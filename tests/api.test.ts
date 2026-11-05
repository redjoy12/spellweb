import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db/client.js';
import { buildServer } from '../src/server/app.js';
import { parseComprehensiveRules } from '../src/rules/parse.js';
import { buildKeywordMap, persistCorpus } from '../src/rules/lookup.js';
import { buildTypeRuleMap } from '../src/rules/typemap.js';
import { toFtsQuery } from '../src/server/routes/cards.js';
import { buildCardRequest } from '../src/atoms/extract.js';
import { persistAtomSchema } from '../src/atoms/schema.js';
import { loadPacketPolicy } from '../src/rules/relevance.js';

let app: FastifyInstance;

beforeAll(() => {
  const db = openDb(':memory:');
  const corpus = parseComprehensiveRules(readFileSync('tests/fixtures/cr.sample.txt', 'utf8'));
  const corpusId = persistCorpus(db, {
    sourceUri: 'u', sha256: 'e'.repeat(64), corpus,
    keywordMap: buildKeywordMap(corpus, ['Deathtouch', 'Fakewalk'], new Set()),
    typeMap: buildTypeRuleMap(corpus),
  });
  // A one-rule packet kernel, so the packet route has a core to send and to omit.
  db.prepare(
    "INSERT INTO packet_kernel (corpus_id, rule_number, origin, evidence) VALUES (?, '100.1a', 'golden_citation', 'test')",
  ).run(corpusId);

  // buildCardRequest stamps the request with the schema version, so the packet test can
  // compare the route against the real extraction request only once one exists.
  persistAtomSchema(db, {
    schema_version: 1,
    types: [{ family: 'PRODUCES', type_key: 'CARD_DRAW', label: 'x',
      params_schema: { type: 'object', properties: {}, additionalProperties: false },
      provenance: 'spec_4_1', evidence: 'test' }],
  });

  db.prepare(
    `INSERT INTO snapshots (source_type, source_uri, source_updated_at, ingested_at, status, cards_kept)
     VALUES ('t','u','t',datetime('now'),'complete',2)`,
  ).run();

  const insCard = db.prepare(
    `INSERT INTO cards (oracle_id,name,layout,mana_cost,cmc,type_line,oracle_text,colors,
       color_identity,keywords,power,toughness,rarity,set_code,collector_number,image_normal,
       oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id,rotated)
     VALUES (?,?,'normal',?,?,?,?,?,?,?,?,?,?,'aaa','1','https://img/n.jpg','h',1,1,?)`,
  );
  const insFace = db.prepare(
    `INSERT INTO card_faces (oracle_id,face_index,name,mana_cost,type_line,oracle_text,
       power,toughness,colors,image_normal) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const insFts = db.prepare(
    'INSERT INTO cards_fts (oracle_id,name,type_line,oracle_text) VALUES (?,?,?,?)',
  );

  insCard.run('deadly', 'Deadly Snake', '{1}{B}', 2, 'Creature — Snake',
    'Deathtouch', '["B"]', '["B"]', '["Deathtouch"]', '1', '1', 'common', 0);
  insFace.run('deadly', 0, 'Deadly Snake', '{1}{B}', 'Creature — Snake', 'Deathtouch', '1', '1', '["B"]', null);
  insFts.run('deadly', 'Deadly Snake', 'Creature — Snake', 'Deathtouch');

  insCard.run('gone', 'Rotated Relic', '{2}', 2, 'Artifact', 'Old text', '[]', '[]', '[]',
    null, null, 'rare', 1);
  insFace.run('gone', 0, 'Rotated Relic', '{2}', 'Artifact', 'Old text', null, null, '[]', null);
  insFts.run('gone', 'Rotated Relic', 'Artifact', 'Old text');

  app = buildServer(db);
});

describe('GET /api/cards', () => {
  it('excludes rotated cards by default', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/cards' });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.total).toBe(1);
    expect(b.items[0].name).toBe('Deadly Snake');
  });

  it('includes rotated cards on request and flags them', async () => {
    const b = (await app.inject({ method: 'GET', url: '/api/cards?includeRotated=true' })).json();
    expect(b.total).toBe(2);
    expect(b.items.find((c: any) => c.oracle_id === 'gone').rotated).toBe(1);
  });

  it('full-text searches oracle text', async () => {
    const b = (await app.inject({ method: 'GET', url: '/api/cards?q=deathtouch' })).json();
    expect(b.total).toBe(1);
    expect(b.items[0].oracle_id).toBe('deadly');
  });

  it('survives FTS-hostile input without a 500', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/cards?q=' + encodeURIComponent('"unclosed AND (') });
    expect(r.statusCode).toBe(200);
    expect(r.json().total).toBe(0);
  });

  it('filters by colour identity and cmc', async () => {
    const b = (await app.inject({ method: 'GET', url: '/api/cards?colors=B&cmcMax=2' })).json();
    expect(b.total).toBe(1);
    const none = (await app.inject({ method: 'GET', url: '/api/cards?colors=U' })).json();
    expect(none.total).toBe(0);
  });
});

describe('GET /api/cards/:oracleId', () => {
  it('returns the card with its faces', async () => {
    const b = (await app.inject({ method: 'GET', url: '/api/cards/deadly' })).json();
    expect(b.card.name).toBe('Deadly Snake');
    expect(b.faces).toHaveLength(1);
    expect(b.card.keywords).toEqual(['Deathtouch']);
  });

  it('404s for an unknown oracle id', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/cards/nope' })).statusCode).toBe(404);
  });
});

describe('GET /api/cards/:oracleId/packet', () => {
  it('returns the scoped packet extraction sends, split exactly as buildCardRequest splits it', async () => {
    const b = (await app.inject({ method: 'GET', url: '/api/cards/deadly/packet' })).json();
    const req = buildCardRequest(app.db, 'deadly', loadPacketPolicy());

    expect(b.core).toEqual(req.kernelSections);
    expect(b.cardSpecific).toEqual(req.cardSections);
    expect(b.glossary.map((g: any) => `${g.term}: ${g.definition}`)).toEqual(req.glossary);
    expect(b.packetRules).toEqual(req.packetRules);
    expect(b.packetChars).toBe(req.packetChars);

    // Concretely: the kernel row, the keyword's section, and the whitelist covering both.
    expect(b.core.map((s: any) => s.number)).toEqual(['100.1a']);
    expect(b.cardSpecific.map((s: any) => s.number)).toContain('702.2');
    expect(b.packetRules).toEqual(expect.arrayContaining(['100.1a', '702.2']));
    expect(b.coreChars + b.cardChars + b.glossaryChars).toBe(b.packetChars);
    expect(b.coreOmitted).toBe(false);
  });

  it('omits core rule bodies on ?core=false while keeping size counters and the whitelist', async () => {
    const full = (await app.inject({ method: 'GET', url: '/api/cards/deadly/packet' })).json();
    const b = (await app.inject({ method: 'GET', url: '/api/cards/deadly/packet?core=false' })).json();
    expect(b.coreOmitted).toBe(true);
    expect(b.core.length).toBeGreaterThan(0);
    for (const section of b.core) {
      expect(section.rules).toEqual([]);
    }
    expect(b.coreChars).toBe(full.coreChars);
    expect(b.packetRules).toEqual(full.packetRules);
  });

  it('404s for an unknown oracle id', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/cards/nope/packet' })).statusCode).toBe(404);
  });
});

describe('GET /api/pool/status and /api/rules/keywords', () => {
  it('reports pool, rotated and corpus counts', async () => {
    const b = (await app.inject({ method: 'GET', url: '/api/pool/status' })).json();
    expect(b.pool).toBe(1);
    expect(b.rotated).toBe(1);
    expect(b.corpus.effective_date).toBe('2026-06-19');
  });

  it('reports keyword resolution buckets', async () => {
    const b = (await app.inject({ method: 'GET', url: '/api/rules/keywords' })).json();
    expect(b.counts.subsection_title).toBe(1);
    expect(b.counts.unresolved).toBe(1);
  });
});

describe('GET /api/rules/sections/:number', () => {
  it('serves a three-digit section', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/rules/sections/702' });
    expect(r.statusCode).toBe(200);
    expect(r.json().title).toBe('Keyword Abilities');
    expect(r.json().chars).toBeGreaterThan(0);
  });

  it('serves a top-level section by gathering its child sections', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/rules/sections/7' });
    expect(r.statusCode).toBe(200);
    expect(r.json().rules.length).toBeGreaterThan(0);
  });

  it('titles a subsection with its own name, not its section name', async () => {
    const b = (await app.inject({ method: 'GET', url: '/api/rules/sections/702.2' })).json();
    expect(b.title).toBe('Deathtouch');
  });

  it('404s for a number with no rules', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/rules/sections/999' })).statusCode).toBe(404);
  });
});

describe('toFtsQuery FTS-safety invariant', () => {
  // The route's catch-block backstop (see cards.ts) is only safe because toFtsQuery
  // can never emit a string that is itself an FTS5 MATCH syntax error. This locks
  // that precondition against arbitrary/adversarial input so a future edit to
  // toFtsQuery can't silently reopen the 500 the backstop exists to prevent.
  const adversarial = [
    '"',
    '(',
    'NEAR/2',
    'col:foo',
    "'''",
    'AND OR NOT',
    'x'.repeat(5000),
    'lightning bolt',
  ];

  it('never produces a query that throws against a real cards_fts MATCH, for adversarial or normal input', () => {
    const db = openDb(':memory:');
    db.prepare(
      "INSERT INTO cards_fts (oracle_id,name,type_line,oracle_text) VALUES ('a','Deadly Snake','Creature — Snake','Deathtouch')",
    ).run();
    const stmt = db.prepare('SELECT oracle_id FROM cards_fts WHERE cards_fts MATCH ?');

    for (const raw of adversarial) {
      const fts = toFtsQuery(raw);
      if (fts === '') continue;
      expect(() => stmt.all(fts)).not.toThrow();
    }

    // Empty/punctuation-only input must hit the route's empty-sentinel short-circuit
    // rather than ever reaching MATCH at all.
    expect(toFtsQuery('')).toBe('');
    expect(toFtsQuery('   ')).toBe('');
    expect(toFtsQuery('!!!')).toBe('');
    expect(toFtsQuery('???')).toBe('');
  });
});
