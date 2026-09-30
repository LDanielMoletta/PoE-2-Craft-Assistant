import {
  normalizeItemClass,
  type Item,
  type ItemClass,
  type ItemModifier,
  type ItemProperties,
  type ItemRarity,
  type ModifierOrigin,
  type ModifierSlot,
  type ParseResult,
} from '../types/index.js';

/** Separador de secao do item copiado no Path of Exile (8 tracos). */
const SEPARATOR_RE = /^\s*-{6,}\s*$/;

/** Cabecalho que marca o inicio de um item. */
const ITEM_HEADER_RE = /^\s*Item Class:\s*/i;

/** Uma secao e o bloco de texto entre dois separadores. */
type Section = readonly string[];

/** Cada item e composto por varias secoes: header, props, requisitos, mods... */
export interface RawItem {
  readonly text: string;
  readonly sections: readonly Section[];
  readonly index: number;
}

const RARITY_TOKENS: Readonly<Record<string, ItemRarity>> = {
  normal: 'normal',
  magic: 'magic',
  rare: 'rare',
  unique: 'unique',
  gem: 'gem',
  currency: 'currency',
  quest: 'quest',
};

/** Propriedades que ficam antes dos modificadores. */
const PROPERTY_PATTERNS: ReadonlyArray<{ re: RegExp; key: keyof ItemProperties }> = [
  { re: /^Physical Damage:/i, key: 'physicalDamage' },
  { re: /^Critical Strike Chance:/i, key: 'criticalStrikeChance' },
  { re: /^Critical Damage Multiplier:/i, key: 'criticalStrikeMultiplier' },
  { re: /^Attacks per Second:/i, key: 'attacksPerSecond' },
  { re: /^Armour:/i, key: 'armour' },
  { re: /^Evasion Rating:/i, key: 'evasionRating' },
  { re: /^Energy Shield:/i, key: 'energyShield' },
  { re: /^Ward:/i, key: 'ward' },
];

const ELEMENTAL_DAMAGE_RE = /^(flat|added)\s+(fire|cold|lightning|chaos)\s+damage/i;
const REQUIREMENT_LINE_RE = /^(level|str|str strength|dex|dexterity|int|intelligence)\s*:/i;
const SOCKET_LINE_RE = /^sockets\s*:/i;
const NUMBER_RE = /-?\d+(?:\.\d+)?/g;

/** Prefixos tipicos de implicit em PoE2 (vêm sempre antes dos suffixes). */
const IMPLICIT_SLOT_HINTS: readonly string[] = [
  'adds',
  'plus',
  'to level of',
  'flat fire damage',
  'flat cold damage',
  'flat lightning damage',
  'flat chaos damage',
  'physical damage',
  'attacks per second',
  'critical strike chance',
];

/**
 * Normaliza quebras de linha e espacos vindos do clipboard do Windows.
 * O jogo usa \n, mas o PowerShell/clipboard pode entregar \r\n.
 */
export function normalizeClipboardText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Divide o clipboard em ITENS (nao em secoes).
 *
 * No PoE2, `--------` separa secoes dentro do mesmo item. Quando o jogador
 * copia varios itens, o texto reinicia com `Item Class:` — e esse cabecalho,
 * nao o separador, que delimita um item novo.
 */
