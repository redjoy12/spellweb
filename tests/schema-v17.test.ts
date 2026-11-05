import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyV17, DESCENDED, DESCENDED_ROLE, V17_MARK, V17_REMOVED } from '../src/atoms/schemaV17.js';
import { GOLDEN_V17_ADD, GOLDEN_V17_SET } from '../src/atoms/goldenV17.js';
import { demandParamLists } from '../src/graph/buildIndex.js';
import { GRADE_VERSION, matchRule } from '../src/graph/match.js';
import type { EdgeRuleContent, Predicate, TypeSide } from '../src/graph/ruleSchema.js';
import { demandTypes, setRoles, setRules } from '../src/graph/ruleSet.js';
import { persistAtomSchema, validateAtomParams } from '../src/atoms/schema.js';
import type { AtomTypeDef } from '../src/atoms/schema.js';
import { INSTRUCTIONS, instructionsFor, validateResponse } from '../src/atoms/extract.js';
import { fixtureWithClauses } from './helpers/fixture.js';
import { maybe, realCorpusId, realDb } from './helpers/realDb.js';

// Schema v17 (spec sec. 22): the owner's tag and reading answers of 2026-10-31.

const props = (t: AtomTypeDef | undefined) => Object.keys((t!.params_schema as { properties: object }).properties);
const EMPTY = { type: 'object', properties: {}, additionalProperties: false };
const def = (family: AtomTypeDef['family'], type_key: string, properties: object = {}): AtomTypeDef =>
  ({ family, type_key, label: type_key, params_schema: { ...EMPTY, properties, required: Object.keys(properties) }, provenance: 'spec_4_1', evidence: 'e' });
const v16 = () => [
  def('PRODUCES', 'SACRIFICE', { object: { enum: ['self', 'other', 'any'] }, object_type: { enum: ['creature', 'any'] }, actor: { enum: ['you', 'opponent', 'any'] } }),
  def('ENABLES', 'SACRIFICE_OUTLET', { cost_type: { enum: ['free', 'costed'] } }),
  def('PRODUCES', 'SACRIFICE_FODDER'),
  def('CARES_ABOUT', 'PERMANENT_DIES', { permanent_type: { enum: ['creature', 'any'] } }),
  def('ENABLES', 'ATTACH'),
];
const find = (t: AtomTypeDef[], id: string) => t.find((x) => `${x.family}.${x.type_key}` === id);

describe('applyV17', () => {
  it('adds the cost and the decision to Sacrifice, and removes the outlet type (S1-S3)', () => {
    const t = applyV17(v16(), { requireAll: true });
    expect(find(t, 'ENABLES.SACRIFICE_OUTLET')).toBeUndefined();
    const sac = find(t, 'PRODUCES.SACRIFICE');
    expect(props(sac)).toEqual(['object', 'object_type', 'actor', 'cost_type', 'decision']);
    expect((sac!.params_schema as { required: string[] }).required).toContain('decision');
    expect(sac!.evidence).toContain(V17_MARK);
  });
  it('adds cause, token_type and the descended demand (R1, R3, R4)', () => {
    const t = applyV17(v16());
    expect(props(find(t, 'CARES_ABOUT.PERMANENT_DIES'))).toEqual(['permanent_type', 'cause']);
    expect(props(find(t, 'PRODUCES.SACRIFICE_FODDER'))).toEqual(['token_type']);
    const d = find(t, DESCENDED)!;
    expect(d.params_schema).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false });
    expect(d.evidence).toContain('CR 700.11');
  });
  it('is a no-op the second time, and throws when a named type is missing', () => {
    const once = applyV17(v16());
    expect(applyV17(once)).toEqual(once);
    expect(() => applyV17([def('ENABLES', 'ATTACH')], { requireAll: true })).toThrow(/not in the vocabulary/);
  });
  it('the committed config is at v17 or later and has the v17 changes', () => {
    const schema = JSON.parse(readFileSync('config/atom-schema.json', 'utf8')) as { schema_version: number; types: AtomTypeDef[] };
    expect(schema.schema_version).toBeGreaterThanOrEqual(17);
    expect(find(schema.types, 'ENABLES.SACRIFICE_OUTLET')).toBeUndefined();
    expect(find(schema.types, DESCENDED)).toBeDefined();
    expect(props(find(schema.types, 'PRODUCES.SACRIFICE'))).toEqual(['object', 'object_type', 'actor', 'cost_type', 'decision']);
  });
});

