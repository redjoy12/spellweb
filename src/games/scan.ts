/**
 * The scan of the Arena logs (game review design sec. 3). It only reads the log folder and the card
 * file. Arena has two logs, and `Player.log` moves to `Player-prev.log` at each start, so a log has an
 * ID from its first lines and keeps its offset after the move. A game shows when it ends: until then
 * the offset stays at its start, and the next scan reads that game again.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import { loadCardTable, newestCardFile } from './cardTable.js';
import type { GameRow } from './counts.js';
import { linkGame } from './link.js';
import { HEAD_BYTES, logHead, readEntries, splitGames, type Kept, type RawGame } from './logText.js';
import { PARSER_VERSION, rebuildGame, type RebuiltGame } from './rebuild.js';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = resolve(here, '../../config/game-review.json');

const ConfigZ = z.object({ scan_seconds: z.number().positive(), close_copies: z.number().int().nonnegative(), log_dir: z.string().min(1).nullable() });
export type GameConfig = z.infer<typeof ConfigZ>;

export const loadGameConfig = (path: string = CONFIG): GameConfig => ConfigZ.parse(JSON.parse(readFileSync(path, 'utf8')));

/** `GAME_LOG_DIR` points a scan at another folder, for example a copy of a log. */
export const logDirOf = (c: GameConfig) => process.env['GAME_LOG_DIR'] ?? c.log_dir ?? join(homedir(), 'AppData', 'LocalLow', 'Wizards Of The Coast', 'MTGA');

export function keepDirOf(db: DatabaseSync): string {
  const file = db.location();
  return file ? join(dirname(file), 'game-logs') : join(tmpdir(), 'mtga-game-logs');
}

export interface ScanOptions { dir: string; keepDir: string; closeCopies: number }

