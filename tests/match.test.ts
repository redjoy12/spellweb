import { describe, it, expect } from 'vitest';
import { gradeOf, matchRule, predicateHolds, resolveParams, supplyHolds, type AtomLite } from '../src/graph/match.js';
import type { EdgeRuleContent, Predicate } from '../src/graph/ruleSchema.js';

// Synthetic atoms and rules: these tests check the mechanics of spec sec. 7.2 only. The type
// keys and params are placeholders, not Magic facts.
const atom = (id: number, family: string, type_key: string, params: Record<string, unknown>, oracle = 'card-a'): AtomLite =>
  ({ id, oracle_id: oracle, face_index: 0, family, type_key, params, span_start: 0, span_end: 1 });

const rule = (over: Partial<EdgeRuleContent> = {}): EdgeRuleContent => ({
  polarity: '+',
  supply: { family: 'S', type_key: 'SUP', where: [] },
  demand: { family: 'D', type_key: 'DEM', where: [] },
  param_links: [],
  implications: [],
  ...over,
});

describe('predicateHolds (spec sec. 5.1 operators)', () => {
  const p = (op: Predicate['op'], value: unknown, param = 'x'): Predicate => ({ param, op, value });
  it.each([
    ['eq equal', p('eq', 'a'), { x: 'a' }, true],
    ['eq different', p('eq', 'a'), { x: 'b' }, false],
    ['in member', p('in', ['a', 'b']), { x: 'b' }, true],
    ['in not member', p('in', ['a', 'b']), { x: 'c' }, false],
    ['overlaps common value', p('overlaps', ['a', 'b']), { x: ['b', 'c'] }, true],
    ['overlaps no common value', p('overlaps', ['a']), { x: ['c'] }, false],
    ['overlaps empty param array agrees with all', p('overlaps', ['a']), { x: [] }, true],
    ['disjoint no common value', p('disjoint', ['a']), { x: ['b'] }, true],
    ['disjoint common value', p('disjoint', ['a']), { x: ['a', 'b'] }, false],
    ['absent param', p('eq', 'a'), {}, false],
  ] as const)('%s', (_name, pred, params, want) => {
    expect(predicateHolds(pred, params as Record<string, unknown>)).toBe(want);
  });
});

describe('grade version 3: a supply `subtypes` array that is empty (spec rev. 26 sec. 7.2)', () => {
  const on = (param: string, side: 'supply' | 'demand') => rule({ [side]: { family: side === 'supply' ? 'S' : 'D', type_key: side === 'supply' ? 'SUP' : 'DEM', where: [{ param, op: 'overlaps', value: ['a'] }] } });
  const demand = atom(2, 'D', 'DEM', {}, 'card-b');
  it('fails from version 3, and passes in a stored build of version 2', () => {
    const supply = atom(1, 'S', 'SUP', { subtypes: [] });
    expect(matchRule(on('subtypes', 'supply'), supply, demand, [], 2)).not.toBeNull();
    expect(matchRule(on('subtypes', 'supply'), supply, demand, [], 3)).toBeNull();
    expect(supplyHolds(on('subtypes', 'supply'), supply, false, 2)).toBe(true);
    expect(supplyHolds(on('subtypes', 'supply'), supply, false, 3)).toBe(false);
  });
  it('keeps a named value, and the empty rule of the other params and of the demand side', () => {
    expect(matchRule(on('subtypes', 'supply'), atom(1, 'S', 'SUP', { subtypes: ['a'] }), demand, [], 3)).not.toBeNull();
    expect(matchRule(on('card_types', 'supply'), atom(1, 'S', 'SUP', { card_types: [] }), demand, [], 3)).not.toBeNull();
    expect(matchRule(on('subtypes', 'demand'), atom(1, 'S', 'SUP', {}), atom(2, 'D', 'DEM', { subtypes: [] }, 'card-b'), [], 3)).not.toBeNull();
  });
});

