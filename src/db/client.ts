import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrate.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(here, 'schema.sql');

/** APP_DB_PATH points the CLIs at another file, for example a copy for an experiment. */
export const DB_PATH = process.env['APP_DB_PATH'] ? resolve(process.env['APP_DB_PATH']) : resolve(here, '../../data/app.db');

/** Opens the database, applies the schema, then runs any pending migrations. Safe to call repeatedly. */
export function openDb(path: string = DB_PATH): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    // Concurrent tests share the on-disk DB; wait for the write lock rather than erroring.
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    runMigrations(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
