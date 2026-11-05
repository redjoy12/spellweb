import { describe, it, expect } from 'vitest';
import { cardPairs, mergeEdges, type AtomEdge, type MergeContext } from '../src/graph/merge.js';
import { loadGraphPolicy } from '../src/graph/policy.js';
import { loadTextTests } from '../src/graph/textTests.js';
import { atomInfo } from '../src/graph/buildIndex.js';
import { weightOf } from '../src/graph/weights.js';
import { maybe, realDb as db } from './helpers/realDb.js';

const policy = loadGraphPolicy();

// Synthetic atoms: these tests check the merge mechanics of spec sec. 7.3 only.
// Atoms 1 and 2: card A, group 0, the same span. Atom 3: card A, group 1. Atom 4: card B.
// Atoms 10 and 11: demand atoms on card B and card A.
const atoms: Record<number, ReturnType<MergeContext['atom']>> = {
  1: { oracle_id: 'A', group: 'A#0#0', kind: 'triggered', span: [0, 9], mv: 2 },
  2: { oracle_id: 'A', group: 'A#0#0', kind: 'triggered', span: [0, 9], mv: 2 },
  3: { oracle_id: 'A', group: 'A#0#1', kind: 'other', span: [12, 20], mv: 2 },
  4: { oracle_id: 'B', group: 'B#0#0', kind: 'activated', span: [0, 5], mv: 1 },
  10: { oracle_id: 'B', group: 'B#0#1', kind: 'other', span: [7, 15], mv: 1 },
  11: { oracle_id: 'A', group: 'A#0#2', kind: 'other', span: [22, 30], mv: 2 },
};
const ctx: MergeContext = { atom: (id) => atoms[id]!, classSize: () => 7, policy };
const edge = (rule: string, supply: number | null, demand: number, over: Partial<AtomEdge> = {}): AtomEdge => ({
  rule_hash: rule, polarity: '+', supply_atom_id: supply, class_id: null, demand_atom_id: demand,
  grade: 'plausible', unresolved: ['x'], ...over,
});

describe('mergeEdges (spec sec. 7.3)', () => {
  it('one merged edge for the same polarity, demand atom, supply group and supply span', () => {
    const m = mergeEdges([edge('r1', 1, 10), edge('r2', 2, 10)], ctx);
    expect(m).toHaveLength(1);
    expect(m[0]!.rule_hashes).toEqual(['r1', 'r2']);
    expect(m[0]!.atom_ids).toEqual([1, 2, 10]);
    expect(m[0]!.supply_oracle).toBe('A');
    expect(m[0]!.demand_oracle).toBe('B');
    expect(m[0]!.key).toBe('+|A#0#0|0|9|10');
  });
  it('edges with different polarities never merge', () => {
    expect(mergeEdges([edge('r1', 1, 10), edge('r2', 2, 10, { polarity: '-' })], ctx)).toHaveLength(2);
  });
  it('a different supply group or demand atom makes a separate edge', () => {
    expect(mergeEdges([edge('r1', 1, 10), edge('r1', 3, 10), edge('r1', 1, 11)], ctx)).toHaveLength(3);
  });
  it('the merged grade is the best grade of the parts, and the weight uses it', () => {
    const [m] = mergeEdges([edge('r1', 1, 10), edge('r2', 2, 10, { grade: 'confirmed', unresolved: [] })], ctx);
    expect(m!.grade).toBe('confirmed');
    expect(m!.unresolved).toEqual([]);
    expect(m!.weight).toEqual(weightOf('confirmed', 'triggered', 2, policy));
  });
  it('a class edge uses the class ID in place of the supply group and span', () => {
    const c = (rule: string) => edge(rule, null, 10, { class_id: 'INTRINSIC.card_type(X)' });
    const m = mergeEdges([c('r1'), c('r2')], ctx);
    expect(m).toHaveLength(1);
    expect(m[0]!.key).toBe('+|INTRINSIC.card_type(X)|10');
    expect(m[0]!.supply_oracle).toBeNull();
    expect(m[0]!.atom_ids).toEqual([10]);
    expect(m[0]!.weight.total).toBeCloseTo(policy.weights.grade.plausible / Math.log2(8), 12);
  });
  it('gives the same output for the same input in any order', () => {
    const es = [edge('r2', 2, 10), edge('r1', 3, 11), edge('r1', 1, 10), edge('r3', 4, 11)];
    expect(mergeEdges([...es].reverse(), ctx)).toEqual(mergeEdges(es, ctx));
  });
});

describe('cardPairs (spec sec. 7.3 item 6)', () => {
  it('a card pair has the highest weight of its merged edges', () => {
    const m = mergeEdges([edge('r1', 1, 10), edge('r2', 3, 10, { grade: 'confirmed', unresolved: [] })], ctx);
    const pairs = cardPairs(m);
    expect([...pairs.keys()]).toEqual(['A|B']);
    expect(pairs.get('A|B')!.weight).toBe(Math.max(...m.map((e) => e.weight.total)));
    expect(pairs.get('A|B')!.edges).toHaveLength(2);
  });
  it('a card that supplies its own demand gives a pair from the card to itself', () => {
    expect([...cardPairs(mergeEdges([edge('r1', 1, 11)], ctx)).keys()]).toEqual(['A|A']);
  });
  it('class edges make no card pair', () => {
    expect(cardPairs(mergeEdges([edge('r1', null, 10, { class_id: 'C' })], ctx)).size).toBe(0);
  });
});

maybe('the merge on the real slice (spec sec. 7.3)', () => {
  it('each CREATE/TOKENS pair with one span merges into one edge', () => {
    const tests = loadTextTests();
    // The pairs on cards that have stored ability groups of the current text tests. Schema v15
    // drops the TOKENS twin at submit (spec sec. 20.3), so the pairs come from the v14 atoms.
    const pairs = db.prepare(
      `SELECT c.id c, t.id t FROM atoms c JOIN atoms t ON t.oracle_id = c.oracle_id AND t.face_index = c.face_index
           AND t.span_start = c.span_start AND t.span_end = c.span_end AND t.run_id = c.run_id
        WHERE c.schema_version = 14 AND t.schema_version = 14 AND c.consensus = 1 AND t.consensus = 1
          AND c.run_id = (SELECT MAX(x.run_id) FROM atoms x WHERE x.oracle_id = c.oracle_id AND x.schema_version = 14 AND x.consensus = 1)
          AND c.family = 'PRODUCES' AND c.type_key = 'CREATE'
          AND t.family = 'PRODUCES' AND t.type_key = 'TOKENS'
          AND EXISTS (SELECT 1 FROM ability_groups g WHERE g.oracle_id = c.oracle_id AND g.oracle_hash = c.oracle_hash
                        AND g.tests_version = ?)`,
    ).all(tests.tests_version) as Array<{ c: number; t: number }>;
    expect(pairs.length).toBeGreaterThan(0);
    const info = atomInfo(db, pairs.flatMap((p) => [p.c, p.t]), tests.tests_version);
    const demandId = -1; // one synthetic demand atom that both rules connect to
    const real: MergeContext = {
      atom: (id) => (id === demandId ? { oracle_id: 'demand', group: 'demand#0#0', kind: 'other', span: [0, 1], mv: 0 } : info.get(id)!),
      classSize: () => 1, policy,
    };
    const edges = pairs.flatMap((p) => [edge('rule-create', p.c, demandId), edge('rule-tokens', p.t, demandId)]);
    const merged = mergeEdges(edges, real);
    expect(merged).toHaveLength(pairs.length);
    for (const m of merged) expect(m.rule_hashes).toEqual(['rule-create', 'rule-tokens']);
  });
});
