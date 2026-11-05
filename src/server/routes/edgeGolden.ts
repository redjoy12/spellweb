/**
 * The edge golden page (Phase 3 spec sec. 13.5, plan Task 2 Step 7). The owner adjudicates the
 * sample of sec. 11.4 here. The pairs show redacted texts only, never card names. The verdict
 * route is the owner's act; `ownerVerdict` checks each correction and each chain quote. The
 * server is bound to 127.0.0.1.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { targetProgress } from '../../graph/goldenSelect.js';
import { GoldenError, VerdictZ, listPairs, ownerAgreement, ownerVerdict } from '../../graph/goldenLabel.js';
import { loadGraphPolicy } from '../../graph/policy.js';
import { reviewAgreement } from '../../graph/goldenReview.js';

const STATUS = { invalid: 400, not_found: 404 } as const;

function refuse(reply: FastifyReply, err: unknown) {
  if (err instanceof GoldenError) return reply.code(STATUS[err.kind]).send({ error: err.message });
  throw err;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function edgeGoldenRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string } }>('/api/edge-golden/pairs', async (req, reply) => {
    try { return { pairs: listPairs(app.db, req.query.status || undefined) }; } catch (err) { return refuse(reply, err); }
  });

  app.get('/api/edge-golden/progress', async () => {
    const policy = loadGraphPolicy();
    const p = targetProgress(app.db, policy);
    return {
      ...p,
      cap: policy.golden.cap,
      agreement: ownerAgreement(app.db),
      review: reviewAgreement(app.db),
      owner_correction_limit: policy.golden.owner_correction_limit,
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/edge-golden/pairs/:id/verdict', async (req, reply) => {
    const body = req.body;
    if (!isObj(body) || typeof body['accept'] !== 'boolean') {
      return reply.code(400).send({ error: 'the body needs "accept": true or false' });
    }
    const parsed = VerdictZ.safeParse(body);
    if (!parsed.success) {
      return reply.code(400).send({ error: `bad verdict: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ')}` });
    }
    try {
      ownerVerdict(app.db, Number(req.params.id), parsed.data);
      return { ok: true };
    } catch (err) { return refuse(reply, err); }
  });
}
