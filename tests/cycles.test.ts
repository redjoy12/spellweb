import { describe, it, expect } from 'vitest';
import { BuildIndex, type IndexAtom } from '../src/graph/buildIndex.js';
import { cycleGraph, graphFromEdges, type CycleGraph, type GroupEdge, type GroupNode } from '../src/graph/cycleGraph.js';
import { bestCycles, type Cycle } from '../src/graph/cycles.js';
import type { GroupKind } from '../src/graph/groups.js';
import { loadGraphPolicy } from '../src/graph/policy.js';
import type { StoredRule } from '../src/graph/ruleSet.js';

// Phase 3 plan Task 6 Step 1 and spec sec. 9.1-9.2. The search has no database access, so these
// tests use synthetic graphs. The types and rules below are synthetic data, not Magic facts.

/** mulberry32: a small seeded generator, so that each seed gives the same graph. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const node = (key: string, kind: GroupKind = 'triggered'): GroupNode => ({
  key, oracle_id: key.split('#')[0]!, kind, per_turn_limit: false, unknown_limit: false, cost_unparsed: false,
});
const edge = (from: string, to: string, weight = 1, grade: GroupEdge['grade'] = 'confirmed'): GroupEdge => ({
  from, to, weight, grade, merged_key: `+|${from}|${to}`, demand_atom_id: 0,
});

/** Few distinct weights, so that equal scores are common. */
const WEIGHTS = [1, 0.5, 0.25, 0.8];

function randomGraph(seed: number, o: { nodes: number; edgeProb: number }): CycleGraph {
  const r = rng(seed);
  const keys = Array.from({ length: o.nodes }, (_, i) => `n${String(i).padStart(2, '0')}`);
  const edges: GroupEdge[] = [];
  for (const a of keys) for (const b of keys) {
    if (r() < o.edgeProb) edges.push(edge(a, b, WEIGHTS[Math.floor(r() * WEIGHTS.length)]!, r() < 0.5 ? 'confirmed' : 'plausible'));
  }
  return graphFromEdges(keys.map((k) => node(k)), edges);
}

const startGroups = (g: CycleGraph) => [...g.nodes.keys()].sort().slice(0, 3);
const key = (c: Cycle) => c.edges.map((e) => e.merged_key).join(',');
const product = (es: readonly GroupEdge[]) => es.reduce((s, e) => s * e.weight, 1);

