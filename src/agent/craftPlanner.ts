import type {
  CostEstimate,
  CraftPlan,
  CraftStep,
  CraftTarget,
  CurrencyUnit,
  DesiredModifier,
  Item,
  ItemClass,
  ItemModifier,
  ModDefinition,
  OrbOdds,
  RiskAssessment,
  SlotBudget,
} from '../types/index.js';
import { CraftTargetSchema, slotBudgetFor } from '../types/index.js';
import { similarityScore } from '../scraper/poeDataService.js';
import type { PoeDataService } from '../scraper/poeDataService.js';

/** Valor de mercado aproximado de cada unidade, em Exalted Orbs. */
export const CURRENCY_IN_EXALTED: Readonly<Record<CurrencyUnit, number>> = {
  exalted: 1,
  divine: 200,
  chaos: 0.1,
  annul: 1,
};

const CURRENCY_LABEL: Readonly<Record<CurrencyUnit, string>> = {
  exalted: 'ex',
  divine: 'div',
  chaos: 'chaos',
  annul: 'annul',
};

/** Origens que nenhuma moeda de craft consegue remover. */
const UNTOUCHABLE_ORIGINS: ReadonlySet<string> = new Set(['implicit', 'enchant', 'rune']);

/** Resultado da analise de um unico modificador desejado. */
export interface DesiredResolution {
  readonly desired: DesiredModifier;
  readonly definition: ModDefinition | null;
  readonly slot: 'prefix' | 'suffix' | 'none';
  readonly alreadyPresent: ItemModifier | null;
  readonly targetMet: boolean;
  readonly feasible: boolean;
  readonly reason: string;
}

/** Analise completa antes da formatacao como plano. */
export interface CraftAnalysis {
  readonly item: Item;
  readonly target: CraftTarget;
  readonly slotBudget: SlotBudget;
  readonly resolutions: readonly DesiredResolution[];
  readonly protectedModifiers: readonly string[];
  readonly notes: readonly string[];
}

export interface PlannerContext {
  readonly dataService: PoeDataService;
}

/** Decide quais modificadores existentes jamais devem ser tocados. */
export function computeProtectedModifiers(item: Item): readonly string[] {
  return item.modifiers
    .filter((mod) => UNTOUCHABLE_ORIGINS.has(mod.origin))
    .map((mod) => mod.text);
}

/** Um modificador do item casa com o desejado? */
export function matchExistingModifier(
  item: Item,
  desired: DesiredModifier,
  definition: ModDefinition | null,
  options: { includeUntouchable?: boolean } = {},
): ItemModifier | null {
  let best: { mod: ItemModifier; score: number } | null = null;

  for (const mod of item.modifiers) {
    if (!options.includeUntouchable && UNTOUCHABLE_ORIGINS.has(mod.origin)) continue;
    const direct = similarityScore(desired.query, mod.text, []);
    // As tags do catalogo ajudam a casar a query do jogador com o NOME canonico
    // do modificador. Nao podem ser usadas na segunda comparacao, senao todo
    // mod do item passa a "conhecer" as mesmas palavras e o score vai a 1.
    const viaDefinition =
      definition === null
        ? 0
        : similarityScore(desired.query, definition.name, definition.tags) *
          similarityScore(definition.name, mod.text, []);
    const score = Math.max(direct, viaDefinition);

    if (score >= 0.6 && (best === null || score > best.score)) {
      best = { mod, score };
    }
  }

  return best?.mod ?? null;
}

/** Existe um mod do item que casa com o desejado e NAO pode ser removido? */
export function matchProtectedModifier(
  item: Item,
  desired: DesiredModifier,
  definition: ModDefinition | null,
): ItemModifier | null {
  const match = matchExistingModifier(item, desired, definition, { includeUntouchable: true });
  return match !== null && UNTOUCHABLE_ORIGINS.has(match.origin) ? match : null;
}

