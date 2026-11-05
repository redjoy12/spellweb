import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, openDb } from '../src/db/client.js';
import { newestBuild, withWeakAnswers } from '../src/deck/deck.js';
import type { DeckView } from '../src/deck/justify.js';
import { deckPolicySha, loadDeckPolicy } from '../src/deck/policy.js';
import { swappedDeck, SwapError } from '../src/deck/swap.js';
import { LegalityError } from '../src/deck/check.js';
import { buildServer } from '../src/server/app.js';
import type { ChatRunner, RunRequest } from '../src/server/chat/turn.js';
import { indexOfBuild } from '../src/server/routes/graph.js';
import { tableOf } from '../src/server/routes/decks.js';
import { maybe } from './helpers/realDb.js';

const INIT = { type: 'system', subtype: 'init' };
const reply = (result: string) => ({ type: 'result', subtype: 'success', is_error: false, result, usage: {}, num_turns: 1 });
const counts = (d: DeckView) => new Map(d.cards.map((c) => [c.oracle_id, c.copies]));
const total = (d: DeckView) => d.cards.reduce((s, c) => s + c.copies, 0);

interface Chat { running: boolean; undo_message_id: number | null; messages: Array<{ id: number; role: string; text: string; data: { status?: string } | null }> }
interface ToolAnswer { result: { content: Array<{ text: string }>; isError?: boolean } }

