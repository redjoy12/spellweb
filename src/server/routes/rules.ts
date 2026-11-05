import type { FastifyInstance } from 'fastify';

export async function rulesRoutes(app: FastifyInstance) {
  app.get('/api/rules/keywords', async () => {
    const corpus = app.db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as
      | { id: number }
      | undefined;
    if (!corpus) return { counts: {}, items: [] };

    const items = app.db
      .prepare(
        `SELECT keyword, keyword_key, rule_number, resolution, evidence
         FROM keyword_rule_map WHERE corpus_id = ? ORDER BY resolution, keyword_key`,
      )
      .all(corpus.id) as any[];

    const counts: Record<string, number> = {};
    for (const i of items) counts[i.resolution] = (counts[i.resolution] ?? 0) + 1;
    return { counts, items };
  });

  app.get<{ Params: { number: string } }>('/api/rules/sections/:number', async (req, reply) => {
    const corpus = app.db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as
      | { id: number }
      | undefined;
    if (!corpus) return reply.code(404).send({ error: 'no current corpus' });

    const n = req.params.number;
    const isSubsection = n.includes('.');
    const isTopLevel = !isSubsection && n.length === 1;

    // Three shapes: '702.2' (subsection), '702' (section), '7' (top level, whose
    // rules live under its child sections and match no section_number directly).
    const sql = isSubsection
      ? 'SELECT number, text FROM rules WHERE corpus_id = ? AND subsection_number = ? ORDER BY ordinal'
      : isTopLevel
        ? `SELECT r.number, r.text FROM rules r
             JOIN rule_sections s ON s.corpus_id = r.corpus_id AND s.number = r.section_number
           WHERE r.corpus_id = ? AND s.parent_number = ? ORDER BY r.ordinal`
        : 'SELECT number, text FROM rules WHERE corpus_id = ? AND section_number = ? ORDER BY ordinal';

    const rules = app.db.prepare(sql).all(corpus.id, n) as Array<{ number: string; text: string }>;
    if (rules.length === 0) return reply.code(404).send({ error: `no rules under ${n}` });

    // `?? n` is required, not defensive: under noUncheckedIndexedAccess the split
    // result is `string | undefined`, which is not a valid SQL bind value.
    const sectionNumber = isSubsection ? (n.split('.')[0] ?? n) : n;

    // For a subsection, prefer its own title ("Deathtouch") over the section's
    // ("Keyword Abilities") — the section title is a poor label for 702.2.
    const subsectionTitle = isSubsection
      ? (app.db
          .prepare(
            `SELECT subsection_title FROM rules
             WHERE corpus_id = ? AND subsection_number = ? AND subsection_title IS NOT NULL LIMIT 1`,
          )
          .get(corpus.id, n) as { subsection_title: string } | undefined)?.subsection_title
      : undefined;

    const meta = app.db
      .prepare('SELECT title FROM rule_sections WHERE corpus_id = ? AND number = ?')
      .get(corpus.id, sectionNumber) as { title: string } | undefined;

    const kept = rules.filter((r) => r.text !== '');
    return {
      number: n,
      title: subsectionTitle ?? meta?.title ?? n,
      rules: kept,
      chars: kept.reduce((acc, r) => acc + r.number.length + r.text.length + 2, 0),
    };
  });
}
