import { describe, it, expect } from 'vitest';
import { matchRule, type AtomLite } from '../src/graph/match.js';
import type { Predicate } from '../src/graph/ruleSchema.js';
import type { StoredRule } from '../src/graph/ruleSet.js';
import { findSubsumed, predicateImplies, subsumes } from '../src/graph/subsume.js';

// Synthetic rules: these tests check the mechanics of the subsumption check (spec rev. 11 sec. 5.8) only.
const P = (param: string, op: Predicate['op'], value: unknown): Predicate => ({ param, op, value });
let n = 0;
function rule(over: { id?: string; supplyWhere?: Predicate[]; demandWhere?: Predicate[]; links?: Array<[string, string]>;
  implies?: Array<[string, unknown]>; polarity?: '+' | '-'; supplyType?: string }): StoredRule {
  n++;
  return {
    rule_hash: `h${n}`, rule_id: over.id ?? `ER-${String(n).padStart(4, '0')}`, votes: 3, status: 'accepted',
    polarity: over.polarity ?? '+',
    supply: { family: 'PRODUCES', type_key: over.supplyType ?? 'CREATE', where: over.supplyWhere ?? [] },
    demand: { family: 'COMBAT', type_key: 'ANTHEM', where: over.demandWhere ?? [] },
    param_links: (over.links ?? []).map(([supply, demand]) => ({ supply, demand })),
    implications: (over.implies ?? []).map(([demand_param, value]) => ({ demand_param, value, evidence: [] })),
    evidence: [],
  };
}
const PARAMS = ['subject_type', 'controller', 'colors'];

describe('predicateImplies (spec sec. 5.1 operators)', () => {
  it('eq implies eq of the same value and in of a list with the value', () => {
    expect(predicateImplies(P('x', 'eq', 'a'), P('x', 'eq', 'a'))).toBe(true);
    expect(predicateImplies(P('x', 'eq', 'a'), P('x', 'in', ['a', 'b']))).toBe(true);
    expect(predicateImplies(P('x', 'eq', 'a'), P('x', 'in', ['b']))).toBe(false);
  });
  it('in implies in of a superset, and eq when the list has one value', () => {
    expect(predicateImplies(P('x', 'in', ['a']), P('x', 'in', ['a', 'b']))).toBe(true);
    expect(predicateImplies(P('x', 'in', ['a', 'b']), P('x', 'in', ['a']))).toBe(false);
    expect(predicateImplies(P('x', 'in', ['a']), P('x', 'eq', 'a'))).toBe(true);
    expect(predicateImplies(P('x', 'in', ['b', 'a']), P('x', 'in', ['a', 'b']))).toBe(true);
  });
  it('overlaps implies overlaps of a superset; disjoint implies disjoint of a subset', () => {
    expect(predicateImplies(P('x', 'overlaps', ['a']), P('x', 'overlaps', ['a', 'b']))).toBe(true);
    expect(predicateImplies(P('x', 'overlaps', ['a', 'b']), P('x', 'overlaps', ['a']))).toBe(false);
    expect(predicateImplies(P('x', 'disjoint', ['a', 'b']), P('x', 'disjoint', ['a']))).toBe(true);
    expect(predicateImplies(P('x', 'disjoint', ['a']), P('x', 'disjoint', ['a', 'b']))).toBe(false);
    expect(predicateImplies(P('x', 'overlaps', ['a']), P('x', 'disjoint', ['b']))).toBe(false);
  });
  it('a predicate on another param implies nothing', () => {
    expect(predicateImplies(P('x', 'eq', 'a'), P('y', 'eq', 'a'))).toBe(false);
  });
});

