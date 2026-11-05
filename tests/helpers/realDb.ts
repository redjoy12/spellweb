/**
 * The real `data/app.db`, opened read-only for the Phase 3 tests that need real slice and CR
 * data (plan "Test database rule"). Read-only, and without `openDb`: no schema or migration
 * runs, so these suites can never change the database. `db` is null when the file or its
 * current corpus is absent; put `maybe` on the `describe`.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe } from 'vitest';
import { DB_PATH } from '../../src/db/client.js';

function open(): { db: DatabaseSync; corpusId: number } | null {
  if (!existsSync(DB_PATH)) return null;
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const row = db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as { id: number } | undefined;
  const golden = row ? (db.prepare('SELECT COUNT(*) n FROM golden_atoms').get() as { n: number }).n : 0;
  if (!row || golden === 0) { db.close(); return null; }
  return { db, corpusId: row.id };
}

const real = open();
export const realDb = real?.db as DatabaseSync;
export const realCorpusId = real?.corpusId as number;
export const maybe = real ? describe : describe.skip;
