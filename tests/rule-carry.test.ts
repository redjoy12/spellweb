import { describe, it, expect } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { persistAtomSchema } from '../src/atoms/schema.js';
import { setStatus } from '../src/graph/ruleBatches.js';
import { carriedDemands, carryForwardSet, carrySource, changedDemandTypes, dropFromOpenSet, repairCarry, shownCandidates, sourceBatches } from '../src/graph/ruleCarry.js';
import { createRuleSet, demandTypes, giveDemandRole, mergeRole, setRoles, setRules, supplyTypes } from '../src/graph/ruleSet.js';
import { ruleHash } from '../src/graph/ruleSchema.js';
import { fixtureWithClauses } from './helpers/fixture.js';

// Schema v15 plan, Task 5 Step 1. The rows are synthetic: no item states a Magic fact.

const DEATH = 'CARES_ABOUT.CREATURE_DEATH';
const ACT = 'ENABLES.ACTIVATE';
const DRAW = 'PRODUCES.CARD_DRAW';
const TOKENS = 'PRODUCES.TOKENS';
const split = (id: string) => ({ family: id.slice(0, id.indexOf('.')), type_key: id.slice(id.indexOf('.') + 1) });
const EMPTY = { type: 'object', properties: {}, additionalProperties: false };

/** The fixture types at a new schema version; `changed` types get one more param. */
function schema(db: DatabaseSync, version: number, changed: string[]): void {
  const rows = db.prepare('SELECT family, type_key, label, params_schema, provenance, evidence FROM atom_types WHERE schema_version = 1').all() as
    Array<{ family: string; type_key: string; label: string; params_schema: string; provenance: string; evidence: string }>;
  persistAtomSchema(db, {
    schema_version: version,
    types: rows.map((r) => ({
      family: r.family as 'PRODUCES', type_key: r.type_key, label: r.label, provenance: r.provenance as 'spec_4_1', evidence: r.evidence,
      params_schema: changed.includes(`${r.family}.${r.type_key}`)
        ? { type: 'object', properties: { cost_tap: { enum: ['yes', 'no'] } }, required: ['cost_tap'], additionalProperties: false }
        : JSON.parse(r.params_schema) as typeof EMPTY,
    })),
  });
}

function batch(db: DatabaseSync, setId: number, stage: 'roles' | 'pairs', key: string, types: string[], demand: string | null, refs = ['118']): void {
  db.prepare(`INSERT INTO edge_rule_batches (set_id, stage, batch_key, demand, types_json, refs_json, packet_sha, packet_bytes, prepared_at)
              VALUES (?, ?, ?, ?, ?, ?, 'sha', 100, 't')`).run(setId, stage, key, demand, JSON.stringify(types), JSON.stringify(refs));
}

function rule(db: DatabaseSync, setId: number, hash: string, id: string, supply: string, demand: string, status: 'accepted' | 'disputed'): number {
  return Number(db.prepare(
    `INSERT INTO edge_rules (set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status)
     VALUES (?, ?, ?, '+', ?, ?, '[]', '[]', '[]', 2, ?)`,
  ).run(setId, hash, id, JSON.stringify({ ...split(supply), where: [] }), JSON.stringify({ ...split(demand), where: [] }), status).lastInsertRowid);
}