describe('the params check at v17', () => {
  const quote = 'Sacrifice a creature: Draw a card.';
  const atom = (params: object) => ({ face_index: 0, family: 'PRODUCES', type_key: 'SACRIFICE', params, quote, rule_numbers: ['700'], confidence: 0.9 });
  const params = { object: 'any', object_type: 'creature', actor: 'you' };
  const setUp = () => {
    const db = fixtureWithClauses(quote);
    persistAtomSchema(db, { schema_version: 17, types: applyV17(v16()) });
    db.exec('UPDATE extraction_runs SET schema_version = 17 WHERE id = 1');
    return db;
  };
  it('accepts a Sacrifice atom with both details, and rejects it without them', () => {
    const r = validateResponse(setUp(), 'o', { runId: 1, passIndex: 0, packetRules: ['700'] }, {
      atoms: [atom({ ...params, cost_type: 'free', decision: 'cost' }), atom(params), atom({ ...params, cost_type: 'free', decision: 'maybe' })],
    });
    expect(r.atoms).toHaveLength(1);
    expect(r.rejected.map((x) => x.reason).join(' ')).toMatch(/cost_type/);
    expect(r.rejected.map((x) => x.reason).join(' ')).toMatch(/decision/);
  });
  it('does not know the outlet type', () => {
    expect(validateAtomParams(setUp(), 17, 'ENABLES', 'SACRIFICE_OUTLET', { cost_type: 'free' }).ok).toBe(false);
  });
});

describe('the sec. 7.2 grade at v17 (spec sec. 22.5)', () => {
  const SAC = 'PRODUCES.SACRIFICE';
  const atom = (id: number, family: string, type_key: string, params: Record<string, unknown>) =>
    ({ id, oracle_id: 'o', face_index: 0, family, type_key, params, span_start: 0, span_end: 5 });
  const rule = (where: Predicate[] = [{ param: 'actor', op: 'eq', value: 'you' }]): EdgeRuleContent => ({
    polarity: '+', supply: { family: 'PRODUCES', type_key: 'CREATE', where: [] }, demand: { family: 'PRODUCES', type_key: 'SACRIFICE', where }, param_links: [], implications: [],
  });
  const supply = atom(1, 'PRODUCES', 'CREATE', {});
  const demand = (decision: string) => atom(2, 'PRODUCES', 'SACRIFICE', { object: 'any', object_type: 'any', actor: 'you', cost_type: 'costed', decision });
  const lists = () => {
    const db = fixtureWithClauses('Sacrifice a creature: Draw a card.');
    persistAtomSchema(db, { schema_version: 17, types: applyV17(v16()) });
    return demandParamLists(db, 17);
  };
  it('leaves cost_type, decision and cause out of the param lists', () => {
    const l = lists();
    expect(l.get(SAC)).toEqual(['object', 'object_type', 'actor']);
    expect(l.get('CARES_ABOUT.PERMANENT_DIES')).toEqual(['permanent_type']);
    expect(l.get('PRODUCES.SACRIFICE_FODDER')).toEqual(['token_type']);
  });
  it('keeps them in a list of an earlier schema version', () => {
    const db = fixtureWithClauses('x');
    persistAtomSchema(db, { schema_version: 16, types: applyV17(v16()) });
    expect(demandParamLists(db, 16).get(SAC)).toEqual(['object', 'object_type', 'actor', 'cost_type', 'decision']);
  });
  it('an edge into a Sacrifice atom with decision forced is confirmed on a v17 set', () => {
    const graded = ['object', 'object_type', 'actor', 'cost_type', 'decision'];
    expect(matchRule(rule(), supply, demand('forced'), graded, GRADE_VERSION)?.grade).toBe('plausible');
    expect(matchRule(rule(), supply, demand('forced'), lists().get(SAC)!, GRADE_VERSION)).toMatchObject({ grade: 'confirmed', unresolved: [] });
  });
  it('a where predicate still tests these params', () => {
    const only = rule([{ param: 'actor', op: 'eq', value: 'you' }, { param: 'decision', op: 'eq', value: 'cost' }]);
    expect(matchRule(only, supply, demand('forced'), lists().get(SAC)!, GRADE_VERSION)).toBeNull();
    expect(matchRule(only, supply, demand('cost'), lists().get(SAC)!, GRADE_VERSION)?.grade).toBe('confirmed');
  });
});

describe('the S3 move', () => {
  it('names the limit of the plan', () => {
    expect(V17_REMOVED).toHaveLength(1);
    expect(V17_REMOVED[0]).toMatchObject({
      type: 'ENABLES.SACRIFICE_OUTLET', into: 'PRODUCES.SACRIFICE',
      where: [{ param: 'actor', op: 'eq', value: 'you' }, { param: 'object', op: 'in', value: ['other', 'any'] }],
    });
  });
});

