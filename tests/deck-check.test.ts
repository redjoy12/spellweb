import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, openDb } from '../src/db/client.js';
import type { DeckCard, SpellSlot } from '../src/deck/assemble.js';
import { checkLegal, deckWarnings, LegalityError } from '../src/deck/check.js';
import { makeDeck, newestBuild, scopePairTable, type MadeDeck } from '../src/deck/deck.js';
import { GoalError, type Goal } from '../src/deck/goal.js';
import type { BuiltCards } from '../src/deck/manaBase.js';
import type { PairTable } from '../src/deck/pairs.js';
import { loadDeckPolicy } from '../src/deck/policy.js';
import { BuildIndex } from '../src/graph/buildIndex.js';
import { maybe } from './helpers/realDb.js';

const policy = loadDeckPolicy();
const goal: Goal = { colours: 'B', seeds: ['a'], excluded: [], target_turn: 6, interaction: 'none', min_creatures: 0, use_rate: false, pinned: [], excluded_tags: [] };

function poolDb(): DatabaseSync {
  const d = openDb(':memory:');
  d.exec("INSERT INTO snapshots (source_type,source_uri,source_updated_at,ingested_at,status) VALUES ('t','u','t','t','complete')");
  const add = d.prepare(`INSERT INTO cards (oracle_id,name,layout,cmc,type_line,colors,color_identity,keywords,rarity,arena_id,set_code,collector_number,oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id,rotated)
    VALUES (?,?,'normal',2,?,'[]',?,'[]','c',?,'s','1','h',1,1,?)`);
  add.run('a', 'Card A', 'Sorcery', '["B"]', 1, 0);
  add.run('red', 'Red Card', 'Sorcery', '["R"]', 2, 0);
  add.run('old', 'Old Card', 'Sorcery', '["B"]', 3, 1);
  add.run('off', 'Off Card', 'Sorcery', '["B"]', null, 0);
  add.run('swamp', 'Swamp', 'Basic Land — Swamp', '["B"]', 4, 0);
  add.run('dual', 'Some Land', 'Land', '["B"]', 5, 0);
  return d;
}

const spell = (id: string, copies: number): SpellSlot => ({ oracle_id: id, copies, role: 'link', fit: 0 });
const built = (spells: SpellSlot[], lands: Array<[string, number]>, over: Partial<BuiltCards> = {}): BuiltCards => ({
  spells, loops: 1, stable: true,
  mana: { land_count: lands.reduce((s, l) => s + l[1], 0), turn: 3, needs: { B: 0, R: 0 }, sources: { B: 0, R: 0 }, short: false,
    lands: lands.map(([oracle_id, copies]) => ({ oracle_id, copies, kind: 'basic' as const })) },
  ...over,
});

describe('checkLegal (design sec. 8)', () => {
  const db = poolDb();
  const bad = (d: BuiltCards, text: RegExp) => {
    expect(() => checkLegal(db, d, goal, policy)).toThrow(LegalityError);
    expect(() => checkLegal(db, d, goal, policy)).toThrow(text);
  };
  it('accepts 60 cards, and a basic land has no copy limit', () => {
    expect(() => checkLegal(db, built([spell('a', 4)], [['swamp', 56]]), goal, policy)).not.toThrow();
  });
  it('refuses a deck that is not exactly 60 cards', () => {
    bad(built([spell('a', 4)], [['swamp', 55]]), /59 cards/);
    bad(built([spell('a', 4)], [['swamp', 57]]), /61 cards/);
  });
  it('refuses more than 4 copies of a card that is not a basic land', () => {
    bad(built([spell('a', 5)], [['swamp', 55]]), /5 copies of Card A/);
    bad(built([spell('a', 4)], [['swamp', 51], ['dual', 5]]), /5 copies of Some Land/);
  });
  it('refuses a colour outside the form', () => {
    bad(built([spell('red', 4)], [['swamp', 56]]), /Red Card is outside the colours B/);
  });
  it('refuses a card that is not in the pool, rotated, or not on Arena', () => {
    bad(built([spell('nothing', 4)], [['swamp', 56]]), /no card with ID nothing/);
    bad(built([spell('old', 4)], [['swamp', 56]]), /Old Card is rotated/);
    bad(built([spell('off', 4)], [['swamp', 56]]), /Off Card is not on Arena/);
  });
});

