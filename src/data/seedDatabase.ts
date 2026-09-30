import { ORB_CATALOG, SEED_MODS } from '../scraper/catalog.js';
import { SLOT_LIMITS } from '../types/index.js';

/**
 * Monta a base de craft a partir do catalogo que ja existe no repo.
 *
 * Material bruto do snapshot `poe2_mods_db.json`: os mesmos `SEED_MODS` e
 * `ORB_CATALOG` que o planner ja usava como fallback, empacotados no formato
 * que a hydration valida. `scripts/buildModsSnapshot.ts` grava o JSON com este
 * builder e o renderer embute o mesmo resultado; um teste garante paridade.
 */

export const SEED_DATABASE_LEAGUE = 'Standard';

/**
 * De proposito no passado: um snapshot com data no futuro "roubaria" o TTL de
 * 24h e o overlay nunca tentaria revalidar.
 */
export const SEED_DATABASE_UPDATED_AT = '2025-06-01T00:00:00.000Z';

export const SEED_DATABASE_VERSION = 1;

/** Bases concretas por classe, que e' o que o jogador ve no jogo. */
const BASE_NAMES: Readonly<Record<string, readonly string[]>> = {
  wand: ['Crackling Wand', 'Slicing Wand', 'Tornado Wand'],
  staff: ['Long Staff', 'Coiled Staff', 'Judgement Staff'],
  bow: ['Short Bow', 'Composite Bow', 'Gemini Bow'],
  sword: ['Rusted Sword', 'Vaal Blade', 'Exquisite Blade'],
  axe: ['Rusted Axe', 'Siege Axe', 'Vaal Axe'],
  mace: ['Driftwood Club', 'Forge Maul', 'Caged Mace'],
  sceptre: ['Worn Sceptre', 'Ochre Sceptre', 'Sovereign Sceptre'],
  dagger: ['Ambusher Dagger', 'Glass Shank', 'Imperial Skean'],
  claw: ['Nailed Claw', 'Bear Claw', 'Twin Claw'],
  chest: ['Simple Robe', 'Plate Vest', 'Grand Regalia'],
  helmet: ['Iron Hat', 'Leather Cap', 'Fossilised Spirit Shield'],
  gloves: ['Silk Gloves', 'Plated Gauntlets', 'Gripped Gloves'],
  boots: ['Worn Boots', 'Iron Greaves', 'Slink Boots'],
  shield: ['Tarnished Buckler', 'Jade Kite', 'Rawhide Buckler'],
  quiver: ['Slim Quiver', 'Broadhead Quiver', 'Gem Quiver'],
  belt: ['Heavy Belt', 'Vanguard Belt', 'Headhunter Belt'],
  ring: ['Iron Ring', 'Sapphire Ring', 'Gold Ring'],
  amulet: ['Iron Amulet', 'Jade Amulet', 'Blue Pearl Amulet'],
  jewel: ['Cobalt Jewel', 'Viridian Jewel', 'Crimson Jewel'],
  other: ['Lesser Jewell', 'Time-Lost Relic', 'Ancient Corpse'],
};

/** Rotulo curto por classe, para a lista de bases na UI. */
const CLASS_LABELS: Readonly<Record<string, string>> = {
  wand: 'Wand',
  staff: 'Staff',
  bow: 'Bow',
  sword: 'Sword',
  axe: 'Axe',
  mace: 'Mace',
  sceptre: 'Sceptre',
  dagger: 'Dagger',
  claw: 'Claw',
  chest: 'Corpo',
  helmet: 'Elmo',
  gloves: 'Luvas',
  boots: 'Botas',
  shield: 'Escudo',
  quiver: 'Aljava',
  belt: 'Cinto',
  ring: 'Anel',
  amulet: 'Amuleto',
  jewel: 'Joia',
  other: 'Outro',
};

/** Slug estavel, no mesmo formato usado por `seedModsToDefinitions`. */
function modId(name: string, slot: string, tier: number): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}#${slot}#t${tier}`;
}

/** Mods do catalogo seed, um registro por tier, sem `maxTier`. */
function seedModifiers(): readonly Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];

  for (const seed of SEED_MODS) {
    seed.tiers.forEach((tier, index) => {
      rows.push({
        id: modId(seed.name, seed.slot, index + 1),
        name: seed.name,
        slot: seed.slot,
        tier: index + 1,
        text: tier.text,
        value: tier.value,
        requiredItemLevel: tier.ilvl,
        weight: seed.weight,
        itemClasses: [...seed.itemClasses],
        tags: [...seed.tags],
      });
    });
  }

  return rows;
}

function seedBases(): readonly Record<string, unknown>[] {
  return Object.entries(SLOT_LIMITS).map(([itemClass, limits]) => ({
    id: `base:${itemClass}`,
    name: CLASS_LABELS[itemClass] ?? itemClass,
    itemClass,
    maxPrefixes: limits.prefixes,
    maxSuffixes: limits.suffixes,
    baseNames: [...(BASE_NAMES[itemClass] ?? [])],
  }));
}

function seedCurrencies(): readonly Record<string, unknown>[] {
  return ORB_CATALOG.map((orb) => ({
    id: `currency:${orb.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: orb.name,
    kind: orb.kind,
    appliesToEmptySlot: orb.appliesToEmptySlot,
    overwritesExisting: orb.overwritesExisting,
    costInExalted: orb.costInExalted,
    slotFilter: [...orb.slotFilter],
    improvesTier: orb.improvesTier,
    removesPerUse: orb.removesPerUse,
    description: orb.description,
  }));
}

export interface SeedDatabaseOptions {
  readonly league?: string;
  readonly updatedAt?: string;
  readonly version?: number;
}

/** Retorno `unknown` de proposito: quem consome passa pelo validador, e assim
 * o snapshot seed exercita o mesmo caminho de dados que a fonte externa. */
export function buildSeedDatabase(options: SeedDatabaseOptions = {}): unknown {
  return {
    version: options.version ?? SEED_DATABASE_VERSION,
    league: options.league ?? SEED_DATABASE_LEAGUE,
    updatedAt: options.updatedAt ?? SEED_DATABASE_UPDATED_AT,
    modifiers: seedModifiers(),
    bases: seedBases(),
    currencies: seedCurrencies(),
  };
}
