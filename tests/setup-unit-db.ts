import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `npm test` only: each test file gets an empty database of its own, so a unit test never reads
// or writes data/app.db, and two test files never migrate the same file at the same time.
process.env['APP_DB_PATH'] = join(mkdtempSync(join(tmpdir(), 'unit-db-')), 'app.db');
