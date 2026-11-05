import { beforeAll, afterAll, it, expect } from 'vitest';
import { restoreBuildCurrency } from './helpers/buildCurrency.js';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DB_PATH, openDb } from '../src/db/client.js';
import { reasonKey } from '../src/graph/fixRequests.js';
import { buildServer } from '../src/server/app.js';
import { maybe } from './helpers/realDb.js';

// Owner request 2026-10-18: the grouped reports and the fix-request API on a scratch copy of
// data/app.db with its newest graph build. The edges come from the API, never from memory.

interface Edge { key: string; rule_hashes: string[] }
interface Group {
  key: string; rule_hashes: string[]; report_count: number; reports: Array<{ id: number; note: string; supply_name: string; demand_name: string }>;
  rules: Array<{ rule_id: string; sentence: string; technical: string }>;
  links: { build_id: number; count: number; strong: number; card_pairs: number; examples: Array<{ supply_name: string; demand_name: string }> } | null;
  fix_requests: Array<{ id: number; status: string }>;
}

maybe('fix-request routes on a scratch copy of the real database', () => {
  let db: DatabaseSync;
  let dir = '';
  let app: ReturnType<typeof buildServer>;
  let buildId = 0;
  let edge: Edge;
  let before = 0;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'api-fix-'));
    const file = join(dir, 'app.db');
    copyFileSync(DB_PATH, file);
    for (const ext of ['-wal', '-shm']) if (existsSync(DB_PATH + ext)) copyFileSync(DB_PATH + ext, file + ext);
    db = openDb(file);
    const b = db.prepare('SELECT id FROM graph_builds ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined;
    if (!b) return;
    buildId = b.id;
    restoreBuildCurrency(db, buildId);
    app = buildServer(db, { fixRequestDir: join(dir, 'fix-requests') });
    // A card with few links, so the reason of its first link is cheap to count.
    const card = (db.prepare(
      `SELECT oracle_id FROM card_degree WHERE build_id = ? AND in_degree > 0 ORDER BY in_degree, oracle_id LIMIT 1`,
    ).get(buildId) as { oracle_id: string }).oracle_id;
    const body = (await app.inject({ url: `/api/graph/${buildId}/card/${card}` })).json() as { edges: { in: Edge[] } };
    edge = body.edges.in[0]!;
    before = (db.prepare("SELECT rule_hashes FROM edge_reports WHERE status = 'open'").all() as Array<{ rule_hashes: string }>)
      .filter((r) => reasonKey(JSON.parse(r.rule_hashes) as string[]) === reasonKey(edge.rule_hashes)).length;
    for (const note of ['first report', 'second report']) {
      const r = await app.inject({ method: 'POST', url: `/api/graph/${buildId}/reports`, payload: { edge_key: edge.key, note } });
      expect(r.statusCode).toBe(200);
    }
  }, 600_000);

  afterAll(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('groups the reports on one reason in one item, with the reason, the link count and examples', async () => {
    if (!buildId) return;
    const counts = (await app.inject({ url: '/api/edge-reports/counts' })).json() as { counts: Record<string, number> };
    expect(counts.counts[reasonKey(edge.rule_hashes)]).toBe(before + 2);
    const r = (await app.inject({ url: '/api/edge-reports/groups' })).json() as { build_id: number; groups: Group[] };
    expect(r.build_id).toBe(buildId);
    const g = r.groups.find((x) => x.key === reasonKey(edge.rule_hashes))!;
    expect(g.report_count).toBe(before + 2);
    expect(g.reports.map((x) => x.note).slice(-2)).toEqual(['first report', 'second report']);
    expect(g.reports.every((x) => x.supply_name && x.demand_name)).toBe(true);
    expect(g.rules.length).toBe(edge.rule_hashes.length);
    expect(g.rules[0]!.sentence).toMatch(/^A card that gives ".+" (helps|works against) a card that needs ".+"\.$/);
    expect(g.links).toMatchObject({ build_id: buildId });
    expect(g.links!.count).toBeGreaterThan(0);
    expect(g.links!.examples.length).toBeGreaterThan(0);
    expect(g.links!.examples.length).toBeLessThanOrEqual(5);
    expect((await app.inject({ url: '/api/edge-reports/groups?status=nope' })).statusCode).toBe(400);
  }, 600_000);

  it('creates, lists and marks a fix request, and writes the brief file', async () => {
    if (!buildId) return;
    const bad = await app.inject({ method: 'POST', url: '/api/fix-requests', payload: { session_name: 'x' } });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({ method: 'POST', url: '/api/fix-requests', payload: { session_name: 'x', rule_hashes: ['no-such-hash'] } });
    expect(unknown.statusCode).toBe(404);

    const c = await app.inject({
      method: 'POST', url: '/api/fix-requests',
      payload: { session_name: 'Test fix session', rule_hashes: edge.rule_hashes, build_id: buildId, edge_key: edge.key, note: 'owner note' },
    });
    expect(c.statusCode).toBe(200);
    const fr = c.json() as { id: number; status: string; brief_path: string; report_ids: number[]; session_name: string; edge_key: string };
    expect(fr).toMatchObject({ status: 'queued', session_name: 'Test fix session', edge_key: edge.key });
    expect(fr.report_ids.length).toBeGreaterThanOrEqual(2);
    expect(fr.brief_path).toBe(join(dir, 'fix-requests', `${fr.id}-test-fix-session.md`));
    const md = readFileSync(fr.brief_path, 'utf8');
    expect(md).toContain('**Language:** ASD-STE100');
    expect(md).toContain('> first report');
    expect(md).toContain('> second report');
    expect(md).toContain('> owner note');
    expect(md).toContain(`In build ${buildId}, this reason makes`);
    expect(md).toContain('## The link that the owner opened this request from');

    const q = (await app.inject({ url: '/api/fix-requests?status=queued' })).json() as { items: Array<{ id: number }>; session_names: string[] };
    expect(q.items.map((x) => x.id)).toContain(fr.id);
    expect(q.session_names).toContain('Test fix session');
    expect((await app.inject({ url: '/api/fix-requests?status=nope' })).statusCode).toBe(400);

    const s = await app.inject({ method: 'POST', url: `/api/fix-requests/${fr.id}/sent` });
    expect(s.json()).toMatchObject({ id: fr.id, status: 'sent', sent_at: expect.any(String) });
    const again = await app.inject({ method: 'POST', url: `/api/fix-requests/${fr.id}/sent` });
    expect(again.json()).toMatchObject({ status: 'sent', sent_at: (s.json() as { sent_at: string }).sent_at });
    expect(((await app.inject({ url: '/api/fix-requests?status=queued' })).json() as { items: Array<{ id: number }> }).items.map((x) => x.id))
      .not.toContain(fr.id);
    expect((await app.inject({ method: 'POST', url: `/api/fix-requests/${fr.id}/done` })).json()).toMatchObject({ status: 'done' });
    expect((await app.inject({ method: 'POST', url: `/api/fix-requests/${fr.id}/sent` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/fix-requests/99999/sent' })).statusCode).toBe(404);

    const g = ((await app.inject({ url: '/api/edge-reports/groups' })).json() as { groups: Group[] }).groups
      .find((x) => x.key === reasonKey(edge.rule_hashes))!;
    expect(g.fix_requests.find((x) => x.id === fr.id)).toMatchObject({ status: 'done' });
  }, 600_000);
});
