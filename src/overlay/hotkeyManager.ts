import { parseItemText } from '../parser/index.js';
import type { Item, ParseResult } from '../types/index.js';
import {
  SimulatedHotkeySource,
  type IHotkeySource,
  type KeyPress,
  normalizeSequence,
  sequenceFromPress,
} from './hotkeySource.js';
import type { IClipboardReader } from './clipboardReader.js';

/** Atalho padrao do overlay. */
export const DEFAULT_HOTKEY = 'Alt+E';

/** Payload devolvido quando o atalho e acionado. */
export interface HotkeyCaptureResult {
  /** Verdadeiro quando o atalho foi reconhecido e o clipboard lido. */
  readonly triggered: boolean;
  /** Sequencia normalizada que disparou. */
  readonly sequence: string;
  /** Texto cru do clipboard, para depuracao. */
  readonly clipboardText: string;
  /** Itens estruturados extraidos do clipboard. */
  readonly item: Item | null;
  /** Todos os itens, caso o jogador tenha copiado varios. */
  readonly parseResult: ParseResult | null;
  /** Tempo total entre o atalho e o item pronto, em ms. */
  readonly latencyMs: number;
  /** Erros nao-fatais (clipboard vazio, texto invalido...). */
  readonly warnings: readonly string[];
}

export interface HotkeyManagerOptions {
  readonly hotkey?: string;
  readonly source?: IHotkeySource;
  /**
   * De onde sai o texto do item. Obrigatorio de proposito: a origem do
   * clipboard depende do ambiente (subprocesso no Node, IPC no Electron,
   * simulacao em teste) e nenhum default aqui funcionaria em todos.
   */
  readonly clipboard: IClipboardReader;
  /** Quando true, cada acionamento e logado no console. */
  readonly verbose?: boolean;
}

/**
 * Gerenciador do atalho global do overlay.
 *
 * Fluxo do atalho Alt+E:
 *   1. O SO detecta Alt+E (fonte de hotkeys nativa ou simulada).
 *   2. O gerenciador le a area de transferencia do sistema.
 *   3. O texto passa pelo parser e vira um `Item` estruturado.
 *   4. O handler recebe o item do cursor e dispara o agente.
 */
export class HotkeyManager {
  readonly #source: IHotkeySource;
  readonly #clipboard: IClipboardReader;
  readonly #verbose: boolean;
  readonly #listeners = new Set<(result: HotkeyCaptureResult) => void>();
  readonly #rebindListeners = new Set<(sequence: string, previous: string) => void>();

  #sequence: string;
  #unregister: (() => void) | null = null;
  #running = false;

  constructor(options: HotkeyManagerOptions) {
    this.#sequence = normalizeSequence(options.hotkey ?? DEFAULT_HOTKEY);
    this.#source = options.source ?? new SimulatedHotkeySource();
    this.#clipboard = options.clipboard;
    this.#verbose = options.verbose ?? false;
  }

  /** Atalho normalizado que este gerenciador escuta. */
  get sequence(): string {
    return this.#sequence;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Registra os ouvintes. Idempotente. */
  start(): void {
    if (this.#running) return;
    this.#unregister = this.#source.register(this.#sequence, () => {
      void this.trigger();
    });
    this.#running = true;
    if (this.#verbose) {
      console.log(`[overlay] escutando ${this.#sequence} (Ctrl+C no jogo e depois este atalho)`);
    }
  }

  stop(): void {
    this.#unregister?.();
    this.#unregister = null;
    this.#running = false;
  }

  /**
   * Troca o atalho em runtime, sem reiniciar o overlay.
   *
   * Se o gerenciador estiver rodando, a nova combinacao e registrada
   * imediatamente e a antiga e liberada — e' o que permite gravar um atalho
   * novo na tela de Settings e usa-lo na proxima tecla, sem reiniciar o jogo.
   */
  rebind(sequence: string): string {
    const normalized = normalizeSequence(sequence);
    if (normalized.length === 0) {
      throw new Error(`Atalho invalido: "${sequence}".`);
    }

    const previous = this.#sequence;
    if (normalized === previous) return previous;

    if (this.#running) {
      this.#unregister?.();
      this.#unregister = this.#source.register(normalized, () => {
        void this.trigger();
      });
    }

    this.#sequence = normalized;
    if (this.#verbose) {
      console.log(`[overlay] atalho ${previous} -> ${normalized}`);
    }
    for (const listener of this.#rebindListeners) {
      listener(normalized, previous);
    }
    return previous;
  }

  /** Notificado a cada `rebind()` concluido. */
  onRebind(listener: (sequence: string, previous: string) => void): () => void {
    this.#rebindListeners.add(listener);
    return () => {
      this.#rebindListeners.delete(listener);
    };
  }

  /** Registra um callback para cada captura bem-sucedida. */
  onCapture(listener: (result: HotkeyCaptureResult) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Executa o fluxo completo: clipboard -> parse -> item.
   * Pode ser chamado direto (atalho simulado, teste, macro) ou pelo handler
   * registrado em `start()`.
   */
  async trigger(press?: KeyPress): Promise<HotkeyCaptureResult> {
    const startedAt = performance.now();
    const sequence = this.#sequence;

    let clipboardText = '';
    const warnings: string[] = [];

    try {
      const snapshot = await this.#clipboard.read();
      clipboardText = snapshot.text;
    } catch (error) {
      warnings.push(
        `Falha ao ler o clipboard: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const parseResult = parseItemText(clipboardText);
    warnings.push(...parseResult.warnings);
    const item = parseResult.items[0] ?? null;

    if (!item) {
      warnings.push('Nenhum item reconhecido no clipboard. O item precisa estar em um stash/mercado.');
    }

    const result: HotkeyCaptureResult = {
      triggered: true,
      sequence: press ? sequenceFromPress(press) || sequence : sequence,
      clipboardText,
      item,
      parseResult,
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
      warnings,
    };

    if (this.#verbose) {
      console.log(
        `[overlay] ${result.sequence} -> item=${item?.name ?? '(nenhum)'} em ${result.latencyMs}ms`,
      );
    }

    for (const listener of this.#listeners) {
      listener(result);
    }

    return result;
  }

  /** Atalho simulado: injeta uma tecla na fonte de hotkeys. */
  simulateHotkey(): boolean {
    if (this.#source instanceof SimulatedHotkeySource) {
      return this.#source.tap(this.#sequence);
    }
    throw new Error('simulateHotkey() exige uma SimulatedHotkeySource.');
  }

  dispose(): void {
    this.stop();
    this.#listeners.clear();
    this.#rebindListeners.clear();
    if (this.#source instanceof SimulatedHotkeySource) {
      this.#source.dispose();
    }
  }
}