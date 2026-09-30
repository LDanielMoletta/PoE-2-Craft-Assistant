import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { CraftAgent } from './agent/craftAgent.js';
import {
  ConfigManager,
  DEFAULT_USER_CONFIG,
  IpcConfigStorage,
  type HotkeyAction,
  type UserConfig,
} from './config/index.js';
import { createRendererSnapshotStore } from './data/ipcSnapshotStore.js';
import { createCommunitySource } from './data/communitySource.js';
import {
  DataHydrationService,
  type DataStatus,
} from './scraper/dataHydration.js';
import type { IClipboardReader } from './overlay/clipboardReader.js';
import { HotkeyManager } from './overlay/hotkeyManager.js';
import { toElectronAccelerator } from './overlay/mainHotkeyManager.js';
import {
  createBestHotkeySource,
  SimulatedHotkeySource,
  toPress,
  type BackendStatus,
  type IHotkeySource,
  type IKeyboardSource,
} from './overlay/hotkeySource.js';
import { formatSequence, type HotkeyValidation } from './overlay/hotkeyValidation.js';
import { parseItemText } from './parser/index.js';
import type { CraftPlan, CraftStep, CraftTarget, DesiredModifier, Item } from './types/index.js';
import { OverlayWindow, type OverlayState } from './ui/OverlayWindow.js';
import type { ConfigPatch, KeyboardTapSource } from './ui/SettingsModal.js';
import type { FeedbackDiagnostics, FeedbackSubmission, FeedbackResult, FeedbackDeliveryResult, FeedbackDraft } from './feedback/feedbackReport.js';
import { buildFeedbackPayload, describeDelivery } from './feedback/feedbackReport.js';
import { MOCK_ITEMS } from './dev/mockGameSimulator.js';
import { createRendererLogger, type RendererHostBridge } from './logger/rendererLogger.js';

/** Preco de um mod em exalted orbs, para a advertencia de hotkey. */
const CRAFT_COST_PER_MOD = 1.4;
const BUDGET_WARNING_AT = 5;

/** Classes mais usadas: pre-carregar cobre a maioria dos itens sem esperar. */
const WARMUP_CLASSES = ['sword', 'axe', 'mace', 'staff', 'wand', 'bow', 'dagger', 'claw', 'sceptre', 'chest', 'helmet', 'gloves', 'boots', 'belt', 'ring', 'amulet'] as const;

/**
 * Ponte entre o Electron/host e a UI presentacional.
 *
 * Concentra o estado que a UI nao deve conhecer: ConfigManager, hotkeys,
 * agente e o passo a passo. Assim o OverlayWindow continua testavel so com
 * props, e o dev no browser roda o mesmo codigo sem hotkey nativo.
 */
