import { describe, it, expect } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { finaliseCard } from '../src/atoms/verify.js';
import { enqueueFindings, listFindings } from '../src/atoms/queue.js';
import { enqueueEdgeFinding, listEdgeFindings, resolveEdgeFinding, countEdgeFindings } from '../src/graph/edgeQueue.js';
import { fixtureWithClauses, insertAtom } from './helpers/fixture.js';

/** The shared in-memory card `o` with one atom finding, plus one rule set, rules and a build. */
function setup(): { db: DatabaseSync; setId: number; buildId: number; rules: number[]; reportId: number } {
  const db = fixtureWithClauses('Draw a card. You gain 2 life.');
  insertAtom(db, { span_start: 0, span_end: 12 });
  finaliseCard(db, 1, 'o');
  enqueueFindings(db, 1, 'o');
  const setId = Number(db.prepare(
    "INSERT INTO edge_rule_sets (version, schema_version, corpus_id, packet_sha, model, status, created_at) VALUES (1, 1, 1, 's', 'm', 'in_progress', 't')",
  ).run().lastInsertRowid);
  const rule = db.prepare(
    `INSERT INTO edge_rules (set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status)
     VALUES (?, ?, ?, '+', '{}', '{}', '[]', '[]', '[]', 2, 'disputed')`,
  );
  const rules = ['r1', 'r2'].map((h) => Number(rule.run(setId, h, h.toUpperCase()).lastInsertRowid));
  const buildId = Number(db.prepare(
    `INSERT INTO graph_builds (build_key, rule_set_id, schema_version, corpus_id, pool_snapshot_id, tests_version, atom_set_sha, scope, built_at, counts_json)
     VALUES ('k', ?, 1, 1, 1, 1, 'a', 'BR', 't', '{}')`,
  ).run(setId).lastInsertRowid);
  const reportId = Number(db.prepare(
    `INSERT INTO edge_reports (build_id, edge_key, supply_oracle, demand_oracle, rule_hashes, note, status, created_at)
     VALUES (?, 'e1', 'o', 'o', '["r1"]', 'looks wrong', 'open', 't')`,
  ).run(buildId).lastInsertRowid);
  return { db, setId, buildId, rules, reportId };
}

describe('edge review queue', () => {
  it('an edge finding goes into the edge domain and does not show in listFindings', () => {
    const { db, setId, rules } = setup();
    const atomIds = listFindings(db).map((f) => f.id);
    expect(enqueueEdgeFinding(db, { severity: 'edge_rule_disagreement', ruleSetId: setId, detailTable: 'edge_rules', detailId: rules[0]!, rankScore: 0 })).toBe(1);
    expect(listFindings(db).map((f) => f.id)).toEqual(atomIds);
    const [edge] = listEdgeFindings(db);
    expect(edge).toMatchObject({ severity: 'edge_rule_disagreement', severity_rank: 2, rule_set_id: setId, oracle_id: null, name: null });
    expect(edge!.summary).toContain('rule R1');
    expect(db.prepare('SELECT domain FROM review_queue WHERE id = ?').get(edge!.id)).toEqual({ domain: 'edge' });
  });

  it('sorts by severity_rank, rank_score DESC, id inside the edge domain only', () => {
    const { db, setId, buildId, rules, reportId } = setup();
    enqueueEdgeFinding(db, { severity: 'edge_report', ruleSetId: setId, buildId, oracleId: 'o', detailTable: 'edge_reports', detailId: reportId, rankScore: 99 });
    enqueueEdgeFinding(db, { severity: 'edge_rule_disagreement', ruleSetId: setId, detailTable: 'edge_rules', detailId: rules[0]!, rankScore: 3 });
    enqueueEdgeFinding(db, { severity: 'edge_rule_disagreement', ruleSetId: setId, detailTable: 'edge_rules', detailId: rules[1]!, rankScore: 7 });
    const list = listEdgeFindings(db);
    expect(list.map((f) => [f.severity, f.rank_score])).toEqual([
      ['edge_rule_disagreement', 7], ['edge_rule_disagreement', 3], ['edge_report', 99],
    ]);
    expect(list.every((f) => f.rule_set_id === setId)).toBe(true);
    expect(countEdgeFindings(db)).toEqual({ edge_role_disagreement: 0, edge_rule_disagreement: 2, edge_report: 1 });
  });

  it('shows an edge row with no oracle_id (LEFT JOIN cards), and names the card when it has one', () => {
    const { db, setId, buildId, rules, reportId } = setup();
    enqueueEdgeFinding(db, { severity: 'edge_rule_disagreement', ruleSetId: setId, detailTable: 'edge_rules', detailId: rules[0]!, rankScore: 0 });
    enqueueEdgeFinding(db, { severity: 'edge_report', ruleSetId: setId, buildId, oracleId: 'o', detailTable: 'edge_reports', detailId: reportId, rankScore: 0 });
    const list = listEdgeFindings(db);
    expect(list).toHaveLength(2);
    expect(list.map((f) => f.name)).toEqual([null, 'N']);
    expect(list[1]!.summary).toBe('edge e1: looks wrong');
  });

  it('refuses a detail table that does not agree with the severity', () => {
    const { db, setId, rules } = setup();
    expect(() => enqueueEdgeFinding(db, { severity: 'edge_role_disagreement', ruleSetId: setId, detailTable: 'edge_rules', detailId: rules[0]!, rankScore: 0 }))
      .toThrow(/points at edge_type_roles/);
    expect(listEdgeFindings(db)).toHaveLength(0);
  });

  it('a second equal insert adds no row', () => {
    const { db, setId, rules } = setup();
    const f = { severity: 'edge_rule_disagreement' as const, ruleSetId: setId, detailTable: 'edge_rules', detailId: rules[0]!, rankScore: 0 };
    expect(enqueueEdgeFinding(db, f)).toBe(1);
    expect(enqueueEdgeFinding(db, f)).toBe(0);
    expect(listEdgeFindings(db)).toHaveLength(1);
  });

  it('resolves an edge finding, and refuses an atom finding', () => {
    const { db, setId, rules } = setup();
    enqueueEdgeFinding(db, { severity: 'edge_rule_disagreement', ruleSetId: setId, detailTable: 'edge_rules', detailId: rules[0]!, rankScore: 0 });
    const [edge] = listEdgeFindings(db);
    resolveEdgeFinding(db, edge!.id);
    expect(listEdgeFindings(db)).toHaveLength(0);
    expect(listEdgeFindings(db, 'resolved')).toHaveLength(1);
    const [atom] = listFindings(db);
    expect(() => resolveEdgeFinding(db, atom!.id)).toThrow(/no pending edge finding/);
    expect(listFindings(db).map((f) => f.id)).toContain(atom!.id);
  });
});
