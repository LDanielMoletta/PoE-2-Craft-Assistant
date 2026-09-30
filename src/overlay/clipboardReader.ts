export interface ClipboardSnapshot {
  readonly text: string;
  readonly capturedAt: number;
}

export interface IClipboardReader {
  read(): Promise<ClipboardSnapshot>;
}

/**
 * Clipboard simulado para o fluxo de teste do `index.ts` e para depurar no
 * browser. Reproduz o comportamento de um Ctrl+C no jogo sem depender do SO.
 *
 * Fica num arquivo sem `node:*` de proposito: o renderer do overlay importa
 * este modulo, e arrastar `node:child_process` para o bundle quebraria o
 * Electron (que roda com `sandbox: true`).
 */
export class SimulatedClipboardReader implements IClipboardReader {
  #queue: string[] = [];

  constructor(initialText = '') {
    if (initialText) this.#queue.push(initialText);
  }

  /** Enfileira o texto que o "jogo" ira colocar na area de transferencia. */
  enqueue(text: string): void {
    this.#queue.push(text);
  }

  async read(): Promise<ClipboardSnapshot> {
    const text = this.#queue.shift() ?? '';
    return { text, capturedAt: Date.now() };
  }
}
