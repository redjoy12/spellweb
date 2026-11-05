import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  DispatchLease, LEASE_MS, RETRY_MS, createFixRequest, dueFixRequests, failFixRequest, markFixRequest,
} from '../src/graph/fixRequests.js';
import { buildServer } from '../src/server/app.js';
import { fixtureWithClauses } from './helpers/fixture.js';

// Owner request 2026-10-18: the delivery of fix requests by the fix-dispatch mod
// (.claude/skills/fix-dispatch). The lease, the retry of a failed delivery, and the routes that
// the mod and the receiving session call, with empty bodies of each content type.

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const SIDE = (t: string) => JSON.stringify({ family: 'PRODUCES', type_key: t, where: [] });

function setup(): { db: DatabaseSync; dir: string } {
  const db = fixtureWithClauses('Draw a card.');
  const setId = Number(db.prepare(
    "INSERT INTO edge_rule_sets (version, schema_version, corpus_id, packet_sha, model, status, created_at) VALUES (1, 1, 1, 's', 'm', 'accepted', 't')",
  ).run().lastInsertRowid);
  db.prepare(
    `INSERT INTO edge_rules (set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status)
     VALUES (?, 'h1', 'ER-0001', '+', ?, ?, '[]', '[]', '[]', 3, 'accepted')`,
  ).run(setId, SIDE('TOKEN'), SIDE('TOKEN'));
  const dir = mkdtempSync(join(tmpdir(), 'fix-dispatch-'));
  dirs.push(dir);
  return { db, dir };
}

const none = () => null;
const T0 = Date.parse('2026-10-18T12:00:00Z');

describe('the dispatcher lease', () => {
  it('gives the lease to one dispatcher while it polls, and to another when the holder stops', () => {
    const l = new DispatchLease();
    expect(l.view()).toBeNull();
    expect(l.poll('a', T0)).toBe(true);
    expect(l.poll('b', T0 + 1000)).toBe(false);
    expect(l.poll('a', T0 + 20_000, [{ title: 'First report fixer', archived: false }])).toBe(true);
    expect(l.poll('b', T0 + 20_000 + LEASE_MS - 1)).toBe(false);
    expect(l.view()).toMatchObject({ holder: 'a', sessions: [{ title: 'First report fixer', archived: false }] });
    expect(l.poll('b', T0 + 20_000 + LEASE_MS)).toBe(true);
    expect(l.view()).toMatchObject({ holder: 'b', seen_at: new Date(T0 + 20_000 + LEASE_MS).toISOString() });
  });

  it('takes the lease from a holder that reports an error, at the next poll of another dispatcher', () => {
    const l = new DispatchLease();
    expect(l.poll('old', T0)).toBe(true);
    expect(l.poll('new', T0 + 1000)).toBe(false);
    expect(l.poll('old', T0 + 20_000, undefined, 'Claude cannot read the session list')).toBe(true);
    expect(l.view()).toMatchObject({ holder: 'old', error: 'Claude cannot read the session list' });
    expect(l.poll('new', T0 + 21_000)).toBe(true);
    expect(l.poll('old', T0 + 40_000, undefined, 'still failing')).toBe(false);
    expect(l.view()).toMatchObject({ holder: 'new', error: null });
    // Alone, a failing holder takes the lease again at each poll.
    const m = new DispatchLease();
    expect(m.poll('old', T0, undefined, 'e')).toBe(true);
    expect(m.poll('old', T0 + 20_000, undefined, 'e')).toBe(true);
  });
});

describe('a failed delivery', () => {
  it('records the reason, waits RETRY_MS, and a later delivery clears it', () => {
    const { db, dir } = setup();
    const r = createFixRequest(db, none, dir, { session_name: 'No such session', rule_hashes: ['h1'] });
    expect(dueFixRequests(db, new Date(T0)).map((x) => x.id)).toEqual([r.id]);
    const f = failFixRequest(db, r.id, 'No open Claude session has the title "No such session".', new Date(T0));
    expect(f).toMatchObject({ status: 'queued', delivery_error: 'No open Claude session has the title "No such session".', delivery_at: new Date(T0).toISOString() });
    expect(dueFixRequests(db, new Date(T0 + RETRY_MS - 1))).toEqual([]);
    expect(dueFixRequests(db, new Date(T0 + RETRY_MS)).map((x) => x.id)).toEqual([r.id]);
    const s = markFixRequest(db, r.id, 'sent', new Date(T0 + RETRY_MS), 'local_abc');
    expect(s).toMatchObject({ status: 'sent', session_id: 'local_abc', delivery_error: null, delivery_at: null });
    expect(() => failFixRequest(db, r.id, 'late')).toThrow(/sent, not queued/);
  });
});

