import { validateModsDatabase } from '../scraper/dataHydration.js';
import type { RemoteSource } from '../scraper/dataHydration.js';

/**
 * Fonte externa de dados de craft.
 *
 * Nao ha um endpoint publico, estavel e com CORS liberado que valha assumir, e
 * uma URL errada alimenta a base de chances com dados de outro jogo ou de outra
 * league — o jogador so ve o numero mudando. Por isso a lista vem de fora:
 * `POE2_MODS_SOURCES`, separada por virgula.
 *
 *   cross-env POE2_MODS_SOURCES=https://exemplo.org/poe2/mods.json pnpm dev:overlay
 *
 * Sem endpoint a hydration cai no snapshot local, que e' o comportamento
 * desejado, nao um modo de falha.
 */

const ENV_SOURCES = 'POE2_MODS_SOURCES';

export interface CommunitySourceOptions {
  /** Endpoints tentados em ordem. O primeiro payload valido vence. */
  readonly endpoints?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly league?: string;
}

export function communityEndpointsFromEnv(env: unknown = readEnv()): readonly string[] {
  if (env === null || typeof env !== 'object') return [];
  const raw = (env as Record<string, unknown>)[ENV_SOURCES];
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readEnv(): unknown {
  const vite = (import.meta as unknown as { env?: Record<string, string> }).env;
  if (vite !== undefined) return vite;
  return typeof process === 'undefined' ? null : process.env;
}

/**
 * Tenta cada endpoint e devolve o primeiro payload que passa no schema: um
 * endpoint quebrado no meio da lista nao pode derrubar a hidratacao quando o
 * seguinte esta bom.
 *
 * Lanca quando todos falham — o servico trata como "revalidacao falhou" e usa
 * o snapshot, que e' o que deve acontecer offline.
 */
export function createCommunitySource(options: CommunitySourceOptions = {}): RemoteSource {
  const endpoints = options.endpoints ?? communityEndpointsFromEnv();
  const timeoutMs = options.timeoutMs ?? 10_000;

  return async (): Promise<unknown> => {
    if (endpoints.length === 0) {
      throw new Error(`Nenhuma fonte externa configurada (defina ${ENV_SOURCES}).`);
    }

    const failures: string[] = [];
    for (const endpoint of endpoints) {
      try {
        const payload = await fetchJson(endpoint, options.fetchImpl, timeoutMs);
        const validated = validateModsDatabase(payload);
        if (validated.ok) return payload;
        failures.push(`${endpoint}: ${validated.issues.slice(0, 2).join('; ')}`);
      } catch (error) {
        failures.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(failures.join(' | '));
  };
}

async function fetchJson(
  endpoint: string,
  fetchImpl: typeof fetch | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('fetch indisponivel neste ambiente.');
  }

  // Sem timeout, uma fonte que aceita a conexao e nunca responde trava a
  // hidratacao inteira e, com ela, o primeiro item do jogador.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await doFetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}