export function splitIntoItems(text: string): readonly RawItem[] {
  const normalized = normalizeClipboardText(text);
  if (normalized.length === 0) return [];

  const lines = normalized.split('\n');
  const starts: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (ITEM_HEADER_RE.test(line)) starts.push(index);
  }

  if (starts.length === 0) return [];

  const items: RawItem[] = [];
  for (const [order, start] of starts.entries()) {
    const end = starts[order + 1] ?? lines.length;
    const itemText = lines.slice(start, end).join('\n').trim();
    if (itemText.length === 0) continue;

    const sections = itemText
      .split(new RegExp(SEPARATOR_RE.source, 'gm'))
      .map((block) => block.split('\n').map((l) => l.trim()).filter((l) => l.length > 0))
      .filter((block) => block.length > 0);

    items.push({ text: itemText, sections, index: items.length });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Modificadores
// ---------------------------------------------------------------------------

/** Extrai `(implicit)`, `(crafted)`, `(enchant)`... do fim da linha. */
function extractOrigin(text: string): { clean: string; origin: ModifierOrigin } {
  const match = /\((implicit|crafted|enchant|rune|veiled|synthetic)\)\s*$/i.exec(text);
  if (match === null || match.index === undefined) {
    return { clean: text, origin: 'unknown' };
  }
  const token = (match[1] ?? '').toLowerCase();
  const origin: ModifierOrigin = token === 'synthetic' ? 'veiled' : (token as ModifierOrigin);
  return { clean: text.slice(0, match.index).trim(), origin };
}

/** Extrai `(T3)` e `(Q5)` do fim da linha. */
function extractTierInfo(text: string): {
  tier: number | null;
  quality: number | null;
  clean: string;
} {
  let clean = text;
  let tier: number | null = null;
  let quality: number | null = null;

  const tierMatch = /\s*\(T(\d+)\)\s*$/i.exec(clean);
  if (tierMatch !== null) {
    tier = Number.parseInt(tierMatch[1] ?? '', 10);
    clean = clean.slice(0, tierMatch.index).trim();
  }

  const qualityMatch = /\s*\(Q(\d+)\)\s*$/i.exec(clean);
  if (qualityMatch !== null) {
    quality = Number.parseInt(qualityMatch[1] ?? '', 10);
    clean = clean.slice(0, qualityMatch.index).trim();
  }

  return { tier, quality, clean };
}

/** Todos os numeros de uma linha, na ordem. */
export function extractNumbers(text: string): readonly number[] {
  const matches = text.match(NUMBER_RE);
  if (matches === null) return [];
  return matches
    .map((m) => Number.parseFloat(m))
    .filter((n) => Number.isFinite(n));
}

/** Maior valor absoluto da linha, 0 quando nao ha numeros. */
function primaryMagnitude(text: string): number | null {
  const values = extractNumbers(text);
  if (values.length === 0) return null;
  return values.reduce((best, current) => (Math.abs(current) > Math.abs(best) ? current : best), 0);
}

/** Normaliza texto para comparacao: minusculas, sem pontuacao. */
export function normalizeModText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[+−-]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens significativos para matching de texto livre ("fire damage"). */
export function tokenize(text: string): readonly string[] {
  const STOP = new Set(['to', 'of', 'all', 'per', 'the', 'and', 'with', 'a', 'an']);
  return normalizeModText(text)
    .split(' ')
    .filter((token) => token.length > 1 && !STOP.has(token));
}

/** Converte uma linha de modificador em `ItemModifier`. */
export function toItemModifier(raw: string): ItemModifier {
  const trimmed = raw.trim();
  const { clean: withoutOrigin, origin } = extractOrigin(trimmed);
  const { tier, quality, clean } = extractTierInfo(withoutOrigin);
  const normalized = normalizeModText(clean);

  // Heuristica de slot: `none` significa "nao classificado" neste estagio.
  let slot: ModifierSlot = 'none';
  if (/^(adds|added|flat|physical|elemental|weapon|critical strike chance|attacks per second)/.test(normalized)) {
    slot = 'prefix';
  } else if (/(increased|reduced|more|less|to maximum|per|chance to|when you|duration|resistance|damage taken|chance to)/.test(normalized)) {
    slot = 'suffix';
  }

  if (origin === 'implicit') {
    // Implicits vem em ordem fixa: os primeiros sao prefixos, o resto suffixes.
    slot = IMPLICIT_SLOT_HINTS.some((hint) => normalized.startsWith(hint)) ? 'prefix' : 'suffix';
  }

  return { raw: trimmed, text: clean, tier, quality, slot, origin, magnitude: primaryMagnitude(clean) };
}

// ---------------------------------------------------------------------------
// Header, escalares, propriedades
// ---------------------------------------------------------------------------

/** Le `Item Class:`, `Rarity:`, nome e base do header. */
function parseHeader(section: Section | undefined): {
  itemClass: ItemClass;
  rarity: ItemRarity;
  name: string | null;
  baseType: string | null;
} {
  let itemClass: ItemClass = 'other';
  let rarity: ItemRarity = 'normal';
  let name: string | null = null;
  let baseType: string | null = null;
  let seenClass = false;
  let seenRarity = false;
  let headerEnded = false;

  for (const rawLine of section ?? []) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (!headerEnded) {
      const classMatch = /^Item Class:\s*(.+)$/i.exec(line);
      if (classMatch !== null) {
        itemClass = normalizeItemClass(classMatch[1] ?? '');
        seenClass = true;
        continue;
      }
      const rarityMatch = /^Rarity:\s*(.+)$/i.exec(line);
      if (rarityMatch !== null) {
        rarity = RARITY_TOKENS[(rarityMatch[1] ?? '').trim().toLowerCase()] ?? 'normal';
        seenRarity = true;
        continue;
      }
      if (!seenClass && !seenRarity) continue;

      // Nome = primeira linha livre depois do cabecalho; base = a seguinte.
      if (name === null) {
        name = line;
        continue;
      }
      baseType = line;
      headerEnded = true;
    }
  }

  return { itemClass, rarity, name, baseType };
}

