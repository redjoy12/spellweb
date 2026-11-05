/**
 * npm run build-diff -- <base> <after> [--min <n>] [--supply <type>] [--demand-card <name>]
 *
 * Read only. Compares two graph builds: the link pairs that each link kind and each rule adds or
 * removes. `--min` hides the kinds and rules that move fewer pairs (default 100). `--supply` keeps
 * one supply type. `--demand-card` keeps the links into one card. Writes nothing.
 */
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../db/client.js';
import { BuildIndex } from '../graph/buildIndex.js';
import { explainBuilds } from '../graph/tagMeasure.js';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = Number(args[0]);
const build = Number(args[1]);
if (!Number.isInteger(base) || !Number.isInteger(build)) {
  console.error('usage: npm run build-diff -- <base> <after> [--min <n>] [--supply <type>] [--demand-card <name>]');
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const min = Number(flag('--min') ?? 100);
const only = flag('--supply');
const name = flag('--demand-card');
const card = name === undefined ? undefined
  : (db.prepare('SELECT oracle_id FROM cards WHERE name = ?').get(name) as { oracle_id: string } | undefined)?.oracle_id;
if (name !== undefined && !card) throw new Error(`no card named ${name}`);
const r = explainBuilds(db, BuildIndex.load(db, base), BuildIndex.load(db, build), { base, build },
  { ...(only ? { only } : {}), ...(card ? { demandCard: card } : {}) });
const large = <T extends { link_new: number; lost: number }>(l: readonly T[]) => l.filter((x) => x.link_new >= min || x.lost >= min);
console.log(JSON.stringify({ base, build, compare: r.compare, links: large(r.links), minus: large(r.minus),
  rules: only || card ? r.rules : large(r.rules) }, null, 2));
