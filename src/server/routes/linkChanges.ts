/**
 * The routes of the link review (docs/superpowers/specs/2026-11-03-link-review-design.md sec. 8): the
 * tab "Link changes", the owner answers, the apply requests and the removal of an owner link. The
 * link check itself is a deck chat turn (`POST /api/decks/:id/link-check`, routes/deckChat.ts).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newestBuild, weakPairKeys, withWeakAnswers } from '../../deck/deck.js';
import { answerSuggestion, cancelApplyRequest, createApplyRequest, LinkChangeError, linkChangesPage, removeOwnerLink } from '../../deck/linkChanges.js';
import { loadDeckPolicy } from '../../deck/policy.js';
import { tableOf } from './decks.js';
import { indexOfBuild } from './graph.js';

const AnswerZ = z.object({ answer: z.enum(['yes', 'weak', 'no']), note: z.string().default('') }).strict();

const CODE = { invalid: 400, not_found: 404, conflict: 409 } as const;

export async function linkChangeRoutes(app: FastifyInstance) {
  /** The newest build with the owner answers of this moment, as a new deck reads it. */
  const graph = () => {
    const buildId = newestBuild(app.db);
    return { idx: indexOfBuild(app.db)(buildId)!, table: withWeakAnswers(app.db, tableOf(app.db, buildId), loadDeckPolicy()), weak: weakPairKeys(app.db) };
  };
  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) => {
    if (err instanceof LinkChangeError) return reply.code(CODE[err.kind]).send({ error: err.message });
    throw err;
  };

  app.get('/api/link-changes', async () => {
    // A new database has no build yet, and so no link check and no suggestion.
    const built = (app.db.prepare('SELECT COUNT(*) AS n FROM graph_builds').get() as { n: number }).n > 0;
    if (!built) return { build_id: null, items: [], to_apply: { suggestions: 0, reports: 0 }, open_request: null, requests: [] };
    const { idx, table, weak } = graph();
    return linkChangesPage(app.db, idx, table, weak);
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/link-changes/:id/answer', async (req, reply) => {
    const parsed = AnswerZ.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'the body needs an answer: yes, weak or no, and can have a note' });
    try {
      answerSuggestion(app.db, Number(req.params.id), parsed.data.answer, parsed.data.note);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/link-apply', async (_req, reply) => {
    const { table, weak } = graph();
    try {
      return createApplyRequest(app.db, table, weak);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/link-apply/:id/cancel', async (req, reply) => {
    try {
      cancelApplyRequest(app.db, Number(req.params.id));
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/owner-links/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'the ID is not a number' });
    const removed = removeOwnerLink(app.db, id);
    if (!removed) return reply.code(404).send({ error: `no active owner link ${id}` });
    return { removed };
  });
}
