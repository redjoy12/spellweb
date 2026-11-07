import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/client.js';
import { applyDiff, diffSnapshots } from '../src/pool/diff.js';
import { fillArenaIds, linkArenaNames } from '../src/pool/arenaIds.js';

const FACE = '[{"face_index":0,"name":"C","mana_cost":null,"type_line":"Creature","oracle_text":"t","power":null,"toughness":null,"colors":[],"image_normal":null}]';

/** A complete snapshot of one card, `o1` with the name "Card o1", and the Scryfall `arena_id` given. */
function snapshot(db: DatabaseSync, arenaId: number | null): number {
  db.prepare(`INSERT INTO snapshots (source_type, source_uri, source_updated_at, ingested_at, status) VALUES ('default_cards','u','t',datetime('now'),'complete')`).run();
  const { id } = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
  db.prepare(
    `INSERT INTO snapshot_cards (snapshot_id, oracle_id, name, layout, cmc, type_line, colors, color_identity, keywords, rarity, arena_id, set_code, collector_number, faces_json, oracle_hash)
     VALUES (?, 'o1', 'Card o1', 'normal', 1, 'Creature', '[]', '[]', '[]', 'common', ?, 'aaa', '1', ?, 'h1')`,
  ).run(id, arenaId, FACE);
  return id;
}

function sync(db: DatabaseSync, from: number | null, to: number): void {
  applyDiff(db, { fromSnapshotId: from, toSnapshotId: to, entries: diffSnapshots(db, from, to) });
}

const arenaId = (db: DatabaseSync) => (db.prepare("SELECT arena_id FROM cards WHERE oracle_id = 'o1'").get() as { arena_id: number | null }).arena_id;

/** The card file loaded before the sync, so its rows of "Card o1" have no oracle_id yet. 400 is a later printing. */
function arenaRows(db: DatabaseSync): void {
  const add = db.prepare('INSERT INTO arena_cards (arena_id, name, oracle_id, is_token, primary_card) VALUES (?, ?, NULL, ?, ?)');
  add.run(400, 'Card o1', 0, 0);
  add.run(500, 'Card o1', 0, 1);
  add.run(600, 'Card o1', 0, 1);
  add.run(700, 'Card o1', 1, 1); // a token of the same name never counts
}

describe('the Arena ID of a card that Scryfall gives none', () => {
  it('a sync links a new card to the Arena card file and gives it the lowest primary ID', () => {
    const db = openDb(':memory:');
    arenaRows(db);
    sync(db, null, snapshot(db, null));
    expect(arenaId(db)).toBe(500);
    expect(db.prepare("SELECT arena_id FROM arena_cards WHERE oracle_id = 'o1' ORDER BY arena_id").all().map((r) => (r as { arena_id: number }).arena_id)).toEqual([400, 500, 600]);
  });

  it('a Scryfall arena_id wins, and a later sync with none fills the Arena ID again', () => {
    const db = openDb(':memory:');
    arenaRows(db);
    const s1 = snapshot(db, 900);
    sync(db, null, s1);
    expect(arenaId(db)).toBe(900);
    const s2 = snapshot(db, null);
    sync(db, s1, s2);
    expect(arenaId(db)).toBe(500);
  });

  it('a card with no primary Arena card keeps no arena_id', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO arena_cards (arena_id, name, oracle_id, is_token, primary_card) VALUES (400, 'Card o1', NULL, 0, 0)").run();
    sync(db, null, snapshot(db, null));
    expect(arenaId(db)).toBeNull();
    expect(linkArenaNames(db)).toBe(0); // the sync linked the name already
    expect(fillArenaIds(db)).toBe(0);
  });
});
