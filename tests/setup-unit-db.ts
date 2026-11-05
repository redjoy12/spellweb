import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `npm test` only: each test file gets an empty database of its own, so a unit test never reads
// or writes data/app.db, and two test files never migrate the same file at the same time.
const dir = mkdtempSync(join(tmpdir(), 'unit-db-'));
process.env['APP_DB_PATH'] = join(dir, 'app.db');

// Remove the folder after the file. On Windows a database that a test did not close keeps its
// file locked, so a failed removal is not an error.
afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* still open */ }
});
