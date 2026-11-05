import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/client.js';
import { buildServer } from '../src/server/app.js';

const db = openDb();

// These tests run against the live dev DB, which extraction batches keep filling.
// Every fixture is a card with no current atoms — the same is_current + oracle_hash
// guard the route applies — so the zero-atom / null-coverage assertions keep
// holding as more of the pool gets extracted.
const NOT_EXTRACTED = `NOT EXISTS (
  SELECT 1 FROM atoms a
   WHERE a.oracle_id = c.oracle_id AND a.is_current = 1 AND a.oracle_hash = c.oracle_hash)`;

const card = db.prepare(
  `SELECT c.oracle_id FROM cards c WHERE ${NOT_EXTRACTED} LIMIT 1`,
).get() as { oracle_id: string } | undefined;
const maybe = card ? describe : describe.skip;

// Edge-case fixtures. Both are present in the live pool (~20 empty-oracle_text faces
// across 4,702 cards; 296 non-normal layouts, of which 222+ have >=2 card_faces rows),
// but queried defensively so the file still loads on a minimal test DB.
const emptyFaceCard = db.prepare(
  `SELECT cf.oracle_id FROM card_faces cf
    JOIN cards c ON c.oracle_id = cf.oracle_id
    WHERE cf.oracle_text = '' AND ${NOT_EXTRACTED} LIMIT 1`,
).get() as { oracle_id: string } | undefined;

const twoFaceCard = db.prepare(
  `SELECT c.oracle_id FROM cards c
    JOIN card_faces cf ON cf.oracle_id = c.oracle_id
    WHERE ${NOT_EXTRACTED}
    GROUP BY c.oracle_id HAVING COUNT(cf.face_index) >= 2 LIMIT 1`,
).get() as { oracle_id: string } | undefined;

maybe('GET /api/cards/:id/atoms', () => {
  const app = buildServer(db);

  it('returns faces and clauses even when no atoms exist yet', async () => {
    const res = await app.inject({ url: `/api/cards/${card!.oracle_id}/atoms` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.faces)).toBe(true);
    expect(body.faces.length).toBeGreaterThan(0);
    for (const f of body.faces) {
      expect(Array.isArray(f.clauses)).toBe(true);
      expect(Array.isArray(f.atoms)).toBe(true);   // empty, not undefined
      expect(f.atoms.length).toBe(0);              // zero-atom state: the load-bearing case
      expect(Array.isArray(f.unclassified)).toBe(true);
      expect(Array.isArray(f.missingRules)).toBe(true);
    }
  });

  it('reports null coverage when the card has never been extracted', async () => {
    // TODO(Task 9): add a test asserting coverage !== null when a current atom seeded
    // with matching oracle_hash exists; deferred because Task 9 owns coverage computation.
    const res = await app.inject({ url: `/api/cards/${card!.oracle_id}/atoms` });
    expect(res.json().coverage).toBeNull();
  });

  // Step 5's "can't visual-verify" substitute: confirm on-the-fly clauses have
  // real spans that slice back to their text — so AtomSpans can render them.
  it('splits clauses on the fly with spans that slice back to their text', async () => {
    const res = await app.inject({ url: `/api/cards/${card!.oracle_id}/atoms` });
    const { faces } = res.json();
    let checkedClauses = 0;
    for (const f of faces) {
      for (const c of f.clauses) {
        expect(f.oracle_text.slice(c.span_start, c.span_end)).toBe(c.text);
        checkedClauses++;
      }
    }
    // The pool is real MTG oracle text; every card with text yields >=1 clause.
    expect(checkedClauses).toBeGreaterThan(0);
  });

  it('404s for an unknown card', async () => {
    const res = await app.inject({ url: '/api/cards/does-not-exist/atoms' });
    expect(res.statusCode).toBe(404);
  });
});

// Empty-oracle_text face (~20 in the pool): the route returns clauses:[],
// spans slice back trivially, and AtomSpans renders nothing for the face.
(emptyFaceCard ? describe : describe.skip)('empty-oracle_text face', () => {
  const app = buildServer(db);

  it('yields clauses: [] for the empty face without a slice-back error', async () => {
    const res = await app.inject({ url: `/api/cards/${emptyFaceCard!.oracle_id}/atoms` });
    expect(res.statusCode).toBe(200);
    const { faces } = res.json();
    const emptyFace = faces.find((f: any) => f.oracle_text === '');
    expect(emptyFace).toBeDefined();
    expect(Array.isArray(emptyFace.clauses)).toBe(true);
    expect(emptyFace.clauses).toEqual([]);
    // Coverage is null because no atoms exist; the slice-back loop below is a no-op.
    expect(res.json().coverage).toBeNull();
  });
});

// Multi-face card (transform / modal_dfc / adventure / etc.): asserts per-face clause
// arrays are returned and that spans on each face slice back to that face's own text.
(twoFaceCard ? describe : describe.skip)('two-face card', () => {
  const app = buildServer(db);

  it('returns exactly two faces, each with its own per-face clauses', async () => {
    const res = await app.inject({ url: `/api/cards/${twoFaceCard!.oracle_id}/atoms` });
    expect(res.statusCode).toBe(200);
    const { faces, coverage } = res.json();
    expect(faces.length).toBe(2);
    for (const f of faces) {
      expect(Array.isArray(f.clauses)).toBe(true);
      for (const c of f.clauses) {
        expect(f.oracle_text.slice(c.span_start, c.span_end)).toBe(c.text);
      }
    }
    expect(coverage).toBeNull();
  });
});