describe('deckWarnings (design sec. 8)', () => {
  const card = (id: string, over: Partial<DeckCard> = {}): DeckCard => ({
    oracle_id: id, name: `Card ${id}`, type_line: 'Sorcery', cmc: 2, costs: [], identity: ['B'], arena_id: 1,
    land: false, creature: false, legendary: false, interaction: false, tags: [], ...over,
  });
  const cards = new Map([card('a', { creature: true }), card('b', { interaction: true }), card('c')].map((c) => [c.oracle_id, c]));
  const table = (over: Partial<PairTable> = {}): PairTable => ({ buildId: null, pos: new Map(), anti: new Map(), linked: new Map(), ...over });
  const linked = new Map([['a', new Set(['b'])], ['b', new Set(['a'])]]);

  it('a deck with links, met quotas and met needs has no warning', () => {
    const d = built([spell('a', 4), spell('b', 4)], [], { });
    expect(deckWarnings(d, cards, { ...goal, min_creatures: 4, interaction: 'none' }, table({ linked }), policy)).toEqual([]);
  });
  it('a quota that is not met gives a warning with the counts', () => {
    const d = built([spell('a', 4), spell('b', 4)], []);
    const w = deckWarnings(d, cards, { ...goal, min_creatures: 14, interaction: 'heavy' }, table({ linked }), policy);
    expect(w.map((x) => x.text)).toEqual([
      `The deck has 4 interaction cards, and the goal asks for ${policy.quotas.interaction.heavy}.`,
      'The deck has 4 creature cards, and the goal asks for 14.',
    ]);
  });
  it('a colour need that is not met gives a warning', () => {
    const d = built([spell('a', 4), spell('b', 4)], []);
    d.mana.needs = { B: 12, R: 0 };
    d.mana.sources = { B: 11, R: 0 };
    d.mana.short = true;
    expect(deckWarnings(d, cards, goal, table({ linked }), policy)[0]).toMatchObject({ kind: 'mana', text: 'Colour B has 11 sources, and the spells need 12.' });
  });
  it('a spell with no link to the deck gives a warning with the card name', () => {
    const d = built([spell('a', 4), spell('b', 4), spell('c', 4)], []);
    expect(deckWarnings(d, cards, goal, table({ linked }), policy)).toEqual([{ kind: 'no_link', text: 'Card c has no link to the deck.', cards: ['c'] }]);
  });
  it('a - link inside the deck gives one warning with the two cards', () => {
    const d = built([spell('a', 4), spell('b', 4)], []);
    const link = { supply: 'a', demand: 'b', weight: 1, key: 'k', grade: 'confirmed' as const, rule_hashes: [], atom_ids: [], demand_atom_id: 0 };
    const anti = new Map([['a', new Map([['b', link]])], ['b', new Map([['a', link]])]]);
    expect(deckWarnings(d, cards, goal, table({ linked, anti }), policy)).toEqual([
      { kind: 'anti_link', text: 'Card a and Card b have a "bad together" link.', cards: ['a', 'b'] },
    ]);
  });
  it('a land count that is not stable gives a mana warning', () => {
    const d = built([spell('a', 4), spell('b', 4)], [], { stable: false, loops: 3 });
    expect(deckWarnings(d, cards, goal, table({ linked }), policy)[0]!.kind).toBe('mana');
  });
});

