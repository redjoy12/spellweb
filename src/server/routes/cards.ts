import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assembleScopedPacket } from '../../rules/packet.js';
import { loadPacketPolicy } from '../../rules/relevance.js';
import { packetParts } from '../../atoms/extract.js';

const QuerySchema = z.object({
  q: z.string().optional(),
  colors: z.string().optional(),          // comma-separated WUBRG
  types: z.string().optional(),           // comma-separated type-line substrings
  cmcMin: z.coerce.number().optional(),
  cmcMax: z.coerce.number().optional(),
  rarity: z.string().optional(),
  includeRotated: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().min(1).max(200).default(60),
  offset: z.coerce.number().min(0).default(0),
});

/** FTS5 treats bare punctuation as syntax; quote each term so user input can never be a syntax error. */
export function toFtsQuery(raw: string): string {
  const terms = raw.match(/[\p{L}\p{N}']+/gu) ?? [];
  if (terms.length === 0) return '';
  return terms.map((t) => `"${t}"*`).join(' AND ');
}

function parseCard(row: any) {
  return {
    ...row,
    colors: JSON.parse(row.colors),
    color_identity: JSON.parse(row.color_identity),
    keywords: JSON.parse(row.keywords),
  };
}

export async function cardRoutes(app: FastifyInstance) {
  app.get('/api/cards', async (req, reply) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const p = parsed.data;

    const where: string[] = [];
    // Typed, not `unknown[]`: node:sqlite's .all()/.get() take SQLInputValue, and an
    // `unknown[]` spread is a compile error under `strict` (TS2345).
    const params: Array<string | number | null> = [];

    if (p.includeRotated !== 'true') where.push('c.rotated = 0');

    if (p.q && p.q.trim()) {
      const fts = toFtsQuery(p.q);
      if (fts === '') {
        return { total: 0, items: [] };
      }
      where.push('c.oracle_id IN (SELECT oracle_id FROM cards_fts WHERE cards_fts MATCH ?)');
      params.push(fts);
    }

    for (const colour of (p.colors ?? '').split(',').filter(Boolean)) {
      where.push("EXISTS (SELECT 1 FROM json_each(c.color_identity) WHERE json_each.value = ?)");
      params.push(colour.toUpperCase());
    }

    const types = (p.types ?? '').split(',').filter(Boolean);
    if (types.length > 0) {
      where.push(`(${types.map(() => 'c.type_line LIKE ?').join(' OR ')})`);
      for (const t of types) params.push(`%${t}%`);
    }

    if (p.cmcMin !== undefined) { where.push('c.cmc >= ?'); params.push(p.cmcMin); }
    if (p.cmcMax !== undefined) { where.push('c.cmc <= ?'); params.push(p.cmcMax); }
    if (p.rarity) { where.push('c.rarity = ?'); params.push(p.rarity); }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let total: number;
    let rows: unknown[];
    try {
      total = (app.db.prepare(`SELECT COUNT(*) AS n FROM cards c ${clause}`).get(...params) as any).n;
      rows = app.db
        .prepare(
          `SELECT c.oracle_id, c.name, c.mana_cost, c.cmc, c.type_line, c.colors,
                  c.color_identity, c.keywords, c.rarity, c.image_normal, c.image_art_crop,
                  c.rotated, c.set_code, c.collector_number, c.arena_id
           FROM cards c ${clause} ORDER BY c.name LIMIT ? OFFSET ?`,
        )
        .all(...params, p.limit, p.offset);
    } catch (err) {
      // `toFtsQuery` quotes every term, so a genuine FTS syntax error should be
      // unreachable — but if one happens it is user input, not a server fault.
      // Anything else (a schema or migration bug) MUST NOT masquerade as
      // "0 cards found": that is the exact number the phase gate compares against
      // Scryfall, and swallowing it would turn a loud failure into a silent one.
      const message = (err as Error).message ?? '';
      if (!/fts5|MATCH/i.test(message)) throw err;
      req.log?.warn?.({ err }, 'FTS query rejected');
      return { total: 0, items: [] };
    }

    return { total, items: (rows as any[]).map(parseCard) };
  });

  app.get<{ Params: { oracleId: string } }>('/api/cards/:oracleId', async (req, reply) => {
    const card = app.db
      .prepare('SELECT * FROM cards WHERE oracle_id = ?')
      .get(req.params.oracleId) as any;
    if (!card) return reply.code(404).send({ error: 'card not found' });

    const faces = (
      app.db
        .prepare('SELECT * FROM card_faces WHERE oracle_id = ? ORDER BY face_index')
        .all(req.params.oracleId) as any[]
    ).map((f) => ({ ...f, colors: JSON.parse(f.colors) }));

    return { card: parseCard(card), faces };
  });

  // The pictures of one card for the hover zoom: both faces of a two-faced card, else its one picture.
  // `name` is a card name or a face name, for the pages that have no oracle id.
  app.get<{ Querystring: { id?: string; name?: string } }>('/api/card-images', async (req, reply) => {
    const { id, name } = req.query;
    if (!id && !name) return reply.code(400).send({ error: 'id or name is required' });
    const card = (id
      ? app.db.prepare('SELECT oracle_id, image_normal FROM cards WHERE oracle_id = ?').get(id)
      : app.db.prepare(
          `SELECT oracle_id, image_normal FROM cards WHERE oracle_id = COALESCE(
             (SELECT oracle_id FROM cards WHERE name = ?),
             (SELECT oracle_id FROM card_faces WHERE name = ?))`,
        ).get(name!, name!)) as { oracle_id: string; image_normal: string | null } | undefined;
    if (!card) return reply.code(404).send({ error: 'card not found' });

    const faces = (
      app.db
        .prepare('SELECT image_normal FROM card_faces WHERE oracle_id = ? AND image_normal IS NOT NULL ORDER BY face_index')
        .all(card.oracle_id) as Array<{ image_normal: string }>
    ).map((f) => f.image_normal);
    return { images: faces.length > 1 ? faces : card.image_normal ? [card.image_normal] : faces };
  });

  // The packet Phase 2 extraction actually sends for this card: assembleScopedPacket under
  // the packet policy, split by packetParts exactly as buildCardRequest splits it - kernel,
  // card-specific sections, matched glossary terms, and gate 4's rule-number whitelist.
  // `?core=false` omits the kernel bodies while keeping their size counters; the UI
  // collapses the kernel by default, so the card view should not ship it on every click.
  app.get<{ Params: { oracleId: string }; Querystring: { core?: string } }>(
    '/api/cards/:oracleId/packet',
    async (req, reply) => {
      const exists = app.db
        .prepare('SELECT 1 FROM cards WHERE oracle_id = ?')
        .get(req.params.oracleId);
      if (!exists) return reply.code(404).send({ error: 'card not found' });

      // Anything thrown past this point (no kernel for the corpus, a schema bug) is a
      // server fault, not "card not found" - let it surface as a 500.
      const packet = assembleScopedPacket(app.db, req.params.oracleId, loadPacketPolicy());
      const parts = packetParts(packet);
      const chars = (ss: Array<{ chars: number }>) => ss.reduce((n, x) => n + x.chars, 0);
      const omitCore = req.query.core === 'false';
      return {
        corpusId: packet.corpusId,
        effectiveDate: packet.effectiveDate,
        core: omitCore ? parts.kernelSections.map((s) => ({ ...s, rules: [] })) : parts.kernelSections,
        cardSpecific: parts.cardSections,
        glossary: parts.glossaryTerms.map((m) => ({
          term: m.term, surface: m.surface, source: m.source, definition: m.definition as string,
        })),
        packetRules: parts.packetRules,
        unresolvedKeywords: packet.unresolvedKeywords,
        missingRules: packet.missingKernelRules,
        coreChars: chars(parts.kernelSections),
        cardChars: chars(parts.cardSections),
        glossaryChars: packet.selectedChars - chars(packet.sections),
        packetChars: packet.selectedChars,
        coreOmitted: omitCore,
      };
    },
  );
}
