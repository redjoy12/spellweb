import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, openDb } from '../src/db/client.js';
import { makeDeck, newestBuild, scopePairTable } from '../src/deck/deck.js';
import { deckLinkKinds, justifyDeck, type DeckView } from '../src/deck/justify.js';
import { deckPolicySha, loadDeckPolicy } from '../src/deck/policy.js';
import { BuildIndex } from '../src/graph/buildIndex.js';
import { maybe } from './helpers/realDb.js';

const policy = loadDeckPolicy();

// On a VACUUM INTO copy (plan Task 6). The seed comes from the database by query, never from memory.
maybe('the reasons of a deck on a copy of the real database (plan Task 6)', () => {
  let dir = '';
  let db: DatabaseSync;
  let idx: BuildIndex;
  let view: DeckView;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'deck-justify-'));
    const file = join(dir, 'app.db');
    const src = new DatabaseSync(DB_PATH, { readOnly: true });
    try { src.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); } finally { src.close(); }
    db = openDb(file);
    const buildId = newestBuild(db);
    idx = BuildIndex.load(db, buildId);
    const table = scopePairTable(db, idx);
    const seed = (db.prepare(
      `SELECT c.oracle_id FROM card_degree d JOIN cards c USING (oracle_id)
        WHERE d.build_id = ? AND c.rotated = 0 AND c.arena_id IS NOT NULL AND c.cmc BETWEEN 1 AND 4 AND c.type_line NOT LIKE '%Land%'
        ORDER BY d.out_degree + d.in_degree DESC, c.oracle_id LIMIT 1`,
    ).get(buildId) as { oracle_id: string }).oracle_id;
    const deck = makeDeck(db, idx, table, { colours: 'BR', seeds: [seed], target_turn: 6, interaction: 'some' }, policy);
    view = justifyDeck(db, idx, table, deck, buildId, deckPolicySha(policy), policy);
    expect(deckLinkKinds(idx, table, deck.spells.map((s) => s.oracle_id)).length).toBeGreaterThan(0);
  }, 600_000);

  afterAll(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('each card has a role, and the copies make 60', () => {
    expect(view.cards.reduce((s, c) => s + c.copies, 0)).toBe(60);
    for (const c of view.cards) expect(['seed', 'quota', 'link', 'land']).toContain(c.role);
    expect(view.cards.filter((c) => c.role === 'land').reduce((s, c) => s + c.copies, 0)).toBe(view.mana.land_count);
  });
  it('each spell with deck links has its top links, at most 3, the highest weight first', () => {
    for (const c of view.cards.filter((x) => x.role !== 'land')) {
      expect(c.links.length).toBe(Math.min(3, c.deck_links));
      expect(new Set(c.links.map((l) => l.other)).size).toBe(c.links.length);
      for (let i = 1; i < c.links.length; i++) expect(c.links[i]!.weight).toBeLessThanOrEqual(c.links[i - 1]!.weight);
    }
  });
  it('each link has two quotes, a grade, a rule ID and a real edge key', () => {
    const links = view.cards.flatMap((c) => c.links.map((l) => ({ c, l })));
    expect(links.length).toBeGreaterThan(0);
    for (const { c, l } of links) {
      expect(l.supply_quote.length).toBeGreaterThan(0);
      expect(l.demand_quote.length).toBeGreaterThan(0);
      expect(['confirmed', 'plausible']).toContain(l.grade);
      expect(l.rule_ids.length).toBeGreaterThan(0);
      for (const r of l.rule_ids) expect(r).toMatch(/^ER-\d+$/);
      expect(view.cards.some((x) => x.oracle_id === l.other)).toBe(true);
      const e = idx.edgesForCard(c.oracle_id);
      expect([...e.out, ...e.in].some((x) => x.key === l.edge_key)).toBe(true);
    }
  });
  it('the import text has one line for each card, and each line has the card name', () => {
    const lines = view.export_text.split('\n');
    expect(lines[0]).toBe('Deck');
    expect(lines).toHaveLength(view.cards.length + 1);
    for (const [i, c] of view.cards.entries()) expect(lines[i + 1]!.startsWith(`${c.copies} ${c.name} (`)).toBe(true);
  });
  it('the deck view is plain JSON, so the deck row can hold it', () => {
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });
});
