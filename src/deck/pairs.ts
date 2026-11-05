/**
 * The pair table of a build (Phase 4 design sec. 6): `pos`, `anti` and the linked cards of each
 * card, read from `BuildIndex.edgesForCard`. It holds the best edge of each pair, for the reasons
 * of the deck view. It reads the index and does not change it.
 */
import type { BuildIndex } from '../graph/buildIndex.js';
import { cardPairs, type MergedEdge } from '../graph/merge.js';

/** The key prefix of an owner link (link review design sec. 8): it has no rule and no atom. */
export const OWNER_KEY = 'owner:';

/** The best edge of one card pair: the highest weight, then the lower edge key. */
export interface PairLink {
  supply: string; demand: string; weight: number; key: string; grade: MergedEdge['grade'];
  rule_hashes: string[]; atom_ids: number[]; demand_atom_id: number;
  /** The owner answered "Yes, but weak" on this pair, so `weight` is the weak part of the edge weight. */
  weak?: true;
}

/** The pairs with an owner weak answer, as `supply>demand`, and the part of the weight that each keeps. */
export interface WeakPairs { keys: ReadonlySet<string>; factor: number }

export interface PairTable {
  buildId: number | null;
  /** `pos.get(a).get(b)`: the `+` pair from supply `a` to demand `b`. */
  pos: Map<string, Map<string, PairLink>>;
  /** `anti.get(a).get(b)`: the `-` pair of `a` and `b`, in either direction. The map has both orders. */
  anti: Map<string, Map<string, PairLink>>;
  /** The cards with a `+` pair with each card, in both directions. */
  linked: Map<string, Set<string>>;
}

function put(m: Map<string, Map<string, PairLink>>, a: string, b: string, link: PairLink): void {
  let row = m.get(a);
  if (!row) { row = new Map(); m.set(a, row); }
  const old = row.get(b);
  if (!old || link.weight > old.weight || (link.weight === old.weight && link.key < old.key)) row.set(b, link);
}

function bestLink(supply: string, demand: string, edges: MergedEdge[]): PairLink {
  const e = edges.reduce((a, b) => (b.weight.total > a.weight.total || (b.weight.total === a.weight.total && b.key < a.key) ? b : a));
  return {
    supply, demand, weight: e.weight.total, key: e.key, grade: e.grade, rule_hashes: e.rule_hashes, atom_ids: e.atom_ids,
    demand_atom_id: e.demand_atom_id,
  };
}

/** The pairs of `cards`, among `cards` only. A card does not link to itself, and a class edge makes no pair. */
export function pairTable(idx: BuildIndex, cards: Iterable<string>): PairTable {
  const ids = [...new Set(cards)].sort();
  const inTable = new Set(ids);
  const t: PairTable = { buildId: idx.build?.id ?? null, pos: new Map(), anti: new Map(), linked: new Map() };
  const each = (edges: MergedEdge[], visit: (a: string, b: string, l: PairLink) => void) => {
    for (const [k, p] of cardPairs(edges)) {
      const [a, b] = k.split('|') as [string, string];
      if (a !== b && inTable.has(a) && inTable.has(b)) visit(a, b, bestLink(a, b, p.edges));
    }
  };
  const link = (a: string, b: string) => {
    let s = t.linked.get(a);
    if (!s) { s = new Set(); t.linked.set(a, s); }
    s.add(b);
  };
  for (const id of ids) {
    const e = idx.edgesForCard(id);
    each(e.out, (a, b, l) => { put(t.pos, a, b, l); link(a, b); link(b, a); });
    each(e.anti, (a, b, l) => { put(t.anti, a, b, l); put(t.anti, b, a, l); });
  }
  return t;
}

/**
 * A copy of `t` where each pair of `weak` counts for less. The pair keeps its link: it stays in
 * `linked`, so the hub measure and the warnings do not change. `t` does not change, so the server
 * can keep it in memory and read new answers for each deck.
 */
export function withWeakPairs(t: PairTable, weak: WeakPairs): PairTable {
  const pos = new Map(t.pos);
  for (const key of weak.keys) {
    const [a, b] = key.split('>') as [string, string];
    const old = pos.get(a);
    const l = old?.get(b);
    if (l) pos.set(a, new Map(old).set(b, { ...l, weight: l.weight * weak.factor, weak: true }));
  }
  return { ...t, pos };
}

/** `pos(a,b)`: the weight of the `+` pair from `a` to `b`, or 0. */
export const posWeight = (t: PairTable, a: string, b: string): number => t.pos.get(a)?.get(b)?.weight ?? 0;

/** `anti(a,b)`: the weight of the `-` pair of `a` and `b`, or 0. */
export const antiWeight = (t: PairTable, a: string, b: string): number => t.anti.get(a)?.get(b)?.weight ?? 0;

/** `links(c)` of each card of a candidate set: the distinct linked cards in that set, in both directions. */
export function linkCounts(t: PairTable, candidates: ReadonlySet<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of candidates) {
    let n = 0;
    for (const d of t.linked.get(c) ?? []) if (candidates.has(d)) n++;
    out.set(c, n);
  }
  return out;
}
