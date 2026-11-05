/**
 * The graph routes (Phase 3 spec sec. 13.1-13.4, plan Task 7): the builds, the edges of one
 * card, the members of a class, the cycles of one card, the gap report, the score of a build
 * and the edge reports. `GET /api/edge-rules` is in edgeRules.ts (D12).
 *
 * Each build has one BuildIndex in a server cache (D10), with its cycle graphs and its balance
 * context. The routes use the atoms of the build, not the current atoms (sec. 7.1); the stale
 * flag says when the two differ. The server is bound to 127.0.0.1.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { balanceContext, cycleBalance, type BalanceContext } from '../../graph/balance.js';
import { atomSetSha, BuildIndex, currentScopeAtoms } from '../../graph/buildIndex.js';
import { cardCycles, cycleGraphs, type CycleGraphs, type SearchOut, type TieredCycle } from '../../graph/cardCycles.js';
import type { CycleGraph } from '../../graph/cycleGraph.js';
import { enqueueEdgeFinding, retireStaleEdgeReports } from '../../graph/edgeQueue.js';
import type { Scope } from '../../graph/intrinsic.js';
import { parseMergeKey, type MergedEdge } from '../../graph/merge.js';
import { loadGraphPolicy } from '../../graph/policy.js';
import { setRules, type StoredRule } from '../../graph/ruleSet.js';
import { fullScore, type FullScore } from '../../graph/score.js';
import { loadTextTests } from '../../graph/textTests.js';
import { groupAtomSha, pickAtomSet } from '../../graph/groups.js';

/** spec sec. 12.2: the bar of the synergy recall and of the confirmed precision. */
const SCORE_BAR = 0.9;

interface BuildRow { id: number; rule_set_id: number; scope: Scope; tests_version: number; atom_set_sha: string }

interface Cached {
  row: BuildRow;
  index: BuildIndex;
  rules: Map<string, StoredRule>;
  /** The cycle graphs, by the `confirmed` flag; made on the first cycle request. */
  graphs: Map<boolean, CycleGraphs>;
  balance?: BalanceContext;
  score?: ScoreView;
}

/** One cache for each database, so two servers on two databases never share an index. */
const caches = new WeakMap<DatabaseSync, Map<number, Cached>>();

function cachedBuild(db: DatabaseSync, buildId: number): Cached | null {
  let m = caches.get(db);
  if (!m) { m = new Map(); caches.set(db, m); }
  const hit = m.get(buildId);
  if (hit) return hit;
  const row = db.prepare('SELECT id, rule_set_id, scope, tests_version, atom_set_sha FROM graph_builds WHERE id = ?')
    .get(buildId) as BuildRow | undefined;
  if (!row) return null;
  const index = BuildIndex.load(db, buildId);
  const c: Cached = {
    row, index, graphs: new Map(),
    rules: new Map(setRules(db, row.rule_set_id, 'all').map((r) => [r.rule_hash, r])),
  };
  m.set(buildId, c);
  return c;
}

/** The cached index of a stored build, or null: the fix-request routes use the same cache. */
export const indexOfBuild = (db: DatabaseSync) => (buildId: number) => cachedBuild(db, buildId)?.index ?? null;

function buildOf(app: FastifyInstance, reply: FastifyReply, raw: string): Cached | null {
  const id = Number(raw);
  const c = Number.isInteger(id) ? cachedBuild(app.db, id) : null;
  if (!c) void reply.code(404).send({ error: `no graph build ${raw}` });
  return c;
}

const isStale = (db: DatabaseSync, scope: Scope, sha: string) => atomSetSha(currentScopeAtoms(db, scope)) !== sha;

const typeId = (x: { family: string; type_key: string }) => `${x.family}.${x.type_key}`;

// ---------- the views ----------

interface CardView {
  name: string; type_line: string; mana_cost: string | null; image: string | null;
  faces: Array<{ face_index: number; name: string; oracle_text: string; image: string | null }>;
}

