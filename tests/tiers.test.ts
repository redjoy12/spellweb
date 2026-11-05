import { describe, it, expect } from 'vitest';
import { atomAmount, cycleBalance, resourceMap, type BalanceContext, type BalanceEntry } from '../src/graph/balance.js';
import type { GroupEdge, GroupNode } from '../src/graph/cycleGraph.js';
import type { Cycle } from '../src/graph/cycles.js';
import type { StoredRole } from '../src/graph/ruleSet.js';
import { sortCycles, tierOf, type Tier, type UnresolvedCause } from '../src/graph/tiers.js';

// Phase 3 plan Task 6 Step 3 and spec sec. 9.3-9.5. Synthetic cycles and resource maps: the
// tests check the tier and balance mechanics, not whether a resource effect is true in Magic.

const node = (key: string, o: Partial<GroupNode> = {}): GroupNode => ({
  key, oracle_id: key, kind: 'triggered', per_turn_limit: false, unknown_limit: false, cost_unparsed: false, ...o,
});
const edge = (from: string, to: string, o: Partial<GroupEdge> = {}): GroupEdge => ({
  from, to, weight: 1, grade: 'confirmed', merged_key: `+|${from}|${to}`, demand_atom_id: 0, ...o,
});
const cycle = (edges: GroupEdge[], score = 1): Cycle => ({ groups: edges.map((e) => e.from), edges, score });
const entry = (net: number | 'unknown', kind: 'cost' | 'value', value = kind === 'value'): BalanceEntry => ({ net, kind, value });

describe('tierOf: the tier table and the unresolved causes (spec sec. 9.5)', () => {
  type Case = {
    name: string; nodes?: Partial<GroupNode>[]; grade2?: GroupEdge['grade'];
    balance?: Array<[string, BalanceEntry]>;
    tier: Tier; unresolved: UnresolvedCause[]; per_turn_limit?: boolean; has_plausible?: boolean;
  };
  // The base cycle passes all tier-3 conditions: life increases, mana balances to zero.
  const base: Array<[string, BalanceEntry]> = [['life', entry(2, 'value')], ['mana', entry(0, 'cost', true)]];
  const cases: Case[] = [
    { name: 'all tier-3 conditions true', tier: 3, unresolved: [] },
    { name: 'a per-turn limit', nodes: [{ per_turn_limit: true }], tier: 2, unresolved: [], per_turn_limit: true },
    { name: 'an unknown limit', nodes: [{}, { unknown_limit: true }], tier: 2, unresolved: ['unknown_limit'] },
    { name: 'no value increase, all amounts known', balance: [['life', entry(0, 'value')]], tier: 2, unresolved: [] },
    { name: 'no value dimension at all', balance: [['mana', entry(0, 'cost')]], tier: 2, unresolved: [] },
    { name: 'an unknown value amount, no other increase', balance: [['life', entry('unknown', 'value')]],
      tier: 2, unresolved: ['unknown_amount', 'no_value_increase'] },
    { name: 'an unknown value amount and a proved increase', balance: [['life', entry('unknown', 'value')], ['damage', entry(1, 'value')]],
      tier: 2, unresolved: ['unknown_amount'] },
    { name: 'an unparsed cost', nodes: [{}, { kind: 'activated', cost_unparsed: true }], tier: 2, unresolved: ['unparsed_cost'] },
    { name: 'a plausible edge', grade2: 'plausible', tier: 2, unresolved: ['plausible_edge'], has_plausible: true },
    { name: 'a group of kind other', nodes: [{ kind: 'other' }], tier: 1, unresolved: [] },
    { name: 'a group of kind other and unknown values', nodes: [{ kind: 'other', unknown_limit: true }], grade2: 'plausible',
      balance: [['mana', entry('unknown', 'cost')]], tier: 1, unresolved: [], has_plausible: true },
    { name: 'a known negative balance of a consumed resource', balance: [['life', entry(2, 'value')], ['mana', entry(-1, 'cost', true)]],
      tier: 1, unresolved: [] },
    { name: 'a negative value resource is not consumed', balance: [['life', entry(2, 'value')], ['opponent_life', entry(-2, 'value')]],
      tier: 3, unresolved: [] },
    { name: 'an unknown consumed balance counts as not negative', balance: [['life', entry(2, 'value')], ['mana', entry('unknown', 'cost')]],
      tier: 2, unresolved: ['unknown_amount'] },
    { name: 'an unknown consumed balance with a per-turn limit', nodes: [{ per_turn_limit: true }],
      balance: [['life', entry(2, 'value')], ['mana', entry('unknown', 'cost')]], tier: 2, unresolved: ['unknown_amount'], per_turn_limit: true },
    { name: 'a plausible edge with a per-turn limit has no effect on the tier', nodes: [{ per_turn_limit: true }], grade2: 'plausible',
      tier: 2, unresolved: [], per_turn_limit: true, has_plausible: true },
    { name: 'all unknown causes together', nodes: [{ unknown_limit: true }, { kind: 'activated', cost_unparsed: true }], grade2: 'plausible',
      balance: [['life', entry('unknown', 'value')]], tier: 2,
      unresolved: ['unknown_amount', 'unknown_limit', 'unparsed_cost', 'plausible_edge', 'no_value_increase'], has_plausible: true },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const nodes = new Map([node('g1', c.nodes?.[0]), node('g2', c.nodes?.[1])].map((n) => [n.key, n]));
      const cy = cycle([edge('g1', 'g2'), edge('g2', 'g1', { grade: c.grade2 ?? 'confirmed' })]);
      const t = tierOf(cy, nodes, new Map(c.balance ?? base));
      expect(t).toEqual({ tier: c.tier, unresolved: c.unresolved, per_turn_limit: c.per_turn_limit ?? false, has_plausible: c.has_plausible ?? false });
    });
  }
});