/** All simple cycles through a start group, to the length limit, canonical, sorted as the search sorts. */
function allCycles(g: CycleGraph, start: readonly string[], maxLength: number): Cycle[] {
  const found = new Map<string, Cycle>();
  const walk = (s: string, path: string[], es: GroupEdge[]) => {
    for (const e of g.out(path[path.length - 1]!)) {
      if (e.to === s) {
        const all = [...es, e];
        const groups = [...path];
        const i = groups.indexOf([...groups].sort()[0]!);
        const rot = { groups: [...groups.slice(i), ...groups.slice(0, i)], edges: [...all.slice(i), ...all.slice(0, i)] };
        found.set(key({ ...rot, score: 0 }), { ...rot, score: product(rot.edges) });
      } else if (!path.includes(e.to) && path.length < maxLength) walk(s, [...path, e.to], [...es, e]);
    }
  };
  for (const s of start) walk(s, [s], []);
  return [...found.values()].sort((a, b) => b.score - a.score || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

const bruteForceTopK = (g: CycleGraph, start: readonly string[], maxLength: number, k: number) =>
  allCycles(g, start, maxLength).slice(0, k);

describe('bestCycles: best-first search for the top K cycles (spec sec. 9.2)', () => {
  it('an exact result equals the brute-force top K', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const g = randomGraph(seed, { nodes: 12, edgeProb: 0.25 });
      const res = bestCycles(g, startGroups(g), { maxLength: 4, topK: 5, budget: 1e6 });
      expect(res.exact).toBe(true);
      expect(res.cycles.map(key)).toEqual(bruteForceTopK(g, startGroups(g), 4, 5).map(key));
    }
  });

  it('gives the same scores as the canonical product of the edge weights', () => {
    const g = randomGraph(7, { nodes: 10, edgeProb: 0.3 });
    const res = bestCycles(g, startGroups(g), { maxLength: 4, topK: 20, budget: 1e6 });
    for (const c of res.cycles) expect(c.score).toBe(product(c.edges));
  });

  it('writes a cycle from its smallest group key and removes duplicates', () => {
    const g = graphFromEdges(['c', 'a', 'b'].map((k) => node(k)), [edge('c', 'a'), edge('a', 'b'), edge('b', 'c')]);
    const res = bestCycles(g, ['c', 'b', 'a'], { maxLength: 4, topK: 10, budget: 1000 });
    expect(res.cycles).toHaveLength(1);
    expect(res.cycles[0]!.groups).toEqual(['a', 'b', 'c']);
    expect(res.cycles[0]!.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['a>b', 'b>c', 'c>a']);
  });

  it('sorts equal scores by edge keys, also at the K-th place', () => {
    // Four cycles s-x-s with the same score; the top 2 are the two smallest edge keys.
    const xs = ['x4', 'x2', 'x3', 'x1'];
    const g = graphFromEdges([node('s'), ...xs.map((k) => node(k))], xs.flatMap((x) => [edge('s', x, 0.5), edge(x, 's', 0.5)]));
    const res = bestCycles(g, ['s'], { maxLength: 2, topK: 2, budget: 1000 });
    expect(res.cycles.map((c) => c.groups)).toEqual([['s', 'x1'], ['s', 'x2']]);
    expect(res.exact).toBe(true);
    expect(res.kept_k).toBe(true);
  });

  it('a higher score comes first, whatever the edge keys', () => {
    const g = graphFromEdges(['s', 'a', 'b'].map((k) => node(k)),
      [edge('s', 'a', 0.5), edge('a', 's', 0.5), edge('s', 'b'), edge('b', 's')]);
    const res = bestCycles(g, ['s'], { maxLength: 3, topK: 5, budget: 1000 });
    expect(res.cycles.map((c) => c.groups)).toEqual([['b', 's'], ['a', 's']]);
    expect(res.cycles.map((c) => c.score)).toEqual([1, 0.25]);
  });

  it('a small budget gives exact = false and a subset of the true cycles', () => {
    for (const seed of [3, 11, 19]) {
      const g = randomGraph(seed, { nodes: 12, edgeProb: 0.35 });
      const res = bestCycles(g, startGroups(g), { maxLength: 4, topK: 50, budget: 5 });
      expect(res.exact).toBe(false);
      expect(res.expansions).toBe(5);
      const all = new Set(allCycles(g, startGroups(g), 4).map(key));
      for (const c of res.cycles) expect(all.has(key(c))).toBe(true);
    }
  });

  it('with fewer than K cycles, the result contains all of them and is exact', () => {
    const g = graphFromEdges(['a', 'b', 'c'].map((k) => node(k)),
      [edge('a', 'b'), edge('b', 'a'), edge('b', 'c'), edge('c', 'a'), edge('a', 'a', 0.5)]);
    const res = bestCycles(g, ['a'], { maxLength: 4, topK: 50, budget: 1000 });
    expect(res.exact).toBe(true);
    expect(res.kept_k).toBe(false);
    expect(res.cycles.map((c) => c.groups)).toEqual([['a', 'b'], ['a', 'b', 'c'], ['a']]);
  });

  it('respects the length limit', () => {
    const ring = ['a', 'b', 'c', 'd', 'e'];
    const g = graphFromEdges(ring.map((k) => node(k)), ring.map((k, i) => edge(k, ring[(i + 1) % ring.length]!)));
    expect(bestCycles(g, ['a'], { maxLength: 4, topK: 5, budget: 1000 }).cycles).toHaveLength(0);
    expect(bestCycles(g, ['a'], { maxLength: 5, topK: 5, budget: 1000 }).cycles).toHaveLength(1);
  });

  it('gives the same output for the same input two times', () => {
    const g = randomGraph(42, { nodes: 12, edgeProb: 0.3 });
    const a = bestCycles(g, startGroups(g), { maxLength: 4, topK: 10, budget: 300 });
    const b = bestCycles(g, startGroups(g), { maxLength: 4, topK: 10, budget: 300 });
    expect(b).toEqual(a);
  });
});

