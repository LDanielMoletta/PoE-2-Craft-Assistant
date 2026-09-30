import {
  formatSequence,
  normalizeSequence,
  sequenceFromPress,
  validateHotkey,
  type HotkeyValidation,
  type KeyPress,
} from './hotkeyValidation.js';

export { formatSequence, normalizeSequence, sequenceFromPress, validateHotkey };
export type { HotkeyValidation, KeyPress };

/** Fonte de eventos de teclado. Permite trocar a implementacao sem tocar no resto. */
export interface IHotkeySource {
  /** Registra um callback para uma sequencia. Retorna a funcao de remoção. */
  register(sequence: string, handler: (press: KeyPress) => void): () => void;
  dispose(): void;
}

/** Fonte de teclado "cru": entrega TODAS as teclas, para gravacao de atalhos. */
export interface IKeyboardSource {
  readonly kind: string;
  /** true quando o backend nativo carregou com sucesso. */
  readonly available: boolean;
  start(handler: (press: KeyPress) => void): void;
  stop(): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Simulado (dev, CI e testes)
// ---------------------------------------------------------------------------

/**
 * Fonte de atalhos global que roda em qualquer plataforma, para dev e testes.
 *
 * `tap()` substitui o teclado real: e' o que a simulacao do `index.ts` chama
 * no lugar do usuario apertar a combinacao.
 */
export class SimulatedHotkeySource implements IHotkeySource {
  readonly #handlers = new Map<string, (press: KeyPress) => void>();

  register(sequence: string, handler: (press: KeyPress) => void): () => void {
    const key = normalizeSequence(sequence);
    this.#handlers.set(key, handler);
    return () => {
      this.#handlers.delete(key);
    };
  }

  /** Simula o usuario apertando a combinacao. */
  tap(sequence: string): boolean {
    const key = normalizeSequence(sequence);
    const handler = this.#handlers.get(key);
    if (handler === undefined) return false;
    handler(toPress(sequence));
    return true;
  }

  /** Sequencias atualmente registradas (usado pela UI de settings). */
  list(): string[] {
    return [...this.#handlers.keys()];
  }

  dispose(): void {
    this.#handlers.clear();
  }
}

/** Teclado simulado: injeta teclas individuais, usado pelo gravador de atalhos. */
export class SimulatedKeyboardSource implements IKeyboardSource {
  readonly kind = 'simulated';
  readonly available = true;

  #handler: ((press: KeyPress) => void) | null = null;
  #started = false;

  start(handler: (press: KeyPress) => void): void {
    this.#handler = handler;
    this.#started = true;
  }

  stop(): void {
    this.#handler = null;
    this.#started = false;
  }

  dispose(): void {
    this.stop();
  }

  /** Injeta uma tecla (ex: `press('alt+e')`). So funciona apos `start()`. */
  press(sequence: string): boolean {
    if (this.#handler === null || !this.#started) return false;
    this.#handler(toPress(sequence));
    return true;
  }

  get running(): boolean {
    return this.#started;
  }
}

/** Monta um `KeyPress` a partir de uma sequencia textual. */
export function toPress(sequence: string): KeyPress {
  const parts = sequence
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    key: parts.at(-1) ?? '',
    alt: parts.includes('alt'),
    ctrl: parts.includes('ctrl') || parts.includes('control'),
    shift: parts.includes('shift'),
    meta: parts.includes('meta') || parts.includes('cmd') || parts.includes('win'),
  };
}

// ---------------------------------------------------------------------------
// Backend nativo
// ---------------------------------------------------------------------------

/** Backends de hotkey global suportados. */
export type HotkeyBackendName = 'uiohook-napi' | 'electron' | 'none';

export interface BackendStatus {
  readonly name: HotkeyBackendName;
  readonly available: boolean;
  readonly detail: string;
}

/**
 * Ponte para o modulo nativo de hotkeys globais.
 *
 * A implementacao real usa `uiohook-napi`, que e' carregado sob demanda: ele
 * exige compilacao nativa e nao pode ser uma dependencia dura do pacote, senao
 * `pnpm install` quebraria em maquinas sem toolchain de C++.
 *
 * Fluxo: `uIOhook.on('keydown', ...)` entrega cada tecla; comparamos a
 * sequencia resultante com as registradas. `RegisterHotKey` nao serve aqui
 * porque nao da para adicionar combinacoes em runtime — e exatamente o que a
 * tela de Settings precisa.
 */
export class NativeHotkeySource implements IHotkeySource {
  readonly #handlers = new Map<string, (press: KeyPress) => void>();
  readonly #backend: NativeBackend;
  #disposeNative: (() => void) | null = null;
  #disposed = false;

