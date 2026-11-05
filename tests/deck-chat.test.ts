import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/client.js';
import { buildServer } from '../src/server/app.js';
import { addMessage, messagesOf, saveComment, setTurnState, ensureChat, commentsOf } from '../src/server/chat/store.js';
import { checkNames, cardByName } from '../src/server/chat/tools.js';
import { cleanEnv, cliArgs, loadChatConfig, spawnClaude, type ChatRunner, type RunRequest } from '../src/server/chat/turn.js';

/** Two decks with two spells and one land each, and one more card. The tests on a real deck are in `api-deck-chat.test.ts`. */
function fixture(): DatabaseSync {
  const d = openDb(':memory:');
  d.exec('PRAGMA foreign_keys = OFF');
  d.exec("INSERT INTO snapshots (source_type,source_uri,source_updated_at,ingested_at,status) VALUES ('t','u','t','t','complete')");
  const card = d.prepare(`INSERT INTO cards (oracle_id,name,layout,cmc,type_line,colors,color_identity,keywords,rarity,arena_id,set_code,collector_number,oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id)
    VALUES (?,?,'normal',2,?,'[]','["B"]','[]','c',1,'s','1','h',1,1)`);
  const face = d.prepare("INSERT INTO card_faces (oracle_id,face_index,name,type_line,oracle_text,colors) VALUES (?,0,?,?,?,'[]')");
  for (const [id, name, type, text] of [
    ['a', 'Alpha Card', 'Creature — Human', 'Draw a card.'],
    ['b', "Beta's Card", 'Sorcery', 'Target opponent discards a card.'],
    ['s', 'Swamp', 'Basic Land — Swamp', ''],
    ['x', 'Xeno // Yeti', 'Instant', 'One'],
  ] as const) {
    card.run(id, name, type);
    face.run(id, name, type, text);
  }
  d.prepare("INSERT INTO card_faces (oracle_id,face_index,name,type_line,oracle_text,colors) VALUES ('x',1,'Yeti','Sorcery','Two','[]')").run();
  const c = (oracle_id: string, name: string, copies: number, role: string) => ({ oracle_id, name, copies, role, mana_value: 2, mana_cost: null, type_line: 'T', image: null, deck_links: 1, links: [] });
  const view = {
    build_id: 1, goal: { colours: 'B', seeds: [], excluded: [], target_turn: 6, interaction: 'some', min_creatures: 0 }, policy_sha: 'p',
    cards: [c('a', 'Alpha Card', 20, 'link'), c('b', "Beta's Card", 20, 'quota'), c('s', 'Swamp', 20, 'land')],
    mana: { land_count: 20, turn: 3, needs: { B: 10, R: 0 }, sources: { B: 20, R: 0 }, short: false }, warnings: [{ kind: 'no_link', text: 'Beta has no link to the deck.', cards: ['b'] }], loops: 1, stable: true, export_text: 'Deck',
  };
  const deck = d.prepare("INSERT INTO decks (build_id, goal_json, policy_sha, deck_json, created_at) VALUES (1, '{}', 'p', ?, 't')");
  deck.run(JSON.stringify(view));
  deck.run(JSON.stringify(view));
  return d;
}

const INIT = { type: 'system', subtype: 'init' };
const reply = (result: string) => ({ type: 'result', subtype: 'success', is_error: false, result, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, total_cost_usd: 0.01, num_turns: 1 });
const failed = (result: string) => ({ type: 'result', subtype: 'success', is_error: true, result });

type Script = (req: RunRequest, n: number) => Promise<object[]> | object[];

/** A replacement of the CLI: it records each start and gives the lines of `script`. */
function fakeCli(script: Script) {
  const calls: RunRequest[] = [];
  const kills: number[] = [];
  const runner: ChatRunner = (req) => {
    const n = calls.push(req) - 1;
    let stop = () => {};
    const stopped = new Promise<object[]>((ok) => { stop = () => ok([]); });
    const done = (async () => {
      const lines = await Promise.race([script(req, n), stopped]);
      for (const l of lines) req.onLine(JSON.stringify(l));
      return { code: 0, stderr: '' };
    })();
    return { kill: () => { kills.push(n); stop(); }, done };
  };
  return { runner, calls, kills };
}