/** O valor do mod no item atinge a janela desejada? */
export function satisfiesValueRange(mod: ItemModifier | null, desired: DesiredModifier): boolean {
  if (mod === null) return false;
  const value = mod.magnitude;
  if (value === null) return desired.minValue === null && desired.maxValue === null;
  if (desired.minValue !== null && value < desired.minValue) return false;
  if (desired.maxValue !== null && value > desired.maxValue) return false;
  return true;
}

/** Espera geometrica: numero de tentativas ate o primeiro sucesso. */
export function expectedAttempts(successChance: number): number {
  if (!Number.isFinite(successChance) || successChance <= 0) return Number.POSITIVE_INFINITY;
  if (successChance >= 1) return 1;
  return 1 / successChance;
}

/** Teto de tentativas usado nas estimativas (evita Infinity no custo). */
const ATTEMPT_CAP = 200;

function cappedAttempts(successChance: number): number {
  return Math.min(expectedAttempts(successChance), ATTEMPT_CAP);
}

function convertExaltedToCurrency(amountInExalted: number, currency: CurrencyUnit): number {
  return round2(amountInExalted / CURRENCY_IN_EXALTED[currency]);
}

/** Escolhe a melhor moeda: maior chance por exalt gasto, desempate por custo. */
export function chooseBestOrb(odds: readonly OrbOdds[]): OrbOdds | null {
  const usable = odds.filter((o) => o.chance > 0);
  if (usable.length === 0) return null;

  return usable.reduce((best, current) => {
    const bestScore = best.chance / best.costInExalted;
    const currentScore = current.chance / current.costInExalted;
    if (currentScore > bestScore) return current;
    if (currentScore === bestScore && current.costInExalted < best.costInExalted) return current;
    return best;
  });
}

/** Estado de ocupacao de slots durante o planejamento. */
interface SlotState {
  prefix: number;
  suffix: number;
}

/** Resolve a classe do item a partir do alvo ou do proprio item capturado. */
function resolveItemClass(item: Item, target: CraftTarget): ItemClass {
  const raw = target.itemClass ?? item.itemClass;
  return (raw.length > 0 ? raw : 'other') as ItemClass;
}

/**
 * Planejador deterministico.
 *
 * Nao usa LLM: dado o item e o objetivo, decide sozinho qual moeda usar, em que
 * ordem, com que custo e com que risco. E' este plano que a LLM explica ao
 * usuario quando a API esta disponivel.
 */
