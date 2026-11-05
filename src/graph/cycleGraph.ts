/**
 * The graph for cycles (Phase 3 spec sec. 9.1). Nodes are ability groups, not cards. An edge goes
 * from group G1 to group G2 when a supply atom in G1 has a merged synergy edge to a demand atom in
 * G2. Thus a path goes through a card only when the demand atom and the supply atom are in the
 * same group. Class nodes are not in the graph: only typed rules give edges.
 *
 * Two merged edges can join the same two groups (two supply atoms, or two demand atoms). The
 * cycle is a sequence of groups, so the graph keeps one edge for each pair: the highest weight,
 * then the smallest merged key. The out-edges of a group are calculated on request and kept, so
 * that a search on one card does not calculate the whole build.
 */
import type { BuildIndex, GroupInfo, IndexAtom } from './buildIndex.js';
import { mergeEdges } from './merge.js';

export type GroupNode = Omit<GroupInfo, 'cost_mana'>;

export interface GroupEdge {
  from: string; to: string; weight: number; merged_key: string;
  grade: 'confirmed' | 'plausible';
  /** The demand atom in `to` that the edge reaches (the balance, balance.ts). */
  demand_atom_id: number;
}

export interface CycleGraph {
  nodes: Map<string, GroupNode>;
  /**
   * The out-edges of a node to nodes of the graph: one edge for each target, sorted by weight
   * from high to low, then by target key. Empty for a key that is not a node.
   */
  out(group: string): readonly GroupEdge[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One edge for each target (the highest weight, then the smallest merged key), in the `out` order. */
function bestPerTarget(edges: Iterable<GroupEdge>): GroupEdge[] {
  const best = new Map<string, GroupEdge>();
  for (const e of edges) {
    const b = best.get(e.to);
    if (!b || e.weight > b.weight || (e.weight === b.weight && e.merged_key < b.merged_key)) best.set(e.to, e);
  }
  return [...best.values()].sort((a, b) => b.weight - a.weight || cmp(a.to, b.to));
}

/** A graph from explicit nodes and edges (synthetic graphs, tests). */
export function graphFromEdges(nodes: readonly GroupNode[], edges: readonly GroupEdge[]): CycleGraph {
  const map = new Map(nodes.map((n) => [n.key, n]));
  const by = new Map<string, GroupEdge[]>();
  for (const e of edges) {
    if (!map.has(e.from) || !map.has(e.to)) continue;
    const l = by.get(e.from);
    if (l) l.push(e); else by.set(e.from, [e]);
  }
  const out = new Map([...by].map(([k, l]) => [k, bestPerTarget(l)]));
  return { nodes: map, out: (k) => out.get(k) ?? [] };
}

/** The synergy edges out of each group of an index, all grades and all targets; shared by the graphs of one index. */
const rawOut = new WeakMap<BuildIndex, Map<string, GroupEdge[]>>();
const atomsByGroup = new WeakMap<BuildIndex, Map<string, IndexAtom[]>>();

function groupAtoms(index: BuildIndex): Map<string, IndexAtom[]> {
  let m = atomsByGroup.get(index);
  if (!m) {
    m = new Map();
    for (const a of [...index.atoms.values()].sort((x, y) => x.id - y.id)) {
      const l = m.get(a.group);
      if (l) l.push(a); else m.set(a.group, [a]);
    }
    atomsByGroup.set(index, m);
  }
  return m;
}

function edgesOutOf(index: BuildIndex, group: string): GroupEdge[] {
  let cache = rawOut.get(index);
  if (!cache) rawOut.set(index, (cache = new Map()));
  let l = cache.get(group);
  if (!l) {
    const atoms = groupAtoms(index).get(group) ?? [];
    l = mergeEdges(atoms.flatMap((a) => index.edgesFromSupply(a)), index.ctx)
      .filter((e) => e.polarity === '+' && e.class_id === null)
      .map((e) => ({
        from: group, to: index.atoms.get(e.demand_atom_id)!.group, weight: e.weight.total, merged_key: e.key,
        grade: e.grade, demand_atom_id: e.demand_atom_id,
      }));
    cache.set(group, l);
  }
  return l;
}

/**
 * spec sec. 9.1-9.2: the cycle graph of a build index. `engineOnly` keeps the groups of the kind
 * `triggered` or `activated` (the engine search); `confirmedOnly` keeps the `confirmed` edges.
 * The index must hold the facts of each group (BuildIndex.load gives them).
 */
export function cycleGraph(index: BuildIndex, opts: { confirmedOnly: boolean; engineOnly: boolean }): CycleGraph {
  const nodes = new Map<string, GroupNode>();
  for (const k of [...groupAtoms(index).keys()].sort()) {
    const info = index.groups.get(k);
    if (!info) throw new Error(`the index has no facts for group ${k}`);
    if (opts.engineOnly && info.kind === 'other') continue;
    const { cost_mana: _cost, ...n } = info;
    nodes.set(k, n);
  }
  const out = new Map<string, GroupEdge[]>();
  return {
    nodes,
    out(k) {
      if (!nodes.has(k)) return [];
      let l = out.get(k);
      if (!l) {
        l = bestPerTarget(edgesOutOf(index, k).filter((e) => nodes.has(e.to) && (!opts.confirmedOnly || e.grade === 'confirmed')));
        out.set(k, l);
      }
      return l;
    },
  };
}
