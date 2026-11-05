import type { FastifyInstance } from 'fastify';
import { clearDecision, decisionPage, DecisionError, saveDecision } from '../../graph/ownerDecisions.js';
import { RATE_FOLLOW_UP_PREFIX, RATE_ROUND_PREFIX, rateFollowUpPage, rateRoundPage, saveRateAnswer, saveRateFollowUp } from '../../rate/ownerRound.js';
import { ROUND2_PREFIX, round2Page, saveRound2Answer } from '../../rate/ownerRound2.js';

/** The "Your decisions" page (owner request 2026-10-18, src/graph/ownerDecisions.ts). */
export async function decisionRoutes(app: FastifyInstance) {
  app.get('/api/decisions', async () => decisionPage(app.db));

  /** The round of the card rate (src/rate/ownerRound.ts): only the job and the cards, so it stays blind. */
  app.get('/api/decisions/rate-round', async () => rateRoundPage(app.db));
  app.get('/api/decisions/rate-follow-up', async () => rateFollowUpPage(app.db));
  /** Round 2 of the card rate (src/rate/ownerRound2.ts): only the words, so no rarity symbol shows. */
  app.get('/api/decisions/rate-round-2', async () => round2Page(app.db));

  app.post<{ Body: { kind?: string; item_key?: string; choice?: string; note?: string } }>('/api/decisions', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.kind || !b.item_key || !b.choice) return reply.code(400).send({ error: 'kind, item_key and choice are required' });
    try {
      if (b.kind === 'link_rule' && b.item_key.startsWith(RATE_ROUND_PREFIX)) return { decision: saveRateAnswer(app.db, { item_key: b.item_key, choice: b.choice, note: b.note }) };
      if (b.kind === 'link_rule' && b.item_key.startsWith(ROUND2_PREFIX)) return { decision: saveRound2Answer(app.db, { item_key: b.item_key, choice: b.choice, note: b.note }) };
      if (b.kind === 'link_rule' && b.item_key.startsWith(RATE_FOLLOW_UP_PREFIX)) return { decision: saveRateFollowUp(app.db, { item_key: b.item_key, choice: b.choice, note: b.note }) };
      return { decision: saveDecision(app.db, { kind: b.kind, item_key: b.item_key, choice: b.choice, note: b.note }) };
    } catch (err) {
      if (err instanceof DecisionError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete<{ Querystring: { kind?: string; item_key?: string } }>('/api/decisions', async (req, reply) => {
    if (!req.query.kind || !req.query.item_key) return reply.code(400).send({ error: 'kind and item_key are required' });
    return { removed: clearDecision(app.db, req.query.kind, req.query.item_key) };
  });
}
