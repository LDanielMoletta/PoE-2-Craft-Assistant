import { createMemorySnapshotStore } from '../scraper/dataHydration.js';
import type { HydrationSnapshotStore } from '../scraper/dataHydration.js';

import { buildSeedDatabase } from './seedDatabase.js';

/**
 * Snapshot embutido no bundle do renderer.
 *
 * O renderer roda com `sandbox: true` e nao tem `node:fs`, entao ele nao le o
 * JSON do disco. O bundle carrega o mesmo catalogo seed por cima do mesmo
 * builder que gerou o arquivo, e `modsDbSnapshot.test.ts` garante que os dois
 * nao divirjam.
 *
 * A persistencia em disco da base revalidada passa por `ipcSnapshotStore.ts`.
 */

export const POE2_MODS_DB_FILENAME = 'poe2_mods_db.json';

export const BUNDLED_MODS_SNAPSHOT: unknown = buildSeedDatabase();

/** Store so com memoria: cobre a sessao, sem inventar `localStorage`. */
export function createBundledSnapshotStore(): HydrationSnapshotStore {
  return createMemorySnapshotStore(BUNDLED_MODS_SNAPSHOT);
}
