/**
 * npm run golden-check -- --apply [--dry-run]
 *
 * Writes the owner answers of the golden check (the "Does card A help card B?" questions on the
 * "Your decisions" page, src/graph/goldenCheck.ts) to the golden set. Link and weak link accept
 * the pair; no link corrects it to `none`; works against corrects it to `anti` on the same
 * clauses and CR chain; not sure waits. `conflicts` lists the
 * answers that were changed, or removed (Undo), after an earlier apply: the apply does not change them.
 *
 * After an apply, run `npm run owner-questions -- --make`: a `wrong_link` question can show a pair
 * that the owner has now answered here.
 */
import { openDb } from '../db/client.js';
import { applyGoldenCheck } from '../graph/goldenCheck.js';

const args = process.argv.slice(2);
if (!args.includes('--apply')) {
  console.error('usage: npm run golden-check -- --apply [--dry-run]');
  process.exit(1);
}
const db = openDb();
const dryRun = args.includes('--dry-run');
db.exec('BEGIN IMMEDIATE');
try {
  const r = applyGoldenCheck(db, { dryRun });
  db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
  console.log(JSON.stringify({ dry_run: dryRun, ...r }, null, 2));
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
