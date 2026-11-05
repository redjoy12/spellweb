/**
 * The name of each Arena card ID (game review design sec. 5). `cards.arena_id` holds one printing, and
 * a game can use any printing, so the names come from the card file of the Arena install. The name
 * then gives the `oracle_id`. A token and a card outside this app have no `oracle_id`.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

const fold = (name: string) => name.toLowerCase().replace(/’/g, "'");

/** Each name of this app, with the name of each face. A card that is not rotated wins. */
function oracleIds(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare(
    `SELECT name, oracle_id, rotated FROM cards
     UNION ALL SELECT f.name, f.oracle_id, c.rotated FROM card_faces f JOIN cards c USING (oracle_id)
     ORDER BY rotated DESC`,
  ).all() as Array<{ name: string; oracle_id: string }>;
  return new Map(rows.map((r) => [fold(r.name), r.oracle_id]));
}

/** Replaces the table from a card file. The file opens read only. */
export function loadCardTable(db: DatabaseSync, file: string): number {
  const source = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = source.prepare(
      `SELECT c.GrpId AS id, c.IsToken AS token,
              (SELECT l.Loc FROM Localizations_enUS l WHERE l.LocId = c.TitleId ORDER BY l.Formatted LIMIT 1) AS name
         FROM Cards c`,
    ).all() as Array<{ id: number; token: number; name: string | null }>;
    const ids = oracleIds(db);
    const add = db.prepare('INSERT INTO arena_cards (arena_id, name, oracle_id, is_token) VALUES (?, ?, ?, ?)');
    let n = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM arena_cards');
      for (const r of rows) {
        if (!r.name) continue;
        const name = r.name.replace(/<[^>]+>/g, '').replace(' /// ', ' // ');
        add.run(r.id, name, r.token ? null : ids.get(fold(name)) ?? null, r.token);
        n++;
      }
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
