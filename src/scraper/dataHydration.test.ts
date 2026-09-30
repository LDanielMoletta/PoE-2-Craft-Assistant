import { describe, expect, it, vi } from 'vitest';

import { buildSeedDatabase } from '../data/seedDatabase.js';
import {
  DataHydrationService,
  HYDRATION_TTL_MS,
  ModsIndex,
  createMemorySnapshotStore,
  describeDataStatus,
  validateModsDatabase,
  type HydrationMod,
  type ModsDatabaseInput,
} from './dataHydration.js';

/** Payload minimo valido, para isolar o que cada teste esta exercitando. */
function payload(overrides: Partial<ModsDatabaseInput> = {}): ModsDatabaseInput {
  return {
    version: 3,
    league: 'Standard',
    updatedAt: '2026-01-10T00:00:00.000Z',
    modifiers: [
      {
        id: 'flat-fire-damage#prefix#t1',
        name: 'Flat Fire Damage',
        slot: 'prefix',
        tier: 1,
        text: 'Flat Fire Damage to Attacks',
        value: 15,
        requiredItemLevel: 25,
        weight: 100,
        itemClasses: ['sword'],
        tags: ['fire'],
      },
      {
        id: 'flat-fire-damage#prefix#t2',
        name: 'Flat Fire Damage',
        slot: 'prefix',
        tier: 2,
        text: 'Flat Fire Damage to Attacks',
        value: 28,
        requiredItemLevel: 45,
        weight: 100,
        itemClasses: ['sword'],
        tags: ['fire'],
      },
    ],
    bases: [
      {
        id: 'base:sword',
        name: 'Sword',
        itemClass: 'sword',
        maxPrefixes: 3,
        maxSuffixes: 3,
        baseNames: ['Rusted Sword', 'Vaal Blade'],
      },
    ],
    currencies: [
      {
        id: 'currency:chaos-orb',
        name: 'Chaos Orb',
        kind: 'random-affix',
        appliesToEmptySlot: true,
        overwritesExisting: true,
        costInExalted: 0.5,
        slotFilter: ['prefix', 'suffix'],
        improvesTier: false,
        removesPerUse: 0,
        description: 'Rola um modificador aleatorio.',
      },
    ],
    ...overrides,
  };
}

const NOW = Date.parse('2026-01-10T06:00:00.000Z');
const UPDATED_AT = Date.parse('2026-01-10T00:00:00.000Z');

function indexOf(raw: unknown): ModsIndex {
  const result = validateModsDatabase(raw);
  if (!result.ok) throw new Error(`payload de teste invalido: ${result.issues.join('; ')}`);
  return new ModsIndex(result.database);
}

