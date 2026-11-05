/**
 * npm run rate-proof -- [--build <id>] [--gaps <n>]
 *
 * Read only (card rate plan Task 3). Prints the proof class of each pair that shares a group, the
 * class of each spell, each proof with its text, and the pairs that only the link check stops.
 * Default build: the newest. Default gaps: 40.
 *
 * The links come from `readLinks`, which stops when the code no longer gives the links of the build.
 */
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../db/client.js';
import { kindKey, loadGroupInput, makeGroups, rewardTest } from '../rate/groups.js';
import { readLinks } from '../rate/links.js';
import {
  cardClasses, classifyGroups, deckDemandTest, demandTest, loadProofCards, targetCount, type PairClass, type PairResult, type ProofCard,
} from '../rate/proof.js';

const args = process.argv.slice(2);
const flag = (name: string): number | null => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : null;
};
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const buildId = flag('--build') ?? (db.prepare('SELECT MAX(id) id FROM graph_builds').get() as { id: number }).id;
const gapLimit = flag('--gaps') ?? 40;

const input = loadGroupInput(db, buildId);
const reward = rewardTest(input.roles);
const groups = makeGroups(input, reward, kindKey).filter((g) => g.members.length >= 2);
const cards = loadProofCards(db, input, buildId);
const condition = deckDemandTest(input.roles);
const { links, cards: linked } = readLinks(db, buildId);
console.log(`links: read only from build ${buildId}, ${linked} cards agree with card_degree`);
const run = classifyGroups(groups, { cards, reward, condition, links });

const results = [...run.pairs.values()];
const spells = input.spells.length;
const share = (n: number, of: number) => `${n} (${((100 * n) / of).toFixed(1)}%)`;
const count = (list: readonly PairResult[], c: PairClass) => list.filter((p) => p.class === c).length;

console.log(`build ${buildId}: ${spells} spells, ${groups.length} groups of 2 or more cards with the key of plan sec. 2.1`);
console.log(`pairs ${results.length}, pair and group rows ${Object.values(run.rows).reduce((s, n) => s + n, 0)}`);
for (const c of ['dominated_in_pool', 'conditional', 'not_comparable'] as const) {
  console.log(`  ${c.padEnd(18)} pairs ${String(count(results, c)).padStart(6)}  rows ${String(run.rows[c]).padStart(6)}`);
}

const reasons = new Map<string, number>();
for (const p of results) if (p.class === 'not_comparable') reasons.set(p.reason, (reasons.get(p.reason) ?? 0) + 1);
console.log('not_comparable, by reason');
for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${r}`);

const conditions = new Map<string, number>();
for (const p of results) if (p.class === 'conditional') conditions.set(p.reason, (conditions.get(p.reason) ?? 0) + 1);
console.log('conditional pairs, by the first atom that one card lacks');
for (const [r, n] of [...conditions].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(n).padStart(6)}  ${r}`);

const weak = new Set(results.filter((p) => p.class === 'dominated_in_pool').map((p) => p.b));
const classes = cardClasses(input, condition, weak);
const rule = (test: typeof condition) => new Set(input.atoms.filter(test).map((a) => a.oracle_id)).size;
console.log(`spells with the class conditional: rule of the brief ${share(rule(demandTest(input.roles)), spells)}, narrower rule ${share(rule(condition), spells)}`);
console.log(`spell classes on the narrower rule: ${['conditional', 'dominated_in_pool', 'plain'].map((c) => `${c} ${classes.filter((x) => x.class === c).length}`).join(', ')}`);

const quotes = input.atoms.filter((a) => /\btargets?\b/i.test(a.quote));
console.log(`target count: ${share(quotes.filter((a) => targetCount(a.quote) !== null).length, quotes.length)} of the atoms with the word "target" read, ${quotes.filter((a) => targetCount(a.quote) === null).length} stay null`);

const show = (c: ProofCard) => {
  const words = c.faces.map((f) => `${f.mana_cost ?? ''} ${f.type_line}${f.power === null ? '' : ` ${f.power}/${f.toughness}`}: ${f.oracle_text}`).join(' // ');
  return `${c.name}, ${words.replace(/\s*\([^)]*\)/g, '').replace(/\n/g, ' / ')}`;
};
const proofs = results.filter((p) => p.class === 'dominated_in_pool');
console.log(`each dominated_in_pool pair (${proofs.length})`);
for (const p of proofs) {
  console.log(`  better on: ${p.gains.join('; ')}`);
  console.log(`    A ${show(cards.get(p.a)!)}`);
  console.log(`    B ${show(cards.get(p.b)!)}`);
  const size = (id: string) => `out ${links(id).out.size}, in ${links(id).in.size}, classes ${links(id).class_in.size + links(id).class_of.size}, anti ${links(id).anti.size}`;
  console.log(`    links of A: ${size(p.a)}. Links of B: ${size(p.b)}`);
}

const gaps = results.filter((p) => p.reason === 'link_gap').sort((p, q) => p.link_gap.length - q.link_gap.length);
const lookup = db.prepare('SELECT name FROM cards WHERE oracle_id = ?');
/** One entry of `link_gap`: a side and a card, or a side and a class or `this pair`. */
const nameOf = (x: string) => {
  const [side, ...rest] = x.split(' ');
  const row = lookup.get(rest.join(' ')) as { name: string } | undefined;
  return `${side} ${row?.name ?? rest.join(' ')}`;
};
console.log(`pairs that pass the fields and fail the link check (${gaps.length}, first ${Math.min(gapLimit, gaps.length)})`);
for (const p of gaps.slice(0, gapLimit)) {
  console.log(`  ${p.link_gap.length} links, better on: ${p.gains.join('; ')}`);
  console.log(`    A ${show(cards.get(p.a)!)}`);
  console.log(`    B ${show(cards.get(p.b)!)}`);
  console.log(`    B has and A lacks: ${p.link_gap.slice(0, 4).map(nameOf).join(', ')}`);
}
