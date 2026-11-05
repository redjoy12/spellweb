/**
 * Round 1 of the rate pairs (card rate plan Task 6, report section "Three checks decide if the
 * search can trust the rate"). The owner reads two cards that do one job at one printed mana, and
 * says which card is better at that job. The app has its own order: the higher `rate`, then the
 * higher `role_gap`, as at a tie-break of plan sec. 2.5. No source proves that the rate predicts
 * anything, so the draw must test the known faults: the rate follows the body, a drawback has no
 * price, and many sizes have no field. So the draw keeps those cards, and it has quotas for them.
 *
 * The page gets only the key, the job and the cards, so the round stays blind. The question file
 * holds the rest, with the checksum of `card_rates` and the build, so a later `rate-fit` cannot move
 * the result. `owner_decisions` has no kind for this round, and a new kind needs a migration and
 * src/graph/ownerDecisions.ts, so an answer has the kind `link_rule` and the key prefix `rr1:`, as a
 * `dk:` mark of src/deck/marks.ts has. No tally of the link rounds reads this prefix. The key joins
 * the two cards with `~`: `weakPairKeys` of src/deck/deck.ts reads each key that ends in
 * `supply>demand`, and the newest answer wins, so a `>` here could remove a weak mark of a link.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { isLand } from '../deck/goal.js';
import { shuffle } from '../graph/linkRuleV2.js';
import { DecisionError, type Decision } from '../graph/ownerDecisions.js';
import { features, GAP_LINE, median } from './fit.js';
import { isCostAtom, kindKey, maskedWords, type AtomTest, type RewardAtom } from './groups.js';
import type { ProofCard } from './proof.js';

export const RATE_ROUND_PATH = 'docs/card-rate-round-1-questions.json';
export const RATE_ROUND_PREFIX = 'rr1:';
export const RATE_ROUND_SEED = 20261101;
/** The pass line of the report, set before the first answer. */
export const PASS_SHARE = 0.75;
/** One card is in one pair, and one job is in at most this many pairs, so few cards or jobs cannot set the result. */
export const MAX_GROUP_PAIRS = 2;

export type RoundKind = 'same_group' | 'large_creature';
export type Bodies = 'creature' | 'mixed' | 'neither';
export type Side = 'a' | 'b';
/** The body of the card that the app prefers, against the other card. A card with no creature face has size 0. */
export type BodyOrder = 'larger' | 'equal' | 'smaller' | 'not_read';
export type UnreadSize = 'app' | 'other' | 'both' | 'none';

export const ROUND_COUNTS: Readonly<Record<RoundKind, number>> = { same_group: 30, large_creature: 10 };

interface Quota { bodies: Bodies; pairs: number; rate_differs?: boolean; app_larger?: boolean }
/**
 * The pairs of the kind `same_group`, the rare ones first. On a creature pair the card that the app
 * prefers has the larger body on 131 of 146 pairs of the pool, so a pair with no larger body has its
 * own quota. A pair with one equal rate tests only the tie-break, so these pairs are the minority.
 */
export const SAME_GROUP_QUOTAS: readonly Quota[] = [
  { bodies: 'creature', app_larger: false, pairs: 5 },
  { bodies: 'creature', app_larger: true, rate_differs: true, pairs: 7 },
  { bodies: 'creature', app_larger: true, rate_differs: false, pairs: 3 },
  { bodies: 'neither', rate_differs: true, pairs: 5 },
  { bodies: 'neither', rate_differs: false, pairs: 3 },
  { bodies: 'mixed', rate_differs: true, pairs: 5 },
  { bodies: 'mixed', rate_differs: false, pairs: 2 },
];
/** A draw with fewer pairs on a fault does not test it. The next seed gives a new draw. */
export const MIN_COVER = { app_drawback: 8, unread_size: 8 };

