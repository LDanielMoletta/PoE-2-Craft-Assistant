/**
 * Gera `src/data/poe2_mods_db.json` a partir do catalogo seed do repo.
 *
 *   pnpm tsx scripts/buildModsSnapshot.ts
 *
 * O JSON e' o artefato versionado: e' ele que o Node carrega em runtime e o que
 * um jogador pode editar a mao. Como deriva do mesmo builder que o renderer
 * embute no bundle, `src/data/modsDbSnapshot.test.ts` falha se divergirem.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { POE2_MODS_DB_FILENAME } from '../src/data/modsDbSnapshot.js';
import { buildSeedDatabase } from '../src/data/seedDatabase.js';
import { validateModsDatabase } from '../src/scraper/dataHydration.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '..', 'src', 'data', POE2_MODS_DB_FILENAME);

// Validar antes de gravar evita publicar um snapshot que o proprio runtime
// rejeitaria — o pior tipo de bug, porque so apareceria no boot do jogador.
const raw = buildSeedDatabase();
const result = validateModsDatabase(raw);
if (!result.ok) {
  console.error('Snapshot seed invalido:');
  for (const issue of result.issues) console.error(`  - ${issue}`);
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

const stats = {
  modifiers: result.database.modifiers.length,
  bases: result.database.bases.length,
  currencies: result.database.currencies.length,
};
console.log(`${POE2_MODS_DB_FILENAME} <- ${stats.modifiers} mods, ${stats.bases} bases, ${stats.currencies} moedas`);
