import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { buildServer } from '../src/server/app.js';
import { listEdgeFindings } from '../src/graph/edgeQueue.js';
import { passDir, submitStage } from '../src/graph/ruleBatches.js';
import type { RoleItem } from '../src/graph/ruleSchema.js';
import { acceptRuleSet, createRuleSet } from '../src/graph/ruleSet.js';
import { fixtureWithClauses } from './helpers/fixture.js';

// Plan Task 3 Step 7 and D13, on a scratch database. The Stage A answers are synthetic, with
// quotes from the fixture rule rows ("text of <number>").

const ev = (ref: string) => ({ source: 'rule' as const, ref, quote: `text of ${ref}` });
const role = (type_key: string, r: RoleItem['role'], over: Partial<RoleItem> = {}): RoleItem =>
  ({ family: 'PRODUCES', type_key, role: r, resources: [], evidence: [ev('700.1')], ...over });

let dir: string;
const before = process.env['EDGE_RULE_BATCHES_DIR'];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'api-edge-rules-')); process.env['EDGE_RULE_BATCHES_DIR'] = dir; });
afterEach(() => {
  if (before === undefined) delete process.env['EDGE_RULE_BATCHES_DIR']; else process.env['EDGE_RULE_BATCHES_DIR'] = before;
  rmSync(dir, { recursive: true, force: true });
});

/** LIFEGAIN is disputed: pass 1 says supply, pass 2 demand, pass 3 both. TOKENS is accepted. */
function server(): { db: DatabaseSync; setId: number; app: ReturnType<typeof buildServer> } {
  const db = fixtureWithClauses('Flying');
  db.prepare("INSERT INTO rule_term_index (corpus_id, term, term_key, source, rule_numbers, definition, evidence) VALUES (1, 'Subtype', 'subtype', 'glossary', '[]', 'd', 'e')").run();
  const { setId } = createRuleSet(db, 'test-model');
  db.prepare(`INSERT INTO edge_rule_batches (set_id, stage, batch_key, demand, types_json, refs_json, packet_sha, packet_bytes, prepared_at)
              VALUES (?, 'roles', 'roles-0', NULL, ?, ?, 'sha', 100, 't')`)
    .run(setId, JSON.stringify(['PRODUCES.LIFEGAIN', 'PRODUCES.TOKENS']), JSON.stringify(['700', '700.1', '118']));
  const bodies = [
    { roles: [role('LIFEGAIN', 'supply'), role('TOKENS', 'supply')], missing_rules: [] },
    { roles: [role('LIFEGAIN', 'demand', { demand_note: 'what pass two watches', resources: [{ resource: 'life', sign: '+', kind: 'value', evidence: [ev('118')] }] }), role('TOKENS', 'supply')], missing_rules: [] },
    { roles: [role('LIFEGAIN', 'both')], missing_rules: [] },
  ];
  bodies.forEach((b, k) => {
    const d = passDir(setId, 'roles', 'roles-0', k + 1);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'response.json'), JSON.stringify(b));
  });
  submitStage(db, setId, 'roles');
  return { db, setId, app: buildServer(db) };
}

const roleRow = (db: DatabaseSync, typeKey: string) =>
  db.prepare("SELECT role, demand_note, resources_json, evidence_json, status FROM edge_type_roles WHERE type_key = ?").get(typeKey) as Record<string, string>;

