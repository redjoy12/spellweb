import type { DatabaseSync } from 'node:sqlite';
import type { DiffEntry } from './diff.js';
import type { CardFace } from '../scryfall/normalize.js';
import { fillArenaIds, linkArenaNames } from './arenaIds.js';

interface SnapshotCardRow {
  oracle_id: string; name: string; layout: string; mana_cost: string | null; cmc: number;
  type_line: string; oracle_text: string | null; colors: string; color_identity: string;
  keywords: string; power: string | null; toughness: string | null; rarity: string;
  arena_id: number | null; set_code: string; collector_number: string;
  image_normal: string | null; image_art_crop: string | null;
  faces_json: string; oracle_hash: string;
}

/**
 * Folds a snapshot into the living `cards` table.
 *
 * §5.2 invariant: rotated cards are marked, never deleted. Every saved deck
 * session that referenced them must keep resolving.
 *
 * Precondition: `diffSnapshots` MUST be called before `applyDiff` for a given
 * snapshot pair. `diffSnapshots` reads the living `cards` table to distinguish
 * `added` from `returned`, and `applyDiff` mutates it — running them in the
 * wrong order misclassifies `returned` as `added`.
 */
export function applyDiff(
  db: DatabaseSync,
  opts: { fromSnapshotId: number | null; toSnapshotId: number; entries: DiffEntry[] },
): number {
  const now = new Date().toISOString();
  const counts = { added: 0, oracle_changed: 0, rotated: 0, returned: 0 };
  for (const e of opts.entries) counts[e.change]++;

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO pool_diffs (from_snapshot_id, to_snapshot_id, created_at,
         added_count, changed_count, rotated_count, returned_count)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(opts.fromSnapshotId, opts.toSnapshotId, now,
          counts.added, counts.oracle_changed, counts.rotated, counts.returned);
    const { id: diffId } = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };

    const entryStmt = db.prepare(
      `INSERT INTO pool_diff_entries (diff_id, oracle_id, change, old_oracle_hash, new_oracle_hash)
       VALUES (?,?,?,?,?)`,
    );
    for (const e of opts.entries) {
      entryStmt.run(diffId, e.oracle_id, e.change, e.old_oracle_hash, e.new_oracle_hash);
    }

    // Upsert every card present in the new snapshot, then clear rotation on survivors.
    const rows = db
      .prepare('SELECT * FROM snapshot_cards WHERE snapshot_id = ?')
      .all(opts.toSnapshotId) as unknown as SnapshotCardRow[];

    const upsert = db.prepare(
      `INSERT INTO cards (
         oracle_id, name, layout, mana_cost, cmc, type_line, oracle_text, colors,
         color_identity, keywords, power, toughness, rarity, arena_id, set_code,
         collector_number, image_normal, image_art_crop, oracle_hash,
         first_seen_snapshot_id, last_seen_snapshot_id, rotated, rotated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL)
       ON CONFLICT(oracle_id) DO UPDATE SET
         name = excluded.name, layout = excluded.layout, mana_cost = excluded.mana_cost,
         cmc = excluded.cmc, type_line = excluded.type_line, oracle_text = excluded.oracle_text,
         colors = excluded.colors, color_identity = excluded.color_identity,
         keywords = excluded.keywords, power = excluded.power, toughness = excluded.toughness,
         rarity = excluded.rarity, arena_id = excluded.arena_id, set_code = excluded.set_code,
         collector_number = excluded.collector_number, image_normal = excluded.image_normal,
         image_art_crop = excluded.image_art_crop, oracle_hash = excluded.oracle_hash,
         last_seen_snapshot_id = excluded.last_seen_snapshot_id,
         rotated = 0, rotated_at = NULL`,
    );

    // CRITICAL: `card_faces` is the cascade parent of `clauses`, `atoms` and
    // `unclassified_clauses` - all three carry
    // `FOREIGN KEY (oracle_id, face_index) ... ON DELETE CASCADE`. So deleting a
    // face row destroys every extraction record hanging off it, including the
    // sec. 4 unclassified candidates that golden-set coverage counts as
    // equal-standing ground truth (golden-set-procedure.md step 4). Rewriting
    // faces unconditionally therefore wiped those records for every card in the
    // pool on every sync, even for the overwhelming majority whose text had not
    // changed by a character. So the rewrite is now scoped to the cards the diff
    // actually classified, and everything else is updated in place.
    const rewriteFaces = new Set(
      opts.entries
        .filter((e) => e.change === 'added' || e.change === 'returned' || e.change === 'oracle_changed')
        .map((e) => e.oracle_id),
    );

    const delFaces = db.prepare('DELETE FROM card_faces WHERE oracle_id = ?');
    const insFace = db.prepare(
      `INSERT INTO card_faces (oracle_id, face_index, name, mana_cost, type_line,
         oracle_text, power, toughness, colors, image_normal)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    // The in-place path for a card whose oracle text is unchanged. A face still
    // carries printing-level data (`image_normal`, `colors`) that moves when a
    // different printing becomes preferred, so these rows cannot simply be
    // skipped - they are upserted, which touches no foreign key. Every column the
    // `oracle_hash` covers is unchanged by definition here, so writing them back
    // is a no-op; they are included so this path can never leave a face row
    // disagreeing with the snapshot.
    const upsertFace = db.prepare(
      `INSERT INTO card_faces (oracle_id, face_index, name, mana_cost, type_line,
         oracle_text, power, toughness, colors, image_normal)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(oracle_id, face_index) DO UPDATE SET
         name = excluded.name, mana_cost = excluded.mana_cost,
         type_line = excluded.type_line, oracle_text = excluded.oracle_text,
         power = excluded.power, toughness = excluded.toughness,
         colors = excluded.colors, image_normal = excluded.image_normal`,
    );
    const delFts = db.prepare('DELETE FROM cards_fts WHERE oracle_id = ?');
    const insFts = db.prepare(
      'INSERT INTO cards_fts (oracle_id, name, type_line, oracle_text) VALUES (?,?,?,?)',
    );

    for (const r of rows) {
      upsert.run(
        r.oracle_id, r.name, r.layout, r.mana_cost, r.cmc, r.type_line, r.oracle_text,
        r.colors, r.color_identity, r.keywords, r.power, r.toughness, r.rarity,
        r.arena_id, r.set_code, r.collector_number, r.image_normal, r.image_art_crop,
        r.oracle_hash, opts.toSnapshotId, opts.toSnapshotId,
      );

      const faces = JSON.parse(r.faces_json) as CardFace[];
      if (rewriteFaces.has(r.oracle_id)) {
        // New, returned, or errata'd. The delete - and the cascade it triggers -
        // is deliberate here: on errata the dependent spans point into text that
        // no longer exists, and the procedure's answer to that is a re-draft, not
        // a silently retained stale record. Note `golden_atoms` deliberately does
        // NOT hang off this key; it survives errata and is caught instead by the
        // explicit oracle_hash staleness check in `verifyGoldenCard`.
        delFaces.run(r.oracle_id);
        for (const f of faces) {
          insFace.run(r.oracle_id, f.face_index, f.name, f.mana_cost, f.type_line,
                      f.oracle_text, f.power, f.toughness, JSON.stringify(f.colors), f.image_normal);
        }
      } else {
        for (const f of faces) {
          upsertFace.run(r.oracle_id, f.face_index, f.name, f.mana_cost, f.type_line,
                         f.oracle_text, f.power, f.toughness, JSON.stringify(f.colors), f.image_normal);
        }
      }

      delFts.run(r.oracle_id);
      insFts.run(r.oracle_id, r.name, r.type_line, faces.map((f) => f.oracle_text).join('\n'));
    }

    // Mark rotations. Never delete.
    const rotate = db.prepare('UPDATE cards SET rotated = 1, rotated_at = ? WHERE oracle_id = ?');
    for (const e of opts.entries) {
      if (e.change === 'rotated') rotate.run(now, e.oracle_id);
    }

    // Queue extraction work for Phase 2. Rotations are not queued.
    // Phase 2 re-keyed extraction_queue onto surrogate id with a partial unique
    // index ON (oracle_id) WHERE status='pending' (sec. 10.1: one open request per
    // card, done history retained). The conflict target must name that partial
    // index's predicate so a requeue updates the still-pending row in place rather
    // than inserting a duplicate or colliding.
    const enqueue = db.prepare(
      `INSERT INTO extraction_queue (oracle_id, reason, enqueued_at, source_diff_id)
       VALUES (?,?,?,?)
       ON CONFLICT(oracle_id) WHERE status = 'pending' DO UPDATE SET
         reason = excluded.reason, enqueued_at = excluded.enqueued_at,
         source_diff_id = excluded.source_diff_id`,
    );
    for (const e of opts.entries) {
      if (e.change === 'added' || e.change === 'returned') {
        enqueue.run(e.oracle_id, 'new_card', now, diffId);
      } else if (e.change === 'oracle_changed') {
        enqueue.run(e.oracle_id, 'oracle_changed', now, diffId);
      }
    }

    // The upsert above wrote the Scryfall `arena_id`, which is null for a card that Scryfall has
    // not given an Arena ID yet. The Arena card file (`arena_cards`) gives the ID of such a card.
    // A new card has no Arena card until its name is linked again, so the link runs first.
    linkArenaNames(db);
    fillArenaIds(db);

    db.exec('COMMIT');
    return diffId;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