describe('instructionsFor at v17', () => {
  it('keeps the v16 text at v16, and adds the items from v17', () => {
    expect(instructionsFor(16)).not.toContain('SACRIFICE_FODDER');
    const v = instructionsFor(17);
    expect(v).toContain('gets only CYCLING');
    expect(v).toContain('with cause "sacrifice" and controller "you"');
    expect(v).toContain('gets ENABLES ATTACH beside PRODUCES CREATE');
    expect(v).toContain('token_type "Food"');
    expect(v).toContain('It is not CARES_ABOUT POPULATED_GRAVEYARD.');
    expect(v).not.toContain('gets PRODUCES CREATE only,');
    expect(INSTRUCTIONS).toContain('gets PRODUCES CREATE only,');
  });
});

describe('the golden table', () => {
  it('names each atom once, and each moved atom ends on Sacrifice', () => {
    const ids = GOLDEN_V17_SET.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GOLDEN_V17_SET.filter((s) => s.to).map((s) => s.to)).toEqual(['PRODUCES.SACRIFICE', 'PRODUCES.SACRIFICE', 'PRODUCES.SACRIFICE']);
    expect(GOLDEN_V17_ADD.map((a) => a.params)).toEqual([{ token_type: 'Food' }, { token_type: 'Food' }]);
  });
  it('gives a decision and a cost on every atom that ends on Sacrifice', () => {
    for (const s of GOLDEN_V17_SET.filter((x) => (x.to ?? x.from) === 'PRODUCES.SACRIFICE')) {
      expect(s.params['decision'], String(s.id)).toMatch(/^(cost|choice|forced)$/);
      if (!s.to) expect(s.params['cost_type'], String(s.id)).toMatch(/^(free|costed)$/);
    }
  });
});

maybe('schema v17 against the stored data', () => {
  it('CR 700.11 has the words of the descended type', () => {
    const r = realDb.prepare('SELECT text FROM rules WHERE corpus_id = ? AND number = ?').get(realCorpusId, '700.11') as { text: string };
    expect(r.text).toContain('a permanent card has been put into that player\'s graveyard from anywhere this turn');
  });
  it('on the v17 rule set, all 60 outlet rules keep their id, votes and status, and have the S3 limit', () => {
    const v17 = realDb.prepare('SELECT id FROM edge_rule_sets WHERE schema_version = 17 ORDER BY id DESC').get() as { id: number } | undefined;
    if (!v17) return;
    const outlet = (s: { type_key?: string }) => s.type_key === 'SACRIFICE_OUTLET';
    const old = setRules(realDb, 4, 'all').filter((r) => outlet(r.demand) || outlet(r.supply as { type_key?: string }));
    expect(old).toHaveLength(60);
    const rules = new Map(setRules(realDb, v17.id, 'all').map((r) => [r.rule_id, r]));
    for (const o of old) {
      const n = rules.get(o.rule_id)!;
      expect(n, o.rule_id).toBeDefined();
      expect([n.votes, n.status, n.polarity], o.rule_id).toEqual([o.votes, o.status, o.polarity]);
      const side = (outlet(o.demand) ? n.demand : n.supply) as TypeSide;
      expect(side).toMatchObject({ family: 'PRODUCES', type_key: 'SACRIFICE' });
      expect(side.where, o.rule_id).toEqual(V17_REMOVED[0]!.where);
    }
    expect(setRules(realDb, v17.id, 'all').filter((r) => outlet(r.demand) || outlet(r.supply as { type_key?: string }))).toEqual([]);
  });
  it('on the v17 rule set, the descended type has the accepted role demand', () => {
    const v17 = realDb.prepare('SELECT id FROM edge_rule_sets WHERE schema_version = 17 ORDER BY id DESC').get() as { id: number } | undefined;
    if (!v17) return;
    expect(demandTypes(realDb, v17.id)).toContain(DESCENDED);
    expect(setRoles(realDb, v17.id).find((r) => `${r.family}.${r.type_key}` === DESCENDED)).toMatchObject({ role: 'demand', status: 'accepted', votes: 0, evidence: DESCENDED_ROLE.evidence });
  });
  it('the role evidence of the descended type is stored CR text', () => {
    for (const e of DESCENDED_ROLE.evidence) {
      const r = realDb.prepare('SELECT text FROM rules WHERE corpus_id = ? AND number = ?').get(realCorpusId, e.ref) as { text: string };
      expect(r.text).toContain(e.quote);
    }
  });
});
