/**
 * Round 3 of the owner pairs (plan 2026-10-31-schema-v17 Task 17): 10 single pairs of the new links
 * of one v19 tag, with the draw rules and the result rule of Task 7, and extra pairs of the two
 * supply kinds that the limit of the tag does not have (the owner answer of 2026-10-31). The Blood
 * rules also match a token atom with no subtype, so `blood_rule` draws from all edges of these rules
 * and `blood_token` from the cards that name Blood (docs/schema-v19-results.md sec. 9.9).
 *
 * Unit: a card pair A -> B on one build, with `confirmed` `+` edges, explicit and class. A pair is in
 * the pool when all its confirmed `+` edges end on the tag and no plausible `+` edge ends on another
 * type, so that an answer speaks for the tag only. The page never gets the kind.
 *
 * Round 4 (plan Task 18) uses the same pool and the same result rule, with 10 pairs for each of the
 * other five tags, in the order of plan section 9.1, and one extra pair for some supply types of the
 * two tags over their limit (`pickTagPairs`).
 */
import { BECOMES_TAPPED_TAG, CARD_DRAW_TAG, COMMIT_CRIME_TAG, DEALT_DAMAGE_TAG, LEAVES_GRAVEYARD_TAG } from '../atoms/schemaV19.js';
import { pickLinkPairs, shuffle, type LinkPair } from './linkRuleV2.js';
import { pairKey, type EdgeGroup, type PairRecord } from './linkRuleRound2.js';

export const ROUND_3_KIND = 'discard';
export const ROUND_3_SAMPLE = 10;
export const ROUND_3_COUNTS = { [ROUND_3_KIND]: ROUND_3_SAMPLE };

/** The extra kinds: all edges of a pair have this supply type. They are not part of the 10. The draw order is this order. */
export const ROUND_3_EXTRA = {
  blood_rule: { supply: 'PRODUCES.CREATE', sample: 2 },
  connive: { supply: 'PRODUCES.CONNIVE', sample: 2 },
  blood_token: { supply: 'PRODUCES.CREATE', sample: 1 },
} as const;
export type ExtraKind = keyof typeof ROUND_3_EXTRA;
/** The subtype that the Blood rules name. A card names it when its atom has this value in `subtypes`. */
export const BLOOD = 'Blood';
export const EXTRA_KINDS = Object.keys(ROUND_3_EXTRA) as ExtraKind[];
const EXTRA_COUNTS = Object.fromEntries(EXTRA_KINDS.map((k) => [k, ROUND_3_EXTRA[k].sample])) as Record<ExtraKind, number>;

/** The result rule of plan Task 7 step 5: at least 8 counted new answers of 10. An extra kind counts all its answers. */
export const ROUND_3_KINDS = {
  [ROUND_3_KIND]: { groups: [ROUND_3_KIND], min_counted: 8 },
  ...Object.fromEntries(EXTRA_KINDS.map((k) => [k, { groups: [k], min_counted: ROUND_3_EXTRA[k].sample }])),
};

/** The edge group function of `pairRecords` for one tag, and for one supply type of that tag when `supply` is set. */
export function tagEdgeGroup(tag: string, supply?: string) {
  return (demand: { family: string; type_key: string }, supplyTypes: readonly string[]): EdgeGroup =>
    (`${demand.family}.${demand.type_key}` === tag && (!supply || supplyTypes.every((t) => t === supply)) ? 'tag' : 'other');
}

export function isTagPair(r: PairRecord): boolean {
  return r.confirmed.size === 1 && r.confirmed.has('tag') && !r.open && [...r.plausible].every((p) => p === 'tag');
}

/** A pair with no confirmed `+` edge, and only plausible `+` edges on the tag (plan Task 18: CARD_DRAW). */
export function isPlausibleTagPair(r: PairRecord): boolean {
  return r.confirmed.size === 0 && !r.open && r.plausible.size === 1 && r.plausible.has('tag');
}

/** The pool: the pairs of the tag that nobody asked. */
export function tagPool(records: ReadonlyMap<string, PairRecord>, asked: ReadonlySet<string>, test: (r: PairRecord) => boolean = isTagPair): Array<{ supply: string; demand: string }> {
  const pool: Array<{ supply: string; demand: string }> = [];
  for (const [k, r] of records) {
    if (asked.has(k) || !test(r)) continue;
    const [supply, demand] = k.split('>') as [string, string];
    pool.push({ supply, demand });
  }
  return pool;
}

/**
 * The extra pairs, after the 10, so that they do not change that draw. Only 12 demand cards have a
 * pool, so an extra pair can use a demand card of the 10. It never uses a card of the 10 as its
 * supply, and the extra pairs share no card.
 */
export function pickExtraPairs(pools: ReadonlyMap<ExtraKind, ReadonlyArray<{ supply: string; demand: string }>>, drawn: ReadonlyArray<{ supply: string; demand: string }>,
  rand: () => number): Array<LinkPair<ExtraKind>> {
  const cards = new Set(drawn.flatMap((p) => [p.supply, p.demand]));
  const taken = new Set(drawn.map((p) => pairKey(p.supply, p.demand)));
  const open = new Map(EXTRA_KINDS.map((k) => [k, (pools.get(k) ?? []).filter((p) => !cards.has(p.supply) && !taken.has(pairKey(p.supply, p.demand)))]));
  return pickLinkPairs(open, rand, EXTRA_COUNTS, EXTRA_KINDS);
}

