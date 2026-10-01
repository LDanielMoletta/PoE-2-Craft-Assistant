import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { HotkeyAction, UserConfig } from '../config/index.js';
import type { HotkeyValidation } from '../overlay/hotkeyValidation.js';
import type { DataStatus } from '../scraper/dataHydration.js';
import type { CraftPlan, CraftStep, DesiredModifier, Item } from '../types/index.js';
import type { FeedbackDiagnostics, FeedbackSubmission, FeedbackResult } from '../feedback/feedbackReport.js';
import { DataStatusBar } from './DataStatusBar.js';
import { ItemHeader, ModifierList } from './ItemHeader.js';
import { SettingsModal, type ConfigPatch, type KeyboardTapSource } from './SettingsModal.js';
import { TargetSelector, type TargetChoice } from './TargetSelector.js';
import { CraftPlanView } from './CraftPlanView.js';
import { FeedbackModal } from './FeedbackModal.js';
import { ActionButton, CloseButton, EmptyState, Section } from './primitives.js';
import './OverlayWindow.css';

/** Estado da tela, controlado de fora para manter o componente burro. */
export interface OverlayState {
  readonly item: Item | null;
  readonly desired: readonly DesiredModifier[];
  readonly plan: CraftPlan | null;
  readonly planning: boolean;
  readonly appliedOrders: readonly number[];
  readonly error: string | null;
}

export interface OverlayWindowProps {
  readonly state: OverlayState;
  readonly config: UserConfig;
  readonly onToggleOverlay: () => void;
  readonly isGlobal: (action: HotkeyAction) => boolean;
  readonly onSetHotkey: (action: HotkeyAction, sequence: string) => Promise<HotkeyValidation>;
  readonly onPatch: (patch: ConfigPatch) => void;
  readonly onResetConfig: () => void;
  readonly onAddTarget: (text: string) => void;
  readonly onRemoveTarget: (text: string) => void;
  readonly onPlan: () => void;
  readonly onApplyStep: (step: CraftStep) => void;
  readonly onRevertStep: (step: CraftStep) => void;
  readonly onSkipStep: (step: CraftStep) => void;
  readonly onResetPlan: () => void;
  readonly onClose: () => void;
  readonly keyboard?: KeyboardTapSource;
  /** Nome do agente, exibido no rodapé do diagnóstico. */
  readonly hotkeyLabel: string;
  readonly dataStatus: DataStatus;
  readonly onRefreshData?: () => void;
  /**
   * Abas de feedback. O overlay e' quem tem o item e o estado da base, entao
   * quem monta o relatorio e' o host; aqui so a entrada do menu e o
   * tratamento de erro ja convertido em texto.
   */
  readonly feedbackDiagnostics?: FeedbackDiagnostics;
  readonly onSendFeedback?: (submission: FeedbackSubmission) => Promise<FeedbackResult>;
}

/**
 * Janela principal do overlay.
 *
 * Fica presentacional de proposito: quem guarda estado, chama o agente e
 * persiste config e o host (Electron ou o harness de dev). Assim a UI pode
 * ser testada sem hotkeys, clipboard ou API.
 */
