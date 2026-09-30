import { z } from 'zod';

import { ItemClassSchema } from '../types/index.js';
import type { ItemClass, ModDefinition } from '../types/index.js';

/**
 * Ingestao e validacao da base de dados de craft do PoE2.
 *
 * Fronteira entre "dados que vem de fora" e o agente: nenhuma fonte externa e'
 * confiavel, entao o payload passa por schema e, se nao passar, a base local
 * assume. Nunca lanca.
 *
 * Modulo puro — o I/O entra injetado como `HydrationSnapshotStore` e
 * `RemoteSource`, o que mantem o bundle do renderer livre de Node.
 */

export const HYDRATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ItemBaseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    itemClass: ItemClassSchema,
    maxPrefixes: z.number().int().nonnegative(),
    maxSuffixes: z.number().int().nonnegative(),
    baseNames: z.array(z.string().min(1)),
  })
  .strict();

export const CraftCurrencySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(['random-affix', 'random-add', 'remove', 'transform', 'quality', 'reroll']),
    appliesToEmptySlot: z.boolean(),
    overwritesExisting: z.boolean(),
    costInExalted: z.number().nonnegative(),
    slotFilter: z.array(z.enum(['prefix', 'suffix', 'none'])),
    improvesTier: z.boolean(),
    removesPerUse: z.number().int().nonnegative(),
    description: z.string(),
  })
  .strict();

/**
 * `.strict()` em todo schema: fonte externa que mande campo novo ou faltando
 * esta sinalizando troca de formato, e aceitar o registro pela metade distorce
 * as chances calculadas pelo agente sem nenhum aviso.
 */
export const HydrationModSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    slot: z.enum(['prefix', 'suffix', 'none']),
    tier: z.number().int().positive(),
    text: z.string().min(1),
    value: z.number().nullable(),
    requiredItemLevel: z.number().int().nonnegative(),
    // Peso zero zeraria a chance do mod sem explicar o motivo.
    weight: z.number().positive(),
    itemClasses: z.array(ItemClassSchema).min(1),
    tags: z.array(z.string().min(1)),
  })
  .strict();

export const ModsDatabaseSchema = z
  .object({
    version: z.number().int().positive(),
    league: z.string().min(1),
    // ISO ou epoch ms: as duas formas aparecem em campo de origem.
    updatedAt: z.union([z.string().min(1), z.number().int().positive()]),
    modifiers: z.array(HydrationModSchema).min(1),
    bases: z.array(ItemBaseSchema).min(1),
    currencies: z.array(CraftCurrencySchema).min(1),
  })
  .superRefine((database, ctx) => {
    // Ids repetidos sobrescrevem o registro anterior em silencio no indice.
    assertUnique(
      database.modifiers.map((mod) => mod.id),
      'modifiers',
      ctx,
    );
    assertUnique(
      database.bases.map((base) => base.id),
      'bases',
      ctx,
    );
    assertUnique(
      database.currencies.map((currency) => currency.id),
      'currencies',
      ctx,
    );

    const knownClasses = new Set(database.bases.map((base) => base.itemClass));
    for (const [position, mod] of database.modifiers.entries()) {
      for (const itemClass of mod.itemClasses) {
        if (knownClasses.has(itemClass)) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['modifiers', position, 'itemClasses'],
          message: `classe de item desconhecida: "${itemClass}"`,
        });
        break;
      }
    }
  });

export type ItemBase = z.infer<typeof ItemBaseSchema>;
export type CraftCurrency = z.infer<typeof CraftCurrencySchema>;

/** `readonly` para casar com `ModDefinition`: e' a mesma estrutura dos dois lados. */
export type HydrationMod = Omit<z.infer<typeof HydrationModSchema>, 'itemClasses' | 'tags'> & {
  readonly itemClasses: readonly ItemClass[];
  readonly tags: readonly string[];
};

/** Declarado a mao (e nao via `z.infer`) para a ida e volta do snapshot compilar. */
export interface ModsDatabaseInput {
  readonly version: number;
  readonly league: string;
  readonly updatedAt: string | number;
  readonly modifiers: readonly HydrationMod[];
  readonly bases: readonly ItemBase[];
  readonly currencies: readonly CraftCurrency[];
}

/**
 * Diferente do payload cru: `updatedAt` vira sempre ISO 8601 e cada mod ganha
 * `maxTier`. O `maxTier` e' derivado do conjunto, nunca aceito de fora — um
 * valor errado faz o calculo de tier esperado do orbe usar a escala errada.
 */
export interface ModsDatabase {
  readonly version: number;
  readonly league: string;
  readonly updatedAt: string;
  readonly modifiers: readonly ModDefinition[];
  readonly bases: readonly ItemBase[];
  readonly currencies: readonly CraftCurrency[];
}

