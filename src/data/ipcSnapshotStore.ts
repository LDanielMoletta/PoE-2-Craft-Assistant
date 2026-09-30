import type { HydrationSnapshotStore, ModsDatabaseInput } from '../scraper/dataHydration.js';
import { electronBridge, isElectronAvailable } from '../lib/electronBridge.js';

import { createBundledSnapshotStore } from './modsDbSnapshot.js';

/**
 * Store do snapshot para o renderer.
 *
 * O disco so existe do outro lado do IPC, e o trafego e' texto cru nas duas
 * pontas — como o `config.json` — para que a fronteira de confianca seja uma so:
 * quem valida o payload continua sendo o renderer, e o main so move bytes.
 *
 * Tres camadas: o que veio do disco no boot (a ultima revalidacao boa, que e'
 * o que sobrevive a um boot sem rede), o que foi revalidado nesta sessao, e o
 * catalogo seed embutido, que garante que o overlay sempre abre com alguma base.
 *
 * Sem `window.overlayHost` (dev no browser, harness de teste) sobram so as duas
 * ultimas: o overlay abre igual, so sem persistencia.
 */
export function createRendererSnapshotStore(): HydrationSnapshotStore {
  const bundled = createBundledSnapshotStore();
  if (!isElectronAvailable()) {
    return bundled;
  }
  let session: unknown | null = null;
  let loaded: Promise<unknown | null> | null = null;

  return {
    async read() {
      if (session !== null) return session;
      // Disco ausente, ilegivel ou JSON truncado: mesmo caso de um cache
      // corrompido, e a hidratacao cai para a camada de baixo. A leitura e o
      // parse ficam no mesmo try porque o `JSON.parse` falha depois do IPC ter
      // resolvido com sucesso.
      loaded ??= electronBridge.readDataSnapshot()
        .then((contents) =>
          contents === null || contents === undefined ? null : (JSON.parse(contents) as unknown),
        )
        .catch(() => null);
      return (await loaded) ?? (await bundled.read());
    },
    async write(snapshot: ModsDatabaseInput) {
      session = snapshot;
      await electronBridge.writeDataSnapshot(JSON.stringify(snapshot));
    },
  };
}
