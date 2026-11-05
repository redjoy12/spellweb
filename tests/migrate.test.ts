import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, appliedMigrations } from '../src/db/migrate.js';

/** A database shaped like Phase 1 left it, with the OLD extraction_queue. */
function legacyDb(): DatabaseSync {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'mig-')), 'app.db'));
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE cards (oracle_id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE pool_diffs (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE extraction_queue (
      oracle_id      TEXT PRIMARY KEY REFERENCES cards(oracle_id),
      reason         TEXT NOT NULL CHECK (reason IN ('new_card','oracle_changed')),
      enqueued_at    TEXT NOT NULL,
      source_diff_id INTEGER REFERENCES pool_diffs(id),
      status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done'))
    );
  `);
  for (let i = 0; i < 50; i++) {
    db.prepare('INSERT INTO cards VALUES (?,?)').run('o' + i, 'card ' + i);
    db.prepare('INSERT INTO extraction_queue (oracle_id, reason, enqueued_at) VALUES (?,?,?)')
      .run('o' + i, i === 0 ? 'oracle_changed' : 'new_card', '2026-07-25T00:00:00Z');
  }
  return db;
}

describe('runMigrations', () => {
  it('preserves every extraction_queue row through the rebuild', () => {
    const db = legacyDb();
    const before = db.prepare('SELECT COUNT(*) n FROM extraction_queue').get() as { n: number };
    runMigrations(db);
    const after = db.prepare('SELECT COUNT(*) n FROM extraction_queue').get() as { n: number };
    expect(after.n).toBe(before.n);
    const reasons = db.prepare('SELECT reason, COUNT(*) n FROM extraction_queue GROUP BY reason').all();
    expect(reasons).toContainEqual({ reason: 'oracle_changed', n: 1 });
    expect(reasons).toContainEqual({ reason: 'new_card', n: 49 });
  });

  it('widens the reason CHECK so requeue paths work', () => {
    const db = legacyDb();
    runMigrations(db);
    // mark o0's prior request done so the partial unique index (one open request per card) doesn't block the INSERT we're testing
    db.exec("UPDATE extraction_queue SET status='done' WHERE oracle_id='o0'");
    expect(() =>
      db.prepare('INSERT INTO extraction_queue (oracle_id, reason, enqueued_at) VALUES (?,?,?)')
        .run('o0', 'kernel_changed', 't'),
    ).not.toThrow();
  });

  it('still rejects a reason outside the widened set', () => {
    const db = legacyDb();
    runMigrations(db);
    expect(() =>
      db.prepare('INSERT INTO extraction_queue (oracle_id, reason, enqueued_at) VALUES (?,?,?)')
        .run('o1', 'nonsense', 't'),
    ).toThrow();
  });

  it('allows queue history per card but only one open request', () => {
    const db = legacyDb();
    runMigrations(db);
    // mark o2's prior request done so the partial unique index (one open request per card)
    // allows a new pending INSERT; the 2nd pending insert is expected to throw
    db.exec("UPDATE extraction_queue SET status='done' WHERE oracle_id='o2'");
    expect(() =>
      db.prepare('INSERT INTO extraction_queue (oracle_id, reason, enqueued_at) VALUES (?,?,?)')
        .run('o2', 'kernel_changed', 't'),
    ).not.toThrow();
    expect(() =>
      db.prepare('INSERT INTO extraction_queue (oracle_id, reason, enqueued_at) VALUES (?,?,?)')
        .run('o2', 'splitter_changed', 't'),
    ).toThrow();
  });

  it('is idempotent — running twice changes nothing and applies nothing new', () => {
    const db = legacyDb();
    const first = runMigrations(db);
    const rows = db.prepare('SELECT COUNT(*) n FROM extraction_queue').get() as { n: number };
    const second = runMigrations(db);
    expect(second).toHaveLength(0);
    expect(appliedMigrations(db)).toEqual(first);
    expect((db.prepare('SELECT COUNT(*) n FROM extraction_queue').get() as { n: number }).n).toBe(rows.n);
  });

  it('leaves no foreign key violations behind', () => {
    const db = legacyDb();
    runMigrations(db);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves a legacy done row as done through the rebuild', () => {
    const db = legacyDb();
    // One row already completed extraction in Phase 1; it must survive the rebuild as done.
    db.exec("UPDATE extraction_queue SET status = 'done' WHERE oracle_id = 'o3'");
    runMigrations(db);
    const row = db.prepare("SELECT status, reason FROM extraction_queue WHERE oracle_id = 'o3'").get() as any;
    expect(row).toMatchObject({ status: 'done', reason: 'new_card' });
  });
});