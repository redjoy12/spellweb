import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { restoreBuildCurrency } from './helpers/buildCurrency.js';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DB_PATH, openDb } from '../src/db/client.js';
import { retireStaleEdgeReports } from '../src/graph/edgeQueue.js';
import { buildServer } from '../src/server/app.js';
import { maybe } from './helpers/realDb.js';

// Plan Task 7 Steps 1 and 3, on a scratch copy of data/app.db with its stored graph build
// (plan "Test database rule"). The cards come from card_degree by query, never from memory.

/** A scratch copy of data/app.db; the builds stay. */
function scratch(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'api-graph-'));
  const file = join(dir, 'app.db');
  copyFileSync(DB_PATH, file);
  for (const ext of ['-wal', '-shm']) if (existsSync(DB_PATH + ext)) copyFileSync(DB_PATH + ext, file + ext);
  return { db: openDb(file), dir };
}

interface Face { face_index: number; oracle_text: string }
interface Side { oracle_id: string; face_index: number; span: [number, number]; quote: string }
interface EdgeView {
  key: string; polarity: '+' | '-'; grade: 'confirmed' | 'plausible'; unresolved: string[];
  supply: Side | null; demand: Side & { atom_id: number };
  class: { id: string; member_count: number } | null; rule_hashes: string[];
  weight: { total: number };
}
interface CardBody {
  build: { id: number; scope: string; stale: boolean };
  cards: Record<string, { name: string; faces: Face[] }>;
  rules: Record<string, { rule_id: string; evidence: Array<{ quote: string }> }>;
  edges: { out: EdgeView[]; in: EdgeView[]; classes: EdgeView[]; anti: EdgeView[] };
}

