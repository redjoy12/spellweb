import { describe, it, expect } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { moveToV18, v18Changes, type V18Atom } from '../src/atoms/migrateV18.js';
import { latestLabels, persistAtomSchema, type AtomTypeDef } from '../src/atoms/schema.js';
import {
  ANTHEM, applyV18, counterNames, COUNTERS, DAMAGE, DESTROY, EXILE, LIFE_LOSS, OPPONENT_LOSS, REMOVAL, SELF_LOSS, STAT_CHANGE, V18_MARK, V18_MOVED, V18_UNGRADED,
} from '../src/atoms/schemaV18.js';
import { INSTRUCTIONS, instructionsFor } from '../src/atoms/extract.js';
import { withDescriptions, type TagCheckItem } from '../src/atoms/tagCheck.js';
import { tagMergeItems } from '../src/atoms/tagMerge.js';
import { demandParamLists } from '../src/graph/buildIndex.js';
import { buildPairs, comparePairs, type BuildPairs } from '../src/graph/pairCompare.js';
import { createRuleSet, setRoles } from '../src/graph/ruleSet.js';
import { quoteTrace } from '../src/graph/score.js';
import { fixtureWithClauses } from './helpers/fixture.js';

// Schema v18 (spec sec. 23): the owner's tag answers of 2026-10-31 that need no model. The rows are
// synthetic: no item states a Magic fact.

const EMPTY = { type: 'object', properties: {}, additionalProperties: false };
const def = (family: AtomTypeDef['family'], type_key: string, properties: object = {}, provenance: AtomTypeDef['provenance'] = 'spec_4_1'): AtomTypeDef =>
  ({ family, type_key, label: type_key, params_schema: { ...EMPTY, properties, required: Object.keys(properties) }, provenance, evidence: 'e' });
const props = (t: AtomTypeDef | undefined) => Object.keys((t!.params_schema as { properties: object }).properties);
const required = (t: AtomTypeDef | undefined) => (t!.params_schema as { required: string[] }).required;
const find = (t: readonly AtomTypeDef[], id: string) => t.find((x) => `${x.family}.${x.type_key}` === id);
const amount = { amount: { type: ['integer', 'string'] } };
const v17 = () => [
  def('INTERACTION', 'TARGETED_REMOVAL', { object_type: { enum: ['creature', 'any'] }, object_controller: { enum: ['you', 'any'] } }),
  def('PRODUCES', 'DESTROY', { object: { enum: ['self', 'other', 'any'] }, targeted: { type: 'boolean' } }),
  def('PRODUCES', 'EXILE', { from_zone: { enum: ['battlefield', 'any'] } }),
  def('COMBAT', 'ANTHEM', { subject_type: { enum: ['creature', 'any'] }, subject_filter: { type: 'string' }, controller: { enum: ['you', 'any'] }, duration: { enum: ['static', 'end_of_turn'] }, sign: { enum: ['+', '-'] } }),
  def('COMBAT', 'STAT_CHANGE', { sign: { enum: ['+', '-'] }, duration: { enum: ['static', 'until_end_of_turn'] } }, 'review_promoted'),
  def('PRODUCES', 'OPPONENT_LIFE_LOSS', amount),
  def('PRODUCES', 'SELF_LIFE_LOSS', amount),
  def('COMBAT', 'POWER'),
  def('COMBAT', 'TOUGHNESS'),
  def('PRODUCES', 'COUNTER_PRODUCTION', { counter_type: { enum: ['+1/+1', '-1/-1', 'other'] }, amount: amount.amount }),
  def('PRODUCES', 'DAMAGE', amount),
];

