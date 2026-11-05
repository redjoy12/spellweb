/**
 * The games of a deck (game review design sec. 3) and the log scan. The scan runs only when the
 * server asks for it, so a test server does not read the log of this machine.
 */
import type { FastifyInstance } from 'fastify';
import { deckGames } from '../../games/counts.js';
import { keepDirOf, loadGameConfig, logDirOf, scanLogs } from '../../games/scan.js';
import { deckRowOf } from './decks.js';

export async function gameRoutes(app: FastifyInstance, opts: { scan?: boolean }) {
  if (opts.scan) {
    const config = loadGameConfig();
    const run = () => { scanLogs(app.db, { dir: logDirOf(config), keepDir: keepDirOf(app.db), closeCopies: config.close_copies }); };
    const first = setTimeout(run, 0);
    const timer = setInterval(run, config.scan_seconds * 1000);
    app.addHook('onClose', async () => {
      clearTimeout(first);
      clearInterval(timer);
    });
  }

  app.get<{ Params: { id: string } }>('/api/decks/:id/games', async (req, reply) => {
    const r = deckRowOf(app.db, req.params.id);
    if (!r) return reply.code(404).send({ error: `no deck ${req.params.id}` });
    return deckGames(app.db, r.id);
  });
}
