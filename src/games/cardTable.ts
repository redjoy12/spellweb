/**
 * The name of each Arena card ID (game review design sec. 5). `cards.arena_id` holds one printing, and
 * a game can use any printing, so the names come from the card file of the Arena install. The name
 * then gives the `oracle_id`. A token and a card outside this app have no `oracle_id`. A load also
 * gives a pool card with no Scryfall `arena_id` its primary Arena ID (`fillArenaIds`).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fillArenaIds, foldName, oracleIdsByName } from '../pool/arenaIds.js';

export interface ArenaCard { name: string; oracle_id: string | null; token: boolean }
export type CardNames = Map<number, ArenaCard>;

/** The newest card file of an install. An update of Arena can leave an old one. */
export function newestCardFile(install: string): string | null {
  const dir = join(install, 'MTGA_Data', 'Downloads', 'Raw');
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  const files = names.filter((f) => /^Raw_CardDatabase_.*\.mtga$/.test(f)).map((f) => join(dir, f));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

/**
 * Replaces the table from a card file, and fills the missing `arena_id` of the pool cards. The file
 * opens read only. A card file with no `IsPrimaryCard` column gives no primary card, so it fills nothing.
 */
export function loadCardTable(db: DatabaseSync, file: string): number {
  const source = new DatabaseSync(file, { readOnly: true });
  try {
    const hasPrimary = (source.prepare("SELECT 1 FROM pragma_table_info('Cards') WHERE name = 'IsPrimaryCard'").get()) !== undefined;
    const rows = source.prepare(
      `SELECT c.GrpId AS id, c.IsToken AS token, ${hasPrimary ? 'c.IsPrimaryCard' : '0'} AS primary_card,
              (SELECT l.Loc FROM Localizations_enUS l WHERE l.LocId = c.TitleId ORDER BY l.Formatted LIMIT 1) AS name
         FROM Cards c`,
    ).all() as Array<{ id: number; token: number; primary_card: number | null; name: string | null }>;
    const ids = oracleIdsByName(db);
    const add = db.prepare('INSERT INTO arena_cards (arena_id, name, oracle_id, is_token, primary_card) VALUES (?, ?, ?, ?, ?)');
    let n = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM arena_cards');
      for (const r of rows) {
        if (!r.name) continue;
        const name = r.name.replace(/<[^>]+>/g, '').replace(' /// ', ' // ');
        add.run(r.id, name, r.token ? null : ids.get(foldName(name)) ?? null, r.token, r.primary_card === 1 ? 1 : 0);
        n++;
      }
      fillArenaIds(db);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return n;
  } finally {
    source.close();
  }
}

/** The names of these Arena IDs. An ID that is not in the table has a plain name, so a page still shows the game. */
export function namesOf(db: DatabaseSync, ids: Iterable<number>): CardNames {
  const list = [...new Set(ids)];
  const rows = db.prepare('SELECT a.arena_id, a.name, a.oracle_id, a.is_token FROM arena_cards a JOIN json_each(?) j ON j.value = a.arena_id').all(JSON.stringify(list)) as
    Array<{ arena_id: number; name: string; oracle_id: string | null; is_token: number }>;
  const out: CardNames = new Map(list.map((id) => [id, { name: `Unknown card ${id}`, oracle_id: null, token: false }]));
  for (const r of rows) out.set(r.arena_id, { name: r.name, oracle_id: r.oracle_id, token: r.is_token === 1 });
  return out;
}
