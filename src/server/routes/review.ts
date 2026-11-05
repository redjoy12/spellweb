/**
 * The review queue and the extraction-runs dashboard (plan Task 9; spec sec. 11.2, 11.3).
 *
 * Every write here is one of sec. 11.2's five reviewer actions, and each goes through the
 * function in `src/atoms/queue.ts` that enforces its rules - the route only parses the body
 * and turns a `ReviewError` into a 4xx carrying the refusal verbatim. The server is bound to
 * 127.0.0.1, as for the golden-set adjudication routes.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ReviewError, SEVERITY_RANK, acceptAsCorrect, acceptMissingRule, acceptSplitterDisagreement, getFinding,
  listFindings, promoteAtomType, recordCorrection, type Correction, type PromotedType,
} from '../../atoms/queue.js';
import { currentSchemaVersion } from '../../atoms/schema.js';
import { countEdgeFindings, listEdgeFindings } from '../../graph/edgeQueue.js';
import { runStats } from '../../atoms/runs.js';
import { loadPacketPolicy } from '../../rules/relevance.js';

const STATUS = { invalid: 400, not_found: 404 } as const;

function refuse(reply: FastifyReply, err: unknown) {
  if (err instanceof ReviewError) return reply.code(STATUS[err.kind]).send({ error: err.message });
  throw err;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function reviewRoutes(app: FastifyInstance) {
  // Phase 3 sec. 10.1: two domains, each with its own ranks. No `domain` means 'atom', as before.
  app.get<{ Querystring: { status?: string; domain?: string } }>('/api/review/queue', async (req, reply) => {
    const status = req.query.status === 'resolved' || req.query.status === 'all' ? req.query.status : 'pending';
    const domain = req.query.domain ?? 'atom';
    if (domain === 'edge') return { counts: countEdgeFindings(app.db), items: listEdgeFindings(app.db, status) };
    if (domain !== 'atom') return reply.code(400).send({ error: `unknown review domain "${domain}": use atom or edge` });
    const items = listFindings(app.db, status);
    const counts = Object.fromEntries(Object.keys(SEVERITY_RANK).map((k) => [k, 0])) as Record<string, number>;
    for (const r of app.db.prepare("SELECT severity, COUNT(*) n FROM review_queue WHERE domain = 'atom' AND status = 'pending' GROUP BY severity")
      .all() as Array<{ severity: string; n: number }>) counts[r.severity] = r.n;
    return { counts, items };
  });

  app.get<{ Params: { id: string } }>('/api/review/findings/:id', async (req, reply) => {
    try { return getFinding(app.db, Number(req.params.id)); } catch (err) { return refuse(reply, err); }
  });

  /** The vocabulary the correction and promotion forms offer. */
  app.get('/api/review/atom-types', async () => {
    const v = currentSchemaVersion(app.db);
    return {
      schema_version: v,
      types: app.db.prepare('SELECT family, type_key, label, params_schema FROM atom_types WHERE schema_version = ? ORDER BY family, type_key')
        .all(v),
    };
  });

  app.post<{ Params: { id: string } }>('/api/review/findings/:id/accept', async (req, reply) => {
    try { acceptAsCorrect(app.db, Number(req.params.id)); return { ok: true }; } catch (err) { return refuse(reply, err); }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/review/findings/:id/correct', async (req, reply) => {
    try {
      const f = getFinding(app.db, Number(req.params.id));
      const b = req.body;
      if (!isObj(b) || !Number.isInteger(b['face_index']) || typeof b['family'] !== 'string' || typeof b['type_key'] !== 'string'
          || typeof b['quote'] !== 'string' || !Array.isArray(b['rule_numbers']) || (b['params'] !== undefined && !isObj(b['params']))
          || (b['span_start'] !== undefined && !Number.isInteger(b['span_start']))) {
        throw new ReviewError('a correction needs face_index, family, type_key, quote, rule_numbers and optional params / span_start');
      }
      const c: Correction = {
        face_index: b['face_index'] as number, family: b['family'], type_key: b['type_key'], quote: b['quote'],
        params: (b['params'] as Record<string, unknown> | undefined) ?? {},
        rule_numbers: (b['rule_numbers'] as unknown[]).map(String),
        ...(b['span_start'] !== undefined ? { span_start: b['span_start'] as number } : {}),
      };
      return { ok: true, golden_atom_id: recordCorrection(app.db, f.oracle_id, c) };
    } catch (err) { return refuse(reply, err); }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/review/findings/:id/promote', async (req, reply) => {
    try {
      const f = getFinding(app.db, Number(req.params.id));
      if (f.severity !== 'unclassified' || f.detail_id === null) throw new ReviewError('only an unclassified finding can be promoted');
      const b = req.body;
      if (!isObj(b) || typeof b['family'] !== 'string' || typeof b['type_key'] !== 'string'
          || typeof b['label'] !== 'string' || typeof b['evidence'] !== 'string'
          || (b['params_schema'] !== undefined && !isObj(b['params_schema']))) {
        throw new ReviewError('a promotion needs family, type_key, label, evidence and optional params_schema');
      }
      return { ok: true, ...promoteAtomType(app.db, f.detail_id, b as unknown as PromotedType) };
    } catch (err) { return refuse(reply, err); }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/review/findings/:id/accept-missing-rule', async (req, reply) => {
    try {
      const f = getFinding(app.db, Number(req.params.id));
      if (f.severity !== 'missing_rule' || f.detail_id === null) throw new ReviewError('this finding is not a missing-rule report');
      const b = req.body;
      if (!isObj(b) || typeof b['rule_number'] !== 'string' || !b['rule_number'].trim()) {
        throw new ReviewError('name the rule the packet lacked (rule_number)');
      }
      return { ok: true, ...acceptMissingRule(app.db, f.detail_id, b['rule_number'], loadPacketPolicy()) };
    } catch (err) { return refuse(reply, err); }
  });

  app.post<{ Params: { id: string } }>('/api/review/findings/:id/accept-splitter', async (req, reply) => {
    try {
      const f = getFinding(app.db, Number(req.params.id));
      if (f.severity !== 'splitter_disagreement' || f.detail_id === null) throw new ReviewError('this finding is not a splitter disagreement');
      acceptSplitterDisagreement(app.db, f.detail_id);
      return { ok: true };
    } catch (err) { return refuse(reply, err); }
  });

  app.get('/api/runs', async () => runStats(app.db));
}