describe('applyV18', () => {
  it('gives Targeted removal the kind of removal and the Destroy and Exile details (B1)', () => {
    const t = find(applyV18(v17(), { requireAll: true }), REMOVAL);
    expect(props(t)).toEqual(['object_type', 'object_controller', 'removal_type', 'object', 'from_zone']);
    expect(required(t)).toEqual(['object_type', 'object_controller', 'removal_type']);
    expect(t!.evidence).toContain(V18_MARK);
  });
  it('removes Anthem, and STAT_CHANGE keeps the set details (B2)', () => {
    const types = applyV18(v17(), { requireAll: true });
    expect(find(types, ANTHEM)).toBeUndefined();
    const t = find(types, STAT_CHANGE);
    expect(props(t)).toEqual(['sign', 'duration', 'scope', 'subject_type', 'subject_filter', 'controller']);
    expect(required(t)).toEqual(['sign', 'duration', 'scope']);
  });
  it('merges the two life-loss types (B3)', () => {
    const types = applyV18(v17(), { requireAll: true });
    expect(find(types, OPPONENT_LOSS)).toBeUndefined();
    expect(find(types, SELF_LOSS)).toBeUndefined();
    const t = find(types, LIFE_LOSS);
    expect(props(t)).toEqual(['amount', 'player']);
    expect((t!.params_schema as { properties: { player: { enum: string[] } } }).properties.player.enum).toEqual(['you', 'opponent', 'target', 'each']);
    expect(t!.provenance).toBe('review_promoted');
  });
  it('gives the three new labels, and counter_type holds a name (B4, B5)', () => {
    const types = applyV18(v17(), { requireAll: true });
    expect(find(types, 'COMBAT.POWER')!.label).toBe('Checks power');
    expect(find(types, 'COMBAT.TOUGHNESS')!.label).toBe('Checks toughness');
    expect(find(types, COUNTERS)!.label).toBe('Puts counters');
    expect((find(types, COUNTERS)!.params_schema as { properties: { counter_type: { type: string } } }).properties.counter_type.type).toBe('string');
  });
  it('is a no-op the second time, also when the promoted type comes back', () => {
    const once = applyV18(v17(), { requireAll: true });
    expect(applyV18(once)).toEqual(once);
    expect(() => applyV18([def('COMBAT', 'POWER')], { requireAll: true })).toThrow(/not in the vocabulary/);
  });
});

describe('V18_UNGRADED and V18_MOVED', () => {
  it('keeps the new details out of the grade of a v18 set only', () => {
    const db = fixtureWithClauses('Flying');
    persistAtomSchema(db, { schema_version: 17, types: v17() });
    persistAtomSchema(db, { schema_version: 18, types: applyV18(v17(), { requireAll: true }) });
    expect(demandParamLists(db, 18).get(REMOVAL)).toEqual(['object_type', 'object_controller']);
    expect(demandParamLists(db, 18).get(STAT_CHANGE)).toEqual(['sign', 'duration', 'subject_type', 'subject_filter', 'controller']);
    expect(demandParamLists(db, 18).get(LIFE_LOSS)).toEqual(['amount']);
    expect(demandParamLists(db, 17).get(REMOVAL)).toEqual(['object_type', 'object_controller']);
    expect(Object.keys(V18_UNGRADED).sort()).toEqual([STAT_CHANGE, REMOVAL, LIFE_LOSS].sort());
  });
  it('names each type whose atoms move', () => {
    expect(V18_MOVED).toEqual([
      { type: ANTHEM, into: STAT_CHANGE }, { type: OPPONENT_LOSS, into: LIFE_LOSS }, { type: SELF_LOSS, into: LIFE_LOSS },
      { type: DESTROY, into: REMOVAL }, { type: EXILE, into: REMOVAL },
    ]);
  });
});

describe('counterNames (B5)', () => {
  it.each([
    ['Put a landmark counter on this.', 'landmark'],
    ['with two stun counters on it', 'stun'],
    ['put up to three lore counters on it', 'lore'],
    ['Put a double strike counter on it.', 'double strike'],
    ['Put a +1/+1 counter and a trample counter on it.', 'trample'],
    ['Put a flying counter, a deathtouch counter, and a lifelink counter on it.', 'flying, deathtouch, lifelink'],
    ['if it had no counters on it, put two stun counters on it', 'stun'],
    ['For each charge counter on this, draw.', 'charge'],
  ])('reads %s', (quote, name) => expect(counterNames(quote)).toBe(name));
  it.each(['Station', 'if it had counters on it, put its counters on this creature.'])('finds no name in %s', (quote) => expect(counterNames(quote)).toBeNull());
});

