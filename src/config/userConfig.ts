import { z } from 'zod';

import {
  formatSequence,
  normalizeSequence,
  validateHotkey,
  validateHotkeySet,
  type HotkeyValidation,
} from '../overlay/hotkeyValidation.js';
import { CurrencyUnitSchema } from '../types/index.js';

/** Versao do formato do config.json, para migracoes futuras. */
export const CONFIG_VERSION = 1 as const;

/** Acoes que disparam um atalho. */
export type HotkeyAction = 'triggerOverlay' | 'quickAnalyze';

export const HOTKEY_ACTIONS: readonly HotkeyAction[] = ['triggerOverlay', 'quickAnalyze'];

/**
 * Quais acoes sao registradas como hotkey GLOBAL (roubam a tecla do sistema)
 * e quais sao apenas OBSERVADAS.
 *
 * `quickAnalyze` = "Ctrl+C" e observado de proposito: o jogo copia o item,
 * o overlay apenas nota o Ctrl+C e le o clipboard. Registrar Ctrl+C
 * globalmente sequestraria a tecla e o jogador nao conseguiria mais copiar.
 */
export const GLOBAL_HOTKEY_ACTIONS: ReadonlySet<HotkeyAction> = new Set<HotkeyAction>([
  'triggerOverlay',
]);

/** Schema de uma combinacao de teclas. Normaliza e valida no parse. */
export const HotkeySchema = z
  .string()
  .min(1, 'Atalho nao pode ser vazio.')
  .transform((value, ctx) => {
    const normalized = normalizeSequence(value);
    if (normalized.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${value}" nao e um atalho valido.` });
      return z.NEVER;
    }
    return normalized;
  });

const HotkeysSchema = z.object({
  triggerOverlay: HotkeySchema.default('Alt+X'),
  quickAnalyze: HotkeySchema.default('Ctrl+C'),
});

const CraftingSchema = z.object({
  defaultBudget: z.number().nonnegative().max(1_000_000).default(10),
  budgetCurrency: CurrencyUnitSchema.default('exalted'),
  preserveExisting: z.boolean().default(true),
});

const UiSchema = z.object({
  opacity: z.number().min(0.3).max(1).default(0.95),
  theme: z.enum(['poe', 'dark', 'light']).default('poe'),
  alwaysOnTop: z.boolean().default(true),
  showOnIdle: z.boolean().default(false),
  fontScale: z.number().min(0.8).max(1.6).default(1),
});

/** Configuracao completa do usuario. Todos os campos tem default. */
export const UserConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
  hotkeys: HotkeysSchema.default({ triggerOverlay: 'alt+x', quickAnalyze: 'ctrl+c' }),
  crafting: CraftingSchema.default({}),
  ui: UiSchema.default({}),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

/** Patch parcial e recursivo aceito por `ConfigManager.update`. */
export type UserConfigPatch = {
  readonly version?: number;
  readonly hotkeys?: Partial<z.input<typeof HotkeysSchema>>;
  readonly crafting?: Partial<z.input<typeof CraftingSchema>>;
  readonly ui?: Partial<z.input<typeof UiSchema>>;
};

export const DEFAULT_USER_CONFIG: UserConfig = UserConfigSchema.parse({});

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

export interface HotkeyChangeEvent {
  readonly action: HotkeyAction;
  readonly previous: string;
  readonly next: string;
  /** A combinacao agora e registrada globalmente? */
  readonly global: boolean;
}

export interface ConfigChangeEvent {
  readonly previous: UserConfig;
  readonly next: UserConfig;
  readonly changedKeys: readonly string[];
}

export type ConfigEvent = 'hotkey:changed' | 'config:changed' | 'config:error';

export interface ConfigErrorEvent {
  readonly scope: 'load' | 'validate' | 'save';
  readonly message: string;
  readonly cause?: unknown;
}

type Handler<T> = (event: T) => void;

