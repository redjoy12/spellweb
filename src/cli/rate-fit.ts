/**
 * npm run rate-fit -- [--dry-run] [--build <id>] [--top <n>]
 *
 * Card rate plan Task 4. Fits atom prices on printed mana value, gives each spell a rate, and prints
 * the held-out test and the checks of the results section. The result rules of plan sec. 2.3 and
 * 2.4 come before any write: a failed rule exits 1 and writes nothing. --dry-run also writes nothing,
 * and it opens the database read only. Default build: the newest. Default top: 15.
 *
 * The weaker card of a proof needs the links of the build, so this CLI calls `readLinks`.
 */
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, openDb } from '../db/client.js';
import { FOLDS, GAP_LINE, MAX_CORRELATION, MAX_ERROR, passesResultRule, rateSpells, wordCost, writeRates, type RateRow } from '../rate/fit.js';
import { kindKey, loadGroupInput, makeGroups, rewardTest } from '../rate/groups.js';
import { readLinks } from '../rate/links.js';
import { cardClasses, classifyGroups, deckDemandTest, loadProofCards, type ProofCard } from '../rate/proof.js';

const args = process.argv.slice(2);
const flag = (name: string): number | null => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : null;
};
const dryRun = args.includes('--dry-run');
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const buildId = flag('--build') ?? (db.prepare('SELECT MAX(id) id FROM graph_builds').get() as { id: number }).id;
const topCount = flag('--top') ?? 15;

const input = loadGroupInput(db, buildId);
const reward = rewardTest(input.roles);
const condition = deckDemandTest(input.roles);
const cards = loadProofCards(db, input, buildId);
const { links, cards: linked } = readLinks(db, buildId);
console.log(`links: read only from build ${buildId}, ${linked} cards agree with card_degree`);
const proofs = [...classifyGroups(makeGroups(input, reward, kindKey).filter((g) => g.members.length >= 2), { cards, reward, condition, links }).pairs.values()]
  .filter((p) => p.class === 'dominated_in_pool');
const classes = cardClasses(input, condition, new Set(proofs.map((p) => p.b)));
const run = rateSpells(input, cards, classes);

const { rows, test } = run;
const fix = (n: number | null, d = 2) => (n === null ? 'null' : n.toFixed(d));
const share = (n: number, of: number) => `${n} (${((100 * n) / of).toFixed(1)}%)`;
const mean = (v: readonly number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0);

const withValue = rows.filter((r) => r.predicted_mana !== null);
console.log(`build ${buildId}: ${rows.length} spells, ${withValue.length} in the fit, ${run.fit_rows.length} fit rows, ${run.prices.length} columns`);
console.log(`ridge strength: ${test.lambdas.join(', ')} on the ${FOLDS} folds, ${run.lambda} on all cards`);
console.log(`held-out typical error (mean absolute) ${test.error.toFixed(3)}, root mean square ${test.root_mean_square.toFixed(3)}`);
console.log(`constant median:                       ${test.baseline_error.toFixed(3)}, root mean square ${test.baseline_root_mean_square.toFixed(3)}`);

const passed = passesResultRule(test, run.gap_correlation);
console.log(`correlation of role_gap with printed mana: ${run.gap_correlation.toFixed(3)} (Pearson)`);
console.log(`result rule: ${passed ? 'pass' : 'FAIL'} (error at most ${MAX_ERROR} and lower than the constant median, absolute correlation at most ${MAX_CORRELATION})`);
console.log(`median residual of each printed mana bin: ${[...run.bin_medians].sort((a, b) => a[0] - b[0]).map(([b, m]) => `${b === 1 ? '0-1' : b === 7 ? '7+' : b} ${m.toFixed(2)}`).join(', ')}`);

console.log('held-out error by the mana value of the row');
console.log('  mana  rows  mean abs  mean signed');
const bands: ReadonlyArray<[string, number, number]> = [['0-1', 0, 1], ['2', 2, 2], ['3', 3, 3], ['4', 4, 4], ['5', 5, 5], ['6', 6, 6], ['7+', 7, Infinity]];
for (const [name, lo, hi] of bands) {
  const e = run.fit_rows.flatMap((r, i) => (r.mana >= lo && r.mana <= hi ? [test.predictions[i]! - r.mana] : []));
  console.log(`  ${name.padEnd(4)} ${String(e.length).padStart(5)}  ${mean(e.map(Math.abs)).toFixed(3).padStart(8)}  ${mean(e).toFixed(3).padStart(11)}`);
}

