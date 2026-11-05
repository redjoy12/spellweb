/**
 * npm run link-check -- --sample [--build <id>] [--seed <n>] [--out <json>] [--add]
 *
 * --add keeps the pairs of the file and adds a new round of 20 pairs with no card of an earlier
 * pair (a confirmation of tests that were corrected on the earlier rounds).
 *
 * Spec rev. 17 sec. 5.9: writes the link-check sample (20 real linked card pairs of a build) for
 * the "Your decisions" page. Default build: the newest build. Default out: docs/link-check/sample.json.
 * Read only on the database.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from '../db/client.js';
import { LINK_CHECK_PATH, makeLinkCheckSample, type LinkCheckSample } from '../graph/linkCheck.js';
import { makePartsLinkSample } from '../graph/partsLinkCheck.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes('--parts')) {
  // APP_DB_PATH=<copy> npm run link-check -- --parts --parts-build <id> --base-build <id> --first-part-atom <id>
  // Adds a round of pairs that only the keyword parts link (owner request 2026-10-24) to the sample file.
  const db = openDb();
  const n = (name: string) => { const v = Number(opt(name)); if (!Number.isInteger(v)) throw new Error(`give ${name} <id>`); return v; };
  const out = opt('--out') ?? LINK_CHECK_PATH;
  const old = JSON.parse(readFileSync(out, 'utf8')) as LinkCheckSample;
  const round = Math.max(...old.items.map((i) => i.round ?? 1)) + 1;
  const r = makePartsLinkSample(db, {
    partsBuild: n('--parts-build'), baseBuild: n('--base-build'), firstPartAtom: n('--first-part-atom'), round, keyPrefix: `parts${round}`,
    groups: [
      { name: 'cast', parts: ['ENABLES.CAST'], size: 8 },
      { name: 'tap_untap', parts: ['ENABLES.TAP_AND_UNTAP'], size: 8 },
      { name: 'equip', parts: ['ENABLES.ATTACH'], keywords: ['ENABLES.EQUIP'], size: 4 },
    ],
  });
  writeFileSync(out, JSON.stringify({ ...old, items: [...old.items, ...r.items] }, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ round, new_pairs: r.new_pairs, by_group: r.by_group, by_keyword: r.by_keyword, out,
    items: r.items.map((i) => `${i.part!.group} ${i.part!.keyword_label} -> ${i.part!.part_label} (${i.part!.when}): ${i.supply.name} -> ${i.demand.name}`) }, null, 2));
  process.exit(0);
}
if (!args.includes('--sample')) {
  console.error('usage: npm run link-check -- --sample [--build <id>] [--seed <n>] [--out <json>]');
  process.exit(1);
}
const db = openDb();
const buildId = opt('--build') !== undefined ? Number(opt('--build'))
  : (db.prepare('SELECT MAX(id) id FROM graph_builds').get() as { id: number | null }).id;
if (buildId === null) throw new Error('no graph build');
const out = opt('--out') ?? LINK_CHECK_PATH;
const old = args.includes('--add') && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) as LinkCheckSample : null;
if (old && old.build !== buildId) throw new Error(`--add: the file has build ${old.build}, not ${buildId}`);
const round = old ? Math.max(...old.items.map((i) => i.round ?? 1)) + 1 : 1;
const seed = opt('--seed') !== undefined ? Number(opt('--seed')) : old ? old.seed + round - 1 : undefined;
const made = makeLinkCheckSample(db, buildId, {
  ...(seed !== undefined ? { seed } : {}), round,
  ...(old ? { exclude: new Set(old.items.map((i) => i.key.slice(i.key.indexOf(':') + 1))) } : {}),
});
const sample: LinkCheckSample = old ? { ...made, seed: old.seed, items: [...old.items.map((i) => ({ ...i, round: i.round ?? 1 })), ...made.items] } : made;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(sample, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  build: sample.build, rule_set: sample.rule_set, linked_pairs: sample.linked_pairs, out,
  items: sample.items.filter((i) => i.round === round).map((i) => `${i.stratum}${i.chosen_by ? ` ${i.chosen_by.rule_id} (${i.chosen_by.card_pairs})` : ''}: ${i.supply.name} -> ${i.demand.name}`),
}, null, 2));
