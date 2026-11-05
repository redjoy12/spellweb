/**
 * npm run trigger-gap -- [--build <id>] [--cards]
 * npm run trigger-gap -- --tag <type> --base <id> [--build <id>]
 *
 * Read only (plan 2026-10-31-schema-v17 Task 13). Lists each event trigger of a build with no
 * CARES_ABOUT atom, with its card and text, and gives the limit of each tag of plan section 9.1.
 * Default build: the newest. --cards prints only the oracle ids of the cards of the six tags.
 * --tag measures one tag against the build --base (plan Task 18 step 3, src/graph/tagMeasure.ts).
 * Set APP_DB_PATH to the copy that has the tag alone.
 */
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../db/client.js';
import { BuildIndex } from '../graph/buildIndex.js';
import { measureTag } from '../graph/tagMeasure.js';
import { triggerGapReport } from '../graph/triggerGap.js';

const args = process.argv.slice(2);
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const i = args.indexOf('--build');
const buildId = i >= 0 ? Number(args[i + 1])
  : (db.prepare('SELECT MAX(id) id FROM graph_builds').get() as { id: number }).id;
if (args.includes('--tag')) {
  const tag = args[args.indexOf('--tag') + 1];
  const base = Number(args[args.indexOf('--base') + 1]);
  if (!tag || !Number.isInteger(base)) throw new Error('--tag needs a type and --base <id>');
  console.log(JSON.stringify(measureTag(db, BuildIndex.load(db, base), BuildIndex.load(db, buildId), tag, { base, build: buildId }), null, 2));
  process.exit(0);
}
const r = triggerGapReport(db, buildId);
const cards = [...new Set(r.gaps.filter((g) => g.tag).map((g) => g.oracle_id))];

if (args.includes('--cards')) {
  for (const c of cards) console.log(c);
} else {
  console.log(`build ${r.build}: ${r.gaps.length} event triggers with no CARES_ABOUT atom, ${r.gaps.filter((g) => g.tag).length} of them on the six tags (${cards.length} cards)`);
  for (const g of [...r.gaps].sort((a, b) => a.quote.localeCompare(b.quote) || a.name.localeCompare(b.name))) {
    console.log(`  ${(g.tag ?? '-').padEnd(30)} ${g.quote.slice(0, 80).padEnd(80)} | ${g.name}`);
  }
  console.log('limits');
  for (const l of r.limits) {
    console.log(`  ${l.tag.padEnd(30)} demand ${String(l.demand_cards).padStart(3)}  new pairs at most ${String(l.new_pairs).padStart(5)}`);
    for (const p of l.parts) console.log(`    ${p.part}: demand ${p.demand_cards}, supply ${p.supply_cards}, pairs ${p.pairs}, new ${p.new_pairs}`);
  }
  console.log(`  all six: ${r.all_new_pairs}`);
  console.log(`  outside the sum: keyword discard supply ${r.keyword_discard_new_pairs}, crime with each text that has "target" ${r.crime_wide_new_pairs}`);
}
