import { useMemo, type ReactNode } from 'react';

import type { DesiredModifier, Item } from '../types/index.js';
import {
  ORIGIN_COLOR,
  ORIGIN_LABEL,
  RARITY_COLOR,
  SLOT_LABEL,
  buildModifierViews,
} from './itemView.js';

/** Cabecalho do item: nome, base, raridade, item level e flags. */
export function ItemHeader({ item }: { readonly item: Item }): ReactNode {
  const title = item.name ?? item.baseType ?? 'Item desconhecido';
  const quality = item.quality !== null ? ` (${item.quality}%)` : '';
  const itemLevel = item.itemLevel !== null ? `iLv ${item.itemLevel}` : 'iLv —';

  const headerStyle: React.CSSProperties = {
    WebkitAppRegion: 'drag',
  } as React.CSSProperties;

  const noDragStyle: React.CSSProperties = {
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties;

  return (
    <header 
      className="border-b border-slate-700/60 px-4 py-3"
      style={headerStyle}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h1 className={`truncate text-lg font-semibold ${RARITY_COLOR[item.rarity]}`}>
          {title}
          {quality}
        </h1>
        <span className="shrink-0 rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300" style={noDragStyle}>
          {itemLevel}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400" style={noDragStyle}>
        {item.baseType !== null && <span>{item.baseType}</span>}
        <span className="uppercase tracking-wide">{item.itemClass}</span>
        <span className="capitalize">{item.rarity}</span>
        {item.corrupted && <span className="text-red-400">Corrompido</span>}
        {item.mirrored && <span className="text-fuchsia-300">Espelhado</span>}
        {!item.identified && <span className="text-yellow-300">Não identificado</span>}
      </div>
    </header>
  );
}

/** Lista de modificadores com destaque para os que casam com o alvo. */
export function ModifierList({
  item,
  desired = [],
}: {
  readonly item: Item;
  readonly desired?: readonly DesiredModifier[];
}): ReactNode {
  const views = useMemo(() => buildModifierViews(item, desired), [item, desired]);

  if (views.length === 0) {
    return <p className="px-4 py-3 text-sm text-slate-500">Nenhum modificador identificado.</p>;
  }

  return (
    <ul className="divide-y divide-slate-800/80">
      {views.map((view, index) => (
        <li
          key={`${view.text}-${index}`}
          className={`flex items-center gap-2 px-4 py-1.5 text-sm ${
            view.matched ? 'bg-emerald-950/30' : ''
          }`}
        >
          <span
            className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase ${ORIGIN_COLOR[view.origin]}`}
          >
            {ORIGIN_LABEL[view.origin]}
          </span>
          <span className={view.matched ? 'text-emerald-200' : 'text-slate-200'}>{view.text}</span>
          {view.tier !== null && <span className="ml-auto text-xs text-slate-500">T{view.tier}</span>}
          <span className="text-xs text-slate-500">{SLOT_LABEL[view.slot]}</span>
        </li>
      ))}
    </ul>
  );
}
