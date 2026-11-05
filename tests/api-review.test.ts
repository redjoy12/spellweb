import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server/app.js';
import { finaliseCard } from '../src/atoms/verify.js';
import { enqueueFindings } from '../src/atoms/queue.js';
import { enqueueEdgeFinding } from '../src/graph/edgeQueue.js';
import { fixtureWithClauses, insertAtom, addRun } from './helpers/fixture.js';

/** Card `o` with an uncovered clause and a missing-rule report: two findings. */
function server() {
  const db = fixtureWithClauses('Draw a card. You gain 2 life.');
  insertAtom(db, { span_start: 0, span_end: 12 });
  db.exec(`INSERT INTO missing_rule_reports (run_id, oracle_id, face_index, quote, statement, oracle_hash)
           VALUES (1,'o',0,'You gain 2 life','life gain was not supplied','h')`);
  finaliseCard(db, 1, 'o');
  enqueueFindings(db, 1, 'o');
  return { db, app: buildServer(db) };
}

describe('review routes', () => {
  it('lists pending findings in rank order with per-severity counts', async () => {
    const { app } = server();
    const res = await app.inject({ url: '/api/review/queue' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((f: { severity: string }) => f.severity)).toEqual(['coverage_miss', 'missing_rule']);
    expect(body.counts).toMatchObject({ coverage_miss: 1, missing_rule: 1, unclassified: 0 });
  });

  it('accepts a finding as correct and drops it from the pending list', async () => {
    const { app } = server();
    const [first] = (await app.inject({ url: '/api/review/queue' })).json().items;
    expect((await app.inject({ method: 'POST', url: `/api/review/findings/${first.id}/accept` })).json()).toEqual({ ok: true });
    expect((await app.inject({ url: '/api/review/queue' })).json().items).toHaveLength(1);
  });

  it('returns a refusal verbatim as 400, and an unknown finding as 404', async () => {
    const { app } = server();
    const items = (await app.inject({ url: '/api/review/queue' })).json().items;
    const report = items.find((f: { severity: string }) => f.severity === 'missing_rule');
    const bad = await app.inject({ method: 'POST', url: `/api/review/findings/${report.id}/accept-missing-rule`, payload: { rule_number: '999.9' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/not in the current Comprehensive Rules/);
    expect((await app.inject({ method: 'POST', url: '/api/review/findings/9999/accept' })).statusCode).toBe(404);
    const wrongKind = await app.inject({ method: 'POST', url: `/api/review/findings/${items[0].id}/accept-splitter` });
    expect(wrongKind.statusCode).toBe(400);
  });

  it('writes a correction through the golden-atom gates', async () => {
    const { app, db } = server();
    const [miss] = (await app.inject({ url: '/api/review/queue' })).json().items;
    const res = await app.inject({ method: 'POST', url: `/api/review/findings/${miss.id}/correct`, payload: {
      face_index: 0, family: 'PRODUCES', type_key: 'LIFEGAIN', params: {}, quote: 'You gain 2 life', rule_numbers: ['119.1'],
    } });
    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT source FROM golden_atoms').get()).toEqual({ source: 'review_correction' });
  });

  it('the inspector shows escape-hatch rows only from the run that owns the live set', async () => {
    const { app, db } = server();
    const two = addRun(db);
    insertAtom(db, { run_id: two, span_start: 0, span_end: 12 });
    finaliseCard(db, two, 'o');
    db.prepare(`INSERT INTO unclassified_clauses (run_id, oracle_id, face_index, span_start, span_end, quote, proposed_label, rationale, oracle_hash)
                VALUES (?, 'o', 0, 13, 28, 'You gain 2 life', 'NEW', 'r', 'h')`).run(two);
    const face = (await app.inject({ url: '/api/cards/o/atoms' })).json().faces[0];
    expect(face.missingRules).toEqual([]);                      // run 1's report is superseded
    expect(face.unclassified.map((u: { proposed_label: string }) => u.proposed_label)).toEqual(['NEW']);
    expect(face.atoms).toHaveLength(1);
  });

  it('reports runs with their verdict counts and the missing-rule rate', async () => {
    const { app, db } = server();
    db.exec('UPDATE extraction_runs SET cards_attempted = 1');
    const run = (await app.inject({ url: '/api/runs' })).json().runs[0];
    expect(run).toMatchObject({
      id: 1, outcomes: { passed: 0, flagged: 1, failed: 0 },
      missing_rule: { reports: 1, cards: 1, rate: 1, open: 1 },
      tokens: { measured: false }, findings_pending: 2,
    });
  });

  it('?domain=edge returns only edge findings, with counts by edge severity', async () => {
    const { app, db } = server();
    const setId = Number(db.prepare(
      "INSERT INTO edge_rule_sets (version, schema_version, corpus_id, packet_sha, model, status, created_at) VALUES (1, 1, 1, 's', 'm', 'in_progress', 't')",
    ).run().lastInsertRowid);
    const ruleRow = Number(db.prepare(
      `INSERT INTO edge_rules (set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status)
       VALUES (?, 'h1', 'R1', '+', '{}', '{}', '[]', '[]', '[]', 2, 'disputed')`,
    ).run(setId).lastInsertRowid);
    enqueueEdgeFinding(db, { severity: 'edge_rule_disagreement', ruleSetId: setId, detailTable: 'edge_rules', detailId: ruleRow, rankScore: 4 });

    const edge = (await app.inject({ url: '/api/review/queue?domain=edge' })).json();
    expect(edge.items.map((f: { severity: string }) => f.severity)).toEqual(['edge_rule_disagreement']);
    expect(edge.items[0].summary).toContain('rule R1');
    expect(edge.counts).toEqual({ edge_role_disagreement: 0, edge_rule_disagreement: 1, edge_report: 0 });

    // Without `domain`, and with domain=atom: the same atom findings and counts as before.
    for (const url of ['/api/review/queue', '/api/review/queue?domain=atom']) {
      const atom = (await app.inject({ url })).json();
      expect(atom.items.map((f: { severity: string }) => f.severity)).toEqual(['coverage_miss', 'missing_rule']);
      expect(atom.counts).toMatchObject({ coverage_miss: 1, missing_rule: 1, unclassified: 0 });
      expect(Object.keys(atom.counts)).not.toContain('edge_rule_disagreement');
    }
  });

  it('an unknown domain gives 400', async () => {
    const { app } = server();
    const res = await app.inject({ url: '/api/review/queue?domain=cards' });
    expect(res.statusCode).toBe(400);
  });
});
