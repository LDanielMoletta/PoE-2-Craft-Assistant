import type {
  CurrencyUnit,
  DesiredModifier,
  Item,
  ItemRarity,
  ModifierOrigin,
  ModifierSlot,
} from '../types/index.js';

export interface ItemModifierView {
  readonly text: string;
  readonly tier: number | null;
  readonly quality: number | null;
  readonly slot: ModifierSlot;
  readonly origin: ModifierOrigin;
  readonly magnitude: number | null;
  /** Linha pode ser alvo do craft atual. */
  readonly matched: boolean;
  /** Slot alvo em que este modificador deve entrar. */
  readonly targetSlot: ModifierSlot | 'any';
}

/** Classes de cor por raridade (baseado no texto do jogo). */
export const RARITY_COLOR: Readonly<Record<ItemRarity, string>> = {
  normal: 'text-slate-300',
  magic: 'text-sky-300',
  rare: 'text-yellow-200',
  unique: 'text-orange-300',
  gem: 'text-emerald-300',
  currency: 'text-amber-200',
  quest: 'text-violet-300',
};

/** Rotulo curto da origem de um modificador, exibido como badge. */
export const ORIGIN_LABEL: Readonly<Record<ModifierOrigin, string>> = {
  implicit: 'Implícito',
  crafted: 'Criado',
  enchant: 'Encantado',
  rune: 'Runa',
  veiled: 'Veilado',
  unknown: 'Desconhecido',
};

/** Classes de cor por origem, para diferenciar o que e' alvo. */
export const ORIGIN_COLOR: Readonly<Record<ModifierOrigin, string>> = {
  implicit: 'border-slate-600 bg-slate-800/60 text-slate-300',
  crafted: 'border-amber-700 bg-amber-900/30 text-amber-200',
  enchant: 'border-teal-700 bg-teal-900/30 text-teal-200',
  rune: 'border-indigo-700 bg-indigo-900/30 text-indigo-200',
  veiled: 'border-fuchsia-700 bg-fuchsia-900/30 text-fuchsia-200',
  unknown: 'border-slate-700 bg-slate-800 text-slate-400',
};

export const SLOT_LABEL: Readonly<Record<ModifierSlot, string>> = {
  prefix: 'Prefixo',
  suffix: 'Sufixo',
  none: 'Neutro',
};

const SLOT_ORDER: Readonly<Record<ModifierSlot, number>> = { prefix: 0, suffix: 1, none: 2 };

/**
 * Prepara os modificadores do item para exibicao, marcando quais casam com os
 * desejados. O overlay precisa dessa informacao porque o jogador decide
 * aceitar ou tentar de novo olhando os mods lado a lado.
 */
export function buildModifierViews(
  item: Item,
  desired: readonly DesiredModifier[] = [],
): ItemModifierView[] {
  const normalized = desired.map((d) => ({ ...d, needle: normalize(d.query) }));

  return [...item.modifiers]
    .sort((a, b) => {
      const bySlot = SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot];
      if (bySlot !== 0) return bySlot;
      return (a.tier ?? 99) - (b.tier ?? 99);
    })
    .map((mod) => {
      const haystack = normalize(mod.text);
      const hit = normalized.find(
        (d) =>
          (d.slot === 'any' || mod.slot === 'none' || d.slot === mod.slot) &&
          d.needle.length > 0 &&
          haystack.includes(d.needle),
      );
      return {
        text: mod.text,
        tier: mod.tier,
        quality: mod.quality,
        slot: mod.slot,
        origin: mod.origin,
        magnitude: mod.magnitude,
        matched: hit !== undefined,
        targetSlot: hit?.slot ?? 'any',
      };
    });
}

/** Remove acentos e pontuacao, para comparar query do usuario com o mod real. */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Linhas implicitas nunca sao alvo, porque nenhuma moeda as altera. */
export function isCraftable(view: ItemModifierView): boolean {
  return view.origin !== 'implicit';
}

/** Formata o custo com a unidade de moeda do plano. */
export function formatCurrency(amount: number, currency: CurrencyUnit): string {
  const rounded = Math.round(amount * 10) / 10;
  const suffix: Readonly<Record<CurrencyUnit, string>> = {
    exalted: 'ex',
    divine: 'div',
    chaos: 'chaos',
    annul: 'anul',
  };
  return `${rounded} ${suffix[currency]}`;
}

/** Percentual legivel, arredondado. */
export function formatPercent(ratio: number): string {
  if (ratio <= 0) return '0%';
  if (ratio >= 1) return '100%';
  if (ratio < 0.01) return '<1%';
  return `${Math.round(ratio * 100)}%`;
}

/** Classe de cor conforme o veredito de risco. */
export const RISK_COLOR: Readonly<Record<string, string>> = {
  cheap: 'text-emerald-300',
  fair: 'text-yellow-200',
  expensive: 'text-orange-300',
  unaffordable: 'text-red-400',
};