export async function planCraft(
  rawItem: Item,
  rawTarget: CraftTarget,
  context: PlannerContext,
): Promise<CraftPlan> {
  const target = CraftTargetSchema.parse(rawTarget);
  const item = rawItem;
  const itemLevel = target.minItemLevel ?? item.itemLevel ?? 1;
  const itemClass = resolveItemClass(item, target);
  const { dataService } = context;

  // Garante que os mods da classe estao carregados antes de planejar.
  await dataService.getModsForItemClass(itemClass);

  const craftable = item.modifiers.filter((mod) => !UNTOUCHABLE_ORIGINS.has(mod.origin));
  const used: SlotState = {
    prefix: craftable.filter((m) => m.slot === 'prefix').length,
    suffix: craftable.filter((m) => m.slot === 'suffix').length,
  };
  const slotBudget = slotBudgetFor(itemClass, used.prefix, used.suffix);

  const protectedModifiers = computeProtectedModifiers(item);
  const notes: string[] = [];
  const steps: CraftStep[] = [];
  const resolutions: DesiredResolution[] = [];

  const limitFor = (slot: 'prefix' | 'suffix'): number =>
    slot === 'prefix' ? slotBudget.maxPrefixes : slotBudget.maxSuffixes;

  for (const desired of target.targetModifiers) {
    const match = dataService.resolveDesiredModSync(desired.query, itemClass, itemLevel);
    const definition = match?.definition ?? null;
    const resolvedSlot: 'prefix' | 'suffix' | 'none' =
      desired.slot === 'any' ? (match?.slot === 'suffix' ? 'suffix' : 'prefix') : desired.slot;

    const alreadyPresent = matchExistingModifier(item, desired, definition);

    if (satisfiesValueRange(alreadyPresent, desired)) {
      resolutions.push({
        desired,
        definition,
        slot: resolvedSlot,
        alreadyPresent,
        targetMet: true,
        feasible: true,
        reason: 'Ja presente no item com o valor desejado.',
      });
      continue;
    }

    // Um mod intocavel (implicit/enchant) ja ocupa o slot com valor menor que
    // o alvo: nenhuma moeda resolve isso, o jogador precisa de outro item base.
    const protectedMatch = matchProtectedModifier(item, desired, definition);
    if (protectedMatch !== null) {
      resolutions.push({
        desired,
        definition,
        slot: resolvedSlot,
        alreadyPresent: protectedMatch,
        targetMet: false,
        feasible: false,
        reason:
          `"${protectedMatch.text}" (${protectedMatch.origin}) ja ocupa este slot com valor ` +
          `${protectedMatch.magnitude ?? 'n/d'}, abaixo do alvo. Mods ${protectedMatch.origin}s ` +
          'nao podem ser removidos por craft.',
      });
      notes.push(
        `Para "${desired.query}" voce precisa de uma base sem o implicito/protigido atual.`,
      );
      continue;
    }

    if (definition === null) {
      resolutions.push({
        desired,
        definition,
        slot: resolvedSlot,
        alreadyPresent,
        targetMet: false,
        feasible: false,
        reason: `Nenhum modificador da base corresponde a "${desired.query}".`,
      });
      notes.push(
        `Sem dados para "${desired.query}" — confirme se o nome segue a grafia da wiki (ex: "Flat Fire Damage").`,
      );
      continue;
    }

    if (!definition.itemClasses.includes(itemClass)) {
      resolutions.push({
        desired,
        definition,
        slot: resolvedSlot,
        alreadyPresent,
        targetMet: false,
        feasible: false,
        reason: `"${definition.name}" nao existe para a classe ${itemClass}.`,
      });
      continue;
    }

    const slotIsFull = used[resolvedSlot] >= limitFor(resolvedSlot);
    if (slotIsFull && alreadyPresent === null) {
      notes.push(
        `Todos os slots de ${resolvedSlot} estao ocupados e nenhum deles corresponde ao alvo; ` +
          'seria necessario remover um modificador existente.',
      );
    }

    // Mod presente com valor abaixo do alvo: precisa remover antes de refazer.
    if (alreadyPresent !== null) {
      if (target.preserveExisting) {
        resolutions.push({
          desired,
          definition,
          slot: resolvedSlot,
          alreadyPresent,
          targetMet: false,
          feasible: false,
          reason:
            `O slot ja esta ocupado por "${alreadyPresent.text}" e preserveExisting=true. ` +
            'Desative preserveExisting para permitir um Annulment.',
        });
        continue;
      }

      const annul = dataService.getOrb('Orb of Annulment');
      if (annul !== null) {
        // O Annulment remove um modificador ALEATORIO: so "acerta" o alvo com
        // 1/n. Qualquer outro resultado e um brick de um mod que vale dinheiro.
        const craftableCount = Math.max(1, craftable.length);
        const hitChance = 1 / craftableCount;

        steps.push({
          order: steps.length + 1,
          orb: annul.name,
          rationale:
            `Remove "${alreadyPresent.text}" (valor ${alreadyPresent.magnitude ?? 'n/d'}` +
            `${desired.minValue !== null ? ` < alvo ${desired.minValue}` : ''}) para refazer o slot. ` +
            `Como o Annulment e aleatorio, ha ${((1 - hitChance) * 100).toFixed(0)}% de chance de ` +
            'remover outro modificador.',
          successChance: round4(hitChance),
          neutralChance: 0,
          brickChance: round4(1 - hitChance),
          expectedCostPerTry: annul.costInExalted,
          currency: 'exalted',
          onFailure: 'revert',
          touchesModifiers: [alreadyPresent.text],
        });
        used[resolvedSlot] = Math.max(0, used[resolvedSlot] - 1);
      }
    }

    const hasFreeSlot = used[resolvedSlot] < limitFor(resolvedSlot);

    // Em slot livre so entram moedas ADITIVAS (que nao podem apagar nada).
    // Se nenhuma existir, caimos na lista ampla e o risco aparece no plano.
    const additiveOnly = ['Regal Orb', 'Orb of Transmutation', 'Orb of Augmentation'];
    const candidates: readonly string[] = hasFreeSlot
      ? additiveOnly
      : ['Orb of Annulment', 'Orb of Friction', 'Chaos Orb', 'Tainted Chaos Orb', 'Exalted Orb'];

    const odds = dataService
      .estimateOdds(definition.id, itemClass, itemLevel, !hasFreeSlot)
      .filter((o) => candidates.includes(o.orb));

    const best = chooseBestOrb(odds.filter((o) => o.brick === 0)) ?? chooseBestOrb(odds);

    if (best === null) {
      resolutions.push({
        desired,
        definition,
        slot: resolvedSlot,
        alreadyPresent,
        targetMet: false,
        feasible: false,
        reason: 'Nenhuma moeda do catalogo aplica este modificador neste slot.',
      });
      continue;
    }

    const orb = dataService.getOrb(best.orb);
    if (orb === null) continue;

    steps.push({
      order: steps.length + 1,
      orb: orb.name,
      rationale: hasFreeSlot
        ? `Slot de ${resolvedSlot} livre (restam ${Math.max(0, limitFor(resolvedSlot) - used[resolvedSlot] - 1)}): ${orb.description}`
        : `Sem espaco livre em ${resolvedSlot}: ${orb.description}`,
      successChance: best.chance,
      neutralChance: best.neutral,
      brickChance: best.brick,
      expectedCostPerTry: orb.costInExalted,
      currency: 'exalted',
      onFailure: best.brick > 0.2 ? 'revert' : 'retry',
      touchesModifiers: [],
    });

    used[resolvedSlot] += 1;

    resolutions.push({
      desired,
      definition,
      slot: resolvedSlot,
      alreadyPresent,
      targetMet: false,
      feasible: true,
      reason:
        `Aplicar "${definition.name}" (T${best.expectedTier}) com ` +
        `${(best.chance * 100).toFixed(1)}% de chance usando ${orb.name}.`,
    });
  }

  // -----------------------------------------------------------------
  // Custo e risco agregados
  // -----------------------------------------------------------------

  let expectedExalted = 0;
  let worstCaseExalted = 0;
  let totalAttempts = 0;
  let survival = 1;

  for (const step of steps) {
    const tries = cappedAttempts(step.successChance);
    expectedExalted += tries * step.expectedCostPerTry;
    worstCaseExalted += tries * step.expectedCostPerTry * 1.5;
    totalAttempts += Math.ceil(tries);
    survival *= 1 - step.brickChance;
  }

  const brickProbability = steps.length === 0 ? 0 : round4(1 - survival);
  const risk = buildRisk(brickProbability, steps, target);
  const cost: CostEstimate = {
    expectedTotal: convertExaltedToCurrency(expectedExalted, target.budgetCurrency),
    worstCaseTotal: convertExaltedToCurrency(worstCaseExalted, target.budgetCurrency),
    currency: target.budgetCurrency,
    attempts: totalAttempts,
    withinBudget:
      target.maxBudget === null
        ? null
        : expectedExalted <= target.maxBudget * CURRENCY_IN_EXALTED[target.budgetCurrency],
  };

  return {
    summary: buildSummary(resolutions, steps, risk, cost, target),
    steps,
    risk,
    cost,
    protectedModifiers,
    notes,
    source: 'heuristic',
  };
}

