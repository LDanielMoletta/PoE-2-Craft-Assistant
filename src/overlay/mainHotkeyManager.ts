import { parseSequence, validateHotkey } from './hotkeyValidation.js';

/**
 * Registro do atalho global no processo main do Electron.
 *
 * Vive aqui, e nao no renderer, porque em tela cheia o PoE2 entra em modo
 * exclusivo e o renderer fica praticamente congelado: quem precisa ver a tecla
 * antes de o jogo repintar e o processo main, via `globalShortcut`.
 *
 * Nao importa `electron`. Backend, clipboard e destino da captura vem injetados,
 * o que torna o ciclo inteiro testavel sem subir uma janela real.
 */
/** Adaptador sobre `electron.globalShortcut`. */
export interface GlobalShortcutBackend {
  /** `false` quando outro programa ja registrou a mesma combinacao. */
  register(accelerator: string, handler: () => void): boolean;
  unregister(accelerator: string): void;
  unregisterAll(): void;
  isRegistered(accelerator: string): boolean;
}

/** Adaptador sobre `electron.clipboard`. */
export interface MainClipboardSource {
  readText(): string;
}

/** O que o renderer recebe quando o atalho dispara. */
export interface ItemCapturedPayload {
  /** Texto cru do clipboard, ainda sem parse. */
  readonly text: string;
  readonly capturedAt: number;
  /** Acelerador que disparou, para log e deduplicacao. */
  readonly accelerator: string;
}

export type ItemCapturedSink = (payload: ItemCapturedPayload) => void;

export interface MainHotkeyManagerOptions {
  readonly backend: GlobalShortcutBackend;
  readonly clipboard: MainClipboardSource;
  readonly onCaptured: ItemCapturedSink;
  readonly onInvalid?: (message: string) => void;
  readonly isPoE2Focused?: () => boolean;
  readonly now?: () => number;
  readonly verbose?: boolean;
}

export interface MainHotkeyStatus {
  /** O backend de hotkey global existe neste ambiente. */
  readonly available: boolean;
  /** Ha um binding vivo agora. */
  readonly registered: boolean;
  /** Acelerador registrado, ou `null` se nenhum. */
  readonly accelerator: string | null;
  /** Explicacao pronta para o diagnostico da UI. */
  readonly detail: string;
}

const MODIFIER_LABELS: Readonly<Record<string, string>> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Super',
};

/**
 * Nomes de tecla especial como o Electron os escreve. `parseSequence` ja
 * canonicalizou `esc`/`up`/`return`; aqui vira a grafia da API.
 *
 * Um mapeamento errado aqui nao lanca: `register` so devolve `false`, e o
 * atalho parece funcionar enquanto nunca dispara.
 */
const KEY_LABELS: Readonly<Record<string, string>> = {
  escape: 'Escape',
  enter: 'Enter',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
};

/** Teclas que Electron nao aceita escritas literalmente. */
function toElectronKey(key: string): string {
  const labeled = KEY_LABELS[key];
  if (labeled !== undefined) return labeled;
  if (key === '"') return 'Quote';
  if (key === '+') return 'Plus';
  return key.toUpperCase();
}

/**
 * Converte a sequencia canonica do config (`alt+e`) no acelerador do Electron
 * (`Alt+E`), ou `null` quando ela nao serve como hotkey global.
 *
 * Reusa `validateHotkey(..., { asGlobal: true })` em vez de reimplementar as
 * regras de "precisa de modificador" e "nao pode ser atalho reservado do SO":
 * duas copias divergiriam em silencio.
 *
 * A conversao roda no renderer, antes do IPC, para que o main receba sempre um
 * acelerador pronto.
 */
export function toElectronAccelerator(sequence: string): string | null {
  const validation = validateHotkey(sequence, { asGlobal: true });
  if (!validation.valid) return null;

  const parsed = parseSequence(validation.normalized);
  if (parsed === null || parsed.keys.length === 0) return null;

  const modifiers = parsed.modifiers.map((modifier) => MODIFIER_LABELS[modifier] ?? modifier);
  const keys = parsed.keys.map(toElectronKey);
  const accelerator = [...modifiers, ...keys].join('+');
  return accelerator.length > 0 ? accelerator : null;
}

/**
 * Ciclo de vida do binding global.
 *
 * Recebe o acelerador ja convertido e nao valida policy — essa mora em
 * `toElectronAccelerator`. O que sobra e' pequeno o bastante para
 * `electron/mainHotkeyManager.cjs` ser um espelho honesto: os dois sao dirigidos
 * pela mesma bateria de vetores em `mainHotkeyManager.test.ts`.
 *
 * `bind` e' idempotente e seguro a cada gravacao de config: sempre libera o
 * binding anterior antes de tentar o novo, entao trocar de `Alt+E` para `Alt+F`
 * nunca deixa os dois registrados.
 */