describe('fix-request routes for the mod and the receiving session', () => {
  it('leases, delivers, fails and marks done; the POST routes take an empty body of any content type', async () => {
    const { db, dir } = setup();
    let t = T0;
    const app = buildServer(db, { fixRequestDir: dir, now: () => t });
    const a = createFixRequest(db, none, dir, { session_name: 'First report fixer', rule_hashes: ['h1'] });
    const b = createFixRequest(db, none, dir, { session_name: 'Gone session', rule_hashes: ['h1'] });

    expect((await app.inject({ url: '/api/fix-requests' })).json()).toMatchObject({ dispatcher: null });
    const poll = (dispatcher: string, sessions?: unknown) =>
      app.inject({ method: 'POST', url: '/api/fix-requests/dispatch', payload: { dispatcher, ...(sessions ? { sessions } : {}) } });
    expect((await poll('one')).json()).toMatchObject({ lease: true, items: [{ id: a.id }, { id: b.id }] });
    expect((await poll('two')).json()).toEqual({ lease: false, items: [] });
    expect((await app.inject({ method: 'POST', url: '/api/fix-requests/dispatch', payload: {} })).statusCode).toBe(400);

    const brief = await app.inject({ url: `/api/fix-requests/${a.id}/brief` });
    expect(brief.headers['content-type']).toMatch(/^text\/markdown/);
    expect(brief.body).toBe(readFileSync(a.brief_path, 'utf8'));
    expect(brief.body).toContain(`curl.exe -s -X POST http://127.0.0.1:8787/api/fix-requests/${a.id}/done`);
    expect((await app.inject({ url: '/api/fix-requests/999/brief' })).statusCode).toBe(404);

    const sent = await app.inject({ method: 'POST', url: `/api/fix-requests/${a.id}/sent`, payload: { session_id: 'local_x' } });
    expect(sent.json()).toMatchObject({ status: 'sent', session_id: 'local_x' });
    const failed = await app.inject({ method: 'POST', url: `/api/fix-requests/${b.id}/failed`, payload: { error: 'The session "Gone session" is archived.' } });
    expect(failed.json()).toMatchObject({ status: 'queued', delivery_error: 'The session "Gone session" is archived.' });
    expect((await app.inject({ method: 'POST', url: `/api/fix-requests/${b.id}/failed`, payload: {} })).statusCode).toBe(400);

    t += 20_000;
    expect((await poll('one', [{ title: 'First report fixer', archived: false }])).json()).toEqual({ lease: true, items: [] });
    t += RETRY_MS;
    expect((await poll('one')).json()).toMatchObject({ lease: true, items: [{ id: b.id }] });
    const list = (await app.inject({ url: '/api/fix-requests' })).json() as { dispatcher: { holder: string; sessions: unknown[] } };
    expect(list.dispatcher).toMatchObject({ holder: 'one', sessions: [{ title: 'First report fixer', archived: false }] });

    // The "done" call of the brief: PowerShell's Invoke-RestMethod sends a form content type with no
    // body (Fastify gave 415 before), curl sends no content type, and some clients send empty JSON.
    const empty = [
      { 'content-type': 'application/x-www-form-urlencoded' },
      {},
      { 'content-type': 'application/json' },
      { 'content-type': 'text/plain' },
    ];
    for (const headers of empty) {
      const r = await app.inject({ method: 'POST', url: `/api/fix-requests/${a.id}/done`, headers, payload: '' });
      expect(r.statusCode, JSON.stringify(headers)).toBe(200);
      expect(r.json()).toMatchObject({ status: 'done' });
    }
    const c = createFixRequest(db, none, dir, { session_name: 'x', rule_hashes: ['h1'] });
    const form = await app.inject({ method: 'POST', url: `/api/fix-requests/${c.id}/sent`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' });
    expect(form.json()).toMatchObject({ status: 'sent', session_id: null });
    const badJson = await app.inject({ method: 'POST', url: '/api/fix-requests', headers: { 'content-type': 'application/json' }, payload: '{nope' });
    expect(badJson.statusCode).toBe(400);
    await app.close();
  });
});
