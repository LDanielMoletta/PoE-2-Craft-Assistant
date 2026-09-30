import { describe, expect, it } from 'vitest';

import { CraftAgent, renderPlan } from './craftAgent.js';
import { chooseBestOrb, expectedAttempts, planCraft } from './craftPlanner.js';
import { PoeDataService, similarityScore } from '../scraper/poeDataService.js';
import { parseFirstItem } from '../parser/index.js';
import { CraftTargetSchema, type CraftTarget, type Item } from '../types/index.js';

const RARE_WAND = `Item Class: Wands
Rarity: Rare
Wandering Path
Crackling Wand
--------
Physical Damage: 27 to 48
--------
Item Level: 64
--------
+11 to Accuracy Rating (implicit)
--------
+1 to Level of all Spell Skill Gems (implicit)
--------
+15% increased Cast Speed
--------
Flat Fire Damage to Attacks`;

const EMPTY_SLOT_WAND = `Item Class: Wands
Rarity: Rare
Lonely Spark
Crackling Wand
--------
Item Level: 64
--------
+11 to Accuracy Rating (implicit)
--------
+18 to Maximum Mana (implicit)
--------
+15% increased Cast Speed`;

function item(text: string): Item {
  const parsed = parseFirstItem(text);
  if (parsed === null) throw new Error('fixture de item invalida');
  return parsed;
}

function target(partial: Partial<CraftTarget> & { targetModifiers: CraftTarget['targetModifiers'] }): CraftTarget {
  return CraftTargetSchema.parse({
    itemClass: null,
    maxBudget: null,
    budgetCurrency: 'exalted',
    preserveExisting: true,
    allowImplicitRemoval: false,
    minItemLevel: null,
    ...partial,
  });
}

function newService(): PoeDataService {
  return new PoeDataService({ fallbackToSeed: true, cache: undefined });
}

describe('similarityScore', () => {
  it('da 1.0 para texto identico', () => {
    expect(similarityScore('Flat Fire Damage', 'Flat Fire Damage', [])).toBe(1);
  });

  it('reconhece abreviacao pelo score de tokens', () => {
    expect(similarityScore('fire damage', 'Flat Fire Damage', [])).toBeGreaterThan(0.5);
  });

  it('devolve 0 para textos sem sobreposicao', () => {
    expect(similarityScore('cast speed', 'Flat Fire Damage', [])).toBe(0);
  });
});

