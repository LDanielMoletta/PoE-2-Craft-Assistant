import { z } from 'zod';

import { ItemSchema } from './item.js';

/**
 * Um status que o usuario quer ver no item apos o craft.
 * O usuario pode ser explicito ("Flat Fire Damage") ou fuzzy ("qualquer
 * modificador de fire damage"), por isso o campo `query` aceita texto livre.
 */
export interface DesiredModifier {
  /** Texto do modificador desejado, como o usuario escreveria. */
  readonly query: string;
  /**
   * Slot exigido. `any` deixa o agente escolher entre prefix e suffix.
   * Exige-se `slot` apenas quando o jogador sabe qual slot quer preservar.
   */
  readonly slot: 'prefix' | 'suffix' | 'any';
  /** true = modificador obrigatorio; false = desejavel mas dispensavel. */
  readonly required: boolean;
  /**
   * Numero minimo aceitavel do valor (ex: 15 para "flat fire damage > 15").
   * A comparacao usa a semantica do modificador, nao texto.
   */
  readonly minValue: number | null;
  /** teto aceitavel, util para Builds de dano alvo. */
  readonly maxValue: number | null;
}

export const DesiredModifierSchema = z.object({
  query: z.string().min(2).max(160),
  slot: z.enum(['prefix', 'suffix', 'any']).default('any'),
  required: z.boolean().default(true),
  minValue: z.number().nullable().default(null),
  maxValue: z.number().nullable().default(null),
});

/** Unidades de moeda aceitas no orcamento. */
export type CurrencyUnit = 'exalted' | 'divine' | 'chaos' | 'annul';

export const CurrencyUnitSchema = z.enum(['exalted', 'divine', 'chaos', 'annul']);

/** Objetivo do craft definido pelo usuario. */
export interface CraftTarget {
  /** Classe de item alvo. Se ausente, usa a classe do item capturado. */
  readonly itemClass: string | null;
  /** Modificadores desejados. Vazio = apenas busca de otimizacao de custo. */
  readonly targetModifiers: readonly DesiredModifier[];
  /** Teto de gasto em craft currency. Opcional. */
  readonly maxBudget: number | null;
  readonly budgetCurrency: CurrencyUnit;
  /**
   * Se true, o agente nuncaDestroy um prefix/suffix ja existente para
   * aplicar um desejado. Se false, pode remover mods de menor valor.
   */
  readonly preserveExisting: boolean;
  /**
   * Modificadores implicitos nunca sao removidos; este campo existe para deixar
   * explicito no plano que eles estao fora do alcance das moedas.
   */
  readonly allowImplicitRemoval: boolean;
  /** Item level minimo para proc de tiers. Padrao: usa o item level capturado. */
  readonly minItemLevel: number | null;
}

export const CraftTargetSchema = z.object({
  itemClass: z.string().nullable().default(null),
  targetModifiers: z.array(DesiredModifierSchema).max(12).default([]),
  maxBudget: z.number().nonnegative().nullable().default(null),
  budgetCurrency: CurrencyUnitSchema.default('exalted'),
  preserveExisting: z.boolean().default(true),
  allowImplicitRemoval: z.boolean().default(false),
  minItemLevel: z.number().int().nonnegative().nullable().default(null),
});

/** Uma linha do plano: uma aplicacao de moeda com um resultado esperado. */
export interface CraftStep {
  readonly order: number;
  /** Moeda a ser usada, ex: "Regal Orb", "Exalted Orb", "Orb of Annulment". */
  readonly orb: string;
  /** Explicacao curta do porque daquela moeda. */
  readonly rationale: string;
  /** Chance de sucesso (0..1) de a moeda produzir o resultado desejado. */
  readonly successChance: number;
  /** Chance de a moeda produzir um resultado neutro (nao desejado). */
  readonly neutralChance: number;
  /** Chance de a moeda REMOVER um modificador existente (brick/partial). */
  readonly brickChance: number;
  /** Custo esperado por tentativa, na unidade do passo. */
  readonly expectedCostPerTry: number;
  readonly currency: CurrencyUnit;
  /** O que acontece se a moeda falhar. */
  readonly onFailure: 'retry' | 'revert' | 'stop';
  /** Modificadores que esta moeda pode substituir, se for caso. */
  readonly touchesModifiers: readonly string[];
}

export const CraftStepSchema = z.object({
  order: z.number().int().positive(),
  orb: z.string().min(1),
  rationale: z.string(),
  successChance: z.number().min(0).max(1),
  neutralChance: z.number().min(0).max(1),
  brickChance: z.number().min(0).max(1),
  expectedCostPerTry: z.number().nonnegative(),
  currency: CurrencyUnitSchema,
  onFailure: z.enum(['retry', 'revert', 'stop']),
  touchesModifiers: z.array(z.string()),
});