/** Indices das secoes que contem os escalares do item (Item Level, Quality...). */
function findScalarSectionIndex(sections: readonly Section[]): number {
  return sections.findIndex((section) =>
    section.some((line) => /^(item level|area level|quality|talisman tier):/i.test(line)),
  );
}

/** Le `Item Level`, `Quality`, flags de corrupcao. */
function parseScalars(sections: readonly Section[]): {
  itemLevel: number | null;
  areaLevel: number | null;
  quality: number | null;
  talismanTier: number | null;
  corrupted: boolean;
  mirrored: boolean;
  split: boolean;
  identified: boolean;
} {
  const flat = sections.flat();
  const text = flat.join('\n');

  const readInt = (re: RegExp): number | null => {
    const match = re.exec(text);
    if (match === null) return null;
    const value = Number.parseInt(match[1] ?? '', 10);
    return Number.isFinite(value) ? value : null;
  };

  return {
    itemLevel: readInt(/^Item Level:\s*(\d+)/im),
    areaLevel: readInt(/^Area Level:\s*(\d+)/im),
    quality: readInt(/^Quality:\s*(\d+)%/im),
    talismanTier: readInt(/^Talisman Tier:\s*(\d+)/im),
    corrupted: /^Corrupted/im.test(text),
    mirrored: /^Mirrored/im.test(text),
    split: /^Split/im.test(text),
    identified: !/^Unidentified/im.test(text),
  };
}

/** Requisitos, sockets e propriedades numericas. */
function parseProperties(sections: readonly Section[], scalarIndex: number): ItemProperties {
  const requirements: Record<string, string> = {};
  const sockets: string[] = [];
  const elemental: string[] = [];
  const props: Record<string, string> = {};

  const bodyEnd = scalarIndex < 0 ? sections.length : scalarIndex;

  for (const section of sections.slice(1, bodyEnd)) {
    let mode: 'none' | 'requirements' | 'sockets' = 'none';

    for (const line of section) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      if (/^requirements\s*:?$/i.test(trimmed)) {
        mode = 'requirements';
        continue;
      }
      if (SOCKET_LINE_RE.test(trimmed)) {
        mode = 'sockets';
      }

      if (mode === 'requirements') {
        const match = REQUIREMENT_LINE_RE.exec(trimmed);
        if (match !== null) {
          requirements[match[1] ?? ''] = trimmed.slice(trimmed.indexOf(':') + 1).trim();
        }
        continue;
      }

      if (mode === 'sockets') {
        const body = trimmed.replace(/^sockets\s*:\s*/i, '');
        sockets.push(...body.split(/\s+/).filter(Boolean));
        continue;
      }

      if (!trimmed.includes(':')) continue;

      if (ELEMENTAL_DAMAGE_RE.test(trimmed)) {
        elemental.push(trimmed);
        continue;
      }
      const matched = PROPERTY_PATTERNS.find((pattern) => pattern.re.test(trimmed));
      if (matched !== undefined) {
        props[matched.key as string] = trimmed.slice(trimmed.indexOf(':') + 1).trim();
      }
    }
  }

  return {
    physicalDamage: props['physicalDamage'],
    elementalDamage: elemental.length > 0 ? elemental : undefined,
    criticalStrikeChance: props['criticalStrikeChance'],
    criticalStrikeMultiplier: props['criticalStrikeMultiplier'],
    attacksPerSecond: props['attacksPerSecond'],
    armour: props['armour'],
    evasionRating: props['evasionRating'],
    energyShield: props['energyShield'],
    ward: props['ward'],
    requirements,
    sockets,
  };
}