const atom = (id: number, type: string, params: Record<string, unknown>, span: [number, number] = [0, 10], quote = 'q'): V18Atom => {
  const [family, type_key] = type.split('.') as [string, string];
  return { id, face_index: 0, family, type_key, span_start: span[0], span_end: span[1], params, quote };
};
const obj = { object_type: 'creature', object_controller: 'any' };

describe('v18Changes', () => {
  it('merges a targeted Destroy atom into the Targeted removal atom of the same object (B1)', () => {
    expect(v18Changes([atom(1, DESTROY, { ...obj, object: 'other', targeted: true }), atom(2, REMOVAL, obj)])).toEqual([
      { kind: 'drop', id: 1, item: 'B1', into: 2 },
      { kind: 'change', id: 2, item: 'B1', type: REMOVAL, params: { ...obj, removal_type: 'destroy', object: 'other' } },
    ]);
  });
  it('merges each atom of a two-object text with its own object (B1)', () => {
    const a = { object_type: 'creature', object_controller: 'any' };
    const b = { object_type: 'planeswalker', object_controller: 'any' };
    const c = v18Changes([atom(1, DESTROY, { ...a, object: 'any', targeted: true }), atom(2, DESTROY, { ...b, object: 'any', targeted: true }), atom(3, REMOVAL, a), atom(4, REMOVAL, b)]);
    expect(c.filter((x) => x.kind === 'drop').map((x) => [x.id, x.kind === 'drop' && x.into])).toEqual([[1, 3], [2, 4]]);
  });
  it('makes a targeted Destroy atom with no Targeted removal atom into one (review 1 F5)', () => {
    expect(v18Changes([atom(1, DESTROY, { ...obj, object: 'any', targeted: true })])).toEqual([
      { kind: 'change', id: 1, item: 'B1', type: REMOVAL, params: { ...obj, object: 'any', removal_type: 'destroy' } },
    ]);
  });
  it('keeps a Destroy text with no target, and an old atom with no Targeted removal atom', () => {
    expect(v18Changes([atom(1, DESTROY, { ...obj, targeted: false }), atom(2, DESTROY, {}, [20, 30])])).toEqual([]);
  });
  it('merges an old atom with no params when the text has both tags', () => {
    expect(v18Changes([atom(1, DESTROY, {}), atom(2, REMOVAL, {})])).toEqual([
      { kind: 'drop', id: 1, item: 'B1', into: 2 },
      { kind: 'change', id: 2, item: 'B1', type: REMOVAL, params: { removal_type: 'destroy' } },
    ]);
  });
  it('merges a targeted Exile atom only when the text has both tags, with its zone (B1)', () => {
    const x = { ...obj, object: 'any', targeted: true, from_zone: 'battlefield' };
    expect(v18Changes([atom(1, EXILE, x), atom(2, REMOVAL, obj)])).toEqual([
      { kind: 'drop', id: 1, item: 'B1', into: 2 },
      { kind: 'change', id: 2, item: 'B1', type: REMOVAL, params: { ...obj, removal_type: 'exile', object: 'any', from_zone: 'battlefield' } },
    ]);
    expect(v18Changes([atom(1, EXILE, x)])).toEqual([]);
  });
  it.each([
    [[atom(1, DAMAGE, {})], 'damage'],
    [[atom(1, STAT_CHANGE, { sign: '-', scope: 'one' })], 'minus'],
    [[atom(1, STAT_CHANGE, { sign: 'mixed', scope: 'one' })], 'minus'],
    [[atom(1, COUNTERS, { counter_type: '-1/-1' })], 'minus'],
    [[atom(1, STAT_CHANGE, { sign: '+', scope: 'one' })], 'other'],
    [[], 'other'],
    [[atom(1, DAMAGE, {}, [20, 30])], 'other'],
  ])('gives a Targeted removal atom the kind of the action on its span (%#)', (others, kind) => {
    const c = v18Changes([...others, atom(9, REMOVAL, obj)]).find((x) => x.id === 9);
    expect(c).toMatchObject({ kind: 'change', params: { removal_type: kind } });
  });
  it('moves Anthem to STAT_CHANGE with scope set, and gives STAT_CHANGE scope one (B2)', () => {
    expect(v18Changes([atom(1, ANTHEM, { sign: '+', duration: 'end_of_turn', controller: 'you' })])).toEqual([
      { kind: 'change', id: 1, item: 'B2', type: STAT_CHANGE, params: { sign: '+', controller: 'you', scope: 'set', duration: 'until_end_of_turn' } },
    ]);
    expect(v18Changes([atom(1, ANTHEM, {})])[0]).toMatchObject({ params: { scope: 'set' } });
    expect(v18Changes([atom(1, STAT_CHANGE, { sign: '+' })])[0]).toMatchObject({ params: { sign: '+', scope: 'one' } });
  });
  it('gives the player from the tags and the quote (B3)', () => {
    const one = (t: string) => v18Changes([atom(1, t, { amount: 2 })]);
    expect(one(OPPONENT_LOSS)).toEqual([{ kind: 'change', id: 1, item: 'B3', type: LIFE_LOSS, params: { amount: 2, player: 'opponent' } }]);
    expect(one(SELF_LOSS)).toEqual([{ kind: 'change', id: 1, item: 'B3', type: LIFE_LOSS, params: { amount: 2, player: 'you' } }]);
    const both = (quote: string) => v18Changes([atom(1, OPPONENT_LOSS, { amount: 2 }, [0, 10], quote), atom(2, SELF_LOSS, { amount: 2 }, [0, 10], quote)]);
    expect(both('Each player loses 2 life.')).toEqual([
      { kind: 'drop', id: 2, item: 'B3', into: 1 },
      { kind: 'change', id: 1, item: 'B3', type: LIFE_LOSS, params: { amount: 2, player: 'each' } },
    ]);
    expect(both('Target player loses 2 life.')[1]).toMatchObject({ params: { player: 'target' } });
  });
  it('keeps two life-loss atoms of one text with different amounts', () => {
    const c = v18Changes([atom(1, OPPONENT_LOSS, { amount: 2 }), atom(2, SELF_LOSS, { amount: 1 })]);
    expect(c.map((x) => [x.id, x.kind === 'change' && x.params['player']])).toEqual([[1, 'opponent'], [2, 'you']]);
  });
  it('gives a counter atom its name, and keeps other when the text has none (B5)', () => {
    expect(v18Changes([atom(1, COUNTERS, { counter_type: 'other', amount: 1 }, [0, 10], 'Put a page counter on it.')])).toEqual([
      { kind: 'change', id: 1, item: 'B5', type: COUNTERS, params: { counter_type: 'page', amount: 1 } },
    ]);
    expect(v18Changes([atom(1, COUNTERS, { counter_type: 'other', amount: 1 }, [0, 10], 'Station')])).toEqual([]);
    expect(v18Changes([atom(1, COUNTERS, { counter_type: '+1/+1', amount: 1 }, [0, 10], 'Put a +1/+1 counter on it.')])).toEqual([]);
  });
  it('gives no change the second time', () => {
    const atoms = [atom(2, REMOVAL, { ...obj, removal_type: 'destroy' }), atom(3, STAT_CHANGE, { sign: '+', scope: 'set' }), atom(4, COUNTERS, { counter_type: 'page' })];
    expect(v18Changes(atoms)).toEqual([]);
  });
});

