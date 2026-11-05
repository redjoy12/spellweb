/**
 * Round 2 of the owner pairs (plan 2026-10-31-schema-v17 Task 7, docs/schema-v17-review-2.md sec. 10).
 * The owner answers 40 single pairs on links into `PRODUCES.SACRIFICE` and `CARES_ABOUT.DESCENDED`.
 * These groups are not tests of V2_TESTS: no gate reads them until Task 8.
 *
 * Unit: a card pair A -> B on one build, with `confirmed` `+` edges, explicit and class. A pair is in
 * a group when all its confirmed `+` edges are in that group and no plausible `+` edge is in another
 * group, so that an answer speaks for that group only. The page never gets a group name.
 */
import { existsSync } from 'node:fs';
import type { BuildIndex } from './buildIndex.js';
import { mergeEdges } from './merge.js';

/** The groups of the sample, in the draw order, each with its kind and its number of pairs. */
export const LINK_GROUPS = {
  descended_battlefield: { kind: 'descended_battlefield', sample: 5 },
  descended_other: { kind: 'descended_other', sample: 5 },
  forced_you: { kind: 'forced', sample: 5 },
  forced_any: { kind: 'forced', sample: 5 },
  choice: { kind: 'choice', sample: 10 },
  cost: { kind: 'cost', sample: 10 },
} as const;
export type LinkGroup = keyof typeof LINK_GROUPS;
export const GROUP_ORDER = Object.keys(LINK_GROUPS) as LinkGroup[];
export const GROUP_COUNTS = Object.fromEntries(GROUP_ORDER.map((g) => [g, LINK_GROUPS[g].sample])) as Record<LinkGroup, number>;

/** Each kind of the result rule, with the counted new answers that it needs. */
export const ROUND_2_KINDS = {
  cost: { groups: ['cost'], asked: 10, min_counted: 8 },
  choice: { groups: ['choice'], asked: 10, min_counted: 8 },
  forced: { groups: ['forced_you', 'forced_any'], asked: 10, min_counted: 8 },
  descended_battlefield: { groups: ['descended_battlefield'], asked: 5, min_counted: 4 },
  descended_other: { groups: ['descended_other'], asked: 5, min_counted: 4 },
} as const;
export type Round2Kind = keyof typeof ROUND_2_KINDS;

/** The seed of the sample. If a draw has too few pairs, the next seed is used and written in the results. */
export const ROUND_2_SEED = 20261101;
/** The share of "no" answers at which the gate removes a kind (plan Task 7 step 5). */
export const REMOVE_SHARE = 0.75;

/** Review 1 sec. 8, problem 5: an additional cost with an alternative. The `decision` of these atoms is open. */
export const OPEN_ATOMS: ReadonlySet<number> = new Set([55022, 55023, 55026, 55038, 55039, 55090, 55211, 55215, 55962, 55966]);

/** Review 2 sec. 3, R2-5: the supply atoms that the CR text already decides for the new demand. */
export const WIDE_ATOMS: ReadonlySet<number> = new Set([
  45064, 45355, 45927, 46134, 46555, 47559, 49228, 49650, 50260, 51157, 51315, 52083, 52166, 52599, 52891, 52911, 53244, 53556,
  53628, 53807, 53893, 53968, 54020, 54022, 54039, 54140, 54243, 54394, 54589, 54866, 55001, 55285, 55294, 55547, 55801, 55911,
  55989, 56083, 56107, 56136, 56189, 56207, 56337, 56749,
]);

/** The supply types that move a card from a hand or a library (CR 701.9a, 701.17a, 701.25a). */
const HAND_OR_LIBRARY = new Set(['PRODUCES.DISCARD', 'ENABLES.CYCLING', 'PRODUCES.CONNIVE', 'PRODUCES.SURVEIL', 'PRODUCES.MILL',
  'PRODUCES.CARDS_TO_GRAVEYARD', 'PRODUCES.MANIFEST_DREAD', 'PRODUCES.EXPLORE']);