export function OverlayWindow(props: OverlayWindowProps): ReactNode {
  const {
    state,
    config,
    onToggleOverlay,
    isGlobal,
    onSetHotkey,
    onPatch,
    onResetConfig,
    onAddTarget,
    onRemoveTarget,
    onPlan,
    onApplyStep,
    onRevertStep,
    onSkipStep,
    onResetPlan,
    onClose,
    hotkeyLabel,
    dataStatus,
    onRefreshData,
    feedbackDiagnostics,
    onSendFeedback,
  } = props;

  const [tab, setTab] = useState<'craft' | 'settings' | 'feedback'>('craft');
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const unsubscribe = window.electron?.onOpenSettings(() => {
      setTab('settings');
      setMenuOpen(false);
    });
    return () => unsubscribe?.();
  }, []);

  const opacity = config.ui.opacity;
  const scale = config.ui.fontScale;

  const candidates = useMemo<TargetChoice[]>(
    () =>
      (state.item?.modifiers ?? []).map((mod) => ({
        text: mod.text,
        slot: mod.slot,
        tier: mod.tier,
        origin: mod.origin,
      })),
    [state.item],
  );

  const isCraftTab = tab === 'craft';
  const isSettingsTab = tab === 'settings';
  const isFeedbackTab = tab === 'feedback';

  const handleAdd = useCallback(
    (choice: TargetChoice) => {
      onAddTarget(choice.text);
    },
    [onAddTarget],
  );

  if (tab === 'settings') {
    return (
      <div
        className="pointer-events-auto flex h-full flex-col overflow-hidden rounded-lg border border-slate-700/80 bg-slate-950 shadow-2xl"
        style={{ opacity, fontSize: `${16 * scale}px` }}
      >
        <div className="top-drag-region">
          <div className="no-drag">
            <SettingsModal
              config={config}
              isGlobal={isGlobal}
              onSetHotkey={onSetHotkey}
              onPatch={onPatch}
              onClose={() => { setTab('craft'); }}
              onReset={onResetConfig}
              keyboard={props.keyboard}
            />
          </div>
        </div>
        <DataStatusBar status={dataStatus} onRefresh={onRefreshData} />
      </div>
    );
  }

  if (tab === 'feedback') {
    return (
      <div
        className="pointer-events-auto flex h-full flex-col overflow-hidden rounded-lg border border-slate-700/80 bg-slate-950 shadow-2xl"
        style={{ opacity, fontSize: `${16 * scale}px` }}
      >
        <div className="top-drag-region">
          <div className="no-drag">
            <FeedbackModal
              diagnostics={feedbackDiagnostics ?? { appVersion: '0.0.0', platform: 'web', arch: 'n/a' }}
              onSubmit={onSendFeedback ?? (async () => ({ ok: false, message: 'Indisponível.' }))}
              onClose={() => { setTab('craft'); }}
              hasItem={state.item !== null}
            />
          </div>
        </div>
      </div>
    );
  }

  if (state.item === null) {
    return (
      <main className="flex h-full flex-col bg-[#121212] px-8 py-7 text-slate-100 sm:px-12 sm:py-10">
        <header className="flex items-start justify-between gap-6 border-b border-slate-800 pb-5">
          <div>
            <p className="text-xl font-semibold tracking-wide">PoE 2 Craft Assistant</p>
            <p className="mt-2 text-sm text-emerald-400">🟢 Assistente Pronto e Ativo</p>
          </div>
          <button
            type="button"
            onClick={() => { setTab('settings'); }}
            className="rounded border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-slate-500 hover:text-white"
          >
            Ajustes
          </button>
        </header>

        <section className="flex flex-1 flex-col justify-center py-8">
          <p className="mb-3 text-xs font-medium uppercase tracking-widest text-emerald-400">Pronto para analisar</p>
          <h1 className="max-w-2xl text-3xl font-semibold leading-tight">Capture um item para começar o craft.</h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-slate-300">
            Copie o item no jogo com Ctrl+C e pressione Alt+X para abrir o overlay.
          </p>
          {state.error !== null && (
            <p role="alert" className="mt-5 max-w-xl border-l-2 border-amber-400 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
              {state.error}
            </p>
          )}
          <div className="mt-8 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={onToggleOverlay}
              className="rounded bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
            >
              Minimizar / Entrar em Modo Overlay
            </button>
            <button
              type="button"
              onClick={() => { setTab('feedback'); }}
              className="rounded border border-slate-700 px-4 py-2.5 text-sm text-slate-300 hover:border-slate-500 hover:text-white"
            >
              Feedback
            </button>
          </div>
        </section>
        <DataStatusBar status={dataStatus} onRefresh={onRefreshData} />
      </main>
    );
  }

  return (
    <div
      className="pointer-events-auto flex h-full flex-col overflow-hidden rounded-lg border border-slate-700/80 bg-slate-950 shadow-2xl"
      style={{ opacity, fontSize: `${16 * scale}px` }}
    >
      {state.item !== null && <ItemHeader item={state.item} />}

      {/* Top drag region - allows dragging the frameless window */}
      <div className="top-drag-region">
        <nav className="flex items-center gap-1 border-b border-slate-800 px-2 py-1 no-drag">
        <TabButton active={isCraftTab} onClick={() => { setTab('craft'); }}>
          Craft
        </TabButton>
        <TabButton active={isSettingsTab} onClick={() => { setTab('settings'); }}>
          Ajustes
        </TabButton>
        <TabButton active={isFeedbackTab} onClick={() => { setTab('feedback'); }}>
          Feedback
        </TabButton>
        <div className="relative ml-auto">
          <button
            type="button"
            aria-label="Menu"
            onClick={() => { setMenuOpen((value) => !value); }}
            className="rounded px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-20 mt-0.5 w-40 rounded border border-slate-700 bg-slate-900 py-1 shadow-xl">
              <MenuItem onClick={() => { setTab('settings'); setMenuOpen(false); }}>
                Preferências
              </MenuItem>
              <MenuItem onClick={() => { onResetPlan(); setMenuOpen(false); }}>
                Limpar plano
              </MenuItem>
              <MenuItem onClick={() => { onClose(); setMenuOpen(false); }}>
                Fechar overlay
              </MenuItem>
              <MenuItem onClick={() => { window.electron?.send('app:quit'); setMenuOpen(false); }}>
                Sair do Assistente
              </MenuItem>
            </div>
          )}
        </div>