/**
 * Modificadores ficam DEPOIS da secao de `Item Level` no texto do jogo.
 * Cada secao seguinte e um modificador (o jogo sempre poe um por linha).
 */
function collectModifiers(sections: readonly Section[], scalarIndex: number): readonly ItemModifier[] {
  if (scalarIndex < 0) return [];

  const modifiers: ItemModifier[] = [];
  for (const section of sections.slice(scalarIndex + 1)) {
    const lines = section.filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      if (/^(corrupted|mirrored|split|unidentified|fractured|veiled)\b/i.test(trimmed)) return false;
      return (
        trimmed.startsWith('+') ||
        trimmed.startsWith('-') ||
        /^(grants|chance to|increased|reduced|more|less|adds|flat|each|per|placeholder)\b/i.test(trimmed)
      );
    });

    for (const line of lines) {
      modifiers.push(toItemModifier(line));
    }
  }

  return modifiers;
}

// ---------------------------------------------------------------------------
// API do modulo
// ---------------------------------------------------------------------------

/** Converte um item cru (com suas secoes) em `Item`. */
export function parseItem(raw: RawItem): Item {
  const scalarIndex = findScalarSectionIndex(raw.sections);
  const header = parseHeader(raw.sections[0]);
  const scalars = parseScalars(raw.sections);

  return {
    name: header.name,
    baseType: header.baseType,
    itemClass: header.itemClass,
    rarity: header.rarity,
    itemLevel: scalars.itemLevel,
    areaLevel: scalars.areaLevel,
    quality: scalars.quality,
    corrupted: scalars.corrupted,
    mirrored: scalars.mirrored,
    split: scalars.split,
    identified: scalars.identified,
    talismanTier: scalars.talismanTier,
    modifiers: collectModifiers(raw.sections, scalarIndex),
    properties: parseProperties(raw.sections, scalarIndex),
    rawText: raw.text,
  };
}

/**
 * Ponto de entrada do modulo: recebe o texto bruto do clipboard e devolve
 * todos os itens encontrados (o jogo permite copiar varios de uma vez).
 */
export function parseItemText(clipboardText: string): ParseResult {
  const warnings: string[] = [];
  const raws = splitIntoItems(clipboardText);

  if (raws.length === 0) {
    const normalized = normalizeClipboardText(clipboardText);
    if (normalized.length === 0) {
      return { items: [], warnings: ['Clipboard vazio.'] };
    }
    return {
      items: [],
      warnings: [
        'Texto nao parece um item do Path of Exile: nenhum cabecalho "Item Class:" foi encontrado.',
      ],
    };
  }

  const items = raws.map(parseItem);

  for (const item of items) {
    if (item.rarity === 'rare' && item.modifiers.length === 0) {
      warnings.push(`Item "${item.name ?? item.baseType ?? 'desconhecido'}" veio sem modificadores legiveis.`);
    }
  }

  return { items, warnings };
}

/** Atalho para o caso de uso do overlay: pega o primeiro item. */
export function parseFirstItem(clipboardText: string): Item | null {
  return parseItemText(clipboardText).items[0] ?? null;
}