// On a VACUUM INTO copy of data/app.db, with a replaced CLI. A turn runs the tool calls of `script`.
maybe('the deck chat on a copy of the real database (design sec. 3 to 5)', () => {
  let dir = '';
  let db: DatabaseSync;
  let app: ReturnType<typeof buildServer>;
  let id = 0;
  let deck: DeckView;
  let script: (tool: (name: string, args?: object) => Promise<ToolAnswer['result']>) => Promise<string> = async () => 'ok';

  const runner: ChatRunner = (req: RunRequest) => {
    const url = (JSON.parse(req.args[req.args.indexOf('--mcp-config') + 1]!) as { mcpServers: { deck: { url: string; headers: { Authorization: string } } } }).mcpServers.deck;
    const route = url.url.slice(url.url.indexOf('/api/'));
    const tool = async (name: string, args: object = {}) => {
      const r = await app.inject({ method: 'POST', url: route, headers: { authorization: url.headers.Authorization }, payload: { id: 1, method: 'tools/call', params: { name, arguments: args } } });
      return (r.json() as ToolAnswer).result;
    };
    const done = script(tool).then((text) => {
      req.onLine(JSON.stringify(INIT));
      req.onLine(JSON.stringify(reply(text)));
      return { code: 0, stderr: '' };
    });
    return { kill: () => {}, done };
  };

  /** One turn. It gives the talk after the turn. */
  const turn = async (run: typeof script, deckId = id): Promise<Chat> => {
    script = run;
    expect((await app.inject({ method: 'POST', url: `/api/decks/${deckId}/chat`, payload: { text: 'go' } })).statusCode).toBe(202);
    for (let i = 0; i < 2000; i++) {
      const c = (await app.inject({ url: `/api/decks/${deckId}/chat` })).json() as Chat;
      if (!c.running) return c;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    throw new Error('the turn did not end');
  };
  const getDeck = async (deckId = id) => ((await app.inject({ url: `/api/decks/${deckId}` })).json() as { deck: DeckView }).deck;
  const press = (messageId: number, choice: 'swap' | 'refuse', deckId = id) => app.inject({ method: 'POST', url: `/api/decks/${deckId}/swap/${messageId}`, payload: { choice } });
  const undo = (deckId = id) => app.inject({ method: 'POST', url: `/api/decks/${deckId}/undo`, payload: {} });

  /** A legal card of the pool that is not in the deck, by a query on `cards`. */
  const outsider = (where: string): { name: string; oracle_id: string } => {
    const names = new Set(deck.cards.map((c) => c.oracle_id));
    const rows = db.prepare(`SELECT oracle_id, name FROM cards WHERE ${where} ORDER BY oracle_id`).all() as Array<{ oracle_id: string; name: string }>;
    return rows.find((r) => !names.has(r.oracle_id))!;
  };
  const legal = "rotated = 0 AND arena_id IS NOT NULL AND type_line NOT LIKE '%Land%' AND color_identity = '[\"B\"]'";
  const spell = () => deck.cards.find((c) => c.role === 'link' && c.copies >= 2) ?? deck.cards.find((c) => c.role !== 'land')!;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'api-deck-chat-'));
    const file = join(dir, 'app.db');
    const src = new DatabaseSync(DB_PATH, { readOnly: true });
    try { src.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); } finally { src.close(); }
    db = openDb(file);
    const b = (db.prepare('SELECT MAX(id) AS id FROM graph_builds').get() as { id: number }).id;
    const seed = (db.prepare(
      `SELECT c.oracle_id FROM card_degree d JOIN cards c USING (oracle_id)
        WHERE d.build_id = ? AND c.rotated = 0 AND c.arena_id IS NOT NULL AND c.cmc BETWEEN 1 AND 4 AND c.type_line NOT LIKE '%Land%'
        ORDER BY d.out_degree + d.in_degree DESC, c.oracle_id LIMIT 1`,
    ).get(b) as { oracle_id: string }).oracle_id;
    app = buildServer(db, { chatRunner: runner });
    const r = await app.inject({ method: 'POST', url: '/api/decks', payload: { colours: 'BR', seeds: [seed], target_turn: 6, interaction: 'some' } });
    expect(r.statusCode).toBe(201);
    ({ id, deck } = r.json() as { id: number; deck: DeckView });
  }, 600_000);

  afterAll(async () => {
    await app?.close();
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('find_cards gives pool cards of the colours, with text and links; card_detail gives the tags and the links', async () => {
    let find = '';
    let none = '';
    let detail = '';
    let bad: ToolAnswer['result'] | null = null;
    await turn(async (tool) => {
      find = (await tool('find_cards', { words: 'discard', type: 'Creature', mana_value_max: 3 })).content[0]!.text;
      none = (await tool('find_cards', { words: 'zzzzzzzz' })).content[0]!.text;
      detail = (await tool('card_detail', { name: spell().name })).content[0]!.text;
      bad = await tool('card_detail', { name: 'No Such Card' });
      return 'done';
    });
    expect(find).toMatch(/^\d+ cards match\./);
    expect(find).toMatch(/\d+ links.*\[\[/);
    expect(none).toContain('No card matches');
    expect(detail).toContain(`[[${spell().name}]]`);
    expect(detail).toContain('Tags: ');
    expect(detail).toContain('Links to this deck');
    expect(bad!.isError).toBe(true);
  }, 120_000);

  it('a swap that is not legal gives the reason, and no swap box shows', async () => {
    const out = spell();
    const offColour = outsider("rotated = 0 AND arena_id IS NOT NULL AND color_identity = '[\"W\"]'");
    const rotated = db.prepare("SELECT name FROM cards WHERE rotated = 1 AND color_identity = '[\"B\"]' LIMIT 1").get() as { name: string } | undefined;
    const noArena = db.prepare("SELECT name FROM cards WHERE rotated = 0 AND arena_id IS NULL AND color_identity = '[\"B\"]' LIMIT 1").get() as { name: string } | undefined;
    const answers: Array<ToolAnswer['result']> = [];
    const swap = (o: object[], i: object[]) => ({ out: o, in: i, reason: 'test' });
    const before = (await app.inject({ url: `/api/decks/${id}/chat` })).json() as Chat;
    const c = await turn(async (tool) => {
      for (const args of [
        swap([{ name: out.name, copies: 1 }], [{ name: offColour.name, copies: 1 }]),
        ...(rotated ? [swap([{ name: out.name, copies: 1 }], [{ name: rotated.name, copies: 1 }])] : []),
        ...(noArena ? [swap([{ name: out.name, copies: 1 }], [{ name: noArena.name, copies: 1 }])] : []),
        swap([{ name: out.name, copies: 1 }], [{ name: outsider(legal).name, copies: 2 }]), // the deck stays at 60
        swap([{ name: out.name, copies: 1 }], [{ name: 'No Such Card', copies: 1 }]),
        swap([{ name: outsider(legal).name, copies: 1 }], [{ name: out.name, copies: 1 }]),
        swap([{ name: out.name, copies: 9 }], [{ name: outsider(legal).name, copies: 9 }]),
      ]) answers.push(await tool('propose_swap', args));
      return 'done';
    });
    expect(answers.every((a) => a.isError === true)).toBe(true);
    expect(answers[0]!.content[0]!.text).toContain('outside the colours');
    expect(c.messages.slice(before.messages.length).filter((m) => m.role === 'swap')).toEqual([]);
    expect(await getDeck()).toEqual(deck);
  }, 120_000);

  it('at most 4 copies, except a basic land', async () => {
    const out = deck.cards.filter((c) => c.role !== 'land').slice(0, 5);
    const n = out.reduce((s, c) => s + c.copies, 0);
    expect(n).toBeGreaterThan(4);
    let spells: ToolAnswer['result'] | null = null;
    let basics: ToolAnswer['result'] | null = null;
    const list = out.map((c) => ({ name: c.name, copies: c.copies }));
    await turn(async (tool) => {
      spells = await tool('propose_swap', { out: list, in: [{ name: outsider(legal).name, copies: n }], reason: 'test' });
      basics = await tool('propose_swap', { out: list, in: [{ name: 'Swamp', copies: n }], reason: 'test' });
      return 'done';
    });
    expect(spells!.isError).toBe(true);
    expect(spells!.content[0]!.text).toContain('copies of');
    expect(basics!.isError).toBeUndefined();
  }, 120_000);

  it('a swap shows under the reply and changes nothing until the owner presses Swap; then only its cards change; Undo gives the same deck', async () => {
    const out = spell();
    const entering = outsider(legal);
    const before = await getDeck();
    const beforeJson = (db.prepare('SELECT deck_json, build_id FROM decks WHERE id = ?').get(id) as { deck_json: string; build_id: number });
    const c = await turn(async (tool) => {
      const a = await tool('propose_swap', { out: [{ name: out.name, copies: 1 }], in: [{ name: entering.name, copies: 1 }], reason: 'A test swap.' });
      expect(a.isError).toBeUndefined();
      return `Take [[${entering.name}]].`;
    });
    expect(c.messages.at(-2)!.role).toBe('claude');
    const box = c.messages.at(-1)!;
    expect(box).toMatchObject({ role: 'swap', data: { status: 'open', reason: 'A test swap.' } });
    expect(await getDeck()).toEqual(before);

    const r = await press(box.id, 'swap');
    expect(r.statusCode).toBe(200);
    const after = (r.json() as { deck: DeckView }).deck;
    expect(total(after)).toBe(60);
    const [was, now] = [counts(before), counts(after)];
    const changed = [...new Set([...was.keys(), ...now.keys()])].filter((k) => was.get(k) !== now.get(k));
    expect(changed.sort()).toEqual([out.oracle_id, entering.oracle_id].sort());
    expect(now.get(entering.oracle_id)).toBe(1);
    expect((was.get(out.oracle_id) ?? 0) - (now.get(out.oracle_id) ?? 0)).toBe(1);
    expect(after.cards.find((x) => x.oracle_id === entering.oracle_id)!.role).toBe('swap');
    expect(after.mana.land_count).toBe(before.mana.land_count);
    expect(after.mana.sources).toEqual(before.mana.sources);
    expect(after.build_id).toBe(newestBuild(db));
    expect(after.export_text).toContain(entering.name);
    expect(await getDeck()).toEqual(after);
    expect((await press(box.id, 'swap')).statusCode).toBe(409);

    const chat = (await app.inject({ url: `/api/decks/${id}/chat` })).json() as Chat;
    expect(chat.undo_message_id).toBe(box.id);
    expect((await undo()).statusCode).toBe(200);
    expect(await getDeck()).toEqual(before);
    expect(db.prepare('SELECT deck_json, build_id FROM decks WHERE id = ?').get(id)).toEqual(beforeJson);
    expect((await undo()).statusCode).toBe(409);
    const last = (await app.inject({ url: `/api/decks/${id}/chat` })).json() as Chat;
    expect(last.messages.find((m) => m.id === box.id)!.data!.status).toBe('undone');
    expect(last.undo_message_id).toBeNull();
  }, 120_000);

  it('a swap of a land changes the land and its colour sources, and two swaps undo in order', async () => {
    const before = await getDeck();
    const basic = before.cards.find((c) => c.role === 'land' && c.type_line.startsWith('Basic Land') && c.copies >= 2)!;
    const dual = db.prepare("SELECT c.name FROM cards c WHERE c.name = 'Rakdos Guildgate' AND c.rotated = 0 AND c.arena_id IS NOT NULL").get() as { name: string } | undefined;
    if (!dual || before.cards.some((c) => c.name === dual.name)) return;
    const a = await turn(async (tool) => { await tool('propose_swap', { out: [{ name: basic.name, copies: 1 }], in: [{ name: dual.name, copies: 1 }], reason: 'Mana.' }); return 'ok'; });
    const first = (await press(a.messages.at(-1)!.id, 'swap')).json() as { deck: DeckView };
    expect(first.deck.mana.land_count).toBe(before.mana.land_count);
    const colour = basic.name === 'Swamp' ? ['B', 'R'] as const : ['R', 'B'] as const;
    expect(first.deck.mana.sources[colour[0]]).toBe(before.mana.sources[colour[0]]);
    expect(first.deck.mana.sources[colour[1]]).toBe(before.mana.sources[colour[1]] + 1);
    expect(first.deck.cards.find((c) => c.name === dual.name)!.role).toBe('land');

    const b = await turn(async (tool) => { await tool('propose_swap', { out: [{ name: spell().name, copies: 1 }], in: [{ name: outsider(legal).name, copies: 1 }], reason: 'Two.' }); return 'ok'; });
    expect((await press(b.messages.at(-1)!.id, 'swap')).statusCode).toBe(200);
    expect((await undo()).statusCode).toBe(200);
    expect(await getDeck()).toEqual(first.deck);
    expect((await undo()).statusCode).toBe(200);
    expect(await getDeck()).toEqual(before);
  }, 120_000);

  it('a box that the deck no longer fits is refused with its reason; "No" closes a box and tells Claude', async () => {
    const out = deck.cards.find((c) => c.role === 'link' && c.copies === 1) ?? spell();
    const swapAll = { out: [{ name: out.name, copies: out.copies }], in: [{ name: outsider(legal).name, copies: out.copies }], reason: 'One.' };
    const c = await turn(async (tool) => {
      await tool('propose_swap', swapAll);
      await tool('propose_swap', { ...swapAll, in: [{ name: outsider(`${legal} AND name <> '${outsider(legal).name.replace(/'/g, "''")}'`).name, copies: out.copies }] });
      return 'ok';
    });
    const [one, two] = c.messages.slice(-2);
    expect((await press(one!.id, 'swap')).statusCode).toBe(200);
    const late = await press(two!.id, 'swap');
    expect(late.statusCode).toBe(422);
    expect((late.json() as { error: string }).error).toContain('not possible now');
    expect((await press(two!.id, 'refuse')).statusCode).toBe(200);
    expect((await press(two!.id, 'refuse')).statusCode).toBe(409);
    expect((await undo()).statusCode).toBe(200);
    expect(await getDeck()).toEqual(deck);
  }, 120_000);

  it('a deck on an older build works: its swap moves to the newest build, and Undo gives the older build back', async () => {
    const newest = newestBuild(db);
    const row = db.prepare('SELECT id FROM decks WHERE build_id < ? ORDER BY id LIMIT 1').get(newest) as { id: number } | undefined;
    if (!row) return;
    const old = await getDeck(row.id);
    const out = old.cards.find((c) => c.role !== 'land' && c.role !== 'seed')!;
    const names = new Set(old.cards.map((c) => c.oracle_id));
    const entering = (db.prepare(`SELECT oracle_id, name FROM cards WHERE ${legal} ORDER BY oracle_id`).all() as Array<{ oracle_id: string; name: string }>).find((r) => !names.has(r.oracle_id))!;
    const c = await turn(async (tool) => { await tool('propose_swap', { out: [{ name: out.name, copies: 1 }], in: [{ name: entering.name, copies: 1 }], reason: 'Old.' }); return 'ok'; }, row.id);
    const r = await press(c.messages.at(-1)!.id, 'swap', row.id);
    expect(r.statusCode).toBe(200);
    const after = (r.json() as { deck: DeckView }).deck;
    expect(after.build_id).toBe(newest);
    expect(total(after)).toBe(60);
    expect((await undo(row.id)).statusCode).toBe(200);
    expect((await getDeck(row.id)).build_id).toBe(old.build_id);
    expect(await getDeck(row.id)).toEqual(old);
  }, 120_000);

  it('with no named card, each stored deck keeps its lands and colour sources', () => {
    const buildId = newestBuild(db);
    const policy = loadDeckPolicy();
    const idx = indexOfBuild(db)(buildId)!;
    const table = withWeakAnswers(db, tableOf(db, buildId), policy);
    const rows = db.prepare('SELECT deck_json FROM decks').all() as Array<{ deck_json: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const view = JSON.parse(r.deck_json) as DeckView;
      const same = swappedDeck(db, idx, table, view, { out: [], in: [] }, buildId, deckPolicySha(policy), policy);
      expect(counts(same)).toEqual(counts(view));
      expect(same.mana.sources).toEqual(view.mana.sources);
      expect(same.mana.needs).toEqual(view.mana.needs);
      expect(same.mana.land_count).toBe(view.mana.land_count);
    }
  }, 120_000);

  it('the swap check refuses a card in both lists and a card that the deck does not have', () => {
    const buildId = newestBuild(db);
    const policy = loadDeckPolicy();
    const idx = indexOfBuild(db)(buildId)!;
    const table = tableOf(db, buildId);
    const c = spell();
    const card = { oracle_id: c.oracle_id, name: c.name, copies: 1 };
    const run = (out: typeof card[], entering: typeof card[]) => swappedDeck(db, idx, table, deck, { out, in: entering }, buildId, 'sha', policy);
    expect(() => run([card], [card])).toThrow(SwapError);
    expect(() => run([{ ...card, copies: 9 }], [])).toThrow(SwapError);
    expect(() => run([card], [])).toThrow(LegalityError);
  }, 120_000);

  it('the chat writes nothing to atoms, tags, links, golden pairs or owner answers', async () => {
    const tables = ['atoms', 'atom_types', 'edge_rules', 'edge_golden_pairs', 'edge_reports', 'owner_decisions', 'graph_builds'];
    const size = () => tables.map((t) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    const before = size();
    const c = await turn(async (tool) => {
      await tool('deck_state');
      await tool('find_cards', { type: 'Creature' });
      await tool('card_detail', { name: spell().name });
      await tool('propose_swap', { out: [{ name: spell().name, copies: 1 }], in: [{ name: outsider(legal).name, copies: 1 }], reason: 'Count.' });
      return 'ok';
    });
    expect((await press(c.messages.at(-1)!.id, 'swap')).statusCode).toBe(200);
    expect((await undo()).statusCode).toBe(200);
    expect(size()).toEqual(before);
  }, 120_000);
});

describe('the test file loads with no real database', () => {
  it('has its helpers', () => {
    expect(total({ cards: [{ copies: 60 }] } as unknown as DeckView)).toBe(60);
  });
});