maybe('graph routes on a scratch copy of the real database (plan Task 7)', () => {
  let s: { db: DatabaseSync; dir: string };
  let app: ReturnType<typeof buildServer>;
  let buildId = 0;
  let top = '';
  let antiCard = '';
  let classCard = '';
  let body: CardBody;

  beforeAll(async () => {
    s = scratch();
    // The newest build, with its atoms made current again on the scratch copy (a re-extraction
    // demotes them: plan Task 8 requeues, schema v15 run 22).
    const b = s.db.prepare('SELECT id FROM graph_builds ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined;
    if (!b) return;
    buildId = b.id;
    restoreBuildCurrency(s.db, buildId);
    const pick = (where: string) => (s.db.prepare(
      `SELECT oracle_id FROM card_degree WHERE build_id = ? AND ${where} ORDER BY out_degree + in_degree DESC, oracle_id LIMIT 1`,
    ).get(buildId) as { oracle_id: string }).oracle_id;
    top = pick('1 = 1');
    antiCard = pick('anti_degree > 0');
    classCard = pick('class_edges > 0');
    app = buildServer(s.db);
    body = (await app.inject({ url: `/api/graph/${buildId}/card/${top}` })).json() as CardBody;
  }, 600_000);

  afterAll(() => {
    s?.db.close();
    if (s) rmSync(s.dir, { recursive: true, force: true });
  });

  const allEdges = (b: CardBody) => [...b.edges.out, ...b.edges.in, ...b.edges.classes, ...b.edges.anti];
  const textAt = (b: CardBody, side: Side) =>
    b.cards[side.oracle_id]!.faces.find((f) => f.face_index === side.face_index)!.oracle_text.slice(side.span[0], side.span[1]);

  it('lists the builds with scope, key, counts and the stale flag', async () => {
    if (!buildId) return;
    const r = (await app.inject({ url: '/api/graph/builds' })).json() as { builds: Array<Record<string, unknown>> };
    const b = r.builds.find((x) => x['id'] === buildId)!;
    expect(b).toMatchObject({ scope: expect.any(String), build_key: expect.any(String), stale: expect.any(Boolean) });
    expect(b['counts']).toHaveProperty('synergy_pairs');
  });

  it('gives edges whose supply and demand quotes are the oracle text at the given spans', () => {
    if (!buildId) return;
    expect(body.build.id).toBe(buildId);
    const edges = allEdges(body);
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(textAt(body, e.demand)).toBe(e.demand.quote);
      if (e.supply) expect(textAt(body, e.supply)).toBe(e.supply.quote);
    }
  });

  it('gives each edge one or more rule IDs, and each rule one or more evidence quotes', () => {
    if (!buildId) return;
    for (const e of allEdges(body)) {
      expect(e.rule_hashes.length).toBeGreaterThan(0);
      for (const h of e.rule_hashes) {
        expect(body.rules[h]!.rule_id).toMatch(/\S/);
        expect(body.rules[h]!.evidence.length).toBeGreaterThan(0);
      }
    }
  });

  it('gives each card view its image URL field, also on each face', () => {
    if (!buildId) return;
    const views = Object.values(body.cards) as Array<{ image?: unknown; faces: Array<Face & { image?: unknown }> }>;
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) {
      expect(v).toHaveProperty('image');
      for (const f of v.faces) expect(f).toHaveProperty('image');
    }
    expect(views.some((v) => typeof v.image === 'string')).toBe(true);
  });

  it('gives the vocabulary label of each type that an edge of the card uses', async () => {
    if (!buildId) return;
    const r = (await app.inject({ url: '/api/graph/labels' })).json() as { labels: Record<string, string> };
    const row = s.db.prepare('SELECT family, type_key, label FROM atom_types ORDER BY schema_version DESC LIMIT 1')
      .get() as { family: string; type_key: string; label: string };
    expect(r.labels[`${row.family}.${row.type_key}`]).toBe(row.label);
    const demand = s.db.prepare('SELECT family, type_key FROM atoms WHERE id = ?')
      .get(body.edges.in[0]?.demand.atom_id ?? body.edges.out[0]!.demand.atom_id) as { family: string; type_key: string };
    expect(r.labels[`${demand.family}.${demand.type_key}`]).toMatch(/\S/);
  });

  it('lists the unresolved params of a plausible edge', () => {
    if (!buildId) return;
    const plausible = allEdges(body).filter((e) => e.grade === 'plausible');
    expect(plausible.length).toBeGreaterThan(0);
    for (const e of plausible) expect(e.unresolved.length).toBeGreaterThan(0);
    for (const e of allEdges(body).filter((x) => x.grade === 'confirmed')) expect(e.unresolved).toEqual([]);
  });

  it('puts the anti edges in their own list', async () => {
    if (!buildId) return;
    const b = (await app.inject({ url: `/api/graph/${buildId}/card/${antiCard}` })).json() as CardBody;
    expect(b.edges.anti.length).toBeGreaterThan(0);
    expect(b.edges.anti.every((e) => e.polarity === '-')).toBe(true);
    expect([...b.edges.out, ...b.edges.in, ...b.edges.classes].every((e) => e.polarity === '+')).toBe(true);
  });

  it('gives the member count of a class edge, and the class route gives the members', async () => {
    if (!buildId) return;
    const b = (await app.inject({ url: `/api/graph/${buildId}/card/${classCard}` })).json() as CardBody;
    const e = b.edges.classes[0]!;
    expect(e.class!.member_count).toBeGreaterThan(0);
    expect(e.supply).toBeNull();
    const r = await app.inject({ url: `/api/graph/${buildId}/class/${encodeURIComponent(e.class!.id)}?limit=5` });
    const c = r.json() as { total: number; members: Array<{ oracle_id: string; name: string }> };
    expect(c.total).toBe(e.class!.member_count);
    expect(c.members.length).toBe(Math.min(5, c.total));
    expect(c.members[0]!.name).toMatch(/\S/);
  });

  it('gives the same cycle body two times', async () => {
    if (!buildId) return;
    const url = `/api/graph/${buildId}/cycles?card=${top}`;
    const one = await app.inject({ url });
    const two = await app.inject({ url });
    expect(one.statusCode).toBe(200);
    expect(two.body).toBe(one.body);
    const c = one.json() as { engine: { exact: boolean; cycles: Array<{ tier: number }> }; full: { cycles: unknown[] }; more_engine: boolean };
    expect(typeof c.engine.exact).toBe('boolean');
    for (const x of c.engine.cycles) expect([1, 2, 3]).toContain(x.tier);
  }, 120_000);

  it('gives the gaps sorted by count from high to low', async () => {
    if (!buildId) return;
    const g = (await app.inject({ url: `/api/graph/${buildId}/gaps` })).json() as { gaps: Array<{ count: number }> };
    expect(g.gaps.length).toBeGreaterThan(0);
    for (let i = 1; i < g.gaps.length; i++) expect(g.gaps[i]!.count).toBeLessThanOrEqual(g.gaps[i - 1]!.count);
  });

  it('gives the current rule set and the roles, with the queue item of a disputed rule', async () => {
    if (!buildId) return;
    const r = (await app.inject({ url: '/api/edge-rules' })).json() as {
      set: { id: number }; rules: Array<{ status: string; queue: { id: number } | null }>; roles: unknown[];
    };
    expect(r.set.id).toBeGreaterThan(0);
    expect(r.rules.length).toBeGreaterThan(0);
    expect(r.roles.length).toBeGreaterThan(0);
    const disputed = r.rules.filter((x) => x.status === 'disputed');
    if (disputed.length) expect(disputed.some((x) => x.queue !== null)).toBe(true);
  });

  it('refuses a report with an unknown edge key or an empty note', async () => {
    if (!buildId) return;
    const e = body.edges.out[0]!;
    const bad = await app.inject({ method: 'POST', url: `/api/graph/${buildId}/reports`, payload: { edge_key: '+|x#0#0|0|1|1', note: 'n' } });
    expect(bad.statusCode).toBe(404);
    const empty = await app.inject({ method: 'POST', url: `/api/graph/${buildId}/reports`, payload: { edge_key: e.key, note: ' ' } });
    expect(empty.statusCode).toBe(400);
  });

  it('a report writes one edge_reports row and one edge queue row with build_id', async () => {
    if (!buildId) return;
    const e = body.edges.out[0]!;
    const r = await app.inject({ method: 'POST', url: `/api/graph/${buildId}/reports`, payload: { edge_key: e.key, note: 'test note' } });
    expect(r.statusCode).toBe(200);
    const rows = s.db.prepare('SELECT * FROM edge_reports WHERE edge_key = ?').all(e.key) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ build_id: buildId, status: 'open', note: 'test note', supply_oracle: e.supply!.oracle_id, demand_oracle: e.demand.oracle_id });
    const q = s.db.prepare("SELECT * FROM review_queue WHERE domain = 'edge' AND detail_table = 'edge_reports' AND detail_id = ?")
      .all(Number(rows[0]!['id'])) as Array<Record<string, unknown>>;
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ severity: 'edge_report', build_id: buildId, status: 'pending' });
  });

  it('the stale flag is true after the current atoms change, and the report of a demoted atom becomes stale', async () => {
    if (!buildId) return;
    const [a, b] = [body.edges.out[0]!, body.edges.in.find((x) => x.demand.atom_id !== body.edges.out[0]!.demand.atom_id)!];
    await app.inject({ method: 'POST', url: `/api/graph/${buildId}/reports`, payload: { edge_key: b.key, note: 'second' } });
    s.db.prepare('UPDATE atoms SET is_current = 0 WHERE id = ?').run(a.demand.atom_id);
    const r = (await app.inject({ url: '/api/graph/builds' })).json() as { builds: Array<{ id: number; stale: boolean }> };
    expect(r.builds.find((x) => x.id === buildId)!.stale).toBe(true);
    const status = (key: string) => (s.db.prepare('SELECT status FROM edge_reports WHERE edge_key = ?').get(key) as { status: string }).status;
    expect(status(a.key)).toBe('stale');
    expect(status(b.key)).toBe('open');
    const q = s.db.prepare(`SELECT q.status FROM review_queue q JOIN edge_reports r ON r.id = q.detail_id
                             WHERE q.detail_table = 'edge_reports' AND r.edge_key = ?`);
    expect((q.get(a.key) as { status: string }).status).toBe('resolved');
    expect((q.get(b.key) as { status: string }).status).toBe('pending');
    const card = (await app.inject({ url: `/api/graph/${buildId}/card/${top}` })).json() as CardBody;
    expect(card.build.stale).toBe(true);
  });

  it('retires a report when a supply atom of its edge is no longer current', () => {
    if (!buildId) return;
    const b = body.edges.in.find((x) => x.demand.atom_id !== body.edges.out[0]!.demand.atom_id)!;
    const supply = s.db.prepare(
      `SELECT a.id FROM atoms a JOIN graph_build_atoms g ON g.atom_id = a.id AND g.build_id = ?
        WHERE a.oracle_id = ? AND a.face_index = ? AND a.span_start = ? AND a.span_end = ?`,
    ).all(buildId, b.supply!.oracle_id, b.supply!.face_index, b.supply!.span[0], b.supply!.span[1]) as Array<{ id: number }>;
    expect(supply.length).toBeGreaterThan(0);
    s.db.prepare('UPDATE atoms SET is_current = 0 WHERE id = ?').run(supply[0]!.id);
    expect(retireStaleEdgeReports(s.db)).toBe(1);
    expect((s.db.prepare('SELECT status FROM edge_reports WHERE edge_key = ?').get(b.key) as { status: string }).status).toBe('stale');
    expect(retireStaleEdgeReports(s.db)).toBe(0);
  });
});

describe('retireStaleEdgeReports without reports', () => {
  it('retires nothing on an empty database', () => {
    const db = openDb(':memory:');
    expect(retireStaleEdgeReports(db)).toBe(0);
    db.close();
  });
});
