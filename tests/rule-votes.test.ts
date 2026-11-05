import { describe, it, expect } from 'vitest';
import { ruleHash, type EdgeRuleItem, type RoleItem } from '../src/graph/ruleSchema.js';
import { voteRoles, voteRules } from '../src/graph/ruleVotes.js';

// Synthetic items (spec sec. 5.3 votes). The test checks the vote mechanics only.
const ev = (ref: string, quote = `q${ref}`) => ({ source: 'rule' as const, ref, quote });
const role = (type_key: string, r: RoleItem['role'], over: Partial<RoleItem> = {}): RoleItem =>
  ({ family: 'F', type_key, role: r, resources: [], evidence: [ev('1')], ...over });
const rule = (demand: string, over: Partial<EdgeRuleItem> = {}): EdgeRuleItem => ({
  polarity: '+', supply: { family: 'S', type_key: 'X', where: [] }, demand: { family: 'D', type_key: demand, where: [] },
  param_links: [], implications: [], evidence: [ev('1')], ...over,
});

describe('voteRoles (spec sec. 5.3, Stage A)', () => {
  it('accepts a role from two of three passes', () => {
    const r = voteRoles([[role('A', 'demand')], [role('A', 'demand')], [role('A', 'supply')]]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]).toMatchObject({ type_key: 'A', role: 'demand', votes: 2 });
    expect(r.disputed).toHaveLength(0);
  });

  it('gives a type with no majority role the role none and a disputed item', () => {
    const r = voteRoles([[role('A', 'demand')], [role('A', 'supply')], [role('A', 'both')]]);
    expect(r.accepted).toHaveLength(0);
    expect(r.disputed).toEqual([expect.objectContaining({ type_key: 'A', role: 'none', votes: 1 })]);
    // A type from one pass only has no majority either.
    expect(voteRoles([[role('B', 'supply')], [], []]).disputed[0]).toMatchObject({ type_key: 'B', role: 'none' });
  });

  it('agrees resource effects on exact resource, sign and kind', () => {
    const eff = (resource: string, sign: '+' | '-', kind: 'cost' | 'value', ref = '2') => ({ resource, sign, kind, evidence: [ev(ref)] });
    const r = voteRoles([
      [role('A', 'supply', { resources: [eff('life', '+', 'value'), eff('mana', '-', 'cost')] })],
      [role('A', 'supply', { resources: [eff('life', '+', 'value', '3'), eff('mana', '-', 'value')] })],
      [role('A', 'supply', { resources: [eff('life', '-', 'value')] })],
    ]);
    expect(r.accepted[0]!.resources).toEqual([{ resource: 'life', sign: '+', kind: 'value', evidence: [ev('2'), ev('3')] }]);
  });

  it('keeps the demand note of each pass that gave the accepted role', () => {
    const r = voteRoles([
      [role('A', 'demand', { demand_note: 'note one' })],
      [role('A', 'supply', { demand_note: 'not kept' })],
      [role('A', 'demand', { demand_note: 'note three' })],
    ]);
    expect(r.accepted[0]!.demand_notes).toEqual(['note one', 'note three']);
    expect(r.accepted[0]!.demand_note).toBe('note one\nnote three');
  });

  it('keeps the union of the verified quotes of the passes that gave the role', () => {
    const r = voteRoles([
      [role('A', 'demand', { evidence: [ev('1'), ev('2')] })],
      [role('A', 'demand', { evidence: [ev('2'), ev('3')] })],
      [role('A', 'supply', { evidence: [ev('9')] })],
    ]);
    expect(r.accepted[0]!.evidence).toEqual([ev('1'), ev('2'), ev('3')]);
  });

  it('counts a pass one time when it gives a type two times', () => {
    const r = voteRoles([[role('A', 'demand'), role('A', 'demand')], [], []]);
    expect(r.disputed[0]).toMatchObject({ votes: 1 });
  });
});

describe('voteRules (spec sec. 5.3, Stage B)', () => {
  it('accepts a rule from two passes with the same rule_hash, with votes = 2', () => {
    const a = rule('Y');
    const same = { ...rule('Y'), evidence: [ev('5')] };
    const r = voteRules([[a], [same], [rule('Z')]]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]).toMatchObject({ votes: 2, rule_hash: ruleHash(a) });
    expect(r.disputed).toEqual([expect.objectContaining({ votes: 1, rule_hash: ruleHash(rule('Z')) })]);
  });

  it('keeps the union of the verified quotes of all passes, also inside the implications', () => {
    const impl = (ref: string) => [{ demand_param: 'c', value: 'v', evidence: [ev(ref)] }];
    const r = voteRules([
      [rule('Y', { evidence: [ev('1')], implications: impl('7') })],
      [rule('Y', { evidence: [ev('2')], implications: impl('8') })],
      [rule('Y', { evidence: [ev('1')], implications: impl('7') })],
    ]);
    expect(r.accepted[0]).toMatchObject({ votes: 3, evidence: [ev('1'), ev('2')] });
    expect(r.accepted[0]!.implications[0]!.evidence).toEqual([ev('7'), ev('8')]);
  });

  it('counts a pass one time when it gives the same rule two times', () => {
    const r = voteRules([[rule('Y'), rule('Y')], [], []]);
    expect(r.accepted).toHaveLength(0);
    expect(r.disputed[0]).toMatchObject({ votes: 1 });
  });
});