/** Monta a analise sem formatar em plano (util para o prompt da LLM). */
export async function analyzeCraft(
  rawItem: Item,
  rawTarget: CraftTarget,
  context: PlannerContext,
): Promise<CraftAnalysis> {
  const target = CraftTargetSchema.parse(rawTarget);
  const itemLevel = target.minItemLevel ?? rawItem.itemLevel ?? 1;
  const itemClass = resolveItemClass(rawItem, target);
  await context.dataService.getModsForItemClass(itemClass);

  const resolutions = target.targetModifiers.map((desired) => {
    const match = context.dataService.resolveDesiredModSync(desired.query, itemClass, itemLevel);
    const definition = match?.definition ?? null;
    const slot: 'prefix' | 'suffix' | 'none' =
      desired.slot === 'any' ? (match?.slot === 'suffix' ? 'suffix' : 'prefix') : desired.slot;
    const alreadyPresent = matchExistingModifier(rawItem, desired, definition);
    const targetMet = satisfiesValueRange(alreadyPresent, desired);

    return {
      desired,
      definition,
      slot,
      alreadyPresent,
      targetMet,
      feasible: definition !== null && definition.itemClasses.includes(itemClass),
      reason: definition === null ? `Sem dados para "${desired.query}".` : definition.name,
    } satisfies DesiredResolution;
  });

  const craftable = rawItem.modifiers.filter((mod) => !UNTOUCHABLE_ORIGINS.has(mod.origin));
  return {
    item: rawItem,
    target,
    slotBudget: slotBudgetFor(
      itemClass,
      craftable.filter((m) => m.slot === 'prefix').length,
      craftable.filter((m) => m.slot === 'suffix').length,
    ),
    resolutions,
    protectedModifiers: computeProtectedModifiers(rawItem),
    notes: [],
  };
}