export class MainHotkeyManager {
  readonly #backend: GlobalShortcutBackend;
  readonly #clipboard: MainClipboardSource;
  readonly #onCaptured: ItemCapturedSink;
  readonly #onInvalid: (message: string) => void;
  readonly #isPoE2Focused: (() => boolean) | undefined;
  readonly #now: () => number;
  readonly #verbose: boolean;

  #accelerator: string | null = null;
  #detail = 'Nenhum atalho global registrado.';

  constructor(options: MainHotkeyManagerOptions) {
    this.#backend = options.backend;
    this.#clipboard = options.clipboard;
    this.#onCaptured = options.onCaptured;
    this.#onInvalid = options.onInvalid ?? ((message) => console.log(`[hotkey:main] ${message}`));
    this.#isPoE2Focused = options.isPoE2Focused;
    this.#now = options.now ?? Date.now;
    this.#verbose = options.verbose ?? false;
  }

  get status(): MainHotkeyStatus {
    const accelerator = this.#accelerator;
    const registered = accelerator !== null && this.#backend.isRegistered(accelerator);
    if (accelerator === null) {
      return { available: true, registered: false, accelerator: null, detail: this.#detail };
    }
    return {
      available: true,
      registered,
      accelerator,
      detail: registered
        ? this.#detail
        : `O sistema nao aceitou ${accelerator}. A combinacao pode ja estar em uso por outro programa.`,
    };
  }

  /**
   * Registra (ou troca) o acelerador. `null` libera o binding atual. Nunca
   * lanca: conflito com outro programa e' estado legitimo, e precisa aparecer
   * no diagnostico em vez de derrubar o app.
   */
  bind(accelerator: string | null): MainHotkeyStatus {
    this.#release();

    if (accelerator === null || accelerator.length === 0) {
      this.#detail = 'Nenhum atalho global registrado.';
      return this.status;
    }

    const ok = this.#backend.register(accelerator, () => {
      this.#trigger(accelerator);
    });

    this.#accelerator = accelerator;
    this.#detail = ok
      ? `Atalho global ${accelerator} ativo.`
      : `O sistema nao aceitou ${accelerator}. A combinacao pode ja estar em uso por outro programa.`;

    if (this.#verbose) console.log(`[hotkey:main] ${this.#detail}`);
    return this.status;
  }

  /**
   * Atalho completo: converte a sequencia do config e registra.
   *
   * Sequencia invalida libera o binding: um overlay que ainda responde a
   * `Alt+F` depois de o campo ter sido limpo e pior do que um overlay mudo.
   */
  bindSequence(sequence: string | null): MainHotkeyStatus {
    if (sequence === null) return this.bind(null);
    const accelerator = toElectronAccelerator(sequence);
    if (accelerator === null) {
      this.bind(null);
      this.#detail = `Atalho invalido para registro global: "${sequence}".`;
      return this.status;
    }
    return this.bind(accelerator);
  }

  /** Libera o binding atual, se houver. Idempotente. */
  unregister(): void {
    this.#release();
    this.#detail = 'Nenhum atalho global registrado.';
  }

  /**
   * `unregisterAll` e' proposital: um `register` que falhou no meio pode ter
   * deixado um accelerator preso no SO, e sair sem liberar isso mata a
   * combinacao para o usuario ate o proximo login.
   */
  dispose(): void {
    this.#release();
    this.#backend.unregisterAll();
    this.#accelerator = null;
    this.#detail = 'Atalho global liberado.';
  }

  #release(): void {
    if (this.#accelerator !== null) {
      this.#backend.unregister(this.#accelerator);
      this.#accelerator = null;
    }
  }

  #trigger(accelerator: string): void {
    // So captura se o Path of Exile 2 estiver em foco
    if (this.#isPoE2Focused && !this.#isPoE2Focused()) {
      if (this.#verbose) console.log(`[hotkey:main] PoE2 nao esta em foco, ignorando atalho`);
      return;
    }

    let text = '';
    try {
      text = this.#clipboard.readText();
    } catch (error) {
      if (this.#verbose) {
        console.warn(`[hotkey:main] clipboard: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.#onInvalid('Nenhum item válido detectado no Clipboard');
      return;
    }

    if (!/Rarity:|Item Class:/i.test(text)) {
      this.#onInvalid('Nenhum item válido detectado no Clipboard');
      return;
    }

    if (this.#verbose) {
      console.log(`[hotkey:main] ${accelerator} -> ${text.length} chars`);
    }
    this.#onCaptured({ text, capturedAt: this.#now(), accelerator });
  }
}