const reasons = new Map<string, number>();
for (const r of rows) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
const gapped = rows.filter((r) => r.role_gap !== null && Math.abs(r.role_gap) >= GAP_LINE);
console.log(`spells with a value ${share(withValue.length, rows.length)}, no value ${share(rows.length - withValue.length, rows.length)}, no group ${share(reasons.get('no_group') ?? 0, rows.length)}`);
console.log(`gap of ${GAP_LINE} mana or more ${share(gapped.length, rows.length)}: above the group ${gapped.filter((r) => r.role_gap! > 0).length}, below the group ${gapped.filter((r) => r.role_gap! < 0).length}`);
console.log(`reasons: ${[...reasons].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
console.log(`classes: ${['conditional', 'dominated_in_pool', 'plain'].map((c) => `${c} ${rows.filter((r) => r.class === c).length}`).join(', ')}`);

const bandOf = rows.filter((r) => r.rate !== null);
console.log('mean rate by printed mana: ' + bands.map(([name, lo, hi]) => `${name} ${mean(bandOf.filter((r) => r.printed_mana >= lo && r.printed_mana <= hi).map((r) => r.rate!)).toFixed(2)}`).join(', '));

const costHolders = new Set(input.atoms.filter((a) => reward(a) && wordCost(a)).map((a) => a.oracle_id));
const costAtoms = input.atoms.filter((a) => reward(a) && wordCost(a)).length;
const holds = (list: readonly RateRow[]) => list.filter((r) => costHolders.has(r.oracle_id)).length;
console.log(`cost atoms of the word check: ${costAtoms} on ${costHolders.size} cards. Of the cards with a gap of ${GAP_LINE} or more, ${holds(gapped)} hold one`);

const show = (c: ProofCard) => {
  const words = c.faces.map((f) => `${f.mana_cost ?? ''} ${f.type_line}${f.power === null ? '' : ` ${f.power}/${f.toughness}`}: ${f.oracle_text}`).join(' // ');
  return `${c.name}, ${words.replace(/\s*\([^)]*\)/g, '').replace(/\n/g, ' / ')}`;
};
const line = (r: RateRow) => {
  const mark = costHolders.has(r.oracle_id) ? ' [cost atom]' : '';
  return `  rate ${fix(r.rate)}  gap ${fix(r.role_gap)}  predicted ${fix(r.predicted_mana)}  printed ${r.printed_mana}  ${r.class}${mark}\n    group ${r.group_key}\n    ${show(cards.get(r.oracle_id)!)}`;
};
const ranked = rows.filter((r) => r.rate !== null).sort((a, b) => b.rate! - a.rate! || (a.oracle_id < b.oracle_id ? -1 : 1));
const top = ranked.slice(0, topCount);
const bottom = ranked.slice(-topCount).reverse();
console.log(`the ${topCount} highest rates: ${holds(top)} hold a cost atom`);
for (const r of top) console.log(line(r));
console.log(`the ${topCount} lowest rates: ${holds(bottom)} hold a cost atom`);
for (const r of bottom) console.log(line(r));

const rowOf = new Map(rows.map((r) => [r.oracle_id, r]));
console.log(`the proof pairs (${proofs.length}): is the rate of the stronger card higher?`);
for (const p of proofs) {
  const [a, b] = [rowOf.get(p.a)!, rowOf.get(p.b)!];
  const side = (r: RateRow) => `${cards.get(r.oracle_id)!.name}: rate ${fix(r.rate)}, gap ${fix(r.role_gap)}, predicted ${fix(r.predicted_mana)}, group ${r.group_key}`;
  const verdict = a.rate === null || b.rate === null ? 'no value' : a.rate > b.rate ? 'yes' : a.rate === b.rate ? 'equal rate' : 'NO';
  console.log(`  ${verdict}\n    A ${side(a)}\n    B ${side(b)}`);
}

if (!passed) {
  console.log('no write: the result rule failed');
  process.exit(1);
}
if (dryRun) {
  console.log('dry run: nothing written');
} else {
  db.close();
  const write = openDb();
  writeRates(write, buildId, rows);
  console.log(`card_rates: ${rows.length} rows for build ${buildId}`);
  write.close();
}
