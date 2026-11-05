/**
 * The `edge` domain of the review queue (Phase 3 spec sec. 10.1).
 *
 * The edge findings share the review_queue table with the Phase 2 atom findings, but never
 * their ranks: every query here filters `domain = 'edge'`, and the sort is
 * `severity_rank, rank_score DESC, id` inside the domain. An edge finding can have no card
 * (a role or a rule concerns a type, not a card), so the read uses LEFT JOIN cards.
 */
import type { DatabaseSync } from 'node:sqlite';
import { parseMergeKey } from './merge.js';

export const EDGE_SEVERITY_RANK = {
  edge_role_disagreement: 1,
  edge_rule_disagreement: 2,
  edge_report: 3,
} as const;

export type EdgeSeverity = keyof typeof EDGE_SEVERITY_RANK;

/**
 * The detail table of each severity. The finding stores the rowid of its detail row.
 * edge_type_roles and edge_rules have composite keys and no INTEGER PRIMARY KEY, so a VACUUM
 * can renumber their rowids and break the link: do not VACUUM the database.
 */
const DETAIL_TABLE: Record<EdgeSeverity, string> = {
  edge_role_disagreement: 'edge_type_roles',
  edge_rule_disagreement: 'edge_rules',
  edge_report: 'edge_reports',
};
const DETAIL_TABLES = new Set(Object.values(DETAIL_TABLE));

export interface EdgeFinding {
  id: number;
  oracle_id: string | null;
  name: string | null;
  rule_set_id: number;
  build_id: number | null;
  severity: EdgeSeverity;
  severity_rank: number;
  rank_score: number;
  detail_table: string | null;
  detail_id: number | null;
  status: 'pending' | 'resolved';
  enqueued_at: string;
  /** One line saying what the finding is, from its detail row. */
  summary: string;
  /** For a role finding: the type of the role, FAMILY.TYPE_KEY (the decision form uses it). */
  role_type: string | null;
}

/**
 * Writes one edge finding. Idempotent: the unique index review_queue_finding absorbs an
 * equal second call, also when oracle_id and build_id are NULL. Returns the rows inserted.
 */
