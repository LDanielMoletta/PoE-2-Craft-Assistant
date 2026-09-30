import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ClipboardSnapshot, IClipboardReader } from './clipboardReader.js';

const execFileAsync = promisify(execFile);

/**
 * Leitores de clipboard que dependem do sistema operacional.
 *
 * Ficam fora de `clipboardReader.ts` porque importam `node:child_process`: o
 * bundle do renderer nao pode carregar esse builtin. Quem roda no Node (CLI,
 * testes) importa este arquivo; o overlay Electron usa o `clipboard:read` do
 * processo main.
 */
export class WindowsClipboardReader implements IClipboardReader {
  readonly #encoding: string;

  constructor(encoding: BufferEncoding = 'utf8') {
    this.#encoding = encoding;
  }

  /**
   * `Get-Clipboard -Raw` devolve o texto com as quebras de linha preservadas,
   * que e' exatamente o formato do "Ctrl+C" do Path of Exile. O console e'
   * forcado para UTF-8 senao acentos chegam como lixo.
   */
  async read(): Promise<ClipboardSnapshot> {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw'],
      { encoding: this.#encoding, maxBuffer: 4 * 1024 * 1024 },
    );
    return { text: stdout as string, capturedAt: Date.now() };
  }
}

/** Leitor para Linux/macOS (util para desenvolvimento e CI). */
export class UnixClipboardReader implements IClipboardReader {
  async read(): Promise<ClipboardSnapshot> {
    const attempts =
      process.platform === 'darwin' ? ['pbpaste'] : ['xclip', '-selection', 'clipboard', '-o'];
    let lastError: unknown = null;

    for (const [index, command] of attempts.entries()) {
      try {
        const args = command === 'pbpaste' ? [] : command.split(' ').slice(1);
        const { stdout } = await execFileAsync(command, args, { encoding: 'utf8' });
        return { text: stdout as string, capturedAt: Date.now() };
      } catch (error) {
        lastError = error;
        if (index === attempts.length - 1) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Clipboard indisponivel.');
  }
}

/** Escolhe o leitor adequado para a plataforma atual. */
export function createDefaultClipboardReader(): IClipboardReader {
  if (process.platform === 'win32') return new WindowsClipboardReader();
  return new UnixClipboardReader();
}
