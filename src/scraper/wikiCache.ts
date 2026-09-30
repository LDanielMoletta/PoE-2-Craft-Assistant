const memoryStore = new Map<string, { expiresAt: number; record: CacheRecord }>();

/** Formato persistido no cache. */
export interface CacheRecord {
  readonly key: string;
  readonly payload: unknown;
  readonly source: 'wiki' | 'seed' | 'trade-api';
  readonly cachedAt?: number;
}

export interface CacheDisk {
  read(key: string): CacheRecord | null;
  write(key: string, record: CacheRecord): void;
  /** Rotulo para o diagnostico; opcional. */
  describe?(): string;
}

export interface WikiCacheOptions {
  /** Camada de disco. Padrao: nenhuma, ou seja, so memoria. */
  readonly disk?: CacheDisk;
  readonly ttlMs: number;
  readonly enabled: boolean;
}

/**
 * Cache em duas camadas: memoria (rapido, por sessao do overlay) + disco
 * (sobrevive ao reinicio do overlay, que acontece toda vez que o usuario
 * fecha o jogo).
 *
 * A camada de disco entra por injecao porque ela usa `node:fs`, que nao pode
 * entrar no bundle do renderer. Quem roda no Node passa a implementacao de
 * `wikiCacheDisk.ts`; o overlay Electron fica so com a memoria.
 */
export class WikiCache {
  readonly #options: WikiCacheOptions;

  constructor(options: Partial<WikiCacheOptions> = {}) {
    this.#options = {
      disk: options.disk,
      ttlMs: options.ttlMs ?? 12 * 60 * 60 * 1000,
      enabled: options.enabled ?? true,
    };
  }

  get(key: string): CacheRecord | null {
    const now = Date.now();

    const inMemory = memoryStore.get(key);
    if (inMemory) {
      if (inMemory.expiresAt > now) return inMemory.record;
      memoryStore.delete(key);
    }

    if (!this.#options.enabled || this.#options.disk === undefined) return null;

    const record = this.#options.disk.read(key);
    if (record === null) return null;
    if (record.cachedAt !== undefined && now - record.cachedAt > this.#options.ttlMs) return null;

    memoryStore.set(key, { expiresAt: now + this.#options.ttlMs, record });
    return record;
  }

  set(key: string, record: CacheRecord): void {
    const payload: CacheRecord = { ...record, cachedAt: Date.now() };
    memoryStore.set(key, { expiresAt: Date.now() + this.#options.ttlMs, record: payload });

    if (!this.#options.enabled || this.#options.disk === undefined) return;

    try {
      this.#options.disk.write(key, payload);
    } catch {
      // Cache em disco e best-effort: falha aqui nunca deve derrubar o overlay.
    }
  }

  /** Limpa apenas a memoria (usado em testes). */
  clearMemory(): void {
    memoryStore.clear();
  }

  describe(): string {
    const disk = this.#options.disk === undefined ? '(desativado)' : this.#options.disk.describe?.() ?? 'ativo';
    return `mem=${memoryStore.size} disco=${disk}`;
  }
}