/**
 * Not a group of round 2: `other` is any other demand, `descended_mixed` has supply types of both
 * sides, and `tag` is the tag of round 3 (src/graph/linkRuleRound3.ts).
 */
export type EdgeGroup = LinkGroup | 'descended_mixed' | 'other' | 'tag';

/**
 * The group of one edge, from its demand atom and its supply types. `INTRINSIC` is the supply of a
 * class edge: the only class rule of the new demand is the subtype Saga, which is on the battlefield.
 */
export function edgeGroup(demand: { family: string; type_key: string; params: Record<string, unknown> }, supplyTypes: readonly string[]): EdgeGroup {
  const type = `${demand.family}.${demand.type_key}`;
  if (type === 'CARES_ABOUT.DESCENDED') {
    const hl = supplyTypes.filter((t) => HAND_OR_LIBRARY.has(t)).length;
    return hl === 0 ? 'descended_battlefield' : hl === supplyTypes.length ? 'descended_other' : 'descended_mixed';
  }
  if (type !== 'PRODUCES.SACRIFICE') return 'other';
  const decision = demand.params['decision'];
  if (decision === 'cost' || decision === 'choice') return decision;
  if (decision !== 'forced') return 'other';
  return demand.params['actor'] === 'you' ? 'forced_you' : demand.params['actor'] === 'any' ? 'forced_any' : 'other';
}

/** The `+` edges of one directed card pair. */
export interface PairRecord { confirmed: Set<EdgeGroup>; plausible: Set<EdgeGroup>; open: boolean; wide: boolean }

/** The group of a pair, or null when a rule of the draw leaves it out. */
export function groupOfPair(r: PairRecord): LinkGroup | null {
  if (r.confirmed.size !== 1 || r.open || r.wide) return null;
  const g = [...r.confirmed][0]!;
  if (g === 'other' || g === 'descended_mixed' || g === 'tag') return null;
  return [...r.plausible].every((p) => p === g) ? g : null;
}

export const pairKey = (supply: string, demand: string) => `${supply}>${demand}`;

/** The `+` edges of a build for each directed card pair, with the two exclusion lists. */
export function pairRecords(index: BuildIndex, groupOf: typeof edgeGroup = edgeGroup): Map<string, PairRecord> {
  const out = new Map<string, PairRecord>();
  const put = (s: string, d: string, g: EdgeGroup, confirmed: boolean, open: boolean, wide: boolean) => {
    if (s === d) return;
    const k = pairKey(s, d);
    const r = out.get(k) ?? out.set(k, { confirmed: new Set(), plausible: new Set(), open: false, wide: false }).get(k)!;
    (confirmed ? r.confirmed : r.plausible).add(g);
    r.open ||= open;
    r.wide ||= wide;
  };
  for (const c of index.cards()) {
    const ae = index.cardAtomEdges(c);
    for (const e of mergeEdges(ae.supply, index.ctx)) {
      if (e.polarity !== '+') continue;
      const d = index.atoms.get(e.demand_atom_id)!;
      const supply = e.atom_ids.filter((id) => id !== e.demand_atom_id);
      const g = groupOf(d, supply.map((id) => { const a = index.atoms.get(id)!; return `${a.family}.${a.type_key}`; }));
      put(e.supply_oracle!, e.demand_oracle, g, e.grade === 'confirmed', e.atom_ids.some((id) => OPEN_ATOMS.has(id)),
        g.startsWith('descended') && supply.some((id) => WIDE_ATOMS.has(id)));
    }
    for (const e of mergeEdges(ae.classes, index.ctx)) {
      if (e.polarity !== '+') continue;
      const g = groupOf(index.atoms.get(e.demand_atom_id)!, ['INTRINSIC']);
      for (const m of index.classes.get(e.class_id!)!.members) put(m, e.demand_oracle, g, e.grade === 'confirmed', OPEN_ATOMS.has(e.demand_atom_id), false);
    }
  }
  return out;
}

