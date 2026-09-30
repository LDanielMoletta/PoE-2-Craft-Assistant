import { z } from 'zod';

/**
 * Como o jogo rotula as linhas de um item copiado.
 * `implicit` nunca pode ser craftado, `crafted` ja foi aplicado por moeda,
 * `implicit`-likeenchant/latent sao linhas geradas por joias etc.
 */
export type ModifierOrigin = 'implicit' | 'crafted' | 'enchant' | 'rune' | 'veiled' | 'unknown';

export const ModifierOriginSchema = z.enum([
  'implicit',
  'crafted',
  'enchant',
  'rune',
  'veiled',
  'unknown',
]);

/** Slot logico que o modificador ocupa no item. */
export type ModifierSlot = 'prefix' | 'suffix' | 'none';

export const ModifierSlotSchema = z.enum(['prefix', 'suffix', 'none']);

/** Raridade exatamente como aparece no cabecalho do item. */
export type ItemRarity = 'normal' | 'magic' | 'rare' | 'unique' | 'gem' | 'currency' | 'quest';

export const ItemRaritySchema = z.enum([
  'normal',
  'magic',
  'rare',
  'unique',
  'gem',
  'currency',
  'quest',
]);

/** Classe de item em forma normalizada, usada para filtrar a base de mods. */
export type ItemClass =
  | 'wand'
  | 'staff'
  | 'bow'
  | 'sword'
  | 'axe'
  | 'mace'
  | 'sceptre'
  | 'dagger'
  | 'claw'
  | 'chest'
  | 'helmet'
  | 'gloves'
  | 'boots'
  | 'shield'
  | 'quiver'
  | 'belt'
  | 'ring'
  | 'amulet'
  | 'jewel'
  | 'other';

export const ItemClassSchema = z.enum([
  'wand',
  'staff',
  'bow',
  'sword',
  'axe',
  'mace',
  'sceptre',
  'dagger',
  'claw',
  'chest',
  'helmet',
  'gloves',
  'boots',
  'shield',
  'quiver',
  'belt',
  'ring',
  'amulet',
  'jewel',
  'other',
]);

/** Um unico modificador lido do texto do item. */
export interface ItemModifier {
  /** Texto exatamente como veio no clipboard, para exibir no overlay. */
  readonly raw: string;
  /** Texto normalizado (sem espaco duplo, sem parenteses de origem). */
  readonly text: string;
  readonly tier: number | null;
  readonly quality: number | null;
  readonly slot: ModifierSlot;
  readonly origin: ModifierOrigin;
  /** Quantidade numerica extraida do texto (ex: 12 em "+12 to Accuracy Rating"). */
  readonly magnitude: number | null;
}

export const ItemModifierSchema = z.object({
  raw: z.string(),
  text: z.string(),
  tier: z.number().int().positive().nullable(),
  quality: z.number().min(0).max(100).nullable(),
  slot: ModifierSlotSchema,
  origin: ModifierOriginSchema,
  magnitude: z.number().nullable(),
});

/** Propriedades do item que nao sao modificadores (dano, requisitos, sockets...). */
export interface ItemProperties {
  readonly physicalDamage?: string;
  readonly elementalDamage?: readonly string[];
  readonly criticalStrikeChance?: string;
  readonly criticalStrikeMultiplier?: string;
  readonly attacksPerSecond?: string;
  readonly armour?: string;
  readonly evasionRating?: string;
  readonly energyShield?: string;
  readonly ward?: string;
  readonly requirements: Readonly<Record<string, string>>;
  readonly sockets: readonly string[];
}

export const ItemPropertiesSchema = z
  .object({
    physicalDamage: z.string().optional(),
    elementalDamage: z.array(z.string()).optional(),
    criticalStrikeChance: z.string().optional(),
    criticalStrikeMultiplier: z.string().optional(),
    attacksPerSecond: z.string().optional(),
    armour: z.string().optional(),
    evasionRating: z.string().optional(),
    energyShield: z.string().optional(),
    ward: z.string().optional(),
    requirements: z.record(z.string()),
    sockets: z.array(z.string()),
  })
  .strict();

/** Item estruturado, resultado do modulo de parser. */
export interface Item {
  readonly name: string | null;
  readonly baseType: string | null;
  readonly itemClass: ItemClass;
  readonly rarity: ItemRarity;
  readonly itemLevel: number | null;
  readonly areaLevel: number | null;
  readonly quality: number | null;
  readonly corrupted: boolean;
  readonly mirrored: boolean;
  readonly split: boolean;
  readonly identified: boolean;
  readonly talismanTier: number | null;
  readonly modifiers: readonly ItemModifier[];
  readonly properties: ItemProperties;
  /** Texto original preservado para reprocessamento. */
  readonly rawText: string;
}

export const ItemSchema = z.object({
  name: z.string().nullable(),
  baseType: z.string().nullable(),
  itemClass: ItemClassSchema,
  rarity: ItemRaritySchema,
  itemLevel: z.number().int().nonnegative().nullable(),
  areaLevel: z.number().int().nonnegative().nullable(),
  quality: z.number().min(0).max(100).nullable(),
  corrupted: z.boolean(),
  mirrored: z.boolean(),
  split: z.boolean(),
  identified: z.boolean(),
  talismanTier: z.number().int().positive().nullable(),
  modifiers: z.array(ItemModifierSchema),
  properties: ItemPropertiesSchema,
  rawText: z.string(),
});

/** Resultado do parse: pode haver varios itens num unico clipboard. */
export interface ParseResult {
  readonly items: readonly Item[];
  /** Modificadores que nao foi possivel classificar como prefix ou suffix. */
  readonly warnings: readonly string[];
}

export const ParseResultSchema = z.object({
  items: z.array(ItemSchema),
  warnings: z.array(z.string()),
});

/** Normaliza as classes do jogo para o enum interno. */
export const ITEM_CLASS_ALIASES: Readonly<Record<string, ItemClass>> = {
  wand: 'wand',
  wands: 'wand',
  staff: 'staff',
  staves: 'staff',
  quarterstaff: 'staff',
  bow: 'bow',
  bows: 'bow',
  sword: 'sword',
  swords: 'sword',
  axe: 'axe',
  axes: 'axe',
  mace: 'mace',
  maces: 'mace',
  sceptre: 'sceptre',
  sceptres: 'sceptre',
  scepter: 'sceptre',
  dagger: 'dagger',
  daggers: 'dagger',
  claw: 'claw',
  claws: 'claw',
  'body armour': 'chest',
  'body armours': 'chest',
  chest: 'chest',
  helmet: 'helmet',
  helmets: 'helmet',
  gloves: 'gloves',
  boots: 'boots',
  'shield': 'shield',
  shields: 'shield',
  'focus': 'shield',
  buckler: 'shield',
  quiver: 'quiver',
  belt: 'belt',
  belts: 'belt',
  ring: 'ring',
  rings: 'ring',
  amulet: 'amulet',
  amulets: 'amulet',
  jewel: 'jewel',
  jewels: 'jewel',
};

export function normalizeItemClass(label: string): ItemClass {
  const key = label.trim().toLowerCase();
  return ITEM_CLASS_ALIASES[key] ?? 'other';
}