/** What the owner reads, above the first pair. The file holds these words, so the page and the seal cannot differ. */
export const ROUND_RULE = {
  test: 'This round tests the card rate: a number that the app gives each card from its text and its printed cost. It is not a win rate. The app has its own order for each pair, and the page does not show that order.',
  pairs: 'The round has 40 pairs. In each pair, both cards do one job and have one mana value. 30 pairs come from a random draw. The other 10 pairs test one known limit of the rate. The page does not show which pair is of which kind.',
  question: 'Read the two full card texts, and use your own Magic knowledge. Which card is better at this job, in a deck that wants this effect? Do not think about links: this round asks only about quality.',
  pass_line: 'The pass line: the app agrees on at least 75% of the pairs where you choose a side. "Card A is better" and "Card B is better" choose a side. "About equal", "I cannot compare" and a free answer do not count. Claude counts when each pair has an answer.',
  effect: 'Your answers change nothing in the app now. If the round fails, the "Card rate" switch stays off by default, and the deck page says that the rate failed its check. You then decide what comes next. If the round passes, nothing changes until you decide. The app sealed its order before your first answer, so a later change of the app cannot change this result. If no button fits, press "Other" and write your own answer.',
};

export const RATE_CHOICES = ['a_better', 'b_better', 'equal', 'cannot_compare', 'other'] as const;

/** One spell of `card_rates`, with what the draw reads from the card record. */
export interface RoundRow {
  oracle_id: string; name: string; rate: number | null; role_gap: number | null; predicted_mana: number | null; printed_mana: number; group_key: string | null;
  /** The faces with a mana cost. A pair needs one, or "one printed mana" is not what the owner reads. */
  costs: number;
  creature: boolean;
  /** Power plus toughness. Null: the card is not a creature, or the printed body has a `*`. */
  body: number | null;
}

/** The two cards of a pair, in the order of the app. */
export interface PoolPair { app: RoundRow; other: RoundRow; bodies: Bodies; rate_differs: boolean; app_body: BodyOrder }
export interface DrawnPair extends PoolPair { kind: RoundKind; app_side: Side }

export interface RoundSide { oracle_id: string; name: string; rate: number; role_gap: number; predicted_mana: number; quote: string }
export interface RoundPair {
  key: string; kind: RoundKind; bodies: Bodies; rate_differs: boolean; group_key: string; printed_mana: number;
  a: RoundSide; b: RoundSide; app_side: Side; app_body: BodyOrder;
  /** The card that the app prefers has a cost or a limit atom. */
  app_drawback: boolean;
  unread_size: UnreadSize;
}
export interface RateSeal { build: number; checksum: string; rows: number }
export interface OrderChecks {
  /** The pairs with the card of the app on side A, by kind. */
  app_on_a: Record<RoundKind, number>;
  /** The longest run of one side down the page. */
  longest_run: number;
  /** The page numbers of the pairs where the words of one card are all on the other card. */
  text_inside: number[];
  /** The page numbers of the pairs where the card of the app has the larger body. */
  app_larger_body: number[];
  /** The pairs with no marked text, because the quote of one card is not in its text. */
  no_mark: number[];
}
export interface RateRound {
  source: string; seed: number; made_at: string; seal: RateSeal; rule: typeof ROUND_RULE;
  pools: { same_group: number; large_creature: number }; checks: OrderChecks; pairs: RoundPair[];
}

export interface RoundFace { name: string; mana_cost: string | null; type_line: string; oracle_text: string; power: string | null; toughness: string | null }
export interface RoundCard { name: string; image: string | null; quote: string; faces: RoundFace[] }
/** The job in the words of the group key. */
export interface RoundJob { type: string; params: Record<string, unknown>; ability: string }
export interface RateRoundItem { key: string; job: RoundJob; a: RoundCard; b: RoundCard }
export interface RateRoundPage { rule: typeof ROUND_RULE | null; items: RateRoundItem[] }

interface FaceRow extends RoundFace { image_normal: string | null }
export const facesOf = (db: DatabaseSync, oracleId: string) => db.prepare(
  'SELECT name, mana_cost, type_line, oracle_text, power, toughness, image_normal FROM card_faces WHERE oracle_id = ? ORDER BY face_index',
).all(oracleId) as unknown as FaceRow[];

