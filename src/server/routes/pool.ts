import type { FastifyInstance } from 'fastify';

export async function poolRoutes(app: FastifyInstance) {
  app.get('/api/pool/status', async () => {
    const one = (sql: string, ...p: Array<string | number | null>) =>
      app.db.prepare(sql).get(...p) as any;
    return {
      pool: one('SELECT COUNT(*) AS n FROM cards WHERE rotated = 0').n,
      rotated: one('SELECT COUNT(*) AS n FROM cards WHERE rotated = 1').n,
      faces: one('SELECT COUNT(*) AS n FROM card_faces').n,
      queued: one("SELECT COUNT(*) AS n FROM extraction_queue WHERE status = 'pending'").n,
      snapshots: app.db
        .prepare('SELECT * FROM snapshots ORDER BY id DESC LIMIT 20')
        .all(),
      corpus: one('SELECT * FROM rules_corpus WHERE is_current = 1') ?? null,
    };
  });

  app.get('/api/pool/diffs', async () => ({
    items: app.db.prepare('SELECT * FROM pool_diffs ORDER BY id DESC LIMIT 50').all(),
  }));

  app.get<{ Params: { id: string } }>('/api/pool/diffs/:id', async (req, reply) => {
    const summary = app.db.prepare('SELECT * FROM pool_diffs WHERE id = ?').get(Number(req.params.id));
    if (!summary) return reply.code(404).send({ error: 'diff not found' });
    const entries = app.db
      .prepare(
        `SELECT e.*, COALESCE(c.name, '(unknown)') AS name, c.image_art_crop
         FROM pool_diff_entries e LEFT JOIN cards c ON c.oracle_id = e.oracle_id
         WHERE e.diff_id = ? ORDER BY e.change, name`,
      )
      .all(Number(req.params.id));
    return { summary, entries };
  });
}
