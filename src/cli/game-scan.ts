/**
 * npm run game-scan -- [--dir <folder>]
 *
 * One scan of the Arena logs (game review design sec. 3), as the API does each 30 seconds. It prints
 * counts only, and no name from the log. Use APP_DB_PATH for a copy of the database.
 */
import { openDb } from '../db/client.js';
import { scanStatus } from '../games/counts.js';
import { keepDirOf, loadGameConfig, logDirOf, scanLogs } from '../games/scan.js';

const at = process.argv.indexOf('--dir');
const config = loadGameConfig();
const db = openDb();
const result = scanLogs(db, { dir: at > 0 ? process.argv[at + 1]! : logDirOf(config), keepDir: keepDirOf(db), closeCopies: config.close_copies });
const rows = db.prepare('SELECT id, played_at, status, reason, deck_id, link_kind, length(game_json) AS size FROM games ORDER BY id').all();
console.log(JSON.stringify({ ...result, status: scanStatus(db), games: rows }, null, 2));