/**
 * Onde o config e lido e gravado.
 *
 * O renderer do Electron roda com `sandbox: true` e nao tem `node:fs`, entao
 * ele usa o `IpcConfigStorage` (via preload) em vez do padrao em disco.
 *
 * A interface nao expoe `node:*`, e o storage em disco mora em
 * `fileConfigStorage.ts`, que o bundle do renderer nao importa. Isso mantem o
 * ConfigManager testavel sem SO e sem vazar builtins do Node para o Vite.
 */
export interface ConfigStorage {
  /** Caminho do arquivo, quando existir. Serve para log e mensagem de erro. */
  readonly path?: string;
  /** Le o conteudo bruto, ou `null` quando ainda nao existe. */
  read(): Promise<string | null>;
  /** Sobrescreve o conteudo de forma atomica. */
  write(contents: string): Promise<void>;
}

/** Storage em memoria: o padrao seguro, sem dependencia de plataforma. */
export class MemoryConfigStorage implements ConfigStorage {
  #contents: string | null;

  constructor(initial: string | null = null) {
    this.#contents = initial;
  }

  async read(): Promise<string | null> {
    return this.#contents;
  }

  async write(contents: string): Promise<void> {
    this.#contents = contents;
  }
}

/**
 * Storage no `localStorage`, para o dev no browser persistir entre recargas
 * sem precisar de backend.
 */
export class WebStorageConfigStorage implements ConfigStorage {
  readonly #key: string;
  readonly #storage: Storage | null;

  constructor(key = 'poe2-craft-assistant:config', storage?: Storage) {
    this.#key = key;
    this.#storage = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  }

  async read(): Promise<string | null> {
    return this.#storage?.getItem(this.#key) ?? null;
  }

  async write(contents: string): Promise<void> {
    this.#storage?.setItem(this.#key, contents);
  }
}

export interface ConfigManagerOptions {
  /**
   * Onde ler/gravar. Padrao: `MemoryConfigStorage`, que nao persiste.
   *
   * Use `FileConfigStorage` (so em Node) ou `IpcConfigStorage` (renderer do
   * Electron) quando quiser persistencia de verdade.
   */
  readonly storage?: ConfigStorage;
  /** Desliga a validacao de hotkeys (util para testes de schema puro). */
  readonly validateHotkeys?: boolean;
}

// ---------------------------------------------------------------------------
// ConfigManager
// ---------------------------------------------------------------------------

/**
 * Le, valida, persiste e observa a configuracao do usuario.
 *
 * Caracteristicas que importam para o overlay:
 *  - Escrita atomica (arquivo temporario + rename), para nao corromper o
 *    config se o jogo travar no meio da escrita.
 *  - `config:error` em vez de excecao: falha ao ler um arquivo corrompido
 *    nunca pode derrubar o overlay.
 *  - Emissao de `hotkey:changed` permite rebind em runtime sem reiniciar.
 */
export class ConfigManager {
  readonly #storage: ConfigStorage;
  readonly #validateHotkeys: boolean;
  readonly #handlers = new Map<ConfigEvent, Set<Handler<never>>>();
  #config: UserConfig;
  #loaded = false;
  #exists = false;

  constructor(options: ConfigManagerOptions = {}) {
    this.#storage = options.storage ?? new MemoryConfigStorage();
    this.#validateHotkeys = options.validateHotkeys ?? true;
    this.#config = DEFAULT_USER_CONFIG;
  }

  // -----------------------------------------------------------------------
  // Propriedades
  // -----------------------------------------------------------------------

  /**
   * Caminho do arquivo quando o storage tem um; `null` caso contrario.
   * So e' informativo (log e mensagens de erro): o acesso real passa pelo
   * `ConfigStorage`, que via IPC nao tem caminho nenhum.
   */
  get path(): string | null {
    return this.#storage.path ?? null;
  }

  get exists(): boolean {
    return this.#exists;
  }

  /** Config atual (sempre completa, nunca parcial). */
  get(): UserConfig {
    return this.#config;
  }

  get hotkeys(): UserConfig['hotkeys'] {
    return this.#config.hotkeys;
  }

