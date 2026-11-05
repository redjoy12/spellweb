/**
 * The link of a game to a deck (game review design sec. 3): the cards of the game against each
 * version of each deck, by card, so a printing makes no difference. A count of "copies differ" is the
 * larger of the copies that came in and the copies that went out, so a swap of 2 copies is 2.
 */
import type { DatabaseSync } from 'node:sqlite';
import { namesOf } from './cardTable.js';

export interface LinkCard { oracle_id: string | null; name: string; copies: number }

export interface DeckLink {
  deck_id: number;
  kind: 'exact' | 'close';
  differ: number;
  /** The game used a version of the deck from before a swap. */
  older: boolean;
  /** Cards of the game that this version does not have. */
  in: LinkCard[];
  /** Cards of this version that the game did not have. */
  out: LinkCard[];
}

interface DeckRow { id: number; deck_json: string; version: number }
interface DeckCards { cards: Array<{ oracle_id: string; name: string; copies: number }> }

export function linkGame(db: DatabaseSync, deck: readonly number[], limit: number): DeckLink | null {
  if (deck.length === 0) return null;
  const names = namesOf(db, deck);
  const game = new Map<string, LinkCard>();
  for (const id of deck) {
    const c = names.get(id)!;
    const key = c.oracle_id ?? c.name;
    const row = game.get(key) ?? { oracle_id: c.oracle_id, name: c.name, copies: 0 };
    row.copies++;
    game.set(key, row);
  }
  // Rows of `deck_versions` hold the deck before each swap. Version 0 is the deck as it is.
  const rows = db.prepare(
    `SELECT id, deck_json, 0 AS version FROM decks
     UNION ALL SELECT deck_id, deck_json, id FROM deck_versions
     ORDER BY id DESC, version`,
  ).all() as unknown as DeckRow[];

  let best: DeckLink | null = null;
  for (const r of rows) {
    const cards = (JSON.parse(r.deck_json) as DeckCards).cards;
    const theirs = new Map(cards.map((c) => [c.oracle_id, c]));
    const entering = [...game.entries()].flatMap(([k, c]) => {
      const copies = c.copies - (theirs.get(k)?.copies ?? 0);
      return copies > 0 ? [{ ...c, copies }] : [];
    });
    const leaving = cards.flatMap((c) => {
      const copies = c.copies - (game.get(c.oracle_id)?.copies ?? 0);
      return copies > 0 ? [{ oracle_id: c.oracle_id, name: c.name, copies }] : [];
    });
    const count = (l: LinkCard[]) => l.reduce((s, c) => s + c.copies, 0);
    const differ = Math.max(count(entering), count(leaving));
    if (differ > limit || (best && differ >= best.differ)) continue;
    best = { deck_id: r.id, kind: differ === 0 ? 'exact' : 'close', differ, older: r.version !== 0, in: entering, out: leaving };
  }
  return best;
}
