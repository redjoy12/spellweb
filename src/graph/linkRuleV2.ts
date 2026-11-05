/**
 * Link rule version 2, draft (owner request 2026-10-25, docs/link-rule-v2-draft.md): measure
 * proxies for the new tests that the owner golden check gives (docs/golden-check-results.md sec. 3).
 *
 * Each test is a filter on one `+` edge: it names the edges that the test removes. A test here is a
 * PROXY: it uses only the atom types and params that the build has. The owner approves the tests;
 * the measure only shows their size. Nothing here changes a build.
 *
 * A card pair is removed by a test when the test removes every `+` edge of the pair.
 */
import type { IndexAtom } from './buildIndex.js';
import type { IntrinsicClass } from './intrinsic.js';

export interface EdgeFacts {
  /** The supply atom, or null for a class edge. */
  supply: IndexAtom | null;
  cls: IntrinsicClass | null;
  demand: IndexAtom;
}

export interface V2Test { id: string; title: string; removes(e: EdgeFacts): boolean }

const type = (a: { family: string; type_key: string }) => `${a.family}.${a.type_key}`;
const supplyType = (e: EdgeFacts) => (e.supply ? type(e.supply) : 'INTRINSIC');

/** Demand types that use any creature or permanent as a carrier (owner: golden 38, 40, 70, 118; link check: Dragonfire Blade). */
const CARRIER = new Set(['ENABLES.EQUIP', 'ENABLES.ATTACH', 'ENABLES.ENCHANT', 'ENABLES.CREW', 'ENABLES.BARGAIN']);
/** Demand types that use a card in a graveyard (owner: golden 67, link check: Midnight Snack, Kavaron). */
const GRAVEYARD_USE = new Set(['ENABLES.RECURSION', 'INTERACTION.GRAVEYARD_HATE', 'ENABLES.FLASHBACK']);
/** Demand types that count objects (owner: golden 7, 23, 63, 99, 111, 152). */
const COUNT = new Set(['CARES_ABOUT.POPULATED_GRAVEYARD', 'CARES_ABOUT.PERMANENT_COUNT']);
/** Supply types that make the counted units themselves (spec 5.9 count test exception). */
const MAKES_UNITS = new Set(['PRODUCES.CREATE', 'PRODUCES.AMASS']);
/** Supplies that act on a chosen target (owner: golden 9, 106; link check: Devoted Duelist). */
const CHOSEN_TARGET = new Set(['PRODUCES.DAMAGE', 'INTERACTION.TARGETED_REMOVAL', 'PRODUCES.DESTROY']);
const DIES = new Set(['CARES_ABOUT.PERMANENT_DIES', 'CARES_ABOUT.LEAVES_BATTLEFIELD']);
/** "Start your engines!" demands (owner: link check Pox Plague, "the value i would gain is soooo little"). */
const SPEED = new Set(['ENABLES.START_YOUR_ENGINES', 'ENABLES.MAX_SPEED']);
const LIFE_LOSS_V2 = new Set(['PRODUCES.DAMAGE', 'PRODUCES.OPPONENT_LIFE_LOSS']);
/** spec sec. 23 item B3: the test of T6 on a build of link gate version 3. The old type has no atom there. */
const losesLife = (e: EdgeFacts) => supplyType(e) === 'PRODUCES.DAMAGE'
  || (supplyType(e) === 'PRODUCES.LIFE_LOSS' && e.supply!.params['player'] !== 'you');

export const V2_TESTS: readonly V2Test[] = [
  {
    id: 'T1', title: 'A card type alone is not a link; a named subtype is (class edges of a card type)',
    removes: (e) => e.cls !== null && e.cls.intrinsic === 'card_type',
  },
  {
    // A variant of T1 for the owner: golden 35 ("two or more spells") is a link, golden 25 and 105 are not.
    id: 'T1b', title: 'As T1, but keep the class edges into "cast a spell" demands',
    removes: (e) => e.cls !== null && e.cls.intrinsic === 'card_type' && type(e.demand) !== 'CARES_ABOUT.SPELL_CAST',
  },
  {
    id: 'T2', title: 'Any creature or permanent is enough for the demand (equip, attach, enchant, crew, bargain)',
    removes: (e) => CARRIER.has(type(e.demand)),
  },
  {
    id: 'T3', title: 'A card in a graveyard is a common resource (recursion, graveyard hate, flashback)',
    removes: (e) => GRAVEYARD_USE.has(type(e.demand)),
  },
  {
    id: 'T4', title: 'A count of objects, unless the supply makes the units itself',
    removes: (e) => COUNT.has(type(e.demand)) && !MAKES_UNITS.has(supplyType(e)),
  },
  {
    id: 'T5', title: 'Damage or removal on a chosen target, into "dies" or "leaves the battlefield"',
    removes: (e) => CHOSEN_TARGET.has(supplyType(e)) && DIES.has(type(e.demand)),
  },
  {
    id: 'T6', title: 'Damage or life loss into "Start your engines!" or max speed (small side value)',
    removes: (e) => (LIFE_LOSS_V2.has(supplyType(e)) || losesLife(e)) && SPEED.has(type(e.demand)),
  },
];

