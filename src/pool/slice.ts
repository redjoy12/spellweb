import type { DatabaseSync } from 'node:sqlite';

/** The five colour letters a colour identity can hold. */
const COLOURS = ['W', 'U', 'B', 'R', 'G'];

/**
 * Task 12a's colour slice: every live card whose colour identity is a subset of `colours`
 * ("BR" -> mono-B, mono-R, BR gold, colourless, and the lands among them). Read from the live
 * pool; rotated cards are never selected (R11-4). Sorted by oracle id. Phase 3 scopes use it too.
 */
export function selectColourSlice(db: DatabaseSync, colours: string): string[] {
  const want = [...new Set(colours.toUpperCase())];
  if (want.length === 0) throw new Error('give at least one colour (W, U, B, R, G)');
  const bad = want.filter((c) => !COLOURS.includes(c));
  if (bad.length > 0) throw new Error(`unknown colour ${bad.join(', ')} (W, U, B, R, G)`);
  return (db.prepare(
    `SELECT c.oracle_id FROM cards c
      WHERE c.rotated = 0
        AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(c.color_identity, '[]')) j
                         WHERE j.value NOT IN (SELECT value FROM json_each(?)))
      ORDER BY c.oracle_id`,
  ).all(JSON.stringify(want)) as Array<{ oracle_id: string }>).map((r) => r.oracle_id);
}