const readSize = (s: string | null) => (s !== null && /^\d+$/.test(s) ? Number(s) : null);

/** The spells of `card_rates` on Arena now. A card with a new text has a new hash, so its rate is not its text. */
export function loadRoundRows(db: DatabaseSync): RoundRow[] {
  const rows = db.prepare(
    `SELECT r.oracle_id, c.name, c.type_line, r.rate, r.role_gap, r.predicted_mana, r.printed_mana, r.group_key
       FROM card_rates r JOIN cards c ON c.oracle_id = r.oracle_id AND c.oracle_hash = r.oracle_hash
      WHERE c.arena_id IS NOT NULL AND c.rotated = 0 ORDER BY r.oracle_id`,
  ).all() as unknown as Array<Omit<RoundRow, 'costs' | 'creature' | 'body'> & { type_line: string }>;
  return rows.filter((r) => !isLand(r.type_line)).map(({ type_line: _, ...r }) => {
    const costed = facesOf(db, r.oracle_id).filter((f) => f.mana_cost);
    const front = costed.find((f) => /\bCreature\b/.test(f.type_line));
    const [power, toughness] = [readSize(front?.power ?? null), readSize(front?.toughness ?? null)];
    return { ...r, costs: costed.length, creature: front !== undefined, body: power === null || toughness === null ? null : power + toughness };
  });
}

/** The order of plan sec. 2.5: the rate, then the gap. */
export function appOrder(x: RoundRow, y: RoundRow): [RoundRow, RoundRow] {
  const first = x.rate! !== y.rate! ? x.rate! > y.rate! : x.role_gap! > y.role_gap!;
  return first ? [x, y] : [y, x];
}

const sizeOf = (r: RoundRow) => (r.creature ? r.body : 0);

export function bodyOrder(app: RoundRow, other: RoundRow): BodyOrder {
  const [a, b] = [sizeOf(app), sizeOf(other)];
  if (a === null || b === null) return 'not_read';
  return a > b ? 'larger' : a < b ? 'smaller' : 'equal';
}

const canPair = (r: RoundRow) => r.rate !== null && r.role_gap !== null && r.group_key !== null && r.costs === 1;

/** Each pair of two cards with one best group and one printed mana, and a gap difference of at least `GAP_LINE`. */
export function pairPool(rows: readonly RoundRow[]): PoolPair[] {
  const byGroup = new Map<string, RoundRow[]>();
  for (const r of rows.filter(canPair)) {
    const key = JSON.stringify([r.group_key, r.printed_mana]);
    byGroup.set(key, [...(byGroup.get(key) ?? []), r]);
  }
  const pool: PoolPair[] = [];
  for (const list of byGroup.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (Math.abs(list[i]!.role_gap! - list[j]!.role_gap!) < GAP_LINE) continue;
        const [app, other] = appOrder(list[i]!, list[j]!);
        const bodies: Bodies = app.creature && other.creature ? 'creature' : app.creature || other.creature ? 'mixed' : 'neither';
        pool.push({ app, other, bodies, rate_differs: app.rate !== other.rate, app_body: bodyOrder(app, other) });
      }
    }
  }
  return pool;
}

/** The median body of the creatures of each printed mana. */
export function bodyMedians(rows: readonly RoundRow[]): Map<number, number> {
  const sizes = new Map<number, number[]>();
  for (const r of rows) if (r.creature && r.body !== null) sizes.set(r.printed_mana, [...(sizes.get(r.printed_mana) ?? []), r.body]);
  return new Map([...sizes].map(([m, v]) => [m, median(v)]));
}

/** Results Task 4: a creature above 0 with a body above the median of its mana, against a card with no creature face. */
export function isLargePair(p: PoolPair, medians: ReadonlyMap<number, number>): boolean {
  const { app, other } = p;
  return app.creature && !other.creature && app.rate! > 0 && app.body !== null && app.body > medians.get(app.printed_mana)!;
}

const fits = (q: Quota) => (p: PoolPair) => p.bodies === q.bodies
  && (q.rate_differs === undefined || p.rate_differs === q.rate_differs)
  && (q.app_larger === undefined || (p.app_body === 'larger') === q.app_larger);