/** An accepted set 1 on schema v1: two demand types with batches and rules, and debate records. */
function source(): { db: DatabaseSync; from: number } {
  const db = fixtureWithClauses('Flying');
  const { setId: from } = createRuleSet(db, 'm1');
  const role = db.prepare(`INSERT INTO edge_type_roles (set_id, family, type_key, role, demand_note, resources_json, evidence_json, votes, status)
                           VALUES (?, ?, ?, ?, NULL, '[]', '[]', 3, 'accepted')`);
  for (const [t, r] of [[DEATH, 'demand'], [ACT, 'both'], [DRAW, 'supply'], [TOKENS, 'supply']] as const) role.run(from, split(t).family, split(t).type_key, r);
  db.prepare(`INSERT INTO edge_role_decisions (set_id, family, type_key, decision, pass_index, note, decided_at, decided_by, debate_round)
              VALUES (?, 'ENABLES', 'ACTIVATE', 'keep', NULL, 'agreed', 't', 'debate', 1)`).run(from);
  batch(db, from, 'roles', 'roles-0', [DEATH, ACT, DRAW, TOKENS], null, ['700']);
  batch(db, from, 'pairs', `${DEATH}-0`, [DEATH, DRAW], DEATH);
  batch(db, from, 'pairs', `${ACT}-0`, [ACT, DRAW, TOKENS], ACT);
  rule(db, from, 'h-death', 'ER-0001', DRAW, DEATH, 'accepted');
  const disputed = rule(db, from, 'h-death-2', 'ER-0002', DRAW, DEATH, 'disputed');
  rule(db, from, 'h-act', 'ER-0003', TOKENS, ACT, 'accepted');
  rule(db, from, 'h-act-2', 'ER-0004', DRAW, ACT, 'disputed');
  const decide = db.prepare(`INSERT INTO edge_rule_decisions (set_id, rule_hash, decision, decided_by, debate_round, note, decided_at)
                             VALUES (?, ?, 'reject', 'debate', 1, 'agreed', 't')`);
  decide.run(from, 'h-death-2');
  decide.run(from, 'h-act-2');
  const outcome = db.prepare(`INSERT INTO edge_debate_outcomes (set_id, stage, item_key, outcome, choice, round, cause, decided_at)
                              VALUES (?, ?, ?, 'agreed', ?, 1, NULL, 't')`);
  outcome.run(from, 'pairs', 'h-death-2', 'reject');
  outcome.run(from, 'pairs', 'h-act-2', 'reject');
  outcome.run(from, 'roles', ACT, 'voted');
  db.prepare(`INSERT INTO review_queue (domain, rule_set_id, severity, severity_rank, rank_score, detail_table, detail_id, enqueued_at)
              VALUES ('edge', ?, 'edge_rule_disagreement', 2, 0, 'edge_rules', ?, 't')`).run(from, disputed);
  db.prepare("UPDATE edge_rule_sets SET status = 'accepted' WHERE id = ?").run(from);
  return { db, from };
}

const n = (db: DatabaseSync, sql: string, ...p: Array<string | number>) => (db.prepare(sql).get(...p) as { n: number }).n;

describe('changedDemandTypes', () => {
  it('lists the demand types whose params change, and ignores a changed supply type', () => {
    const { db, from } = source();
    schema(db, 2, [ACT, DRAW]);
    expect(changedDemandTypes(db, from, 2)).toEqual([ACT]);
  });

  it('lists a demand type that the new schema does not have', () => {
    const { db, from } = source();
    schema(db, 2, []);
    db.prepare("DELETE FROM atom_types WHERE schema_version = 2 AND type_key = 'CREATURE_DEATH'").run();
    expect(changedDemandTypes(db, from, 2)).toEqual([DEATH]);
  });
});

