/**
 * Round 2 of the rate pairs (card rate plan sec. 2.6). Round 1 failed, and the owner's reasons say
 * what the rate must read. Printed mana gives those parts no price, so half of this round gives
 * their weights, and the other half tests them. The owner chose to read the whole card, and its
 * image shows the rarity symbol, so this round does not test the rarity lead of round 1.
 *
 * The page gets only the key and the cards. The question file holds the rest, with the rule, so a
 * later build cannot move the result. An answer has the kind `link_rule` and the key prefix `rr2:`,
 * as `rr1:` has, and the key joins the two cards with `~` (src/rate/ownerRound.ts says why).
 */
import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { shuffle } from '../graph/linkRuleV2.js';
import { DecisionError, type Decision } from '../graph/ownerDecisions.js';
import { axisDifference, axisScore, fitWeights, type Axes } from './axes.js';
import { maskedWords, type RewardAtom } from './groups.js';
import { facesOf, loadRateRound, MAX_GROUP_PAIRS, PASS_SHARE, type Bodies, type RateSeal, type RoundCard, type Side } from './ownerRound.js';

export const ROUND2_PATH = 'docs/card-rate-round-2-questions.json';
export const ROUND2_PREFIX = 'rr2:';
export const ROUND2_SEED = 20261102;
/** Fewer sides give ten weights nothing to stand on, so the round then has no rate to test. */
export const MIN_FIT_SIDES = 20;
export const ROUND2_CHOICES = ['a_better', 'b_better', 'equal', 'depends', 'cannot_compare', 'other'] as const;

export type Fold = 'fit' | 'test';
const RARITY_ORDER: Readonly<Record<string, number>> = { common: 0, uncommon: 1, rare: 2, mythic: 3 };

/** The pairs of each kind. Equal rarity comes in half of the round, because the rarity rule says nothing there. */
export const ROUND2_QUOTAS: ReadonlyArray<{ same_rarity: boolean; bodies: Bodies; pairs: number }> = [
  { same_rarity: true, bodies: 'creature', pairs: 16 },
  { same_rarity: true, bodies: 'mixed', pairs: 12 },
  { same_rarity: true, bodies: 'neither', pairs: 12 },
  { same_rarity: false, bodies: 'creature', pairs: 16 },
  { same_rarity: false, bodies: 'mixed', pairs: 12 },
  { same_rarity: false, bodies: 'neither', pairs: 12 },
];
export const ROUND2_SIZE = ROUND2_QUOTAS.reduce((s, q) => s + q.pairs, 0);

/** What the owner reads, above the first pair. */
export const ROUND2_RULE = {
  test: 'This round asks two things. How much does each thing that you named count: the reward, the cost, the uses, a condition and speed? Can a rate from card text do better than a simple rule?',
  pairs: 'The round has 80 pairs. In each pair, both cards have one mana value and do a similar thing. The page shows the words and the whole card image of each card. The image shows the rarity symbol, so this round does not test the rarity lead of round 1. 40 pairs give the weights of a new rate, and the other 40 test that rate. The page does not show which pair is of which kind.',
  question: 'Read the two full card texts, and use your own Magic knowledge. Which is the better whole card at this cost, in a deck that can use both? Do not think about links: this round asks only about quality.',
  answers: 'You can choose "It depends on the deck". Then write what kind of deck decides it. Use "About equal" when neither card is better, and "I cannot compare" when the two cards do not compare.',
  pass_line: 'The pass line: on the 40 test pairs, the new rate must agree on at least 75% of the pairs where you choose a side. It must also do better than the rule "the higher rarity" and the rule "the larger body". A rule with no side on a pair gets half a point.',
  effect: 'Your answers change nothing in the app now. If the new rate fails, a text rate does not do this job in v1, and the "Card rate" switch stays off. If it passes, nothing changes until you decide. The app sealed the draw and the rules before your first answer. If no button fits, press "Other" and write your own answer.',
};

/** One spell that the draw can use. */
export interface DrawCard {
  oracle_id: string; name: string; printed_mana: number; rarity: string; creature: boolean;
  /** Power plus toughness. Null: the card is not a creature, or the printed body has a `*`. */
  body: number | null;
  rate: number | null; role_gap: number | null; axes: Axes;
  /** The whole text, with numbers masked, so two cards with one text are not a pair. */
  words: string;
}
export interface DrawGroup { key: string; members: readonly string[] }

