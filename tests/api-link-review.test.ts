import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, openDb } from '../src/db/client.js';
import { newestBuild, withWeakAnswers } from '../src/deck/deck.js';
import type { DeckView } from '../src/deck/justify.js';
import {
  applyRequestText, closeRequest, LINK_CHECK_MESSAGE, LinkChangeError, markApplied, sendQuestion, writeOwnerLink, type LinkChangesPage, type ApplyRequestView,
} from '../src/deck/linkChanges.js';
import { OWNER_KEY, type PairTable } from '../src/deck/pairs.js';
import { loadDeckPolicy } from '../src/deck/policy.js';
import { buildServer } from '../src/server/app.js';
import type { ChatRunner, RunRequest } from '../src/server/chat/turn.js';
import { tableOf } from '../src/server/routes/decks.js';
import { indexOfBuild } from '../src/server/routes/graph.js';
import { maybe } from './helpers/realDb.js';

const INIT = { type: 'system', subtype: 'init' };
const reply = (result: string) => ({ type: 'result', subtype: 'success', is_error: false, result, usage: {}, num_turns: 1 });
interface ToolAnswer { result: { content: Array<{ text: string }>; isError?: boolean } }
interface Chat { running: boolean; messages: Array<{ role: string; text: string }> }

// Link review design sec. 5 to 8, on a VACUUM INTO copy of data/app.db, with a replaced CLI. No real
// Claude session runs, so the real deck sessions do not change.
maybe('the link review on a copy of the real database', () => {
  let dir = '';
  let db: DatabaseSync;
  let app: ReturnType<typeof buildServer>;
  let id = 0;
  let deck: DeckView;
  let script: (tool: (name: string, args?: object) => Promise<ToolAnswer['result']>) => Promise<string> = async () => 'ok';
  const policy = loadDeckPolicy();
  const table = (): PairTable => withWeakAnswers(db, tableOf(db, newestBuild(db)), policy);

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

  const waitTurn = async (): Promise<Chat> => {
    for (let i = 0; i < 2000; i++) {
      const c = (await app.inject({ url: `/api/decks/${id}/chat` })).json() as Chat;
      if (!c.running) return c;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    throw new Error('the turn did not end');
  };
  // Only the items of the test deck: the real database can hold suggestions of the owner.
  const page = async () => {
    const p = (await app.inject({ url: '/api/link-changes' })).json() as LinkChangesPage;
    return { ...p, items: p.items.filter((s) => s.deck_id === id) };
  };
  let approvedBefore = 0;
  const answer = (sid: number, a: string, note = '') => app.inject({ method: 'POST', url: `/api/link-changes/${sid}/answer`, payload: { answer: a, note } });

  // The cards of the test: a + link of the deck, a pair of spells with no link, and a land.
  let linked: [string, string] = ['', ''];
  let unlinked: [string, string] = ['', ''];
  const name = (oracle: string) => deck.cards.find((c) => c.oracle_id === oracle)!.name;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'api-link-review-'));
    const file = join(dir, 'app.db');
    const src = new DatabaseSync(DB_PATH, { readOnly: true });
    try { src.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); } finally { src.close(); }
    db = openDb(file);
    const b = newestBuild(db);
    const seed = (db.prepare(
      `SELECT c.oracle_id FROM card_degree d JOIN cards c USING (oracle_id)
        WHERE d.build_id = ? AND c.rotated = 0 AND c.arena_id IS NOT NULL AND c.cmc BETWEEN 1 AND 4 AND c.type_line NOT LIKE '%Land%'
        ORDER BY d.out_degree + d.in_degree DESC, c.oracle_id LIMIT 1`,
    ).get(b) as { oracle_id: string }).oracle_id;
    app = buildServer(db, { chatRunner: runner });
    const r = await app.inject({ method: 'POST', url: '/api/decks', payload: { colours: 'BR', seeds: [seed], target_turn: 6, interaction: 'some' } });
    expect(r.statusCode).toBe(201);
    ({ id, deck } = r.json() as { id: number; deck: DeckView });
    const t = table();
    const spells = deck.cards.filter((c) => c.role !== 'land').map((c) => c.oracle_id);
    for (const a of spells) for (const x of spells) {
      if (a === x) continue;
      if (!linked[0] && t.pos.get(a)?.has(x)) linked = [a, x];
      if (!unlinked[0] && !t.linked.get(a)?.has(x)) unlinked = [a, x];
    }
    expect(linked[0] && unlinked[0]).toBeTruthy();
  }, 600_000);

  afterAll(async () => {
    await app?.close();
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('the check sends the fixed message, deck_links gives all links, and propose_link_change checks each suggestion', async () => {
    const out: Record<string, ToolAnswer['result']> = {};
    script = async (tool) => {
      out['links'] = await tool('deck_links');
      out['delete'] = await tool('propose_link_change', { kind: 'delete', supply: name(linked[0]), demand: name(linked[1]), reason: 'They do not help each other.' });
      out['add'] = await tool('propose_link_change', { kind: 'add', supply: name(unlinked[0]), demand: name(unlinked[1]), reason: 'The first card feeds the second card.' });
      out['weak'] = await tool('propose_link_change', { kind: 'correct', change: 'weak', supply: name(linked[0]), demand: name(linked[1]), reason: 'The cost is high.' });
      out['add_exists'] = await tool('propose_link_change', { kind: 'add', supply: name(linked[0]), demand: name(linked[1]), reason: 'x' });
      out['delete_none'] = await tool('propose_link_change', { kind: 'delete', supply: name(unlinked[0]), demand: name(unlinked[1]), reason: 'x' });
      out['dup'] = await tool('propose_link_change', { kind: 'delete', supply: name(linked[0]), demand: name(linked[1]), reason: 'again' });
      const land = deck.cards.find((c) => c.role === 'land')!;
      out['land'] = await tool('propose_link_change', { kind: 'add', supply: land.name, demand: name(linked[1]), reason: 'x' });
      out['no_change'] = await tool('propose_link_change', { kind: 'correct', supply: name(linked[0]), demand: name(linked[1]), reason: 'x' });
      return 'I wrote 3 suggestions.';
    };
    expect((await app.inject({ method: 'POST', url: `/api/decks/${id}/link-check`, payload: {} })).statusCode).toBe(202);
    const chat = await waitTurn();
    expect(chat.messages.some((m) => m.role === 'owner' && m.text === LINK_CHECK_MESSAGE)).toBe(true);
    expect(chat.messages.some((m) => m.role === 'step' && m.text.startsWith('Wrote link suggestion'))).toBe(true);
    expect(out['links']!.content[0]!.text).toMatch(/^Links of deck \d+ on build \d+: \d+ good together/);
    expect(out['links']!.content[0]!.text).toContain(`[[${name(linked[0])}]] helps [[${name(linked[1])}]]`);
    for (const k of ['delete', 'add', 'weak']) expect(out[k]!.isError, k).toBeUndefined();
    for (const k of ['add_exists', 'delete_none', 'dup', 'land', 'no_change']) expect(out[k]!.isError, k).toBe(true);
    expect(out['add_exists']!.content[0]!.text).toContain('already has a + link');
    expect(out['land']!.content[0]!.text).toContain('not a spell of this deck');
  }, 120_000);

  it('the tab shows the items with the cards and the link; an answer changes no link', { timeout: 60_000 }, async () => {
    const before = table().pos.get(linked[0])?.get(linked[1])?.key;
    const p = await page();
    expect(p.items).toHaveLength(3);
    const del = p.items.find((s) => s.kind === 'delete')!;
    expect(del.supply.name).toBe(name(linked[0]));
    expect(del.supply.text.length).toBeGreaterThan(0);
    expect(del.link?.key).toBe(before);
    approvedBefore = p.to_apply.suggestions;
    expect((await answer(del.id, 'yes', 'no real link')).statusCode).toBe(200);
    const add = p.items.find((s) => s.kind === 'add')!;
    expect((await answer(add.id, 'weak')).statusCode).toBe(200);
    const cor = p.items.find((s) => s.kind === 'correct')!;
    expect((await answer(cor.id, 'weak')).statusCode).toBe(400);
    expect((await answer(cor.id, 'no')).statusCode).toBe(200);
    const after = await page();
    expect(after.items.find((s) => s.id === cor.id)!.state).toBe('rejected');
    expect(after.items.find((s) => s.id === del.id)!.owner_note).toBe('no real link');
    expect(after.to_apply.suggestions).toBe(approvedBefore + 2);
    expect(table().pos.get(linked[0])?.get(linked[1])?.key).toBe(before);
  });

  it('an apply request takes the approved items and the free reports, gives the desktop link, and a cancel returns the items', { timeout: 60_000 }, async () => {
    const reports = (await page()).to_apply.reports;
    const r1 = (await app.inject({ method: 'POST', url: '/api/link-apply', payload: {} })).json() as ApplyRequestView;
    expect(r1).toMatchObject({ state: 'open', suggestions: approvedBefore + 2, reports });
    expect(r1.link.startsWith('claude://code/new?q=')).toBe(true);
    expect(r1.prompt).toContain(`--show ${r1.id}`);
    const again = (await app.inject({ method: 'POST', url: '/api/link-apply', payload: {} })).json() as ApplyRequestView;
    expect(again.id).toBe(r1.id);
    const p = await page();
    expect(p.open_request?.id).toBe(r1.id);
    expect(p.items.filter((s) => s.state === 'in_request')).toHaveLength(2);
    const del = p.items.find((s) => s.kind === 'delete')!;
    expect((await answer(del.id, 'no')).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/link-apply/${r1.id}/cancel`, payload: {} })).statusCode).toBe(200);
    expect((await page()).items.filter((s) => s.state === 'answered')).toHaveLength(2);
    const r2 = (await app.inject({ method: 'POST', url: '/api/link-apply', payload: {} })).json() as ApplyRequestView;
    expect(r2.id).not.toBe(r1.id);
    expect(r2.reports).toBe(reports);
  });

  it('the apply session writes owner links that a new deck reads, marks the items, and closes the request', async () => {
    const p = await page();
    const req = p.open_request!;
    const del = p.items.find((s) => s.kind === 'delete')!;
    const add = p.items.find((s) => s.kind === 'add')!;
    const text = applyRequestText(db, indexOfBuild(db)(newestBuild(db))!, table(), new Set(), req.id);
    expect(text).toContain(`## Suggestion ${del.id}: delete a + link`);
    expect(text).toContain('Card pairs of this rule on build');
    expect(text).toContain('Owner note: "no real link"');
    const block = writeOwnerLink(db, del.id);
    const plus = writeOwnerLink(db, add.id);
    const t = table();
    expect(t.pos.get(linked[0])?.get(linked[1])).toBeUndefined();
    expect(t.pos.get(unlinked[0])?.get(unlinked[1])).toMatchObject({ key: `${OWNER_KEY}${plus}`, weak: true });
    expect(t.pos.get(unlinked[0])?.get(unlinked[1])?.weight).toBeCloseTo(policy.score.owner_link_weight * policy.score.weak_factor);
    expect(() => closeRequest(db, req.id, 'x')).toThrow(LinkChangeError);
    markApplied(db, [del.id], 'block on this pair', null);
    sendQuestion(db, add.id, 'Is the token always made?');
    // The request also takes the answered suggestions of the owner on the real database; on this copy
    // they go back with a question, so the request can close.
    const others = db.prepare("SELECT id FROM link_suggestions WHERE apply_id = ? AND state = 'in_request'").all(req.id) as Array<{ id: number }>;
    for (const o of others) sendQuestion(db, o.id, 'not part of this test');
    closeRequest(db, req.id, 'docs/link-apply-results.md sec. 1');
    const after = await page();
    expect(after.open_request).toBeNull();
    expect(after.items.find((s) => s.id === add.id)).toMatchObject({ state: 'question', question: 'Is the token always made?', apply_id: null });
    // A new deck with the same goal reads the owner link, and the page can remove it.
    expect((await app.inject({ method: 'DELETE', url: `/api/owner-links/${block}` })).json()).toEqual({ removed: true });
    expect((await app.inject({ method: 'DELETE', url: `/api/owner-links/${block}` })).statusCode).toBe(404);
    expect(table().pos.get(linked[0])?.get(linked[1])).toBeDefined();
  }, 300_000);
});

describe('the link review route without a database', () => {
  it('a missing deck gives 404 for the check', async () => {
    const db = openDb(':memory:');
    const app = buildServer(db);
    expect((await app.inject({ method: 'POST', url: '/api/decks/99999/link-check', payload: {} })).statusCode).toBe(404);
    await app.close();
    db.close();
  });
});