describe('sortCycles (spec sec. 9.2)', () => {
  it('sorts by tier, then no unresolved flag first, then score, then edge keys', () => {
    const mk = (tier: Tier, unresolved: UnresolvedCause[], score: number, k: string) =>
      ({ ...cycle([edge(k, k)], score), tier, unresolved });
    const list = [
      mk(2, [], 0.5, 'b'), mk(3, [], 0.1, 'z'), mk(2, ['plausible_edge'], 0.9, 'a'), mk(1, [], 1, 'a'),
      mk(2, [], 0.5, 'a'), mk(2, [], 0.8, 'c'),
    ];
    expect(sortCycles(list).map((c) => `${c.tier}${c.unresolved.length ? 'u' : ''}:${c.score}:${c.groups[0]}`)).toEqual([
      '3:0.1:z', '2:0.8:c', '2:0.5:a', '2:0.5:b', '2u:0.9:a', '1:1:a',
    ]);
  });
});

describe('cycleBalance: the resource balance of one loop (spec sec. 9.3)', () => {
  // g1 (triggered): atom 1 demand T, atom 2 gains life (amount 3). g2 (activated, cost 2 mana):
  // atom 3 demand U, atom 4 makes mana (amount 1) and atom 5 is a mana cost atom.
  const effects = new Map([
    ['P.LIFE', [{ resource: 'life', sign: '+' as const, kind: 'value' as const }]],
    ['P.MANA', [{ resource: 'mana', sign: '+' as const, kind: 'value' as const }]],
    ['E.PAY', [{ resource: 'mana', sign: '-' as const, kind: 'cost' as const }]],
    ['C.T', [{ resource: 'permanents', sign: '-' as const, kind: 'cost' as const }]],
    ['C.U', []],
  ]);
  const atoms: Record<string, Array<{ id: number; type: string; amount: number | 'unknown' }>> = {
    g1: [{ id: 1, type: 'C.T', amount: 1 }, { id: 2, type: 'P.LIFE', amount: 3 }],
    g2: [{ id: 3, type: 'C.U', amount: 'unknown' }, { id: 4, type: 'P.MANA', amount: 1 }, { id: 5, type: 'E.PAY', amount: 'unknown' }],
  };
  const ctx = (cost: number | 'unknown' = 2, over: Partial<BalanceContext> = {}): BalanceContext => ({
    effects, atoms: (g) => atoms[g] ?? [], costMana: (g) => (g === 'g2' ? cost : null), ...over,
  });
  const cy = cycle([edge('g1', 'g2', { demand_atom_id: 3 }), edge('g2', 'g1', { demand_atom_id: 1 })]);

  it('sums sign x amount for each resource; the activation cost replaces the mana cost atoms of its group', () => {
    const b = cycleBalance(cy, ctx());
    expect(Object.fromEntries(b)).toEqual({
      life: { net: 3, kind: 'value', value: true },
      mana: { net: -1, kind: 'cost', value: true },
    });
  });

  it('skips the demand atom that the incoming edge reaches', () => {
    // Atom 1 (a cost on permanents) is the demand atom of the edge g2 -> g1, so it does not count.
    expect(cycleBalance(cy, ctx()).has('permanents')).toBe(false);
    const other = cycle([edge('g1', 'g2', { demand_atom_id: 3 }), edge('g2', 'g1', { demand_atom_id: 2 })]);
    expect(cycleBalance(other, ctx()).get('permanents')).toEqual({ net: -1, kind: 'cost', value: false });
  });

  it('an unknown amount makes the balance of its resource unknown', () => {
    expect(cycleBalance(cy, ctx('unknown')).get('mana')!.net).toBe('unknown');
    expect(cycleBalance(cy, ctx()).get('life')!.net).toBe(3);
  });
});

