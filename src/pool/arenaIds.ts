/**
 * The Arena ID of a pool card that Scryfall gives no `arena_id` (fix of 2026-11-07). The pool keeps
 * only printings with `games` "arena" (`isPoolLegal`), so each pool card is on Arena. But Scryfall
 * fills `arena_id` late for a new set, and the code that needs an Arena card (the deck search, the
 * goal and legality checks, the swap of the deck chat, the card picker, the card rate) reads
 * `cards.arena_id`. The card file of the Arena install (table `arena_cards`, game review design
 * sec. 5) already has these cards, so this module copies the ID from it.
 *
 * Only a primary card of the card file counts (`IsPrimaryCard`, column `primary_card`). The lowest
 * primary ID wins. A later printing, a token, a face that has the name of a face of another card,
 * and a meld result are not primary, so a meld result stays out of a deck, as before. A Scryfall
 * `arena_id` always wins, and a sync puts it back first (`applyDiff`).
 */
import type { DatabaseSync } from 'node:sqlite';

/** The form of a name that `arena_cards` and `cards` compare. */
export const foldName = (name: string) => name.toLowerCase().replace(/’/g, "'");

/** Each name of this app, with the name of each face. A card that is not rotated wins. */
export function oracleIdsByName(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare(
    `SELECT name, oracle_id, rotated FROM cards
     UNION ALL SELECT f.name, f.oracle_id, c.rotated FROM card_faces f JOIN cards c USING (oracle_id)
     ORDER BY rotated DESC`,
  ).all() as Array<{ name: string; oracle_id: string }>;
  return new Map(rows.map((r) => [foldName(r.name), r.oracle_id]));
}

/**
 * Sets the `oracle_id` of each Arena card again from its name. A sync can add a card after the card
 * file loaded, and that card then has no Arena card until this runs. Returns the rows that change.
 */
export function linkArenaNames(db: DatabaseSync): number {
  const ids = oracleIdsByName(db);
  const rows = db.prepare('SELECT arena_id, name, oracle_id FROM arena_cards WHERE is_token = 0').all() as
    Array<{ arena_id: number; name: string; oracle_id: string | null }>;
  const set = db.prepare('UPDATE arena_cards SET oracle_id = ? WHERE arena_id = ?');
  let n = 0;
  for (const r of rows) {
    const id = ids.get(foldName(r.name)) ?? null;
    if (id !== r.oracle_id) { set.run(id, r.arena_id); n++; }
  }
  return n;
}

/** Gives each card with no `arena_id` the lowest primary Arena ID of its `oracle_id`. Returns the cards that change. */
export function fillArenaIds(db: DatabaseSync): number {
  const primary = 'FROM arena_cards a WHERE a.oracle_id = cards.oracle_id AND a.is_token = 0 AND a.primary_card = 1';
  return Number(db.prepare(
    `UPDATE cards SET arena_id = (SELECT MIN(a.arena_id) ${primary})
      WHERE arena_id IS NULL AND EXISTS (SELECT 1 ${primary})`,
  ).run().changes);
}