function buildRisk(
  brickProbability: number,
  steps: readonly CraftStep[],
  target: CraftTarget,
): RiskAssessment {
  const mitigations: string[] = [];

  if (steps.some((s) => s.brickChance > 0.2)) {
    mitigations.push('Faca os slots de maior valor primeiro: um brick no inicio custa mais caro.');
  }
  if (target.preserveExisting) {
    mitigations.push('preserveExisting ativo — nada e removido sem confirmacao.');
  }
  if (!target.allowImplicitRemoval) {
    mitigations.push('Implicitos e encantamentos estao fora do alcance das moedas.');
  }
  if (steps.some((s) => s.onFailure === 'revert')) {
    mitigations.push('Passos marcados como "revert" devem ser executados em bloco de stash.');
  }
  if (mitigations.length === 0) {
    mitigations.push('Nenhum risco relevante: apenas moedas aditivas em slots vazios.');
  }

  const label =
    brickProbability < 0.05
      ? 'risco baixo'
      : brickProbability < 0.2
        ? 'risco moderado'
        : 'risco alto de brick';

  return {
    brickProbability,
    verdict:
      brickProbability < 0.05
        ? 'cheap'
        : brickProbability < 0.25
          ? 'fair'
          : brickProbability < 0.6
            ? 'expensive'
            : 'unaffordable',
    label,
    mitigations,
  };
}

function buildSummary(
  resolutions: readonly DesiredResolution[],
  steps: readonly CraftStep[],
  risk: RiskAssessment,
  cost: CostEstimate,
  target: CraftTarget,
): string {
  if (resolutions.length === 0) {
    return 'Nenhum alvo informado. Defina ao menos um status desejado (CraftTarget.targetModifiers).';
  }

  const done = resolutions.filter((r) => r.targetMet).length;
  const feasible = resolutions.filter((r) => r.feasible && !r.targetMet).length;
  const blocked = resolutions.filter((r) => !r.feasible).length;
  const unit = CURRENCY_LABEL[cost.currency];

  const parts = [
    `${steps.length} passo(s) para ${feasible} alvo(s); ${done} ja satisfeito(s)` +
      (blocked > 0 ? `; ${blocked} bloqueado(s)` : '') +
      '.',
    `Custo esperado ~${cost.expectedTotal} ${unit} (pior caso ~${cost.worstCaseTotal} ${unit}); ${risk.label}.`,
  ];

  if (target.maxBudget !== null) {
    parts.push(
      cost.withinBudget === true
        ? `Dentro do orcamento de ${target.maxBudget} ${unit}.`
        : `ACIMA do orcamento de ${target.maxBudget} ${unit}.`,
    );
  }

  return parts.join(' ');
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}