function cardViews(db: DatabaseSync, ids: Iterable<string>): Record<string, CardView> {
  const list = JSON.stringify([...new Set(ids)]);
  const out: Record<string, CardView> = {};
  for (const r of db.prepare('SELECT c.oracle_id, c.name, c.type_line, c.mana_cost, c.image_normal FROM cards c JOIN json_each(?) j ON j.value = c.oracle_id')
    .all(list) as Array<{ oracle_id: string; name: string; type_line: string; mana_cost: string | null; image_normal: string | null }>) {
    out[r.oracle_id] = { name: r.name, type_line: r.type_line, mana_cost: r.mana_cost, image: r.image_normal, faces: [] };
  }
  for (const f of db.prepare(
    `SELECT f.oracle_id, f.face_index, f.name, f.oracle_text, f.image_normal FROM card_faces f JOIN json_each(?) j ON j.value = f.oracle_id
      ORDER BY f.oracle_id, f.face_index`,
  ).all(list) as Array<{ oracle_id: string; face_index: number; name: string; oracle_text: string; image_normal: string | null }>) {
    out[f.oracle_id]?.faces.push({ face_index: f.face_index, name: f.name, oracle_text: f.oracle_text, image: f.image_normal });
  }
  return out;
}

function quotes(db: DatabaseSync, ids: Iterable<number>): Map<number, string> {
  return new Map((db.prepare('SELECT a.id, a.quote FROM atoms a JOIN json_each(?) j ON j.value = a.id')
    .all(JSON.stringify([...new Set(ids)])) as Array<{ id: number; quote: string }>).map((r) => [r.id, r.quote]));
}

/** The supply atom IDs of a merged edge: its atom IDs without one copy of the demand atom. */
function supplyIds(e: MergedEdge): number[] {
  const ids = [...e.atom_ids];
  ids.splice(ids.indexOf(e.demand_atom_id), 1);
  return ids;
}

function edgeView(c: Cached, e: MergedEdge, q: Map<number, string>) {
  const idx = c.index;
  const d = idx.atoms.get(e.demand_atom_id)!;
  const sIds = supplyIds(e);
  const s = sIds.length ? idx.atoms.get(sIds[0]!)! : null;
  const cls = e.class_id !== null ? idx.classes.get(e.class_id) : undefined;
  return {
    key: e.key, polarity: e.polarity, grade: e.grade, unresolved: e.unresolved, weight: e.weight,
    supply: s ? {
      oracle_id: s.oracle_id, face_index: s.face_index, span: e.supply_span!, quote: q.get(s.id) ?? '', group: e.supply_group!, kind: s.kind,
      atom_ids: sIds, types: [...new Set(sIds.map((id) => typeId(idx.atoms.get(id)!)))].sort(),
    } : null,
    class: cls ? { id: cls.id, intrinsic: cls.intrinsic, value: cls.value, member_count: cls.members.length } : null,
    demand: {
      oracle_id: d.oracle_id, atom_id: d.id, face_index: d.face_index, span: [d.span_start, d.span_end] as [number, number],
      quote: q.get(d.id) ?? '', group: d.group, kind: d.kind, type: typeId(d),
    },
    /** The demand type has no params (schema v14): no param can narrow this edge (the precision gap, sec. 13.3). */
    demand_without_params: idx.paramsOf(d).length === 0,
    rule_hashes: e.rule_hashes,
  };
}

function ruleView(r: StoredRule) {
  return {
    rule_hash: r.rule_hash, rule_id: r.rule_id, polarity: r.polarity, supply: r.supply, demand: r.demand,
    param_links: r.param_links, implications: r.implications, evidence: r.evidence, votes: r.votes, status: r.status,
  };
}

function searchView(c: Cached, g: CycleGraph, s: SearchOut, names: Map<string, string>) {
  const idx = c.index;
  const step = (e: TieredCycle['edges'][number]) => {
    const d = idx.atoms.get(e.demand_atom_id)!;
    const k = parseMergeKey(e.merged_key);
    const supplyTypes = k && k.class_id === null
      ? [...new Set(idx.atomsOfCard(k.supply_oracle).filter((a) => a.face_index === k.face_index && a.span_start === k.span[0] && a.span_end === k.span[1])
        .map(typeId))].sort()
      : [];
    return {
      from: e.from, to: e.to, merged_key: e.merged_key, grade: e.grade, weight: e.weight, demand_atom_id: e.demand_atom_id,
      supply_types: supplyTypes, demand_type: typeId(d), demand_without_params: idx.paramsOf(d).length === 0,
    };
  };
  return {
    exact: s.exact, expansions: s.expansions, kept_k: s.kept_k,
    cycles: s.cycles.map((cy) => ({
      tier: cy.tier, unresolved: cy.unresolved, has_plausible: cy.has_plausible, per_turn_limit: cy.per_turn_limit, score: cy.score,
      groups: cy.groups.map((k) => {
        const n = g.nodes.get(k)!;
        return { key: k, oracle_id: n.oracle_id, name: names.get(n.oracle_id) ?? n.oracle_id, kind: n.kind,
          per_turn_limit: n.per_turn_limit, unknown_limit: n.unknown_limit, cost_unparsed: n.cost_unparsed };
      }),
      steps: cy.edges.map(step),
      balance: [...cycleBalance(cy, c.balance!)].map(([resource, b]) => ({ resource, ...b }))
        .sort((a, b) => (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0)),
    })),
  };
}

