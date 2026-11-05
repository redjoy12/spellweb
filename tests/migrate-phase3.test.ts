import { describe, it, expect, beforeAll } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, DB_PATH } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

// Migration 4 rebuilds review_queue (spec sec. 10.1); migration 5 adds the sec. 10.2 tables.
// The test needs a database from BEFORE migration 4: the backup that Task 1 Step 2 takes,
// or the real database while it is still unmigrated. Both are copied: `npm test` never
// changes data/app.db.
const BACKUP = join(dirname(DB_PATH), 'app.pre-phase3.db');

function preMigrationSource(): string | null {
  for (const p of [BACKUP, DB_PATH]) {
    if (!existsSync(p)) continue;
    const raw = new DatabaseSync(p, { readOnly: true });
    try {
      const hasTable = raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
      const applied = hasTable && raw.prepare('SELECT 1 FROM schema_migrations WHERE id = 4').get();
      if (!applied) return p;
    } finally { raw.close(); }
  }
  return null;
}

const NEW_TABLES = [
  'edge_rule_sets', 'edge_type_roles', 'edge_rules', 'edge_rule_passes', 'edge_rule_pass_items',
  'edge_rule_rejections', 'edge_missing_rule_reports', 'ability_groups', 'graph_builds',
  'graph_build_atoms', 'card_degree', 'graph_gaps', 'edge_reports', 'edge_golden_pairs',
];

const source = preMigrationSource();
const maybe = source ? describe : describe.skip;

type Row = Record<string, unknown>;

maybe('migration 4 on a copy of the real database', () => {
  let db: DatabaseSync;
  let before: Row[];

  beforeAll(() => {
    const scratch = join(mkdtempSync(join(tmpdir(), 'migrate-p3-')), 'app.db');
    copyFileSync(source!, scratch);
    for (const ext of ['-wal', '-shm']) if (existsSync(source! + ext)) copyFileSync(source! + ext, scratch + ext);
    const raw = new DatabaseSync(scratch);
    before = raw.prepare('SELECT id, oracle_id, run_id, severity, detail_id, status FROM review_queue ORDER BY id').all() as Row[];
    raw.close();
    // The real path: schema.sql, then runMigrations (src/db/client.ts).
    db = openDb(scratch);
  });

  it('keeps every review_queue row and id', () => {
    const after = db.prepare('SELECT id, oracle_id, run_id, severity, detail_id, status, domain FROM review_queue ORDER BY id').all() as Row[];
    expect(after.map(({ domain, ...r }) => r)).toEqual(before);
    if (after.length > 0) expect(new Set(after.map((r) => r['domain']))).toEqual(new Set(['atom']));
  });

  it('creates every new table and the unique finding index', () => {
    const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as Array<{ name: string }>)
      .map((r) => r.name));
    for (const t of [...NEW_TABLES, 'review_queue_finding', 'idx_review_open']) expect(names.has(t), t).toBe(true);
  });

  it('a second runMigrations call does nothing', () => {
    expect(runMigrations(db)).toEqual([]);
  });
});

/** A fresh database with one rule set and one build, for the CHECK and index cases. */
function fresh(): { db: DatabaseSync; setId: number; buildId: number } {
  const db = openDb(':memory:');
  db.exec("INSERT INTO snapshots (source_type,source_uri,source_updated_at,ingested_at,status) VALUES ('t','u','t','t','complete')");
  db.exec("INSERT INTO rules_corpus (source_uri,effective_date,sha256,fetched_at,section_count,rule_count,glossary_count,is_current) VALUES ('u','d','s','t',1,1,1,1)");
  db.exec(`INSERT INTO extraction_runs (id, started_at, provider, model, schema_version, corpus_id, packet_policy_sha, splitter_version, batch_kind, status)
           VALUES (1, 't', 'p', 'm', 1, 1, 's', 1, 'golden', 'complete')`);
  db.exec(`INSERT INTO cards (oracle_id, name, layout, cmc, type_line, colors, color_identity, keywords, rarity, set_code, collector_number, oracle_hash, first_seen_snapshot_id, last_seen_snapshot_id)
           VALUES ('o', 'N', 'normal', 0, 't', '[]', '[]', '[]', 'common', 's', '1', 'h', 1, 1)`);
  const setId = Number(db.prepare(
    "INSERT INTO edge_rule_sets (version, schema_version, corpus_id, packet_sha, model, status, created_at) VALUES (1, 1, 1, 's', 'm', 'in_progress', 't')",
  ).run().lastInsertRowid);
  const buildId = Number(db.prepare(
    `INSERT INTO graph_builds (build_key, rule_set_id, schema_version, corpus_id, pool_snapshot_id, tests_version, atom_set_sha, scope, built_at, counts_json)
     VALUES ('k', ?, 1, 1, 1, 1, 'a', 'BR', 't', '{}')`,
  ).run(setId).lastInsertRowid);
  return { db, setId, buildId };
}