// On a VACUUM INTO copy (plan Task 5). The cards come from the database by query, never from memory.
maybe('three decks on a copy of the real database (plan Task 5)', () => {
  let dir = '';
  let db: DatabaseSync;
  let idx: BuildIndex;
  let table: PairTable;
  let seeds: string[] = [];
  let decks: MadeDeck[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'deck-check-'));
    const file = join(dir, 'app.db');
    const src = new DatabaseSync(DB_PATH, { readOnly: true });
    // VACUUM INTO, not a file copy: app.db is WAL, and a copy can be stale.
    try { src.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); } finally { src.close(); }
    db = openDb(file);
    const buildId = newestBuild(db);
    idx = BuildIndex.load(db, buildId);
    table = scopePairTable(db, idx);
    seeds = (db.prepare(
      `SELECT c.oracle_id FROM card_degree d JOIN cards c USING (oracle_id)
        WHERE d.build_id = ? AND c.rotated = 0 AND c.arena_id IS NOT NULL AND c.cmc BETWEEN 1 AND 4 AND c.type_line NOT LIKE '%Land%'
        ORDER BY d.out_degree + d.in_degree DESC, c.oracle_id LIMIT 200`,
    ).all(buildId) as Array<{ oracle_id: string }>).map((r) => r.oracle_id).filter((_, i) => i % 60 === 0).slice(0, 3);
    decks = seeds.map((s) => makeDeck(db, idx, table, { colours: 'BR', seeds: [s], target_turn: 6, interaction: 'some' }, policy));
  }, 600_000);

  afterAll(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('3 seeds give 3 legal decks of exactly 60 cards', () => {
    expect(new Set(seeds).size).toBe(3);
    for (const [i, d] of decks.entries()) {
      expect(() => checkLegal(db, d, d.goal, policy)).not.toThrow();
      expect([...d.spells, ...d.mana.lands].reduce((s, x) => s + x.copies, 0)).toBe(60);
      const seed = d.spells.find((s) => s.oracle_id === seeds[i])!;
      expect(seed.role).toBe('seed');
      expect(seed.copies).toBeGreaterThanOrEqual(1);
      expect(d.mana.land_count).toBeGreaterThanOrEqual(20);
      expect(d.mana.land_count).toBeLessThanOrEqual(26);
    }
  });
  it('a goal with no seed gives a legal deck of exactly 60 cards', () => {
    const d = makeDeck(db, idx, table, { colours: 'BR', target_turn: 6, interaction: 'some' }, policy);
    expect(() => checkLegal(db, d, d.goal, policy)).not.toThrow();
    expect([...d.spells, ...d.mana.lands].reduce((s, x) => s + x.copies, 0)).toBe(60);
    expect(d.spells.every((s) => s.role !== 'seed')).toBe(true);
  });
  it('the same goal gives the same deck', () => {
    const again = makeDeck(db, idx, table, decks[0]!.goal, policy);
    expect({ spells: again.spells, mana: again.mana, warnings: again.warnings })
      .toEqual({ spells: decks[0]!.spells, mana: decks[0]!.mana, warnings: decks[0]!.warnings });
  });
  it('an excluded card does not enter, and a land in the pool is not a spell', () => {
    const d = decks[0]!;
    const out = d.spells.find((s) => s.role !== 'seed')!.oracle_id;
    const again = makeDeck(db, idx, table, { ...d.goal, excluded: [out] }, policy);
    expect(again.spells.map((s) => s.oracle_id)).not.toContain(out);
    expect(again.spells.every((s) => !again.cards.get(s.oracle_id)!.land)).toBe(true);
  });
  it('a bad goal gives a GoalError and no deck', () => {
    expect(() => makeDeck(db, idx, table, { colours: 'BR', seeds: ['nothing'], target_turn: 6, interaction: 'some' }, policy)).toThrow(GoalError);
  });
  it('colours outside the build scope give a GoalError', () => {
    const narrow = Object.assign(Object.create(idx) as BuildIndex, { build: { ...idx.build!, scope: 'B' as const } });
    const mono = (db.prepare(`SELECT oracle_id FROM cards WHERE rotated = 0 AND arena_id IS NOT NULL AND color_identity = '["R"]' AND type_line NOT LIKE '%Land%' ORDER BY oracle_id LIMIT 1`)
      .get() as { oracle_id: string }).oracle_id;
    expect(() => makeDeck(db, narrow, table, { colours: 'R', seeds: [mono], target_turn: 6, interaction: 'some' }, policy)).toThrow(/outside the build scope B/);
  });
});
