import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { HotkeyAction, UserConfig } from '../config/index.js';
import { formatSequence, type HotkeyValidation } from '../overlay/hotkeyValidation.js';
import { ActionButton, NumberField, Toggle } from './primitives.js';

/** Evento de tecla entregue a UI, sem os tipos de baixo nivel do backend. */
export interface UiKeyPress {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

/**
 * Teclado observavel pela UI.
 *
 * `available` false desabilita a captura ao vivo: sem backend nativo nao ha
 * como ler teclas de fora do navegador, e fingir que ha seria pior do que
 * deixar o usuario digitar a combinacao no campo de texto.
 */
export interface KeyboardTapSource {
  /** true se ha teclado real observeavel (nativo). */
  readonly available: boolean;
  /** Detalhe do backend, exibido no diagnostico. */
  readonly detail?: string;
  /** Injeta uma tecla manualmente (teste e modo simulado). */
  tap(sequence: string): boolean;
  start(handler: (press: UiKeyPress) => void): void;
  stop(): void;
}

export interface ConfigPatch {
  readonly crafting?: Partial<UserConfig['crafting']>;
  readonly ui?: Partial<UserConfig['ui']>;
}

export interface SettingsModalProps {
  readonly config: UserConfig;
  readonly isGlobal: (action: HotkeyAction) => boolean;
  /** Aplica e persiste. Retorna falha como validacao, sem lancar. */
  /**
   * Aplica e persiste um atalho. DEVE devolver a validacao (inclusive quando
   * recusada) para que a linha possa mostrar o motivo da recusa.
   */
  readonly onSetHotkey: (action: HotkeyAction, sequence: string) => Promise<HotkeyValidation>;
  readonly onPatch: (patch: ConfigPatch) => void;
  readonly onClose: () => void;
  readonly onReset?: () => void;
  readonly keyboard?: KeyboardTapSource;
}

/** Uma linha de captura de atalho, com gravacao ao vivo ou digitacao. */
function HotkeyRow({
  label,
  sequence,
  hint,
  global,
  onApply,
  keyboard,
  conflictingWith,
}: {
  readonly label: string;
  readonly sequence: string;
  readonly hint: string;
  readonly global: boolean;
  readonly onApply: (value: string) => Promise<HotkeyValidation>;
  readonly keyboard: KeyboardTapSource | undefined;
  readonly conflictingWith: string;
}): ReactNode {
  const [draft, setDraft] = useState(sequence);
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return undefined;

    const handler = (press: UiKeyPress): void => {
      const parts: string[] = [];
      if (press.ctrl) parts.push('ctrl');
      if (press.alt) parts.push('alt');
      if (press.shift) parts.push('shift');
      if (press.meta) parts.push('meta');
      parts.push(press.key);
      const next = parts.join('+');

      // So modificadores: aguardamos a tecla final.
      if (['control', 'ctrl', 'alt', 'shift', 'meta', 'cmd'].includes(press.key.toLowerCase())) return;
      if (press.key.toLowerCase() === 'escape') {
        setRecording(false);
        setPending(null);
        return;
      }
      // Gravacao de uma so combinacao: a proxima tecla ja fecha a captura.
      setRecording(false);
      setPending(next);
    };

    keyboard?.start(handler);
    return () => {
      keyboard?.stop();
    };
  }, [recording, keyboard]);

  useEffect(() => {
    setDraft(sequence);
  }, [sequence]);

  // `onApply` grava em disco/IPC, entao devolve promessa. A UI espera a
  // validacao para so entao limpar o campo ou mostrar o motivo da recusa.
  const submit = useCallback(
    async (value: string): Promise<void> => {
      const result = await onApply(value);
      setError(null);
      if (result.valid) {
        setDraft(result.normalized);
        setPending(null);
      } else {
        setError(result.message);
      }
    },
    [onApply],
  );

  return (
    <div className="border-b border-slate-800 px-4 py-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm text-slate-200">{label}</p>
          <p className="text-[11px] text-slate-500">{hint}</p>
        </div>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase ${
            global
              ? 'border-emerald-800 bg-emerald-950/50 text-emerald-300'
              : 'border-slate-700 bg-slate-800 text-slate-400'
          }`}
          title={
            global
              ? 'Registrado globalmente: a tecla sai do jogo para o overlay.'
              : 'Apenas observado: o jogo continua usando a tecla normalmente.'
          }
        >
          {global ? 'global' : 'observado'}
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          type="text"
          value={pending ?? draft}
          onChange={(event) => {
            setPending(null);
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            submit(pending ?? draft);
          }}
          disabled={recording}
          placeholder="Alt+E"
          className="w-40 rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100 focus:border-emerald-700 focus:outline-none disabled:opacity-50"
        />
        <ActionButton
          onClick={() => { submit(pending ?? draft); }}
          disabled={recording || (pending ?? draft) === sequence}
        >
          Aplicar
        </ActionButton>
        <ActionButton
          onClick={() => {
            setRecording((value) => !value);
            setPending(null);
            setError(null);
          }}
          disabled={keyboard?.available !== true}
          title={
            keyboard?.available === true
              ? 'Capturar a combinação digitada agora'
              : 'Captura por teclado indisponível neste ambiente'
          }
        >
          {recording ? 'Cancelar' : 'Capturar'}
        </ActionButton>
      </div>

      {recording && (
        <p className="mt-1 text-[11px] text-emerald-300">
          Pressione a combinação agora (Esc cancela)…
        </p>
      )}

      {pending !== null && (
        <p className="mt-1 text-[11px] text-emerald-300">
          Capturado: {formatSequence(pending)} — pressione Aplicar
        </p>
      )}

      {error !== null && <p className="mt-1 text-[11px] text-red-400">{error}</p>}

      {conflictingWith.length > 0 && (
        <p className="mt-1 text-[11px] text-orange-300">Conflita com {conflictingWith}.</p>
      )}
    </div>
  );
}

/** Modal de preferencias: hotkeys, orcamento e aparencia. */
export function SettingsModal({
  config,
  isGlobal,
  onSetHotkey,
  onPatch,
  onClose,
  onReset,
  keyboard,
}: SettingsModalProps): ReactNode {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const conflict = useMemo(
    () =>
      config.hotkeys.triggerOverlay === config.hotkeys.quickAnalyze
        ? config.hotkeys.triggerOverlay
        : '',
    [config.hotkeys],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="flex h-full flex-col bg-slate-950/95 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
        <h1 className="text-sm font-semibold text-slate-100">Ajustes</h1>
        <div className="flex items-center gap-1.5">
          {onReset !== undefined && (
            <ActionButton
              onClick={onReset}
              title="Restaurar todos os valores padrão"
            >
              Restaurar padrões
            </ActionButton>
          )}
          <ActionButton variant="primary" onClick={onClose}>
            Fechar
          </ActionButton>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <h2 className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Atalhos
        </h2>

        <HotkeyRow
          label="Abrir overlay"
          sequence={config.hotkeys.triggerOverlay}
          hint="Atalho global que lê o item copiado e mostra o plano."
          global={isGlobal('triggerOverlay')}
          onApply={(value) => onSetHotkey('triggerOverlay', value)}
          keyboard={keyboard}
          conflictingWith={
            config.hotkeys.triggerOverlay === config.hotkeys.quickAnalyze
              ? 'análise rápida'
              : ''
          }
        />

        <HotkeyRow
          label="Análise rápida"
          sequence={config.hotkeys.quickAnalyze}
          hint="Observado apenas: o jogo continua usando Ctrl+C para copiar."
          global={isGlobal('quickAnalyze')}
          onApply={(value) => onSetHotkey('quickAnalyze', value)}
          keyboard={keyboard}
          conflictingWith={
            config.hotkeys.quickAnalyze === config.hotkeys.triggerOverlay ? 'abrir overlay' : ''
          }
        />

        {conflict.length > 0 && (
          <p className="px-4 py-1.5 text-[11px] text-red-400">
            Os dois atalhos são iguais: um deles nunca vai disparar.
          </p>
        )}

        <h2 className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Crafting
        </h2>

        <NumberField
          label="Orçamento padrão"
          value={config.crafting.defaultBudget}
          min={0}
          max={500}
          suffix=" ex"
          onChange={(value) => { onPatch({ crafting: { defaultBudget: value } }); }}
        />

        <Toggle
          label="Preservar modificadores existentes"
          description="O agente evita remover um prefixo/suffix já presente."
          checked={config.crafting.preserveExisting}
          onChange={(value) => { onPatch({ crafting: { preserveExisting: value } }); }}
        />

        <h2 className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Aparência
        </h2>

        <NumberField
          label="Opacidade"
          value={config.ui.opacity}
          min={0.3}
          max={1}
          step={0.05}
          onChange={(value) => { onPatch({ ui: { opacity: value } }); }}
        />

        <NumberField
          label="Escala do texto"
          value={config.ui.fontScale}
          min={0.8}
          max={1.6}
          step={0.05}
          onChange={(value) => { onPatch({ ui: { fontScale: value } }); }}
        />

        <Toggle
          label="Sempre no topo"
          checked={config.ui.alwaysOnTop}
          onChange={(value) => { onPatch({ ui: { alwaysOnTop: value } }); }}
        />

        <Toggle
          label="Mostrar quando o jogo está ocioso"
          description="Mantém o overlay visível sem apertar atalho."
          checked={config.ui.showOnIdle}
          onChange={(value) => { onPatch({ ui: { showOnIdle: value } }); }}
        />

        <button
          type="button"
          onClick={() => { setShowAdvanced((value) => !value); }}
          className="w-full px-4 py-2 text-left text-[11px] text-slate-500 hover:text-slate-300"
        >
          {showAdvanced ? 'Ocultar' : 'Mostrar'} diagnóstico
        </button>

        {showAdvanced && (
          <pre className="mx-4 mb-3 overflow-x-auto rounded border border-slate-800 bg-slate-900 p-2 font-mono text-[10px] text-slate-500">
            {[
              `triggerOverlay: ${config.hotkeys.triggerOverlay} (${isGlobal('triggerOverlay') ? 'global' : 'observado'})`,
              `quickAnalyze: ${config.hotkeys.quickAnalyze} (${isGlobal('quickAnalyze') ? 'global' : 'observado'})`,
              `teclado nativo: ${keyboard?.available === true ? 'sim' : 'não'}`,
            ].join('\n')}
          </pre>
        )}
      </div>
    </div>
  );
}