/**
 * The link gate (spec rev. 21 sec. 7.10). The owner answers of 2026-10-31 keep these tests. T1 holds
 * T1b. T5 stays out: its kind has 62.5% "no" answers, under the 75% bar. Version 1 is this list.
 * Version 2 adds the named subtype part of T1: a card-type class edge into a demand that names a
 * subtype stays, for the class members with that subtype (buildIndex.ts). Version 3 (spec sec. 23)
 * has the same tests, and T6 reads PRODUCES.LIFE_LOSS in place of PRODUCES.OPPONENT_LIFE_LOSS. A
 * build stores its version, and the index gives it to `linkGateBlocks`, so an older build loads
 * with its own edges (review 2 R2-7).
 */
const LINK_GATE_TESTS = new Set(['T1', 'T2', 'T3', 'T4', 'T6']);
export const LINK_GATE_VERSION = 3;

/** True when the link gate of `version` removes the `+` edge with these facts (sec. 7.10). */
export function linkGateBlocks(e: EdgeFacts, version: number = LINK_GATE_VERSION): boolean {
  return V2_TESTS.some((t) => LINK_GATE_TESTS.has(t.id) && (t.id === 'T6'
    ? (version >= 3 ? losesLife(e) : LIFE_LOSS_V2.has(supplyType(e))) && SPEED.has(type(e.demand))
    : t.removes(e)));
}

/** sec. 7.10 version 2: the subtype that a demand atom names, or null. */
export function namedSubtype(d: { params: Record<string, unknown> }): string | null {
  const s = d.params['subtype_filter'];
  return typeof s === 'string' && s !== '' ? s : null;
}

/**
 * The kinds of link in the owner pair sample (owner request 2026-10-31). The owner answers one card
 * pair at a time and never sees these names, so the answers give each test without a rule question.
 * A kind holds the pairs that exactly one test removes, so an answer speaks for that test only.
 * `sample`: more pairs where the earlier owner labels are few. `kept`: pairs that no test removes.
 */
export const LINK_KINDS = {
  card_type: { test: 'T1b', sample: 3 },
  spell_type: { test: 'T1, not T1b', sample: 4 },
  carrier: { test: 'T2 without crew', sample: 2 },
  crew: { test: 'T2, crew only', sample: 3 },
  graveyard: { test: 'T3', sample: 4 },
  count: { test: 'T4', sample: 4 },
  target: { test: 'T5', sample: 4 },
  side_value: { test: 'T6', sample: 3 },
  kept: { test: 'no test', sample: 3 },
} as const;
export type LinkKind = keyof typeof LINK_KINDS;

const bitOf = (id: string) => 1 << V2_TESTS.findIndex((t) => t.id === id);

/**
 * The kind of one linked pair, or null when no single test removes it. `mask`: the tests that remove
 * every edge of the pair. `stays`: one edge of the pair passes all tests. `crew`, `other`: the pair
 * has an edge into a crew demand, and an edge into another demand.
 */
export function linkKindOf(p: { mask: number; stays: boolean; crew: boolean; other: boolean }): LinkKind | null {
  if (p.stays) return 'kept';
  if (p.mask === bitOf('T1')) return 'spell_type';
  if (p.mask === (bitOf('T1') | bitOf('T1b'))) return 'card_type';
  if (p.mask === bitOf('T2')) return !p.crew ? 'carrier' : p.other ? null : 'crew';
  if (p.mask === bitOf('T3')) return 'graveyard';
  if (p.mask === bitOf('T4')) return 'count';
  if (p.mask === bitOf('T5')) return 'target';
  if (p.mask === bitOf('T6')) return 'side_value';
  return null;
}

/** Shuffles a list in place with a seeded generator. */
export function shuffle<T>(list: T[], rand: () => number): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  return list;
}

export interface LinkPair<K extends string = LinkKind> { kind: K; supply: string; demand: string }

/** The number of pairs of each kind of the sample of 2026-10-31. */
export const LINK_KIND_COUNTS = Object.fromEntries((Object.keys(LINK_KINDS) as LinkKind[]).map((k) => [k, LINK_KINDS[k].sample])) as Record<LinkKind, number>;

/**
 * The owner sample: for each kind, its number of random pairs (`counts`). No card is in two pairs,
 * so the page does not repeat a card. The small pools go first, unless `order` states the order. The
 * result is in random order, so the kinds mix on the page.
 */
export function pickLinkPairs<K extends string>(pools: Map<K, Array<{ supply: string; demand: string }>>, rand: () => number,
  counts: Readonly<Record<K, number>>, order?: readonly K[]): Array<LinkPair<K>> {
  const used = new Set<string>();
  const out: Array<LinkPair<K>> = [];
  const kinds = order ?? [...pools.keys()].sort((a, b) => pools.get(a)!.length - pools.get(b)!.length);
  for (const kind of kinds) {
    let left = counts[kind];
    for (const p of shuffle([...pools.get(kind)!], rand)) {
      if (left === 0) break;
      if (used.has(p.supply) || used.has(p.demand)) continue;
      used.add(p.supply).add(p.demand);
      out.push({ kind, ...p });
      left--;
    }
  }
  return shuffle(out, rand);
}