  get ui(): UserConfig['ui'] {
    return this.#config.ui;
  }

  get crafting(): UserConfig['crafting'] {
    return this.#config.crafting;
  }

  // -----------------------------------------------------------------------
  // Eventos
  // -----------------------------------------------------------------------

  on<T extends ConfigEvent>(event: T, handler: Handler<never>): () => void;
  on(event: 'hotkey:changed', handler: Handler<HotkeyChangeEvent>): () => void;
  on(event: 'config:changed', handler: Handler<ConfigChangeEvent>): () => void;
  on(event: 'config:error', handler: Handler<ConfigErrorEvent>): () => void;
  on(event: ConfigEvent, handler: Handler<never>): () => void {
    const set = this.#handlers.get(event) ?? new Set();
    set.add(handler);
    this.#handlers.set(event, set);
    return () => {
      set.delete(handler);
    };
  }

  off(event: ConfigEvent, handler: Handler<never>): void {
    this.#handlers.get(event)?.delete(handler);
  }

  #emit<T extends ConfigEvent>(event: T, payload: unknown): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      try {
        (handler as Handler<unknown>)(payload);
      } catch (error) {
        if (event === 'config:error') throw error;
        this.#emit('config:error', { scope: 'validate', message: 'Listener de config lancou excecao.', cause: error });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Carga e persistencia
  // -----------------------------------------------------------------------

  /**
   * Le o `config.json`. Ausente = defaults. Corrompido = defaults + aviso,
   * porque perder preferencias e melhor que derrubar o overlay.
   *
   * E' assincrono porque o renderer do Electron nao tem `node:fs`: ele le o
   * arquivo pelo processo main (ver `IpcConfigStorage`).
   */
  async load(): Promise<UserConfig> {
    let contents: string | null;
    try {
      contents = await this.#storage.read();
    } catch (error) {
      this.#emit('config:error', {
        scope: 'load',
        message: 'Falha ao ler a configuracao; usando defaults.',
        cause: error,
      });
      this.#config = DEFAULT_USER_CONFIG;
      this.#loaded = true;
      this.#exists = false;
      return this.#config;
    }

    if (contents === null) {
      this.#config = DEFAULT_USER_CONFIG;
      this.#loaded = true;
      this.#exists = false;
      return this.#config;
    }

    this.#exists = true;