/** The pairs of the round in page order. Each side comes from `rand`, with half of each kind on side A. */
export function drawRound(rows: readonly RoundRow[], rand: () => number): { pairs: DrawnPair[]; pools: Record<RoundKind, number> } {
  const pool = pairPool(rows);
  const medians = bodyMedians(rows);
  const large = pool.filter((p) => isLargePair(p, medians));
  const rest = pool.filter((p) => !isLargePair(p, medians));
  const used = new Set<string>();
  const perGroup = new Map<string, number>();
  const take = (list: readonly PoolPair[], n: number): PoolPair[] => {
    const got: PoolPair[] = [];
    for (const p of shuffle([...list], rand)) {
      if (got.length === n) break;
      const g = p.app.group_key!;
      if (used.has(p.app.oracle_id) || used.has(p.other.oracle_id) || (perGroup.get(g) ?? 0) >= MAX_GROUP_PAIRS) continue;
      used.add(p.app.oracle_id).add(p.other.oracle_id);
      perGroup.set(g, (perGroup.get(g) ?? 0) + 1);
      got.push(p);
    }
    return got;
  };
  const sided = (list: readonly PoolPair[], kind: RoundKind): DrawnPair[] => {
    const sides = shuffle(list.map((_, i): Side => (i < list.length / 2 ? 'a' : 'b')), rand);
    return list.map((p, i) => ({ ...p, kind, app_side: sides[i]! }));
  };
  const drawnLarge = sided(take(large, ROUND_COUNTS.large_creature), 'large_creature');
  const drawnSame = sided(SAME_GROUP_QUOTAS.flatMap((q) => take(rest.filter(fits(q)), q.pairs)), 'same_group');
  return { pairs: shuffle([...drawnLarge, ...drawnSame], rand), pools: { same_group: rest.length, large_creature: large.length } };
}

/** Refuses a draw with too few pairs. The next seed gives a new draw. */
export function requireFullRound(pairs: ReadonlyArray<{ kind: RoundKind }>): void {
  const short = (Object.keys(ROUND_COUNTS) as RoundKind[]).filter((k) => pairs.filter((p) => p.kind === k).length !== ROUND_COUNTS[k]);
  if (short.length) throw new Error(`the draw has too few pairs in: ${short.join(', ')}. Use the next seed, and write it in the results`);
}

/** Refuses a draw that does not test the faults. */
export function requireCover(pairs: readonly Pick<RoundPair, 'app_drawback' | 'unread_size'>[]): void {
  const drawback = pairs.filter((p) => p.app_drawback).length;
  const unread = pairs.filter((p) => p.unread_size !== 'none').length;
  if (drawback < MIN_COVER.app_drawback || unread < MIN_COVER.unread_size) {
    throw new Error(`the draw has ${drawback} pairs with a drawback and ${unread} pairs with an unread size. Use the next seed, and write it in the results`);
  }
}

export interface CardFacts { quote: string; drawback: boolean; unread: boolean }

/** The words of the job on a card, and the two faults that the rate cannot price. */
export function cardFacts(card: Pick<ProofCard, 'atoms' | 'fields' | 'faces'>, groupKey: string, reward: AtomTest): CardFacts {
  const a: RewardAtom | undefined = card.atoms.find((x) => reward(x) && kindKey(x) === groupKey);
  return {
    quote: a?.quote ?? '',
    drawback: card.atoms.some((x) => x.family === 'CONSTRAINTS' || isCostAtom(x)),
    unread: [...features(card).keys()].some((k) => k.endsWith('?')),
  };
}

const sideOf = (r: RoundRow, quote: string): RoundSide =>
  ({ oracle_id: r.oracle_id, name: r.name, rate: r.rate!, role_gap: r.role_gap!, predicted_mana: r.predicted_mana!, quote });

