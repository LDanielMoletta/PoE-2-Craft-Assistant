import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ConfigManager, type ConfigManagerOptions, type ConfigStorage } from './userConfig.js';

/**
 * Storage de config em disco, so para processos Node.
 *
 * Fica num arquivo separado de proposito: ele importa `node:fs`, e o bundle do
 * renderer (Vite) nao pode arrastar esse builtin — o Electron roda a UI com
 * `sandbox: true`. Quem roda no renderer usa `IpcConfigStorage`.
 */
export class FileConfigStorage implements ConfigStorage {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  get path(): string {
    return this.#filePath;
  }

  async read(): Promise<string | null> {
    if (!existsSync(this.#filePath)) return null;
    return readFileSync(this.#filePath, 'utf8');
  }

  /**
   * Grava num `.tmp` e troca por rename.
   *
   * Um rename no mesmo diretorio e' atomico no Windows e no POSIX: se o
   * processo cair no meio da escrita, o config.json antigo continua inteiro em
   * vez de ficar truncado (o que faria o ConfigManager perder tudo).
   */
  async write(contents: string): Promise<void> {
    mkdirSync(dirname(this.#filePath), { recursive: true });
    const tmp = `${this.#filePath}.tmp`;
    try {
      writeFileSync(tmp, contents, 'utf8');
      renameSync(tmp, this.#filePath);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // Se o tmp nem chegou a existir, o erro original e' o que importa.
      }
      throw error;
    }
  }
}

/** Cria um `ConfigManager` que persiste em `config.json` dentro de `dir`. */
export function createFileConfigManager(
  dir: string,
  options: Omit<ConfigManagerOptions, 'storage'> = {},
): ConfigManager {
  return new ConfigManager({ ...options, storage: new FileConfigStorage(join(dir, 'config.json')) });
}