    let raw: unknown;
    try {
      raw = JSON.parse(contents);
    } catch (error) {
      this.#emit('config:error', {
        scope: 'load',
        message: `config.json ilegivel; usando defaults. ${this.#describeStorage()}`,
        cause: error,
      });
      this.#config = DEFAULT_USER_CONFIG;
      this.#loaded = true;
      return this.#config;
    }

    const parsed = this.#parseWithValidation(raw);
    this.#config = parsed;
    this.#loaded = true;
    return parsed;
  }

  /** Le apenas se ainda nao foi lido; util na inicializacao. */
  async ensureLoaded(): Promise<UserConfig> {
    return this.#loaded ? this.#config : this.load();
  }

  /** Le do zero, ignorando o cache em memoria. */
  async reload(): Promise<UserConfig> {
    this.#loaded = false;
    return this.load();
  }

  /** Grava o config inteiro. */
  async save(config: UserConfig = this.#config): Promise<void> {
    try {
      await this.#storage.write(`${JSON.stringify(config, null, 2)}\n`);
      this.#exists = true;
    } catch (error) {
      this.#emit('config:error', {
        scope: 'save',
        message: `Nao foi possivel gravar ${this.#describeStorage()}`,
        cause: error,
      });
      throw error;
    }
  }

  #describeStorage(): string {
    const path = this.path;
    return path ?? this.#storage.constructor.name;
  }

  // -----------------------------------------------------------------------
  // Validacao
  // -------------------------------------------------------------------------

  /** Valida um conjunto de atalhos respeitando conflitos internos. */
  validateHotkeys(hotkeys: UserConfig['hotkeys']): ReadonlyMap<HotkeyAction, HotkeyValidation> {
    return validateHotkeySet(hotkeys, {}) as ReadonlyMap<HotkeyAction, HotkeyValidation>;
  }

  /**
   * Valida um bloco de hotkeys e devolve a versao corrigida.
   *
   * A regra depende de QUEM usa a combinacao: `triggerOverlay` e global, entao
   * exige modificador e nao pode ser atalho reservado do SO. `quickAnalyze` e
   * apenas observado — por isso `Ctrl+C` e aceitavel la, mas continua invalido
   * como hotkey global.
   */
  #sanitizeHotkeys(hotkeys: UserConfig['hotkeys']): UserConfig['hotkeys'] {
    if (!this.#validateHotkeys) return hotkeys;

    const trigger = validateHotkey(hotkeys.triggerOverlay, { asGlobal: true });
    if (!trigger.valid) {
      this.#emit('config:error', {
        scope: 'validate',
        message: `hotkeys.triggerOverlay invalido (${trigger.code}): ${trigger.message}. Voltando para Alt+X.`,
      });
      hotkeys = { ...hotkeys, triggerOverlay: 'alt+x' };
    }

    const quick = validateHotkey(hotkeys.quickAnalyze, { taken: [hotkeys.triggerOverlay] });
    if (!quick.valid) {
      this.#emit('config:error', {
        scope: 'validate',
        message: `hotkeys.quickAnalyze invalido (${quick.code}): ${quick.message}. Voltando para Ctrl+C.`,
      });
      hotkeys = { ...hotkeys, quickAnalyze: 'ctrl+c' };
    }

    return hotkeys;
  }

  #parseWithValidation(raw: unknown): UserConfig {
    const parsed = UserConfigSchema.safeParse(raw);

    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      this.#emit('config:error', {
        scope: 'load',
        message: `Config invalido; usando defaults. ${message}`,
      });
      return DEFAULT_USER_CONFIG;
    }

    if (parsed.data.hotkeys.triggerOverlay === 'alt+q') {
      parsed.data.hotkeys.triggerOverlay = 'alt+x';
    }

    if (!this.#validateHotkeys) return parsed.data;
    return { ...parsed.data, hotkeys: this.#sanitizeHotkeys(parsed.data.hotkeys) };
  }

  // -----------------------------------------------------------------------
  // Mutacoes
  // -------------------------------------------------------------------------

  /**
   * Aplica um patch parcial, valida, persiste e emite eventos.
   * Em caso de recusa, a config atual fica intacta e o erro e lancado.
   */
  async update(patch: UserConfigPatch, options: { persist?: boolean } = {}): Promise<UserConfig> {
    const previous = this.#config;

    const merged = {
      ...previous,
      ...patch,
      version: CONFIG_VERSION,
      hotkeys: { ...previous.hotkeys, ...patch.hotkeys },
      crafting: { ...previous.crafting, ...patch.crafting },
      ui: { ...previous.ui, ...patch.ui },
    };

    const parsed = UserConfigSchema.safeParse(merged);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      this.#emit('config:error', { scope: 'validate', message: `Patch invalido: ${message}` });
      throw new ConfigValidationError(message, toIssues(parsed.error.issues));
    }

    const next = this.#validateHotkeys ? this.#parseWithValidation(parsed.data) : parsed.data;

    this.#config = next;
    if (options.persist !== false) await this.save(next);

    const changedKeys = diffKeys(previous, next);
    if (changedKeys.length === 0) return next;

    for (const action of HOTKEY_ACTIONS) {
      const before = previous.hotkeys[action];
      const after = next.hotkeys[action];
      if (before !== after) {
        this.#emit('hotkey:changed', {
          action,
          previous: before,
          next: after,
          global: GLOBAL_HOTKEY_ACTIONS.has(action),
        });
      }
    }

    this.#emit('config:changed', { previous, next, changedKeys });
    return next;
  }

  /**
   * Troca um atalho especifico.
   * `asGlobal` fica implicito pela acao (ver `GLOBAL_HOTKEY_ACTIONS`).
   */
  async setHotkey(
    action: HotkeyAction,
    sequence: string,
    options: { persist?: boolean } = {},
  ): Promise<HotkeyValidation> {
    const asGlobal = GLOBAL_HOTKEY_ACTIONS.has(action);

    // Valida contra os OUTROS atalhos ja configurados.
    const others = HOTKEY_ACTIONS.filter((a) => a !== action).map((a) => this.#config.hotkeys[a]);
    const validation = validateHotkey(sequence, { asGlobal, taken: others });

    if (!validation.valid) {
      this.#emit('config:error', {
        scope: 'validate',
        message: `Atalho recusado para ${action}: ${validation.message}`,
      });
      return validation;
    }

    await this.update({ hotkeys: { [action]: validation.normalized } }, options);
    return validation;
  }

  /** Atalho de uma acao, ja canonico. */
  getHotkey(action: HotkeyAction): string {
    return this.#config.hotkeys[action];
  }

  /** Atalho legivel para exibicao (`alt+e` -> `Alt+E`). */
  getHotkeyLabel(action: HotkeyAction): string {
    return formatSequence(this.#config.hotkeys[action]);
  }

  /** Um atalho e registrado globalmente? Afeta sequestro de tecla. */
  isGlobalHotkey(action: HotkeyAction): boolean {
    return GLOBAL_HOTKEY_ACTIONS.has(action);
  }

  /** Restaura os defaults e persiste. */
  async reset(options: { persist?: boolean } = {}): Promise<UserConfig> {
    const previous = this.#config;
    this.#config = DEFAULT_USER_CONFIG;
    if (options.persist !== false) await this.save(this.#config);

    for (const action of HOTKEY_ACTIONS) {
      const before = previous.hotkeys[action];
      const after = this.#config.hotkeys[action];
      if (before !== after) {
        this.#emit('hotkey:changed', {
          action,
          previous: before,
          next: after,
          global: GLOBAL_HOTKEY_ACTIONS.has(action),
        });
      }
    }
    this.#emit('config:changed', {
      previous,
      next: this.#config,
      changedKeys: diffKeys(previous, this.#config),
    });
    return this.#config;
  }

  /** Linha de debug com o storage e os atalhos atuais. */
  describe(): string {
    return [
      `path=${this.#describeStorage()}`,
      `existe=${this.exists}`,
      `triggerOverlay=${this.getHotkeyLabel('triggerOverlay')}(global)`,
      `quickAnalyze=${this.getHotkeyLabel('quickAnalyze')}(observado)`,
    ].join(' ');
  }
}