describe('carryForwardSet', () => {
  it('copies the roles and the rules of the unchanged demand types, with their ids and debate records', () => {
    const { db, from } = source();
    schema(db, 2, [ACT]);
    const r = carryForwardSet(db, from, 'm2');
    expect(r).toMatchObject({ fromSetId: from, schemaVersion: 2, changed: [ACT], carried: [{ demand: DEATH, rules: 2 }], roles: 4, rules: 2 });
    const set = db.prepare('SELECT * FROM edge_rule_sets WHERE id = ?').get(r.setId) as { status: string; schema_version: number; model: string };
    expect(set).toMatchObject({ status: 'in_progress', schema_version: 2, model: 'm2' });
    expect(setRoles(db, r.setId).map((x) => [`${x.family}.${x.type_key}`, x.role, x.decision?.decision ?? null])).toEqual([
      [DEATH, 'demand', null], [ACT, 'both', 'keep'], [DRAW, 'supply', null], [TOKENS, 'supply', null],
    ]);
    expect(setRules(db, r.setId, 'all').map((x) => [x.rule_id, x.rule_hash, x.status])).toEqual([
      ['ER-0001', 'h-death', 'accepted'], ['ER-0002', 'h-death-2', 'disputed'],
    ]);
    expect(n(db, 'SELECT COUNT(*) n FROM edge_rule_decisions WHERE set_id = ?', r.setId)).toBe(1);
    expect(db.prepare('SELECT stage, item_key FROM edge_debate_outcomes WHERE set_id = ? ORDER BY stage').all(r.setId).map((o) => ({ ...o })))
      .toEqual([{ stage: 'pairs', item_key: 'h-death-2' }, { stage: 'roles', item_key: ACT }]);
    // The review items stay on the source set: the edge queue lists every set.
    expect(n(db, 'SELECT COUNT(*) n FROM review_queue WHERE rule_set_id = ?', r.setId)).toBe(0);
    expect(n(db, 'SELECT COUNT(*) n FROM edge_rule_batches WHERE set_id = ?', r.setId)).toBe(0);
    expect(carrySource(db, r.setId)).toBe(from);
    expect(setStatus(db, r.setId).carried).toEqual({ from_set_id: from, demands: 1, rules: 2 });
    expect(setStatus(db, from).carried).toBeNull();
  });

  it('does not carry an unchanged demand type that had no batch (a deferred type)', () => {
    const { db, from } = source();
    db.prepare("DELETE FROM edge_rule_batches WHERE set_id = ? AND demand = ?").run(from, DEATH);
    schema(db, 2, [ACT]);
    expect(carryForwardSet(db, from, 'm2').carried).toEqual([]);
  });

  it('with all, carries every demand type and moves the rules of a removed type (spec sec. 21)', () => {
    const { db, from } = source();
    schema(db, 2, [ACT]);
    db.prepare("DELETE FROM atom_types WHERE schema_version = 2 AND type_key = 'TOKENS'").run();
    db.prepare(`UPDATE atom_types SET params_schema = '{"type":"object","properties":{"count":{"type":"integer"}}}' WHERE schema_version = 2 AND type_key = 'CARD_DRAW'`).run();
    // A disputed rule with the content that the accepted TOKENS -> ACT rule gets: the moved rule merges
    // into it, and the kept rule is accepted.
    const same = ruleHash({ polarity: '+', supply: { ...split(DRAW), where: [] }, demand: { ...split(ACT), where: [] }, param_links: [], implications: [] });
    rule(db, from, same, 'ER-0005', DRAW, ACT, 'disputed');
    db.prepare(`INSERT INTO edge_rules (set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status)
                VALUES (?, 'h-tok', 'ER-0006', '-', ?, ?, '[]', '[]', '[]', 2, 'accepted')`)
      .run(from, JSON.stringify({ ...split(TOKENS), where: [{ param: 'amount', op: 'eq', value: 1 }] }), JSON.stringify({ ...split(DEATH), where: [] }));
    const r = carryForwardSet(db, from, 'm2', { all: true, moves: [{ type: TOKENS, into: DRAW, params: { amount: 'count' } }] });
    expect(r.carried.map((c) => c.demand)).toEqual([DEATH, ACT]);
    expect(r).toMatchObject({ moved: { rules: 2, merged: 1 }, dropped: { rules: 0, roles: 1 }, roles: 3 });
    const rules = setRules(db, r.setId, 'all');
    expect(rules.map((x) => x.rule_id)).toEqual(['ER-0001', 'ER-0002', 'ER-0004', 'ER-0005', 'ER-0006']);
    const moved = rules.find((x) => x.rule_id === 'ER-0006')!;
    expect(moved.supply).toEqual({ ...split(DRAW), where: [{ param: 'count', op: 'eq', value: 1 }] });
    expect(moved.rule_hash).toBe(ruleHash(moved));
    expect(rules.find((x) => x.rule_id === 'ER-0005')!.status).toBe('accepted');
    expect(carriedDemands(db, r.setId).get(ACT)!.rules).toBe(2);
  });

  it('a move with where adds the limit before the hash, so a moved rule keeps its row, id and votes (spec sec. 22.1 item S3)', () => {
    const { db, from } = source();
    schema(db, 2, [ACT]);
    db.prepare("DELETE FROM atom_types WHERE schema_version = 2 AND type_key = 'TOKENS'").run();
    db.prepare(`UPDATE atom_types SET params_schema = '{"type":"object","properties":{"count":{"type":"integer"}}}' WHERE schema_version = 2 AND type_key = 'CARD_DRAW'`).run();
    db.prepare("UPDATE edge_rules SET votes = 3 WHERE set_id = ? AND rule_id = 'ER-0003'").run(from);
    // With no limit, the moved TOKENS -> ACT rule has the content of this rule, and merges into it.
    const same = ruleHash({ polarity: '+', supply: { ...split(DRAW), where: [] }, demand: { ...split(ACT), where: [] }, param_links: [], implications: [] });
    rule(db, from, same, 'ER-0005', DRAW, ACT, 'accepted');
    const limit = [{ param: 'count', op: 'in' as const, value: [1, 2] }];
    const r = carryForwardSet(db, from, 'm2', { all: true, moves: [{ type: TOKENS, into: DRAW, where: limit }] });
    expect(r.moved).toEqual({ rules: 1, merged: 0 });
    const rules = setRules(db, r.setId, 'all');
    const moved = rules.find((x) => x.rule_id === 'ER-0003')!;
    expect(moved.votes).toBe(3);
    expect(moved.status).toBe('accepted');
    expect(moved.supply).toEqual({ ...split(DRAW), where: limit });
    expect(moved.rule_hash).toBe(ruleHash(moved));
    expect(rules.find((x) => x.rule_id === 'ER-0005')!.supply).toEqual({ ...split(DRAW), where: [] });
  });

  describe('a demand type that a rule move made (plan Task 17)', () => {
    const NEW = 'CARES_ABOUT.NEW_EVENT';
    /** Set 2 has a rule of a type with no batch and no carry row, as a rule move leaves it. Set 3 is a carry of an earlier code. */
    function moved() {
      const { db, from } = source();
      schema(db, 2, []);
      const second = carryForwardSet(db, from, 'm2');
      db.prepare("UPDATE edge_rule_sets SET status = 'superseded' WHERE id = ?").run(from);
      db.prepare("UPDATE edge_rule_sets SET status = 'accepted' WHERE id = ?").run(second.setId);
      rule(db, second.setId, 'h-new', 'ER-0009', DRAW, NEW, 'accepted');
      db.prepare(`INSERT INTO edge_rule_decisions (set_id, rule_hash, decision, decided_by, debate_round, note, decided_at)
                  VALUES (?, 'h-new', 'adopt', 'debate', 1, 'agreed', 't')`).run(second.setId);
      schema(db, 3, []);
      db.prepare(`INSERT INTO atom_types (schema_version, family, type_key, label, params_schema, provenance, evidence)
                  VALUES (3, 'CARES_ABOUT', 'NEW_EVENT', 'New', '{}', 'review_promoted', 'e')`).run();
      return { db, second };
    }
    it('carries the rules of that type to the next set', () => {
      const { db, second } = moved();
      const r = carryForwardSet(db, second.setId, 'm3', { all: true });
      expect(r.carried).toContainEqual({ demand: NEW, rules: 1 });
      expect(setRules(db, r.setId, 'all').find((x) => x.rule_hash === 'h-new')).toMatchObject({ rule_id: 'ER-0009', votes: 2, status: 'accepted' });
      expect(n(db, 'SELECT COUNT(*) n FROM edge_rule_decisions WHERE set_id = ? AND rule_hash = ?', r.setId, 'h-new')).toBe(1);
      expect(carriedDemands(db, r.setId).get(NEW)).toMatchObject({ from_set_id: second.setId, rules: 1 });
    });
    it('repairCarry gives an accepted set the rules that an earlier carry skipped, and a second run does nothing', () => {
      const { db, second } = moved();
      const r = carryForwardSet(db, second.setId, 'm3', { all: true });
      db.prepare("DELETE FROM edge_rule_decisions WHERE set_id = ? AND rule_hash = 'h-new'").run(r.setId);
      db.prepare("DELETE FROM edge_rules WHERE set_id = ? AND rule_hash = 'h-new'").run(r.setId);
      db.prepare('DELETE FROM edge_rule_carry WHERE set_id = ? AND demand = ?').run(r.setId, NEW);
      expect(repairCarry(db, r.setId, { dryRun: true })).toEqual({ from: second.setId, repaired: [{ demand: NEW, rules: 1 }] });
      expect(setRules(db, r.setId, 'all').some((x) => x.rule_hash === 'h-new')).toBe(false);
      expect(repairCarry(db, r.setId).repaired).toEqual([{ demand: NEW, rules: 1 }]);
      expect(setRules(db, r.setId, 'all').find((x) => x.rule_hash === 'h-new')).toMatchObject({ rule_id: 'ER-0009', votes: 2, status: 'accepted' });
      expect(n(db, 'SELECT COUNT(*) n FROM edge_rule_decisions WHERE set_id = ? AND rule_hash = ?', r.setId, 'h-new')).toBe(1);
      expect(repairCarry(db, r.setId).repaired).toEqual([]);
    });
    it('repairCarry refuses a set with no carry', () => {
      const { db, from } = source();
      expect(() => repairCarry(db, from)).toThrow(/not a carried set/);
    });
  });

  it('giveDemandRole gives a new CARES_ABOUT type the accepted role demand, with stored rule text (spec sec. 22.5)', () => {
    const { db, from } = source();
    schema(db, 2, []);
    db.prepare(`INSERT INTO atom_types (schema_version, family, type_key, label, params_schema, provenance, evidence)
                VALUES (2, 'CARES_ABOUT', 'NEW_EVENT', 'New', '{}', 'review_promoted', 'e'), (2, 'PRODUCES', 'NEW_THING', 'New', '{}', 'review_promoted', 'e')`).run();
    const { number, text } = db.prepare('SELECT number, text FROM rules WHERE length(text) > 10 LIMIT 1').get() as { number: string; text: string };
    const evidence = [{ source: 'rule' as const, ref: number, quote: text.slice(0, 10) }];
    const give = (setId: number, type: string, e = evidence) => giveDemandRole(db, setId, { type, demand_note: 'n', evidence: e });
    const r = carryForwardSet(db, from, 'm2', { all: true });
    expect(demandTypes(db, r.setId)).not.toContain('CARES_ABOUT.NEW_EVENT');
    expect(() => give(r.setId, 'PRODUCES.NEW_THING')).toThrow(/not a CARES_ABOUT type/);
    expect(() => give(r.setId, 'CARES_ABOUT.NO_SUCH_TYPE')).toThrow(/has no type/);
    expect(() => give(r.setId, 'CARES_ABOUT.NEW_EVENT', [])).toThrow(/needs evidence/);
    expect(() => give(r.setId, 'CARES_ABOUT.NEW_EVENT', [{ ...evidence[0]!, quote: 'not the rule' }])).toThrow(/not in CR/);
    give(r.setId, 'CARES_ABOUT.NEW_EVENT');
    expect(demandTypes(db, r.setId)).toContain('CARES_ABOUT.NEW_EVENT');
    expect(supplyTypes(db, r.setId)).not.toContain('CARES_ABOUT.NEW_EVENT');
    expect(setRoles(db, r.setId).find((x) => x.type_key === 'NEW_EVENT')).toMatchObject({ role: 'demand', status: 'accepted', votes: 0, demand_note: 'n', resources: [], evidence });
    expect(() => give(r.setId, 'CARES_ABOUT.NEW_EVENT')).toThrow(/already/);
    expect(() => give(from, 'CARES_ABOUT.NEW_EVENT')).toThrow(/not in_progress/);
  });

  describe('spec sec. 23: split types, changed values and merged roles', () => {
    const REM = 'INTERACTION.REMOVAL';
    const COST = 'PRODUCES.COUNTERS';
    /** Set 2 has a source type with the params of the rules, and a removal type that takes them. */
    function splitSource() {
      const { db, from } = source();
      schema(db, 2, []);
      db.prepare(`UPDATE atom_types SET params_schema = ? WHERE schema_version = 2 AND family = 'PRODUCES' AND type_key = 'CARD_DRAW'`)
        .run(JSON.stringify({ ...EMPTY, properties: { targeted: { type: 'boolean' }, object: {} } }));
      db.prepare(`INSERT INTO atom_types (schema_version, family, type_key, label, params_schema, provenance, evidence)
                  VALUES (1, 'INTERACTION', 'REMOVAL', 'R', ?, 'spec_4_1', 'e'), (2, 'INTERACTION', 'REMOVAL', 'R', ?, 'spec_4_1', 'e'),
                         (1, 'PRODUCES', 'COUNTERS', 'C', ?, 'spec_4_1', 'e'), (2, 'PRODUCES', 'COUNTERS', 'C', ?, 'spec_4_1', 'e')`)
        .run(...[{ removal_type: {}, object: {} }, { removal_type: {}, object: {} }, { counter_type: {} }, { counter_type: {} }].map((p) => JSON.stringify({ ...EMPTY, properties: p })));
      const set = (hash: string, where: object[], supply = DRAW) => db.prepare(`UPDATE edge_rules SET supply_json = ? WHERE set_id = ? AND rule_hash = ?`)
        .run(JSON.stringify({ ...split(supply), where }), from, hash);
      set('h-death', []);
      set('h-death-2', [{ param: 'targeted', op: 'eq', value: false }]);
      set('h-act', [{ param: 'targeted', op: 'eq', value: true }, { param: 'object', op: 'eq', value: 'other' }]);
      set('h-act-2', [{ param: 'counter_type', op: 'in', value: ['+1/+1', 'other'] }], COST);
      return { db, from };
    }
    const run = (db: DatabaseSync, from: number) => carryForwardSet(db, from, 'm2', {
      schemaVersion: 2, all: true,
      splits: [{ type: DRAW, into: REM, where: [{ param: 'removal_type', op: 'eq', value: 'destroy' }] }],
      values: [{ type: COST, param: 'counter_type', old: 'other', named: ['+1/+1', '-1/-1'] }],
    });

    it('copies a rule, leaves a false rule, and moves a true rule', () => {
      const { db, from } = splitSource();
      const r = run(db, from);
      expect(r.split).toEqual({ copied: 1, moved: 1 });
      const rules = setRules(db, r.setId, 'all');
      const of = (id: string) => rules.find((x) => x.rule_id === id)!;
      // ER-0001 has no `targeted` test: it stays, and a copy goes to the removal type.
      expect(of('ER-0001').supply).toEqual({ ...split(DRAW), where: [] });
      const copy = rules.find((x) => x.rule_id.startsWith('copy-'))!;
      expect(copy).toMatchObject({ status: 'accepted', votes: 2, supply: { ...split(REM), where: [{ param: 'removal_type', op: 'eq', value: 'destroy' }] }, demand: { ...split(DEATH), where: [] } });
      expect(copy.rule_hash).toBe(copy.rule_id.slice('copy-'.length));
      // ER-0002 tests `targeted` false: it stays, and it has no copy.
      expect(of('ER-0002').supply).toEqual({ ...split(DRAW), where: [{ param: 'targeted', op: 'eq', value: false }] });
      // ER-0003 tests `targeted` true: it moves, keeps its id, and loses the test.
      expect(of('ER-0003').supply).toEqual({ ...split(REM), where: [{ param: 'object', op: 'eq', value: 'other' }, { param: 'removal_type', op: 'eq', value: 'destroy' }] });
      expect(rules).toHaveLength(5);
      expect(r.rules).toBe(5);
    });
    it('copies the decisions and the debate outcomes with a copy', () => {
      const { db, from } = splitSource();
      db.prepare("UPDATE edge_rule_decisions SET rule_hash = 'h-death' WHERE set_id = ? AND rule_hash = 'h-death-2'").run(from);
      db.prepare("UPDATE edge_debate_outcomes SET item_key = 'h-death' WHERE set_id = ? AND item_key = 'h-death-2'").run(from);
      const r = run(db, from);
      const copy = setRules(db, r.setId, 'all').find((x) => x.rule_id.startsWith('copy-'))!;
      expect(n(db, 'SELECT COUNT(*) n FROM edge_rule_decisions WHERE set_id = ? AND rule_hash = ?', r.setId, copy.rule_hash)).toBe(1);
      expect(n(db, "SELECT COUNT(*) n FROM edge_debate_outcomes WHERE set_id = ? AND item_key = ? AND stage = 'pairs'", r.setId, copy.rule_hash)).toBe(1);
    });
    it('refuses a rule with a split type on the demand side', () => {
      const { db, from } = splitSource();
      expect(() => carryForwardSet(db, from, 'm2', { schemaVersion: 2, all: true, splits: [{ type: DEATH, into: REM, where: [] }] })).toThrow(/split type/);
    });
    it('changes a predicate that names the old value (B5)', () => {
      const { db, from } = splitSource();
      const r = run(db, from);
      expect(r.values).toBe(1);
      expect(setRules(db, r.setId, 'all').find((x) => x.rule_id === 'ER-0004')!.supply).toEqual({ ...split(COST), where: [{ param: 'counter_type', op: 'disjoint', value: ['-1/-1'] }] });
    });
    it('a type that stays can take a limit on its own rules', () => {
      const { db, from } = source();
      schema(db, 2, []);
      db.prepare(`UPDATE atom_types SET params_schema = ? WHERE schema_version = 2 AND family = 'PRODUCES' AND type_key = 'CARD_DRAW'`)
        .run(JSON.stringify({ ...EMPTY, properties: { scope: {} } }));
      const r = carryForwardSet(db, from, 'm2', { schemaVersion: 2, all: true, moves: [{ type: DRAW, into: DRAW, where: [{ param: 'scope', op: 'eq', value: 'one' }] }] });
      expect(setRules(db, r.setId, 'all').find((x) => x.rule_id === 'ER-0001')!.supply).toEqual({ ...split(DRAW), where: [{ param: 'scope', op: 'eq', value: 'one' }] });
    });
    it('mergeRole takes the union of the source roles, on an open set only', () => {
      const { db, from } = source();
      schema(db, 2, []);
      const evidence = (quote: string) => JSON.stringify([{ source: 'rule', ref: '1', quote }]);
      db.prepare('UPDATE edge_type_roles SET evidence_json = ?, resources_json = ?, votes = 2 WHERE set_id = ? AND type_key = ?').run(evidence('a'), JSON.stringify([{ resource: 'a' }]), from, 'CARD_DRAW');
      db.prepare('UPDATE edge_type_roles SET evidence_json = ?, resources_json = ?, demand_note = ? WHERE set_id = ? AND type_key = ?').run(evidence('b'), JSON.stringify([{ resource: 'b' }]), 'note', from, 'CREATURE_DEATH');
      const r = carryForwardSet(db, from, 'm2', { schemaVersion: 2, all: true });
      mergeRole(db, r.setId, from, { type: DRAW, from: [DEATH] });
      expect(setRoles(db, r.setId).find((x) => x.type_key === 'CARD_DRAW')).toMatchObject({
        role: 'both', demand_note: 'note', votes: 2, resources: [{ resource: 'b' }, { resource: 'a' }], status: 'accepted',
      });
      expect(() => mergeRole(db, from, from, { type: DRAW, from: [DEATH] })).toThrow(/not in_progress/);
      expect(() => mergeRole(db, r.setId, from, { type: DRAW, from: [DEATH, 'PRODUCES.NOT_A_TYPE', TOKENS] })).toThrow(/no role/);
    });
  });

  it('with all, refuses a kept rule that tests a param the new schema does not have (spec sec. 21)', () => {
    const { db, from } = source();
    schema(db, 2, [ACT]);
    db.prepare(`INSERT INTO edge_rules (set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status)
                VALUES (?, 'h-old', 'ER-0007', '+', ?, ?, '[]', '[]', '[]', 2, 'accepted')`)
      .run(from, JSON.stringify({ ...split(DRAW), where: [{ param: 'gone', op: 'eq', value: 1 }] }), JSON.stringify({ ...split(DEATH), where: [] }));
    expect(() => carryForwardSet(db, from, 'm2', { all: true })).toThrow(/ER-0007: PRODUCES\.CARD_DRAW\.gone/);
    expect(n(db, 'SELECT COUNT(*) n FROM edge_rule_sets')).toBe(1);
  });

  describe('a carry on the same schema (plan Task 18)', () => {
    it('copies every demand type with its ids, votes and records, and gives a new tag a batch', () => {
      const { db, from } = source();
      db.prepare(`INSERT INTO atom_types (schema_version, family, type_key, label, params_schema, provenance, evidence)
                  VALUES (1, 'CARES_ABOUT', 'NEW_EVENT', 'New', '{}', 'review_promoted', 'e')`).run();
      const r = carryForwardSet(db, from, 'm2', { all: true, sameSchema: true });
      expect(r).toMatchObject({ fromSetId: from, schemaVersion: 1, changed: [], roles: 4, rules: 4, dropped: { rules: 0, roles: 0 } });
      expect(r.carried).toEqual([{ demand: DEATH, rules: 2 }, { demand: ACT, rules: 2 }]);
      expect(setRules(db, r.setId, 'all').map((x) => [x.rule_id, x.votes, x.status])).toEqual(setRules(db, from, 'all').map((x) => [x.rule_id, x.votes, x.status]));
      expect(n(db, 'SELECT COUNT(*) n FROM edge_rule_decisions WHERE set_id = ?', r.setId)).toBe(2);
      expect(n(db, 'SELECT COUNT(*) n FROM edge_rule_batches WHERE set_id = ?', r.setId)).toBe(0);
      giveDemandRole(db, r.setId, { type: 'CARES_ABOUT.NEW_EVENT', demand_note: 'n', evidence: [{ source: 'rule', ref: '118', quote: (db.prepare("SELECT text FROM rules WHERE number = '118'").get() as { text: string }).text.slice(0, 20) }] });
      expect(demandTypes(db, r.setId)).toEqual([ACT, DEATH, 'CARES_ABOUT.NEW_EVENT'].sort());
      // A carried type keeps its candidates. The new tag has no earlier batch, so it has no row here.
      expect([...shownCandidates(db, r.setId).keys()].sort()).toEqual([DEATH, ACT]);
    });
    it('needs all', () => {
      const { db, from } = source();
      expect(() => carryForwardSet(db, from, 'm2', { sameSchema: true })).toThrow(/needs all/);
      expect(n(db, 'SELECT COUNT(*) n FROM edge_rule_sets')).toBe(1);
    });
  });

  describe('a carry that drops rules (spec sec. 25.5)', () => {
    it('leaves the rules out with their records, and keeps the ids and votes of the others', () => {
      const { db, from } = source();
      schema(db, 2, []);
      const all = setRules(db, from, 'all');
      const gone = all.find((x) => x.status === 'accepted')!;
      const r = carryForwardSet(db, from, 'm2', { all: true, drop: [gone.rule_id] });
      expect(r).toMatchObject({ removed: [gone.rule_id], rules: all.length - 1 });
      const kept = all.filter((x) => x.rule_id !== gone.rule_id).map((x) => [x.rule_id, x.votes, x.status]);
      expect(setRules(db, r.setId, 'all').map((x) => [x.rule_id, x.votes, x.status])).toEqual(kept);
      expect(n(db, 'SELECT COUNT(*) n FROM edge_rule_decisions WHERE set_id = ? AND rule_hash = ?', r.setId, gone.rule_hash)).toBe(0);
      // The source set does not change.
      expect(setRules(db, from, 'all')).toHaveLength(all.length);
    });
    it('refuses an id that is not in the set, and leaves no open set', () => {
      const { db, from } = source();
      schema(db, 2, []);
      expect(() => carryForwardSet(db, from, 'm2', { all: true, drop: ['ER-9999'] })).toThrow(/ER-9999 is not in the carried set/);
      expect(n(db, 'SELECT COUNT(*) n FROM edge_rule_sets')).toBe(1);
    });
    it('removes a rule of an open set with its records, and refuses an accepted set', () => {
      const { db, from } = source();
      schema(db, 2, []);
      const all = setRules(db, from, 'all');
      const gone = all.find((x) => x.status === 'accepted')!;
      const r = carryForwardSet(db, from, 'm2', { all: true });
      const before = n(db, 'SELECT SUM(rules) n FROM edge_rule_carry WHERE set_id = ?', r.setId);
      expect(dropFromOpenSet(db, r.setId, [gone.rule_id])).toEqual([gone.rule_id]);
      expect(setRules(db, r.setId, 'all').map((x) => x.rule_id)).not.toContain(gone.rule_id);
      expect(n(db, 'SELECT COUNT(*) n FROM edge_rule_decisions WHERE set_id = ? AND rule_hash = ?', r.setId, gone.rule_hash)).toBe(0);
      expect(n(db, 'SELECT SUM(rules) n FROM edge_rule_carry WHERE set_id = ?', r.setId)).toBe(before - 1);
      // An unknown id rolls back, and the accepted source set is refused.
      expect(() => dropFromOpenSet(db, r.setId, ['ER-9999'])).toThrow(/ER-9999 is not in the carried set/);
      expect(() => dropFromOpenSet(db, from, [gone.rule_id])).toThrow(/only an in-progress set/);
      expect(setRules(db, from, 'all')).toHaveLength(all.length);
    });
  });

  it('refuses a set that is not accepted, the same schema, another corpus, and a second open set', () => {
    const { db, from } = source();
    expect(() => carryForwardSet(db, from, 'm2')).toThrow(/new schema version/);
    expect(() => carryForwardSet(db, from, 'm2', { all: true })).toThrow(/new schema version/);
    schema(db, 2, [ACT]);
    expect(() => carryForwardSet(db, from, 'm2', { corpusId: 99 })).toThrow(/corpus/);
    const r = carryForwardSet(db, from, 'm2');
    expect(() => carryForwardSet(db, r.setId, 'm2', { schemaVersion: 1 })).toThrow(/in_progress/);
    expect(() => carryForwardSet(db, from, 'm2')).toThrow(/in progress/);
    // A failed carry-forward leaves no set behind.
    expect(n(db, 'SELECT COUNT(*) n FROM edge_rule_sets')).toBe(2);
  });
});