export function OverlayHost(): ReactNode {
  const configManager = useMemo(() => createConfigManager(), []);
  // Config comeca nos defaults e e trocada assim que o storage responder: o
  // renderer nao pode bloquear a primeira renderizacao aguardando disco/IPC.
  const [config, setConfig] = useState<UserConfig>(DEFAULT_USER_CONFIG);
  const [item, setItem] = useState<Item | null>(null);
  const [desired, setDesired] = useState<readonly DesiredModifier[]>([]);
  const [plan, setPlan] = useState<CraftPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [applied, setApplied] = useState<readonly number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [keyboard, setKeyboard] = useState<KeyboardTapSource | undefined>(undefined);

  const hotkeyRef = useRef<HotkeyManager | null>(null);
  const sourceRef = useRef<IHotkeySource | null>(null);
  const agentRef = useRef<CraftAgent | null>(null);

  /**
   * Nasce no servico (nao em estado) porque e' o mesmo objeto que o agente
   * consulta: recria-lo a cada render criaria uma copia paralela que o planner
   * nunca veria. O estado abaixo e' so o resumo para a UI.
   */
  const hydrationRef = useRef<DataHydrationService | null>(null);
  hydrationRef.current ??= new DataHydrationService({
    store: createRendererSnapshotStore(),
    fetchRemote: createCommunitySource(),
  });
  const hydration = hydrationRef.current;
  const [dataStatus, setDataStatus] = useState<DataStatus>(hydration.status);

  // Nao bloqueia a primeira renderizacao: o overlay abre, mostra o snapshot e
  // troca para a base viva quando ela chega.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setDataStatus(await hydration.hydrate());
      if (cancelled) return;
      agentRef.current?.useModsIndex(hydration.index);
      await agentRef.current?.dataService.warmupFromIndex(WARMUP_CLASSES);
      if (cancelled) return;
      setDataStatus(hydration.status);
    })();
    return () => {
      cancelled = true;
    };
  }, [hydration]);

  const handleRefreshData = useCallback(() => {
    void (async () => {
      setDataStatus(await hydration.hydrate({ force: true }));
      agentRef.current?.useModsIndex(hydration.index);
      setDataStatus(hydration.status);
    })();
  }, [hydration]);

  /**
   * Compartilhado entre a fonte simulada do renderer e o atalho global do main:
   * os dois entregam o mesmo par (item parseado, avisos), e um unico ponto de
   * reset evita o caso em que o overlay ignora o item novo porque o caminho
   * que o capturou nao limpou o estado antigo.
   */
  const applyCapturedItem = useCallback((captured: Item | null, warnings: readonly string[]) => {
    if (captured === null) {
      setError(warnings.at(-1) ?? 'Nenhum item reconhecido no clipboard.');
      return;
    }
    setItem(captured);
    setDesired([]);
    setPlan(null);
    setApplied([]);
    setError(null);
  }, []);

  // Carga inicial do config. Precisa vir antes de registrar o hotkey, senao o
  // overlay escuta o padrao e ignora o atalho customizado do usuario.
  useEffect(() => {
    let cancelled = false;
    void configManager.load().then((loaded) => {
      if (cancelled) return;
      setConfig(loaded);
      // `load` nao emite `hotkey:changed` (nao e mudanca do usuario), entao o
      // gerenciador precisa aceitar o atalho encontrado explicitamente.
      hotkeyRef.current?.rebind(loaded.hotkeys.triggerOverlay);
      pushGlobalHotkey(loaded.hotkeys.triggerOverlay);
    });
    return () => {
      cancelled = true;
    };
  }, [configManager]);

  // A fonte simulada sempre existe (permite depurar no browser sem hotkey
  // nativo); o backend nativo entra em outro efeito, como opcional.
  useEffect(() => {
    const simulated = new SimulatedHotkeySource();
    sourceRef.current = simulated;

    const manager = new HotkeyManager({
      source: simulated,
      hotkey: configManager.getHotkey('triggerOverlay'),
      clipboard: createHostClipboard(),
    });
    hotkeyRef.current = manager;
    manager.start();

    const off = manager.onCapture((result) => {
      applyCapturedItem(result.item, result.warnings);
    });

    return () => {
      off();
      manager.dispose();
      hotkeyRef.current = null;
      sourceRef.current = null;
    };
  }, [applyCapturedItem, configManager]);

  /**
   * No Electron este e' o caminho real: o main leu o clipboard porque o SO
   * congela o renderer em tela cheia, entao aqui so ha parse. Fora do Electron
   * a assinatura nao existe e o overlay continua no `HotkeyManager` simulado.
   */
  useEffect(() => {
    const api = window.overlayHost;
    if (api === undefined) return;

    return api.onItemCaptured((payload) => {
      const parsed = parseItemText(payload.text);
      applyCapturedItem(parsed.items[0] ?? null, parsed.warnings);
    });
  }, [applyCapturedItem]);

  // Recarrega o config do disco quando outro processo alterar o arquivo.
  useEffect(() => {
    const off = configManager.on('config:changed', (event) => {
      setConfig(event.next);
      // O main nao le o config; quem empurra o acelerador novo e' o renderer.
      pushGlobalHotkey(event.next.hotkeys.triggerOverlay);
    });
    const offError = configManager.on('config:error', (event) => {
      setError(event.message);
    });
    return () => {
      off();
      offError();
    };
  }, [configManager]);

  // Backend nativo, se houver. A ausencia nao e erro: o overlay continua
  // funcionando, so sem captura de tecla de fora da janela.
  useEffect(() => {
    let cancelled = false;
    void createBestHotkeySource().then(({ keyboard: source, status }) => {
      if (cancelled) {
        source.dispose();
        return;
      }
      setKeyboard(toTapSource(source, status));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const agent = useCallback((): CraftAgent => {
    agentRef.current ??= new CraftAgent({ modsIndex: hydration.index });
    return agentRef.current;
  }, [hydration]);

  const buildTarget = useCallback((): CraftTarget => {
    return {
      itemClass: item?.itemClass ?? null,
      targetModifiers: desired,
      maxBudget: config.crafting.defaultBudget,
      budgetCurrency: config.crafting.budgetCurrency,
      preserveExisting: config.crafting.preserveExisting,
      allowImplicitRemoval: false,
      minItemLevel: item?.itemLevel ?? null,
    };
  }, [config.crafting, desired, item]);

  const handlePlan = useCallback(async () => {
    if (item === null) return;
    setPlanning(true);
    setError(null);
    try {
      const result = await agent().planWithLlm(item, buildTarget());
      setPlan(result.plan);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setPlanning(false);
    }
  }, [agent, buildTarget, item]);

  const handleAddTarget = useCallback((text: string) => {
    setDesired((current) => {
      if (current.some((d) => d.query === text)) return current;
      const entry: DesiredModifier = {
        query: text,
        slot: 'any',
        required: true,
        minValue: null,
        maxValue: null,
      };
      // Um mod caro demais para o orcamento e avisado, mas nunca bloqueado:
      // quem decide o risco de gastar e o jogador.
      const projected = (current.length + 1) * CRAFT_COST_PER_MOD;
      if (BUDGET_WARNING_AT < projected && config.crafting.defaultBudget < projected) {
        setError(
          `Esse alvo pode custar ~${projected.toFixed(1)} ex, acima do orçamento de ${config.crafting.defaultBudget}.`,
        );
      }
      return [...current, entry];
    });
  }, [config.crafting.defaultBudget]);

  const handleRemoveTarget = useCallback((text: string) => {
    setDesired((current) => current.filter((d) => d.query !== text));
  }, []);

  const handleApplyStep = useCallback((step: CraftStep) => {
    setApplied((current) => (current.includes(step.order) ? current : [...current, step.order]));
  }, []);

  const handleRevertStep = useCallback((step: CraftStep) => {
    setApplied((current) => current.filter((order) => order !== step.order));
  }, []);

  const handleSkipStep = useCallback((step: CraftStep) => {
    setApplied((current) => (current.includes(step.order) ? current : [...current, step.order]));
  }, []);

  const handleResetPlan = useCallback(() => {
    setApplied([]);
    setPlan(null);
  }, []);

  const readLog = useCallback(async (): Promise<string> => {
    try {
      return await window.overlayHost?.readLog() ?? '';
    } catch {
      return '';
    }
  }, []);

  const sendFeedback = useCallback(async (submission: FeedbackSubmission): Promise<FeedbackResult> => {
    try {
      const logText = await readLog();
      const itemText = item?.rawText ?? null;
      const draft = {
        kind: submission.kind,
        description: submission.description,
        attachDiagnostics: submission.attachDiagnostics,
        contact: submission.contact ?? undefined,
        ...(submission.attachDiagnostics && itemText != null ? { itemText } : {}),
        ...(submission.attachDiagnostics && logText != null ? { logText } : {}),
      } satisfies FeedbackDraft;
      const payload = buildFeedbackPayload(draft,
        {
          appVersion: '0.2.0',
          platform: typeof navigator !== 'undefined' ? navigator.platform : 'web',
          arch: typeof navigator !== 'undefined' && 'deviceMemory' in navigator ? 'browser' : 'unknown',
          electron: typeof process !== 'undefined' && process.versions?.electron ? process.versions.electron : undefined,
          dataState: dataStatus.state,
          league: null,
        },
      );

      const result: FeedbackDeliveryResult = await window.overlayHost?.sendFeedback(payload) ?? {
        channel: 'none',
        ok: false,
        reason: 'overlayHost.sendFeedback indisponível',
      };

      if (!result.ok) {
        return { ok: false, message: describeDelivery(result) };
      }
      if (result.channel === 'issue-url') {
        return { ok: true, message: `Abri ${result.url}. Revise e confirme o envio.` };
      }
      return { ok: true, message: describeDelivery(result) };
    } catch (thrown) {
      return { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) };
    }
  }, [item?.rawText, dataStatus.state, readLog]);

  const feedbackDiagnostics = useMemo<FeedbackDiagnostics>(() => ({
    appVersion: '0.2.0',
    platform: typeof navigator !== 'undefined' ? navigator.platform : 'web',
    arch: typeof navigator !== 'undefined' && 'deviceMemory' in navigator ? 'browser' : 'unknown',
    electron: typeof process !== 'undefined' && process.versions?.electron ? process.versions.electron : undefined,
    dataState: dataStatus.state,
    league: null,
  }), [dataStatus.state]);

  // Logger do renderer com bridge para o main (writeLog via IPC).
  useEffect(() => {
    const bridge: RendererHostBridge = {
      writeLog: (line) => window.overlayHost?.writeLog(line),
    };
    const { installGlobalHandlers, uninstallGlobalHandlers } = createRendererLogger({
      host: bridge,
      context: {
        app: 'poe2-craft-assistant',
        version: '0.2.0',
        platform: typeof navigator !== 'undefined' ? navigator.platform : 'web',
        arch: typeof navigator !== 'undefined' && 'deviceMemory' in navigator ? 'browser' : 'unknown',
        scope: 'renderer',
        electron: typeof process !== 'undefined' && process.versions?.electron ? process.versions.electron : undefined,
      },
    });
    installGlobalHandlers();
    return () => {
      uninstallGlobalHandlers();
    };
  }, []);

  // Dev: F8 injeta item mock via IPC (apenas em dev)
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F8' && MOCK_ITEMS.length > 0) {
        const randomIndex = Math.floor(Math.random() * MOCK_ITEMS.length);
        const item = MOCK_ITEMS[randomIndex];
        if (item) {
          window.overlayHost?.devInjectItem(item.text);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Escuta item:parsed do main (dev IPC ou hotkey real)
  useEffect(() => {
    const api = window.overlayHost;
    if (api === undefined) return;
    return api.onItemParsed((payload) => {
      const parsed = parseItemText(payload.text);
      applyCapturedItem(parsed.items[0] ?? null, parsed.warnings);
    });
  }, [applyCapturedItem]);

  const handleClose = useCallback(() => {
    window.overlayHost?.hide();
  }, []);

  const handleSetHotkey = useCallback(
    async (action: HotkeyAction, sequence: string): Promise<HotkeyValidation> => {
      try {
        return await configManager.setHotkey(action, sequence);
      } catch (thrown) {
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        setError(message);
        return { valid: false, code: 'unknown-key', message, normalized: '' };
      }
    },
    [configManager],
  );

  const handlePatch = useCallback(
    (patch: ConfigPatch) => {
      void configManager.update(patch).catch((thrown: unknown) => {
        setError(thrown instanceof Error ? thrown.message : String(thrown));
      });
    },
    [configManager],
  );

  const handleResetConfig = useCallback(() => {
    void configManager.reset().catch((thrown: unknown) => {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    });
  }, [configManager]);

  const isGlobal = useCallback(
    (action: HotkeyAction) => configManager.isGlobalHotkey(action),
    [configManager],
  );

  // Troca o atalho do gerenciador sem reiniciar a janela.
  useEffect(() => {
    configManager.on('hotkey:changed', (event) => {
      if (event.action !== 'triggerOverlay') return;
      try {
        hotkeyRef.current?.rebind(event.next);
      } catch (thrown) {
        setError(thrown instanceof Error ? thrown.message : String(thrown));
      }
    });
  }, [configManager]);

  const state: OverlayState = useMemo(
    () => ({ item, desired, plan, planning, appliedOrders: applied, error }),
    [item, desired, plan, planning, applied, error],
  );

  return (
    <OverlayWindow
      state={state}
      config={config}
      isGlobal={isGlobal}
      onSetHotkey={handleSetHotkey}
      onPatch={handlePatch}
      onResetConfig={handleResetConfig}
      onAddTarget={handleAddTarget}
      onRemoveTarget={handleRemoveTarget}
      onPlan={() => {
        void handlePlan();
      }}
      onApplyStep={handleApplyStep}
      onRevertStep={handleRevertStep}
      onSkipStep={handleSkipStep}
      onResetPlan={handleResetPlan}
      onClose={handleClose}
      keyboard={keyboard}
      hotkeyLabel={formatSequence(config.hotkeys.triggerOverlay)}
      dataStatus={dataStatus}
      onRefreshData={handleRefreshData}
      feedbackDiagnostics={feedbackDiagnostics}
      onSendFeedback={sendFeedback}
    />
  );
}

/**
 * A conversao e a validacao acontecem aqui, e nao no main, para que as regras de
 * "precisa de modificador" e "nao e atalho reservado do SO" existam em um lugar
 * so. O main recebe a string pronta e apenas registra.
 *
 * `null` e' valor valido: significa "libera o binding", que e' o que acontece
 * quando o usuario limpa o campo ou escolhe uma combinacao invalida.
 */
function pushGlobalHotkey(sequence: string | null): void {
  const api = window.overlayHost;
  if (api === undefined) return;
  const accelerator = sequence === null ? null : toElectronAccelerator(sequence);
  // Sem canal de erro no overlay: o `hotkey:status` no painel de Ajustes e'
  // onde o usuario ve que o SO recusou a combinacao.
  void api.registerGlobalHotkey(accelerator).catch(() => {});
}

/**
 * No Electron quem le e grava o `config.json` e' o main (via preload), porque o
 * renderer roda com `sandbox: true`. No browser de dev cai no padrao em disco.
 */
function createConfigManager(): ConfigManager {
  const api = window.overlayHost;
  if (api === undefined) return new ConfigManager();

  return new ConfigManager({
    storage: new IpcConfigStorage({
      read: () => api.readConfig(),
      write: (contents) => api.writeConfig(contents),
    }),
  });
}

/**
 * O `tap` da fonte simulada e' o que permite testar a captura ao vivo sem SO:
 * `keyboard.press('alt+shift+k')` no dev faz o mesmo que o usuario digitar.
 */
function toTapSource(source: IKeyboardSource, status: BackendStatus): KeyboardTapSource {

  return {
    available: status.available,
    detail: status.detail,
    tap: (sequence) => {
      const simulated = source as Partial<{ press(sequence: string): boolean }>;
      if (typeof simulated.press === 'function') return simulated.press(sequence);
      return false;
    },
    start: (handler) => {
      source.start(handler);
    },
    stop: () => {
      source.stop();
    },
  };
}

/**
 * No Electron o main le o clipboard por subprocesso, unico caminho confiavel no
 * Windows sem pacote nativo. No browser cai para `navigator.clipboard`, que
 * exige permissao — por isso o dev sempre injeta o item por simulacao.
 */
function createHostClipboard(): IClipboardReader {
  return {
    async read() {
      const native = window.overlayHost?.readClipboard();
      if (native !== undefined) {
        const snapshot = await native;
        return { text: snapshot.text, capturedAt: snapshot.capturedAt };
      }
      if (typeof navigator !== 'undefined' && 'clipboard' in navigator) {
        try {
          return { text: await navigator.clipboard.readText(), capturedAt: Date.now() };
        } catch {
          return { text: '', capturedAt: Date.now() };
        }
      }
      return { text: '', capturedAt: Date.now() };
    },
  };
}

/** Injeta uma tecla na fonte simulada, para depurar sem hotkey nativo. */
export function simulateKey(source: IHotkeySource, sequence: string): boolean {
  if (source instanceof SimulatedHotkeySource) return source.tap(sequence);
  return false;
}

export { toPress };
