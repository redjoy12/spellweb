import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/client.js';
import { diffSnapshots, applyDiff } from '../src/pool/diff.js';
import type { DatabaseSync } from 'node:sqlite';

/** Creates a complete snapshot holding the given (oracle_id, hash) pairs. */
function makeSnapshot(db: DatabaseSync, cards: Array<[string, string]>): number {
  db.prepare(
    `INSERT INTO snapshots (source_type, source_uri, source_updated_at, ingested_at, status)
     VALUES ('default_cards','u','t',datetime('now'),'complete')`,
  ).run();
  const { id } = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
  for (const [oid, hash] of cards) {
    db.prepare(
      `INSERT INTO snapshot_cards (snapshot_id, oracle_id, name, layout, cmc, type_line,
         colors, color_identity, keywords, rarity, set_code, collector_number,
         faces_json, oracle_hash)
       VALUES (?,?,?,'normal',1,'Creature','[]','[]','[]','common','aaa','1',
         '[{"face_index":0,"name":"C","mana_cost":null,"type_line":"Creature","oracle_text":"t","power":null,"toughness":null,"colors":[],"image_normal":null}]', ?)`,
    ).run(id, oid, `Card ${oid}`, hash);
  }
  return id;
}

describe('diffSnapshots', () => {
  it('reports every card as added when there is no previous snapshot', () => {
    const db = openDb(':memory:');
    const s1 = makeSnapshot(db, [['o1', 'h1'], ['o2', 'h2']]);
    const d = diffSnapshots(db, null, s1);
    expect(d).toHaveLength(2);
    expect(d.every((e) => e.change === 'added')).toBe(true);
  });

  it('classifies added, oracle_changed, and rotated', () => {
    const db = openDb(':memory:');
    const s1 = makeSnapshot(db, [['keep', 'h1'], ['errata', 'old'], ['gone', 'h3']]);
    const s2 = makeSnapshot(db, [['keep', 'h1'], ['errata', 'new'], ['fresh', 'h4']]);
    const byId = Object.fromEntries(diffSnapshots(db, s1, s2).map((e) => [e.oracle_id, e]));
    expect(byId['keep']).toBeUndefined();          // unchanged cards are not diff entries
    expect(byId['errata']!.change).toBe('oracle_changed');
    expect(byId['errata']!.old_oracle_hash).toBe('old');
    expect(byId['errata']!.new_oracle_hash).toBe('new');
    expect(byId['gone']!.change).toBe('rotated');
    expect(byId['fresh']!.change).toBe('added');
  });

  it('marks a previously rotated card that reappears as returned', () => {
    const db = openDb(':memory:');
    const s1 = makeSnapshot(db, [['o1', 'h1']]);
    applyDiff(db, { fromSnapshotId: null, toSnapshotId: s1, entries: diffSnapshots(db, null, s1) });
    const s2 = makeSnapshot(db, []);
    applyDiff(db, { fromSnapshotId: s1, toSnapshotId: s2, entries: diffSnapshots(db, s1, s2) });
    expect((db.prepare('SELECT rotated FROM cards WHERE oracle_id = ?').get('o1') as any).rotated).toBe(1);

    const s3 = makeSnapshot(db, [['o1', 'h1']]);
    const d = diffSnapshots(db, s2, s3);
    expect(d.find((e) => e.oracle_id === 'o1')!.change).toBe('returned');
    applyDiff(db, { fromSnapshotId: s2, toSnapshotId: s3, entries: d });
    const card = db.prepare('SELECT rotated, rotated_at FROM cards WHERE oracle_id = ?').get('o1') as any;
    expect(card.rotated).toBe(0);
    expect(card.rotated_at).toBeNull();
    const q = db.prepare('SELECT reason FROM extraction_queue WHERE oracle_id = ?').get('o1') as any;
    expect(q.reason).toBe('new_card');
  });
});