describe('the batches of a carried set', () => {
  it('shows the source batches of the roles and of each carried demand type only', () => {
    const { db, from } = source();
    schema(db, 2, [ACT]);
    const { setId } = carryForwardSet(db, from, 'm2');
    batch(db, setId, 'pairs', `${ACT}-0`, [ACT, DRAW], ACT);
    expect(sourceBatches(db, setId).map((b) => [b.set_id, b.batch_key])).toEqual([
      [setId, `${ACT}-0`], [from, `${DEATH}-0`], [from, 'roles-0'],
    ]);
    const shown = shownCandidates(db, setId);
    expect([...shown.keys()].sort()).toEqual([DEATH, ACT].sort());
    expect([...shown.get(DEATH)!.types]).toEqual([DRAW]);
    expect(shown.get(DEATH)!.n).toBe(1);
    expect(shown.get(ACT)!.n).toBe(1);
  });

  it('follows a chain of carried sets to the set whose batches showed the rules', () => {
    const { db, from } = source();
    schema(db, 2, [ACT]);
    const mid = carryForwardSet(db, from, 'm2').setId;
    batch(db, mid, 'pairs', `${ACT}-0`, [ACT, DRAW], ACT);
    rule(db, mid, 'h-act-new', 'ER-0005', DRAW, ACT, 'accepted');
    db.prepare("UPDATE edge_rule_sets SET status = CASE id WHEN ? THEN 'accepted' ELSE 'superseded' END").run(mid);
    schema(db, 3, [ACT]);   // the same params as v2: nothing changes
    const last = carryForwardSet(db, mid, 'm3');
    expect(last.carried).toEqual([{ demand: DEATH, rules: 2 }, { demand: ACT, rules: 1 }].sort((a, b) => a.demand.localeCompare(b.demand)));
    expect([...carriedDemands(db, last.setId).values()].map((c) => c.from_set_id)).toEqual([mid, mid]);
    expect(sourceBatches(db, last.setId).map((b) => [b.set_id, b.batch_key])).toEqual([
      [mid, `${ACT}-0`], [from, `${DEATH}-0`], [from, 'roles-0'],
    ]);
  });
});
