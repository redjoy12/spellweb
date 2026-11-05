import type { DatabaseSync } from 'node:sqlite';

export type PoolChange = 'added' | 'oracle_changed' | 'rotated' | 'returned';

export interface DiffEntry {
  oracle_id: string;
  change: PoolChange;
  old_oracle_hash: string | null;
  new_oracle_hash: string | null;
}

function snapshotHashes(db: DatabaseSync, snapshotId: number): Map<string, string> {
  const rows = db
    .prepare('SELECT oracle_id, oracle_hash FROM snapshot_cards WHERE snapshot_id = ?')
    .all(snapshotId) as Array<{ oracle_id: string; oracle_hash: string }>;
  return new Map(rows.map((r) => [r.oracle_id, r.oracle_hash]));
}

/**
 * §5.2. Only genuine changes produce entries; an unchanged card yields nothing.
 * `returned` distinguishes a card coming back into Standard from a first sighting,
 * because the two need different handling in the UI even though both end rotated=0.
 */
export function diffSnapshots(
  db: DatabaseSync,
  fromSnapshotId: number | null,
  toSnapshotId: number,
): DiffEntry[] {
  const to = snapshotHashes(db, toSnapshotId);
  const from = fromSnapshotId === null ? new Map<string, string>() : snapshotHashes(db, fromSnapshotId);

  const known = new Set(
    (db.prepare('SELECT oracle_id FROM cards').all() as Array<{ oracle_id: string }>)
      .map((r) => r.oracle_id),
  );

  const entries: DiffEntry[] = [];

  for (const [oid, newHash] of to) {
    const oldHash = from.get(oid);
    if (oldHash === undefined) {
      entries.push({
        oracle_id: oid,
        change: known.has(oid) ? 'returned' : 'added',
        old_oracle_hash: null,
        new_oracle_hash: newHash,
      });
    } else if (oldHash !== newHash) {
      entries.push({ oracle_id: oid, change: 'oracle_changed', old_oracle_hash: oldHash, new_oracle_hash: newHash });
    }
  }

  for (const [oid, oldHash] of from) {
    if (!to.has(oid)) {
      entries.push({ oracle_id: oid, change: 'rotated', old_oracle_hash: oldHash, new_oracle_hash: null });
    }
  }

  entries.sort((a, b) => (a.oracle_id < b.oracle_id ? -1 : a.oracle_id > b.oracle_id ? 1 : 0));
  return entries;
}

export { applyDiff } from './apply.js';
