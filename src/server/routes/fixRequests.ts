/**
 * The edge reports grouped by reason and the fix requests (owner request 2026-10-18).
 *
 * The UI reads the groups and saves a fix request ("Fix this reason"). The fix-dispatch mod
 * (.claude/skills/fix-dispatch) runs in each Claude session of the project and polls
 * `POST /api/fix-requests/dispatch`; the session with the lease gets the due requests, sends each
 * brief to the session with the request's title, and calls `POST /api/fix-requests/:id/sent`, or
 * `POST /api/fix-requests/:id/failed` with the reason. The receiving session calls
 * `POST /api/fix-requests/:id/done` when its report is ready. The server is bound to 127.0.0.1.
 *
 * The POST routes take an empty body of any content type: PowerShell's Invoke-RestMethod sends
 * `application/x-www-form-urlencoded` with no body, and Fastify refused that with 415.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { retireStaleEdgeReports } from '../../graph/edgeQueue.js';
import { readFileSync } from 'node:fs';
import {
  DispatchLease, FIX_STATUSES, FixRequestError, createFixRequest, defaultFixRequestDir, dueFixRequests, failFixRequest,
  getFixRequest, listFixRequests, markFixRequest, openReportCounts, reportGroups, sessionNames, type ReportStatus,
} from '../../graph/fixRequests.js';
import { indexOfBuild } from './graph.js';

const STATUS = { invalid: 400, not_found: 404, conflict: 409 } as const;

function refuse(reply: FastifyReply, err: unknown) {
  if (err instanceof FixRequestError) return reply.code(STATUS[err.kind]).send({ error: err.message });
  throw err;
}

const CreateZ = z.object({
  session_name: z.string(),
  rule_hashes: z.array(z.string().min(1)).min(1),
  build_id: z.number().int().optional(),
  edge_key: z.string().min(1).optional(),
  note: z.string().optional(),
}).strict();

const DispatchZ = z.object({
  dispatcher: z.string().min(1).max(200),
  sessions: z.array(z.object({ title: z.string(), archived: z.boolean() })).max(1000).optional(),
  error: z.string().max(1000).optional(),
}).strict();

const SentZ = z.object({ session_id: z.string().min(1).max(200).optional() }).strict();
const FailedZ = z.object({ error: z.string().min(1).max(500) }).strict();

/** An empty body (undefined, '' or the text of an empty form) as {}. */
const bodyOf = (b: unknown): unknown => (b === undefined || b === null || b === '' ? {} : b);

export async function fixRequestRoutes(app: FastifyInstance, opts: { fixRequestDir?: string; now?: () => number }) {
  const dir = opts.fixRequestDir ?? defaultFixRequestDir(app.db);
  const indexOf = indexOfBuild(app.db);
  const lease = new DispatchLease();
  const now = opts.now ?? Date.now;

  // This plugin scope only: JSON may be empty, and any other content type is read as text.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') { done(null, undefined); return; }
    try { done(null, JSON.parse(body as string)); } catch (err) { (err as { statusCode?: number }).statusCode = 400; done(err as Error, undefined); }
  });
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  /** The reports grouped by reason. status: open (default), closed (stale, accepted or rejected) or all. */
  app.get<{ Querystring: { status?: string } }>('/api/edge-reports/groups', async (req, reply) => {
    const status = (req.query.status ?? 'open') as ReportStatus;
    if (!['open', 'closed', 'all'].includes(status)) return reply.code(400).send({ error: 'status must be open, closed or all' });
    retireStaleEdgeReports(app.db);
    return { ...reportGroups(app.db, indexOf, status), dispatcher: lease.view() };
  });

  /** The number of open reports on each reason, by reason key (the sorted rule hashes, comma-joined). */
  app.get('/api/edge-reports/counts', async () => ({ counts: openReportCounts(app.db) }));

  app.get<{ Querystring: { status?: string } }>('/api/fix-requests', async (req, reply) => {
    const status = req.query.status;
    if (status !== undefined && !(FIX_STATUSES as readonly string[]).includes(status)) {
      return reply.code(400).send({ error: `status must be one of ${FIX_STATUSES.join(', ')}` });
    }
    return {
      items: listFixRequests(app.db, status ? { status: status as (typeof FIX_STATUSES)[number] } : {}),
      session_names: sessionNames(app.db),
      dispatcher: lease.view(),
    };
  });

  /**
   * One poll of the fix-dispatch mod. The holder of the lease gets the due requests; another
   * session gets `lease: false` and no items. `sessions` are the session titles that the holder saw.
   */
  app.post<{ Body: unknown }>('/api/fix-requests/dispatch', async (req, reply) => {
    const parsed = DispatchZ.safeParse(bodyOf(req.body));
    if (!parsed.success) return reply.code(400).send({ error: 'the body needs dispatcher, and can have sessions [{ title, archived }]' });
    const t = now();
    const held = lease.poll(parsed.data.dispatcher, t, parsed.data.sessions, parsed.data.error);
    return { lease: held, items: held ? dueFixRequests(app.db, new Date(t)) : [] };
  });

  /** The brief file of a request, as markdown. */
  app.get<{ Params: { id: string } }>('/api/fix-requests/:id/brief', async (req, reply) => {
    try {
      const r = getFixRequest(app.db, Number(req.params.id));
      return reply.type('text/markdown; charset=utf-8').send(readFileSync(r.brief_path, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'the brief file is missing' });
      return refuse(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/api/fix-requests/:id', async (req, reply) => {
    try { return getFixRequest(app.db, Number(req.params.id)); } catch (err) { return refuse(reply, err); }
  });

  app.post<{ Body: unknown }>('/api/fix-requests', async (req, reply) => {
    const parsed = CreateZ.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'the body needs session_name and rule_hashes, and can have build_id, edge_key and note' });
    try {
      const b = parsed.data;
      return createFixRequest(app.db, indexOf, dir, {
        session_name: b.session_name, rule_hashes: b.rule_hashes,
        ...(b.build_id !== undefined ? { build_id: b.build_id } : {}),
        ...(b.edge_key !== undefined ? { edge_key: b.edge_key } : {}),
        ...(b.note !== undefined ? { note: b.note } : {}),
      });
    } catch (err) { return refuse(reply, err); }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/fix-requests/:id/sent', async (req, reply) => {
    const parsed = SentZ.safeParse(bodyOf(req.body));
    if (!parsed.success) return reply.code(400).send({ error: 'the body can have session_id' });
    try { return markFixRequest(app.db, Number(req.params.id), 'sent', new Date(now()), parsed.data.session_id); } catch (err) { return refuse(reply, err); }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/fix-requests/:id/failed', async (req, reply) => {
    const parsed = FailedZ.safeParse(bodyOf(req.body));
    if (!parsed.success) return reply.code(400).send({ error: 'the body needs error' });
    try { return failFixRequest(app.db, Number(req.params.id), parsed.data.error, new Date(now())); } catch (err) { return refuse(reply, err); }
  });

  app.post<{ Params: { id: string } }>('/api/fix-requests/:id/done', async (req, reply) => {
    try { return markFixRequest(app.db, Number(req.params.id), 'done'); } catch (err) { return refuse(reply, err); }
  });
}
