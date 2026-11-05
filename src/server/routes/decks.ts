/**
 * The deck routes (Phase 4 design sec. 11, plan Task 7). `POST /api/decks` builds a deck from a goal
 * form on the newest build and stores it. The other routes read the stored decks.
 *
 * The server keeps the pair table of the newest build in memory, so the first deck takes about
 * 25 s and later decks take less. The index comes from the cache of the graph routes. The table
 * has no weak answers, so a weak mark reaches the next deck without a new table.
 */
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { LegalityError } from '../../deck/check.js';
import { z } from 'zod';
import { makeDeck, newestBuild, scopePairTable, weakPairKeys, withWeakAnswers } from '../../deck/deck.js';
import { GoalError, storedGoal } from '../../deck/goal.js';
import { justifyDeck, type DeckView } from '../../deck/justify.js';
import { clearWeakMark, saveWeakMark, withMarks } from '../../deck/marks.js';
import type { PairTable } from '../../deck/pairs.js';
import { deckPolicySha, loadDeckPolicy } from '../../deck/policy.js';
import { rateReady } from '../../deck/rates.js';
import { buildChatStore, closeTalk, talkOf } from '../chat/build.js';
import { commentsOf } from '../chat/store.js';
import { indexOfBuild } from './graph.js';

/** One pair table for each database and build, so two servers on two databases never share one. */
const tables = new WeakMap<DatabaseSync, Map<number, PairTable>>();

export function tableOf(db: DatabaseSync, buildId: number): PairTable {
  let m = tables.get(db);
  if (!m) { m = new Map(); tables.set(db, m); }
  const hit = m.get(buildId);
  if (hit) return hit;
  // Only the newest build matters, so an older table leaves the memory.
  m.clear();
  const table = scopePairTable(db, indexOfBuild(db)(buildId)!);
  m.set(buildId, table);
  return table;
}

interface DeckRow { id: number; build_id: number; goal_json: string; policy_sha: string; deck_json: string; created_at: string; brief: string | null }

const WeakMarkZ = z.object({ supply: z.string().min(1), demand: z.string().min(1), note: z.string().trim().default('') }).strict();

/** The view in a stored row. */
export function viewOf(json: string): DeckView {
  const d = JSON.parse(json) as DeckView;
  return { ...d, goal: storedGoal(d.goal) };
}

/** The stored row of a deck, from the ID of a route. */
export function deckRowOf(db: DatabaseSync, raw: string): DeckRow | undefined {
  const id = Number(raw);
  return Number.isInteger(id) ? db.prepare('SELECT * FROM decks WHERE id = ?').get(id) as unknown as DeckRow | undefined : undefined;
}

export async function deckRoutes(app: FastifyInstance) {
  // The goal form disables the card rate switch when this says no. `POST /api/decks` tests it again.
  app.get('/api/decks/rate', async () => {
    const { id } = app.db.prepare('SELECT MAX(id) AS id FROM graph_builds').get() as { id: number | null };
    return { build_id: id, ready: id !== null && rateReady(app.db, id) };
  });

  app.post<{ Body: unknown }>('/api/decks/weak', async (req, reply) => {
    const parsed = WeakMarkZ.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'the body needs supply and demand' });
    const { supply, demand, note } = parsed.data;
    const found = app.db.prepare('SELECT COUNT(*) AS n FROM cards WHERE oracle_id IN (?, ?)').get(supply, demand) as { n: number };
    if (found.n !== 2) return reply.code(404).send({ error: 'no pair of two different cards with these IDs' });
    saveWeakMark(app.db, supply, demand, note);
    return { ok: true };
  });

  app.delete<{ Querystring: { supply?: string; demand?: string } }>('/api/decks/weak', async (req, reply) => {
    const { supply, demand } = req.query;
    if (!supply || !demand) return reply.code(400).send({ error: 'the query needs supply and demand' });
    const removed = clearWeakMark(app.db, supply, demand);
    // An answer on the "Your decisions" page can keep the pair weak.
    return { removed, weak: weakPairKeys(app.db).has(`${supply}>${demand}`) };
  });

  app.post<{ Body: unknown }>('/api/decks', async (req, reply) => {
    const policy = loadDeckPolicy();
    // Build chat design sec. 8: a build from a talk names the talk. The goal form does not hold it.
    const { build_chat_id: talkId, ...goal } = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const talk = talkId === undefined ? null : Number.isInteger(talkId) ? talkOf(app.db, talkId as number, policy) : null;
    if (talkId !== undefined && !talk) return reply.code(404).send({ error: `no talk ${String(talkId)}` });
    if (talk && talk.deck_id !== null) return reply.code(409).send({ error: `This talk already built deck ${talk.deck_id}. Start a new talk.` });
    const buildId = newestBuild(app.db);
    const idx = indexOfBuild(app.db)(buildId)!;
    const table = withWeakAnswers(app.db, tableOf(app.db, buildId), policy);
    let view: DeckView;
    try {
      const sha = deckPolicySha(policy);
      view = justifyDeck(app.db, idx, table, makeDeck(app.db, idx, table, goal, policy), buildId, sha, policy);
    } catch (err) {
      if (err instanceof GoalError) return reply.code(400).send({ error: err.message });
      if (err instanceof LegalityError) return reply.code(422).send({ error: `no deck: ${err.message}` });
      throw err;
    }
    const id = Number(app.db.prepare(
      'INSERT INTO decks (build_id, goal_json, policy_sha, deck_json, created_at, brief) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(buildId, JSON.stringify(view.goal), view.policy_sha, JSON.stringify(view), new Date().toISOString(), talk?.brief.trim() || null).lastInsertRowid);
    if (talk) {
      closeTalk(app.db, talk.chat_id, id);
      buildChatStore.addMessage(app.db, talk.chat_id, 'note', `You built deck ${id}. This talk is closed. The deck page starts a new talk, and it reads the brief.`, { deck_id: id });
    }
    return reply.code(201).send({ id, deck: withMarks(app.db, view) });
  });

  app.get('/api/decks', async () => {
    const rows = app.db.prepare('SELECT id, build_id, deck_json, created_at FROM decks ORDER BY id DESC').all() as unknown as Array<Omit<DeckRow, 'goal_json' | 'policy_sha'>>;
    return {
      decks: rows.map((r) => {
        const d = viewOf(r.deck_json);
        return {
          id: r.id, build_id: r.build_id, created_at: r.created_at, colours: d.goal.colours, target_turn: d.goal.target_turn,
          seeds: d.cards.filter((c) => c.role === 'seed').map((c) => c.name), land_count: d.mana.land_count, warnings: d.warnings.length,
          use_rate: d.goal.use_rate,
        };
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/api/decks/:id', async (req, reply) => {
    const r = deckRowOf(app.db, req.params.id);
    if (!r) return reply.code(404).send({ error: `no deck ${req.params.id}` });
    const comments = Object.fromEntries(commentsOf(app.db, r.id).map((c) => [c.oracle_id, c.text]));
    return { id: r.id, created_at: r.created_at, deck: withMarks(app.db, viewOf(r.deck_json)), comments, brief: r.brief ?? null };
  });

  app.get<{ Params: { id: string } }>('/api/decks/:id/export', async (req, reply) => {
    const r = deckRowOf(app.db, req.params.id);
    if (!r) return reply.code(404).send({ error: `no deck ${req.params.id}` });
    return reply.type('text/plain; charset=utf-8').send((JSON.parse(r.deck_json) as DeckView).export_text);
  });
}