function insertAtom(db: DatabaseSync, run: number, oracle: string, type: string, params: object, span: [number, number], quote = 'q'): number {
  const [family, type_key] = type.split('.') as [string, string];
  return Number(db.prepare(
    `INSERT INTO atoms (run_id, oracle_id, face_index, schema_version, family, type_key, params_json, span_start, span_end, quote,
       span_ambiguous, rule_numbers, confidence, confidence_source, oracle_hash, pass_index, consensus, is_current)
     VALUES (?, ?, 0, 17, ?, ?, ?, ?, ?, ?, 0, '[]', 1, 'model', 'h', 0, 1, 1)`,
  ).run(run, oracle, family, type_key, JSON.stringify(params), span[0], span[1], quote).lastInsertRowid);
}

function v18Db() {
  const db = fixtureWithClauses('Flying');
  persistAtomSchema(db, { schema_version: 17, types: v17() });
  const c = db.prepare('SELECT id FROM rules_corpus LIMIT 1').get() as { id: number };
  const run = Number(db.prepare(
    `INSERT INTO extraction_runs (started_at, provider, model, schema_version, corpus_id, packet_policy_sha, splitter_version, batch_kind, status)
     VALUES ('t', 'p', 'm', 17, ?, 'sha', 1, 'full', 'complete')`,
  ).run(c.id).lastInsertRowid);
  const oracle = (db.prepare('SELECT oracle_id FROM cards LIMIT 1').get() as { oracle_id: string }).oracle_id;
  return { db, run, oracle };
}