describe('applyDiff', () => {
  it('never deletes a rotated card and records rotated_at', () => {
    const db = openDb(':memory:');
    const s1 = makeSnapshot(db, [['o1', 'h1']]);
    applyDiff(db, { fromSnapshotId: null, toSnapshotId: s1, entries: diffSnapshots(db, null, s1) });
    const s2 = makeSnapshot(db, []);
    applyDiff(db, { fromSnapshotId: s1, toSnapshotId: s2, entries: diffSnapshots(db, s1, s2) });

    const row = db.prepare('SELECT rotated, rotated_at, name FROM cards WHERE oracle_id = ?').get('o1') as any;
    expect(row).toBeDefined();               // still present — §5.2
    expect(row.rotated).toBe(1);
    expect(row.rotated_at).toBeTruthy();
  });

  it('queues new and errata cards for extraction but not rotations', () => {
    const db = openDb(':memory:');
    const s1 = makeSnapshot(db, [['o1', 'h1']]);
    applyDiff(db, { fromSnapshotId: null, toSnapshotId: s1, entries: diffSnapshots(db, null, s1) });
    const s2 = makeSnapshot(db, [['o1', 'h1-errata'], ['o2', 'h2']]);
    applyDiff(db, { fromSnapshotId: s1, toSnapshotId: s2, entries: diffSnapshots(db, s1, s2) });

    const q = db.prepare('SELECT oracle_id, reason FROM extraction_queue ORDER BY oracle_id').all() as any[];
    expect(q.map((r) => [r.oracle_id, r.reason])).toEqual([
      ['o1', 'oracle_changed'],
      ['o2', 'new_card'],
    ]);
  });

  it('rebuilds card_faces and the FTS index for changed cards', () => {
    const db = openDb(':memory:');
    const s1 = makeSnapshot(db, [['o1', 'h1']]);
    applyDiff(db, { fromSnapshotId: null, toSnapshotId: s1, entries: diffSnapshots(db, null, s1) });
    const faces = db.prepare('SELECT COUNT(*) AS n FROM card_faces WHERE oracle_id = ?').get('o1') as any;
    expect(faces.n).toBe(1);
    const fts = db.prepare("SELECT COUNT(*) AS n FROM cards_fts WHERE cards_fts MATCH 'Creature'").get() as any;
    expect(fts.n).toBe(1);
  });

  it('writes a pool_diffs summary row with correct counts', () => {
    const db = openDb(':memory:');
    const s1 = makeSnapshot(db, [['o1', 'h1'], ['o2', 'h2']]);
    const id = applyDiff(db, { fromSnapshotId: null, toSnapshotId: s1, entries: diffSnapshots(db, null, s1) });
    const row = db.prepare('SELECT * FROM pool_diffs WHERE id = ?').get(id) as any;
    expect(row.added_count).toBe(2);
    expect(row.rotated_count).toBe(0);
  });

  it('retains done queue history when a card is requeued via applyDiff', () => {
    const db = openDb(':memory:');
    // First diff: o1 is added and enqueued as pending.
    const s1 = makeSnapshot(db, [['o1', 'h1']]);
    applyDiff(db, { fromSnapshotId: null, toSnapshotId: s1, entries: diffSnapshots(db, null, s1) });
    // Mark o1's queue row done — simulates a completed extraction.
    db.exec("UPDATE extraction_queue SET status = 'done' WHERE oracle_id = 'o1'");
    // Second diff: o1 returns with changed oracle text, re-enqueued via applyDiff.
    const s2 = makeSnapshot(db, [['o1', 'h1-errata']]);
    applyDiff(db, { fromSnapshotId: s1, toSnapshotId: s2, entries: diffSnapshots(db, s1, s2) });
    // sec. 10.1: one open request per card; done history retained — two rows now.
    const rows = db.prepare(
      "SELECT status, reason FROM extraction_queue WHERE oracle_id = 'o1' ORDER BY id",
    ).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'done', reason: 'new_card' });
    expect(rows[1]).toMatchObject({ status: 'pending', reason: 'oracle_changed' });
  });
});

/**
 * Attaches one extraction record to (oracle_id, face 0) in each of the three
 * tables that hang off `card_faces` with ON DELETE CASCADE. Returns a counter
 * for how many of them survive.
 */
