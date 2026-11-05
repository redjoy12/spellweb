import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, openDb } from '../src/db/client.js';
import { buildServer } from '../src/server/app.js';
import { draftChanges, emptyDraft } from '../src/server/chat/build.js';
import type { ChatRunner, RunRequest } from '../src/server/chat/turn.js';
import { loadDeckPolicy } from '../src/deck/policy.js';
import { maybe } from './helpers/realDb.js';

const INIT = { type: 'system', subtype: 'init' };
const reply = (result: string) => ({ type: 'result', subtype: 'success', is_error: false, result, usage: {}, num_turns: 1 });

interface Talk {
  id: number; running: boolean; deck_id: number | null; brief: string;
  draft: { colours: string; target_turn: number; seeds: Array<{ oracle_id: string; name: string }>; pinned: Array<{ oracle_id: string; name: string }>; excluded_tags: string[] };
  messages: Array<{ id: number; role: string; text: string; data: { answers?: string[] } | null }>;
}
interface ToolAnswer { result: { content: Array<{ text: string }>; isError?: boolean } }

describe('draftChanges (build chat design sec. 4)', () => {
  const db = openDb(':memory:');
  const base = emptyDraft(loadDeckPolicy());
  it('names each changed field, and nothing for the same draft', () => {
    expect(draftChanges(db, base, base, '', '')).toEqual([]);
    expect(draftChanges(db, base, { ...base, target_turn: 5, excluded_tags: ['PRODUCES.DISCARD'] }, '', 'plan')).toEqual([
      'target turn 6 -> 5', 'never tags added: PRODUCES.DISCARD', 'the brief changed',
    ]);
  });
});

