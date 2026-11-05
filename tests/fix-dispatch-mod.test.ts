import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API, jsonOf, poll, type Port, type Session } from '../.claude/skills/fix-dispatch/hooks/dispatch.js';
import { RETRY_MS, createFixRequest, getFixRequest } from '../src/graph/fixRequests.js';
import { buildServer } from '../src/server/app.js';
import { fixDeliveryState, sessionNameWarning } from '../src/web/lib/fixDelivery.js';
import { fixtureWithClauses } from './helpers/fixture.js';

// Owner request 2026-10-18: the fix-dispatch mod (.claude/skills/fix-dispatch) delivers each
// queued fix request to the Claude session with its title. Its poll runs here against the real
// routes; the session tools of the desktop app are fakes that record what the mod sent.

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const db = fixtureWithClauses('Draw a card.');
  const setId = Number(db.prepare(
    "INSERT INTO edge_rule_sets (version, schema_version, corpus_id, packet_sha, model, status, created_at) VALUES (1, 1, 1, 's', 'm', 'accepted', 't')",
  ).run().lastInsertRowid);
  const side = JSON.stringify({ family: 'PRODUCES', type_key: 'TOKEN', where: [] });
  db.prepare(
    `INSERT INTO edge_rules (set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status)
     VALUES (?, 'h1', 'ER-0001', '+', ?, ?, '[]', '[]', '[]', 3, 'accepted')`,
  ).run(setId, side, side);
  const dir = mkdtempSync(join(tmpdir(), 'fix-dispatch-mod-'));
  dirs.push(dir);
  let t = Date.parse('2026-10-18T12:00:00Z');
  const app = buildServer(db, { fixRequestDir: dir, now: () => t });
  const sent: Array<{ to: string; message: string }> = [];
  const submitted: string[] = [];
  let sessions: Session[] = [
    { sessionId: 'local_me', title: 'Dispatcher session', isArchived: false, self: true },
    { sessionId: 'local_old', title: 'First report fixer', isArchived: true },
    { sessionId: 'local_fixer', title: 'First report fixer', isArchived: false },
    { sessionId: 'local_gone', title: 'Gone session', isArchived: true },
  ];
  const port: Port = {
    async fetch(url, init) {
      expect(url.startsWith(API)).toBe(true);
      const r = await app.inject({
        method: (init?.method ?? 'GET') as 'GET' | 'POST', url: url.slice('http://127.0.0.1:8787'.length),
        ...(init?.headers ? { headers: init.headers } : {}), ...(init?.body !== undefined ? { payload: init.body } : {}),
      });
      return { ok: r.statusCode < 300, status: r.statusCode, text: r.body };
    },
    sessions: async () => sessions,
    async send(to, message) { sent.push({ to, message }); return `Message sent. (delivery: delivered; message_id: m${sent.length})`; },
    async submit(text) { submitted.push(text); },
  };
  const make = (name: string) => createFixRequest(db, () => null, dir, { session_name: name, rule_hashes: ['h1'] });
  return {
    db, app, port, sent, submitted, make,
    tick: (ms: number) => { t += ms; },
    setSessions: (s: Session[]) => { sessions = s; },
  };
}

describe('the fix-dispatch mod', () => {
  it('sends a new request to the open session with its title, and the request turns to sent', async () => {
    const s = setup();
    const r = s.make('  first REPORT fixer ');
    const out = await poll(s.port, 'me', false);
    expect(out.holds).toBe(true);
    expect(out.log).toEqual([`request ${r.id}: sent to "First report fixer"`]);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.to).toBe('local_fixer');
    expect(s.sent[0]!.message).toContain(`Fix request ${r.id}: the owner used "Fix this reason"`);
    expect(s.sent[0]!.message).toContain('**Language:** ASD-STE100');
    expect(s.sent[0]!.message).toContain(`/api/fix-requests/${r.id}/done`);
    expect(getFixRequest(s.db, r.id)).toMatchObject({ status: 'sent', session_id: 'local_fixer', delivery_error: null });
    expect((await poll(s.port, 'me', true)).log).toEqual([]);
    expect(s.sent).toHaveLength(1);
  });

  it('records a missing or archived session, shows it, and delivers when the session exists', async () => {
    const s = setup();
    const missing = s.make('Later session');
    const archived = s.make('Gone session');
    await poll(s.port, 'me', false);
    expect(s.sent).toEqual([]);
    const m = getFixRequest(s.db, missing.id);
    expect(m).toMatchObject({ status: 'queued', delivery_error: 'No Claude session has the title "Later session".' });
    expect(getFixRequest(s.db, archived.id).delivery_error).toBe('The session "Gone session" is archived. Unarchive it in the Claude app.');
    expect(fixDeliveryState(m, null)).toMatchObject({ label: 'not delivered', tone: 'failed' });

    // The holder reports the titles at its next poll; the form warns before the owner saves.
    s.tick(20_000);
    await poll(s.port, 'me', true);
    const view = ((await s.app.inject({ url: '/api/fix-requests' })).json() as { dispatcher: Parameters<typeof sessionNameWarning>[1] }).dispatcher;
    expect(sessionNameWarning('Later session', view)).toMatch(/^No open Claude session has the title "Later session"/);
    expect(sessionNameWarning('gone session', view)).toMatch(/is archived/);
    expect(sessionNameWarning('First report fixer', view)).toBeNull();

    s.setSessions([{ sessionId: 'local_me', title: 'Dispatcher session', isArchived: false, self: true },
      { sessionId: 'local_later', title: 'Later session', isArchived: false }]);
    s.tick(RETRY_MS);
    const out = await poll(s.port, 'me', true);
    expect(out.log).toContain(`request ${missing.id}: sent to "Later session"`);
    expect(s.sent.map((x) => x.to)).toEqual(['local_later']);
    expect(getFixRequest(s.db, missing.id)).toMatchObject({ status: 'sent', delivery_error: null });
  });

  it('queues the brief as a prompt when the request names the dispatcher session itself', async () => {
    const s = setup();
    const r = s.make('Dispatcher session');
    await poll(s.port, 'me', false);
    expect(s.sent).toEqual([]);
    expect(s.submitted).toHaveLength(1);
    expect(getFixRequest(s.db, r.id)).toMatchObject({ status: 'sent', session_id: 'local_me' });
  });

  it('records a failed send, and a second dispatcher gets nothing while the first holds the lease', async () => {
    const s = setup();
    const r = s.make('First report fixer');
    s.port.send = async () => 'Not delivered: the session is busy with an orchestrator.';
    expect(await poll(s.port, 'other', false)).toEqual({ holds: true, log: [expect.stringMatching(/could not send the brief/)] });
    expect(getFixRequest(s.db, r.id).delivery_error).toMatch(/^Claude could not send the brief to the session "First report fixer": Not delivered/);
    expect(await poll(s.port, 'me', false)).toEqual({ holds: false, log: [] });
  });

  it('reads the JSON of a tool text', () => {
    expect(jsonOf<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(jsonOf<number[]>('[1,2]')).toEqual([1, 2]);
    expect(() => jsonOf('nothing')).toThrow(/no JSON/);
  });
});