const INSERT = `INSERT INTO review_queue (domain, oracle_id, run_id, rule_set_id, build_id, severity, severity_rank, rank_score, detail_table, detail_id, enqueued_at)
                VALUES (?,?,?,?,?,?,1,0,'t',?, 't')`;

describe('review_queue shape after migration 4', () => {
  it('a fresh database has the new shape, the new tables and the unique finding index', () => {
    const { db } = fresh();
    const cols = (db.prepare('PRAGMA table_info(review_queue)').all() as Array<{ name: string; notnull: number }>);
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('domain')?.notnull).toBe(1);
    expect(byName.get('oracle_id')?.notnull).toBe(0);
    expect(byName.get('run_id')?.notnull).toBe(0);
    expect(byName.has('rule_set_id') && byName.has('build_id')).toBe(true);
    const names = new Set((db.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name));
    for (const t of [...NEW_TABLES, 'review_queue_finding']) expect(names.has(t), t).toBe(true);
  });

  it('refuses an atom row with a NULL oracle_id', () => {
    const { db } = fresh();
    expect(() => db.prepare(INSERT).run('atom', null, 1, null, null, 'coverage_miss', 1)).toThrow(/CHECK/);
  });

  it('refuses an edge row with an atom severity', () => {
    const { db, setId } = fresh();
    expect(() => db.prepare(INSERT).run('edge', null, null, setId, null, 'coverage_miss', 1)).toThrow(/CHECK/);
  });

  it('refuses an edge_report row with no build_id', () => {
    const { db, setId, buildId } = fresh();
    expect(() => db.prepare(INSERT).run('edge', null, null, setId, null, 'edge_report', 1)).toThrow(/CHECK/);
    expect(db.prepare(INSERT).run('edge', null, null, setId, buildId, 'edge_report', 1).changes).toBe(1);
  });

  it('two equal edge rows with NULL oracle_id and run_id give one row', () => {
    const { db, setId } = fresh();
    const ins = db.prepare(INSERT.replace("'t')", "'t') ON CONFLICT DO NOTHING"));
    expect(ins.run('edge', null, null, setId, null, 'edge_rule_disagreement', 7).changes).toBe(1);
    expect(ins.run('edge', null, null, setId, null, 'edge_rule_disagreement', 7).changes).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM review_queue WHERE domain = 'edge'").get() as { n: number }).n).toBe(1);
  });

  it('an atom row is still unique on (oracle_id, run_id, severity, detail_id)', () => {
    const { db } = fresh();
    const ins = db.prepare(INSERT.replace("'t')", "'t') ON CONFLICT DO NOTHING"));
    expect(ins.run('atom', 'o', 1, null, null, 'coverage_miss', 3).changes).toBe(1);
    expect(ins.run('atom', 'o', 1, null, null, 'coverage_miss', 3).changes).toBe(0);
  });
});

/** The review_queue table before migration 4 (schema.sql at Phase 2). */
const OLD_REVIEW_QUEUE = `
  CREATE TABLE review_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    oracle_id     TEXT    NOT NULL REFERENCES cards(oracle_id),
    run_id        INTEGER NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
    severity      TEXT    NOT NULL CHECK (severity IN
                     ('coverage_miss','missing_rule','vote_disagreement',
                      'unclassified','splitter_disagreement')),
    severity_rank INTEGER NOT NULL,
    rank_score    INTEGER NOT NULL,
    detail_table  TEXT,
    detail_id     INTEGER,
    status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
    enqueued_at   TEXT    NOT NULL,
    UNIQUE (oracle_id, run_id, severity, detail_id)
  );
  CREATE INDEX idx_review_open ON review_queue(status, severity_rank, rank_score DESC);
`;