interface Candidate { a: DrawCard; b: DrawCard; group_key: string; same_rarity: boolean; bodies: Bodies }

export interface Round2Side { oracle_id: string; name: string; rarity: string; body: number | null; creature: boolean; rate: number | null; role_gap: number | null; axes: Axes }
export interface Round2Pair { key: string; group_key: string; printed_mana: number; fold: Fold; same_rarity: boolean; bodies: Bodies; a: Round2Side; b: Round2Side }
export interface Round2 { source: string; seed: number; made_at: string; seal: RateSeal; rule: typeof ROUND2_RULE; scales: Axes; pools: Record<string, number>; pairs: Round2Pair[] }

export const rarityRank = (r: string): number => RARITY_ORDER[r] ?? 0;

/** A keyword line is not a job (owner notes on pairs 19 and 39 of round 1): the two cards can have the same words. */
export function isKeywordLine(a: Pick<RewardAtom, 'quote'>, keywords: readonly string[]): boolean {
  const bare = a.quote.replace(/\([^)]*\)/g, ' ').trim().toLowerCase();
  return keywords.some((k) => bare.startsWith(k.toLowerCase()));
}

/** Each pair of one group with one printed mana, of cards with different words. A pair of two groups comes once. */
export function candidates(groups: readonly DrawGroup[], cards: ReadonlyMap<string, DrawCard>): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const g of groups) {
    const list = g.members.flatMap((id) => { const c = cards.get(id); return c ? [c] : []; });
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = list[i]!.oracle_id < list[j]!.oracle_id ? [list[i]!, list[j]!] : [list[j]!, list[i]!];
        const id = `${a.oracle_id}~${b.oracle_id}`;
        if (a.printed_mana !== b.printed_mana || a.words === b.words || seen.has(id)) continue;
        seen.add(id);
        const bodies: Bodies = a.creature && b.creature ? 'creature' : a.creature || b.creature ? 'mixed' : 'neither';
        out.push({ a, b, group_key: g.key, same_rarity: a.rarity === b.rarity, bodies });
      }
    }
  }
  return out;
}

const sideOf = ({ oracle_id, name, rarity, body, creature, rate, role_gap, axes }: DrawCard): Round2Side => ({ oracle_id, name, rarity, body, creature, rate, role_gap, axes });

/** The pairs of the round in page order. Each kind has half of its pairs in each fold, and half with the higher card on side A. */
export function drawRound2(pool: readonly Candidate[], rand: () => number): Round2Pair[] {
  const used = new Set<string>();
  const perGroup = new Map<string, number>();
  const pairs: Round2Pair[] = [];
  for (const q of ROUND2_QUOTAS) {
    const got: Candidate[] = [];
    for (const c of shuffle(pool.filter((p) => p.same_rarity === q.same_rarity && p.bodies === q.bodies), rand)) {
      if (got.length === q.pairs) break;
      if (used.has(c.a.oracle_id) || used.has(c.b.oracle_id) || (perGroup.get(c.group_key) ?? 0) >= MAX_GROUP_PAIRS) continue;
      used.add(c.a.oracle_id).add(c.b.oracle_id);
      perGroup.set(c.group_key, (perGroup.get(c.group_key) ?? 0) + 1);
      got.push(c);
    }
    const half = <T>(x: T, y: T) => shuffle(got.map((_, i) => (i < got.length / 2 ? x : y)), rand);
    const [folds, sides] = [half<Fold>('fit', 'test'), half<Side>('a', 'b')];
    got.forEach((c, i) => {
      const higher = rarityRank(c.a.rarity) >= rarityRank(c.b.rarity);
      const [a, b] = (sides[i] === 'a') === higher ? [c.a, c.b] : [c.b, c.a];
      pairs.push({
        key: `${ROUND2_PREFIX}${a.oracle_id}~${b.oracle_id}`, group_key: c.group_key, printed_mana: a.printed_mana, fold: folds[i]!,
        same_rarity: c.same_rarity, bodies: c.bodies, a: sideOf(a), b: sideOf(b),
      });
    });
  }
  return shuffle(pairs, rand);
}

