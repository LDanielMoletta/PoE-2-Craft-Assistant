import { afterEach, describe, expect, it, vi } from 'vitest';

import { BUNDLED_MODS_SNAPSHOT } from './modsDbSnapshot.js';
import { createRendererSnapshotStore } from './ipcSnapshotStore.js';

// O store do renderer tem tres camadas (disco, sessao, seed embutido) e e' o
// que decide se o overlay abre com alguma base depois de um boot sem rede.

interface FakeHost {
  readDataSnapshot: () => Promise<string | null>;
  writeDataSnapshot: (contents: string) => Promise<void>;
  written: string[];
}

function fakeHost(read: () => Promise<string | null>): FakeHost {
  const written: string[] = [];
  return {
    written,
    readDataSnapshot: read,
    writeDataSnapshot: async (contents) => {
      written.push(contents);
    },
  };
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'overlayHost');
});

/** Snapshot em disco como o main o entregaria: texto cru. */
function asFile(database: unknown): string {
  return JSON.stringify(database);
}

describe('createRendererSnapshotStore', () => {
  it('prefere o snapshot do disco, que e a ultima revalidacao boa', async () => {
    const live = { ...(BUNDLED_MODS_SNAPSHOT as object), version: 99 };
    (window as unknown as { overlayHost: unknown }).overlayHost = fakeHost(async () => asFile(live));

    const store = createRendererSnapshotStore();

    expect(await store.read()).toEqual(live);
  });

  it('cai no catalogo seed quando o disco esta vazio', async () => {
    (window as unknown as { overlayHost: unknown }).overlayHost = fakeHost(async () => null);

    const store = createRendererSnapshotStore();

    expect(await store.read()).toEqual(BUNDLED_MODS_SNAPSHOT);
  });

  it('cai no catalogo seed quando o JSON do disco esta truncado', async () => {
    (window as unknown as { overlayHost: unknown }).overlayHost = fakeHost(async () => '{"version": 3, "mo');

    const store = createRendererSnapshotStore();

    expect(await store.read()).toEqual(BUNDLED_MODS_SNAPSHOT);
  });

  it('cai no catalogo seed quando a leitura do disco lanca', async () => {
    (window as unknown as { overlayHost: unknown }).overlayHost = fakeHost(async () => {
      throw new Error('EACCES');
    });

    const store = createRendererSnapshotStore();

    expect(await store.read()).toEqual(BUNDLED_MODS_SNAPSHOT);
  });

  it('faz uma leitura so por sessao, em vez de pagar o IPC a cada chamada', async () => {
    const read = vi.fn(async () => asFile({ version: 1 }));
    (window as unknown as { overlayHost: unknown }).overlayHost = fakeHost(read);

    const store = createRendererSnapshotStore();
    await store.read();
    await store.read();
    await store.read();

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('depois de gravar, a sessao passa a devolver a base viva sem tocar o disco', async () => {
    const read = vi.fn(async () => null);
    const host = fakeHost(read);
    (window as unknown as { overlayHost: unknown }).overlayHost = host;

    const store = createRendererSnapshotStore();
    const live = {
      version: 42,
      league: 'Standard',
      updatedAt: '2026-01-10T00:00:00.000Z',
      modifiers: [],
      bases: [],
      currencies: [],
    };
    await store.write(live);

    expect(await store.read()).toEqual(live);
    // Sessao valida: o disco nao e' tocado de novo.
    expect(read).toHaveBeenCalledTimes(0);
    // A escrita vai para o disco: e' o que faz a revalidacao de hoje sobreviver
    // ao proximo boot.
    expect(JSON.parse(host.written[0] ?? 'null')).toEqual(live);
  });

  it('degrada para o catalogo seed sem o preload, em vez de quebrar', async () => {
    const store = createRendererSnapshotStore();

    expect(await store.read()).toEqual(BUNDLED_MODS_SNAPSHOT);
  });

  it('ignora um preload que nao tem a API de snapshot', async () => {
    (window as unknown as { overlayHost: unknown }).overlayHost = {};

    const store = createRendererSnapshotStore();

    expect(await store.read()).toEqual(BUNDLED_MODS_SNAPSHOT);
  });
});