describe('moveToV18', () => {
  it('refuses a database with no v18 types', () => {
    expect(() => moveToV18(v18Db().db)).toThrow(/not in atom_types/);
  });
  it('gives changed atoms new rows on a new run, keeps the old rows, and leaves other atoms', () => {
    const { db, run, oracle } = v18Db();
    persistAtomSchema(db, { schema_version: 18, types: applyV18(v17(), { requireAll: true }) });
    const d = insertAtom(db, run, oracle, DESTROY, { ...obj, object: 'any', targeted: true }, [0, 10]);
    const r = insertAtom(db, run, oracle, REMOVAL, obj, [0, 10]);
    const o = insertAtom(db, run, oracle, 'COMBAT.POWER', {}, [20, 30]);
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

    const dry = moveToV18(db, { dryRun: true });
    expect(dry).toMatchObject({ runId: null, cards: 1, atoms: { dropped: { 'B1 PRODUCES.DESTROY merged': 1 }, changed: { 'B1 INTERACTION.TARGETED_REMOVAL': 1 }, unchanged: 1 } });
    expect(n('SELECT COUNT(*) n FROM atoms WHERE is_current = 1')).toBe(3);

    const res = moveToV18(db);
    expect(res.runId).not.toBeNull();
    const current = db.prepare('SELECT id, family, type_key, schema_version, run_id, params_json FROM atoms WHERE is_current = 1 ORDER BY id').all() as
      Array<{ id: number; type_key: string; schema_version: number; run_id: number; params_json: string }>;
    expect(current.map((a) => [a.type_key, a.schema_version])).toEqual([['POWER', 17], ['TARGETED_REMOVAL', 18]]);
    expect(current[0]!.id).toBe(o);
    expect(JSON.parse(current[1]!.params_json)).toEqual({ ...obj, removal_type: 'destroy', object: 'any' });
    expect(current[1]!.run_id).toBe(res.runId);
    // The old rows stay for the old builds.
    expect((db.prepare('SELECT is_current FROM atoms WHERE id = ?').get(d) as { is_current: number }).is_current).toBe(0);
    expect((db.prepare('SELECT is_current FROM atoms WHERE id = ?').get(r) as { is_current: number }).is_current).toBe(0);
    expect(moveToV18(db).cards).toBe(0);
  });
});

describe('comparePairs', () => {
  const pairs = (plus: Array<[string, 'confirmed' | 'plausible', number]>, minus: Array<[string, 'confirmed' | 'plausible']> = []): BuildPairs => ({
    plus: new Map(plus.map(([k, grade, weight]) => [k, { grade, weight }])), minus: new Map(minus), classes: new Map(),
  });
  it('is the same with the same pairs, and counts a new weight apart', () => {
    const r = comparePairs(pairs([['a|b', 'confirmed', 0.5]]), pairs([['a|b', 'confirmed', 0.25]]));
    expect(r.same).toBe(true);
    expect(r.weights).toEqual({ changed: 1, largest: 0.25 });
  });
  it('finds an added pair, a lost pair, a grade and a reversed direction', () => {
    const before = pairs([['a|b', 'confirmed', 0.5], ['c|d', 'plausible', 0.5]]);
    expect(comparePairs(before, pairs([['a|b', 'plausible', 0.5], ['d|c', 'plausible', 0.5]]))).toMatchObject({
      same: false, plus: { added: ['d|c'], lost: ['c|d'], grade: ['a|b'] },
    });
    expect(comparePairs(pairs([], [['a|b', 'confirmed']]), pairs([])).same).toBe(false);
  });
  it('reads an index with no cards', () => {
    expect(buildPairs({ cards: () => [] } as unknown as Parameters<typeof buildPairs>[0]).plus.size).toBe(0);
  });
});