/** Refuses a draw with too few pairs, or with folds of different sizes. The next seed gives a new draw. */
export function requireRound2(pairs: readonly Pick<Round2Pair, 'fold'>[]): void {
  const fit = pairs.filter((p) => p.fold === 'fit').length;
  if (pairs.length !== ROUND2_SIZE || fit !== ROUND2_SIZE / 2) throw new Error(`the draw has ${pairs.length} pairs and ${fit} in the fit fold. Use the next seed, and write it in the results`);
}

export const loadRound2 = (path: string = ROUND2_PATH): Round2 | null =>
  (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Round2 : null);

export interface Round2Item { key: string; a: RoundCard; b: RoundCard }
export interface Round2Page { rule: typeof ROUND2_RULE | null; items: Round2Item[] }

/** The words. The page reads the card image from the card route, so this list stays free of each sealed value. */
function wordsOnly(db: DatabaseSync, oracleId: string): RoundCard {
  const faces = facesOf(db, oracleId).map(({ name, mana_cost, type_line, oracle_text, power, toughness }) => ({ name, mana_cost, type_line, oracle_text, power, toughness }));
  const c = db.prepare('SELECT name FROM cards WHERE oracle_id = ?').get(oracleId) as { name: string };
  return { name: c.name, image: null, quote: '', faces };
}

/** What the page gets. This list names each field, so no sealed value can reach the owner. */
export function round2Page(db: DatabaseSync, path: string = ROUND2_PATH): Round2Page {
  const round = loadRound2(path);
  if (!round) return { rule: null, items: [] };
  return { rule: round.rule, items: round.pairs.map((p) => ({ key: p.key, a: wordsOnly(db, p.a.oracle_id), b: wordsOnly(db, p.b.oracle_id) })) };
}

/** Records (or replaces) one answer. "It depends" needs the kind of deck, because R8 reads it. */
export function saveRound2Answer(db: DatabaseSync, d: { item_key: string; choice: string; note?: string }, path: string = ROUND2_PATH): Decision {
  if (!loadRound2(path)?.pairs.some((p) => p.key === d.item_key)) throw new DecisionError(`no round 2 pair "${d.item_key}"`);
  if (!(ROUND2_CHOICES as readonly string[]).includes(d.choice)) throw new DecisionError(`"${d.choice}" is not an answer for this item: use ${ROUND2_CHOICES.join(', ')}`);
  const note = (d.note ?? '').trim();
  if ((d.choice === 'other' || d.choice === 'depends') && !note) throw new DecisionError('this answer needs a note');
  const out: Decision = { kind: 'link_rule', item_key: d.item_key, choice: d.choice, note, decided_at: new Date().toISOString() };
  db.prepare('INSERT OR REPLACE INTO owner_decisions (kind, item_key, choice, note, decided_at) VALUES (?, ?, ?, ?, ?)').run(out.kind, out.item_key, out.choice, out.note, out.decided_at);
  return out;
}

export interface Round2Answer { choice: string; note: string }

export function loadRound2Answers(db: DatabaseSync): Map<string, Round2Answer> {
  const rows = db.prepare("SELECT item_key, choice, note FROM owner_decisions WHERE kind = 'link_rule' AND item_key LIKE 'rr2:%'").all() as unknown as Array<Round2Answer & { item_key: string }>;
  return new Map(rows.map((r) => [r.item_key, { choice: r.choice, note: r.note }]));
}

const chosen = (a: Round2Answer | undefined): Side | null => (a?.choice === 'a_better' ? 'a' : a?.choice === 'b_better' ? 'b' : null);

export type Rule = (p: Round2Pair) => Side | null;

export const raritySide: Rule = (p) => {
  const [a, b] = [rarityRank(p.a.rarity), rarityRank(p.b.rarity)];
  return a === b ? null : a > b ? 'a' : 'b';
};

/** A card with no creature face has size 0, as in round 1. */
export const bodySide: Rule = (p) => {
  const size = (s: Round2Side) => (s.creature ? s.body : 0);
  const [a, b] = [size(p.a), size(p.b)];
  return a === null || b === null || a === b ? null : a > b ? 'a' : 'b';
};

/** Rate version 1: the rate, then the gap. */
export const rateV1Side: Rule = (p) => {
  const key = (s: Round2Side) => [s.rate ?? 0, s.role_gap ?? 0] as const;
  const [a, b] = [key(p.a), key(p.b)];
  if (a[0] !== b[0]) return a[0] > b[0] ? 'a' : 'b';
  return a[1] === b[1] ? null : a[1] > b[1] ? 'a' : 'b';
};