export function enqueueEdgeFinding(db: DatabaseSync, f: {
  severity: EdgeSeverity; ruleSetId: number; buildId?: number; oracleId?: string;
  detailTable: string; detailId: number; rankScore: number;
}): number {
  if (DETAIL_TABLE[f.severity] !== f.detailTable) {
    throw new Error(`an ${f.severity} finding points at ${DETAIL_TABLE[f.severity]}, not at ${f.detailTable}`);
  }
  return Number(db.prepare(
    `INSERT INTO review_queue (domain, oracle_id, run_id, rule_set_id, build_id, severity, severity_rank, rank_score,
                               detail_table, detail_id, enqueued_at)
     VALUES ('edge', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).run(f.oracleId ?? null, f.ruleSetId, f.buildId ?? null, f.severity, EDGE_SEVERITY_RANK[f.severity], f.rankScore,
    f.detailTable, f.detailId, new Date().toISOString()).changes);
}

function detailRow(db: DatabaseSync, f: { detail_table: string | null; detail_id: number | null }): Record<string, unknown> | undefined {
  return f.detail_table && f.detail_id !== null && DETAIL_TABLES.has(f.detail_table)
    ? db.prepare(`SELECT * FROM ${f.detail_table} WHERE rowid = ?`).get(f.detail_id) as Record<string, unknown> | undefined
    : undefined;
}

function summarize(db: DatabaseSync, f: { severity: EdgeSeverity; detail_table: string | null; detail_id: number | null }): string {
  const d = detailRow(db, f);
  if (!d) return 'detail row missing';
  switch (f.severity) {
    case 'edge_role_disagreement': {
      const id = `${String(d['family'])}.${String(d['type_key'])}`;
      // spec sec. 5.3: a resource outside the closed list also makes a role item.
      const other = (db.prepare(
        "SELECT item_json FROM edge_rule_pass_items WHERE set_id = ? AND stage = 'roles' AND item_key = ? ORDER BY pass_index",
      ).all(Number(d['set_id']), id) as Array<{ item_json: string }>)
        .flatMap((r) => (JSON.parse(r.item_json) as { resources: Array<{ resource: string; note?: string }> }).resources)
        .filter((r) => r.resource === 'other').map((r) => r.note ?? '');
      const base = `${id}: role ${String(d['role'])} (${String(d['status'])}, ${String(d['votes'])} votes)`;
      return other.length ? `${base}; other resource: ${[...new Set(other)].join('; ')}` : base;
    }
    case 'edge_rule_disagreement':
      return `rule ${String(d['rule_id'])} (${String(d['polarity'])}, ${String(d['status'])}, ${String(d['votes'])} votes)`;
    case 'edge_report':
      return `edge ${String(d['edge_key'])}: ${String(d['note'])}`;
  }
}

/** The ranked edge queue: severity_rank, then rank_score descending, then age. */
export function listEdgeFindings(db: DatabaseSync, status: 'pending' | 'resolved' | 'all' = 'pending'): EdgeFinding[] {
  const rows = db.prepare(
    `SELECT q.id, q.oracle_id, c.name, q.rule_set_id, q.build_id, q.severity, q.severity_rank, q.rank_score,
            q.detail_table, q.detail_id, q.status, q.enqueued_at
       FROM review_queue q LEFT JOIN cards c USING (oracle_id)
      WHERE q.domain = 'edge' AND (? = 'all' OR q.status = ?)
      ORDER BY q.severity_rank, q.rank_score DESC, q.id`,
  ).all(status, status) as unknown as Array<Omit<EdgeFinding, 'summary' | 'role_type'>>;
  return rows.map((r) => {
    const d = r.severity === 'edge_role_disagreement' ? detailRow(db, r) : undefined;
    return { ...r, summary: summarize(db, r), role_type: d ? `${String(d['family'])}.${String(d['type_key'])}` : null };
  });
}

/** Pending edge findings by severity, every severity present (0 when none). */
export function countEdgeFindings(db: DatabaseSync): Record<EdgeSeverity, number> {
  const counts = Object.fromEntries(Object.keys(EDGE_SEVERITY_RANK).map((k) => [k, 0])) as Record<EdgeSeverity, number>;
  for (const r of db.prepare("SELECT severity, COUNT(*) n FROM review_queue WHERE domain = 'edge' AND status = 'pending' GROUP BY severity")
    .all() as Array<{ severity: EdgeSeverity; n: number }>) counts[r.severity] = r.n;
  return counts;
}

/**
 * Resolves one edge finding. The decision itself (a role, a rule, a report status) is the
 * caller's, in its own table; review_queue has no column for a note (spec sec. 10.1).
 */
export function resolveEdgeFinding(db: DatabaseSync, id: number): void {
  const r = db.prepare("UPDATE review_queue SET status = 'resolved' WHERE id = ? AND domain = 'edge' AND status = 'pending'").run(id);
  if (r.changes === 0) throw new Error(`no pending edge finding ${id}`);
}

/**
 * spec sec. 10.1, rank 2: sets the rank_score of each pending `edge_rule_disagreement` finding
 * of a set to the number of atom edges of its rule in a build (`edges`, by rule_hash; 0 when
 * absent). Returns the findings updated.
 */
export function refreshRuleRanks(db: DatabaseSync, setId: number, edges: ReadonlyMap<string, number>): number {
  const pending = db.prepare(
    `SELECT q.id, r.rule_hash FROM review_queue q JOIN edge_rules r ON r.rowid = q.detail_id
      WHERE q.domain = 'edge' AND q.severity = 'edge_rule_disagreement' AND q.status = 'pending'
        AND q.detail_table = 'edge_rules' AND q.rule_set_id = ?`,
  ).all(setId) as Array<{ id: number; rule_hash: string }>;
  const rank = db.prepare('UPDATE review_queue SET rank_score = ? WHERE id = ?');
  for (const p of pending) rank.run(edges.get(p.rule_hash) ?? 0, p.id);
  return pending.length;
}

/**
 * spec sec. 10.2 and plan Task 7 Step 3: an open edge report becomes `stale` when one of its
 * atoms is no longer current, and its queue item is resolved. The demand atom ID is in the
 * merged-edge key; the supply atoms are the atoms of the report's build with the supply card,
 * face and span of the key. A class edge has no supply atom. Returns the reports retired.
 *
 * buildGraph and `GET /api/graph/builds` call this: atoms are demoted in several places
 * (verify.ts, extract.ts), so one call at build time is simpler than one at each demotion.
 */
export function retireStaleEdgeReports(db: DatabaseSync): number {
  const open = db.prepare("SELECT id, build_id, edge_key FROM edge_reports WHERE status = 'open' ORDER BY id")
    .all() as Array<{ id: number; build_id: number; edge_key: string }>;
  if (open.length === 0) return 0;
  const demandCurrent = db.prepare('SELECT is_current FROM atoms WHERE id = ?');
  const supplyCurrent = db.prepare(
    `SELECT MIN(a.is_current) AS cur FROM atoms a JOIN graph_build_atoms g ON g.atom_id = a.id AND g.build_id = ?
      WHERE a.oracle_id = ? AND a.face_index = ? AND a.span_start = ? AND a.span_end = ?`,
  );
  const retire = db.prepare("UPDATE edge_reports SET status = 'stale' WHERE id = ? AND status = 'open'");
  const resolve = db.prepare(
    "UPDATE review_queue SET status = 'resolved' WHERE domain = 'edge' AND detail_table = 'edge_reports' AND detail_id = ? AND status = 'pending'",
  );
  let n = 0;
  for (const r of open) {
    const k = parseMergeKey(r.edge_key);
    if (!k) continue;
    const d = demandCurrent.get(k.demand_atom_id) as { is_current: number } | undefined;
    let stale = !d || d.is_current === 0;
    if (!stale && k.class_id === null) {
      const s = supplyCurrent.get(r.build_id, k.supply_oracle, k.face_index, k.span[0], k.span[1]) as { cur: number | null };
      stale = s.cur === 0;
    }
    if (!stale) continue;
    retire.run(r.id);
    resolve.run(r.id);
    n++;
  }
  return n;
}