interface ScoreView {
  synergy_recall: number | null; anti_recall: number | null; confirmed_precision: number | null; all_precision: number | null;
  bar: number; counts: FullScore['counts'];
  /** The confirmed card pairs whose label does not agree, and how many of them go only through demand types without params. */
  wrong_confirmed: { items: number; only_demand_without_params: number; type_pairs: Array<{ type_pair: string; items: number }> };
}

function scoreView(c: Cached, s: FullScore): ScoreView {
  const noParams = (type: string) => c.index.paramsOf({ family: type.slice(0, type.indexOf('.')), type_key: type.slice(type.indexOf('.') + 1) }).length === 0;
  let items = 0;
  let only = 0;
  const pairs = new Map<string, number>();
  for (const p of s.pairs) {
    for (const pol of p.confirmed) {
      if (pol === '+' ? p.label === 'synergy' : p.label === 'anti') continue;
      items++;
      const types = p.confirmed_types.filter((t) => t.startsWith(`${pol} `));
      if (types.length && types.every((t) => noParams(t.slice(t.indexOf('-> ') + 3)))) only++;
      for (const t of types) pairs.set(t, (pairs.get(t) ?? 0) + 1);
    }
  }
  return {
    synergy_recall: s.synergy_recall, anti_recall: s.anti_recall, confirmed_precision: s.confirmed_precision, all_precision: s.all_precision,
    bar: SCORE_BAR, counts: s.counts,
    wrong_confirmed: {
      items, only_demand_without_params: only,
      type_pairs: [...pairs].map(([type_pair, n]) => ({ type_pair, items: n }))
        .sort((a, b) => b.items - a.items || (a.type_pair < b.type_pair ? -1 : 1)).slice(0, 10),
    },
  };
}

const ReportZ = z.object({ edge_key: z.string().min(1), note: z.string().trim().min(1) }).strict();