/** Resumo do risco de transformar o item em "brick". */
export interface RiskAssessment {
  /** Probabilidade total de o item perder um modificador de alto valor. */
  readonly brickProbability: number;
  /** Qualidade do alvo em relacao ao orcamento: 'cheap' | 'fair' | 'expensive' | 'unaffordable'. */
  readonly verdict: 'cheap' | 'fair' | 'expensive' | 'unaffordable';
  /** Frase curta para o overlay: "risco baixo", etc. */
  readonly label: string;
  /** Conselhos de mitigacao. */
  readonly mitigations: readonly string[];
}

export const RiskAssessmentSchema = z.object({
  brickProbability: z.number().min(0).max(1),
  verdict: z.enum(['cheap', 'fair', 'expensive', 'unaffordable']),
  label: z.string(),
  mitigations: z.array(z.string()),
});

/** Custo agregado do plano. */
export interface CostEstimate {
  readonly expectedTotal: number;
  readonly worstCaseTotal: number;
  readonly currency: CurrencyUnit;
  readonly attempts: number;
  readonly withinBudget: boolean | null;
}

export const CostEstimateSchema = z.object({
  expectedTotal: z.number().nonnegative(),
  worstCaseTotal: z.number().nonnegative(),
  currency: CurrencyUnitSchema,
  attempts: z.number().int().nonnegative(),
  withinBudget: z.boolean().nullable(),
});

/** Plano completo devolvido pelo agente. */
export interface CraftPlan {
  readonly summary: string;
  readonly steps: readonly CraftStep[];
  readonly risk: RiskAssessment;
  readonly cost: CostEstimate;
  /** Modificadores que o agente considera sacred: nao tocar. */
  readonly protectedModifiers: readonly string[];
  /** Alertas/informacoes (ex: target impossivel no patch atual). */
  readonly notes: readonly string[];
  /** Quem gerou: llm | heuristic. */
  readonly source: 'llm' | 'heuristic';
}

export const CraftPlanSchema = z.object({
  summary: z.string(),
  steps: z.array(CraftStepSchema),
  risk: RiskAssessmentSchema,
  cost: CostEstimateSchema,
  protectedModifiers: z.array(z.string()),
  notes: z.array(z.string()),
  source: z.enum(['llm', 'heuristic']),
});

/** Entrada canonica da tool do Vercel AI SDK. */
export const CraftAgentInputSchema = z.object({
  currentItem: ItemSchema,
  targetGoal: CraftTargetSchema,
});

export type CraftAgentInput = z.infer<typeof CraftAgentInputSchema>;

/** Slots livres em um item, derivado das contagens de prefix/suffix. */
export interface SlotBudget {
  readonly usedPrefixes: number;
  readonly usedSuffixes: number;
  readonly freePrefixes: number;
  readonly freeSuffixes: number;
  readonly maxPrefixes: number;
  readonly maxSuffixes: number;
}

export const SlotBudgetSchema = z.object({
  usedPrefixes: z.number().int().nonnegative(),
  usedSuffixes: z.number().int().nonnegative(),
  freePrefixes: z.number().int().nonnegative(),
  freeSuffixes: z.number().int().nonnegative(),
  maxPrefixes: z.number().int().nonnegative(),
  maxSuffixes: z.number().int().nonnegative(),
});

/** Por item, quantos prefix/suffix e permitido. */
export const SLOT_LIMITS: Readonly<Record<string, { prefixes: number; suffixes: number }>> = {
  wand: { prefixes: 2, suffixes: 3 },
  staff: { prefixes: 2, suffixes: 3 },
  bow: { prefixes: 2, suffixes: 3 },
  sword: { prefixes: 3, suffixes: 3 },
  axe: { prefixes: 3, suffixes: 3 },
  mace: { prefixes: 3, suffixes: 3 },
  sceptre: { prefixes: 2, suffixes: 3 },
  dagger: { prefixes: 2, suffixes: 3 },
  claw: { prefixes: 2, suffixes: 3 },
  chest: { prefixes: 3, suffixes: 3 },
  helmet: { prefixes: 3, suffixes: 3 },
  gloves: { prefixes: 2, suffixes: 2 },
  boots: { prefixes: 2, suffixes: 2 },
  shield: { prefixes: 2, suffixes: 2 },
  quiver: { prefixes: 2, suffixes: 2 },
  belt: { prefixes: 2, suffixes: 2 },
  ring: { prefixes: 2, suffixes: 2 },
  amulet: { prefixes: 2, suffixes: 2 },
  jewel: { prefixes: 2, suffixes: 2 },
  other: { prefixes: 2, suffixes: 2 },
};

export function slotBudgetFor(itemClass: string, usedPrefixes: number, usedSuffixes: number): SlotBudget {
  const limit = SLOT_LIMITS[itemClass] ?? SLOT_LIMITS.other ?? { prefixes: 2, suffixes: 2 };
  return {
    usedPrefixes,
    usedSuffixes,
    freePrefixes: Math.max(0, limit.prefixes - usedPrefixes),
    freeSuffixes: Math.max(0, limit.suffixes - usedSuffixes),
    maxPrefixes: limit.prefixes,
    maxSuffixes: limit.suffixes,
  };
}