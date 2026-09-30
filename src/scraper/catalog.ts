import type { ItemClass, OrbDefinition } from '../types/index.js';

/**
 * Catalogo de moedas de craft do PoE2 0.1.
 * Os valores de custo sao em Exalted Orbs e servem de base para o planejador.
 * `slotFilter` vazio = a moeda aceita qualquer slot.
 */
export const ORB_CATALOG: readonly OrbDefinition[] = [
  {
    name: 'Regal Orb',
    kind: 'random-add',
    appliesToEmptySlot: true,
    overwritesExisting: false,
    costInExalted: 0.25,
    slotFilter: ['prefix', 'suffix'],
    improvesTier: false,
    removesPerUse: 0,
    description: 'Adiciona um modificador aleatorio em um slot VAZIO. Nunca remove nada.',
  },
  {
    name: 'Orb of Alchemy',
    kind: 'random-affix',
    appliesToEmptySlot: true,
    overwritesExisting: true,
    costInExalted: 0.1,
    slotFilter: ['prefix', 'suffix'],
    improvesTier: false,
    removesPerUse: 0,
    description: 'Rola um modificador aleatorio em qualquer slot. Pode DESTRUIR um mod existente.',
  },
  {
    name: 'Chaos Orb',
    kind: 'random-affix',
    appliesToEmptySlot: true,
    overwritesExisting: true,
    costInExalted: 0.5,
    slotFilter: ['prefix', 'suffix'],
    improvesTier: false,
    removesPerUse: 0,
    description: 'Rola um modificador aleatorio em qualquer slot. Mesma chance que Alchemy.',
  },
  {
    name: 'Orb of Annulment',
    kind: 'remove',
    appliesToEmptySlot: false,
    overwritesExisting: false,
    costInExalted: 1.5,
    slotFilter: ['prefix', 'suffix'],
    improvesTier: false,
    removesPerUse: 1,
    description: 'Remove um modificador aleatorio (craftado ou implicito). Alto risco de brick.',
  },
  {
    name: 'Orb of Friction',
    kind: 'reroll',
    appliesToEmptySlot: true,
    overwritesExisting: true,
    costInExalted: 0.35,
    slotFilter: ['prefix', 'suffix'],
    improvesTier: false,
    removesPerUse: 0,
    description: 'Remove um modificador e adiciona outro. Barato, mas so com tiers baixos.',
  },
  {
    name: 'Exalted Orb',
    kind: 'random-affix',
    appliesToEmptySlot: true,
    overwritesExisting: true,
    costInExalted: 10,
    slotFilter: ['prefix', 'suffix'],
    improvesTier: false,
    removesPerUse: 0,
    description: 'Rola um modificador aleatorio com peso maior para tiers altos.',
  },
  {
    name: 'Orb of Transmutation',
    kind: 'random-affix',
    appliesToEmptySlot: true,
    overwritesExisting: false,
    costInExalted: 0.02,
    slotFilter: ['prefix', 'suffix'],
    improvesTier: false,
    removesPerUse: 0,
    description: 'Adiciona mod em item normal. Barata, mas so tier 1.',
  },
  {
    name: 'Orb of Augmentation',
    kind: 'random-affix',
    appliesToEmptySlot: true,
    overwritesExisting: false,
    costInExalted: 0.05,
    slotFilter: ['prefix', 'suffix'],
    improvesTier: false,
    removesPerUse: 0,
    description: 'Adiciona mod em item magico, sempre tier 1.',
  },
  {
    name: 'Exalted Orb (Awakened)',
    kind: 'random-affix',
    appliesToEmptySlot: true,
    overwritesExisting: true,
    costInExalted: 45,
    slotFilter: ['prefix', 'suffix'],
    improvesTier: true,
    removesPerUse: 0,
    description: 'Blinda o prefix (ou suffix) atual e rola um novo tier elevado.',
  },
  {
    name: 'Tainted Chaos Orb',
    kind: 'random-affix',
    appliesToEmptySlot: true,
    overwritesExisting: true,
    costInExalted: 2.5,
    slotFilter: ['prefix', 'suffix'],
    improvesTier: false,
    removesPerUse: 0,
    description: 'Rola qualquer modificador, inclusive de ascension. Melhor cobertura.',
  },
];

/** Moedas que nunca sobrescrevem mod existente: seguras para slot vazio. */
export const NON_DESTRUCTIVE_ORBS: readonly string[] = ORB_CATALOG.filter(
  (orb) => !orb.overwritesExisting && orb.appliesToEmptySlot,
).map((orb) => orb.name);

/** Moedas consideradas pelas estimativas de chance, em ordem de preferencia. */
export const ODDS_CANDIDATE_ORBS: readonly string[] = [
  'Orb of Alchemy',
  'Chaos Orb',
  'Regal Orb',
  'Orb of Friction',
  'Tainted Chaos Orb',
  'Exalted Orb',
];

/**
 * Modificadores de exemplo, suficientes para demonstracao e testes offline.
 * Em producao, `poeDataService` substitui este catalogo pelo scrape da wiki.
 */