/** A fresh database put back to the Phase 2 review_queue, with migration 4 not yet applied. */
function phase2Queue(rows: Array<{ id: number; severity: string; detail_id: number }>, deleteIds: number[] = []): DatabaseSync {
  const { db } = fresh();
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('DROP TABLE review_queue');
  db.exec(OLD_REVIEW_QUEUE);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('DELETE FROM schema_migrations WHERE id = 4');
  const ins = db.prepare(`INSERT INTO review_queue (id, oracle_id, run_id, severity, severity_rank, rank_score, detail_table, detail_id, enqueued_at)
                          VALUES (?, 'o', 1, ?, 1, 0, 't', ?, 't')`);
  for (const r of rows) ins.run(r.id, r.severity, r.detail_id);
  for (const id of deleteIds) db.prepare('DELETE FROM review_queue WHERE id = ?').run(id);
  return db;
}

const seqOf = (db: DatabaseSync) =>
  (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'review_queue'").get() as { seq: number } | undefined)?.seq;

describe('migration 4 on an in-memory Phase 2 review_queue', () => {
  it('keeps every row, its id and the sequence, and gives the new shape', () => {
    const db = phase2Queue([
      { id: 3, severity: 'coverage_miss', detail_id: 1 },
      { id: 7, severity: 'missing_rule', detail_id: 2 },
      { id: 12, severity: 'unclassified', detail_id: 3 },
    ], [12]);
    const before = db.prepare('SELECT id, oracle_id, run_id, severity, detail_id, status FROM review_queue ORDER BY id').all();
    expect(seqOf(db)).toBe(12);
    expect(runMigrations(db)).toEqual([4]);
    const after = db.prepare('SELECT id, oracle_id, run_id, severity, detail_id, status, domain FROM review_queue ORDER BY id').all() as Row[];
    expect(after.map(({ domain, ...r }) => r)).toEqual(before);
    expect(after.every((r) => r['domain'] === 'atom')).toBe(true);
    expect(seqOf(db)).toBe(12);
    const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name));
    expect(names.has('review_queue_finding') && names.has('idx_review_open')).toBe(true);
    // The new CHECK holds: an atom row needs an oracle_id.
    expect(() => db.prepare(INSERT).run('atom', null, 1, null, null, 'coverage_miss', 9)).toThrow(/CHECK/);
    expect(runMigrations(db)).toEqual([]);
  });

  it('keeps the sequence of an empty table, so no deleted id comes back', () => {
    const db = phase2Queue([{ id: 5, severity: 'coverage_miss', detail_id: 1 }], [5]);
    expect(seqOf(db)).toBe(5);
    runMigrations(db);
    expect(seqOf(db)).toBe(5);
    const id = Number(db.prepare(INSERT).run('atom', 'o', 1, null, null, 'coverage_miss', 1).lastInsertRowid);
    expect(id).toBe(6);
  });
});

describe('migration 10: the atom-set part of the ability-group key (plan Task 8)', () => {
  it("keeps each old row with atom_sha '', and a second atom set can add rows with the same old key", () => {
    const file = join(mkdtempSync(join(tmpdir(), 'migrate-10-')), 'app.db');
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE ability_groups (
      oracle_id TEXT NOT NULL, face_index INTEGER NOT NULL, group_index INTEGER NOT NULL, span_start INTEGER NOT NULL,
      span_end INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('triggered','activated','other')), cost_json TEXT,
      cost_unparsed INTEGER NOT NULL DEFAULT 0, per_turn_limit INTEGER NOT NULL DEFAULT 0, unknown_limit INTEGER NOT NULL DEFAULT 0,
      oracle_hash TEXT NOT NULL, tests_version INTEGER NOT NULL,
      PRIMARY KEY (oracle_id, face_index, oracle_hash, tests_version, group_index))`);
    raw.exec(`INSERT INTO ability_groups (oracle_id, face_index, group_index, span_start, span_end, kind, oracle_hash, tests_version)
              VALUES ('o', 0, 0, 0, 5, 'other', 'h', 1)`);
    raw.close();
    const db = openDb(file);
    expect(db.prepare('SELECT oracle_id, group_index, kind, atom_sha FROM ability_groups').all())
      .toEqual([{ oracle_id: 'o', group_index: 0, kind: 'other', atom_sha: '' }]);
    db.exec(`INSERT INTO ability_groups (oracle_id, face_index, group_index, span_start, span_end, kind, oracle_hash, tests_version, atom_sha)
             VALUES ('o', 0, 0, 0, 5, 'activated', 'h', 1, 'x')`);
    expect(db.prepare('SELECT COUNT(*) n FROM ability_groups').get()).toEqual({ n: 2 });
    expect(runMigrations(db)).toEqual([]);
  });
});