describe('expectedAttempts', () => {
  it('e 1/chance', () => {
    expect(expectedAttempts(0.25)).toBe(4);
    expect(expectedAttempts(1)).toBe(1);
  });

  it('devolve Infinity quando a chance e zero', () => {
    expect(expectedAttempts(0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('chooseBestOrb', () => {
  it('escolhe a maior chance por exalt gasto', () => {
    const best = chooseBestOrb([
      { orb: 'A', modId: 'm', chance: 0.1, neutral: 0.9, brick: 0, expectedTier: 1, costInExalted: 1 },
      { orb: 'B', modId: 'm', chance: 0.1, neutral: 0.9, brick: 0, expectedTier: 1, costInExalted: 0.5 },
    ]);
    expect(best?.orb).toBe('B');
  });

  it('ignora moedas com chance zero', () => {
    const best = chooseBestOrb([
      { orb: 'Impossivel', modId: 'm', chance: 0, neutral: 1, brick: 0, expectedTier: 1, costInExalted: 0.01 },
    ]);
    expect(best).toBeNull();
  });
});

describe('PoeDataService', () => {
  it('resolve um status desejado como prefixo com tiers', async () => {
    const service = newService();
    const resolution = await service.resolveDesiredMod('Flat Fire Damage', 'wand', 64);

    expect(resolution?.slot).toBe('prefix');
    expect(resolution?.obtainable).toBe(true);
    expect(resolution?.bestAvailableTier).toBe(2);
    expect(resolution?.availableTiers.length).toBeGreaterThan(0);
  });

  it('filtra tiers pelo item level', async () => {
    const service = newService();

    // T1 de Flat Fire Damage exige ilvl 25.
    const tooLow = await service.resolveDesiredMod('Flat Fire Damage', 'wand', 20);
    expect(tooLow?.availableTiers).toHaveLength(0);
    expect(tooLow?.obtainable).toBe(false);

    const justT1 = await service.resolveDesiredMod('Flat Fire Damage', 'wand', 30);
    expect(justT1?.availableTiers.map((t) => t.tier)).toEqual([1]);
    expect(justT1?.bestAvailableTier).toBe(1);
  });

  it('nao resolve modificador de outra classe de item', async () => {
    const service = newService();
    const resolution = await service.resolveDesiredMod('Flat Fire Damage', 'chest', 80);
    expect(resolution).toBeNull();
  });

  it('devolve chance e risco por moeda', async () => {
    const service = newService();
    await service.getModsForItemClass('wand');
    const resolution = await service.resolveDesiredMod('Flat Fire Damage', 'wand', 64);
    const odds = service.estimateOdds(resolution!.definition.id, 'wand', 64, false);

    expect(odds.length).toBeGreaterThan(0);
    for (const o of odds) {
      expect(o.chance + o.neutral + o.brick).toBeCloseTo(1, 2);
      expect(o.costInExalted).toBeGreaterThan(0);
    }
  });

  it('slot ocupado multiplica o risco de brick', async () => {
    const service = newService();
    await service.getModsForItemClass('wand');
    const resolution = await service.resolveDesiredMod('Flat Fire Damage', 'wand', 64);
    const modId = resolution!.definition.id;

    const free = service.estimateOdds(modId, 'wand', 64, false, 'Chaos Orb');
    const occupied = service.estimateOdds(modId, 'wand', 64, true, 'Chaos Orb');

    expect(occupied[0]?.brick).toBeGreaterThan(free[0]?.brick ?? 0);
  });

  it('moeda aditiva nao funciona em slot ocupado', async () => {
    const service = newService();
    await service.getModsForItemClass('wand');
    const resolution = await service.resolveDesiredMod('Flat Fire Damage', 'wand', 64);
    const regal = service.estimateOdds(resolution!.definition.id, 'wand', 64, true, 'Regal Orb');
    expect(regal[0]?.chance).toBe(0);
  });
});

describe('planCraft', () => {
  it('nao planeja nada quando o alvo ja esta no item', async () => {
    const service = newService();
    const plan = await planCraft(
      item(RARE_WAND),
      target({ targetModifiers: [{ query: 'increased Cast Speed', slot: 'any', required: true, minValue: null, maxValue: null }] }),
      { dataService: service },
    );

    expect(plan.steps).toHaveLength(0);
    expect(plan.summary).toContain('ja satisfeito');
  });

  it('usa moeda aditiva quando ha slot livre', async () => {
    const service = newService();
    const plan = await planCraft(
      item(EMPTY_SLOT_WAND),
      target({ targetModifiers: [{ query: 'Flat Fire Damage', slot: 'prefix', required: true, minValue: null, maxValue: null }] }),
      { dataService: service },
    );

    expect(plan.steps.length).toBeGreaterThan(0);
    const step = plan.steps[0];
    expect(step?.orb).toBe('Regal Orb');
    expect(step?.brickChance).toBe(0);
    expect(plan.risk.brickProbability).toBe(0);
  });

  it('bloqueia remocao quando preserveExisting esta ativo', async () => {
    const service = newService();
    const plan = await planCraft(
      item(RARE_WAND),
      target({
        preserveExisting: true,
        targetModifiers: [{ query: 'Flat Fire Damage', slot: 'prefix', required: true, minValue: 28, maxValue: null }],
      }),
      { dataService: service },
    );

    expect(plan.steps).toHaveLength(0);
    expect(plan.summary).toContain('bloqueado');
  });

  it('planeja Annulment + reroll quando o mod existe com valor menor', async () => {
    const service = newService();
    const plan = await planCraft(
      item(RARE_WAND),
      target({
        preserveExisting: false,
        targetModifiers: [{ query: 'Flat Fire Damage', slot: 'prefix', required: true, minValue: 28, maxValue: null }],
      }),
      { dataService: service },
    );

    expect(plan.steps[0]?.orb).toBe('Orb of Annulment');
    expect(plan.steps[0]?.touchesModifiers).toContain('Flat Fire Damage to Attacks');
    expect(plan.steps[0]?.successChance).toBeLessThan(1);
    expect(plan.risk.brickProbability).toBeGreaterThan(0);
  });

  it('informa quando o slot esta preso a um modificador protegido', async () => {
    const service = newService();
    const plan = await planCraft(
      item(RARE_WAND),
      target({
        targetModifiers: [
          { query: 'to Level of all Spell Skill Gems', slot: 'any', required: true, minValue: 2, maxValue: null },
        ],
      }),
      { dataService: service },
    );

    expect(plan.steps).toHaveLength(0);
    expect(plan.notes.some((n) => n.includes('implicito'))).toBe(true);
  });

  it('respeita o orcamento em currency diferente de exalted', async () => {
    const service = newService();
    const plan = await planCraft(
      item(EMPTY_SLOT_WAND),
      target({
        budgetCurrency: 'divine',
        maxBudget: 1,
        targetModifiers: [{ query: 'Flat Fire Damage', slot: 'prefix', required: true, minValue: null, maxValue: null }],
      }),
      { dataService: service },
    );

    expect(plan.cost.currency).toBe('divine');
    // 1 divine = 200 exalted; o custo esperado em divine deve ser bem menor.
    expect(plan.cost.expectedTotal).toBeLessThan(200);
  });

  it('protege implicitos e encantamentos', async () => {
    const service = newService();
    const plan = await planCraft(
      item(RARE_WAND),
      target({ targetModifiers: [] }),
      { dataService: service },
    );

    expect(plan.protectedModifiers).toContain('+11 to Accuracy Rating');
    expect(plan.protectedModifiers).toContain('+1 to Level of all Spell Skill Gems');
  });
});

describe('CraftAgent', () => {
  it('roda sem chave de API usando o planner deterministico', async () => {
    const agent = new CraftAgent({ dataService: newService(), apiKey: undefined });
    expect(agent.hasLlm).toBe(false);

    const result = await agent.planWithLlm(
      item(EMPTY_SLOT_WAND),
      target({ targetModifiers: [{ query: 'Flat Fire Damage', slot: 'prefix', required: true, minValue: null, maxValue: null }] }),
    );

    expect(result.source).toBe('heuristic');
    expect(result.plan.steps.length).toBeGreaterThan(0);
    expect(result.narrative.length).toBeGreaterThan(0);
  });

  it('renderiza o plano em texto', async () => {
    const agent = new CraftAgent({ dataService: newService(), apiKey: undefined });
    const plan = await agent.planOnly(
      item(EMPTY_SLOT_WAND),
      target({ targetModifiers: [{ query: 'Flat Fire Damage', slot: 'prefix', required: true, minValue: null, maxValue: null }] }),
    );

    const rendered = renderPlan(plan);
    expect(rendered).toContain('Passo a passo:');
    expect(rendered).toContain('Regal Orb');
  });
});