export interface SeedMod {
  readonly name: string;
  readonly slot: 'prefix' | 'suffix';
  readonly tiers: readonly { readonly text: string; readonly value: number; readonly ilvl: number }[];
  readonly itemClasses: readonly ItemClass[];
  readonly tags: readonly string[];
  /** Peso relativo da pool. Mods raros tem peso menor. */
  readonly weight: number;
}

export const SEED_MODS: readonly SeedMod[] = [
  {
    name: 'Flat Fire Damage',
    slot: 'prefix',
    tiers: [
      { text: 'Flat Fire Damage to Attacks', value: 15, ilvl: 25 },
      { text: 'Flat Fire Damage to Attacks', value: 28, ilvl: 45 },
      { text: 'Flat Fire Damage to Attacks', value: 44, ilvl: 65 },
      { text: 'Flat Fire Damage to Attacks', value: 66, ilvl: 80 },
    ],
    itemClasses: ['wand', 'staff', 'bow', 'sword', 'axe', 'mace', 'sceptre', 'dagger', 'claw'],
    tags: ['fire', 'damage', 'flat', 'attack', 'weapon'],
    weight: 100,
  },
  {
    name: 'Flat Cold Damage',
    slot: 'prefix',
    tiers: [
      { text: 'Flat Cold Damage to Attacks', value: 15, ilvl: 25 },
      { text: 'Flat Cold Damage to Attacks', value: 28, ilvl: 45 },
      { text: 'Flat Cold Damage to Attacks', value: 44, ilvl: 65 },
      { text: 'Flat Cold Damage to Attacks', value: 66, ilvl: 80 },
    ],
    itemClasses: ['wand', 'staff', 'bow', 'sword', 'axe', 'mace', 'sceptre', 'dagger', 'claw'],
    tags: ['cold', 'damage', 'flat', 'attack', 'weapon'],
    weight: 100,
  },
  {
    name: 'Flat Lightning Damage',
    slot: 'prefix',
    tiers: [
      { text: 'Flat Lightning Damage to Attacks', value: 15, ilvl: 25 },
      { text: 'Flat Lightning Damage to Attacks', value: 28, ilvl: 45 },
      { text: 'Flat Lightning Damage to Attacks', value: 44, ilvl: 65 },
      { text: 'Flat Lightning Damage to Attacks', value: 66, ilvl: 80 },
    ],
    itemClasses: ['wand', 'staff', 'bow', 'sword', 'axe', 'mace', 'sceptre', 'dagger', 'claw'],
    tags: ['lightning', 'damage', 'flat', 'attack', 'weapon'],
    weight: 100,
  },
  {
    name: 'Adds Chaos Damage',
    slot: 'prefix',
    tiers: [
      { text: 'Flat Chaos Damage to Attacks', value: 12, ilvl: 35 },
      { text: 'Flat Chaos Damage to Attacks', value: 22, ilvl: 55 },
      { text: 'Flat Chaos Damage to Attacks', value: 38, ilvl: 75 },
      { text: 'Flat Chaos Damage to Attacks', value: 55, ilvl: 90 },
    ],
    itemClasses: ['wand', 'staff', 'bow', 'sword', 'axe', 'mace', 'sceptre', 'dagger', 'claw'],
    tags: ['chaos', 'damage', 'flat', 'attack', 'weapon', 'ailment'],
    weight: 60,
  },
  {
    name: 'to Level of all Spell Skill Gems',
    slot: 'prefix',
    tiers: [
      { text: '+1 to Level of all Spell Skill Gems', value: 1, ilvl: 20 },
      { text: '+2 to Level of all Spell Skill Gems', value: 2, ilvl: 55 },
      { text: '+3 to Level of all Spell Skill Gems', value: 3, ilvl: 80 },
    ],
    itemClasses: ['wand', 'staff', 'bow', 'sceptre', 'amulet', 'ring', 'helmet', 'chest', 'gloves', 'belt'],
    tags: ['level', 'spell', 'gem', 'skill', 'caster'],
    weight: 25,
  },
  {
    name: 'Spell Damage',
    slot: 'prefix',
    tiers: [
      { text: 'Adds Spell Damage', value: 12, ilvl: 20 },
      { text: 'Adds Spell Damage', value: 25, ilvl: 45 },
      { text: 'Adds Spell Damage', value: 42, ilvl: 65 },
      { text: 'Adds Spell Damage', value: 65, ilvl: 85 },
    ],
    itemClasses: ['wand', 'staff', 'bow', 'sceptre'],
    tags: ['spell', 'damage', 'caster', 'weapon'],
    weight: 80,
  },
  {
    name: 'Increased Cast Speed',
    slot: 'suffix',
    tiers: [
      { text: '10% increased Cast Speed', value: 10, ilvl: 20 },
      { text: '15% increased Cast Speed', value: 15, ilvl: 45 },
      { text: '20% increased Cast Speed', value: 20, ilvl: 70 },
    ],
    itemClasses: ['wand', 'staff', 'bow', 'sceptre', 'helmet', 'gloves', 'ring', 'amulet', 'belt'],
    tags: ['cast', 'speed', 'caster', 'attack', 'rate'],
    weight: 55,
  },
  {
    name: 'Increased Attack Speed',
    slot: 'suffix',
    tiers: [
      { text: '10% increased Attack Speed', value: 10, ilvl: 20 },
      { text: '15% increased Attack Speed', value: 15, ilvl: 45 },
      { text: '20% increased Attack Speed', value: 20, ilvl: 70 },
    ],
    itemClasses: ['wand', 'staff', 'bow', 'sword', 'axe', 'mace', 'sceptre', 'dagger', 'claw', 'gloves', 'belt', 'ring', 'amulet'],
    tags: ['attack', 'speed', 'weapon', 'rate'],
    weight: 55,
  },
  {
    name: 'Critical Strike Chance',
    slot: 'suffix',
    tiers: [
      { text: '10% increased Critical Strike Chance', value: 10, ilvl: 25 },
      { text: '20% increased Critical Strike Chance', value: 20, ilvl: 55 },
      { text: '30% increased Critical Strike Chance', value: 30, ilvl: 80 },
    ],
    itemClasses: ['wand', 'staff', 'bow', 'sword', 'axe', 'mace', 'sceptre', 'dagger', 'claw', 'ring', 'amulet', 'belt', 'helmet', 'gloves'],
    tags: ['critical', 'crit', 'chance', 'attack'],
    weight: 45,
  },
  {
    name: 'increased Elemental Damage',
    slot: 'suffix',
    tiers: [
      { text: '15% increased Elemental Damage', value: 15, ilvl: 25 },
      { text: '25% increased Elemental Damage', value: 25, ilvl: 50 },
      { text: '35% increased Elemental Damage', value: 35, ilvl: 75 },
    ],
    itemClasses: ['wand', 'staff', 'bow', 'sword', 'axe', 'mace', 'sceptre', 'dagger', 'claw', 'ring', 'amulet', 'belt'],
    tags: ['elemental', 'damage', 'increased'],
    weight: 70,
  },
  {
    name: 'to Maximum Mana',
    slot: 'suffix',
    tiers: [
      { text: '+30 to Maximum Mana', value: 30, ilvl: 20 },
      { text: '+50 to Maximum Mana', value: 50, ilvl: 45 },
      { text: '+80 to Maximum Mana', value: 80, ilvl: 70 },
      { text: '+120 to Maximum Mana', value: 120, ilvl: 90 },
    ],
    itemClasses: ['helmet', 'chest', 'gloves', 'belt', 'ring', 'amulet', 'wand', 'staff'],
    tags: ['mana', 'maximum', 'flat', 'defence'],
    weight: 65,
  },
  {
    name: 'to Maximum Life',
    slot: 'suffix',
    tiers: [
      { text: '+40 to Maximum Life', value: 40, ilvl: 20 },
      { text: '+70 to Maximum Life', value: 70, ilvl: 45 },
      { text: '+110 to Maximum Life', value: 110, ilvl: 70 },
      { text: '+170 to Maximum Life', value: 170, ilvl: 90 },
    ],
    itemClasses: ['helmet', 'chest', 'gloves', 'boots', 'belt', 'ring', 'amulet'],
    tags: ['life', 'maximum', 'flat', 'defence'],
    weight: 65,
  },
  {
    name: 'to all Attributes',
    slot: 'suffix',
    tiers: [
      { text: '+5 to all Attributes', value: 5, ilvl: 30 },
      { text: '+10 to all Attributes', value: 10, ilvl: 60 },
      { text: '+16 to all Attributes', value: 16, ilvl: 85 },
    ],
    itemClasses: ['helmet', 'chest', 'gloves', 'boots', 'belt', 'ring', 'amulet'],
    tags: ['attribute', 'str', 'dex', 'int', 'all'],
    weight: 12,
  },
  {
    name: 'to Fire Resistance',
    slot: 'suffix',
    tiers: [
      { text: '+15% to Fire Resistance', value: 15, ilvl: 20 },
      { text: '+25% to Fire Resistance', value: 25, ilvl: 45 },
      { text: '+38% to Fire Resistance', value: 38, ilvl: 70 },
    ],
    itemClasses: ['helmet', 'chest', 'gloves', 'boots', 'ring', 'amulet'],
    tags: ['resistance', 'fire', 'defence'],
    weight: 40,
  },
  {
    name: 'to Spell Suppression',
    slot: 'suffix',
    tiers: [
      { text: '5% increased Spell Suppression Chance', value: 5, ilvl: 35 },
      { text: '10% increased Spell Suppression Chance', value: 10, ilvl: 65 },
    ],
    itemClasses: ['helmet', 'chest', 'gloves', 'boots'],
    tags: ['suppression', 'spell', 'defence'],
    weight: 30,
  },
  {
    name: 'chance to Ignite',
    slot: 'suffix',
    tiers: [
      { text: '20% chance to Ignite', value: 20, ilvl: 35 },
      { text: '30% chance to Ignite', value: 30, ilvl: 60 },
    ],
    itemClasses: ['wand', 'staff', 'bow', 'ring', 'amulet', 'belt', 'gloves', 'helmet'],
    tags: ['ignite', 'ailment', 'chance', 'fire'],
    weight: 30,
  },
];