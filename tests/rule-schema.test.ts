import { describe, it, expect } from 'vitest';
import { EdgeRuleItemZ, PairsResponse, RolesResponse, ruleHash, type EdgeRuleItem } from '../src/graph/ruleSchema.js';

// Synthetic items: the test checks the hash and the shapes, not whether a rule is true in Magic.
// The shape of spec sec. 5.1: a type supply side, a demand side with a predicate, one
// implication with its own quote.
const ev = (ref: string, quote: string) => ({ source: 'rule' as const, ref, quote });
const base: EdgeRuleItem = {
  polarity: '+',
  supply: { family: 'ENABLES', type_key: 'SUPPLY_X', where: [{ param: 'p1', op: 'eq', value: 'a' }, { param: 'p2', op: 'in', value: ['y', 'x'] }] },
  demand: { family: 'CARES_ABOUT', type_key: 'DEMAND_Y', where: [] },
  param_links: [{ supply: 'p1', demand: 'q1' }, { supply: 'p2', demand: 'q2' }],
  implications: [{ demand_param: 'controller', value: 'you', evidence: [ev('1.1', 'quote one')] }, { demand_param: 'k', value: 2, evidence: [] }],
  evidence: [ev('1.2', 'quote two')],
};

describe('ruleHash (spec sec. 5.1)', () => {
  it('is the same when keys, predicates, links, implications and set values have a different order', () => {
    const shuffled = JSON.parse(JSON.stringify({
      evidence: base.evidence,
      implications: [...base.implications].reverse(),
      param_links: [...base.param_links].reverse(),
      demand: { where: [], type_key: 'DEMAND_Y', family: 'CARES_ABOUT' },
      supply: { where: [{ value: ['x', 'y'], op: 'in', param: 'p2' }, { op: 'eq', param: 'p1', value: 'a' }], type_key: 'SUPPLY_X', family: 'ENABLES' },
      polarity: '+',
    })) as EdgeRuleItem;
    expect(ruleHash(shuffled)).toBe(ruleHash(base));
  });

  it('ignores evidence, also the evidence of an implication', () => {
    const other = {
      ...base,
      evidence: [ev('9.9', 'a different quote')],
      implications: base.implications.map((i) => ({ ...i, evidence: [ev('8.8', 'x')] })),
    };
    expect(ruleHash(other)).toBe(ruleHash(base));
  });

  it('changes when the polarity, a type key, a predicate value or a link changes', () => {
    const h = ruleHash(base);
    expect(ruleHash({ ...base, polarity: '-' })).not.toBe(h);
    expect(ruleHash({ ...base, demand: { ...base.demand, type_key: 'DEMAND_Z' } })).not.toBe(h);
    const supply = base.supply as Extract<EdgeRuleItem['supply'], { where: unknown }>;
    expect(ruleHash({ ...base, supply: { ...supply, where: [{ param: 'p1', op: 'eq', value: 'b' }, supply.where[1]!] } })).not.toBe(h);
    expect(ruleHash({ ...base, param_links: [{ supply: 'p1', demand: 'q2' }, { supply: 'p2', demand: 'q2' }] })).not.toBe(h);
    expect(ruleHash({ ...base, implications: [base.implications[0]!] })).not.toBe(h);
  });

  it('ignores a repeated value of a set operator', () => {
    const where = (value: unknown[]) => ({ ...base, demand: { ...base.demand, where: [{ param: 'q', op: 'in' as const, value }] } });
    expect(ruleHash(where(['a', 'a', 'b']))).toBe(ruleHash(where(['b', 'a'])));
  });

  it('separates an intrinsic class by kind and value', () => {
    const cls = (intrinsic: 'card_type' | 'mana_value', value: string | number): EdgeRuleItem => ({ ...base, supply: { intrinsic, value }, param_links: [] });
    expect(ruleHash(cls('card_type', 'A'))).toBe(ruleHash(cls('card_type', 'A')));
    expect(ruleHash(cls('card_type', 'A'))).not.toBe(ruleHash(cls('card_type', 'B')));
    expect(ruleHash(cls('mana_value', 2))).not.toBe(ruleHash(cls('card_type', 'B')));
  });
});

describe('response schemas (spec sec. 5.1, 5.3)', () => {
  it('drops an empty where of an intrinsic class, and reads a null note as no note', () => {
    const r = EdgeRuleItemZ.parse({ ...base, supply: { intrinsic: 'card_type', value: 'A', where: [] } });
    expect(r.supply).toEqual({ intrinsic: 'card_type', value: 'A' });
    const role = { family: 'F', type_key: 'T', role: 'supply', demand_note: null,
      resources: [{ resource: 'life', sign: '+', kind: 'value', note: null, evidence: [] }], evidence: [] };
    const parsed = RolesResponse.parse({ roles: [role], missing_rules: [] });
    expect(parsed.roles[0]!.demand_note).toBeUndefined();
    expect(parsed.roles[0]!.resources[0]!.note).toBeUndefined();
  });

  it('accepts the rule shape of sec. 5.1 and an intrinsic supply side', () => {
    expect(EdgeRuleItemZ.safeParse(base).success).toBe(true);
    expect(EdgeRuleItemZ.safeParse({ ...base, supply: { intrinsic: 'card_type', value: 'A' } }).success).toBe(true);
    expect(PairsResponse.safeParse({ rules: [base], missing_rules: [{ needed: 'n', rationale: 'r' }] }).success).toBe(true);
  });

  it('rejects an unknown field at each level', () => {
    expect(EdgeRuleItemZ.safeParse({ ...base, weight: 1 }).success).toBe(false);
    expect(EdgeRuleItemZ.safeParse({ ...base, demand: { ...base.demand, label: 'x' } }).success).toBe(false);
    expect(EdgeRuleItemZ.safeParse({ ...base, evidence: [{ ...base.evidence[0], page: 1 }] }).success).toBe(false);
    expect(EdgeRuleItemZ.safeParse({ ...base, supply: { intrinsic: 'card_type', value: 'A', where: [{ param: 'p', op: 'eq', value: 1 }] } }).success).toBe(false);
    expect(PairsResponse.safeParse({ rules: [], missing_rules: [], notes: 'x' }).success).toBe(false);
    expect(EdgeRuleItemZ.safeParse({ ...base, supply: { ...base.supply, where: [{ param: 'p', op: 'lt', value: 1 }] } }).success).toBe(false);
  });

  it('accepts a role item and rejects a role or a resource field outside the shape', () => {
    const role = {
      family: 'PRODUCES', type_key: 'T', role: 'supply',
      resources: [{ resource: 'other', sign: '+', kind: 'value', note: 'n', evidence: [ev('1.1', 'q')] }],
      evidence: [ev('1.1', 'q')],
    };
    expect(RolesResponse.safeParse({ roles: [role], missing_rules: [] }).success).toBe(true);
    expect(RolesResponse.safeParse({ roles: [{ ...role, role: 'maybe' }], missing_rules: [] }).success).toBe(false);
    expect(RolesResponse.safeParse({ roles: [{ ...role, resources: [{ ...role.resources[0], kind: 'both' }] }], missing_rules: [] }).success).toBe(false);
    expect(RolesResponse.safeParse({ roles: [role] }).success).toBe(false);
  });
});