/** The pool of each group: the pairs of that group that nobody asked. */
export function round2Pools(records: ReadonlyMap<string, PairRecord>, asked: ReadonlySet<string>): Map<LinkGroup, Array<{ supply: string; demand: string }>> {
  const pools = new Map<LinkGroup, Array<{ supply: string; demand: string }>>(GROUP_ORDER.map((g) => [g, []]));
  for (const [k, r] of records) {
    const g = asked.has(k) ? null : groupOfPair(r);
    if (!g) continue;
    const [supply, demand] = k.split('>') as [string, string];
    pools.get(g)!.push({ supply, demand });
  }
  return pools;
}

/** Refuses a sample file that exists: the answers of a pair stay with that file. */
export function requireNoSampleFile(path: string): void {
  if (existsSync(path)) throw new Error(`${path} exists: a new draw must not replace a sample that the owner can answer`);
}

/** Refuses a draw with too few pairs. The next seed gives a new draw. */
export function requireFullDraw(pairs: ReadonlyArray<{ kind: LinkGroup }>): void {
  const short = GROUP_ORDER.filter((g) => pairs.filter((p) => p.kind === g).length !== GROUP_COUNTS[g]);
  if (short.length) throw new Error(`the draw has too few pairs in: ${short.join(', ')}. Use the next seed, and write it in the results`);
}

export interface Round2Answer { choice: string; note: string }
export interface Round2Label { owner: 'yes' | 'weak' | 'no' | 'anti'; group: string | null }
export interface Round2Row {
  kind: string; asked: number; earlier: { real: number; no: number };
  yes: number; weak: number; no: number; anti: number; unsure: number; other: number; open: number;
  counted: number; no_share: number; result: 'wait' | 'draw more' | 'remove' | 'keep';
}

/**
 * The result rule of plan Task 7 step 5. `labels`: the earlier owner labels, each with the group of
 * its pair; a label that the rules of the draw leave out has no group, so it does not count here.
 * `minus`: a kind of `-` links, so only "works against" is real, and each other counted answer is a "no".
 */
export function tallyRound2(pairs: ReadonlyArray<{ key: string; kind: string }>, answers: ReadonlyMap<string, Round2Answer>, labels: readonly Round2Label[],
  kinds: Readonly<Record<string, { groups: readonly string[]; min_counted: number; minus?: boolean }>> = ROUND_2_KINDS): Round2Row[] {
  return Object.keys(kinds).map((kind) => {
    const { groups, minus } = kinds[kind]!;
    const mine = pairs.filter((p) => groups.includes(p.kind));
    const got = mine.map((p) => answers.get(p.key)?.choice);
    const count = (c: string) => got.filter((x) => x === c).length;
    const old = labels.filter((l) => l.group !== null && groups.includes(l.group));
    const isReal = (l: Round2Label) => (minus ? l.owner === 'anti' : l.owner === 'yes' || l.owner === 'weak');
    const earlier = { real: old.filter(isReal).length, no: old.filter((l) => !isReal(l)).length };
    const row = { yes: count('link'), weak: count('weak_link'), no: count('no_link'), anti: count('anti'), unsure: count('unsure'), other: count('other') };
    const counted = row.yes + row.weak + row.no + row.anti;
    const newReal = minus ? row.anti : row.yes + row.weak;
    const real = earlier.real + newReal;
    const no = earlier.no + counted - newReal;
    const noShare = real + no ? no / (real + no) : 0;
    const open = got.filter((x) => x === undefined).length;
    const result = open > 0 ? 'wait' : counted < kinds[kind]!.min_counted ? 'draw more' : noShare >= REMOVE_SHARE ? 'remove' : 'keep';
    return { kind, asked: mine.length, earlier, ...row, open, counted, no_share: noShare, result };
  });
}