export interface RuleScore { name: string; agree: number; no_side: number; points: number; sides: number; share: number | null }

/** A rule with no side gets half a point, so a rule that says little is not punished or paid. */
export function scoreRule(name: string, rule: Rule, pairs: readonly Round2Pair[], answers: ReadonlyMap<string, Round2Answer>): RuleScore {
  const sided = pairs.filter((p) => chosen(answers.get(p.key)));
  const agree = sided.filter((p) => rule(p) === chosen(answers.get(p.key))).length;
  const no_side = sided.filter((p) => rule(p) === null).length;
  return { name, agree, no_side, points: agree + no_side / 2, sides: sided.length, share: sided.length ? (agree + no_side / 2) / sided.length : null };
}

export interface Round2Result {
  open: number;
  result: 'wait' | 'no fit' | 'pass' | 'fail';
  fit_sides: number;
  weights: number[] | null;
  scores: RuleScore[];
  /** A count, not a test: the owner sees the symbol. */
  rarity: { sides: number; agree: number; share: number | null };
  depends: number; equal: number; cannot: number; other: number;
}

/** The sealed rule. It reads the answers only when each pair has one, and the test fold plays no part in the weights. */
export function round2Result(round: Pick<Round2, 'pairs' | 'scales'>, answers: ReadonlyMap<string, Round2Answer>): Round2Result {
  const { pairs, scales } = round;
  const open = pairs.filter((p) => !answers.has(p.key)).length;
  const count = (c: string) => pairs.filter((p) => answers.get(p.key)?.choice === c).length;
  const others = { depends: count('depends'), equal: count('equal'), cannot: count('cannot_compare'), other: count('other') };
  const empty = { fit_sides: 0, weights: null, scores: [], rarity: { sides: 0, agree: 0, share: null } };
  if (open > 0) return { open, result: 'wait', ...empty, ...others };
  const rows = pairs.filter((p) => p.fold === 'fit').flatMap((p) => {
    const side = chosen(answers.get(p.key));
    return side ? [{ x: axisDifference(p.a.axes, p.b.axes, scales), chose_a: side === 'a' }] : [];
  });
  const diff = pairs.filter((p) => raritySide(p) !== null && chosen(answers.get(p.key)));
  const agree = diff.filter((p) => raritySide(p) === chosen(answers.get(p.key))).length;
  const rarity = { sides: diff.length, agree, share: diff.length ? agree / diff.length : null };
  const test = pairs.filter((p) => p.fold === 'test');
  const plain = [scoreRule('the higher rarity', raritySide, test, answers), scoreRule('the larger body', bodySide, test, answers), scoreRule('rate version 1', rateV1Side, test, answers)];
  if (rows.length < MIN_FIT_SIDES) return { open, result: 'no fit', fit_sides: rows.length, weights: null, scores: plain, rarity, ...others };
  const weights = fitWeights(rows);
  const newRate: Rule = (p) => {
    const [a, b] = [axisScore(p.a.axes, scales, weights), axisScore(p.b.axes, scales, weights)];
    return a === b ? null : a > b ? 'a' : 'b';
  };
  const score = scoreRule('the new rate', newRate, test, answers);
  const beats = (s: RuleScore) => score.points > s.points;
  const passed = score.share !== null && score.share >= PASS_SHARE && beats(plain[0]!) && beats(plain[1]!);
  return { open, result: passed ? 'pass' : 'fail', fit_sides: rows.length, weights, scores: [score, ...plain], rarity, ...others };
}

export interface Round2Note { pair: number; a: string; b: string; choice: string; note: string }

export function round2Notes(pairs: readonly Round2Pair[], answers: ReadonlyMap<string, Round2Answer>): Round2Note[] {
  return pairs.flatMap((p, i) => {
    const a = answers.get(p.key);
    return a?.note ? [{ pair: i + 1, a: p.a.name, b: p.b.name, choice: a.choice, note: a.note }] : [];
  });
}

/** The cards of round 1: the owner has read them, so they stay out. */
export const roundOneCards = (): Set<string> => new Set((loadRateRound()?.pairs ?? []).flatMap((p) => [p.a.oracle_id, p.b.oracle_id]));

export const masked = (faces: ReadonlyArray<{ oracle_text: string }>, name: string): string => maskedWords(faces.map((f) => f.oracle_text).join('\n'), name);