function seedFaceDependents(db: DatabaseSync, oracleId: string): () => Record<string, number> {
  db.prepare(
    `INSERT INTO rules_corpus (id, source_uri, effective_date, sha256, fetched_at,
       section_count, rule_count, glossary_count, is_current)
     VALUES (1,'u','2026-01-01','s','t',0,0,0,1)`,
  ).run();
  db.prepare(
    `INSERT INTO extraction_runs (id, started_at, provider, model, schema_version,
       corpus_id, packet_policy_sha, splitter_version, batch_kind, status)
     VALUES (1,'t','human','hand-drafted',1,1,'n/a',1,'golden','complete')`,
  ).run();
  db.prepare(
    `INSERT INTO unclassified_clauses (run_id, oracle_id, face_index, span_start,
       span_end, quote, proposed_label, rationale, oracle_hash)
     VALUES (1,?,0,0,1,'t','LABEL','why','h1')`,
  ).run(oracleId);
  db.prepare(
    `INSERT INTO clauses (oracle_id, face_index, clause_index, span_start, span_end,
       text, kind, oracle_hash, splitter_version)
     VALUES (?,0,0,0,1,'t','ability','h1',1)`,
  ).run(oracleId);

  return () => ({
    unclassified: (db.prepare('SELECT COUNT(*) AS n FROM unclassified_clauses').get() as any).n,
    clauses: (db.prepare('SELECT COUNT(*) AS n FROM clauses').get() as any).n,
  });
}

describe('applyDiff face-cascade containment', () => {
  it('preserves extraction records for cards whose oracle text did not change', () => {
    const db = openDb(':memory:');
    const s1 = makeSnapshot(db, [['keep', 'h1'], ['other', 'h2']]);
    applyDiff(db, { fromSnapshotId: null, toSnapshotId: s1, entries: diffSnapshots(db, null, s1) });
    const counts = seedFaceDependents(db, 'keep');
    expect(counts()).toEqual({ unclassified: 1, clauses: 1 });

    // A later sync that adds a card and errata's an unrelated one. `keep` is
    // untouched, so nothing of its may be destroyed - this is the regression:
    // applyDiff used to delete and re-insert EVERY face row, cascading away the
    // dependents of every card in the pool on every sync.
    const s2 = makeSnapshot(db, [['keep', 'h1'], ['other', 'h2-errata'], ['fresh', 'h3']]);
    applyDiff(db, { fromSnapshotId: s1, toSnapshotId: s2, entries: diffSnapshots(db, s1, s2) });
    expect(counts()).toEqual({ unclassified: 1, clauses: 1 });
  });

  it('still refreshes printing-level face data for unchanged cards', () => {
    const db = openDb(':memory:');
    const s1 = makeSnapshot(db, [['o1', 'h1']]);
    applyDiff(db, { fromSnapshotId: null, toSnapshotId: s1, entries: diffSnapshots(db, null, s1) });

    // Same oracle_hash, different printing: the face's image moved.
    const s2 = makeSnapshot(db, [['o1', 'h1']]);
    db.prepare(
      `UPDATE snapshot_cards
          SET faces_json = '[{"face_index":0,"name":"C","mana_cost":null,"type_line":"Creature","oracle_text":"t","power":null,"toughness":null,"colors":[],"image_normal":"http://new"}]'
        WHERE snapshot_id = ? AND oracle_id = 'o1'`,
    ).run(s2);
    applyDiff(db, { fromSnapshotId: s1, toSnapshotId: s2, entries: diffSnapshots(db, s1, s2) });

    const face = db.prepare('SELECT image_normal FROM card_faces WHERE oracle_id = ?').get('o1') as any;
    expect(face.image_normal).toBe('http://new');
    expect((db.prepare('SELECT COUNT(*) AS n FROM card_faces').get() as any).n).toBe(1);
  });

  it("drops a card's own dependents when its oracle text is errata'd", () => {
    const db = openDb(':memory:');
    const s1 = makeSnapshot(db, [['o1', 'h1']]);
    applyDiff(db, { fromSnapshotId: null, toSnapshotId: s1, entries: diffSnapshots(db, null, s1) });
    const counts = seedFaceDependents(db, 'o1');
    expect(counts()).toEqual({ unclassified: 1, clauses: 1 });

    // Errata: the recorded spans point into text that no longer exists, so the
    // cascade here is the intended behaviour, not collateral damage.
    const s2 = makeSnapshot(db, [['o1', 'h1-errata']]);
    applyDiff(db, { fromSnapshotId: s1, toSnapshotId: s2, entries: diffSnapshots(db, s1, s2) });
    expect(counts()).toEqual({ unclassified: 0, clauses: 0 });
  });
});
