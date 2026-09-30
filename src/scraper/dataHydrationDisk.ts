import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { HydrationSnapshotStore, ModsDatabaseInput } from './dataHydration.js';
import { POE2_MODS_DB_FILENAME } from '../data/modsDbSnapshot.js';

/**
 * Store do snapshot em disco, so para quem roda em Node (CLI e testes).
 *
 * O renderer usa `createBundledSnapshotStore()` porque nao tem `node:fs`. Aqui
 * o snapshot vira de verdade `src/data/poe2_mods_db.json`, e uma revalidacao
 * bem-sucedida sobrevive ao proximo boot mesmo sem rede.
 *
 * Este arquivo NAO pode ser importado pelo bundle da UI: e' a razao de existir
 * separado de `dataHydration.ts`.
 */
export function createFileSnapshotStore(filePath: string): HydrationSnapshotStore & {
  path(): string;
} {
  return {
    path: () => filePath,
    async read() {
      let contents: string;
      try {
        contents = readFileSync(filePath, 'utf8');
      } catch (thrown) {
        // Snapshot ausente e' o estado inicial, nao um erro de hidratacao.
        if (thrown && (thrown as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw thrown;
      }
      return JSON.parse(contents) as unknown;
    },
    async write(snapshot: ModsDatabaseInput) {
      mkdirSync(dirname(filePath), { recursive: true });
      // Snapshot novo e' bem maior que a base live; escrever direto seria
      // suficiente (nao e config, e' cache), entao nao ha rename atomico aqui.
      writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    },
  };
}

/** Caminho padrao do snapshot dentro de um diretorio de projeto. */
export function defaultSnapshotPath(projectRoot: string): string {
  return `${projectRoot.replace(/[\\/]+$/, '')}/src/data/${POE2_MODS_DB_FILENAME}`;
}