describe('resolveParams (spec sec. 7.2 resolutions)', () => {
  const link = { param_links: [{ supply: 's', demand: 'd' }] };
  it('agrees by link when the values are equal', () => {
    const r = resolveParams(rule(link), atom(1, 'S', 'SUP', { s: 'a' }), atom(2, 'D', 'DEM', { d: 'a' }), ['d']);
    expect(r.get('d')).toBe('agrees');
  });
  it('agrees by implication', () => {
    const imp = { implications: [{ demand_param: 'd', value: 'a', evidence: [] }] };
    const r = resolveParams(rule(imp), atom(1, 'S', 'SUP', {}), atom(2, 'D', 'DEM', { d: 'a' }), ['d']);
    expect(r.get('d')).toBe('agrees');
  });
  it('a demand value any agrees with all supply values', () => {
    const r = resolveParams(rule(link), atom(1, 'S', 'SUP', { s: 'b' }), atom(2, 'D', 'DEM', { d: 'any' }), ['d']);
    expect(r.get('d')).toBe('agrees');
  });
  it('is partial when the supply value is any and the demand value is specific', () => {
    const r = resolveParams(rule(link), atom(1, 'S', 'SUP', { s: 'any' }), atom(2, 'D', 'DEM', { d: 'a' }), ['d']);
    expect(r.get('d')).toBe('partial');
  });
  it('is unresolved with no link and no implication', () => {
    const r = resolveParams(rule(), atom(1, 'S', 'SUP', { s: 'a' }), atom(2, 'D', 'DEM', { d: 'a' }), ['d']);
    expect(r.get('d')).toBe('unresolved');
  });
  it('is unresolved when the linked supply param is absent on the supply atom', () => {
    const r = resolveParams(rule(link), atom(1, 'S', 'SUP', {}), atom(2, 'D', 'DEM', { d: 'a' }), ['d']);
    expect(r.get('d')).toBe('unresolved');
  });
  it('is unresolved for an intrinsic supply with a link (a class has no params)', () => {
    const r = resolveParams(rule(link), { id: 'INTRINSIC.card_type(X)', intrinsic: 'card_type', value: 'X', members: [] },
      atom(2, 'D', 'DEM', { d: 'a' }), ['d']);
    expect(r.get('d')).toBe('unresolved');
  });
  it('disagrees when two specific values are different', () => {
    const r = resolveParams(rule(link), atom(1, 'S', 'SUP', { s: 'a' }), atom(2, 'D', 'DEM', { d: 'b' }), ['d']);
    expect(r.get('d')).toBe('disagrees');
  });
  it('for arrays, the demand operator gives the agreement (overlaps by default, disjoint when the rule says so)', () => {
    const s = atom(1, 'S', 'SUP', { s: ['a', 'b'] });
    expect(resolveParams(rule(link), s, atom(2, 'D', 'DEM', { d: ['b'] }), ['d']).get('d')).toBe('agrees');
    expect(resolveParams(rule(link), s, atom(2, 'D', 'DEM', { d: ['c'] }), ['d']).get('d')).toBe('disagrees');
    expect(resolveParams(rule(link), s, atom(2, 'D', 'DEM', { d: [] }), ['d']).get('d')).toBe('agrees');
    const dis = rule({ ...link, demand: { family: 'D', type_key: 'DEM', where: [{ param: 'd', op: 'disjoint', value: ['z'] }] } });
    expect(resolveParams(dis, s, atom(2, 'D', 'DEM', { d: ['c'] }), ['d']).get('d')).toBe('agrees');
    expect(resolveParams(dis, s, atom(2, 'D', 'DEM', { d: ['a'] }), ['d']).get('d')).toBe('disagrees');
  });
  it('gives a resolution only for the demand params that the demand atom has', () => {
    const r = resolveParams(rule(), atom(1, 'S', 'SUP', {}), atom(2, 'D', 'DEM', { d: 'a' }), ['d', 'e']);
    expect([...r.keys()]).toEqual(['d']);
  });
});

describe('resolveParams, grade version 2 (spec rev. 19 sec. 7.2)', () => {
  const s = atom(1, 'S', 'SUP', { s: 'a' });
  it.each(['any', '', 'not_stated', [], ['any', 'x']])('a demand value that states no restriction agrees: %j', (v) => {
    expect(resolveParams(rule(), s, atom(2, 'D', 'DEM', { d: v }), ['d'], 1).get('d')).toBe('unresolved');
    expect(resolveParams(rule(), s, atom(2, 'D', 'DEM', { d: v }), ['d'], 2).get('d')).toBe('agrees');
  });
  it('a no-restriction demand value agrees also against a linked supply value', () => {
    const r = rule({ param_links: [{ supply: 's', demand: 'd' }] });
    expect(resolveParams(r, s, atom(2, 'D', 'DEM', { d: '' }), ['d'], 1).get('d')).toBe('disagrees');
    expect(resolveParams(r, s, atom(2, 'D', 'DEM', { d: '' }), ['d'], 2).get('d')).toBe('agrees');
  });
  it('a demand predicate resolves the param when no link and no implication covers it', () => {
    const r = rule({ demand: { family: 'D', type_key: 'DEM', where: [{ param: 'd', op: 'in', value: ['x', 'y'] }] } });
    expect(resolveParams(r, s, atom(2, 'D', 'DEM', { d: 'x' }), ['d'], 1).get('d')).toBe('unresolved');
    expect(resolveParams(r, s, atom(2, 'D', 'DEM', { d: 'x' }), ['d'], 2).get('d')).toBe('agrees');
    expect(matchRule(r, s, atom(2, 'D', 'DEM', { d: 'x' }), ['d'], 2)?.grade).toBe('confirmed');
  });
  it('a link keeps priority over a predicate and can still disagree', () => {
    const r = rule({ param_links: [{ supply: 's', demand: 'd' }], demand: { family: 'D', type_key: 'DEM', where: [{ param: 'd', op: 'eq', value: 'b' }] } });
    expect(resolveParams(r, s, atom(2, 'D', 'DEM', { d: 'b' }), ['d'], 2).get('d')).toBe('disagrees');
  });
});