/** Reads a part of a file. A log can grow during a scan, so `to` fixes the end. */
function readPart(path: string, from: number, to?: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const end = to ?? fstatSync(fd).size;
    const buf = Buffer.alloc(Math.max(0, end - from));
    const n = buf.length > 0 ? readSync(fd, buf, 0, buf.length, from) : 0;
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

const readGame = (messages: readonly Kept[]): { game: RebuiltGame | null; reason: string | null } => {
  try {
    return { game: rebuildGame(messages), reason: null };
  } catch (err) {
    return { game: null, reason: (err as Error).message };
  }
};

function setLink(db: DatabaseSync, id: number, game: RebuiltGame, limit: number): void {
  const link = linkGame(db, game.deck, limit);
  db.prepare('UPDATE games SET deck_id = ?, link_kind = ?, link_json = ? WHERE id = ?').run(link?.deck_id ?? null, link?.kind ?? null, link ? JSON.stringify(link) : null, id);
}

/** Keeps the messages of a game and stores its row. A scan of a reconnect does not replace a game that it can read. */
function storeGame(db: DatabaseSync, raw: RawGame, o: ScanOptions): boolean {
  const old = db.prepare('SELECT status FROM games WHERE match_id = ? AND game_number = ?').get(raw.matchId, raw.gameNumber) as { status: string } | undefined;
  const { game, reason } = readGame(raw.messages);
  if (old?.status === 'ok' && !game) return false;
  const file = `${raw.matchId}-${raw.gameNumber}.jsonl.gz`;
  mkdirSync(o.keepDir, { recursive: true });
  writeFileSync(join(o.keepDir, file), gzipSync(raw.messages.map((m) => JSON.stringify(m)).join('\n')));
  const note = game && raw.bad > 0 ? `The log has ${raw.bad} messages of this game that the app could not read.` : reason;
  db.prepare(
    `INSERT INTO games (match_id, game_number, played_at, file, status, reason, parser_version, game_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (match_id, game_number) DO UPDATE SET played_at = excluded.played_at, file = excluded.file, status = excluded.status,
       reason = excluded.reason, parser_version = excluded.parser_version, game_json = excluded.game_json`,
  ).run(raw.matchId, raw.gameNumber, raw.messages.find((m) => m.k === 'gre')?.t ?? '', file, game ? 'ok' : 'unreadable', note, PARSER_VERSION, game ? JSON.stringify(game) : null);
  return true;
}

/** Reads the kept messages of each game from an older parser, so a fix reaches the old games. */
function rereadOldGames(db: DatabaseSync, keepDir: string): void {
  const rows = db.prepare('SELECT id, file FROM games WHERE parser_version < ?').all(PARSER_VERSION) as Array<{ id: number; file: string }>;
  for (const r of rows) {
    const path = join(keepDir, r.file);
    if (!existsSync(path)) continue;
    const messages = gunzipSync(readFileSync(path)).toString('utf8').split('\n').map((l) => JSON.parse(l) as Kept);
    const { game, reason } = readGame(messages);
    db.prepare('UPDATE games SET status = ?, reason = ?, parser_version = ?, game_json = ?, deck_id = NULL, link_kind = NULL, link_json = NULL WHERE id = ?')
      .run(game ? 'ok' : 'unreadable', reason, PARSER_VERSION, game ? JSON.stringify(game) : null, r.id);
  }
}

export interface ScanResult { added: number; bytes: number }

function scanOnce(db: DatabaseSync, o: ScanOptions): ScanResult & { logFound: boolean; detailed: boolean | null } {
  let added = 0;
  let bytes = 0;
  let detailed: boolean | null = null;
  let logFound = false;
  for (const name of ['Player-prev.log', 'Player.log']) {
    const path = join(o.dir, name);
    if (!existsSync(path)) continue;
    logFound = true;
    const head = logHead(readPart(path, 0, HEAD_BYTES).toString('utf8'));
    detailed = head.detailed ?? detailed;
    if (!head.id) continue; // the log has just started
    if (head.install) {
      const file = newestCardFile(head.install);
      const known = db.prepare('SELECT card_file FROM game_scan_state WHERE id = 1').get() as { card_file: string | null } | undefined;
      if (file && basename(file) !== known?.card_file) {
        loadCardTable(db, file);
        db.prepare('INSERT INTO game_scan_state (id, card_file) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET card_file = excluded.card_file').run(basename(file));
      }
    }
    const row = db.prepare('SELECT read_to, closed FROM game_log_files WHERE log_id = ?').get(head.id) as { read_to: number; closed: number } | undefined;
    if (row?.closed) continue;
    const closed = name === 'Player-prev.log'; // Arena writes no more to this log
    const from = row?.read_to ?? 0;
    const buf = readPart(path, from);
    bytes += buf.length;
    const { entries, end } = readEntries(buf, from);
    const { games, resume } = splitGames(entries, end);
    for (const raw of games) {
      const running = !closed && raw === games.at(-1) && !raw.ended;
      if (!running && storeGame(db, raw, o)) added++;
    }
    db.prepare(
      `INSERT INTO game_log_files (log_id, read_to, closed) VALUES (?, ?, ?)
       ON CONFLICT (log_id) DO UPDATE SET read_to = excluded.read_to, closed = excluded.closed`,
    ).run(head.id, closed ? from + buf.length : resume, closed ? 1 : 0);
  }
  rereadOldGames(db, o.keepDir);
  const open = db.prepare("SELECT id, game_json FROM games WHERE status = 'ok' AND deck_id IS NULL").all() as unknown as Array<Pick<GameRow, 'id' | 'game_json'>>;
  for (const r of open) setLink(db, r.id, JSON.parse(r.game_json!) as RebuiltGame, o.closeCopies);
  return { added, bytes, logFound, detailed };
}

/** One scan. A failure goes to the scan state, so the API stays up and the page can show it. */
export function scanLogs(db: DatabaseSync, o: ScanOptions): ScanResult {
  const state = (logFound: boolean, detailed: boolean | null, error: string | null) => db.prepare(
    `INSERT INTO game_scan_state (id, log_found, detailed, scanned_at, error) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET log_found = excluded.log_found, detailed = excluded.detailed, scanned_at = excluded.scanned_at, error = excluded.error`,
  ).run(logFound ? 1 : 0, detailed === null ? null : detailed ? 1 : 0, new Date().toISOString(), error);
  try {
    const { logFound, detailed, ...result } = scanOnce(db, o);
    state(logFound, detailed, null);
    return result;
  } catch (err) {
    state(existsSync(o.dir), null, (err as Error).message);
    return { added: 0, bytes: 0 };
  }
}
