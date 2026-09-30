import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateModsDatabase } from '../scraper/dataHydration.js';

import { BUNDLED_MODS_SNAPSHOT, POE2_MODS_DB_FILENAME } from './modsDbSnapshot.js';
import { buildSeedDatabase } from './seedDatabase.js';

/**
 * Divergencia entre o JSON em disco e o objeto embutido tem custo silencioso:
 * o arquivo e' o que um usuario inspeciona, e o objeto e' o que o overlay usa. Se
 * os dois sairem do passo, o JSON deixa de ser referencia e vira decoracao.
 *
 * O caminho e' resolvido a partir deste arquivo, e nao do `process.cwd()`: um
 * teste nao pode passar so porque alguem rodou o vitest da raiz.
 */
const here = dirname(fileURLToPath(import.meta.url));
const snapshotPath = join(here, POE2_MODS_DB_FILENAME);

function readSnapshotFile(): unknown {
  return JSON.parse(readFileSync(snapshotPath, 'utf8')) as unknown;
}

describe('poe2_mods_db.json', () => {
  it('existe no disco', () => {
    expect(() => readFileSync(snapshotPath, 'utf8')).not.toThrow();
  });

  it('e identico ao snapshot embutido no bundle', () => {
    expect(readSnapshotFile()).toEqual(BUNDLED_MODS_SNAPSHOT);
  });

  it('e identico ao catalogo seed, que e a unica fonte de geracao', () => {
    expect(readSnapshotFile()).toEqual(buildSeedDatabase());
  });

  it('passa pelo mesmo validador da fonte externa', () => {
    const result = validateModsDatabase(readSnapshotFile());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.database.modifiers.length).toBeGreaterThan(0);
    expect(result.database.bases.length).toBeGreaterThan(0);
    expect(result.database.currencies.length).toBeGreaterThan(0);
  });

  it('esta em ordem de insercao, para o diff do arquivo ser legivel', () => {
    expect(readFileSync(snapshotPath, 'utf8')).toMatch(/\n {2}"version"/);
  });

  it('nao carrega campo derivado, para continuar re-ingerivel', () => {
    // `maxTier` e' calculado na normalizacao; no arquivo, o schema estrito
    // recusaria o proprio snapshot no boot seguinte.
    const raw = readSnapshotFile() as { modifiers?: Record<string, unknown>[] };
    for (const modifier of raw.modifiers ?? []) {
      expect(Object.keys(modifier)).not.toContain('maxTier');
    }
  });
});