describe('edge-rule routes (plan Task 3 Step 7, D12, D13)', () => {
  it('lists the sets and the roles, and shows the proposal of each pass of a type', async () => {
    const { app, setId } = server();
    const sets = (await app.inject({ url: '/api/edge-rules/sets' })).json();
    expect(sets.sets[0]).toMatchObject({ set: { id: setId, status: 'in_progress' }, roles_disputed: 1 });
    const roles = (await app.inject({ url: `/api/edge-rules/${setId}/roles` })).json();
    expect(roles.roles.map((r: { type_key: string; status: string }) => [r.type_key, r.status])).toEqual([['LIFEGAIN', 'disputed'], ['TOKENS', 'accepted']]);
    const p = (await app.inject({ url: `/api/edge-rules/${setId}/roles/PRODUCES/LIFEGAIN/proposals` })).json();
    expect(p.proposals.map((x: { pass_index: number; item: RoleItem }) => [x.pass_index, x.item.role])).toEqual([[1, 'supply'], [2, 'demand'], [3, 'both']]);
    expect((await app.inject({ url: `/api/edge-rules/${setId}/roles/PRODUCES/NOPE/proposals` })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/edge-rules/99/roles' })).statusCode).toBe(404);
  });

  it('decide copies the role, note, effects and evidence of the pass, accepts the role and resolves the queue item', async () => {
    const { app, db, setId } = server();
    expect(listEdgeFindings(db).map((f) => f.role_type)).toEqual(['PRODUCES.LIFEGAIN']);
    const res = await app.inject({ method: 'POST', url: `/api/edge-rules/${setId}/roles/decide`,
      payload: { family: 'PRODUCES', type_key: 'LIFEGAIN', pass_index: 2, note: 'the person adopts pass 2' } });
    expect(res.json()).toEqual({ ok: true });
    const row = roleRow(db, 'LIFEGAIN');
    expect(row).toMatchObject({ role: 'demand', demand_note: 'what pass two watches', status: 'accepted' });
    expect(JSON.parse(row['resources_json']!)).toEqual([{ resource: 'life', sign: '+', kind: 'value', evidence: [ev('118')] }]);
    expect(JSON.parse(row['evidence_json']!)).toEqual([ev('700.1')]);
    expect(listEdgeFindings(db)).toHaveLength(0);
    expect(db.prepare('SELECT decision, pass_index, note FROM edge_role_decisions').get()).toEqual(expect.objectContaining({ decision: 'pass', pass_index: 2, note: 'the person adopts pass 2' }));
  });

  it('none keeps the role none, accepted, and resolves the queue item', async () => {
    const { app, db, setId } = server();
    const res = await app.inject({ method: 'POST', url: `/api/edge-rules/${setId}/roles/none`, payload: { family: 'PRODUCES', type_key: 'LIFEGAIN', note: 'no role' } });
    expect(res.json()).toEqual({ ok: true });
    expect(roleRow(db, 'LIFEGAIN')).toMatchObject({ role: 'none', status: 'accepted' });
    expect(listEdgeFindings(db)).toHaveLength(0);
  });

  it('gives 400 for a pass that proposed no role for the type, a type with no review item, a bad body or no note', async () => {
    const { app, db, setId } = server();
    const post = (payload: unknown, kind = 'decide') => app.inject({ method: 'POST', url: `/api/edge-rules/${setId}/roles/${kind}`, payload: payload as Record<string, unknown> });
    db.prepare("DELETE FROM edge_rule_pass_items WHERE item_key = 'PRODUCES.LIFEGAIN' AND pass_index = 3").run();
    expect((await post({ family: 'PRODUCES', type_key: 'LIFEGAIN', pass_index: 3, note: 'n' })).statusCode).toBe(400);
    expect((await post({ family: 'PRODUCES', type_key: 'TOKENS', pass_index: 1, note: 'n' })).statusCode).toBe(400);
    expect((await post({ family: 'PRODUCES', type_key: 'LIFEGAIN', pass_index: 'one', note: 'n' })).statusCode).toBe(400);
    expect((await post({ family: 'PRODUCES', type_key: 'LIFEGAIN', note: ' ' }, 'none')).statusCode).toBe(400);
    expect((await post({ family: 'PRODUCES', type_key: 'NOPE', note: 'n' }, 'none')).statusCode).toBe(404);
    expect(roleRow(db, 'LIFEGAIN')).toMatchObject({ role: 'none', status: 'disputed' });
  });

  it('keep resolves the item of an accepted role and changes nothing; keep on a disputed role gives 400', async () => {
    const { app, db, setId } = server();
    const post = (type_key: string) => app.inject({ method: 'POST', url: `/api/edge-rules/${setId}/roles/keep`, payload: { family: 'PRODUCES', type_key, note: 'n' } });
    expect((await post('LIFEGAIN')).statusCode).toBe(400);
    db.prepare(`INSERT INTO review_queue (domain, rule_set_id, severity, severity_rank, rank_score, detail_table, detail_id, enqueued_at)
                SELECT 'edge', ?, 'edge_role_disagreement', 1, 0, 'edge_type_roles', rowid, 't' FROM edge_type_roles WHERE type_key = 'TOKENS'`).run(setId);
    const before = roleRow(db, 'TOKENS');
    expect((await post('TOKENS')).json()).toEqual({ ok: true });
    expect(roleRow(db, 'TOKENS')).toEqual(before);
    expect(listEdgeFindings(db).map((f) => f.role_type)).toEqual(['PRODUCES.LIFEGAIN']);
  });

  it('refuses a decision on an accepted set: a correction makes a new set', async () => {
    const { app, setId, db } = server();
    db.prepare(`INSERT INTO edge_rule_batches (set_id, stage, batch_key, demand, types_json, refs_json, packet_sha, packet_bytes, prepared_at)
                VALUES (?, 'pairs', 'x-0', 'x', '[]', '[]', 'sha', 1, 't')`).run(setId);
    db.prepare(`INSERT INTO edge_rule_passes (set_id, stage, batch_key, pass_index, packet_bytes, response_sha, items_valid, items_rejected)
                VALUES (?, 'pairs', 'x-0', 1, 1, 's', 0, 0), (?, 'pairs', 'x-0', 2, 1, 's', 0, 0), (?, 'pairs', 'x-0', 3, 1, 's', 0, 0)`).run(setId, setId, setId);
    acceptRuleSet(db, setId, { force: true });
    const res = await app.inject({ method: 'POST', url: `/api/edge-rules/${setId}/roles/decide`, payload: { family: 'PRODUCES', type_key: 'LIFEGAIN', pass_index: 1, note: 'n' } });
    expect(res.statusCode).toBe(400);
  });
});