/**
 * Storage que delega ao processo main do Electron.
 *
 * O renderer roda com `contextIsolation` e `sandbox`, entao nao tem acesso a
 * `node:fs`. Passa a ser o main quem le e grava o `config.json`.
 */
export class IpcConfigStorage implements ConfigStorage {
  #read: () => Promise<string | null>;
  #write: (contents: string) => Promise<void>;

  constructor(api: {
    read: () => Promise<string | null>;
    write: (contents: string) => Promise<void>;
  }) {
    this.#read = api.read;
    this.#write = api.write;
  }

  read(): Promise<string | null> {
    return this.#read();
  }

  write(contents: string): Promise<void> {
    return this.#write(contents);
  }
}

/** Erro lancado quando um patch nao passa no schema. */
export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(message: string, issues: readonly ConfigIssue[]) {
    super(message);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

/** Achata os `ZodIssue` em `path: string`, legivel para log e UI. */
function toIssues(issues: readonly z.ZodIssue[]): ConfigIssue[] {
  return issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** Lista quais chaves de topo mudaram (hotkeys/crafting/ui sao trato como bloco). */
function diffKeys(previous: UserConfig, next: UserConfig): string[] {
  const keys: string[] = [];
  for (const key of ['version', 'hotkeys', 'crafting', 'ui'] as const) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) keys.push(key);
  }
  return keys;
}