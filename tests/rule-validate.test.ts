import { describe, it, expect, beforeAll } from 'vitest';
import { currentSchemaVersion } from '../src/atoms/schema.js';
import { packetContext, planPairPackets, type PacketChunk } from '../src/graph/edgePackets.js';
import { loadGraphPolicy } from '../src/graph/policy.js';
import type { Evidence } from '../src/graph/quotes.js';
import type { EdgeRuleItem, RoleItem } from '../src/graph/ruleSchema.js';
import { baseContext, linkCompatible, validateRole, validateRule, type ParamSchema, type ValidateContext } from '../src/graph/ruleValidate.js';
import { maybe, realDb as db, realCorpusId as corpusId } from './helpers/realDb.js';

// spec sec. 5.4, on the real v14 schema and CR text. The items are synthetic data shapes: the
// test checks the validation, not whether a rule is true in Magic. Every name, value and quote
// comes from the database, never from memory.

maybe('validateRule and validateRole (spec sec. 5.4)', () => {
  let ctx: ValidateContext;
  let chunk: PacketChunk;
  let good: Evidence;
  let goodGlossary: Evidence;
  let outside: string;
  let demand: string;
  let supply: string;
  let enumParam: { name: string; values: unknown[] };
  let arrayType: { id: string; param: string; values: unknown[] };

  const side = (id: string, where: EdgeRuleItem['demand']['where'] = []) =>
    ({ family: id.slice(0, id.indexOf('.')), type_key: id.slice(id.indexOf('.') + 1), where });
  const rule = (over: Partial<EdgeRuleItem> = {}): EdgeRuleItem => ({
    polarity: '+', supply: side(supply), demand: side(demand), param_links: [], implications: [], evidence: [good], ...over,
  });

  beforeAll(() => {
    const schemaVersion = currentSchemaVersion(db);
    const pctx = packetContext(db);
    const policy = loadGraphPolicy();
    const base = baseContext(db, { corpusId, schemaVersion, scope: 'BR', resources: policy.resources });
    // A demand type with an enum param, and the first other type as a supply candidate.
    const withEnum = [...base.types].find(([, p]) => Object.values(p).some((s) => s.enum))!;
    demand = withEnum[0];
    const [name, schema] = Object.entries(withEnum[1]).find(([, s]) => s.enum)! as [string, ParamSchema];
    enumParam = { name, values: schema.enum! };
    supply = [...base.types.keys()].find((t) => t !== demand && Object.keys(base.types.get(t)!).length === 0)!;
    const arr = [...base.types].flatMap(([id, p]) => Object.entries(p).filter(([, s]) => s.type === 'array').map(([param, s]) => ({ id, param, values: s.items!.enum! })))[0]!;
    arrayType = arr;
    chunk = planPairPackets(db, pctx, side(demand), [supply])[0]!;
    ctx = { ...base, packetTypes: new Set([...base.types.keys()]), refs: new Set(chunk!.refs), demand };

    const ruleRef = chunk!.refs.find((r) => !r.startsWith('glossary:') && (db.prepare('SELECT text FROM rules WHERE corpus_id = ? AND number = ?').get(corpusId, r) as { text: string }).text.length > 20)!;
    const text = (db.prepare('SELECT text FROM rules WHERE corpus_id = ? AND number = ?').get(corpusId, ruleRef) as { text: string }).text;
    good = { source: 'rule', ref: ruleRef, quote: text.slice(0, 20) };
    const term = chunk!.refs.find((r) => r.startsWith('glossary:'))!.slice('glossary:'.length);
    const def = (db.prepare('SELECT definition FROM glossary_entries WHERE corpus_id = ? AND term = ?').get(corpusId, term) as { definition: string }).definition;
    goodGlossary = { source: 'glossary', ref: term, quote: def.slice(0, 15) };
    outside = (db.prepare("SELECT number FROM rules WHERE corpus_id = ? AND text <> '' AND number NOT IN (SELECT value FROM json_each(?)) LIMIT 1")
      .get(corpusId, JSON.stringify(chunk!.refs)) as { number: string }).number;
  });

  it('accepts a valid rule, a glossary quote and an enum predicate', () => {
    expect(validateRule(db, ctx, rule())).toBeNull();
    expect(validateRule(db, ctx, rule({ evidence: [goodGlossary] }))).toBeNull();
    expect(validateRule(db, ctx, rule({ demand: side(demand, [{ param: enumParam.name, op: 'eq', value: enumParam.values[0] }]) }))).toBeNull();
    expect(validateRule(db, ctx, rule({ demand: side(demand, [{ param: enumParam.name, op: 'in', value: enumParam.values.slice(0, 2) }]) }))).toBeNull();
  });

  it('check 1: a type outside schema v14, outside the packet, or another demand type is unknown_type', () => {
    expect(validateRule(db, ctx, rule({ demand: { family: 'CARES_ABOUT', type_key: 'NO_SUCH_TYPE', where: [] } }))).toBe('unknown_type');
    expect(validateRule(db, ctx, rule({ supply: { family: 'NO_FAMILY', type_key: 'X', where: [] } }))).toBe('unknown_type');
    expect(validateRule(db, { ...ctx, packetTypes: new Set([demand]) }, rule())).toBe('unknown_type');
    expect(validateRule(db, { ...ctx, demand: supply }, rule())).toBe('unknown_type');
  });

  it('check 2: an unknown param, a wrong operator or a link to no param is unknown_param', () => {
    expect(validateRule(db, ctx, rule({ demand: side(demand, [{ param: 'no_such_param', op: 'eq', value: 1 }]) }))).toBe('unknown_param');
    expect(validateRule(db, ctx, rule({ demand: side(demand, [{ param: enumParam.name, op: 'overlaps', value: [enumParam.values[0]] }]) }))).toBe('unknown_param');
    expect(validateRule(db, ctx, rule({ param_links: [{ supply: 'no_such_param', demand: enumParam.name }] }))).toBe('unknown_param');
    expect(validateRule(db, ctx, rule({ implications: [{ demand_param: 'no_such_param', value: 1, evidence: [good] }] }))).toBe('unknown_param');
    const intrinsic = { intrinsic: 'mana_value' as const, value: ctx.intrinsic.mana_value[0]! };
    expect(validateRule(db, ctx, rule({ supply: intrinsic, param_links: [{ supply: enumParam.name, demand: enumParam.name }] }))).toBe('unknown_param');
  });

  it('check 2: a link needs two params that permit an equal value', () => {
    const same = rule({ supply: side(demand), param_links: [{ supply: enumParam.name, demand: enumParam.name }] });
    expect(validateRule(db, ctx, same)).toBeNull();
    // A param of the schema whose values can never equal a value of the enum param.
    const foreign = [...ctx.types].flatMap(([id, p]) => Object.entries(p).map(([name, s]) => ({ id, name, s })))
      .find((x) => x.id !== demand && !linkCompatible(x.s, { enum: enumParam.values }))!;
    expect(validateRule(db, ctx, rule({ supply: side(foreign.id), param_links: [{ supply: foreign.name, demand: enumParam.name }] }))).toBe('unknown_param');
  });

  it('check 2: an array param links to a scalar param by its items', () => {
    const types = { type: 'array', items: { enum: ['artifact', 'creature'] } } as ParamSchema;
    expect(linkCompatible(types, { enum: ['creature', 'any'] })).toBe(true);
    expect(linkCompatible({ enum: ['creature', 'any'] }, types)).toBe(true);
    expect(linkCompatible(types, { enum: ['land'] })).toBe(false);
    const subtypes = { type: 'array', items: { type: 'string' } } as ParamSchema;
    expect(linkCompatible(subtypes, { type: 'string' })).toBe(true);
    expect(linkCompatible(subtypes, { type: 'boolean' })).toBe(false);
  });

  it('check 2: a value outside the params schema is unknown_enum', () => {
    expect(validateRule(db, ctx, rule({ demand: side(demand, [{ param: enumParam.name, op: 'eq', value: 'not-an-enum-value' }]) }))).toBe('unknown_enum');
    expect(validateRule(db, ctx, rule({ demand: side(demand, [{ param: enumParam.name, op: 'in', value: [] }]) }))).toBe('unknown_enum');
    expect(validateRule(db, ctx, rule({ implications: [{ demand_param: enumParam.name, value: 'not-an-enum-value', evidence: [good] }] }))).toBe('unknown_enum');
    const arr = { ...ctx, demand: arrayType.id };
    const arrRule = (value: unknown) => rule({ demand: side(arrayType.id, [{ param: arrayType.param, op: 'overlaps', value }]) });
    expect(validateRule(db, arr, arrRule([arrayType.values[0]]))).toBeNull();
    expect(validateRule(db, arr, arrRule(['not-an-enum-value']))).toBe('unknown_enum');
    expect(validateRule(db, arr, rule({ demand: side(arrayType.id, [{ param: arrayType.param, op: 'eq', value: [] }]) }))).toBe('unknown_param');
  });

  it('check 3: an item with no evidence is no_evidence, also an implication', () => {
    expect(validateRule(db, ctx, rule({ evidence: [] }))).toBe('no_evidence');
    expect(validateRule(db, ctx, rule({ implications: [{ demand_param: enumParam.name, value: enumParam.values[0], evidence: [] }] }))).toBe('no_evidence');
  });

  it('checks 4 and 5: not verbatim, not in the packet, or an unknown reference', () => {
    expect(validateRule(db, ctx, rule({ evidence: [{ ...good, quote: 'zz a quote that is not in the rule zz' }] }))).toBe('not_verbatim');
    expect(validateRule(db, ctx, rule({ evidence: [{ source: 'rule', ref: outside, quote: 'x' }] }))).toBe('not_in_packet');
    expect(validateRule(db, ctx, rule({ evidence: [{ source: 'rule', ref: '999.99z', quote: 'x' }] }))).toBe('unknown_ref');
    expect(validateRule(db, ctx, rule({ evidence: [{ source: 'glossary', ref: 'No Such Term Zz', quote: 'x' }] }))).toBe('unknown_ref');
  });

  it('checks the implication evidence as it checks the rule evidence', () => {
    const impl = (e: Evidence) => [{ demand_param: enumParam.name, value: enumParam.values[0], evidence: [e] }];
    expect(validateRule(db, ctx, rule({ implications: impl(good) }))).toBeNull();
    expect(validateRule(db, ctx, rule({ implications: impl({ ...good, quote: 'zz not verbatim zz' }) }))).toBe('not_verbatim');
    expect(validateRule(db, ctx, rule({ implications: impl({ source: 'rule', ref: outside, quote: 'x' }) }))).toBe('not_in_packet');
  });

  it('check 6: an intrinsic kind or value outside the permitted sets is bad_intrinsic (D8)', () => {
    const cls = (intrinsic: string, value: string | number) => rule({ supply: { intrinsic, value } as EdgeRuleItem['supply'] });
    expect(validateRule(db, ctx, cls('card_type', String(ctx.intrinsic.card_type[0])))).toBeNull();
    expect(validateRule(db, ctx, cls('card_type', String(ctx.intrinsic.card_type[0]).toLowerCase()))).toBeNull();
    expect(validateRule(db, ctx, cls('card_type', 'Zzq Not A Card Type'))).toBe('bad_intrinsic');
    expect(validateRule(db, ctx, cls('subtype', String(ctx.intrinsic.subtype[0])))).toBeNull();
    expect(validateRule(db, ctx, cls('subtype', 'Zzq Not A Subtype'))).toBe('bad_intrinsic');
    expect(validateRule(db, ctx, cls('mana_value', ctx.intrinsic.mana_value[0]!))).toBeNull();
    expect(validateRule(db, ctx, cls('mana_value', 9999))).toBe('bad_intrinsic');
    expect(validateRule(db, ctx, cls('mana_value', String(ctx.intrinsic.mana_value[0])))).toBe('bad_intrinsic');
    expect(validateRule(db, ctx, cls('color_identity', 'Zz'))).toBe('bad_intrinsic');
    expect(validateRule(db, ctx, cls('power', 1))).toBe('bad_intrinsic');
  });

  describe('roles', () => {
    const roleOf = (over: Partial<RoleItem> = {}): RoleItem => ({
      family: supply.slice(0, supply.indexOf('.')), type_key: supply.slice(supply.indexOf('.') + 1),
      role: 'supply', resources: [], evidence: [good], ...over,
    });

    it('accepts a valid role and a resource of the policy list', () => {
      expect(validateRole(db, ctx, roleOf())).toBeNull();
      expect(validateRole(db, ctx, roleOf({ resources: [{ resource: ctx.resources[0]!, sign: '+', kind: 'value', evidence: [good] }] }))).toBeNull();
    });

    it('check 7: a resource outside the list is rejected; other with a note is accepted', () => {
      expect(validateRole(db, ctx, roleOf({ resources: [{ resource: 'no_such_resource', sign: '+', kind: 'value', evidence: [good] }] }))).toBe('unknown_resource');
      expect(validateRole(db, ctx, roleOf({ resources: [{ resource: 'other', sign: '-', kind: 'cost', note: 'a named resource', evidence: [good] }] }))).toBeNull();
      expect(validateRole(db, ctx, roleOf({ resources: [{ resource: 'other', sign: '-', kind: 'cost', evidence: [good] }] }))).toBe('unknown_resource');
    });

    it('checks the type, the role evidence and the evidence of each effect', () => {
      expect(validateRole(db, ctx, roleOf({ type_key: 'NO_SUCH_TYPE' }))).toBe('unknown_type');
      expect(validateRole(db, { ...ctx, packetTypes: new Set([demand]) }, roleOf())).toBe('unknown_type');
      expect(validateRole(db, ctx, roleOf({ evidence: [] }))).toBe('no_evidence');
      expect(validateRole(db, ctx, roleOf({ resources: [{ resource: ctx.resources[0]!, sign: '+', kind: 'value', evidence: [] }] }))).toBe('no_evidence');
      expect(validateRole(db, ctx, roleOf({ resources: [{ resource: ctx.resources[0]!, sign: '+', kind: 'value', evidence: [{ ...good, quote: 'zz no zz' }] }] }))).toBe('not_verbatim');
    });
  });
});