const flag = (req: RunRequest, name: string) => req.args[req.args.indexOf(name) + 1];
const bearer = (req: RunRequest) => (JSON.parse(flag(req, '--mcp-config')!) as { mcpServers: { deck: { headers: { Authorization: string } } } }).mcpServers.deck.headers.Authorization;
const never = () => new Promise<object[]>(() => {});

interface Chat { model: string; running: boolean; flagged: boolean; context: { used: number; limit: number } | null; messages: Array<{ id: number; role: string; text: string; data: Record<string, unknown> | null }> }

describe('the deck chat with a replaced CLI (design sec. 4 to 6)', () => {
  const apps: Array<ReturnType<typeof buildServer>> = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

  function serve(d: DatabaseSync, runner: ChatRunner) {
    const app = buildServer(d, { chatRunner: runner });
    apps.push(app);
    const send = (deck: number, text: string) => app.inject({ method: 'POST', url: `/api/decks/${deck}/chat`, payload: { text } });
    const chat = async (deck: number) => (await app.inject({ url: `/api/decks/${deck}/chat` })).json() as Chat;
    const idle = async (deck: number) => {
      for (let i = 0; i < 200; i++) {
        const c = await chat(deck);
        if (!c.running) return c;
        await new Promise((ok) => setTimeout(ok, 5));
      }
      throw new Error('the turn did not end');
    };
    return { app, send, chat, idle };
  }

  it('a reply shows after the check, with the card of each name and the size of the turn', async () => {
    const cli = fakeCli(() => [INIT, reply("Keep [[Alpha Card]] and [[Beta's Card]].")]);
    const { send, idle, chat } = serve(fixture(), cli.runner);
    expect((await chat(1)).messages).toEqual([]);
    expect((await send(1, 'What is wrong?')).statusCode).toBe(202);
    const c = await idle(1);
    expect(c.messages.map((m) => m.role)).toEqual(['owner', 'claude']);
    expect(c.messages[1]!.data).toMatchObject({ cards: { 'Alpha Card': 'a', "Beta's Card": 'b' }, model: 'opus', usage: { input: 1, output: 2, cache_read: 3, cache_write: 4 }, session_cost_usd: 0.01, passes: 1 });
    expect(cli.calls[0]!.stdin).toBe('What is wrong?');
  });

  it('the first start uses --session-id, and each later start uses --resume with the same ID, also after a failed turn', async () => {
    const cli = fakeCli((_r, n) => (n === 0 ? [INIT, failed('API Error')] : [INIT, reply('ok')]));
    const { send, idle } = serve(fixture(), cli.runner);
    await send(1, 'one');
    await idle(1);
    await send(1, 'two');
    await idle(1);
    const id = flag(cli.calls[0]!, '--session-id')!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(cli.calls[0]!.args).not.toContain('--resume');
    expect(flag(cli.calls[1]!, '--resume')).toBe(id);
    expect(cli.calls[1]!.args).not.toContain('--session-id');
  });

  it('the arguments are the tested set: only the web tools, no project text, the model and effort of the config', () => {
    const a = cliArgs({ sessionId: 'id', resume: false, model: 'opus', effort: 'high', mcpConfig: '{}', systemPrompt: 'p' });
    for (const [k, v] of [['--tools', 'WebSearch,WebFetch'], ['--setting-sources', ''], ['--strict-mcp-config', '--allowedTools'], ['--allowedTools', 'mcp__deck__*,WebSearch,WebFetch'], ['--permission-mode', 'dontAsk'], ['--model', 'opus'], ['--effort', 'high'], ['--system-prompt', 'p'], ['--output-format', 'stream-json']]) {
      expect(a[a.indexOf(k!) + 1]).toBe(v);
    }
    expect(a).toContain('--verbose');
    expect(a[0]).toBe('-p');
    expect(loadChatConfig()).toMatchObject({ model: 'opus', effort: 'high', fallback_model: 'sonnet', rewrites: 1 });
  });

  it('the environment has no CLAUDE or ANTHROPIC name, and memory notes are off', () => {
    const env = cleanEnv({ PATH: 'p', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: 'x', ANTHROPIC_API_KEY: 'k', anthropic_base_url: 'u' });
    expect(env).toEqual({ PATH: 'p', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });

  it('a result with subtype success and is_error true is an error, and the chat shows the message of the CLI', async () => {
    const cli = fakeCli(() => [INIT, failed('You have reached your plan limit.')]);
    const { send, idle } = serve(fixture(), cli.runner);
    await send(1, 'hi');
    const c = await idle(1);
    expect(c.messages.map((m) => [m.role, m.text])).toEqual([['owner', 'hi'], ['error', 'You have reached your plan limit.']]);
  });

  it('a finished /compact shows a note and no error, and the next message resumes the session', async () => {
    const cli = fakeCli((_r, n) => (n === 0 ? [INIT, { type: 'system', subtype: 'compact_boundary' }, reply('')] : [INIT, reply('ok')]));
    const { send, idle } = serve(fixture(), cli.runner);
    await send(1, '/compact');
    const c = await idle(1);
    expect(c.messages.map((m) => m.role)).toEqual(['owner', 'note']);
    expect(c.messages[1]!.text).toMatch(/^You compacted this talk\./);
    await send(1, 'hi');
    const after = await idle(1);
    expect(after.messages.at(-1)!.role).toBe('claude');
    expect(flag(cli.calls[1]!, '--resume')).toBe(flag(cli.calls[0]!, '--session-id'));
  });

  it('/compact goes alone with an unread note and comment, and the next message carries them', async () => {
    const d = fixture();
    const cli = fakeCli((_r, n) => (n === 0 ? [INIT, { type: 'system', subtype: 'compact_boundary' }, reply('')] : [INIT, reply('ok')]));
    const { send, idle } = serve(d, cli.runner);
    saveComment(d, 1, 'a', 'This is the win condition.');
    ensureChat(d, 1, 'opus');
    addMessage(d, 1, 'note', 'You swapped: out 1 [[Alpha Card]], in 1 [[Swamp]].');
    await send(1, '/compact');
    const c = await idle(1);
    expect(cli.calls[0]!.stdin).toBe('/compact');
    expect(c.messages.at(-1)!.text).toMatch(/^You compacted this talk\./);
    expect(commentsOf(d, 1)[0]!.unread).toBe(1);
    await send(1, 'hi');
    await idle(1);
    expect(cli.calls[1]!.stdin).toContain('You swapped: out 1 [[Alpha Card]]');
    expect(cli.calls[1]!.stdin).toContain('You compacted this talk.');
    expect(cli.calls[1]!.stdin).toContain('This is the win condition.');
    expect(commentsOf(d, 1)[0]!.unread).toBe(0);
  });

  it('a /compact that gives a reply leaves the unread text for the next message', async () => {
    const d = fixture();
    const cli = fakeCli(() => [INIT, reply('Nothing to compact.')]);
    const { send, idle } = serve(d, cli.runner);
    saveComment(d, 1, 'a', 'This is the win condition.');
    await send(1, '/compact');
    await idle(1);
    expect(commentsOf(d, 1)[0]!.unread).toBe(1);
  });

  it('the context is the last model call of the turn against the limit of its model, and a compact gives the new size', async () => {
    const model = 'claude-opus-5-5';
    const start = { ...INIT, model };
    const limits = { modelUsage: { [model]: { contextWindow: 1000000 }, 'claude-haiku-5-5': { contextWindow: 200000 } } };
    const call = (read: number) => ({ type: 'assistant', message: { usage: { input_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: 8, output_tokens: 500 } } });
    const cli = fakeCli((_r, n) => {
      if (n === 0) return [start, call(100), call(900), { ...reply('one'), ...limits }];
      if (n === 1) return [start, { type: 'system', subtype: 'compact_boundary', compact_metadata: { post_tokens: 300 } }, { ...reply(''), ...limits }];
      return [start, reply('no limit in this result')];
    });
    const { send, idle, chat } = serve(fixture(), cli.runner);
    expect((await chat(1)).context).toBeNull();
    await send(1, 'one');
    expect((await idle(1)).context).toEqual({ used: 910, limit: 1000000 });
    await send(1, '/compact');
    expect((await idle(1)).context).toEqual({ used: 300, limit: 1000000 });
    await send(1, 'three');
    expect((await idle(1)).context).toEqual({ used: 300, limit: 1000000 });
  });

  it('an empty result stays an error when it is not a finished /compact', async () => {
    const noBoundary = fakeCli(() => [INIT, reply('')]);
    const a = serve(fixture(), noBoundary.runner);
    await a.send(1, '/compact');
    expect((await a.idle(1)).messages.map((m) => m.role)).toEqual(['owner', 'error']);
    const otherText = fakeCli(() => [INIT, { type: 'system', subtype: 'compact_boundary' }, reply('')]);
    const b = serve(fixture(), otherText.runner);
    await b.send(1, 'hi');
    expect((await b.idle(1)).messages.map((m) => m.role)).toEqual(['owner', 'error']);
  });

  it('a CLI that cannot start gives its message, and the talk stays usable', async () => {
    const runner: ChatRunner = () => ({ kill: () => {}, done: Promise.resolve({ code: null, stderr: 'The API could not start the claude CLI: spawn claude ENOENT' }) });
    const { send, idle } = serve(fixture(), runner);
    await send(1, 'hi');
    const c = await idle(1);
    expect(c.messages[1]).toMatchObject({ role: 'error', text: expect.stringContaining('ENOENT') });
    expect((await send(1, 'again')).statusCode).toBe(202);
  });

  it('the real start with no CLI on the path gives a message and does not throw', async () => {
    const lines: string[] = [];
    const run = spawnClaude({ args: [], cwd: tmpdir(), env: { PATH: '' }, stdin: 'hi', onLine: (l) => lines.push(l) });
    const exit = await run.done;
    expect(exit.code).toBeNull();
    expect(exit.stderr).toContain('could not start the claude CLI');
    expect(lines).toEqual([]);
  });

  it('a session that the CLI does not know starts again with --session-id, one time', async () => {
    const cli = fakeCli((_r, n) => (n === 0 ? [failed('No conversation found with session ID: x')] : [INIT, reply('ok')]));
    const d = fixture();
    ensureChat(d, 1, 'opus');
    d.prepare('UPDATE deck_chats SET started = 1 WHERE deck_id = 1').run();
    const { send, idle } = serve(d, cli.runner);
    await send(1, 'hi');
    const c = await idle(1);
    expect(cli.calls[0]!.args).toContain('--resume');
    expect(cli.calls[1]!.args).toContain('--session-id');
    expect(c.messages.map((m) => m.role)).toEqual(['owner', 'claude']);
  });

  it('a flag stops the talk on Opus until the owner chooses Sonnet, and the same session continues with the last message', async () => {
    const cli = fakeCli((req) => (flag(req, '--model') === 'opus' ? [INIT, failed('Claude Code safeguards flagged this message.')] : [INIT, reply('Back on Sonnet.')]));
    const { app, send, idle } = serve(fixture(), cli.runner);
    await send(1, 'hello');
    const c = await idle(1);
    expect(c.flagged).toBe(true);
    expect(c.messages.at(-1)).toMatchObject({ role: 'error', data: { flagged: true } });
    expect((await send(1, 'more')).statusCode).toBe(409);
    expect(cli.calls).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: '/api/decks/1/chat', payload: { continue_on_fallback: true } })).statusCode).toBe(202);
    const after = await idle(1);
    expect(after).toMatchObject({ model: 'sonnet', flagged: false });
    expect(after.messages.map((m) => m.role)).toEqual(['owner', 'error', 'note', 'claude']);
    expect(flag(cli.calls[1]!, '--model')).toBe('sonnet');
    expect(flag(cli.calls[1]!, '--resume')).toBe(flag(cli.calls[0]!, '--session-id'));
    expect(cli.calls[1]!.stdin).toContain('hello');
  });

  it('a false card name gets one rewrite', async () => {
    const cli = fakeCli((_r, n) => [INIT, n === 0 ? reply('Add [[No Such Card]].') : reply('Add [[Alpha Card]].')]);
    const { send, idle } = serve(fixture(), cli.runner);
    await send(1, 'hi');
    const c = await idle(1);
    expect(cli.calls).toHaveLength(2);
    expect(cli.calls[1]!.stdin).toContain('No Such Card');
    expect(c.messages.map((m) => m.role)).toEqual(['owner', 'step', 'claude']);
    expect(c.messages.at(-1)!.text).toBe('Add [[Alpha Card]].');
    expect(c.messages.at(-1)!.data).toMatchObject({ passes: 2, usage: { input: 2 } });
  });

  it('a false card name after the rewrite fails the turn, and no reply shows', async () => {
    const cli = fakeCli(() => [INIT, reply('Add [[No Such Card]].')]);
    const { send, idle } = serve(fixture(), cli.runner);
    await send(1, 'hi');
    const c = await idle(1);
    expect(cli.calls).toHaveLength(2);
    expect(c.messages.map((m) => m.role)).toEqual(['owner', 'step', 'error']);
    expect(c.messages.at(-1)!.text).toContain('No Such Card');
  });

  it('Stop ends a turn, and the next turn resumes the session', async () => {
    const cli = fakeCli((_r, n) => (n === 0 ? never().then(() => []) : [INIT, reply('ok')]));
    const { app, send, idle, chat } = serve(fixture(), cli.runner);
    await send(1, 'hi');
    expect((await chat(1)).running).toBe(true);
    expect((await send(1, 'second')).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/api/decks/1/chat/turn' })).json()).toEqual({ stopped: true });
    const c = await idle(1);
    expect(cli.kills).toEqual([0]);
    expect(c.messages.map((m) => m.role)).toEqual(['owner', 'note']);
    await send(1, 'again');
    await idle(1);
    expect(cli.calls[1]!.stdin).toContain('You stopped this turn.');
  });

  it('a new server ends a turn of the old server with an error, and the talk continues', async () => {
    const d = fixture();
    ensureChat(d, 1, 'opus');
    setTurnState(d, 1, 'running');
    const cli = fakeCli(() => [INIT, reply('ok')]);
    const { send, idle } = serve(d, cli.runner);
    const c = await idle(1);
    expect(c.messages.map((m) => m.role)).toEqual(['error']);
    expect(c.messages[0]!.text).toContain('server restarted');
    expect((await send(1, 'hi')).statusCode).toBe(202);
    await idle(1);
  });

  it('two decks do not share a talk or a session', async () => {
    const cli = fakeCli((req) => [INIT, reply(`I read: ${req.stdin}`)]);
    const { send, idle } = serve(fixture(), cli.runner);
    await send(1, 'for deck one');
    await send(2, 'for deck two');
    const [one, two] = [await idle(1), await idle(2)];
    expect(one.messages.map((m) => m.text)).toEqual(['for deck one', 'I read: for deck one']);
    expect(two.messages.map((m) => m.text)).toEqual(['for deck two', 'I read: for deck two']);
    expect(flag(cli.calls[0]!, '--session-id')).not.toBe(flag(cli.calls[1]!, '--session-id'));
  });

  it('a comment saves, stays after a reload, and empty text removes it', async () => {
    const d = fixture();
    const { app } = serve(d, fakeCli(() => []).runner);
    const put = (text: string, id = 'a') => app.inject({ method: 'PUT', url: `/api/decks/1/comments/${id}`, payload: { text } });
    expect((await put('  too slow  ')).statusCode).toBe(200);
    expect(((await app.inject({ url: '/api/decks/1' })).json() as { comments: unknown }).comments).toEqual({ a: 'too slow' });
    expect(((await app.inject({ url: '/api/decks/2' })).json() as { comments: unknown }).comments).toEqual({});
    expect((await put('x', 'x')).statusCode).toBe(404);
    expect((await put('')).statusCode).toBe(200);
    expect(commentsOf(d, 1)).toEqual([]);
  });

  it('Claude reads a new comment and a note with the next message, one time; a failed turn keeps them', async () => {
    const d = fixture();
    const cli = fakeCli((_r, n) => [INIT, n === 0 ? failed('API Error') : reply('ok')]);
    const { send, idle } = serve(d, cli.runner);
    saveComment(d, 1, 'a', 'This is the win condition.');
    ensureChat(d, 1, 'opus');
    addMessage(d, 1, 'note', 'You swapped: out 1 [[Alpha Card]], in 1 [[Swamp]].');
    await send(1, 'one');
    await idle(1);
    await send(1, 'two');
    await idle(1);
    await send(1, 'three');
    await idle(1);
    for (const n of [0, 1]) {
      expect(cli.calls[n]!.stdin).toContain('- [[Alpha Card]]: This is the win condition.');
      expect(cli.calls[n]!.stdin).toContain('You swapped');
    }
    expect(cli.calls[1]!.stdin.endsWith('Message of the owner:\ntwo')).toBe(true);
    expect(cli.calls[2]!.stdin).toBe('three');
  });

  it('a changed comment is new again, and the same text is not', () => {
    const d = fixture();
    saveComment(d, 1, 'a', 'one');
    d.prepare('UPDATE deck_card_comments SET unread = 0').run();
    saveComment(d, 1, 'a', 'one');
    expect(commentsOf(d, 1)[0]!.unread).toBe(0);
    saveComment(d, 1, 'a', 'two');
    expect(commentsOf(d, 1)[0]).toMatchObject({ text: 'two', unread: 1 });
  });

  it('the tool route answers as the tests of the CLI need, and only with the token of the live turn', async () => {
    let requested: RunRequest | null = null;
    let finish: (l: object[]) => void = () => {};
    const cli = fakeCli((req) => { requested = req; return new Promise((ok) => { finish = ok; }); });
    const { app, send, idle } = serve(fixture(), cli.runner);
    await send(1, 'hi');
    const token = bearer(requested!);
    const rpc = (payload: object, authorization = token, deck = 1) => app.inject({ method: 'POST', url: `/api/deck-chat-mcp/${deck}`, headers: { authorization }, payload });
    expect((await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } })).json()).toMatchObject({ id: 1, result: { protocolVersion: '2099-01-01', capabilities: { tools: {} } } });
    expect((await rpc({ method: 'notifications/initialized' })).statusCode).toBe(202);
    expect((await rpc({ id: 2, method: 'server/discover' })).json()).toMatchObject({ error: { code: -32601 } });
    expect((await app.inject({ method: 'GET', url: '/api/deck-chat-mcp/1' })).statusCode).toBe(405);
    expect((await rpc({ id: 3, method: 'ping' }, 'Bearer wrong')).statusCode).toBe(401);
    expect((await rpc({ id: 4, method: 'ping' }, token, 2)).statusCode).toBe(401);
    const list = (await rpc({ id: 5, method: 'tools/list' })).json() as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['deck_state', 'find_cards', 'card_detail', 'propose_swap', 'deck_links', 'propose_link_change', 'list_games', 'game_log']);
    const state = (await rpc({ id: 6, method: 'tools/call', params: { name: 'deck_state', arguments: {} } })).json() as { result: { content: Array<{ text: string }> } };
    expect(state.result.content[0]!.text).toContain("[[Beta's Card]]");
    expect(state.result.content[0]!.text).toContain('Target opponent discards a card.');
    expect(state.result.content[0]!.text).toContain('Beta has no link to the deck.');
    finish([INIT, reply('ok')]);
    const c = await idle(1);
    expect(c.messages.map((m) => m.role)).toEqual(['owner', 'step', 'claude']);
    expect((await rpc({ id: 7, method: 'ping' })).statusCode).toBe(401);
  });

  it('deck_state holds the comments', async () => {
    const d = fixture();
    saveComment(d, 1, 'b', 'Keep this one.');
    let text = '';
    const app = serve(d, fakeCli(async (req) => {
      const r = await app.inject({ method: 'POST', url: '/api/deck-chat-mcp/1', headers: { authorization: bearer(req) }, payload: { id: 1, method: 'tools/call', params: { name: 'deck_state', arguments: {} } } });
      text = (r.json() as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
      return [INIT, reply('ok')];
    }).runner).app;
    await app.inject({ method: 'POST', url: '/api/decks/1/chat', payload: { text: 'hi' } });
    for (let i = 0; i < 100 && !text; i++) await new Promise((ok) => setTimeout(ok, 5));
    expect(text).toContain('Owner comment: Keep this one.');
  });

  it('a swap box with no such message, and a body with no text, are refused', async () => {
    const { app } = serve(fixture(), fakeCli(() => []).runner);
    expect((await app.inject({ method: 'POST', url: '/api/decks/1/swap/99', payload: { choice: 'swap' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/decks/1/chat', payload: { text: '  ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/decks/9/chat', payload: { text: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/decks/1/undo', payload: {} })).statusCode).toBe(409);
  });

  it('a deck that leaves the database takes its talk with it', () => {
    const d = fixture();
    ensureChat(d, 1, 'opus');
    saveComment(d, 1, 'a', 'one');
    const message = addMessage(d, 1, 'swap', 'box', {});
    d.prepare("INSERT INTO deck_versions (deck_id, message_id, build_id, policy_sha, deck_json, created_at) VALUES (1, ?, 1, 'p', '{}', 't')").run(message);
    d.exec('PRAGMA foreign_keys = ON');
    d.exec('DELETE FROM decks WHERE id = 1');
    for (const t of ['deck_chats', 'deck_chat_messages', 'deck_card_comments', 'deck_versions']) {
      expect((d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
    }
  });

  it('the store keeps the messages in order', () => {
    const d = fixture();
    addMessage(d, 1, 'owner', 'one');
    addMessage(d, 2, 'owner', 'other deck');
    addMessage(d, 1, 'step', 'two', { a: 1 });
    expect(messagesOf(d, 1).map((m) => [m.text, m.data])).toEqual([['one', null], ['two', { a: 1 }]]);
  });
});

describe('card names (design sec. 3)', () => {
  const d = fixture();
  it('reads the whole name, the name of a face, any case and a curved apostrophe', () => {
    expect(cardByName(d, 'alpha card')).toEqual({ oracle_id: 'a', name: 'Alpha Card' });
    expect(cardByName(d, 'Beta’s Card')?.oracle_id).toBe('b');
    expect(cardByName(d, 'Yeti')).toEqual({ oracle_id: 'x', name: 'Xeno // Yeti' });
    expect(cardByName(d, 'Xeno // Yeti')?.oracle_id).toBe('x');
    expect(cardByName(d, 'Nothing')).toBeNull();
  });
  it('gives the card of each name and each false name once', () => {
    expect(checkNames(d, '[[Alpha Card]], [[No Card]], [[No Card]] and plain Beta.')).toEqual({ cards: { 'Alpha Card': 'a' }, bad: ['No Card'] });
    expect(checkNames(d, 'No marked name.')).toEqual({ cards: {}, bad: [] });
  });
});
