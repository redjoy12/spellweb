import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../db/client.js';
import { cardRoutes } from './routes/cards.js';
import { poolRoutes } from './routes/pool.js';
import { rulesRoutes } from './routes/rules.js';
import { atomRoutes } from './routes/atoms.js';
import { goldenRoutes } from './routes/golden.js';
import { reviewRoutes } from './routes/review.js';
import { edgeGoldenRoutes } from './routes/edgeGolden.js';
import { edgeRuleRoutes } from './routes/edgeRules.js';
import { graphRoutes } from './routes/graph.js';
import { fixRequestRoutes } from './routes/fixRequests.js';
import { decisionRoutes } from './routes/decisions.js';
import { deckRoutes } from './routes/decks.js';
import { deckChatRoutes } from './routes/deckChat.js';
import { buildChatRoutes } from './routes/buildChat.js';
import { gameRoutes } from './routes/games.js';
import { linkChangeRoutes } from './routes/linkChanges.js';
import type { ChatRunner } from './chat/turn.js';

/**
 * `fixRequestDir` is the folder of the fix-request briefs; the default is data/fix-requests next to the database file.
 * `now` is the clock of the fix-request dispatcher lease (tests).
 * `chatRunner` replaces the start of the Claude Code CLI (tests).
 * `scanGames` starts the scan of the Arena logs. Only the entrypoint sets it.
 */
export function buildServer(db: DatabaseSync, opts: { fixRequestDir?: string; now?: () => number; chatRunner?: ChatRunner; scanGames?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.get('/api/health', async () => {
    // Exclude SQLite internals and FTS5 shadow tables so the number is the one
    // a human can check against schema.sql.
    const { n } = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
           AND name NOT LIKE 'cards\\_fts\\_%' ESCAPE '\\'`,
      )
      .get() as { n: number };
    return { ok: true, tables: n };
  });
  app.register(cardRoutes);
  app.register(poolRoutes);
  app.register(rulesRoutes);
  app.register(atomRoutes);
  app.register(goldenRoutes);
  app.register(reviewRoutes);
  app.register(edgeGoldenRoutes);
  app.register(edgeRuleRoutes);
  app.register(graphRoutes);
  app.register(decisionRoutes);
  app.register(deckRoutes);
  app.register(deckChatRoutes, { ...(opts.chatRunner ? { chatRunner: opts.chatRunner } : {}) });
  app.register(buildChatRoutes, { ...(opts.chatRunner ? { chatRunner: opts.chatRunner } : {}) });
  app.register(linkChangeRoutes);
  app.register(gameRoutes, { ...(opts.scanGames ? { scan: true } : {}) });
  app.register(fixRequestRoutes, {
    ...(opts.fixRequestDir ? { fixRequestDir: opts.fixRequestDir } : {}), ...(opts.now ? { now: opts.now } : {}),
  });
  return app;
}

declare module 'fastify' {
  interface FastifyInstance { db: DatabaseSync }
}

// Entrypoint when run directly.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const app = buildServer(openDb(), { scanGames: true });
  const port = Number(process.env.API_PORT ?? 8787);
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`API listening on http://127.0.0.1:${port}`);
}
