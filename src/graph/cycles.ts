/**
 * The best cycles of one card on request (Phase 3 spec sec. 9.2). No database access.
 *
 * Best-first search over simple paths of 1 to `maxLength` groups that start at a start group. The
 * score of a path is the product of its edge weights. All weights are 1.0 or less (weights.ts
 * throws otherwise), so no path has a higher score than any of its prefixes. Thus the search
 * stops when the best open path has a lower score than the K-th best cycle: that result is the
 * true top K (`exact`). A path with a score equal to the K-th score stays open, because its
 * cycles can win on the edge keys.
 *
 * Each queue entry is one out-edge of one path: when the search takes it, it also queues the next
 * out-edge of the same path. The out-edges are sorted by weight, so the queue stays small (two
 * new entries for each expansion) and the order is the same as a queue of all children.
 *
 * A cycle is written from its smallest group key, and its score is the product of its edge
 * weights in that order, so the same cycle found from two start groups is one cycle.
 */
import type { CycleGraph, GroupEdge } from './cycleGraph.js';

export interface Cycle { groups: string[]; edges: GroupEdge[]; score: number }
export interface SearchResult {
  cycles: Cycle[];
  /** True when the search did not reach the budget: the result is the true top K. */
  exact: boolean;
  expansions: number;
  /** True when the result has K cycles: more cycles can exist (the "more engine cycles" note). */
  kept_k: boolean;
}

/** The edge keys of a cycle, comma-joined: the last sort key (spec sec. 9.2). */
export const cycleKey = (c: { edges: readonly GroupEdge[] }) => c.edges.map((e) => e.merged_key).join(',');

/** Score from high to low, then edge keys. */
export function compareCycles(a: Cycle, b: Cycle): number {
  if (a.score !== b.score) return b.score - a.score;
  const ka = cycleKey(a);
  const kb = cycleKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** The canonical form: start at the smallest group key; the score in that order. */
export function canonicalCycle(groups: readonly string[], edges: readonly GroupEdge[]): Cycle {
  let i = 0;
  for (let j = 1; j < groups.length; j++) if (groups[j]! < groups[i]!) i = j;
  const g = [...groups.slice(i), ...groups.slice(0, i)];
  const e = [...edges.slice(i), ...edges.slice(0, i)];
  return { groups: g, edges: e, score: e.reduce((s, x) => s * x.weight, 1) };
}

interface Entry { score: number; seq: number; path: string[]; edges: GroupEdge[]; pathScore: number; i: number }

/** A binary max-heap on score, then on the queue sequence (first in, first out). */
class Queue {
  private readonly h: Entry[] = [];
  get size() { return this.h.length; }
  peek(): Entry | undefined { return this.h[0]; }
  private above(a: Entry, b: Entry) { return a.score > b.score || (a.score === b.score && a.seq < b.seq); }
  push(e: Entry) {
    const h = this.h;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.above(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }
  pop(): Entry | undefined {
    const h = this.h;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0 && last) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.above(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.above(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * The path score and the canonical score multiply the same weights in other orders. The bound
 * keeps a path whose score is a little lower than the K-th score, so a rounding difference never
 * removes a cycle of the true top K.
 */
const SLACK = 1 - 1e-9;

export function bestCycles(g: CycleGraph, start: readonly string[],
  limits: { maxLength: number; topK: number; budget: number }): SearchResult {
  const { maxLength, topK, budget } = limits;
  const top: Cycle[] = [];
  const seen = new Set<string>();
  const queue = new Queue();
  let seq = 0;
  let expansions = 0;
  const kth = () => (top.length < topK ? -Infinity : top[topK - 1]!.score * SLACK);
  // The edge from a group back to the start, by target: a path of `maxLength` groups can only close.
  const byTarget = new Map<string, Map<string, GroupEdge>>();
  const edgeTo = (from: string, to: string) => {
    let m = byTarget.get(from);
    if (!m) byTarget.set(from, (m = new Map(g.out(from).map((e) => [e.to, e]))));
    return m.get(to);
  };

  const record = (groups: readonly string[], edges: readonly GroupEdge[]) => {
    const c = canonicalCycle(groups, edges);
    const k = cycleKey(c);
    if (seen.has(k)) return;
    seen.add(k);
    if (top.length === topK && compareCycles(c, top[topK - 1]!) >= 0) return;
    let lo = 0;
    let hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareCycles(top[mid]!, c) < 0) lo = mid + 1; else hi = mid;
    }
    top.splice(lo, 0, c);
    if (top.length > topK) top.pop();
  };

  /** Queue the first out-edge of a path; a path of `maxLength` groups can only close. */
  const open = (path: string[], edges: GroupEdge[], pathScore: number) => {
    const last = path[path.length - 1]!;
    if (path.length < maxLength) {
      const outs = g.out(last);
      if (outs.length > 0) queue.push({ score: pathScore * outs[0]!.weight, seq: seq++, path, edges, pathScore, i: 0 });
    } else {
      const close = edgeTo(last, path[0]!);
      if (close) record(path, [...edges, close]);
    }
  };

  for (const s of [...new Set(start)].sort()) if (g.nodes.has(s)) open([s], [], 1);

  let exact = true;
  while (queue.size > 0) {
    if (queue.peek()!.score < kth()) break;
    if (expansions >= budget) { exact = false; break; }
    const en = queue.pop()!;
    expansions++;
    const outs = g.out(en.path[en.path.length - 1]!);
    const e = outs[en.i]!;
    const next = outs[en.i + 1];
    if (next) queue.push({ ...en, score: en.pathScore * next.weight, seq: seq++, i: en.i + 1 });
    if (e.to === en.path[0]) record(en.path, [...en.edges, e]);
    else if (!en.path.includes(e.to)) {
      const score = en.pathScore * e.weight;
      if (score >= kth()) open([...en.path, e.to], [...en.edges, e], score);
    }
  }
  return { cycles: top, exact, expansions, kept_k: top.length === topK };
}
