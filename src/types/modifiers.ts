import { z } from 'zod';

import type { ItemClass, ModifierSlot } from './item.js';

/**
 * Uma definicao de modificador vinda da wiki/replica local.
 * Representa UM tier de UM modificador para UMA classe de item.
 */
export interface ModDefinition {
  /** Id estavel, ex: `fire-damage#prefix#t3`. */
  readonly id: string;
  /** Nome canonico do modificador, ex: "Flat Fire Damage". */
  readonly name: string;
  readonly slot: ModifierSlot;
  readonly tier: number;
  /** Texto renderizado do tier, ex: "Flat Fire Damage to Attacks". */
  readonly text: string;
  /** Valor numerico absoluto do tier (sem o sinal), util para comparacoes. */
  readonly value: number | null;
  /** Item level minimo para o tier aparecer. */
  readonly requiredItemLevel: number;
  /** Peso relativo na pool de mods (base do calculo de chance). */
  readonly weight: number;
  /** Classes de item onde este tier existe. */
  readonly itemClasses: readonly ItemClass[];
  /** Tags semanticas para matching de texto livre ("fire", "spell", "chaos"...). */
  readonly tags: readonly string[];
  /** Tier maximo conhecido para este modificador nesta classe. */
  readonly maxTier: number;
}

export const ModDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slot: z.enum(['prefix', 'suffix', 'none']),
  tier: z.number().int().positive(),
  text: z.string().min(1),
  value: z.number().nullable(),
  requiredItemLevel: z.number().int().nonnegative(),
  weight: z.number().nonnegative(),
  itemClasses: z.array(z.string()),
  tags: z.array(z.string()),
  maxTier: z.number().int().positive(),
});

/** Uma moeda de craft e o que ela faz. */
export interface OrbDefinition {
  readonly name: string;
  /** Familia da moeda: 'random-affix', 'random-add', 'remove', 'transform'... */
  readonly kind: 'random-affix' | 'random-add' | 'remove' | 'transform' | 'quality' | 'reroll';
  /**
   * Pode aplicar em slot vazio sem chance de remover nada.
   * Orbs "add" (Regal) preservam mods existentes; "random-affix" (Chaos)
   * podem sobrescrever em slots ja ocupados.
   */
  readonly appliesToEmptySlot: boolean;
  /** Pode substituir um modificador existente (risco de brick). */
  readonly overwritesExisting: boolean;
  /** Multiplicador de custo em exalted orbs, usado nas estimativas. */
  readonly costInExalted: number;
  /** Filtragem de slots que a moeda aceita aplicar. */
  readonly slotFilter: readonly ModifierSlot[];
  /** Se true, a moeda sobe o tier do que ela tenta adicionar. */
  readonly improvesTier: boolean;
  /** Numero maximo de modificadores que a moeda remove (Orb of Annulment = 1). */
  readonly removesPerUse: number;
  /** Descricao curta para o overlay. */
  readonly description: string;
}

export const OrbDefinitionSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['random-affix', 'random-add', 'remove', 'transform', 'quality', 'reroll']),
  appliesToEmptySlot: z.boolean(),
  overwritesExisting: z.boolean(),
  costInExalted: z.number().nonnegative(),
  slotFilter: z.array(z.enum(['prefix', 'suffix', 'none'])),
  improvesTier: z.boolean(),
  removesPerUse: z.number().int().nonnegative(),
  description: z.string(),
});

/** Resultado da consulta "este status desejado existe como prefix ou suffix?". */
export interface ModResolution {
  readonly definition: ModDefinition;
  /** Tipo que o usuario perguntou, ja resolvido. */
  readonly slot: ModifierSlot;
  /** true se o tier 1 do modificador existe nesta classe. */
  readonly obtainable: boolean;
  /** Melhor tier disponivel no item level informado. */
  readonly bestAvailableTier: number | null;
  /** Item level necessario para o melhor tier; null se nenhum. */
  readonly requiredItemLevel: number | null;
  /** Tiers que o item level permite. */
  readonly availableTiers: readonly ModDefinition[];
}

export const ModResolutionSchema = z.object({
  definition: z.object({
    id: z.string(),
    name: z.string(),
    slot: z.enum(['prefix', 'suffix', 'none']),
    tier: z.number(),
    text: z.string(),
    value: z.number().nullable(),
    requiredItemLevel: z.number(),
    weight: z.number(),
    itemClasses: z.array(z.string()),
    tags: z.array(z.string()),
    maxTier: z.number(),
  }),
  slot: z.enum(['prefix', 'suffix', 'none']),
  obtainable: z.boolean(),
  bestAvailableTier: z.number().nullable(),
  requiredItemLevel: z.number().nullable(),
  availableTiers: z.array(z.any()),
});

/**
 * Chance estimada de um status desejado sair com uma dada moeda.
 * e o dado que o agente usa para decidir entre Chaos (barato) e
 * Exalted/Regal (caro, mas controla o tier).
 */
export interface OrbOdds {
  readonly orb: string;
  readonly modId: string;
  /** Probabilidade de a moeda produzir o modificador desejado (0..1). */
  readonly chance: number;
  /** Probabilidade de a moeda produzir um resultado neutro (0..1). */
  readonly neutral: number;
  /** Probabilidade de a moeda remover um mod existente (0..1). */
  readonly brick: number;
  /** Tier medio que a moeda deve entregar se acertar. */
  readonly expectedTier: number;
  readonly costInExalted: number;
}

export const OrbOddsSchema = z.object({
  orb: z.string(),
  modId: z.string(),
  chance: z.number().min(0).max(1),
  neutral: z.number().min(0).max(1),
  brick: z.number().min(0).max(1),
  expectedTier: z.number(),
  costInExalted: z.number().nonnegative(),
});

/** Faixa de tiercing de um modificador, para comparacao com o item. */
export interface TierRange {
  readonly modId: string;
  readonly name: string;
  readonly slot: ModifierSlot;
  readonly minTier: number;
  readonly maxTier: number;
}

export const TierRangeSchema = z.object({
  modId: z.string(),
  name: z.string(),
  slot: z.enum(['prefix', 'suffix', 'none']),
  minTier: z.number(),
  maxTier: z.number(),
});