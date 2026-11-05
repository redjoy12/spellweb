import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, openDb } from '../src/db/client.js';
import { buildServer } from '../src/server/app.js';
import type { DeckView } from '../src/deck/justify.js';
import { maybe } from './helpers/realDb.js';

// On a VACUUM INTO copy of data/app.db (plan Task 7). The seed comes from the database by query.
maybe('the deck routes on a copy of the real database (plan Task 7)', () => {
  let dir = '';
  let db: DatabaseSync;
  let app: ReturnType<typeof buildServer>;
  let seed = '';
  let id = 0;
  let deck: DeckView;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'api-decks-'));
    const file = join(dir, 'app.db');
    const src = new DatabaseSync(DB_PATH, { readOnly: true });
    // VACUUM INTO, not a file copy: app.db is WAL, and a copy can be stale.
    try { src.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); } finally { src.close(); }
    db = openDb(file);
    const b = (db.prepare('SELECT MAX(id) AS id FROM graph_builds').get() as { id: number }).id;
    seed = (db.prepare(
      `SELECT c.oracle_id FROM card_degree d JOIN cards c USING (oracle_id)
        WHERE d.build_id = ? AND c.rotated = 0 AND c.arena_id IS NOT NULL AND c.cmc BETWEEN 1 AND 4 AND c.type_line NOT LIKE '%Land%'
        ORDER BY d.out_degree + d.in_degree DESC, c.oracle_id LIMIT 1`,
    ).get(b) as { oracle_id: string }).oracle_id;
    app = buildServer(db);
    const r = await app.inject({ method: 'POST', url: '/api/decks', payload: { colours: 'BR', seeds: [seed], target_turn: 6, interaction: 'some' } });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { id: number; deck: DeckView };
    id = body.id;
    deck = body.deck;
  }, 600_000);

  afterAll(async () => {
    await app?.close();
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('POST stores the deck with its build, goal and policy SHA', () => {
    const row = db.prepare('SELECT build_id, goal_json, policy_sha FROM decks WHERE id = ?').get(id) as { build_id: number; goal_json: string; policy_sha: string };
    expect(row.build_id).toBe(deck.build_id);
    expect(JSON.parse(row.goal_json)).toEqual(deck.goal);
    expect(row.policy_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(deck.goal.min_creatures).toBe(14);
    expect(deck.cards.reduce((s, c) => s + c.copies, 0)).toBe(60);
  });
  it('GET /api/decks lists the deck, the newest first', async () => {
    const r = (await app.inject({ url: '/api/decks' })).json() as { decks: Array<{ id: number; seeds: string[]; colours: string; land_count: number }> };
    expect(r.decks[0]).toMatchObject({ id, colours: 'BR', land_count: deck.mana.land_count });
    expect(r.decks[0]!.seeds).toEqual(deck.cards.filter((c) => c.role === 'seed').map((c) => c.name));
  });
  it('GET /api/decks/:id gives the stored deck', async () => {
    const r = await app.inject({ url: `/api/decks/${id}` });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { deck: DeckView }).deck).toEqual(deck);
  });
  it('GET /api/decks/:id/export gives the import text as plain text', async () => {
    const r = await app.inject({ url: `/api/decks/${id}/export` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.body).toBe(deck.export_text);
    expect(r.body.startsWith('Deck\n')).toBe(true);
  });
  describe('marks on the links of a deck', () => {
    const firstLink = (d: DeckView) => {
      const card = d.cards.find((c) => c.links.length > 0)!;
      const link = card.links[0]!;
      return { card, link, supply: link.direction === 'gives' ? card.oracle_id : link.other, demand: link.direction === 'gives' ? link.other : card.oracle_id };
    };
    const get = async () => ((await app.inject({ url: `/api/decks/${id}` })).json() as { deck: DeckView }).deck;
    const stored = () => (db.prepare('SELECT deck_json FROM decks WHERE id = ?').get(id) as { deck_json: string }).deck_json;

    it('a weak mark stays after a reload, on both cards of the link, and can go', async () => {
      const { supply, demand } = firstLink(deck);
      const before = stored();
      const post = await app.inject({ method: 'POST', url: '/api/decks/weak', payload: { supply, demand, note: 'test' } });
      expect(post.statusCode).toBe(200);
      const marked = (await get()).cards.flatMap((c) => c.links.filter((l) => (l.direction === 'gives' ? c.oracle_id === supply && l.other === demand : c.oracle_id === demand && l.other === supply)));
      expect(marked.length).toBeGreaterThan(0);
      for (const l of marked) expect(l).toMatchObject({ weak: true, weak_mark: true });
      expect(stored()).toBe(before);
      const del = await app.inject({ method: 'DELETE', url: `/api/decks/weak?supply=${supply}&demand=${demand}` });
      expect(del.json()).toEqual({ removed: true, weak: false });
      expect(firstLink(await get()).link.weak_mark).toBeUndefined();
    });
    it('a weak mark changes the pair table of the next deck, with no new table', async () => {
      const link = firstLink(deck);
      await app.inject({ method: 'POST', url: '/api/decks/weak', payload: { supply: link.supply, demand: link.demand } });
      const t0 = Date.now();
      const r = await app.inject({ method: 'POST', url: '/api/decks', payload: { colours: 'BR', seeds: [seed], target_turn: 6, interaction: 'some' } });
      expect(Date.now() - t0).toBeLessThan(5000);
      const next = (r.json() as { deck: DeckView }).deck;
      const same = next.cards.flatMap((c) => c.links).filter((l) => l.edge_key === link.link.edge_key);
      for (const l of same) expect(l.weak).toBe(true);
      await app.inject({ method: 'DELETE', url: `/api/decks/weak?supply=${link.supply}&demand=${link.demand}` });
    });
    it('a false mark stays after a reload', async () => {
      const { link } = firstLink(deck);
      const r = await app.inject({ method: 'POST', url: `/api/graph/${deck.build_id}/reports`, payload: { edge_key: link.edge_key, note: 'test note' } });
      const report = (r.json() as { report_id: number }).report_id;
      for (const l of (await get()).cards.flatMap((c) => c.links).filter((x) => x.edge_key === link.edge_key)) expect(l.report).toEqual({ id: report, note: 'test note' });
      db.prepare("UPDATE edge_reports SET status = 'rejected' WHERE id = ?").run(report);
      expect(firstLink(await get()).link.report).toBeUndefined();
    });
    it('refuses a mark without a pair of cards', async () => {
      expect((await app.inject({ method: 'POST', url: '/api/decks/weak', payload: { supply: 'x' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/decks/weak', payload: { supply: 'x', demand: 'y' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: '/api/decks/weak?supply=x' })).statusCode).toBe(400);
    });
  });
  it('a second deck uses the pair table in memory, and the same goal gives the same deck', async () => {
    const t0 = Date.now();
    const r = await app.inject({ method: 'POST', url: '/api/decks', payload: { colours: 'BR', seeds: [seed], target_turn: 6, interaction: 'some' } });
    expect(Date.now() - t0).toBeLessThan(5000);
    const body = r.json() as { id: number; deck: DeckView };
    expect(body.id).not.toBe(id);
    expect(body.deck.export_text).toBe(deck.export_text);
  });
  it('a bad goal gives 400 with the fault, and stores nothing', async () => {
    const before = (db.prepare('SELECT COUNT(*) n FROM decks').get() as { n: number }).n;
    const r = await app.inject({ method: 'POST', url: '/api/decks', payload: { colours: 'BR', seeds: ['nothing'], target_turn: 6, interaction: 'some' } });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toMatch(/no card with ID nothing/);
    const r2 = await app.inject({ method: 'POST', url: '/api/decks', payload: { colours: 'BR', seeds: [seed, seed, seed, seed, seed], target_turn: 6, interaction: 'some' } });
    expect(r2.statusCode).toBe(400);
    expect((db.prepare('SELECT COUNT(*) n FROM decks').get() as { n: number }).n).toBe(before);
  });
  it('a goal with no seed gives a deck of 60 cards, and the list shows no seed', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/decks', payload: { colours: 'BR', seeds: [], target_turn: 6, interaction: 'some' } });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { id: number; deck: DeckView };
    expect(body.deck.cards.reduce((s, c) => s + c.copies, 0)).toBe(60);
    const list = (await app.inject({ url: '/api/decks' })).json() as { decks: Array<{ id: number; seeds: string[] }> };
    expect(list.decks.find((d) => d.id === body.id)!.seeds).toEqual([]);
  });
  it('a deck that does not exist gives 404', async () => {
    expect((await app.inject({ url: '/api/decks/999999' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/decks/abc/export' })).statusCode).toBe(404);
  });
  describe('the card rate switch (card rate plan Task 5)', () => {
    const on = () => ({ colours: 'BR', seeds: [seed], target_turn: 6, interaction: 'some', use_rate: true });
    const status = async () => (await app.inject({ url: '/api/decks/rate' })).json() as { build_id: number; ready: boolean };
    const summary = async (deckId: number) => ((await app.inject({ url: '/api/decks' })).json() as { decks: Array<{ id: number; use_rate: boolean }> }).decks.find((d) => d.id === deckId);

    it('a deck with no switch in its goal is off, and shows no rate', async () => {
      expect(deck.goal.use_rate).toBe(false);
      expect((await summary(id))!.use_rate).toBe(false);
      expect(deck.cards.every((c) => c.rate === undefined)).toBe(true);
    });
    it('an old stored deck reads as off, on the deck page and in the deck list', async () => {
      const stored = JSON.parse((db.prepare('SELECT deck_json FROM decks WHERE id = ?').get(id) as { deck_json: string }).deck_json) as DeckView;
      const { use_rate: _, ...oldGoal } = stored.goal;
      const row = db.prepare('INSERT INTO decks (build_id, goal_json, policy_sha, deck_json, created_at) SELECT build_id, ?, policy_sha, ?, created_at FROM decks WHERE id = ?')
        .run(JSON.stringify(oldGoal), JSON.stringify({ ...stored, goal: oldGoal }), id);
      const oldId = Number(row.lastInsertRowid);
      expect(((await app.inject({ url: `/api/decks/${oldId}` })).json() as { deck: DeckView }).deck.goal.use_rate).toBe(false);
      expect((await summary(oldId))!.use_rate).toBe(false);
    });
    it('with no rows for the build, the status says no and POST refuses, with what to run', async () => {
      db.exec('DELETE FROM card_rates');
      expect((await status()).ready).toBe(false);
      const before = (db.prepare('SELECT COUNT(*) n FROM decks').get() as { n: number }).n;
      const r = await app.inject({ method: 'POST', url: '/api/decks', payload: on() });
      expect(r.statusCode).toBe(400);
      expect((r.json() as { error: string }).error).toContain('Run npm run rate-fit');
      expect((db.prepare('SELECT COUNT(*) n FROM decks').get() as { n: number }).n).toBe(before);
      expect((await app.inject({ method: 'POST', url: '/api/decks', payload: { ...on(), use_rate: false } })).statusCode).toBe(201);
    });
    it('with rows of an older build, POST refuses', async () => {
      const b = (await status()).build_id;
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare("INSERT INTO card_rates (oracle_id, oracle_hash, build_id, printed_mana, rate, class, reason) VALUES (?, 'h', ?, 2, 0, 'plain', 'under_line')").run(seed, b - 1);
      db.exec('PRAGMA foreign_keys = ON');
      expect((await status()).ready).toBe(false);
      expect((await app.inject({ method: 'POST', url: '/api/decks', payload: on() })).statusCode).toBe(400);
      db.exec('DELETE FROM card_rates');
    });
    it('with rows of the build, the deck has the switch and the value of each spell', async () => {
      const b = (await status()).build_id;
      const spells = deck.cards.filter((c) => c.role !== 'land');
      const add = db.prepare(
        `INSERT INTO card_rates (oracle_id, oracle_hash, build_id, predicted_mana, printed_mana, role_gap, rate, class, reason)
         SELECT oracle_id, oracle_hash, ?, ?, cmc, ?, ?, 'plain', ? FROM cards WHERE oracle_id = ?`,
      );
      add.run(b, null, null, null, 'x_cost', spells[0]!.oracle_id);
      add.run(b, 3, null, 0, 'no_group', spells[1]!.oracle_id);
      for (const c of spells.slice(2)) add.run(b, 3, 2, 2, 'gap', c.oracle_id);
      expect(await status()).toEqual({ build_id: b, ready: true });
      const r = await app.inject({ method: 'POST', url: '/api/decks', payload: on() });
      expect(r.statusCode).toBe(201);
      const body = r.json() as { id: number; deck: DeckView };
      expect(body.deck.goal.use_rate).toBe(true);
      expect((await summary(body.id))!.use_rate).toBe(true);
      for (const c of body.deck.cards) {
        if (c.role === 'land') expect(c.rate).toBeUndefined();
        else expect(c.rate).toBeDefined();
      }
      const reasons = new Set(body.deck.cards.flatMap((c) => (c.rate ? [c.rate.reason] : [])));
      expect(reasons).toContain('gap');
      db.exec('DELETE FROM card_rates');
    });
  });
  it('the false link report of the deck view reaches edge_reports', async () => {
    const link = deck.cards.flatMap((c) => c.links)[0]!;
    const r = await app.inject({ method: 'POST', url: `/api/graph/${deck.build_id}/reports`, payload: { edge_key: link.edge_key, note: 'false link, from the deck view' } });
    expect(r.statusCode).toBe(200);
    const id2 = (r.json() as { report_id: number }).report_id;
    expect(db.prepare('SELECT edge_key, status FROM edge_reports WHERE id = ?').get(id2)).toMatchObject({ edge_key: link.edge_key, status: 'open' });
  });
});

describe('the deck routes with no graph build', () => {
  it('stored decks list is empty on a fresh database', async () => {
    const app = buildServer(openDb(':memory:'));
    const r = await app.inject({ url: '/api/decks' });
    expect(r.json()).toEqual({ decks: [] });
    expect((await app.inject({ url: '/api/decks/rate' })).json()).toEqual({ build_id: null, ready: false });
    await app.close();
  });
});