describe('instructionsFor v18', () => {
  const s = instructionsFor(18);
  it('replaces the lines of the removed types', () => {
    expect(s).toContain('PRODUCES LIFE_LOSS');
    expect(s).not.toMatch(/ANTHEM|OPPONENT_LIFE_LOSS|SELF_LIFE_LOSS/);
    expect(s).toContain('scope set: a set of creatures');
  });
  it('states the merged removal texts', () => {
    expect(s).toContain('A Destroy text with a target gets this type, with removal_type destroy');
    expect(s).toContain('An Exile text that gets INTERACTION TARGETED_REMOVAL has removal_type exile');
  });
  it('keeps the old text on an earlier version', () => {
    expect(instructionsFor(17)).toContain('COMBAT ANTHEM stays for a set of creatures');
    expect(INSTRUCTIONS).toContain('PRODUCES OPPONENT_LIFE_LOSS');
  });
});

describe('the labels of the Decisions page (B4, B5)', () => {
  const db = fixtureWithClauses('Flying');
  persistAtomSchema(db, { schema_version: 17, types: v17() });
  persistAtomSchema(db, { schema_version: 18, types: applyV18(v17(), { requireAll: true }) });
  it('latestLabels gives a later version first, and keeps a removed type', () => {
    const l = latestLabels(db);
    expect(l.get('COMBAT.POWER')).toBe('Checks power');
    expect(l.get(ANTHEM)).toBe('ANTHEM');
  });
  it('a sample tag shows the current label', () => {
    const item = { tags: [{ type: 'COMBAT.POWER', label: 'old', params: {}, quote: 'q' }, { type: 'X.NOT_A_TYPE', label: 'kept', params: {}, quote: 'q' }],
      other_tags: [{ type: COUNTERS, label: 'old', params: {}, quote: 'q' }] } as unknown as TagCheckItem;
    const [out] = withDescriptions(db, [item]);
    expect(out!.tags.map((t) => t.label)).toEqual(['Checks power', 'kept']);
    expect(out!.other_tags![0]!.label).toBe('Puts counters');
  });
  it('a sample tag of a removed type shows the type that keeps its fact', () => {
    const item = { tags: [{ type: OPPONENT_LOSS, label: 'old', params: {}, quote: 'q' }, { type: SELF_LOSS, label: 'old', params: {}, quote: 'q' }, { type: ANTHEM, label: 'old', params: {}, quote: 'q' }] } as unknown as TagCheckItem;
    const [out] = withDescriptions(db, [item]);
    expect(out!.tags.map((t) => t.label)).toEqual(['Player loses life', 'Player loses life', 'Power/toughness change (one creature or a set of creatures)']);
    expect(out!.tags[0]!.type).toBe(OPPONENT_LOSS);
  });
  it('a stored merge item shows the current labels, and keeps its counts', () => {
    const items = tagMergeItems(db, 1, null);
    const i = items.find((x) => x.a.type === 'COMBAT.TOUGHNESS' || x.b.type === 'COMBAT.TOUGHNESS');
    if (!i) return; // The snapshot files are not in this checkout.
    expect([i.a.label, i.b.label].sort()).toEqual(['Checks power', 'Checks toughness']);
    expect(i.a.atoms).toBeGreaterThan(0);
  });
});