// On a VACUUM INTO copy of data/app.db, with a replaced CLI. A turn runs the tool calls of `script`.
maybe('the build chat on a copy of the real database (design sec. 4 to 8)', () => {
  let dir = '';
  let db: DatabaseSync;
  let app: ReturnType<typeof buildServer>;
  let seed = { oracle_id: '', name: '' };
  let pin = { oracle_id: '', name: '' };
  let stdin: string[] = [];
  let script: (tool: (name: string, args?: object) => Promise<ToolAnswer['result']>) => Promise<string> = async () => 'ok';

  const runner: ChatRunner = (req: RunRequest) => {
    stdin.push(req.stdin);
    const servers = (JSON.parse(req.args[req.args.indexOf('--mcp-config') + 1]!) as { mcpServers: Record<string, { url: string; headers: { Authorization: string } }> }).mcpServers;
    const server = Object.values(servers)[0]!;
    const route = server.url.slice(server.url.indexOf('/api/'));
    const tool = async (name: string, args: object = {}) => {
      const r = await app.inject({ method: 'POST', url: route, headers: { authorization: server.headers.Authorization }, payload: { id: 1, method: 'tools/call', params: { name, arguments: args } } });
      return (r.json() as ToolAnswer).result;
    };
    const done = script(tool).then((text) => {
      req.onLine(JSON.stringify(INIT));
      req.onLine(JSON.stringify(reply(text)));
      return { code: 0, stderr: '' };
    });
    return { kill: () => {}, done };
  };

  const getTalk = async (id: number) => (await app.inject({ url: `/api/build-chats/${id}` })).json() as Talk;
  const turn = async (id: number, run: typeof script): Promise<Talk> => {
    script = run;
    const r = await app.inject({ method: 'POST', url: `/api/build-chats/${id}/messages`, payload: { text: 'I want a fast black deck' } });
    expect(r.statusCode).toBe(202);
    for (let i = 0; i < 3000; i++) {
      const t = await getTalk(id);
      if (!t.running) return t;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    throw new Error('the turn did not end');
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'api-build-chat-'));
    const file = join(dir, 'app.db');
    const src = new DatabaseSync(DB_PATH, { readOnly: true });
    try { src.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); } finally { src.close(); }
    db = openDb(file);
    const b = (db.prepare('SELECT MAX(id) AS id FROM graph_builds').get() as { id: number }).id;
    const top = db.prepare(
      `SELECT c.oracle_id, c.name FROM card_degree d JOIN cards c USING (oracle_id)
        WHERE d.build_id = ? AND c.rotated = 0 AND c.arena_id IS NOT NULL AND c.cmc BETWEEN 1 AND 4 AND c.type_line NOT LIKE '%Land%'
          AND c.color_identity = '["B"]' AND c.name NOT LIKE '%//%'
        ORDER BY d.out_degree + d.in_degree DESC, c.oracle_id LIMIT 2`,
    ).all(b) as Array<{ oracle_id: string; name: string }>;
    [seed, pin] = [top[0]!, top[1]!];
    app = buildServer(db, { chatRunner: runner });
  }, 600_000);

  afterAll(async () => {
    await app?.close();
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a new talk has the form of the page; set_draft changes it, ask adds buttons, and try_draft gives a test deck', async () => {
    const made = await app.inject({ method: 'POST', url: '/api/build-chats', payload: {} });
    expect(made.statusCode).toBe(201);
    const id = (made.json() as Talk).id;
    let refused: ToolAnswer['result'] | null = null;
    let tried = '';
    let tags = '';
    let found = '';
    const t = await turn(id, async (tool) => {
      refused = await tool('set_draft', { seeds: ['No Such Card'] });
      expect((await tool('set_draft', { colours: 'B', target_turn: 5, seeds: [seed.name], pinned: [pin.name], brief: 'A fast plan.' })).isError).toBeUndefined();
      tags = (await tool('list_tags', { words: 'discard' })).content[0]!.text;
      found = (await tool('find_cards', { type: 'Creature', mana_value_max: 2 })).content[0]!.text;
      tried = (await tool('try_draft')).content[0]!.text;
      await tool('ask', { answers: ['Attacks', 'A drain'] });
      return 'How does the deck win?';
    });
    expect(refused!.isError).toBe(true);
    expect(refused!.content[0]!.text).toMatch(/No Such Card/);
    expect(t.draft).toMatchObject({ colours: 'B', target_turn: 5 });
    expect(t.draft.seeds.map((s) => s.name)).toEqual([seed.name]);
    expect(t.draft.pinned.map((s) => s.name)).toEqual([pin.name]);
    expect(t.brief).toBe('A fast plan.');
    expect(tags).toMatch(/DISCARD/);
    expect(found).toMatch(/cards match/);
    expect(tried).toMatch(/^Test deck: \d+ spell copies and \d+ lands/);
    expect(tried).toContain(`(pin) [[${pin.name}]]`);
    expect(t.messages.find((m) => m.role === 'claude')!.data!.answers).toEqual(['Attacks', 'A drain']);
    expect(t.messages.some((m) => m.role === 'step' && /Claude changed the form/.test(m.text))).toBe(true);
    // The first turn read the form that the page started with.
    expect(stdin.at(-1)).toMatch(/The form now:\nColours BR\. Target turn 6/);
  }, 600_000);

  it('an owner change of the form is a note, and the next turn reads it', async () => {
    const id = ((await app.inject({ method: 'POST', url: '/api/build-chats', payload: {} })).json() as Talk).id;
    const before = await getTalk(id);
    const draft = { ...emptyDraft(loadDeckPolicy()), target_turn: 7 };
    const put = await app.inject({ method: 'PUT', url: `/api/build-chats/${id}/draft`, payload: { draft, brief: before.brief } });
    expect(put.statusCode).toBe(200);
    expect((put.json() as Talk).messages.at(-1)).toMatchObject({ role: 'note', text: 'You changed the form: target turn 6 -> 7.' });
    // The same form again adds no note.
    await app.inject({ method: 'PUT', url: `/api/build-chats/${id}/draft`, payload: { draft, brief: before.brief } });
    expect((await getTalk(id)).messages.filter((m) => m.role === 'note')).toHaveLength(1);
    await turn(id, async () => 'ok');
    expect(stdin.at(-1)).toMatch(/What the owner did since your last reply:\n- You changed the form: target turn 6 -> 7\./);
    await turn(id, async () => 'ok');
    expect(stdin.at(-1)).not.toMatch(/What the owner did/);
  }, 600_000);

  it('a build from a talk stores the brief and closes the talk; the first deck chat turn reads the brief', async () => {
    const id = ((await app.inject({ method: 'POST', url: '/api/build-chats', payload: {} })).json() as Talk).id;
    await turn(id, async (tool) => {
      await tool('set_draft', { colours: 'B', seeds: [seed.name], brief: 'Win with early attacks.' });
      return 'Press Build.';
    });
    const t = await getTalk(id);
    const goal = { colours: 'B', seeds: [seed.oracle_id], excluded: [], target_turn: 6, interaction: 'some', min_creatures: 14, use_rate: false, pinned: [], excluded_tags: [] };
    const built = await app.inject({ method: 'POST', url: '/api/decks', payload: { ...goal, build_chat_id: t.id } });
    expect(built.statusCode).toBe(201);
    const deckId = (built.json() as { id: number }).id;
    expect(((await app.inject({ url: `/api/decks/${deckId}` })).json() as { brief: string }).brief).toBe('Win with early attacks.');
    const closed = await getTalk(id);
    expect(closed.deck_id).toBe(deckId);
    expect((await app.inject({ method: 'POST', url: `/api/build-chats/${id}/messages`, payload: { text: 'more' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/decks', payload: { ...goal, build_chat_id: t.id } })).statusCode).toBe(409);
    // The deck chat: the first turn reads the brief, and a later turn does not.
    script = async () => 'ok';
    const send = async () => {
      expect((await app.inject({ method: 'POST', url: `/api/decks/${deckId}/chat`, payload: { text: 'hello' } })).statusCode).toBe(202);
      for (let i = 0; i < 3000; i++) {
        if (!((await app.inject({ url: `/api/decks/${deckId}/chat` })).json() as { running: boolean }).running) return;
        await new Promise((ok) => setTimeout(ok, 10));
      }
    };
    await send();
    expect(stdin.at(-1)).toMatch(/The brief of that talk:\nWin with early attacks\./);
    await send();
    expect(stdin.at(-1)).not.toMatch(/brief/);
  }, 600_000);

  it('a goal with no talk still builds, and a wrong talk ID gives 404', async () => {
    const goal = { colours: 'B', seeds: [seed.oracle_id], target_turn: 6, interaction: 'some' };
    expect((await app.inject({ method: 'POST', url: '/api/decks', payload: goal })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/decks', payload: { ...goal, build_chat_id: 99999 } })).statusCode).toBe(404);
  }, 600_000);
});