/** The side, the key and the facts of each pair. A mark on one card alone can look like an answer, so a pair marks both cards or neither. */
export function finishPairs(drawn: readonly DrawnPair[], factsOf: (oracleId: string, groupKey: string) => CardFacts, textOf: (oracleId: string) => string): RoundPair[] {
  return drawn.map((p) => {
    const group_key = p.app.group_key!;
    const [app, other] = [factsOf(p.app.oracle_id, group_key), factsOf(p.other.oracle_id, group_key)];
    const marked = Boolean(app.quote) && Boolean(other.quote) && textOf(p.app.oracle_id).includes(app.quote) && textOf(p.other.oracle_id).includes(other.quote);
    const [appSide, otherSide] = [sideOf(p.app, marked ? app.quote : ''), sideOf(p.other, marked ? other.quote : '')];
    const [a, b] = p.app_side === 'a' ? [appSide, otherSide] : [otherSide, appSide];
    return {
      key: `${RATE_ROUND_PREFIX}${a.oracle_id}~${b.oracle_id}`, kind: p.kind, bodies: p.bodies, rate_differs: p.rate_differs, group_key, printed_mana: p.app.printed_mana,
      a, b, app_side: p.app_side, app_body: p.app_body, app_drawback: app.drawback,
      unread_size: app.unread ? (other.unread ? 'both' : 'app') : other.unread ? 'other' : 'none',
    };
  });
}

const wordsOf = (text: string, name: string) => new Set(maskedWords(text, name).toLowerCase().split(/[^\p{L}\p{N}~]+/u).filter(Boolean));

/** The traits on the page that can show the order of the app. Nothing here reads an answer. */
export function orderChecks(pairs: readonly RoundPair[], textOf: (oracleId: string) => string): OrderChecks {
  const inside = (x: ReadonlySet<string>, y: ReadonlySet<string>) => [...x].every((w) => y.has(w));
  const numbers = (test: (p: RoundPair) => boolean) => pairs.flatMap((p, i) => (test(p) ? [i + 1] : []));
  let [run, longest] = [0, 0];
  pairs.forEach((p, i) => {
    run = i > 0 && pairs[i - 1]!.app_side === p.app_side ? run + 1 : 1;
    longest = Math.max(longest, run);
  });
  const onA = (k: RoundKind) => pairs.filter((p) => p.kind === k && p.app_side === 'a').length;
  return {
    app_on_a: { same_group: onA('same_group'), large_creature: onA('large_creature') },
    longest_run: longest,
    text_inside: numbers((p) => {
      const [a, b] = [wordsOf(textOf(p.a.oracle_id), p.a.name), wordsOf(textOf(p.b.oracle_id), p.b.name)];
      return inside(a, b) || inside(b, a);
    }),
    app_larger_body: numbers((p) => p.app_body === 'larger'),
    no_mark: numbers((p) => !p.a.quote),
  };
}

/** The value of `Task 4`: the rows of the table in `oracle_id` order, as JSON. */
export function rateChecksum(db: DatabaseSync): string {
  const rows = db.prepare('SELECT * FROM card_rates ORDER BY oracle_id').all();
  return createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex').slice(0, 16);
}

/** The table holds one build (`writeRates`). */
export function rateSeal(db: DatabaseSync): RateSeal {
  const builds = db.prepare('SELECT build_id, COUNT(*) n FROM card_rates GROUP BY build_id').all() as unknown as Array<{ build_id: number; n: number }>;
  if (builds.length !== 1) throw new Error(`card_rates holds ${builds.length} builds, and a seal needs one. Run npm run rate-fit`);
  return { build: builds[0]!.build_id, checksum: rateChecksum(db), rows: builds[0]!.n };
}

export const loadRateRound = (path: string = RATE_ROUND_PATH): RateRound | null =>
  (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as RateRound : null);

/** A group key is `FAMILY.TYPE {params} kind`. */
export function jobOf(groupKey: string): RoundJob {
  const m = /^(\S+) (\{.*\}) (\S+)$/.exec(groupKey);
  if (!m) throw new Error(`"${groupKey}" is not a group key`);
  return { type: m[1]!, params: JSON.parse(m[2]!) as Record<string, unknown>, ability: m[3]! };
}