<CloseButton onClose={onClose} />
        </nav>
      </div>

      {state.item === null ? (
        <EmptyState
          title="Copie um item no jogo para começar"
          hint="O overlay lê a área de transferência e calcula a rota de craft mais barata."
          hotkeyLabel={hotkeyLabel}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <Section
            title="Modificadores do item"
            actions={
              <span className="text-[10px] text-slate-600">{state.item.modifiers.length} linhas</span>
            }
          >
            <div className="max-h-40 overflow-y-auto">
              <ModifierList item={state.item} desired={state.desired} />
            </div>
          </Section>

          <Section
            title="Alvo"
            actions={
              <ActionButton variant="primary" onClick={onPlan} disabled={state.planning}>
                {state.planning ? 'Calculando…' : 'Calcular'}
              </ActionButton>
            }
          >
            <TargetSelector
              candidates={candidates}
              selected={state.desired.map((d) => d.query)}
              onSelect={handleAdd}
              onRemove={onRemoveTarget}
            />
            {state.desired.length === 0 && (
              <p className="px-4 pb-2 text-[11px] text-slate-500">
                Sem alvo definido, o plano busca só o menor custo de craft.
              </p>
            )}
          </Section>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {state.error !== null && (
              <p className="border-b border-red-900 bg-red-950/40 px-4 py-1.5 text-xs text-red-300">
                {state.error}
              </p>
            )}

            {state.plan === null ? (
              <p className="px-4 py-4 text-sm text-slate-500">
                {state.planning ? 'Calculando rotas possíveis…' : 'Defina um alvo e calcule o plano.'}
              </p>
            ) : (
              <CraftPlanView
                plan={state.plan}
                appliedOrders={state.appliedOrders}
                onApplyStep={onApplyStep}
                onRevertStep={onRevertStep}
                onSkipStep={onSkipStep}
                onReplan={onPlan}
                onReset={onResetPlan}
              />
            )}
          </div>
        </div>
      )}

      <DataStatusBar status={dataStatus} onRefresh={onRefreshData} />
    </div>
  );
}

function TabButton({
  active = false,
  onClick,
  children,
}: {
  readonly active?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2.5 py-1 text-xs transition ${
        active ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
      }`}
    >
      {children}
    </button>
  );
}

function MenuItem({ onClick, children }: { readonly onClick: () => void; readonly children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full px-3 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800"
    >
      {children}
    </button>
  );
}
