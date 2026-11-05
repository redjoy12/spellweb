/**
 * npm run owner-questions -- --make [--build <id>] [--out <json>]
 *
 * Writes the high-help questions for the "Your decisions" page (src/graph/ownerQuestions.ts):
 * reading questions, type roles that block golden pairs, and golden pairs where a confirmed edge
 * does not agree with the label. Default build: the newest build. Default out:
 * docs/owner-questions/questions.json. Read only on the database.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from '../db/client.js';
import { makeOwnerQuestions, QUESTIONS_PATH } from '../graph/ownerQuestions.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!args.includes('--make')) {
  console.error('usage: npm run owner-questions -- --make [--build <id>] [--out <json>]');
  process.exit(1);
}
const db = openDb();
const buildId = opt('--build') !== undefined ? Number(opt('--build'))
  : (db.prepare('SELECT MAX(id) id FROM graph_builds').get() as { id: number | null }).id;
if (buildId === null) throw new Error('no graph build');
const out = opt('--out') ?? QUESTIONS_PATH;
const q = makeOwnerQuestions(db, buildId);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(q, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  build: q.build, rule_set: q.rule_set, out,
  reading: q.reading.map((r) => `${r.key}: ${r.cards} cards, ${JSON.stringify(r.with_type)}`),
  type_role: q.type_role.map((r) => `${r.type} (${r.role}, needs ${r.needs}): pairs ${r.pairs.map((p) => p.pair_id).join(', ')}`),
  wrong_link: q.wrong_link.map((w) => `pair ${w.pair_id} (${w.label}, ${w.polarities.join('')}): ${w.supply.name} -> ${w.demand.name}`),
}, null, 2));