describe('gradeOf (spec sec. 7.2 grades)', () => {
  const m = (e: Array<[string, 'agrees' | 'partial' | 'unresolved' | 'disagrees']>) => new Map(e);
  it('all agrees gives confirmed', () => {
    expect(gradeOf(m([['a', 'agrees'], ['b', 'agrees']]))).toEqual({ grade: 'confirmed', unresolved: [] });
  });
  it('a demand type with no params gives confirmed', () => {
    expect(gradeOf(m([]))).toEqual({ grade: 'confirmed', unresolved: [] });
  });
  it('any disagrees gives rejected', () => {
    expect(gradeOf(m([['a', 'unresolved'], ['b', 'disagrees']])).grade).toBe('rejected');
  });
  it('other cases give plausible with the names of the params that are not resolved, sorted', () => {
    expect(gradeOf(m([['c', 'partial'], ['a', 'agrees'], ['b', 'unresolved']]))).toEqual({ grade: 'plausible', unresolved: ['b', 'c'] });
  });
});

describe('the example of spec sec. 5.1', () => {
  // A rule from ENABLES.SACRIFICE_OUTLET to CARES_ABOUT.PERMANENT_DIES with the implication
  // controller = you. The rule cannot link permanent_type.
  const r = rule({
    supply: { family: 'ENABLES', type_key: 'SACRIFICE_OUTLET', where: [] },
    demand: { family: 'CARES_ABOUT', type_key: 'PERMANENT_DIES', where: [] },
    implications: [{ demand_param: 'controller', value: 'you', evidence: [] }],
  });
  const supply = atom(1, 'ENABLES', 'SACRIFICE_OUTLET', { cost_type: 'costed' });
  const params = ['permanent_type', 'controller'];

  it('gives plausible with permanent_type unresolved for controller = you', () => {
    const demand = atom(2, 'CARES_ABOUT', 'PERMANENT_DIES', { permanent_type: 'creature', controller: 'you' }, 'card-b');
    expect(gradeOf(resolveParams(r, supply, demand, params))).toEqual({ grade: 'plausible', unresolved: ['permanent_type'] });
    expect(matchRule(r, supply, demand, params)).toEqual({ grade: 'plausible', unresolved: ['permanent_type'], partial: [] });
  });
  it('gives rejected for controller = opponent', () => {
    const demand = atom(2, 'CARES_ABOUT', 'PERMANENT_DIES', { permanent_type: 'creature', controller: 'opponent' }, 'card-b');
    expect(gradeOf(resolveParams(r, supply, demand, params)).grade).toBe('rejected');
    expect(matchRule(r, supply, demand, params)).toBeNull();
  });
});

describe('matchRule', () => {
  it('needs the rule types and every predicate of both sides', () => {
    const r = rule({
      supply: { family: 'S', type_key: 'SUP', where: [{ param: 's', op: 'eq', value: 'a' }] },
      demand: { family: 'D', type_key: 'DEM', where: [{ param: 'd', op: 'in', value: ['x', 'any'] }] },
    });
    expect(matchRule(r, atom(1, 'S', 'SUP', { s: 'a' }), atom(2, 'D', 'DEM', { d: 'x' }), ['d'])?.grade).toBe('plausible');
    expect(matchRule(r, atom(1, 'S', 'SUP', { s: 'b' }), atom(2, 'D', 'DEM', { d: 'x' }), ['d'])).toBeNull();
    expect(matchRule(r, atom(1, 'S', 'SUP', { s: 'a' }), atom(2, 'D', 'DEM', { d: 'y' }), ['d'])).toBeNull();
    expect(matchRule(r, atom(1, 'S', 'OTHER', { s: 'a' }), atom(2, 'D', 'DEM', { d: 'x' }), ['d'])).toBeNull();
  });
  it('never matches an atom with itself', () => {
    const r = rule({ supply: { family: 'D', type_key: 'DEM', where: [] } });
    const a = atom(1, 'D', 'DEM', {});
    expect(matchRule(r, a, a, [])).toBeNull();
    expect(matchRule(r, a, { ...a, id: 2 }, [])).toEqual({ grade: 'confirmed', unresolved: [], partial: [] });
  });
  it('lists the partial params apart from the unresolved ones, for the gap report', () => {
    const r = rule({ param_links: [{ supply: 's', demand: 'd' }] });
    const m = matchRule(r, atom(1, 'S', 'SUP', { s: 'any' }), atom(2, 'D', 'DEM', { d: 'a', e: 'b' }), ['d', 'e']);
    expect(m).toEqual({ grade: 'plausible', unresolved: ['d', 'e'], partial: ['d'] });
  });
});
