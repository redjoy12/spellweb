import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, DB_PATH } from '../src/db/client.js';
import { assemblePacket, isCovered } from '../src/rules/packet.js';

// `describe.skip` still RUNS its factory to collect children, so `openDb` must not be
// called at that level: it would create data/app.db as a side effect, and the *next*
// `vitest run` would see the file, un-skip this block, and fail against an empty
// database. Gate on a non-empty file, and open only inside beforeAll.
const hasDb = existsSync(DB_PATH) && statSync(DB_PATH).size > 0;
const maybe = hasDb ? describe : describe.skip;

maybe('phase 1 gate (local database)', () => {
  let db: DatabaseSync;
  beforeAll(() => { db = openDb(DB_PATH); });

  it('has a non-trivial pool', () => {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM cards WHERE rotated = 0').get() as any).n;
    expect(n).toBeGreaterThan(1000);
  });

  it('gives every pool card at least one face', () => {
    const orphans = (db.prepare(
      `SELECT COUNT(*) AS n FROM cards c
       WHERE c.rotated = 0 AND NOT EXISTS (SELECT 1 FROM card_faces f WHERE f.oracle_id = c.oracle_id)`,
    ).get() as any).n;
    expect(orphans).toBe(0);
  });

  it('keeps the FTS index in step with the pool', () => {
    const cards = (db.prepare('SELECT COUNT(*) AS n FROM cards').get() as any).n;
    const fts = (db.prepare('SELECT COUNT(*) AS n FROM cards_fts').get() as any).n;
    expect(fts).toBe(cards);
  });

  it('resolves every pool keyword into a named bucket', () => {
    const corpus = db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as any;
    expect(corpus, 'run `npm run sync:rules`').toBeDefined();
    const rows = db.prepare('SELECT keywords FROM cards WHERE rotated = 0').all() as any[];
    const pool = new Set<string>();
    for (const r of rows) for (const k of JSON.parse(r.keywords)) pool.add(k.trim().toLowerCase());
    const mapped = new Set(
      (db.prepare('SELECT keyword_key FROM keyword_rule_map WHERE corpus_id = ?').all(corpus.id) as any[])
        .map((r) => r.keyword_key),
    );
    const missing = [...pool].filter((k) => !mapped.has(k));
    expect(missing, `unmapped pool keywords: ${missing.join(', ')}`).toEqual([]);
  });

  it('assembles a clean packet for a sample of cards', () => {
    const sample = db.prepare(
      'SELECT oracle_id FROM cards WHERE rotated = 0 ORDER BY oracle_id LIMIT 50',
    ).all() as any[];
    for (const { oracle_id } of sample) {
      const p = assemblePacket(db, oracle_id);
      expect(p.missingRules, `card ${oracle_id}`).toEqual([]);
      expect(p.unmappedLayouts, `card ${oracle_id}`).toEqual([]);
      // The core is the derived kernel now, not Phase 1's 385,012-char section list.
      expect(p.coreChars).toBeGreaterThan(0);
      expect(p.coreChars).toBeLessThan(300000);
    }
  });

  it('handles every layout present in the pool', () => {
    // One card per distinct layout, so transform/adventure/saga/class/case/prepare/
    // split/modal_dfc/meld are all exercised rather than whatever the first 50 happen to be.
    const perLayout = db.prepare(
      'SELECT layout, MIN(oracle_id) AS oracle_id FROM cards WHERE rotated = 0 GROUP BY layout',
    ).all() as any[];
    expect(perLayout.length).toBeGreaterThan(1);
    for (const { layout, oracle_id } of perLayout) {
      const p = assemblePacket(db, oracle_id);
      expect(p.unmappedLayouts, `layout ${layout} has no usable alias`).toEqual([]);
    }
  });

  it('resolves Class cards to the Class rules, not Attraction', () => {
    // Regression for the config error this plan shipped in an earlier draft.
    const row = db.prepare(
      "SELECT oracle_id FROM cards WHERE rotated = 0 AND layout = 'class' LIMIT 1",
    ).get() as any;
    if (!row) return;                                   // no Class cards in this Standard
    const numbers = assemblePacket(db, row.oracle_id).cardSpecific.map((s) => s.number);
    expect(numbers).toContain('716');
    expect(numbers).not.toContain('717');
  });

  it('adds no card-specific section that the kernel already contains', () => {
    const sample = db.prepare(
      'SELECT oracle_id FROM cards WHERE rotated = 0 ORDER BY oracle_id LIMIT 200',
    ).all() as any[];
    for (const { oracle_id } of sample) {
      const p = assemblePacket(db, oracle_id);
      const kernel = new Set(p.core.map((s) => s.number));
      for (const s of p.cardSpecific) {
        expect(isCovered(kernel, s.number), `card ${oracle_id}: ${s.number}`).toBe(false);
      }
    }
  });

  it('never deletes a rotated card', () => {
    const rotatedInDiffs = db.prepare(
      "SELECT DISTINCT oracle_id FROM pool_diff_entries WHERE change = 'rotated'",
    ).all() as any[];
    for (const { oracle_id } of rotatedInDiffs) {
      const row = db.prepare('SELECT oracle_id FROM cards WHERE oracle_id = ?').get(oracle_id);
      expect(row, `rotated card ${oracle_id} was deleted`).toBeDefined();
    }
  });
});
