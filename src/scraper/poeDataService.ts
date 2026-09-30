import axios, { type AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';

import type { ItemClass, ModDefinition, ModResolution, OrbDefinition, OrbOdds } from '../types/index.js';
import { normalizeModText, tokenize } from '../parser/index.js';
import { ODDS_CANDIDATE_ORBS, ORB_CATALOG, SEED_MODS, type SeedMod } from './catalog.js';
import type { ModsIndex } from './dataHydration.js';
import { WikiCache, type CacheRecord } from './wikiCache.js';

export interface PoeDataServiceOptions {
  /** URL base da wiki usada como fonte de modificadores. */
  readonly wikiBaseUrl?: string;
  /** League no formato aceito pela trade API do PoE2. */
  readonly league?: string;
  readonly cache?: WikiCache;
  readonly httpClient?: AxiosInstance;
  /** Quando true (padrao), qualquer erro de rede cai no catalogo local. */
  readonly fallbackToSeed?: boolean;
  readonly timeoutMs?: number;
  /**
   * Base hidratada por `DataHydrationService`. Quando presente, e' consultada
   * antes de qualquer rede: e' o contrato de "o agente usa os dados locais
   * indexados primeiro", e o que mantem o overlay instantaneo no jogo.
   */
  readonly modsIndex?: ModsIndex | null;
}

const DEFAULT_WIKI_BASE_URL = process.env['POE2_WIKI_MODIFIER_BASE_URL'] ?? 'https://www.poe2wiki.net';
const DEFAULT_LEAGUE = process.env['POE2_LEAGUE'] ?? 'Standard';

/** Resposta da trade API ao buscar listagens de uma moeda. */
interface TradeFetchResponse {
  result: { listing: { price?: { amount?: string; currency?: string } } }[];
}

/**
 * Converte o catalogo seed em ModDefinition[] (um registro por tier).
 * Esta e' a fonte de verdade quando a wiki nao esta disponivel.
 */
function seedModsToDefinitions(seeds: readonly SeedMod[] = SEED_MODS): readonly ModDefinition[] {
  const defs: ModDefinition[] = [];

  for (const seed of seeds) {
    const maxTier = seed.tiers.length;
    seed.tiers.forEach((tier, index) => {
      const tierNumber = index + 1;
      defs.push({
        id: `${seed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}#${seed.slot}#t${tierNumber}`,
        name: seed.name,
        slot: seed.slot,
        tier: tierNumber,
        text: tier.text,
        value: tier.value,
        requiredItemLevel: tier.ilvl,
        weight: seed.weight,
        itemClasses: seed.itemClasses,
        tags: seed.tags,
        maxTier,
      });
    });
  }

  return defs;
}

/** Score de similaridade entre um texto livre e um modificador do catalogo. */
export function similarityScore(query: string, candidate: string, tags: readonly string[]): number {
  const q = normalizeModText(query);
  const c = normalizeModText(candidate);
  if (q.length === 0 || c.length === 0) return 0;
  if (q === c) return 1;

  const qTokens = tokenize(q);
  const cTokens = new Set([...tokenize(c), ...tags.map((t) => t.toLowerCase())]);
  if (qTokens.length === 0) return 0;

  let hits = 0;
  for (const token of qTokens) {
    if (cTokens.has(token)) {
      hits += 1;
      continue;
    }
    // Match parcial token-a-token cobre "fire dmg" -> "flat fire damage".
    if ([...cTokens].some((ct) => ct.startsWith(token) || token.startsWith(ct))) {
      hits += 0.5;
    }
  }

  return hits / qTokens.length;
}

/**
 * Servico de dados do PoE2.
 *
 * Responde se um status desejado e PREFIXO ou SUFIXO, qual TIER minimo o item
 * level exige, e a chance estimada de sucesso por tipo de moeda.
 *
 * Ordem das fontes: base hidratada (`ModsIndex`) quando injetada — validada e em
 * memoria, entao e' a mais rapida e confiavel — depois cache (memoria -> disco),
 * wiki (Axios + Cheerio) e por fim o catalogo local (seed), para nunca deixar o
 * overlay sem resposta.
 */
export class PoeDataService {
  readonly #http: AxiosInstance;
  readonly #cache: WikiCache;
  readonly #wikiBaseUrl: string;
  readonly #league: string;
  readonly #fallbackToSeed: boolean;

  /**
   * Base hidratada.
   *
   * Mutavel de proposito: a hydration roda em background no host e pode terminar
   * depois da criacao do servico. `useModsIndex` troca a base sem reconstruir o
   * agente, invalidando as classes ja cacheadas.
   */
  #modsIndex: ModsIndex | null;

  /** Cache em memoria dos defs ja carregados, por classe de item. */
  readonly #modIndex = new Map<string, readonly ModDefinition[]>();
  readonly #orbIndex = new Map<string, OrbDefinition>();

  constructor(options: PoeDataServiceOptions = {}) {
    this.#wikiBaseUrl = options.wikiBaseUrl ?? DEFAULT_WIKI_BASE_URL;
    this.#league = options.league ?? DEFAULT_LEAGUE;
    // Sem `cache` explicito, usa so a memoria: e' o que roda no renderer, onde
    // nao ha `node:fs`. Quem roda no Node pode injetar um `FileCacheDisk`.
    this.#cache = options.cache ?? new WikiCache();
    this.#fallbackToSeed = options.fallbackToSeed ?? true;
    this.#modsIndex = options.modsIndex ?? null;
    this.#http =
      options.httpClient ??
      axios.create({
        timeout: options.timeoutMs ?? 8000,
        headers: { 'User-Agent': 'poe2-craft-assistant/0.1 (+overlay)' },
      });

    for (const orb of ORB_CATALOG) {
      this.#orbIndex.set(orb.name, orb);
    }
    this.#applyIndexCurrencies();
  }

  /**
   * Troca a base de dados em runtime.
   *
   * `null` volta ao caminho wiki/seed. Passado um indice novo, o cache por
   * classe e' descartado: misturar defs de duas bases erraria a probability.
   */
  useModsIndex(index: ModsIndex | null): void {
    this.#modsIndex = index;
    this.#modIndex.clear();
    if (index !== null) this.#applyIndexCurrencies();
  }

  get modsIndex(): ModsIndex | null {
    return this.#modsIndex;
  }

  /**
   * Moedas da base hidratada tem precedencia sobre o catalogo seed: sao os
   * mesmos campos, entao um patch de league nao obriga a recompilar o codigo.
   */
  #applyIndexCurrencies(): void {
    const index = this.#modsIndex;
    if (index === null) return;
    for (const currency of index.listCurrencies()) {
      this.#orbIndex.set(currency.name, {
        name: currency.name,
        kind: currency.kind,
        appliesToEmptySlot: currency.appliesToEmptySlot,
        overwritesExisting: currency.overwritesExisting,
        costInExalted: currency.costInExalted,
        slotFilter: currency.slotFilter,
        improvesTier: currency.improvesTier,
        removesPerUse: currency.removesPerUse,
        description: currency.description,
      });
    }
  }

  // ------------------------------------------------------------------
  // Orbs
  // ------------------------------------------------------------------

  getOrb(name: string): OrbDefinition | null {
    return this.#orbIndex.get(name) ?? null;
  }

  listOrbs(): readonly OrbDefinition[] {
    return [...this.#orbIndex.values()];
  }

  // ------------------------------------------------------------------
  // Modificadores
  // ------------------------------------------------------------------

  /**
   * Todos os modificadores aplicaveis a uma classe de item. Nunca lanca em caso
   * de falha de rede.
   *
   * A base hidratada tem precedencia inclusive sobre `forceRefresh`: ja foi
   * validada por schema e esta em memoria, entao o refresh so faz sentido para
   * quem depende da wiki.
   */
  async getModsForItemClass(itemClass: ItemClass, forceRefresh = false): Promise<readonly ModDefinition[]> {
    const key = `mods:${itemClass}`;

    const hydrated = this.#modsIndex?.modsForItemClass(itemClass) ?? [];
    if (hydrated.length > 0) {
      this.#modIndex.set(key, hydrated);
      return hydrated;
    }

    if (!forceRefresh) {
      const memo = this.#modIndex.get(key);
      if (memo) return memo;
      const cached = this.#cache.get(key);
      if (cached) {
        const defs = cached.payload as readonly ModDefinition[];
        this.#modIndex.set(key, defs);
        return defs;
      }
    }

    const defs = await this.#fetchMods(itemClass, key);
    this.#modIndex.set(key, defs);
    return defs;
  }

  /**
   * Prepara as classes mais usadas para o primeiro item. Com base hidratada e'
   * um lookup em memoria; sem ela, e' o que paga a latencia da wiki enquanto o
   * jogador ainda esta lendo o item.
   */
  async warmupFromIndex(itemClasses: readonly ItemClass[]): Promise<boolean> {
    const index = this.#modsIndex;
    if (index === null) return false;
    for (const itemClass of itemClasses) {
      const defs = index.modsForItemClass(itemClass);
      if (defs.length > 0) this.#modIndex.set(`mods:${itemClass}`, defs);
    }
    return true;
  }

  async #fetchMods(itemClass: ItemClass, cacheKey: string): Promise<readonly ModDefinition[]> {
    try {
      const url = `${this.#wikiBaseUrl}/wiki/Item_Mods`;
      const response = await this.#http.get<string>(url, { responseType: 'text' });
      const parsed = this.parseWikiModTable(response.data, itemClass);
      if (parsed.length > 0) {
        this.#cache.set(cacheKey, {
          key: cacheKey,
          payload: parsed,
          source: 'wiki',
        } satisfies CacheRecord);
        return parsed;
      }
      throw new Error('Wiki respondeu, mas nenhuma tabela de mods foi reconhecida.');
    } catch (error) {
      if (!this.#fallbackToSeed) throw error;
      const seed = seedModsToDefinitions().filter((d) => d.itemClasses.includes(itemClass));
      this.#cache.set(cacheKey, {
        key: cacheKey,
        payload: seed,
        source: 'seed',
      } satisfies CacheRecord);
      return seed;
    }
  }

  /**
   * Extrai a tabela de mods da wiki com Cheerio. Estrategia tolerante: procura
   * tabelas com cabecalho contendo "Name"/"Tier" e le as linhas como pares
   * nome/tier. Se o layout mudar, o fallback seed assume.
   */
  parseWikiModTable(html: string, itemClass: ItemClass): readonly ModDefinition[] {
    const $ = cheerio.load(html);
    const defs: ModDefinition[] = [];

    $('table').each((_tableIndex, table) => {
      const headers = $(table)
        .find('tr')
        .first()
        .find('th, td')
        .map((_i, cell) => $(cell).text().trim().toLowerCase())
        .get();

      const nameCol = headers.findIndex((h) => h.includes('name') || h.includes('modifier'));
      const tierCol = headers.findIndex((h) => h.startsWith('tier') || h.includes('tier'));
      if (nameCol < 0 || tierCol < 0) return;

      $(table)
        .find('tr')
        .slice(1)
        .each((_rowIndex, row) => {
          const cells = $(row).find('td').map((_i, cell) => $(cell).text().trim()).get();
          const name = cells[nameCol];
          const tierText = cells[tierCol];
          if (!name || !tierText) return;

          const tier = Number.parseInt(tierText.replace(/\D+/g, ''), 10);
          if (!Number.isFinite(tier) || tier <= 0) return;

          const slot: 'prefix' | 'suffix' | 'none' = /prefix/i.test(tierText)
            ? 'prefix'
            : /suffix/i.test(tierText)
              ? 'suffix'
              : 'none';

          defs.push({
            id: `${normalizeModText(name).replace(/\s+/g, '-')}#${slot}#t${tier}`,
            name,
            slot,
            tier,
            text: name,
            value: null,
            requiredItemLevel: tier * 20,
            weight: 100,
            itemClasses: [itemClass],
            tags: tokenize(name),
            maxTier: tier,
          });
        });
    });

    // Preenche maxTier corretamente por modificador.
    const maxByName = new Map<string, number>();
    for (const def of defs) {
      maxByName.set(def.name, Math.max(maxByName.get(def.name) ?? 0, def.tier));
    }

    return defs.map((def) => ({ ...def, maxTier: maxByName.get(def.name) ?? def.tier }));
  }

  // ------------------------------------------------------------------
  // Resolucao de status desejado
  // ------------------------------------------------------------------

  /**
   * Responde a pergunta central do agente:
   * "esse status existe? e prefixo ou sufixo? qual tier minimo?".
   */
  async resolveDesiredMod(
    query: string,
    itemClass: ItemClass,
    itemLevel: number | null,
  ): Promise<ModResolution | null> {
    const defs = await this.getModsForItemClass(itemClass);

    let best: { def: ModDefinition; score: number } | null = null;
    for (const def of defs) {
      const score = similarityScore(query, def.name, def.tags);
      if (score >= 0.6 && (!best || score > best.score)) {
        best = { def, score };
      }
    }

    if (!best) return null;

    const family = defs.filter((d) => d.name === best.def.name).sort((a, b) => a.tier - b.tier);
    const ilvl = itemLevel ?? 1;
    const availableTiers = family.filter((d) => d.requiredItemLevel <= ilvl);
    const bestAvailable = availableTiers.at(-1) ?? null;
    const bestOverall = family.at(-1) ?? null;

    return {
      definition: best.def,
      slot: best.def.slot,
      obtainable: availableTiers.length > 0,
      bestAvailableTier: bestAvailable?.tier ?? null,
      requiredItemLevel: bestAvailable?.requiredItemLevel ?? bestOverall?.requiredItemLevel ?? null,
      availableTiers,
    };
  }

  /** Versao sincrona: so funciona com dados ja carregados em cache. */
  resolveDesiredModSync(
    query: string,
    itemClass: ItemClass,
    itemLevel: number | null,
  ): ModResolution | null {
    const defs = this.#modIndex.get(`mods:${itemClass}`) ?? [];
    let best: { def: ModDefinition; score: number } | null = null;
    for (const def of defs) {
      const score = similarityScore(query, def.name, def.tags);
      if (score >= 0.6 && (!best || score > best.score)) best = { def, score };
    }
    if (!best) return null;

    const family = defs.filter((d) => d.name === best.def.name).sort((a, b) => a.tier - b.tier);
    const ilvl = itemLevel ?? 1;
    const availableTiers = family.filter((d) => d.requiredItemLevel <= ilvl);
    const bestAvailable = availableTiers.at(-1) ?? null;
    const bestOverall = family.at(-1) ?? null;

    return {
      definition: best.def,
      slot: best.def.slot,
      obtainable: availableTiers.length > 0,
      bestAvailableTier: bestAvailable?.tier ?? null,
      requiredItemLevel: bestAvailable?.requiredItemLevel ?? bestOverall?.requiredItemLevel ?? null,
      availableTiers,
    };
  }

  // ------------------------------------------------------------------
  // Probabilidades
  // ------------------------------------------------------------------

  /**
   * Probabilidade de um orbe produzir um modificador especifico.
   *
   * Modelo simplificado, mas consistente com o jogo: o peso relativo na pool
   * define a chance base; orbes baratos sorteiam de toda a pool de tiers
   * disponiveis para o item level e orbes caros concentram em tiers altos; e
   * com o slot ocupado a chance de brick sobe conforme o orbe sobrescrever.
   */
  estimateOdds(
    modId: string,
    itemClass: ItemClass,
    itemLevel: number | null,
    slotOccupied: boolean,
    orbName?: string,
  ): readonly OrbOdds[] {
    const defs = this.#modIndex.get(`mods:${itemClass}`) ?? [];
    const target = defs.find((d) => d.id === modId);
    if (!target) return [];

    const family = defs.filter((d) => d.name === target.name);
    const maxTier = Math.max(...family.map((d) => d.maxTier), 1);
    const ilvl = itemLevel ?? 1;
    const eligible = family.filter((d) => d.requiredItemLevel <= ilvl);
    const totalWeight = defs
      .filter((d) => d.slot === target.slot && d.requiredItemLevel <= ilvl)
      .reduce((sum, d) => sum + d.weight, 0);
    const targetWeight = eligible
      .filter((d) => d.slot === target.slot)
      .reduce((sum, d) => sum + d.weight, 0);

    // Chance base = peso do modificador / peso total da pool daquele slot.
    const baseChance = totalWeight > 0 ? targetWeight / totalWeight : 0;

    const candidates = orbName ? [orbName] : ODDS_CANDIDATE_ORBS;
    const odds: OrbOdds[] = [];

    for (const name of candidates) {
      const orb = this.#orbIndex.get(name);
      if (!orb) continue;
      if (!orb.slotFilter.includes(target.slot) && !orb.slotFilter.includes('none')) continue;

      // Orbes caros concentram o sorteio em tiers melhores.
      const tierFocus = orb.improvesTier
        ? 1
        : orb.name === 'Exalted Orb' || orb.name === 'Tainted Chaos Orb'
          ? 0.65
          : orb.name === 'Chaos Orb'
            ? 0.45
            : orb.name === 'Orb of Friction'
              ? 0.2
              : 0.35;

      const expectedTier = Math.max(
        1,
        Math.min(maxTier, Math.round(maxTier * (0.4 + tierFocus * 0.6))),
      );

      // Tier alto e mais raro: a chance cai conforme o tier desejado.
      const tierPenalty = 1 - ((expectedTier - 1) / Math.max(1, maxTier)) * 0.6;
      let chance = baseChance * tierFocus * tierPenalty;

      // Slot ocupado: ou o orbe nao pode tocar (Regal), ou ha risco de brick.
      let brick = 0;
      if (slotOccupied) {
        if (!orb.overwritesExisting) {
          chance = 0;
        } else {
          brick = 0.35 * (orb.costInExalted / 10);
          chance *= 0.65;
        }
      }

      const neutral = Math.max(0, 1 - chance - brick);
      odds.push({
        orb: orb.name,
        modId,
        chance: round4(chance),
        neutral: round4(neutral),
        brick: round4(brick),
        expectedTier,
        costInExalted: orb.costInExalted,
      });
    }

    return odds.sort((a, b) => b.chance / b.costInExalted - a.chance / a.costInExalted);
  }

  /**
   * Preco de mercado (em Exalted) de uma moeda, via trade API do PoE2.
   * Falha silenciosa: devolve null e o agente usa a tabela de custos local.
   */
  async fetchOrbPriceInExalted(orbName: string): Promise<number | null> {
    const key = `price:${this.#league}:${orbName}`;
    const cached = this.#cache.get(key);
    if (cached) return cached.payload as number;

    const tradeBase = process.env['POE2_TRADE_SEARCH_URL'];
    if (!tradeBase) return null;

    try {
      const response = await this.#http.post<{ id: string }>(
        `${tradeBase}/${encodeURIComponent(this.#league)}`,
        {
          query: {
            status: { option: 'online' },
            type: orbName,
            stats: [{ type: 'and', filters: [] }],
          },
          sort: { price: 'asc' },
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

      if (!response.data?.id) return null;

      const fetchUrl = `${tradeBase.replace('/search/', '/fetch/')}/${response.data.id}`;
      const details = await this.#http.get<TradeFetchResponse>(fetchUrl);

      const first = details.data.result[0]?.listing.price?.amount;
      if (first === undefined) return null;

      const parsed = Number.parseFloat(first);
      const value = Number.isFinite(parsed) ? round4(parsed) : null;
      if (value !== null) {
        this.#cache.set(key, { key, payload: value, source: 'trade-api' });
      }
      return value;
    } catch {
      return null;
    }
  }

  /** URL base usada pelo fetchOrbPriceInExalted (usado no log de debug). */
  get league(): string {
    return this.#league;
  }

  get cacheDescription(): string {
    return this.#cache.describe();
  }

  /** Pré-carrega as classes usadas com mais frequencia pelo overlay. */
  async warmup(itemClasses: readonly ItemClass[]): Promise<void> {
    await Promise.all(itemClasses.map((itemClass) => this.getModsForItemClass(itemClass)));
  }

  /** Libera o cache em memoria (usado em testes). */
  reset(): void {
    this.#modIndex.clear();
    this.#cache.clearMemory();
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}