function roundCard(db: DatabaseSync, oracleId: string, quote: string): RoundCard {
  const c = db.prepare('SELECT name, image_normal FROM cards WHERE oracle_id = ?').get(oracleId) as { name: string; image_normal: string | null };
  const faces = facesOf(db, oracleId);
  return {
    name: c.name, image: c.image_normal ?? faces[0]?.image_normal ?? null, quote,
    faces: faces.map(({ name, mana_cost, type_line, oracle_text, power, toughness }) => ({ name, mana_cost, type_line, oracle_text, power, toughness })),
  };
}

/** What the page gets. This list names each field, so no sealed value can reach the owner. */
export function rateRoundPage(db: DatabaseSync, path: string = RATE_ROUND_PATH): RateRoundPage {
  const round = loadRateRound(path);
  if (!round) return { rule: null, items: [] };
  return {
    rule: round.rule,
    items: round.pairs.map((p) => ({ key: p.key, job: jobOf(p.group_key), a: roundCard(db, p.a.oracle_id, p.a.quote), b: roundCard(db, p.b.oracle_id, p.b.quote) })),
  };
}

/** Records (or replaces) one answer. The answer changes nothing else. */
export function saveRateAnswer(db: DatabaseSync, d: { item_key: string; choice: string; note?: string }, path: string = RATE_ROUND_PATH): Decision {
  if (!loadRateRound(path)?.pairs.some((p) => p.key === d.item_key)) throw new DecisionError(`no rate round pair "${d.item_key}"`);
  if (!(RATE_CHOICES as readonly string[]).includes(d.choice)) throw new DecisionError(`"${d.choice}" is not an answer for this item: use ${RATE_CHOICES.join(', ')}`);
  const note = (d.note ?? '').trim();
  if (d.choice === 'other' && !note) throw new DecisionError('a free answer needs a note');
  return storeAnswer(db, d.item_key, d.choice, note);
}

function storeAnswer(db: DatabaseSync, key: string, choice: string, note: string): Decision {
  const out: Decision = { kind: 'link_rule', item_key: key, choice, note, decided_at: new Date().toISOString() };
  db.prepare('INSERT OR REPLACE INTO owner_decisions (kind, item_key, choice, note, decided_at) VALUES (?, ?, ?, ?, ?)')
    .run(out.kind, out.item_key, out.choice, out.note, out.decided_at);
  return out;
}

/**
 * Why-questions after the round: as the `lrf:` follow-ups of the link rounds, one question on one
 * earlier answer. A pair asks which card is the better whole card, with a reason. An item with no
 * pair asks about the whole round. No tally reads `rrf:`, so the sealed result does not move.
 */
export const RATE_FOLLOW_UP_PATH = 'docs/card-rate-round-1-follow-up.json';
export const RATE_FOLLOW_UP_PREFIX = 'rrf:';
export const ROUND_QUESTION_CHOICES = ['yes', 'sometimes', 'no', 'other'] as const;

interface FollowUp { key: string; ask: string; pair?: number; a?: string; b?: string; your_answer?: string }
interface FollowUpFile { source: string; intro: string[]; items: FollowUp[] }
export interface RateFollowUpItem { key: string; ask: string; pair: number | null; your_answer: string | null; a: RoundCard | null; b: RoundCard | null }
export interface RateFollowUpPage { intro: string[]; items: RateFollowUpItem[] }

const loadFollowUp = (path: string): FollowUpFile | null =>
  (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as FollowUpFile : null);

export function rateFollowUpPage(db: DatabaseSync, path: string = RATE_FOLLOW_UP_PATH): RateFollowUpPage {
  const file = loadFollowUp(path);
  if (!file) return { intro: [], items: [] };
  return {
    intro: file.intro,
    items: file.items.map((f) => ({
      key: f.key, ask: f.ask, pair: f.pair ?? null, your_answer: f.your_answer ?? null,
      a: f.a ? roundCard(db, f.a, '') : null, b: f.b ? roundCard(db, f.b, '') : null,
    })),
  };
}

