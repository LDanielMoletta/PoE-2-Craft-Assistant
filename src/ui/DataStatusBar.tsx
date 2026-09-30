import type { ReactNode } from 'react';

import { describeDataStatus, type DataStatus } from '../scraper/dataHydration.js';

/**
 * Rodape de status da base de dados.
 *
 * Existe por um motivo concreto: as chances mostradas no plano dependem
 * inteiramente de qual base esta em uso. Sem isso, o jogador nao tem como
 * saber se esta vendo os pesos da league de hoje ou um snapshot de fallback —
 * e uma chance de 12% que virou 4% por causa de uma revalidacao que falhou
 * parece bug do planner.
 */
export function DataStatusBar({
  status,
  onRefresh,
}: {
  readonly status: DataStatus;
  /** Ausente esconde o botao (usado onde nao ha IPC, como no teste de UI). */
  readonly onRefresh?: () => void;
}): ReactNode {
  const label = describeDataStatus(status);

  const tone: Readonly<Record<string, string>> = {
    ok: 'text-slate-500',
    warn: 'text-amber-400/90',
    error: 'text-red-400/90',
  };
  const dot: Readonly<Record<string, string>> = {
    ok: 'bg-emerald-500',
    warn: 'bg-amber-400',
    error: 'bg-red-500',
  };

  const counts =
    status.state === 'empty'
      ? null
      : `${status.modifiers} mods · ${status.bases} bases · ${status.currencies} moedas`;

  return (
    <footer
      className="flex items-center gap-2 border-t border-slate-800 px-3 py-1 text-[10px]"
      title={label.title}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot[label.tone]}`} aria-hidden="true" />
      <span className={tone[label.tone]}>
        {label.text}
        {counts !== null && <span className="text-slate-600"> · {counts}</span>}
      </span>

      <span className="ml-auto flex items-center gap-1.5">
        {status.league !== null && <span className="text-slate-600">{status.league}</span>}
        {onRefresh !== undefined && (
          <button
            type="button"
            onClick={onRefresh}
            className="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
            title="Tentar revalidar a base a partir da fonte externa"
          >
            Atualizar
          </button>
        )}
      </span>
    </footer>
  );
}
