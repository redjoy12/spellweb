/**
 * npm run tag-check -- --sample [--size <n>] [--seed <n>] [--out <json>] [--add]
 *                      [--min-schema <v>] [--two-readings <run>,<earlier run> --two-readings-size <n>]
 *
 * Owner request 2026-10-21: writes the tag-check sample (real cards with their current atoms) for
 * the "Your decisions" page. Default size: 20 cards. Default out: docs/tag-check/sample.json.
 * --add keeps the cards of the file and adds a new round with no card of an earlier round.
 * --min-schema draws only cards whose current atoms are all on that schema version or later.
 * --two-readings also draws cards where the two runs read the same text differently (default 10).
 * Read only on the database.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from '../db/client.js';
import { makeTagCheckSample, TAG_CHECK_PATH, type TagCheckSample } from '../atoms/tagCheck.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!args.includes('--sample')) {
  console.error('usage: npm run tag-check -- --sample [--size <n>] [--seed <n>] [--out <json>] [--add] [--min-schema <v>] [--two-readings <run>,<earlier> [--two-readings-size <n>]]');
  process.exit(1);
}
const db = openDb();
const out = opt('--out') ?? TAG_CHECK_PATH;
const old = args.includes('--add') && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) as TagCheckSample : null;
const round = old && old.items.length ? Math.max(...old.items.map((i) => i.round)) + 1 : 1;
const seed = opt('--seed') !== undefined ? Number(opt('--seed')) : old ? old.seed + round - 1 : undefined;
const two = opt('--two-readings')?.split(',').map(Number);
if (two && (two.length !== 2 || two.some((n) => !Number.isInteger(n)))) throw new Error('--two-readings needs <run>,<earlier run>');
const made = makeTagCheckSample(db, {
  ...(seed !== undefined ? { seed } : {}), round,
  ...(opt('--size') !== undefined ? { size: Number(opt('--size')) } : {}),
  ...(old ? { exclude: new Set(old.items.map((i) => i.card.oracle_id)) } : {}),
  ...(opt('--min-schema') !== undefined ? { minSchema: Number(opt('--min-schema')) } : {}),
  ...(two ? { twoReadings: { run: two[0]!, earlier: two[1]!, size: Number(opt('--two-readings-size') ?? 10) } } : {}),
});
const sample: TagCheckSample = old ? { ...made, seed: old.seed, items: [...old.items, ...made.items] } : made;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(sample, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  cards_with_tags: sample.cards_with_tags, out,
  items: sample.items.filter((i) => i.round === round).map((i) => `${i.card.name}: ${i.tags.length} tags (schema ${i.schema_versions.join('+')})${i.reason === 'two_readings' ? `, two readings: ${i.new_tags!.length} new, ${i.other_tags!.length} only earlier` : ''}`),
}, null, 2));