// A synthetic BuildIndex. Card A, one triggered group: demand X (atom 1), supply P (atom 2).
// Card B, one activated group: demand D (atom 3), supply Q (atom 4). Card C: an `other` group with
// demand X (atom 5), and a triggered group with supply P (atom 6). Rules: P -> D, Q -> X, and a
// class rule on X. The D type has the param `p` and no rule resolves it, so P -> D is plausible.
function syntheticIndex(): BuildIndex {
  const atom = (id: number, card: string, group: number, kind: GroupKind, family: string, type_key: string,
    params: Record<string, unknown> = {}): IndexAtom => ({
    id, oracle_id: card, face_index: 0, family, type_key, params, span_start: group * 10, span_end: group * 10 + 5,
    group: `${card}#0#${group}`, kind, span: [group * 10, group * 10 + 5], mv: 2,
  });
  const atoms = [
    atom(1, 'A', 0, 'triggered', 'CARES_ABOUT', 'X'), atom(2, 'A', 0, 'triggered', 'PRODUCES', 'P'),
    atom(3, 'B', 0, 'activated', 'ENABLES', 'D', { p: 'v' }), atom(4, 'B', 0, 'activated', 'PRODUCES', 'Q'),
    atom(5, 'C', 0, 'other', 'CARES_ABOUT', 'X'), atom(6, 'C', 1, 'triggered', 'PRODUCES', 'P'),
  ];
  const side = (family: string, type_key: string) => ({ family, type_key, where: [] });
  const rule = (hash: string, supply: StoredRule['supply'], demand: StoredRule['demand']): StoredRule => ({
    rule_hash: hash, rule_id: hash, votes: 3, status: 'accepted', polarity: '+', supply, demand,
    param_links: [], implications: [], evidence: [],
  });
  const groups = new Map<string, GroupNode>();
  for (const a of atoms) groups.set(a.group, { ...node(a.group, a.kind), oracle_id: a.oracle_id });
  return new BuildIndex({
    atoms: new Map(atoms.map((a) => [a.id, a])),
    rules: [
      rule('h1', side('PRODUCES', 'P'), side('ENABLES', 'D')),
      rule('h2', side('PRODUCES', 'Q'), side('CARES_ABOUT', 'X')),
      rule('h3', { intrinsic: 'card_type', value: 'Creature' }, side('CARES_ABOUT', 'X')),
    ],
    classes: [{ id: 'INTRINSIC.card_type(Creature)', intrinsic: 'card_type', value: 'Creature', members: ['A', 'B', 'C'] }],
    params: new Map([['ENABLES.D', ['p']]]),
    policy: loadGraphPolicy(),
    groups: new Map([...groups].map(([k, g]) => [k, { ...g, cost_mana: null }])),
  });
}

describe('cycleGraph: groups as nodes, merged edges between groups (spec sec. 9.1)', () => {
  it('has a node for each group and no class node', () => {
    const g = cycleGraph(syntheticIndex(), { confirmedOnly: false, engineOnly: false });
    expect([...g.nodes.keys()].sort()).toEqual(['A#0#0', 'B#0#0', 'C#0#0', 'C#0#1']);
    for (const k of g.nodes.keys()) expect(k.startsWith('INTRINSIC')).toBe(false);
    for (const k of g.nodes.keys()) for (const e of g.out(k)) expect(e.to.startsWith('INTRINSIC')).toBe(false);
  });

  it('engineOnly keeps only triggered and activated groups', () => {
    const g = cycleGraph(syntheticIndex(), { confirmedOnly: false, engineOnly: true });
    expect([...g.nodes.keys()].sort()).toEqual(['A#0#0', 'B#0#0', 'C#0#1']);
    for (const n of g.nodes.values()) expect(['triggered', 'activated']).toContain(n.kind);
    expect(g.out('B#0#0').map((e) => e.to)).toEqual(['A#0#0']);
  });

  it('an edge goes from the supply group to the group of the demand atom', () => {
    const g = cycleGraph(syntheticIndex(), { confirmedOnly: false, engineOnly: false });
    expect(g.out('A#0#0').map((e) => [e.to, e.grade, e.demand_atom_id])).toEqual([['B#0#0', 'plausible', 3]]);
    expect(g.out('B#0#0').map((e) => e.to).sort()).toEqual(['A#0#0', 'C#0#0']);
    expect(g.out('C#0#0')).toEqual([]);
  });

  it('a path goes through a card only when the demand atom and the supply atom are in the same group', () => {
    const g = cycleGraph(syntheticIndex(), { confirmedOnly: false, engineOnly: false });
    // B -> C#0#0 (demand X) cannot continue: the supply P of card C is in another group.
    const res = bestCycles(g, ['B#0#0'], { maxLength: 4, topK: 10, budget: 1000 });
    expect(res.cycles.map((c) => c.groups)).toEqual([['A#0#0', 'B#0#0']]);
    expect(bestCycles(g, ['C#0#0', 'C#0#1'], { maxLength: 4, topK: 10, budget: 1000 }).cycles).toEqual([]);
  });

  it('confirmedOnly drops the plausible edges', () => {
    const g = cycleGraph(syntheticIndex(), { confirmedOnly: true, engineOnly: false });
    expect(g.out('A#0#0')).toEqual([]);
    expect(bestCycles(g, ['A#0#0'], { maxLength: 4, topK: 10, budget: 1000 }).cycles).toEqual([]);
  });
});
