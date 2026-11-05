/**
 * The edge-rule routes (Phase 3 plan Task 3, D12): the sets, the roles, the proposals of each
 * pass, a person's decision on a disputed role (D13), and `GET /api/edge-rules` (Task 7).
 * The session never decides a role: these routes are the person's act. The server is bound to
 * 127.0.0.1.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  RuleSetError, currentRuleSet, decideRole, getRuleSet, keepRoleNone, keepVotedRole, roleProposals, setRoles, setRules,
} from '../../graph/ruleSet.js';
import { setStatus } from '../../graph/ruleBatches.js';

const STATUS = { invalid: 400, not_found: 404 } as const;

function refuse(reply: FastifyReply, err: unknown) {
  if (err instanceof RuleSetError) return reply.code(STATUS[err.kind]).send({ error: err.message });
  throw err;
}

const Type = { family: z.string().min(1), type_key: z.string().min(1) };
const DecideZ = z.object({ ...Type, pass_index: z.number().int().min(1), note: z.string() }).strict();
const NoneZ = z.object({ ...Type, note: z.string() }).strict();

function setIdOf(reply: FastifyReply, raw: string, db: FastifyInstance['db']): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || !getRuleSet(db, id)) {
    void reply.code(404).send({ error: `no edge-rule set ${raw}` });
    return null;
  }
  return id;
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ');

export async function edgeRuleRoutes(app: FastifyInstance) {
  /**
   * spec sec. 13.2 and plan Task 7 (D12): the current (accepted) rule set, all its rules and its
   * roles. Each item has its review-queue item, if any, and each rule its debate outcome and
   * decision (spec rev. 9 sec. 5.6). A debate verdict is not an owner decision.
   */
  app.get('/api/edge-rules', async () => {
    const cur = currentRuleSet(app.db);
    if (!cur) return { set: null, rules: [], roles: [] };
    const set = getRuleSet(app.db, cur.id)!;
    type Queue = { id: number; status: string };
    // A carried set copies its rules and roles; their queue items stay on the earlier set
    // (src/graph/ruleCarry.ts). So the item of a rule hash or a type can be on any earlier set; the newest wins.
    const queueOf = (table: string, keySql: string) => new Map((app.db.prepare(
      `SELECT ${keySql} AS k, q.id, q.status FROM ${table} r
         JOIN review_queue q ON q.domain = 'edge' AND q.detail_table = '${table}' AND q.detail_id = r.rowid
        WHERE r.set_id <= ? ORDER BY q.id`,
    ).all(cur.id) as Array<Queue & { k: string }>).map((r) => [r.k, { id: r.id, status: r.status }]));
    const ruleQueue = queueOf('edge_rules', 'r.rule_hash');
    const roleQueue = queueOf('edge_type_roles', "r.family || '.' || r.type_key");
    const debate = new Map((app.db.prepare(
      "SELECT item_key, outcome, choice, round FROM edge_debate_outcomes WHERE set_id = ? AND stage = 'pairs'",
    ).all(cur.id) as Array<{ item_key: string; outcome: string; choice: string | null; round: number }>)
      .map(({ item_key, ...o }) => [item_key, o]));
    const decision = new Map((app.db.prepare(
      'SELECT rule_hash, decision, decided_by, debate_round, note FROM edge_rule_decisions WHERE set_id = ?',
    ).all(cur.id) as Array<{ rule_hash: string; decision: string; decided_by: string; debate_round: number | null; note: string }>)
      .map(({ rule_hash, ...d }) => [rule_hash, d]));
    return {
      set,
      rules: setRules(app.db, cur.id, 'all').map((r) => ({
        ...r, queue: ruleQueue.get(r.rule_hash) ?? null, debate: debate.get(r.rule_hash) ?? null, decision: decision.get(r.rule_hash) ?? null,
      })),
      roles: setRoles(app.db, cur.id).map((r) => ({ ...r, queue: roleQueue.get(`${r.family}.${r.type_key}`) ?? null })),
    };
  });

  app.get('/api/edge-rules/sets', async () => {
    const ids = (app.db.prepare('SELECT id FROM edge_rule_sets ORDER BY version DESC').all() as Array<{ id: number }>).map((r) => r.id);
    return { sets: ids.map((id) => setStatus(app.db, id)) };
  });

  app.get<{ Params: { setId: string } }>('/api/edge-rules/:setId/roles', async (req, reply) => {
    const id = setIdOf(reply, req.params.setId, app.db);
    if (id === null) return reply;
    return { roles: setRoles(app.db, id) };
  });

  app.get<{ Params: { setId: string; family: string; typeKey: string } }>(
    '/api/edge-rules/:setId/roles/:family/:typeKey/proposals', async (req, reply) => {
      const id = setIdOf(reply, req.params.setId, app.db);
      if (id === null) return reply;
      const role = setRoles(app.db, id).find((r) => r.family === req.params.family && r.type_key === req.params.typeKey);
      if (!role) return reply.code(404).send({ error: `set ${id} has no role for ${req.params.family}.${req.params.typeKey}` });
      return { role, proposals: roleProposals(app.db, id, req.params.family, req.params.typeKey) };
    });

  app.post<{ Params: { setId: string }; Body: unknown }>('/api/edge-rules/:setId/roles/decide', async (req, reply) => {
    const id = setIdOf(reply, req.params.setId, app.db);
    if (id === null) return reply;
    const parsed = DecideZ.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: `bad decision: ${issues(parsed.error)}` });
    try { decideRole(app.db, id, parsed.data); return { ok: true }; } catch (err) { return refuse(reply, err); }
  });

  for (const [path, act] of [['none', keepRoleNone], ['keep', keepVotedRole]] as const) {
    app.post<{ Params: { setId: string }; Body: unknown }>(`/api/edge-rules/:setId/roles/${path}`, async (req, reply) => {
      const id = setIdOf(reply, req.params.setId, app.db);
      if (id === null) return reply;
      const parsed = NoneZ.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: `bad decision: ${issues(parsed.error)}` });
      try { act(app.db, id, parsed.data); return { ok: true }; } catch (err) { return refuse(reply, err); }
    });
  }
}
