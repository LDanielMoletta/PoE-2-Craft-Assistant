import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CacheDisk, CacheRecord } from './wikiCache.js';

/**
 * Camada de disco do cache, so para processos Node.
 *
 * Fica em arquivo separado porque usa `node:fs`/`node:crypto`: o bundle do
 * renderer nao pode arrastar esses builtins. No Electron o overlay usa so a
 * camada de memoria, que ja e' suficiente para a sessao do jogo.
 */
export class FileCacheDisk implements CacheDisk {
  readonly #directory: string;

  constructor(directory = join(process.cwd(), '.cache')) {
    this.#directory = directory;
  }

  #filePath(key: string): string {
    // O hash evita caminho invalido e colisao de nomes vindos da query.
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
    return join(this.#directory, `mods-${hash}.json`);
  }

  read(key: string): CacheRecord | null {
    const path = this.#filePath(key);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as CacheRecord;
    } catch {
      return null;
    }
  }

  write(key: string, record: CacheRecord): void {
    const path = this.#filePath(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record), 'utf8');
  }

  describe(): string {
    return this.#directory;
  }
}