describe('validateModsDatabase', () => {
  it('aceita um payload bem formado e deriva maxTier por familia', () => {
    const result = validateModsDatabase(payload());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.database.version).toBe(3);
    // maxTier vem do conjunto, nunca da fonte: e' a escala que o calculo de
    // tier esperado do orbe usa, e um valor errado distorce toda a chance.
    expect(result.database.modifiers.map((mod) => mod.maxTier)).toEqual([2, 2]);
  });

  it('rejeita mod sem itemClasses, que nunca entraria na pool de um item', () => {
    const broken = payload();
    const first = broken.modifiers[0] as HydrationMod & { itemClasses: readonly string[] };
    first.itemClasses = [];

    const result = validateModsDatabase(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toMatch(/itemClasses/);
  });

  it('rejeita peso zero, que zeraria a chance do mod sem explicar o motivo', () => {
    const broken = payload();
    (broken.modifiers[0] as { weight: number }).weight = 0;

    expect(validateModsDatabase(broken).ok).toBe(false);
  });

  it('rejeita campo desconhecido em um mod, em vez de aceitar pela metade', () => {
    const broken = payload();
    (broken.modifiers[0] as Record<string, unknown>).tierWeight = 3;

    const result = validateModsDatabase(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toMatch(/tierWeight|unrecognized/i);
  });

  it('rejeita id duplicado, que faria um registro sobrescrever o outro em silencio', () => {
    const broken = payload();
    (broken.modifiers[1] as { id: string }).id = broken.modifiers[0]?.id ?? '';

    const result = validateModsDatabase(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toMatch(/duplicado/);
  });

  it('rejeita mod que aponta para uma classe sem base cadastrada', () => {
    const broken = payload();
    const first = broken.modifiers[0] as HydrationMod & { itemClasses: readonly string[] };
    first.itemClasses = ['jewel'];

    const result = validateModsDatabase(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toMatch(/jewel/);
  });

  it('rejeita base com classe de item inexistente', () => {
    const broken = payload();
    (broken.bases[0] as { itemClass: string }).itemClass = 'spaceship';

    expect(validateModsDatabase(broken).ok).toBe(false);
  });

  it('rejeita colecoes vazias, que produziriam um agente sem nada para calcular', () => {
    expect(validateModsDatabase(payload({ modifiers: [] })).ok).toBe(false);
    expect(validateModsDatabase(payload({ bases: [] })).ok).toBe(false);
    expect(validateModsDatabase(payload({ currencies: [] })).ok).toBe(false);
  });

  it('aceita updatedAt em epoch ms e canonicaliza para ISO', () => {
    const result = validateModsDatabase(payload({ updatedAt: UPDATED_AT }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.database.updatedAt).toBe('2026-01-10T00:00:00.000Z');
  });

  it('nao lanca com entrada que nao e objeto', () => {
    for (const garbage of [null, undefined, 42, 'mods', []]) {
      expect(validateModsDatabase(garbage).ok).toBe(false);
    }
  });
});

describe('ModsIndex', () => {
  const index = indexOf(payload());

  it('filtra mods por classe de item', () => {
    expect(index.modsForItemClass('sword')).toHaveLength(2);
    expect(index.modsForItemClass('claw')).toHaveLength(0);
  });

  it('agrupa a familia de tiers em ordem crescente', () => {
    const family = index.familyByName('Flat Fire Damage');
    expect(family.map((mod) => mod.tier)).toEqual([1, 2]);
    // Uma familia so aparece em uma classe aqui; o filtro e por classe, e a
    // familia e o mesmo modificador com todos os tiers.
    expect(index.stats.families).toBe(1);
  });

  it('acha a base com o orcamento de slots', () => {
    const base = index.baseForItemClass('sword');
    expect(base?.maxPrefixes).toBe(3);
    expect(base?.maxSuffixes).toBe(3);
    expect(base?.baseNames).toEqual(['Rusted Sword', 'Vaal Blade']);
    expect(index.baseForItemClass('claw')).toBeNull();
  });

  it('acha a moeda ignorando caixa e espacos', () => {
    expect(index.currencyByName('chaos orb')?.costInExalted).toBe(0.5);
    expect(index.currencyByName('CHAOS ORB')?.overwritesExisting).toBe(true);
    expect(index.currencyByName('Regal Orb')).toBeNull();
  });

  it('reporta as contagens para o diagnostico da UI', () => {
    expect(index.stats).toEqual({ modifiers: 2, families: 1, bases: 1, currencies: 1 });
    expect(index.league).toBe('Standard');
    expect(index.version).toBe(3);
  });
});

describe('DataHydrationService', () => {
  it('usa a fonte externa quando ela responde com payload valido', async () => {
    const service = new DataHydrationService({
      store: createMemorySnapshotStore(payload({ version: 1 })),
      fetchRemote: async () => payload(),
      now: () => NOW,
    });

    const status = await service.hydrate();

    expect(status.state).toBe('live');
    expect(status.version).toBe(3);
    expect(status.detail).toMatch(/Fonte externa/);
  });

  it('cai no snapshot quando a rede falha, e diz o motivo', async () => {
    const service = new DataHydrationService({
      store: createMemorySnapshotStore(payload()),
      fetchRemote: async () => {
        throw new Error('ECONNREFUSED');
      },
      now: () => NOW,
    });

    const status = await service.hydrate();

    expect(status.state).toBe('snapshot');
    expect(status.detail).toMatch(/ECONNREFUSED/);
  });

  it('cai no snapshot quando a fonte responde, mas com payload invalido', async () => {
    const service = new DataHydrationService({
      store: createMemorySnapshotStore(payload()),
      fetchRemote: async () => ({ league: 'Standard', modifiers: 'isto devia ser um array' }),
      now: () => NOW,
    });

    const status = await service.hydrate();

    expect(status.state).toBe('snapshot');
    expect(status.detail).toMatch(/payload invalido/);
  });

  it('marca como stale quando o snapshot local passou do TTL + grace period (14 dias)', async () => {
    const service = new DataHydrationService({
      store: createMemorySnapshotStore(payload({ updatedAt: '2026-01-01T00:00:00.000Z' })),
      now: () => NOW,
    });

    const status = await service.hydrate();

    expect(HYDRATION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    // Com grace period de 1x TTL, stale so depois de 14 dias
    expect(status.state).toBe('snapshot');
    expect(status.ageMs).toBeGreaterThan(HYDRATION_TTL_MS);

    // Avançar para 15 dias: deve ficar stale
    const future = new DataHydrationService({
      store: createMemorySnapshotStore(payload({ updatedAt: '2026-01-01T00:00:00.000Z' })),
      now: () => NOW + 15 * 24 * 60 * 60 * 1000,
    });
    const futureStatus = await future.hydrate();
    expect(futureStatus.state).toBe('stale');
  });

  it('persiste a base viva para o proximo boot', async () => {
    const store = createMemorySnapshotStore();
    const service = new DataHydrationService({ store, fetchRemote: async () => payload(), now: () => NOW });

    await service.hydrate();

    const written = validateModsDatabase(store.peek());
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.database.version).toBe(3);
  });

  it('mantem a base viva em memoria quando a revalidacao falha e nao ha snapshot', async () => {
    let remote: () => Promise<unknown> = async () => payload();
    let snapshot: unknown = null;

    const service = new DataHydrationService({
      store: { read: async () => snapshot, write: async () => {} },
      fetchRemote: () => remote(),
      now: () => NOW,
    });

    await service.hydrate();
    expect(service.state).toBe('live');

    // Snapshot apagado e rede fora: o caso em que o overlay ficaria mudo se a
    // base valida em memoria fosse descartada junto com a tentativa de revalidar.
    remote = async () => {
      throw new Error('offline');
    };
    const status = await service.hydrate({ force: true });

    expect(status.state).toBe('stale');
    expect(status.version).toBe(3);
    expect(service.index?.modsForItemClass('sword')).toHaveLength(2);
    expect(status.detail).toMatch(/Mantendo a base em memoria/);
  });

  it('sobra vazio e sem lancar quando nao ha fonte nem snapshot', async () => {
    const service = new DataHydrationService({
      store: createMemorySnapshotStore(),
      fetchRemote: async () => {
        throw new Error('sem rede');
      },
      now: () => NOW,
    });

    const status = await service.hydrate();

    expect(status.state).toBe('empty');
    expect(status.version).toBeNull();
    expect(service.index).toBeNull();
  });

  it('ignora snapshot corrompido em vez de derrubar a hidratacao', async () => {
    const service = new DataHydrationService({
      store: createMemorySnapshotStore({ version: 1, league: 'x' }),
      now: () => NOW,
    });

    expect((await service.hydrate()).state).toBe('empty');
  });

  it('nao perde a base valida quando gravar o snapshot falha', async () => {
    const service = new DataHydrationService({
      store: {
        read: async () => null,
        // A escrita e' fire-and-forget: a rejeicao tem de ser engolida dentro
        // do servico, e nao escapar como unhandled rejection.
        write: () => Promise.reject(new Error('disco cheio')),
      },
      fetchRemote: async () => payload(),
      now: () => NOW,
    });

    expect((await service.hydrate()).state).toBe('live');
    expect(service.index).not.toBeNull();
    // Deixa a escrita orfa rejecting: um unhandled rejection derrubaria o app
    // inteiro por causa de um cache.
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it('nao reconsulta a rede dentro do TTL', async () => {
    const fetchRemote = vi.fn(async () => payload());
    const service = new DataHydrationService({
      store: createMemorySnapshotStore(),
      fetchRemote,
      now: () => NOW,
    });

    await service.hydrate();
    await service.hydrate();
    await service.hydrate();

    expect(fetchRemote).toHaveBeenCalledTimes(1);
  });

  it('revalida assim que o TTL de 24h vence', async () => {
    const fetchRemote = vi.fn(async () => payload());
    let clock = NOW;
    const service = new DataHydrationService({
      store: createMemorySnapshotStore(),
      fetchRemote,
      now: () => clock,
    });

    await service.hydrate();
    // A base foi escrita 6h antes de `clock`: ainda esta dentro dos 7 dias.
    expect(service.needsRevalidation()).toBe(false);

    // 4 dias depois: idade de 4d 6h, ainda dentro da janela.
    clock = NOW + 4 * 24 * 60 * 60 * 1000;
    expect(service.needsRevalidation()).toBe(false);
    await service.hydrate();
    expect(fetchRemote).toHaveBeenCalledTimes(1);

    // Passados 7 dias desde a escrita: revalida.
    clock = NOW + 8 * 24 * 60 * 60 * 1000;
    expect(service.needsRevalidation()).toBe(true);
    await service.hydrate();
    expect(fetchRemote).toHaveBeenCalledTimes(2);
  });

  it('forcar a revalidacao ignora a base valida em memoria', async () => {
    const fetchRemote = vi.fn(async () => payload());
    const service = new DataHydrationService({
      store: createMemorySnapshotStore(),
      fetchRemote,
      now: () => NOW,
    });

    await service.hydrate();
    await service.hydrate({ force: true });

    expect(fetchRemote).toHaveBeenCalledTimes(2);
  });

  it('compartilha a mesma promessa entre chamadas concorrentes', async () => {
    const fetchRemote = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return payload();
    });
    const service = new DataHydrationService({
      store: createMemorySnapshotStore(),
      fetchRemote,
      now: () => NOW,
    });

    const [a, b] = await Promise.all([service.hydrate(), service.hydrate()]);

    // Duas hidratacoes simultaneas seriam duas buscas na wiki pelo mesmo dado.
    expect(fetchRemote).toHaveBeenCalledTimes(1);
    expect(a.version).toBe(b.version);
  });
});

describe('describeDataStatus', () => {
  const base = {
    league: 'Standard',
    version: 3,
    updatedAt: '2026-01-10T00:00:00.000Z',
    ageMs: 1_000,
    ttlMs: HYDRATION_TTL_MS,
    modifiers: 53,
    bases: 20,
    currencies: 10,
    detail: 'x',
  } as const;

  it('mostra a versao quando a base veio da rede', () => {
    expect(describeDataStatus({ ...base, state: 'live' }).text).toBe('Base de Modificadores: atualizada v3.00');
  });

  it('avisa que a base local esta desatualizada', () => {
    const label = describeDataStatus({ ...base, state: 'stale' });
    expect(label.tone).toBe('warn');
    expect(label.text).toMatch(/desatualizada/);
  });

  it('trata base vazia como erro, nao como estado silencioso', () => {
    const label = describeDataStatus({
      ...base,
      state: 'empty',
      league: null,
      version: null,
      updatedAt: null,
      ageMs: null,
      modifiers: 0,
      bases: 0,
      currencies: 0,
    });
    expect(label.tone).toBe('error');
    expect(label.text).toMatch(/indispon/);
  });
});

describe('catalogo seed', () => {
  it('passa no mesmo validador usado para a fonte externa', () => {
    const result = validateModsDatabase(buildSeedDatabase());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.database.modifiers.length).toBeGreaterThan(0);
    expect(result.database.bases.length).toBeGreaterThan(0);
    expect(result.database.currencies.length).toBeGreaterThan(0);
  });
});