describe('subsumes (spec rev. 11 sec. 5.8)', () => {
  it('a rule with one more demand predicate is subsumed by the rule without it', () => {
    const wide = rule({ demandWhere: [P('subject_type', 'in', ['any', 'creature'])] });
    const narrow = rule({ demandWhere: [P('subject_type', 'in', ['any', 'creature']), P('controller', 'in', ['any', 'you'])] });
    expect(subsumes(wide, narrow, PARAMS)).toBe(true);
    expect(subsumes(narrow, wide, PARAMS)).toBe(false);
  });
  it('a wider supply predicate subsumes a narrower one', () => {
    const wide = rule({ supplyWhere: [P('subject_type', 'in', ['creature', 'artifact'])] });
    const narrow = rule({ supplyWhere: [P('subject_type', 'eq', 'creature')] });
    expect(subsumes(wide, narrow, PARAMS)).toBe(true);
  });
  it('a different polarity, supply type or demand type never subsumes', () => {
    const a = rule({});
    expect(subsumes(rule({ polarity: '-' }), a, PARAMS)).toBe(false);
    expect(subsumes(rule({ supplyType: 'TOKENS' }), a, PARAMS)).toBe(false);
  });
  it('a different link, a link that only one rule has, or an implication that only one rule has: no subsumption', () => {
    const base = rule({ links: [['controller', 'controller']] });
    expect(subsumes(rule({ links: [['owner', 'controller']] }), base, PARAMS)).toBe(false);
    expect(subsumes(rule({}), base, PARAMS)).toBe(false);
    expect(subsumes(base, rule({}), PARAMS)).toBe(false);
    expect(subsumes(rule({ implies: [['controller', 'you']] }), rule({}), PARAMS)).toBe(false);
    expect(subsumes(rule({ implies: [['controller', 'you']] }), rule({ implies: [['controller', 'any']] }), PARAMS)).toBe(false);
  });
  it('a demand predicate that changes the array operator of a resolved param: no subsumption', () => {
    const narrow = rule({ demandWhere: [P('colors', 'disjoint', ['B'])], links: [['colors', 'colors']] });
    const wide = rule({ links: [['colors', 'colors']] });
    expect(subsumes(wide, narrow, PARAMS)).toBe(false);
    // The same operator: the narrow rule only filters more.
    const narrow2 = rule({ demandWhere: [P('colors', 'overlaps', ['B'])], links: [['colors', 'colors']] });
    expect(subsumes(wide, narrow2, PARAMS)).toBe(true);
  });
  it('an implication subsumes a predicate whose values all agree with it, when the narrow rule leaves the param unresolved', () => {
    const narrow = rule({ demandWhere: [P('controller', 'in', ['any', 'you'])] });
    expect(subsumes(rule({ implies: [['controller', 'you']] }), narrow, PARAMS)).toBe(true);
    expect(subsumes(narrow, rule({ implies: [['controller', 'you']] }), PARAMS)).toBe(false);
    // A value that disagrees, a narrow rule that resolves the param, or a wide link: no subsumption.
    expect(subsumes(rule({ implies: [['controller', 'you']] }), rule({ demandWhere: [P('controller', 'in', ['you', 'opponent'])] }), PARAMS)).toBe(false);
    expect(subsumes(rule({ implies: [['controller', 'you']] }), rule({ demandWhere: [P('controller', 'eq', 'you')], links: [['controller', 'controller']] }), PARAMS)).toBe(false);
    expect(subsumes(rule({ implies: [['controller', 'you']], links: [['controller', 'controller']] }), narrow, PARAMS)).toBe(false);
  });
  it('a link to a param that the demand type does not have does not count', () => {
    const narrow = rule({ links: [['x', 'not_a_param']], demandWhere: [P('controller', 'eq', 'you')] });
    expect(subsumes(rule({}), narrow, PARAMS)).toBe(true);
    expect(subsumes(rule({}), narrow)).toBe(false);
  });
});

describe('subsumes, grade version 2 (spec rev. 19 sec. 5.8)', () => {
  it('a wide rule without the predicate does not subsume a narrow rule that a predicate resolves', () => {
    const narrow = rule({ demandWhere: [P('controller', 'eq', 'you')] });
    const wide = rule({});
    expect(subsumes(wide, narrow, PARAMS, 1)).toBe(true);
    expect(subsumes(wide, narrow, PARAMS, 2)).toBe(false);
    expect(subsumes(rule({ demandWhere: [P('controller', 'in', ['any', 'you'])] }), narrow, PARAMS, 2)).toBe(true);
    expect(subsumes(rule({ implies: [['controller', 'you']] }), narrow, PARAMS, 2)).toBe(true);
  });
});

describe('findSubsumed', () => {
  it('points each subsumed rule to a kept rule, also along a chain', () => {
    const c = rule({ id: 'ER-0003' });
    const b = rule({ id: 'ER-0002', demandWhere: [P('controller', 'in', ['any', 'you'])] });
    const a = rule({ id: 'ER-0001', demandWhere: [P('controller', 'eq', 'you')] });
    const m = findSubsumed([a, b, c], () => PARAMS);
    expect([...m.keys()].sort()).toEqual([a.rule_hash, b.rule_hash].sort());
    expect(m.get(a.rule_hash)!.wide.rule_id).toBe('ER-0003');
    expect(m.get(b.rule_hash)!.wide.rule_id).toBe('ER-0003');
  });
  it('two rules equal in effect: the lower rule ID stays', () => {
    const x = rule({ id: 'ER-0010', demandWhere: [P('controller', 'eq', 'you')] });
    const y = rule({ id: 'ER-0011', demandWhere: [P('controller', 'in', ['you'])] });
    const m = findSubsumed([y, x], () => PARAMS);
    expect([...m.keys()]).toEqual([y.rule_hash]);
    expect(m.get(y.rule_hash)!.wide.rule_id).toBe('ER-0010');
  });
  it('conflicting rules both stay', () => {
    const x = rule({ links: [['controller', 'controller']] });
    const y = rule({ demandWhere: [P('controller', 'eq', 'you')] });
    expect(findSubsumed([x, y], () => PARAMS).size).toBe(0);
  });
});