  private constructor(backend: NativeBackend) {
    this.#backend = backend;
  }

  /** Carrega o backend nativo. Falha de forma explicita, nunca silenciosa. */
  static async create(options: { prefer?: HotkeyBackendName } = {}): Promise<NativeHotkeySource> {
    const backend = await loadNativeBackend(options.prefer);
    return new NativeHotkeySource(backend);
  }

  /** true se existe backend nativo utilizavel nesta maquina. */
  static async isSupported(): Promise<boolean> {
    try {
      const backend = await loadNativeBackend();
      backend.dispose();
      return true;
    } catch {
      return false;
    }
  }

  register(sequence: string, handler: (press: KeyPress) => void): () => void {
    if (this.#disposed) throw new Error('NativeHotkeySource ja foi descartado.');
    const normalized = normalizeSequence(sequence);
    if (normalized.length === 0) throw new Error(`Atalho invalido: "${sequence}".`);

    this.#handlers.set(normalized, handler);
    this.#ensureNativeListener();

    return () => {
      this.#handlers.delete(normalized);
    };
  }

  /**
   * Escuta TODAS as teclas, sem filtrar por combinacao.
   * E o que o gravador de atalhos da tela de Settings consome.
   */
  onAnyKeyDown(handler: (press: KeyPress) => void): () => void {
    if (this.#disposed) throw new Error('NativeHotkeySource ja foi descartado.');
    this.#ensureNativeListener();
    return this.#backend.onRawKeyDown(handler);
  }

  #ensureNativeListener(): void {
    if (this.#disposeNative !== null) return;
    this.#disposeNative = this.#backend.onKeyDown((press) => {
      const sequenceKey = sequenceFromPress(press);
      this.#handlers.get(sequenceKey)?.(press);
    });
  }