/** A pair needs a reason: the reason is the point of the question. */
export function saveRateFollowUp(db: DatabaseSync, d: { item_key: string; choice: string; note?: string }, path: string = RATE_FOLLOW_UP_PATH): Decision {
  const item = loadFollowUp(path)?.items.find((i) => i.key === d.item_key);
  if (!item) throw new DecisionError(`no rate follow-up "${d.item_key}"`);
  const choices: readonly string[] = item.pair === undefined ? ROUND_QUESTION_CHOICES : RATE_CHOICES;
  if (!choices.includes(d.choice)) throw new DecisionError(`"${d.choice}" is not an answer for this item: use ${choices.join(', ')}`);
  const note = (d.note ?? '').trim();
  if (!note && (item.pair !== undefined || d.choice === 'other')) throw new DecisionError('this answer needs a reason in the box');
  return storeAnswer(db, d.item_key, d.choice, note);
}

export interface RoundAnswer { choice: string; note: string }

export function loadRoundAnswers(db: DatabaseSync): Map<string, RoundAnswer> {
  const rows = db.prepare("SELECT item_key, choice, note FROM owner_decisions WHERE kind = 'link_rule' AND item_key LIKE 'rr1:%'").all() as unknown as Array<RoundAnswer & { item_key: string }>;
  return new Map(rows.map((r) => [r.item_key, { choice: r.choice, note: r.note }]));
}

export interface TallyRow { name: string; pairs: number; sides: number; agree: number; share: number | null; equal: number; cannot: number; other: number; open: number }

/** The rows of `--tally`. The first row is the row of the pass line. The others show where a result comes from. */
const TALLY_ROWS: ReadonlyArray<readonly [string, (p: RoundPair) => boolean]> = [
  ['all pairs', () => true],
  ['creature pairs', (p) => p.bodies === 'creature'],
  ['other pairs', (p) => p.bodies !== 'creature'],
  ['same group', (p) => p.kind === 'same_group'],
  ['large creature', (p) => p.kind === 'large_creature'],
  ['the rate differs', (p) => p.rate_differs],
  ['only the gap differs', (p) => !p.rate_differs],
  ['no creature in the pair', (p) => p.bodies === 'neither'],
  ['creature pairs, app card not larger', (p) => p.bodies === 'creature' && p.app_body !== 'larger'],
  ['app card has a drawback', (p) => p.app_drawback],
  ['a card has an unread size', (p) => p.unread_size !== 'none'],
];

export function tallyRound(pairs: readonly RoundPair[], answers: ReadonlyMap<string, RoundAnswer>): TallyRow[] {
  return TALLY_ROWS.map(([name, test]) => {
    const list = pairs.filter(test);
    const choices = list.map((p) => answers.get(p.key)?.choice);
    const count = (c: string) => choices.filter((x) => x === c).length;
    const sides = count('a_better') + count('b_better');
    const agree = list.filter((p) => answers.get(p.key)?.choice === `${p.app_side}_better`).length;
    return {
      name, pairs: list.length, sides, agree, share: sides ? agree / sides : null,
      equal: count('equal'), cannot: count('cannot_compare'), other: count('other'), open: choices.filter((x) => x === undefined).length,
    };
  });
}

/** The sealed rule: the first row of `tallyRound`, when each pair has an answer. */
export function roundResult(all: TallyRow): 'wait' | 'no side' | 'pass' | 'fail' {
  if (all.open > 0) return 'wait';
  if (all.sides === 0) return 'no side';
  return all.agree >= PASS_SHARE * all.sides ? 'pass' : 'fail';
}

export interface RoundNote { pair: number; a: string; b: string; kind: RoundKind; choice: string; app_side: Side; note: string }

export function roundNotes(pairs: readonly RoundPair[], answers: ReadonlyMap<string, RoundAnswer>): RoundNote[] {
  return pairs.flatMap((p, i) => {
    const a = answers.get(p.key);
    return a?.note ? [{ pair: i + 1, a: p.a.name, b: p.b.name, kind: p.kind, choice: a.choice, app_side: p.app_side, note: a.note }] : [];
  });
}