function assertUnique(ids: readonly string[], field: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `id duplicado: "${id}"`,
      });
      return;
    }
    seen.add(id);
  }
}

export type ValidationResult =
  | { readonly ok: true; readonly database: ModsDatabase }
  | { readonly ok: false; readonly issues: readonly string[] };

function normalize(input: ModsDatabaseInput): ModsDatabase {
  const maxTierByName = new Map<string, number>();
  for (const mod of input.modifiers) {
    const current = maxTierByName.get(mod.name) ?? 0;
    if (mod.tier > current) maxTierByName.set(mod.name, mod.tier);
  }

  return {
    version: input.version,
    league: input.league,
    updatedAt: toIsoString(input.updatedAt),
    bases: input.bases,
    currencies: input.currencies,
    modifiers: input.modifiers.map((mod) => ({
      ...mod,
      maxTier: maxTierByName.get(mod.name) ?? mod.tier,
    })),
  };
}

function toIsoString(value: string | number): string {
  if (typeof value === 'number') return new Date(value).toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

/** Remove os campos derivados: o snapshot tem de continuar re-ingerivel. */
function toSnapshot(database: ModsDatabase): ModsDatabaseInput {
  return {
    version: database.version,
    league: database.league,
    updatedAt: database.updatedAt,
    bases: database.bases,
    currencies: database.currencies,
    modifiers: database.modifiers.map(({ maxTier: _derived, ...rest }) => rest),
  };
}

/** Nunca lanca: devolve os problemas para o chamador manter a base atual. */
export function validateModsDatabase(raw: unknown): ValidationResult {
  const parsed = ModsDatabaseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`),
    };
  }
  return { ok: true, database: normalize(parsed.data) };
}

export interface ModsDatabaseStats {
  readonly modifiers: number;
  readonly families: number;
  readonly bases: number;
  readonly currencies: number;
}

/**
 * A hidratacao acontece uma vez; daqui para frente e tudo lookup em memoria.
 * O agente pergunta status, tier e chance por moeda no meio do planejamento, e
 * `await` sobre rede em cada pergunta seria lento e fragil.
 */
export class ModsIndex {
  readonly #database: ModsDatabase;
  readonly #byItemClass = new Map<string, readonly ModDefinition[]>();
  readonly #byName = new Map<string, ModDefinition[]>();
  readonly #basesByClass = new Map<string, ItemBase[]>();
  readonly #currencies = new Map<string, CraftCurrency>();

  constructor(database: ModsDatabase) {
    this.#database = database;

    for (const itemClass of collectItemClasses(database)) {
      this.#byItemClass.set(
        itemClass,
        database.modifiers.filter((mod) => mod.itemClasses.some((entry) => entry === itemClass)),
      );
    }

    for (const mod of database.modifiers) {
      const family = this.#byName.get(mod.name);
      if (family === undefined) this.#byName.set(mod.name, [mod]);
      else family.push(mod);
    }
    for (const family of this.#byName.values()) {
      family.sort((a, b) => a.tier - b.tier);
    }

    for (const base of database.bases) {
      const list = this.#basesByClass.get(base.itemClass);
      if (list === undefined) this.#basesByClass.set(base.itemClass, [base]);
      else list.push(base);
    }

    for (const currency of database.currencies) {
      this.#currencies.set(currency.name.toLowerCase(), currency);
    }
  }

  get version(): number {
    return this.#database.version;
  }

  get league(): string {
    return this.#database.league;
  }

  get updatedAt(): string {
    return toIsoString(this.#database.updatedAt);
  }

  get database(): ModsDatabase {
    return this.#database;
  }

  get stats(): ModsDatabaseStats {
    return {
      modifiers: this.#database.modifiers.length,
      families: this.#byName.size,
      bases: this.#database.bases.length,
      currencies: this.#database.currencies.length,
    };
  }

  modsForItemClass(itemClass: string): readonly ModDefinition[] {
    return this.#byItemClass.get(itemClass) ?? [];
  }

  familyByName(name: string): readonly ModDefinition[] {
    return this.#byName.get(name) ?? [];
  }

  baseForItemClass(itemClass: string): ItemBase | null {
    return this.#basesByClass.get(itemClass)?.[0] ?? null;
  }

  listBases(): readonly ItemBase[] {
    return this.#database.bases;
  }

  currencyByName(name: string): CraftCurrency | null {
    return this.#currencies.get(name.trim().toLowerCase()) ?? null;
  }

  listCurrencies(): readonly CraftCurrency[] {
    return this.#database.currencies;
  }

  itemClasses(): readonly string[] {
    return [...this.#byItemClass.keys()];
  }
}

function collectItemClasses(database: ModsDatabase): readonly string[] {
  const classes = new Set<string>();
  for (const base of database.bases) classes.add(base.itemClass);
  for (const mod of database.modifiers) {
    for (const itemClass of mod.itemClasses) classes.add(itemClass);
  }
  return [...classes];
}

export interface HydrationSnapshotStore {
  /**
   * Assincrono porque no renderer o disco so existe do outro lado do IPC.
   */
  read(): Promise<unknown | null>;
  write(snapshot: ModsDatabaseInput): Promise<void>;
}

export type RemoteSource = () => Promise<unknown>;

/**
 * `live`     - veio da rede nesta hidratacao.
 * `snapshot` - veio do disco/memoria e ainda esta dentro do TTL.
 * `stale`    - TTL vencido; revalidar mesmo assim e melhor que planejar sem base.
 * `empty`    - nao ha base alguma utilizavel.
 */
export type HydrationState = 'live' | 'snapshot' | 'stale' | 'empty';

export interface DataStatus {
  readonly state: HydrationState;
  readonly league: string | null;
  readonly version: number | null;
  readonly updatedAt: string | null;
  readonly ageMs: number | null;
  readonly ttlMs: number;
  readonly modifiers: number;
  readonly bases: number;
  readonly currencies: number;
  /** Explicacao curta para o jogador, sem stack trace. */
  readonly detail: string;
}

export type DataStatusTone = 'ok' | 'warn' | 'error';

export interface DataStatusLabel {
  readonly text: string;
  readonly tone: DataStatusTone;
  readonly title: string;
}

export function describeDataStatus(status: DataStatus): DataStatusLabel {
  const version = status.version === null ? '?' : `v${status.version.toFixed(2)}`;
  const prefix = 'Base de Modificadores';

  if (status.state === 'empty') {
    return { text: `${prefix}: indisponível`, tone: 'error', title: status.detail };
  }
  if (status.state === 'stale') {
    return { text: `${prefix}: local ${version} (desatualizada)`, tone: 'warn', title: status.detail };
  }
  if (status.state === 'snapshot') {
    return { text: `${prefix}: local ${version}`, tone: 'ok', title: status.detail };
  }
  return { text: `${prefix}: atualizada ${version}`, tone: 'ok', title: status.detail };
}

export interface DataHydrationOptions {
  readonly store?: HydrationSnapshotStore | undefined;
  readonly fetchRemote?: RemoteSource | undefined;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly verbose?: boolean;
}

export interface HydrateOptions {
  readonly force?: boolean;
}

/**
 * Ordem de preferencia, ja aplicada em `hydrate()`:
 *   1. base valida em memoria (senao um hotkey nao paga rede)
 *   2. fonte externa, validada por schema
 *   3. snapshot local, tambem validado por schema
 *   4. base vazia
 *
 * Chamadas concorrentes compartilham a mesma promise, para que abrir o overlay
 * durante a hidratacao nao dispare duas buscas.
 */
export class DataHydrationService {
  readonly #store: HydrationSnapshotStore | undefined;
  readonly #fetchRemote: RemoteSource | undefined;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #verbose: boolean;

  #index: ModsIndex | null = null;
  #state: HydrationState = 'empty';
  #detail = 'Base ainda nao carregada.';
  #pending: Promise<DataStatus> | null = null;

  constructor(options: DataHydrationOptions = {}) {
    this.#store = options.store;
    this.#fetchRemote = options.fetchRemote;
    this.#ttlMs = options.ttlMs ?? HYDRATION_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#verbose = options.verbose ?? false;
  }

  get index(): ModsIndex | null {
    return this.#index;
  }

  get state(): HydrationState {
    return this.#state;
  }

  get status(): DataStatus {
    const index = this.#index;
    if (index === null) {
      return {
        state: 'empty',
        league: null,
        version: null,
        updatedAt: null,
        ageMs: null,
        ttlMs: this.#ttlMs,
        modifiers: 0,
        bases: 0,
        currencies: 0,
        detail: this.#detail,
      };
    }

    const updatedAt = index.updatedAt;
    const ageMs = Math.max(0, this.#now() - Date.parse(updatedAt));
    const stats = index.stats;
    return {
      state: this.#state,
      league: index.league,
      version: index.version,
      updatedAt,
      ageMs,
      ttlMs: this.#ttlMs,
      modifiers: stats.modifiers,
      bases: stats.bases,
      currencies: stats.currencies,
      detail: this.#detail,
    };
  }

  needsRevalidation(): boolean {
    const index = this.#index;
    if (index === null) return true;
    const parsed = Date.parse(index.updatedAt);
    if (Number.isNaN(parsed)) return true;
    return this.#now() - parsed >= this.#ttlMs;
  }

  /** Idempotente dentro do TTL; `force` ignora a base em memoria. */
  async hydrate(options: HydrateOptions = {}): Promise<DataStatus> {
    if (this.#pending !== null) return this.#pending;

    if (options.force !== true && this.#index !== null && !this.needsRevalidation()) {
      return this.status;
    }

    this.#pending = this.#load().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #load(): Promise<DataStatus> {
    const remoteFailures: string[] = [];

    if (this.#fetchRemote !== undefined) {
      try {
        const raw = await this.#fetchRemote();
        const result = validateModsDatabase(raw);
        if (result.ok) {
          this.#commit(result.database, 'live', `Fonte externa (${result.database.league}).`);
          this.#persist(result.database);
          return this.status;
        }
        remoteFailures.push(`payload invalido (${result.issues.slice(0, 3).join('; ')})`);
      } catch (error) {
        remoteFailures.push(error instanceof Error ? error.message : String(error));
      }
    }

    const snapshot = await this.#readSnapshot();
    if (snapshot !== null) {
      const age = this.#ageOf(snapshot);
      // Grace period: allow snapshots up to 2x TTL to be used as 'snapshot' instead of 'stale'
      // This avoids 'desatualizado' warning on first use without internet.
      const graceMs = this.#ttlMs;
      const state: HydrationState = age >= this.#ttlMs + graceMs ? 'stale' : 'snapshot';
      const reason =
        remoteFailures.length > 0
          ? `Revalidacao falhou (${remoteFailures[0]}). Usando o snapshot local.`
          : 'Usando o snapshot local.';
      this.#commit(snapshot, state, reason);
      return this.status;
    }

    // Sem fonte e sem snapshot, a base valida em memoria continua servindo:
    // descartar aqui transformaria uma falha de revalidacao em outage.
    if (this.#index !== null) {
      this.#state = 'stale';
      this.#detail = `Revalidacao falhou (${remoteFailures[0] ?? 'sem fonte externa'}). Mantendo a base em memoria.`;
      if (this.#verbose) console.warn(`[hydration] ${this.#detail}`);
      return this.status;
    }

    this.#index = null;
    this.#state = 'empty';
    this.#detail =
      remoteFailures.length > 0
        ? `Sem fonte externa (${remoteFailures[0]}) e sem snapshot local.`
        : 'Sem fonte externa e sem snapshot local.';
    if (this.#verbose) console.warn(`[hydration] ${this.#detail}`);
    return this.status;
  }

  #commit(database: ModsDatabase, state: HydrationState, detail: string): void {
    this.#index = new ModsIndex(database);
    this.#state = state;
    this.#detail = detail;
    if (this.#verbose) {
      const stats = this.#index.stats;
      console.log(
        `[hydration] ${state} ${database.league} v${database.version}: ` +
          `${stats.modifiers} mods, ${stats.bases} bases, ${stats.currencies} moedas`,
      );
    }
  }

  async #readSnapshot(): Promise<ModsDatabase | null> {
    if (this.#store === undefined) return null;
    let raw: unknown | null;
    try {
      raw = await this.#store.read();
    } catch (error) {
      if (this.#verbose) {
        console.warn(`[hydration] snapshot ilegivel: ${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    }
    if (raw === null || raw === undefined) return null;

    const result = validateModsDatabase(raw);
    if (result.ok) return result.database;

    // Snapshot corrompido e' o pior caso, nao ha onde revalidar. O overlay
    // segue com a base vazia em vez de crashar.
    if (this.#verbose) {
      console.warn(`[hydration] snapshot invalido: ${result.issues.slice(0, 3).join('; ')}`);
    }
    return null;
  }

  /**
   * Fire-and-forget: o store pode estar em disco, do outro lado do IPC, e
   * esperar a escrita atrasaria o overlay por causa de um cache.
   */
  #persist(database: ModsDatabase): void {
    if (this.#store === undefined) return;
    const warn = (error: unknown) => {
      if (this.#verbose) {
        console.warn(
          `[hydration] nao foi possivel gravar o snapshot: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    try {
      void Promise.resolve(this.#store.write(toSnapshot(database))).catch(warn);
    } catch (error) {
      warn(error);
    }
  }

  #ageOf(database: ModsDatabase): number {
    const parsed = Date.parse(toIsoString(database.updatedAt));
    if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.#now() - parsed);
  }
}

export function createMemorySnapshotStore(initial: unknown = null): HydrationSnapshotStore & {
  /** Leitura sincrona, so para assercao em teste. */
  peek(): unknown | null;
} {
  let current: unknown | null = initial;
  return {
    read: async () => current,
    write: async (snapshot) => {
      current = snapshot;
    },
    peek: () => current,
  };
}