describe('quoteTrace (review 2 R2-6, spec sec. 12.2)', () => {
  const OLD = 'ENABLES.OLD_DEMAND';
  const NEW = 'ENABLES.NEW_DEMAND';
  const DUE = 'CARES_ABOUT.NEW_EVENT';
  const split = (id: string) => ({ family: id.slice(0, id.indexOf('.')), type_key: id.slice(id.indexOf('.') + 1) });
  function setup() {
    const db = fixtureWithClauses('Flying');
    const { number, text } = db.prepare('SELECT number, text FROM rules WHERE length(text) > 10 LIMIT 1').get() as { number: string; text: string };
    const evidence = JSON.stringify([{ source: 'rule', ref: number, quote: text.slice(0, 10) }]);
    const { setId: from } = createRuleSet(db, 'm');
    db.prepare("UPDATE edge_rule_sets SET status = 'accepted' WHERE id = ?").run(from);
    const { setId: to } = createRuleSet(db, 'm');
    const batch = db.prepare(`INSERT INTO edge_rule_batches (set_id, stage, batch_key, demand, types_json, refs_json, packet_sha, packet_bytes, prepared_at)
                              VALUES (?, ?, ?, ?, ?, ?, 'sha', 100, 't')`);
    const rule = db.prepare(`INSERT INTO edge_rules (set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status)
                             VALUES (?, ?, 'ER-0001', '+', '{"family":"PRODUCES","type_key":"X","where":[]}', ?, '[]', '[]', ?, 2, 'accepted')`);
    batch.run(from, 'pairs', `${OLD}-0`, OLD, JSON.stringify([OLD]), JSON.stringify([number]));
    rule.run(from, 'h1', JSON.stringify({ ...split(OLD), where: [] }), evidence);
    db.prepare('INSERT INTO edge_rule_carry (set_id, from_set_id, demand, rules) VALUES (?, ?, ?, 0)').run(to, from, OLD);
    return { db, to, from, evidence, rule, batch, number };
  }
  it('passes a moved rule through the batches of the demand type of its source set', () => {
    const { db, to, evidence, rule } = setup();
    rule.run(to, 'h2', JSON.stringify({ ...split(NEW), where: [] }), evidence);
    expect(quoteTrace(db, to).rules).toEqual({ ok: 1, total: 1 });
  });
  it('fails a rule with the same quote and no batch that showed it', () => {
    const { db, to, evidence } = setup();
    db.prepare(`INSERT INTO edge_rules (set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status)
                VALUES (?, 'h3', 'ER-0002', '+', '{"family":"PRODUCES","type_key":"X","where":[]}', ?, '[]', '[]', ?, 2, 'accepted')`).run(to, JSON.stringify({ ...split(NEW), where: [] }), evidence);
    expect(quoteTrace(db, to).rules).toEqual({ ok: 0, total: 1 });
  });
  it('passes a role with 0 votes through the Stage B batches of its type', () => {
    const { db, to, evidence, batch, number } = setup();
    const role = db.prepare(`INSERT INTO edge_type_roles (set_id, family, type_key, role, demand_note, resources_json, evidence_json, votes, status)
                             VALUES (?, 'CARES_ABOUT', 'NEW_EVENT', 'demand', 'n', '[]', ?, ?, 'accepted')`);
    role.run(to, evidence, 0);
    expect(quoteTrace(db, to).roles).toEqual({ ok: 0, total: 1 });
    batch.run(to, 'pairs', `${DUE}-0`, DUE, JSON.stringify([DUE]), JSON.stringify([number]));
    expect(quoteTrace(db, to).roles).toEqual({ ok: 1, total: 1 });
    // A voted role must have a Stage A batch.
    db.prepare('UPDATE edge_type_roles SET votes = 3 WHERE set_id = ?').run(to);
    expect(quoteTrace(db, to).roles).toEqual({ ok: 0, total: 1 });
  });
  it('passes the role of a merged type through the Stage A batches of a removed type', () => {
    const { db, to, from, evidence, batch, number } = setup();
    batch.run(from, 'roles', 'roles-0', null, JSON.stringify([OPPONENT_LOSS]), JSON.stringify([number]));
    db.prepare(`INSERT INTO edge_type_roles (set_id, family, type_key, role, demand_note, resources_json, evidence_json, votes, status)
                VALUES (?, 'PRODUCES', 'LIFE_LOSS', 'supply', NULL, '[]', ?, 3, 'accepted')`).run(to, evidence);
    expect(setRoles(db, to).map((r) => r.type_key)).toEqual(['LIFE_LOSS']);
    expect(quoteTrace(db, to).roles).toEqual({ ok: 1, total: 1 });
  });
});
