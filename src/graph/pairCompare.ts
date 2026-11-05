/**
 * The proof of spec sec. 23 (plan Task 12): two builds have the same card pairs. It reads each build
 * with `BuildIndex.load`, in memory, and writes nothing.
 *
 * It compares more than the counts of review 1 sec. 2: each direction, the self pairs, the grade of
 * each pair, the `-` pairs, and the class edges of each demand card (a class edge makes no card pair).
 * A weight is not part of the pair: `weights` reports how many pairs have another weight.
 */
import type { BuildIndex } from './buildIndex.js';
import type { Grade } from './match.js';
import { cardPairs, mergeEdges, type MergedEdge } from './merge.js';

type Level = Exclude<Grade, 'rejected'>;
const best = (edges: readonly MergedEdge[]): Level => (edges.some((e) => e.grade === 'confirmed') ? 'confirmed' : 'plausible');

export interface BuildPairs {
  plus: Map<string, { grade: Level; weight: number }>;
  minus: Map<string, Level>;
  /** `polarity|class id|demand card`. */
  classes: Map<string, Level>;
}

export function buildPairs(index: BuildIndex): BuildPairs {
  const out: BuildPairs = { plus: new Map(), minus: new Map(), classes: new Map() };
  for (const c of index.cards()) {
    const ae = index.cardAtomEdges(c);
    const merged = mergeEdges(ae.supply, index.ctx);
    for (const [k, p] of cardPairs(merged.filter((e) => e.polarity === '+'))) out.plus.set(k, { grade: best(p.edges), weight: p.weight });
    for (const [k, p] of cardPairs(merged.filter((e) => e.polarity === '-'))) out.minus.set(k, best(p.edges));
    const byClass = new Map<string, MergedEdge[]>();
    for (const e of mergeEdges(ae.classes, index.ctx)) {
      const k = `${e.polarity}|${e.class_id}|${e.demand_oracle}`;
      const l = byClass.get(k);
      if (l) l.push(e); else byClass.set(k, [e]);
    }
    for (const [k, l] of byClass) out.classes.set(k, best(l));
  }
  return out;
}

export interface MapDiff { before: number; after: number; added: string[]; lost: string[]; grade: string[] }

function diff<V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>, level: (v: V) => string): MapDiff {
  const out: MapDiff = { before: a.size, after: b.size, added: [], lost: [], grade: [] };
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w === undefined) out.lost.push(k);
    else if (level(v) !== level(w)) out.grade.push(k);
  }
  for (const k of b.keys()) if (!a.has(k)) out.added.push(k);
  return out;
}

export interface PairCompare {
  same: boolean;
  plus: MapDiff; minus: MapDiff; classes: MapDiff;
  /** The `+` pairs of both builds with another weight, and the largest change. */
  weights: { changed: number; largest: number };
}

/** True in `same` when no pair, direction or grade differs. */
export function comparePairs(a: BuildPairs, b: BuildPairs): PairCompare {
  const plus = diff(a.plus, b.plus, (v) => v.grade);
  const minus = diff(a.minus, b.minus, (v) => v);
  const classes = diff(a.classes, b.classes, (v) => v);
  let changed = 0;
  let largest = 0;
  for (const [k, v] of a.plus) {
    const w = b.plus.get(k);
    if (!w || w.weight === v.weight) continue;
    changed++;
    largest = Math.max(largest, Math.abs(w.weight - v.weight));
  }
  const clean = (d: MapDiff) => !d.added.length && !d.lost.length && !d.grade.length;
  return { same: clean(plus) && clean(minus) && clean(classes), plus, minus, classes, weights: { changed, largest } };
}
