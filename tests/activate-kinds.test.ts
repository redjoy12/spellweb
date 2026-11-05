import { describe, it, expect } from 'vitest';
import { BuildIndex, type IndexAtom } from '../src/graph/buildIndex.js';
import { loadGraphPolicy } from '../src/graph/policy.js';
import type { StoredRule } from '../src/graph/ruleSet.js';

// Spec sec. 21 item M3: on a v16 build a keyword kind (here EQUIP) is also ENABLES.ACTIVATE. The
// rules below are synthetic data, not Magic facts.

const atom = (id: number, card: string, family: string, type_key: string, params: Record<string, unknown> = {}): IndexAtom => ({
  id, oracle_id: card, face_index: 0, family, type_key, params, span_start: 0, span_end: 5,
  group: `${card}#0#0`, kind: 'activated', span: [0, 5], mv: 2,
});
const side = (family: string, type_key: string, where: StoredRule['demand']['where'] = []) => ({ family, type_key, where });
const rule = (hash: string, supply: StoredRule['supply'], demand: StoredRule['demand']): StoredRule => ({
  rule_hash: hash, rule_id: hash, votes: 3, status: 'accepted', polarity: '+', supply, demand,
  param_links: [], implications: [], evidence: [],
});

function index(activateKinds: boolean): BuildIndex {
  const atoms = [
    atom(1, 'K', 'ENABLES', 'EQUIP', { cost_mana: 'yes', cost_tap: 'no' }),
    atom(2, 'U', 'ENABLES', 'UNTAPPER'),
    atom(3, 'Y', 'CARES_ABOUT', 'X'),
    atom(4, 'Z', 'PRODUCES', 'P'),
    atom(5, 'A', 'ENABLES', 'ACTIVATE', { cost_mana: 'no', cost_tap: 'yes' }),
  ];
  return new BuildIndex({
    atoms: new Map(atoms.map((a) => [a.id, a])),
    rules: [
      rule('r1', side('ENABLES', 'UNTAPPER'), side('ENABLES', 'ACTIVATE', [{ param: 'cost_tap', op: 'eq', value: 'yes' }])),
      rule('r2', side('ENABLES', 'UNTAPPER'), side('ENABLES', 'ACTIVATE')),
      rule('r3', side('ENABLES', 'ACTIVATE', [{ param: 'cost_mana', op: 'eq', value: 'yes' }]), side('CARES_ABOUT', 'X')),
      rule('r4', side('PRODUCES', 'P'), side('ENABLES', 'EQUIP')),
    ],
    classes: [],
    params: new Map([['ENABLES.ACTIVATE', ['cost_mana', 'cost_tap']], ['ENABLES.EQUIP', []]]),
    policy: loadGraphPolicy(),
    activateKinds,
  });
}
const key = (e: { rule_hash: string; supply_atom_id: number | null; demand_atom_id: number }) => `${e.rule_hash}:${e.supply_atom_id}>${e.demand_atom_id}`;

describe('BuildIndex with activateKinds (M3)', () => {
  it('lets ACTIVATE rules reach a keyword atom, with the ACTIVATE predicates and params', () => {
    const idx = index(true);
    const equip = idx.atoms.get(1)!;
    const into = idx.edgesToDemand(equip);
    expect(into.map(key).sort()).toEqual(['r2:2>1', 'r4:4>1']);
    // r2 grades with the ACTIVATE params (unresolved), r4 with the EQUIP params (none).
    expect(into.find((e) => e.rule_hash === 'r2')!.grade).toBe('plausible');
    expect(into.find((e) => e.rule_hash === 'r4')!.grade).toBe('confirmed');
    expect(idx.edgesFromSupply(equip).map(key)).toEqual(['r3:1>3']);
    // The plain ACTIVATE atom keeps its own edges, and no edge comes two times.
    expect(idx.edgesToDemand(idx.atoms.get(5)!).map(key).sort()).toEqual(['r1:2>5', 'r2:2>5']);
    const all = [...idx.atoms.values()].flatMap((a) => idx.edgesFromSupply(a)).map(key);
    expect(new Set(all).size).toBe(all.length);
    expect(idx.typesOf(equip)).toEqual(['ENABLES.EQUIP', 'ENABLES.ACTIVATE']);
  });

  it('matches exact types only when the flag is off (a build before v16)', () => {
    const idx = index(false);
    const equip = idx.atoms.get(1)!;
    expect(idx.edgesToDemand(equip).map(key)).toEqual(['r4:4>1']);
    expect(idx.edgesFromSupply(equip)).toEqual([]);
    expect(idx.typesOf(equip)).toEqual(['ENABLES.EQUIP']);
  });
});