describe('atomAmount and resourceMap (spec sec. 9.3 and 5.3)', () => {
  it('reads the integer amount param; a string or an absent param is unknown', () => {
    const params = new Map([['P.LIFE', 'amount']]);
    expect(atomAmount({ type: 'P.LIFE', params: { amount: 2 } }, params, null)).toBe(2);
    expect(atomAmount({ type: 'P.LIFE', params: { amount: 'X' } }, params, null)).toBe('unknown');
    expect(atomAmount({ type: 'P.LIFE', params: { amount: 1.5 } }, params, null)).toBe('unknown');
    expect(atomAmount({ type: 'P.LIFE', params: {} }, params, null)).toBe('unknown');
    expect(atomAmount({ type: 'E.PAY', params: {} }, params, null)).toBe('unknown');
  });

  it('counts the mana symbols of the quote for MANA_PRODUCTION; no symbol is unknown', () => {
    expect(atomAmount({ type: 'PRODUCES.MANA_PRODUCTION', params: {} }, new Map(), 2)).toBe(2);
    expect(atomAmount({ type: 'PRODUCES.MANA_PRODUCTION', params: {} }, new Map(), 'unknown')).toBe('unknown');
    expect(atomAmount({ type: 'PRODUCES.MANA_PRODUCTION', params: {} }, new Map(), 0)).toBe('unknown');
  });

  it('keeps the accepted roles only and drops the other resource', () => {
    const role = (type_key: string, status: StoredRole['status'], resources: Array<[string, '+' | '-', 'cost' | 'value']>): StoredRole => ({
      family: 'F', type_key, role: 'supply', demand_note: null, votes: 3, status, evidence: [], decision: null,
      resources: resources.map(([resource, sign, kind]) => ({ resource, sign, kind, evidence: [] })),
    });
    const m = resourceMap([
      role('A', 'accepted', [['life', '+', 'value'], ['other', '+', 'value']]),
      role('B', 'disputed', [['mana', '+', 'value']]),
      role('C', 'accepted', [['other', '-', 'cost']]),
    ]);
    expect(Object.fromEntries(m)).toEqual({ 'F.A': [{ resource: 'life', sign: '+', kind: 'value' }] });
  });
});