export async function graphRoutes(app: FastifyInstance) {
  /** The vocabulary label of each type ("FAMILY.TYPE_KEY"), for plain names in the UI. A later schema version wins. */
  app.get('/api/graph/labels', async () => {
    const labels: Record<string, string> = {};
    for (const t of app.db.prepare('SELECT family, type_key, label FROM atom_types ORDER BY schema_version')
      .all() as Array<{ family: string; type_key: string; label: string }>) {
      labels[typeId(t)] = t.label;
    }
    return { labels };
  });

  app.get('/api/graph/builds', async () => {
    retireStaleEdgeReports(app.db);
    const rows = app.db.prepare(
      `SELECT g.id, g.build_key, g.rule_set_id, s.version AS rule_set_version, g.scope, g.schema_version, g.tests_version,
              g.atom_set_sha, g.built_at, g.counts_json
         FROM graph_builds g JOIN edge_rule_sets s ON s.id = g.rule_set_id ORDER BY g.id DESC`,
    ).all() as Array<Record<string, unknown> & { scope: Scope; atom_set_sha: string; counts_json: string }>;
    const stale = new Map<string, boolean>();
    return {
      builds: rows.map(({ counts_json, ...r }) => {
        const k = `${r.scope}|${r.atom_set_sha}`;
        if (!stale.has(k)) stale.set(k, isStale(app.db, r.scope, r.atom_set_sha));
        return { ...r, counts: JSON.parse(counts_json) as unknown, stale: stale.get(k)! };
      }),
    };
  });

  app.get<{ Params: { buildId: string; oracleId: string } }>('/api/graph/:buildId/card/:oracleId', async (req, reply) => {
    const c = buildOf(app, reply, req.params.buildId);
    if (!c) return reply;
    const id = req.params.oracleId;
    const cards0 = cardViews(app.db, [id]);
    if (!cards0[id]) return reply.code(404).send({ error: `no card ${id}` });
    const e = c.index.edgesForCard(id);
    const all = [...e.out, ...e.in, ...e.classes, ...e.anti];
    const own = c.index.atomsOfCard(id);
    const q = quotes(app.db, [...own.map((a) => a.id), ...all.flatMap((x) => x.atom_ids)]);
    const cardIds = new Set<string>([id]);
    for (const x of all) { cardIds.add(x.demand_oracle); if (x.supply_oracle) cardIds.add(x.supply_oracle); }
    const ruleHashes = new Set(all.flatMap((x) => x.rule_hashes));
    const hashes = (app.db.prepare('SELECT DISTINCT a.oracle_hash FROM atoms a JOIN json_each(?) j ON j.value = a.id')
      .all(JSON.stringify(own.map((a) => a.id))) as Array<{ oracle_hash: string }>).map((r) => r.oracle_hash);
    const sha = groupAtomSha(own.map((a) => a.id));
    const groups = pickAtomSet(app.db.prepare(
      `SELECT face_index, group_index, span_start, span_end, kind, cost_unparsed, per_turn_limit, unknown_limit, atom_sha FROM ability_groups
        WHERE oracle_id = ? AND tests_version = ? AND oracle_hash IN (SELECT value FROM json_each(?)) AND atom_sha IN (?, '')
        ORDER BY face_index, group_index`,
    ).all(id, c.row.tests_version, JSON.stringify(hashes), sha) as Array<Record<string, unknown> & { atom_sha: string }>, sha)
      .map(({ atom_sha: _sha, ...g }) => g);
    return {
      build: { id: c.row.id, scope: c.row.scope, rule_set_id: c.row.rule_set_id, stale: isStale(app.db, c.row.scope, c.row.atom_set_sha) },
      centre: {
        oracle_id: id, groups,
        atoms: own.map((a) => ({
          id: a.id, face_index: a.face_index, family: a.family, type_key: a.type_key, params: a.params,
          span_start: a.span_start, span_end: a.span_end, quote: q.get(a.id) ?? '', group: a.group, kind: a.kind,
        })),
      },
      cards: cardViews(app.db, cardIds),
      rules: Object.fromEntries([...ruleHashes].sort().map((h) => [h, ruleView(c.rules.get(h)!)])),
      edges: {
        out: e.out.map((x) => edgeView(c, x, q)), in: e.in.map((x) => edgeView(c, x, q)),
        classes: e.classes.map((x) => edgeView(c, x, q)), anti: e.anti.map((x) => edgeView(c, x, q)),
      },
    };
  });

  app.get<{ Params: { buildId: string; classId: string }; Querystring: { offset?: string; limit?: string } }>(
    '/api/graph/:buildId/class/:classId', async (req, reply) => {
      const c = buildOf(app, reply, req.params.buildId);
      if (!c) return reply;
      const cls = c.index.classes.get(req.params.classId);
      if (!cls) return reply.code(404).send({ error: `build ${c.row.id} has no class ${req.params.classId}` });
      const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 50) || 50));
      const page = [...cls.members].sort().slice(offset, offset + limit);
      const v = cardViews(app.db, page);
      return {
        class: { id: cls.id, intrinsic: cls.intrinsic, value: cls.value }, total: cls.members.length, offset, limit,
        members: page.map((m) => ({ oracle_id: m, name: v[m]?.name ?? m, type_line: v[m]?.type_line ?? '' })),
      };
    });

  app.get<{ Params: { buildId: string }; Querystring: { card?: string; confirmed?: string } }>(
    '/api/graph/:buildId/cycles', async (req, reply) => {
      const c = buildOf(app, reply, req.params.buildId);
      if (!c) return reply;
      const card = req.query.card;
      if (!card) return reply.code(400).send({ error: 'the query needs card=<oracle_id>' });
      const confirmed = req.query.confirmed === '1' || req.query.confirmed === 'true';
      let graphs = c.graphs.get(confirmed);
      if (!graphs) { graphs = cycleGraphs(c.index, confirmed); c.graphs.set(confirmed, graphs); }
      c.balance ??= balanceContext(app.db, c.index, loadTextTests());
      const p = loadGraphPolicy().cycles;
      const limits = { maxLength: p.max_length, topK: p.top_k, budget: p.budget };
      const r = cardCycles(c.index, graphs, c.balance, card, limits);
      const ids = new Set<string>([card]);
      for (const s of [r.engine, r.full]) for (const cy of s.cycles) for (const k of cy.groups) ids.add(graphs.full.nodes.get(k)?.oracle_id ?? '');
      const v = cardViews(app.db, ids);
      const names = new Map(Object.entries(v).map(([k, x]) => [k, x.name]));
      // The search times are left out, so the same request always gives the same body (spec I4).
      return {
        build: { id: c.row.id }, card, confirmed, limits,
        engine: searchView(c, graphs.engine, r.engine, names), full: searchView(c, graphs.full, r.full, names), more_engine: r.more_engine,
      };
    });

  app.get<{ Params: { buildId: string } }>('/api/graph/:buildId/gaps', async (req, reply) => {
    const id = Number(req.params.buildId);
    const ok = Number.isInteger(id) && app.db.prepare('SELECT 1 FROM graph_builds WHERE id = ?').get(id);
    if (!ok) return reply.code(404).send({ error: `no graph build ${req.params.buildId}` });
    return {
      gaps: app.db.prepare('SELECT gap_kind, type_key, param, count FROM graph_gaps WHERE build_id = ? ORDER BY count DESC, gap_kind, type_key, param')
        .all(id),
    };
  });

  /** The cards with the highest degree (out + in) of a build: the start list of the card picker (sec. 12.1). */
  app.get<{ Params: { buildId: string }; Querystring: { limit?: string } }>('/api/graph/:buildId/top', async (req) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 10) || 10));
    return {
      cards: app.db.prepare(
        `SELECT d.oracle_id, c.name, c.type_line, c.image_normal AS image, d.out_degree, d.in_degree, d.class_edges, d.anti_degree
          FROM card_degree d JOIN cards c USING (oracle_id)
          WHERE d.build_id = ? ORDER BY d.out_degree + d.in_degree DESC, d.oracle_id LIMIT ?`,
      ).all(Number(req.params.buildId), limit),
    };
  });

  app.get<{ Params: { buildId: string } }>('/api/graph/:buildId/score', async (req, reply) => {
    const c = buildOf(app, reply, req.params.buildId);
    if (!c) return reply;
    c.score ??= scoreView(c, fullScore(app.db, c.row.id, c.index));
    return c.score;
  });

  app.post<{ Params: { buildId: string }; Body: unknown }>('/api/graph/:buildId/reports', async (req, reply) => {
    const c = buildOf(app, reply, req.params.buildId);
    if (!c) return reply;
    const parsed = ReportZ.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'the body needs edge_key and a note that is not empty' });
    const k = parseMergeKey(parsed.data.edge_key);
    const d = k ? c.index.atoms.get(k.demand_atom_id) : undefined;
    const ce = d ? c.index.edgesForCard(d.oracle_id) : null;
    const edge = ce ? [...ce.in, ...ce.classes, ...ce.anti, ...ce.out].find((x) => x.key === parsed.data.edge_key) : undefined;
    if (!edge) return reply.code(404).send({ error: `build ${c.row.id} has no edge ${parsed.data.edge_key}` });
    const degree = app.db.prepare('SELECT out_degree + in_degree + class_edges AS n FROM card_degree WHERE build_id = ? AND oracle_id = ?')
      .get(c.row.id, edge.demand_oracle) as { n: number } | undefined;
    app.db.exec('BEGIN');
    try {
      // A class edge has no supply card: supply_oracle holds the class ID.
      const id = Number(app.db.prepare(
        `INSERT INTO edge_reports (build_id, edge_key, supply_oracle, demand_oracle, rule_hashes, note, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      ).run(c.row.id, edge.key, edge.supply_oracle ?? edge.class_id!, edge.demand_oracle, JSON.stringify(edge.rule_hashes),
        parsed.data.note, new Date().toISOString()).lastInsertRowid);
      enqueueEdgeFinding(app.db, {
        severity: 'edge_report', ruleSetId: c.row.rule_set_id, buildId: c.row.id, oracleId: edge.demand_oracle,
        detailTable: 'edge_reports', detailId: id, rankScore: degree?.n ?? 0,
      });
      app.db.exec('COMMIT');
      return { ok: true, report_id: id };
    } catch (err) {
      app.db.exec('ROLLBACK');
      throw err;
    }
  });
}