  list(): string[] {
    return [...this.#handlers.keys()];
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get backendName(): HotkeyBackendName {
    return this.#backend.name;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposeNative?.();
    this.#disposeNative = null;
    this.#handlers.clear();
    this.#backend.dispose();
  }
}

/** Contrato interno do backend nativo, independente da biblioteca usada. */
interface NativeBackend {
  readonly name: HotkeyBackendName;
  /** Entrega apenas as teclas que casam com uma combinacao registrada. */
  onKeyDown(handler: (press: KeyPress) => void): () => void;
  /** Entrega todas as teclas, para gravacao ao vivo. */
  onRawKeyDown(handler: (press: KeyPress) => void): () => void;
  dispose(): void;
}

/** Erro de carregamento com instrucao de como resolver. */
export class HotkeyBackendUnavailableError extends Error {
  readonly attempts: readonly string[];

  constructor(attempts: readonly string[]) {
    super(
      `Nenhum backend de hotkey global disponivel. Tentado: ${attempts.join(', ')}. ` +
        'Rode "pnpm approve-builds uiohook-napi" para compilar o modulo nativo, ' +
        'ou use a fonte simulada em desenvolvimento.',
    );
    this.name = 'HotkeyBackendUnavailableError';
    this.attempts = attempts;
  }
}

/** Mapeia teclas do uiohook para o formato interno. */
function fromUiohook(keycode: number, modifiers: number): KeyPress {
  return {
    key: uiohookKeyName(keycode),
    ctrl: (modifiers & 0x40) !== 0, // CTRL
    alt: (modifiers & 0x08) !== 0, // ALT
    shift: (modifiers & 0x04) !== 0, // SHIFT
    meta: (modifiers & 0x10) !== 0, // META
  };
}

/** Nomes de tecla do uiohook para as teclas que realmente usamos. */
function uiohookKeyName(keycode: number): string {
  const named: Readonly<Record<number, string>> = {
    1: 'escape', 14: 'backspace', 15: 'tab', 57: 'space', 58: 'enter', 27: 'escape',
    573: 'arrowdown', 574: 'arrowleft', 575: 'arrowright', 576: 'arrowup',
  };
  const direct = named[keycode];
  if (direct !== undefined) return direct;

  // Layout US do uiohook: A..Z em 30..55, 1..0 em 2..11, F1..F12 em 96..107.
  if (keycode >= 30 && keycode <= 55) return String.fromCharCode(65 + (keycode - 30));
  if (keycode >= 2 && keycode <= 11) return String.fromCharCode(48 + (keycode - 2));
  if (keycode >= 96 && keycode <= 107) return `F${keycode - 96}`;
  return `Key${keycode}`;
}

/**
 * Tenta carregar `uiohook-napi`.
 * Qualquer ausencia de modulo OU de binario nativo cai no proximo backend.
 */
async function loadNativeBackend(prefer?: HotkeyBackendName): Promise<NativeBackend> {
  const attempts: string[] = [];

  if (prefer === undefined || prefer === 'uiohook-napi') {
    attempts.push('uiohook-napi');
    try {
      const moduleName = 'uiohook-napi';
      const imported = (await import(/* @vite-ignore */ moduleName)) as {
        uIOhook?: {
          on(event: 'keydown', listener: (event: { keycode: number; modifiers: number }) => void): void;
          start(): void;
          stop(): void;
        };
      };
      const uIOhook = imported.uIOhook;
      if (uIOhook === undefined) throw new Error('modulo sem export `uIOhook`');

      // onKeyDown e onRawKeyDown compartilham o mesmo event listener nativo:
      // o filtro por combinacao acontece em NativeHotkeySource, nao aqui.
      const onEvent = (handler: (press: KeyPress) => void): (() => void) => {
        const listener = (event: { keycode: number; modifiers: number }): void => {
          handler(fromUiohook(event.keycode, event.modifiers));
        };
        uIOhook.on('keydown', listener);
        uIOhook.start();
        return () => {
          uIOhook.stop();
        };
      };

      return {
        name: 'uiohook-napi',
        onKeyDown: onEvent,
        onRawKeyDown: onEvent,
        dispose() {
          uIOhook.stop();
        },
      };
    } catch (error) {
      attempts.push(`falhou: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new HotkeyBackendUnavailableError(attempts);
}

/**
 * Escolhe a melhor fonte disponivel: nativa se der, senao simulada.
 * Em dev e CI cai quase sempre na simulada — e isso proposital.
 */
export async function createBestHotkeySource(): Promise<{
  source: IHotkeySource;
  keyboard: IKeyboardSource;
  status: BackendStatus;
}> {
  try {
    const source = await NativeHotkeySource.create();
    return {
      source,
      keyboard: new NativeKeyboardSource(source),
      status: { name: source.backendName, available: true, detail: 'backend nativo carregado' },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      source: new SimulatedHotkeySource(),
      keyboard: new SimulatedKeyboardSource(),
      status: { name: 'none', available: false, detail },
    };
  }
}

/** Teclado cru apoiado em um `NativeHotkeySource` ja carregado. */
export class NativeKeyboardSource implements IKeyboardSource {
  readonly kind = 'native';
  #unregister: (() => void) | null = null;
  readonly #source: NativeHotkeySource;

  constructor(source: NativeHotkeySource) {
    this.#source = source;
  }

  get available(): boolean {
    return !this.#source.disposed;
  }

  start(handler: (press: KeyPress) => void): void {
    this.stop();
    this.#unregister = this.#source.onAnyKeyDown(handler);
  }

  stop(): void {
    this.#unregister?.();
    this.#unregister = null;
  }

  dispose(): void {
    this.stop();
  }
}

// ---------------------------------------------------------------------------
// Gravador de atalhos (usado pela SettingsModal)
// ---------------------------------------------------------------------------

export type RecordingPhase = 'idle' | 'recording' | 'captured' | 'rejected';

export interface HotkeyRecording {
  readonly phase: RecordingPhase;
  /** Forma canonica capturada (`alt+shift+e`). Vazio enquanto nao capturou. */
  readonly sequence: string;
  /** Forma legivel (`Alt+Shift+E`). */
  readonly label: string;
  /** Teclas pressionadas ate agora, em ordem. */
  readonly pending: readonly string[];
  readonly validation: HotkeyValidation | null;
}

export interface HotkeyRecorderOptions {
  /** Se true, Esc durante a gravacao cancela em vez de capturar. */
  readonly cancelOnEscape?: boolean;
  /** Se true, o atalho e validado como hotkey GLOBAL (exige modificador). */
  readonly asGlobal?: boolean;
  /** Combinacoes ja em uso, para detectar conflito. */
  readonly taken?: () => readonly string[];
}

type RecordingListener = (recording: HotkeyRecording) => void;

/**
 * Captura a combinacao de teclas digitada ao vivo.
 *
 * A UI mostra "pressione o novo atalho..." e o gravador acumula as teclas ate
 * formar uma combinacao completa (modificador + tecla). Esc cancela; uma
 * combinacao invalida (atalho do SO, sem modificador, conflito) e recusada com
 * o motivo, em vez de ser aplicada.
 */
export class HotkeyRecorder {
  readonly #keyboard: IKeyboardSource;
  readonly #options: Required<Omit<HotkeyRecorderOptions, 'taken'>> & {
    taken: () => readonly string[];
  };
  readonly #listeners = new Set<RecordingListener>();

  #state: HotkeyRecording = {
    phase: 'idle',
    sequence: '',
    label: '',
    pending: [],
    validation: null,
  };
  #active = false;

  constructor(keyboard: IKeyboardSource, options: HotkeyRecorderOptions = {}) {
    this.#keyboard = keyboard;
    this.#options = {
      cancelOnEscape: options.cancelOnEscape ?? true,
      asGlobal: options.asGlobal ?? true,
      taken: options.taken ?? (() => []),
    };
  }

  get state(): HotkeyRecording {
    return this.#state;
  }

  get isRecording(): boolean {
    return this.#active;
  }

  subscribe(listener: RecordingListener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #publish(next: HotkeyRecording): void {
    this.#state = next;
    for (const listener of this.#listeners) listener(next);
  }

  /** Comeca a gravar. Idempotente. */
  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#publish({ phase: 'recording', sequence: '', label: '', pending: [], validation: null });
    this.#keyboard.start((press) => this.#onPress(press));
  }

  /** Para de gravar, preservando a ultima captura. */
  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#keyboard.stop();
  }

  /** Descarta a captura e volta para idle. */
  reset(): void {
    this.stop();
    this.#publish({ phase: 'idle', sequence: '', label: '', pending: [], validation: null });
  }

  #onPress(press: KeyPress): void {
    if (press.key === 'escape' && this.#options.cancelOnEscape) {
      this.reset();
      return;
    }

    // So modificadores pressionados: mostra o que falta, sem capturing.
    const isModifierKey = ['control', 'ctrl', 'alt', 'shift', 'meta', 'cmd'].includes(
      press.key.toLowerCase(),
    );
    if (isModifierKey) {
      const pending = buildPendingLabel(press);
      this.#publish({
        phase: 'recording',
        sequence: '',
        label: pending,
        pending: [pending],
        validation: null,
      });
      return;
    }

    const sequence = sequenceFromPress(press);
    const pending = [...(this.#state.pending.length > 0 ? this.#state.pending : []), formatSequence(sequence)];
    const validation = validateHotkey(sequence, {
      asGlobal: this.#options.asGlobal,
      taken: this.#options.taken(),
    });

    this.stop();

    this.#publish({
      phase: validation.valid ? 'captured' : 'rejected',
      sequence: validation.normalized,
      label: validation.valid ? formatSequence(validation.normalized) : formatSequence(sequence),
      pending,
      validation,
    });
  }
}

/** "Alt+" enquanto so o modificador esta pressionado. */
function buildPendingLabel(press: KeyPress): string {
  const parts: string[] = [];
  if (press.ctrl) parts.push('Ctrl');
  if (press.alt) parts.push('Alt');
  if (press.shift) parts.push('Shift');
  if (press.meta) parts.push('Win');
  return parts.length > 0 ? `${parts.join('+')}+…` : '…';
}