/** Refuses a draw with too few pairs. The next seed gives a new draw. */
export function requireDraw(pairs: ReadonlyArray<{ kind: string }>, counts: Readonly<Record<string, number>>): void {
  for (const [kind, n] of Object.entries(counts)) {
    const got = pairs.filter((p) => p.kind === kind).length;
    if (got !== n) throw new Error(`the draw has ${got} of ${n} pairs of ${kind}. Use the next seed, and write it in the results`);
  }
}

export const requireRound3Draw = (pairs: ReadonlyArray<{ kind: string }>) => requireDraw(pairs, { ...ROUND_3_COUNTS, ...EXTRA_COUNTS });

export interface Round4Row { kind: string; tag: string; sample: number; supply?: string; plausible?: boolean }

const row = (kind: string, tag: string, more: Partial<Round4Row> = {}): Round4Row => ({ kind, tag, sample: ROUND_3_SAMPLE, ...more });
/** An extra kind: one pair for a supply type of 30 or more pairs that the limit of the tag does not list, when a pair has only that type. */
const extra = (kind: string, tag: string, supply: string, plausible = false): Round4Row => ({ kind, tag, supply, sample: 1, plausible });

/**
 * The kinds of round 4, in the draw order: the tags in the order of plan section 9.1, and then the
 * extra kinds of the two tags over their limit (docs/schema-v19-results.md sec. 10.4). No rule tests
 * `which` and each demand card with a supply has the value `second`, so CARD_DRAW has no confirmed
 * pair: its pool is the pairs with only a plausible `+` edge on the tag.
 */
export const ROUND_4_ROWS: readonly Round4Row[] = [
  row('leaves_graveyard', LEAVES_GRAVEYARD_TAG),
  row('becomes_tapped', BECOMES_TAPPED_TAG),
  row('card_draw', CARD_DRAW_TAG, { plausible: true }),
  row('commit_crime', COMMIT_CRIME_TAG),
  row('dealt_damage', DEALT_DAMAGE_TAG),
  extra('graveyard_exile', LEAVES_GRAVEYARD_TAG, 'PRODUCES.EXILE'),
  extra('graveyard_mayhem', LEAVES_GRAVEYARD_TAG, 'ENABLES.MAYHEM'),
  extra('graveyard_craft', LEAVES_GRAVEYARD_TAG, 'ENABLES.CRAFT'),
  extra('draw_cycling', CARD_DRAW_TAG, 'ENABLES.CYCLING', true),
  extra('draw_empower_jace', CARD_DRAW_TAG, 'PRODUCES.EMPOWER_JACE', true),
  extra('draw_create', CARD_DRAW_TAG, 'PRODUCES.CREATE', true),
  extra('draw_connive', CARD_DRAW_TAG, 'PRODUCES.CONNIVE', true),
  extra('draw_investigate', CARD_DRAW_TAG, 'PRODUCES.INVESTIGATE', true),
];
export const ROUND_4_ORDER = ROUND_4_ROWS.map((r) => r.kind);
export const ROUND_4_COUNTS = Object.fromEntries(ROUND_4_ROWS.map((r) => [r.kind, r.sample]));
/** The result rule of plan Task 7 step 5, for each tag. An extra kind counts all its answers, and a `remove` of an extra kind is a proposal. */
export const ROUND_4_KINDS = Object.fromEntries(ROUND_4_ROWS.map((r) => [r.kind, { groups: [r.kind], min_counted: r.sample === ROUND_3_SAMPLE ? 8 : r.sample }]));

export const requireRound4Draw = (pairs: ReadonlyArray<{ kind: string }>) => requireDraw(pairs, ROUND_4_COUNTS);

/** The test of a pair of a kind of round 4. */
export const round4Test = (r: Round4Row): ((p: PairRecord) => boolean) => (r.plausible ? isPlausibleTagPair : isTagPair);

/**
 * The draw of round 4, in `order`. Three tags have fewer than 10 demand cards, so "no card in two
 * pairs" cannot hold for them: a demand card can repeat inside its group, which is its tag, and the
 * draw takes the demand card with the fewest pairs. No other card repeats.
 */
export function pickTagPairs<K extends string>(pools: ReadonlyMap<K, ReadonlyArray<{ supply: string; demand: string }>>, rand: () => number,
  counts: Readonly<Record<string, number>>, order: readonly K[], groupOf: (kind: K) => string = (k) => k): Array<LinkPair<K>> {
  const supplies = new Set<string>();
  const demands = new Map<string, Map<string, number>>();
  const demandElsewhere = (card: string, group?: string) => [...demands].some(([g, m]) => g !== group && m.has(card));
  const out: Array<LinkPair<K>> = [];
  for (const kind of order) {
    const group = groupOf(kind);
    const here = demands.get(group) ?? demands.set(group, new Map()).get(group)!;
    const pool = shuffle([...(pools.get(kind) ?? [])], rand);
    for (let left = counts[kind] ?? 0; left > 0; left--) {
      const open = pool.filter((p) => !supplies.has(p.supply) && !supplies.has(p.demand) && !demandElsewhere(p.supply) && !demandElsewhere(p.demand, group));
      if (open.length === 0) break;
      const fewest = Math.min(...open.map((p) => here.get(p.demand) ?? 0));
      const p = open.find((x) => (here.get(x.demand) ?? 0) === fewest)!;
      supplies.add(p.supply);
      here.set(p.demand, (here.get(p.demand) ?? 0) + 1);
      out.push({ kind, ...p });
    }
  }
  return shuffle(out, rand);
}
