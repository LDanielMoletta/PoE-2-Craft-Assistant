import { useMemo, useRef, useState, type ReactNode } from 'react';

import type { ItemModifier } from '../types/index.js';
import { ORIGIN_COLOR, ORIGIN_LABEL, SLOT_LABEL } from './itemView.js';

export interface TargetChoice {
  readonly text: string;
  readonly slot: ItemModifier['slot'];
  readonly tier: number | null;
  readonly origin: ItemModifier['origin'];
}

/** Normaliza para comparar query digitada com modificadores reais. */
function needle(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function haystackOf(choice: TargetChoice): string {
  return needle(choice.text);
}

function score(query: string, choice: TargetChoice): number {
  const q = needle(query);
  const h = haystackOf(choice);
  if (q.length === 0) return 0;
  if (h === q) return 100;
  if (h.startsWith(q)) return 60;
  if (h.includes(q)) return 30;
  // Casamento por token: "fire" acha "of Fire Damage" mesmo fora de ordem.
  const tokens = q.split(' ');
  const hits = tokens.filter((token) => h.includes(token)).length;
  return hits === 0 ? 0 : (hits / tokens.length) * 20;
}

/**
 * Autocomplete dos modificadores desejados.
 *
 * A lista vem do item capturado, nao do catalogo: o jogador quer escolher
 * entre as linhas que ele REALMENTE pode ter, o que evita pedir um mod que
 * nao existe na base daquele item.
 */
export function TargetSelector({
  candidates,
  selected,
  onSelect,
  onRemove,
  placeholder = 'Adicionar modificador desejado…',
  limit = 12,
}: {
  readonly candidates: readonly TargetChoice[];
  readonly selected: readonly string[];
  readonly onSelect: (choice: TargetChoice) => void;
  readonly onRemove: (text: string) => void;
  readonly placeholder?: string;
  readonly limit?: number;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const suggestions = useMemo(() => {
    if (query.trim().length === 0) return [];
    const already = new Set(selected.map(needle));
    return candidates
      .filter((choice) => !already.has(haystackOf(choice)))
      .map((choice) => ({ choice, weight: score(query, choice) }))
      .filter((entry) => entry.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 8)
      .map((entry) => entry.choice);
  }, [candidates, query, selected]);

  const commit = (choice: TargetChoice): void => {
    if (selected.length >= limit) return;
    onSelect(choice);
    setQuery('');
    setHighlight(0);
  };

  return (
    <div className="px-4 py-2">
      {selected.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1">
          {selected.map((text) => (
            <li key={text}>
              <button
                type="button"
                onClick={() => {
                  onRemove(text);
                }}
                className="rounded border border-emerald-800 bg-emerald-950/50 px-2 py-0.5 text-xs text-emerald-200 hover:border-red-800 hover:bg-red-950/50 hover:text-red-200"
                title="Remover alvo"
              >
                {text} ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setHighlight((index) => Math.min(index + 1, suggestions.length - 1));
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setHighlight((index) => Math.max(index - 1, 0));
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              const choice = suggestions[highlight];
              if (choice !== undefined) commit(choice);
              return;
            }
            if (event.key === 'Backspace' && query.length === 0 && selected.length > 0) {
              const last = selected.at(-1);
              if (last !== undefined) onRemove(last);
            }
          }}
          className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-700 focus:outline-none"
        />

        {suggestions.length > 0 && (
          <ul className="absolute inset-x-0 top-full z-10 mt-0.5 max-h-52 overflow-y-auto rounded border border-slate-700 bg-slate-900 shadow-lg">
            {suggestions.map((choice, index) => (
              <li key={`${choice.text}-${index}`}>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    commit(choice);
                  }}
                  onMouseEnter={() => {
                    setHighlight(index);
                  }}
                  className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs ${
                    index === highlight ? 'bg-slate-800' : ''
                  }`}
                >
                  <span
                    className={`rounded border px-1 py-0.5 text-[9px] uppercase ${ORIGIN_COLOR[choice.origin]}`}
                  >
                    {ORIGIN_LABEL[choice.origin]}
                  </span>
                  <span className="truncate text-slate-200">{choice.text}</span>
                  {choice.tier !== null && (
                    <span className="ml-auto shrink-0 text-slate-500">T{choice.tier}</span>
                  )}
                  <span className="shrink-0 text-slate-500">{SLOT_LABEL[choice.slot]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