describe('a subsumed rule adds no edge and changes no grade (random atoms)', () => {
  const values: Record<string, unknown[]> = { subject_type: ['any', 'creature', 'artifact'], controller: ['any', 'you', 'opponent'], colors: [[], ['B'], ['R'], ['B', 'R']] };
  const preds: Predicate[] = [
    P('subject_type', 'in', ['any', 'creature']), P('subject_type', 'eq', 'creature'), P('controller', 'in', ['any', 'you']),
    P('controller', 'eq', 'you'), P('colors', 'overlaps', ['B']), P('colors', 'overlaps', ['B', 'R']), P('colors', 'disjoint', ['R']),
  ];
  const links: Array<[string, string]> = [['controller', 'controller'], ['colors', 'colors']];
  const imps: Array<[string, unknown]> = [['subject_type', 'creature'], ['controller', 'any']];
  it.each([1, 2])('grade version %i: each atom pair that the narrow rule matches, the wide rule matches with the same or a better grade', (version) => {
    let seed = 42;
    const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
    const some = <T>(xs: readonly T[]): T[] => xs.filter(() => rng() < 0.3);
    const atom = (id: number, family: string, type_key: string): AtomLite => ({
      id, oracle_id: `c${id}`, face_index: 0, family, type_key, span_start: 0, span_end: 1,
      params: Object.fromEntries(Object.entries(values).filter(() => rng() < 0.85).map(([k, v]) => [k, pick(v)])),
    });
    const supplies = Array.from({ length: 40 }, (_, i) => atom(i, 'PRODUCES', 'CREATE'));
    const demands = Array.from({ length: 40 }, (_, i) => atom(100 + i, 'COMBAT', 'ANTHEM'));
    let pairs = 0;
    let better = 0;
    for (let t = 0; t < 400; t++) {
      // The second rule has the links and implications of the first, and more predicates; a third rule is random.
      const l = some(links);
      const i = some(imps);
      const sw = some(preds);
      const dw = some(preds);
      const rs = [rule({ supplyWhere: sw, demandWhere: dw, links: l, implies: i }),
        rule({ supplyWhere: [...sw, ...some(preds)], demandWhere: [...dw, ...some(preds)], links: l, implies: i }),
        rule({ supplyWhere: some(preds), demandWhere: some(preds), links: some(links), implies: some(imps) })];
      // A rule that gives an implication where the second rule only filters with a predicate.
      const dropped = (rs[1]!.demand.where).filter((p) => p.param === 'controller' && (p.op === 'eq' || p.op === 'in'));
      if (dropped.length) {
        rs.push(rule({ supplyWhere: sw, demandWhere: dw.filter((p) => p.param !== 'controller'), links: l,
          implies: [...i.filter(([dp]) => dp !== 'controller'), ['controller', 'you']] }));
      }
      for (const [w, nr] of rs.flatMap((a) => rs.filter((b) => b !== a).map((b) => [a, b] as const))) {
        if (!subsumes(w, nr, PARAMS, version)) continue;
        pairs++;
        for (const s of supplies) {
          for (const d of demands) {
            const mn = matchRule(nr, s, d, PARAMS, version);
            if (!mn) continue;
            const mw = matchRule(w, s, d, PARAMS, version);
            // The merge (sec. 7.3) keeps the better part: the wide part must not be worse.
            expect(mw).not.toBeNull();
            if (mn.grade === 'confirmed') expect(mw!.grade).toBe('confirmed');
            expect(mw!.unresolved.every((u) => mn.unresolved.includes(u))).toBe(true);
            if (mw!.unresolved.length < mn.unresolved.length) better++;
          }
        }
      }
    }
    expect(pairs).toBeGreaterThan(100);
    // In version 2 a predicate of the narrow rule already resolves its param (sec. 7.2 step 4).
    if (version === 1) expect(better).toBeGreaterThan(0);
  });
});
