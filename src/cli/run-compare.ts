/**
 * npm run run-compare -- --run <run_id> --before <db copy> [--report <md>]
 *
 * Read only. Compares the atoms of a run with the atoms that it replaced. `--before` is the backup
 * made before the run (VACUUM INTO): its current atoms of the same cards are the earlier reading.
 */
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../db/client.js';
import { compareAtoms, compareGolden, renderCompare, type CompareAtom } from '../atoms/runCompare.js';
import { V17_REMOVED } from '../atoms/schemaV17.js';
import { V18_MOVED } from '../atoms/schemaV18.js';
import { V19_TAGS } from '../atoms/schemaV19.js';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const run = Number(opt('--run'));
const beforePath = opt('--before');
if (!Number.isInteger(run) || !beforePath) {
  console.error('usage: npm run run-compare -- --run <run_id> --before <db copy> [--report <md>]');
  process.exit(1);
}

type Row = Omit<CompareAtom, 'params'> & { params_json: string };
const toAtom = ({ params_json, ...r }: Row): CompareAtom => ({ ...r, params: JSON.parse(params_json) as Record<string, unknown> });
const COLUMNS = 'a.oracle_id, c.name, a.face_index, a.family, a.type_key, a.span_start, a.span_end, a.quote, a.params_json';

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const old = new DatabaseSync(beforePath, { readOnly: true });
const after = (db.prepare(`SELECT ${COLUMNS} FROM atoms a JOIN cards c USING (oracle_id) WHERE a.run_id = ? AND a.is_current = 1 AND a.consensus = 1`)
  .all(run) as unknown as Row[]).map(toAtom);
const cards = (db.prepare("SELECT oracle_id FROM extraction_results WHERE run_id = ? AND outcome <> 'failed'").all(run) as Array<{ oracle_id: string }>).map((r) => r.oracle_id);
const before = (old.prepare(`SELECT ${COLUMNS} FROM atoms a JOIN cards c USING (oracle_id) JOIN json_each(?) j ON j.value = a.oracle_id WHERE a.is_current = 1 AND a.consensus = 1`)
  .all(JSON.stringify(cards)) as unknown as Row[]).map(toAtom);

const res = compareAtoms(before, after, new Map([...V17_REMOVED, ...V18_MOVED].map((r) => [r.type, r.into])));
const pct = res.params.total ? (res.params.agree / res.params.total) * 100 : 0;
console.log(JSON.stringify({ run, cards: res.cards, before: res.before, after: res.after, matched: res.matched, moved: res.moved,
  lost: res.lost.length, added: res.added.length, params: `${res.params.agree} of ${res.params.total} (${pct.toFixed(1)}%)`,
  atoms_all_agree: `${res.atoms_all_agree} of ${res.matched}` }, null, 2));
const golden = compareGolden(db, run, new Set(['PRODUCES.SACRIFICE', 'PRODUCES.SACRIFICE_FODDER', 'CARES_ABOUT.PERMANENT_DIES', 'ENABLES.ATTACH', ...V19_TAGS.map((t) => t.type)]));
console.log(JSON.stringify({ golden_cards: golden.cards, golden_atoms: golden.atoms, golden_matched: golden.matched,
  golden_params: `${golden.params.agree} of ${golden.params.total}`, focus_atoms: golden.focus.length, focus_agree: golden.focus.filter((f) => f.agree).length,
  misses: golden.misses.length, extras: golden.extras.length }, null, 2));
const report = opt('--report');
if (report) {
  writeFileSync(report, renderCompare(res), 'utf8');
  writeFileSync(report.replace(/\.md$/, '') + '.golden.json', JSON.stringify(golden, null, 2) + '\n', 'utf8');
  console.log(`wrote ${report}`);
}
