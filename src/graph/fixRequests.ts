/**
 * The edge reports grouped by reason, and the fix requests of a reason (owner request 2026-10-18).
 *
 * A reason is the rule set of one merged edge: the sorted `rule_hashes` of the reported edge (one
 * merged edge can have more than one rule). The owner can report many links of one wrong reason;
 * the review queue shows them as one item. "Fix this reason" saves a fix_requests row and writes a
 * brief file in ASD-STE100 for a named Claude session. The fix-dispatch mod
 * (.claude/skills/fix-dispatch) reads the queued rows, sends each brief to the session with that
 * title, and then marks the row sent. When no session has the title, the mod records why.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { kindName, reasonSentence, sideText, typeName } from '../web/lib/plain.js';
import type { BuildIndex } from './buildIndex.js';
import { mergeEdges, parseMergeKey, type MergedEdge } from './merge.js';
import type { StoredRule } from './ruleSet.js';

/** The index of a stored build, or null when the build does not exist. The routes give their cached one. */
export type IndexOf = (buildId: number) => BuildIndex | null;

export class FixRequestError extends Error {
  constructor(readonly kind: 'invalid' | 'not_found' | 'conflict', message: string) { super(message); }
}

/** The key of a reason: its rule hashes, sorted, comma-joined. */
export function reasonKey(hashes: readonly string[]): string {
  return [...new Set(hashes)].sort().join(',');
}

const typeId = (x: { family: string; type_key: string }) => `${x.family}.${x.type_key}`;

/** The vocabulary labels, as GET /api/graph/labels gives them: a later schema version wins. */
export function typeLabels(db: DatabaseSync): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const t of db.prepare('SELECT family, type_key, label FROM atom_types ORDER BY schema_version')
    .all() as Array<{ family: string; type_key: string; label: string }>) labels[typeId(t)] = t.label;
  return labels;
}

function newestBuild(db: DatabaseSync): { id: number; rule_set_id: number; scope: string } | null {
  return (db.prepare('SELECT id, rule_set_id, scope FROM graph_builds ORDER BY id DESC LIMIT 1').get() as
    { id: number; rule_set_id: number; scope: string } | undefined) ?? null;
}

// ---------- the views ----------

export interface ReasonRule {
  rule_hash: string; rule_id: string; rule_set_id: number; polarity: '+' | '-';
  supply: StoredRule['supply']; demand: StoredRule['demand'];
  param_links: StoredRule['param_links']; implications: StoredRule['implications']; evidence: StoredRule['evidence'];
  votes: number; status: 'accepted' | 'disputed';
  /** The reason in one plain sentence, and its technical form. */
  sentence: string; technical: string;
}

export interface ReportItem {
  id: number; build_id: number; edge_key: string; status: string; note: string; created_at: string;
  supply_oracle: string; demand_oracle: string;
  /** The supply card name, or the card kind of a class edge. */
  supply_name: string; demand_name: string;
}

export interface LinkExample {
  key: string; polarity: '+' | '-'; grade: 'confirmed' | 'plausible'; strength: number;
  supply_oracle: string | null; supply_name: string; demand_oracle: string; demand_name: string;
  supply_quote: string; demand_quote: string;
}

export interface ReasonLinks {
  build_id: number;
  /** The links (merged edges) of the reason in this build, by grade, and their distinct card pairs. */
  count: number; strong: number; possible: number; card_pairs: number;
  examples: LinkExample[];
}

export interface FixRequestRow {
  id: number; session_name: string; rule_hashes: string[]; report_ids: number[]; build_id: number | null;
  edge_key: string | null; brief_path: string; status: 'queued' | 'sent' | 'done'; note: string;
  created_at: string; sent_at: string | null;
  /** The Claude session that got the brief (the mod sets it). */
  session_id: string | null;
  /** Why the last delivery failed, and when; null after a delivery. The mod tries again after RETRY_MS. */
  delivery_error: string | null; delivery_at: string | null;
  /** The rule IDs of the reason, for a short label. */
  rule_ids: string[];
}

export interface ReasonGroup {
  key: string; rule_hashes: string[]; rules: ReasonRule[];
  /** The plain sentence of each rule, joined. */
  sentence: string;
  report_count: number; reports: ReportItem[];
  links: ReasonLinks | null;
  fix_requests: FixRequestRow[];
}

/**
 * The stored rules of the hashes. A hash can be in more than one rule set: the set of `preferSet`
 * wins, else the newest set.
 */
export function reasonRules(db: DatabaseSync, hashes: readonly string[], labels: Record<string, string>, preferSet: number | null): ReasonRule[] {
  const rows = db.prepare(
    `SELECT set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status
       FROM edge_rules WHERE rule_hash IN (SELECT value FROM json_each(?))
      ORDER BY (set_id = ?) DESC, set_id DESC`,
  ).all(JSON.stringify(hashes), preferSet ?? -1) as Array<Record<string, string | number>>;
  const out = new Map<string, ReasonRule>();
  for (const r of rows) {
    const hash = String(r['rule_hash']);
    if (out.has(hash)) continue;
    const supply = JSON.parse(String(r['supply_json'])) as StoredRule['supply'];
    const demand = JSON.parse(String(r['demand_json'])) as StoredRule['demand'];
    const polarity = r['polarity'] as '+' | '-';
    out.set(hash, {
      rule_hash: hash, rule_id: String(r['rule_id']), rule_set_id: Number(r['set_id']), polarity, supply, demand,
      param_links: JSON.parse(String(r['param_links'])) as StoredRule['param_links'],
      implications: JSON.parse(String(r['implications'])) as StoredRule['implications'],
      evidence: JSON.parse(String(r['evidence_json'])) as StoredRule['evidence'],
      votes: Number(r['votes']), status: r['status'] as ReasonRule['status'],
      sentence: reasonSentence({ polarity, supply, demand }, labels),
      technical: `${polarity} ${sideText(supply)} -> ${sideText(demand)}`,
    });
  }
  return [...out.values()].sort((a, b) => (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0));
}

function cardNames(db: DatabaseSync, ids: Iterable<string>): Map<string, string> {
  return new Map((db.prepare('SELECT c.oracle_id, c.name FROM cards c JOIN json_each(?) j ON j.value = c.oracle_id')
    .all(JSON.stringify([...new Set(ids)])) as Array<{ oracle_id: string; name: string }>).map((r) => [r.oracle_id, r.name]));
}

function atomQuotes(db: DatabaseSync, ids: Iterable<number>): Map<number, string> {
  return new Map((db.prepare('SELECT a.id, a.quote FROM atoms a JOIN json_each(?) j ON j.value = a.id')
    .all(JSON.stringify([...new Set(ids)])) as Array<{ id: number; quote: string }>).map((r) => [r.id, r.quote]));
}

/** The name of the supply side of a merged edge: the card, or the card kind of a class edge. */
function supplyName(idx: BuildIndex | null, supplyOracle: string, names: Map<string, string>): string {
  const cls = idx?.classes.get(supplyOracle);
  if (cls) return kindName(cls.intrinsic, cls.value);
  return names.get(supplyOracle) ?? supplyOracle;
}

/** One merged edge as an example pair, with the marked texts of both sides. */
function examples(db: DatabaseSync, idx: BuildIndex, edges: MergedEdge[]): LinkExample[] {
  const names = cardNames(db, edges.flatMap((e) => [e.demand_oracle, ...(e.supply_oracle ? [e.supply_oracle] : [])]));
  const q = atomQuotes(db, edges.flatMap((e) => e.atom_ids));
  return edges.map((e) => {
    const sId = e.atom_ids.find((id) => id !== e.demand_atom_id);
    return {
      key: e.key, polarity: e.polarity, grade: e.grade, strength: e.weight.total,
      supply_oracle: e.supply_oracle, demand_oracle: e.demand_oracle,
      supply_name: e.supply_oracle ? names.get(e.supply_oracle) ?? e.supply_oracle : supplyName(idx, e.class_id ?? '', names),
      demand_name: names.get(e.demand_oracle) ?? e.demand_oracle,
      supply_quote: sId !== undefined ? q.get(sId) ?? '' : '', demand_quote: q.get(e.demand_atom_id) ?? '',
    };
  });
}

/** The most examples that a reason keeps. */
const MAX_EXAMPLES = 8;

interface LinkSummary { count: number; strong: number; possible: number; card_pairs: number; picks: MergedEdge[] }

/**
 * The links of each index and reason. A reason can have very many links, so the cache keeps only
 * the counts and the examples: the strongest links, first with a supply card and a demand card
 * that no earlier example has, then any other card pair.
 */
const linkCache = new WeakMap<BuildIndex, Map<string, LinkSummary>>();

/**
 * The merged edges, of both polarities, that one of the rules makes in the index. Each merged edge
 * has all its parts (also of other rules), so it is the same edge that edgesForCard gives.
 */
export function edgesOfRules(idx: BuildIndex, rules: ReadonlyArray<{ rule_hash: string; demand: { family: string; type_key: string } }>): MergedEdge[] {
  const hashes = new Set(rules.map((r) => r.rule_hash));
  const types = new Set(rules.map((r) => typeId(r.demand)));
  const parts = [...idx.atoms.values()].filter((a) => idx.typesOf(a).some((t) => types.has(t))).sort((a, b) => a.id - b.id)
    .flatMap((d) => idx.edgesToDemand(d));
  return mergeEdges(parts, idx.ctx).filter((e) => e.rule_hashes.some((h) => hashes.has(h)));
}

function linksOf(idx: BuildIndex, rules: readonly ReasonRule[]): LinkSummary {
  let m = linkCache.get(idx);
  if (!m) { m = new Map(); linkCache.set(idx, m); }
  const k = reasonKey(rules.map((r) => r.rule_hash));
  const hit = m.get(k);
  if (hit) return hit;
  const edges = edgesOfRules(idx, rules);
  const pairOf = (e: MergedEdge) => `${e.supply_oracle ?? e.class_id}|${e.demand_oracle}`;
  const sorted = [...edges].sort((a, b) => b.weight.total - a.weight.total || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const picks: MergedEdge[] = [];
  const pairs = new Set<string>();
  const sides = new Set<string>();
  for (const fresh of [true, false]) {
    for (const e of sorted) {
      if (picks.length >= MAX_EXAMPLES) break;
      const s = `s:${e.supply_oracle ?? e.class_id}`;
      const d = `d:${e.demand_oracle}`;
      if (pairs.has(pairOf(e)) || (fresh && (sides.has(s) || sides.has(d)))) continue;
      pairs.add(pairOf(e));
      sides.add(s);
      sides.add(d);
      picks.push(e);
    }
  }
  const summary: LinkSummary = {
    count: edges.length, strong: edges.filter((e) => e.grade === 'confirmed').length,
    possible: edges.filter((e) => e.grade === 'plausible').length, card_pairs: new Set(edges.map(pairOf)).size, picks,
  };
  m.set(k, summary);
  return summary;
}

/** How many links the reason makes in a build, and up to `n` examples of distinct card pairs. */
export function reasonLinks(db: DatabaseSync, idx: BuildIndex, buildId: number, rules: readonly ReasonRule[], n = 5): ReasonLinks {
  const s = linksOf(idx, rules);
  return {
    build_id: buildId, count: s.count, strong: s.strong, possible: s.possible, card_pairs: s.card_pairs,
    examples: examples(db, idx, s.picks.slice(0, n)),
  };
}

// ---------- the reports ----------

interface ReportRow {
  id: number; build_id: number; edge_key: string; supply_oracle: string; demand_oracle: string;
  rule_hashes: string; note: string; status: string; created_at: string;
}

export type ReportStatus = 'open' | 'closed' | 'all';

function reportRows(db: DatabaseSync, status: ReportStatus): ReportRow[] {
  const where = status === 'open' ? "WHERE status = 'open'" : status === 'closed' ? "WHERE status <> 'open'" : '';
  return db.prepare(`SELECT id, build_id, edge_key, supply_oracle, demand_oracle, rule_hashes, note, status, created_at
                       FROM edge_reports ${where} ORDER BY id`).all() as unknown as ReportRow[];
}

/** The open reports on each reason, by reason key. The report form shows this number. */
export function openReportCounts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reportRows(db, 'open')) {
    const k = reasonKey(JSON.parse(r.rule_hashes) as string[]);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function reportItems(db: DatabaseSync, rows: ReportRow[], indexOf: IndexOf): ReportItem[] {
  const names = cardNames(db, rows.flatMap((r) => [r.supply_oracle, r.demand_oracle]));
  return rows.map((r) => ({
    id: r.id, build_id: r.build_id, edge_key: r.edge_key, status: r.status, note: r.note, created_at: r.created_at,
    supply_oracle: r.supply_oracle, demand_oracle: r.demand_oracle,
    supply_name: names.has(r.supply_oracle) ? names.get(r.supply_oracle)! : supplyName(indexOf(r.build_id), r.supply_oracle, names),
    demand_name: names.get(r.demand_oracle) ?? r.demand_oracle,
  }));
}

/**
 * The reports grouped by reason, the group with the most reports first. Each group has its rules
 * in plain words, the links of the reason in the newest build, and its fix requests.
 */
export function reportGroups(db: DatabaseSync, indexOf: IndexOf, status: ReportStatus = 'open'): { build_id: number | null; groups: ReasonGroup[] } {
  const rows = reportRows(db, status);
  const byKey = new Map<string, ReportRow[]>();
  for (const r of rows) {
    const k = reasonKey(JSON.parse(r.rule_hashes) as string[]);
    const l = byKey.get(k);
    if (l) l.push(r); else byKey.set(k, [r]);
  }
  const nb = newestBuild(db);
  const groups = [...byKey].map(([key, list]) => reasonGroup(db, indexOf, key.split(','), list, nb));
  groups.sort((a, b) => b.report_count - a.report_count || Math.max(...b.reports.map((r) => r.id)) - Math.max(...a.reports.map((r) => r.id)));
  return { build_id: nb?.id ?? null, groups };
}

function reasonGroup(db: DatabaseSync, indexOf: IndexOf, hashes: string[], rows: ReportRow[],
  nb: { id: number; rule_set_id: number } | null, labels = typeLabels(db)): ReasonGroup {
  const key = reasonKey(hashes);
  const rules = reasonRules(db, hashes, labels, nb?.rule_set_id ?? null);
  const idx = nb ? indexOf(nb.id) : null;
  return {
    key, rule_hashes: key.split(','), rules, sentence: rules.map((r) => r.sentence).join(' '),
    report_count: rows.length, reports: reportItems(db, rows, indexOf),
    links: idx && nb ? reasonLinks(db, idx, nb.id, rules) : null,
    fix_requests: listFixRequests(db, { key }),
  };
}

// ---------- the fix requests ----------

interface FixRow {
  id: number; session_name: string; rule_hashes: string; report_ids: string; build_id: number | null; edge_key: string | null;
  brief_path: string; status: FixRequestRow['status']; note: string; created_at: string; sent_at: string | null;
  session_id: string | null; delivery_error: string | null; delivery_at: string | null;
}

function fixView(db: DatabaseSync, r: FixRow): FixRequestRow {
  const hashes = JSON.parse(r.rule_hashes) as string[];
  const ids = (db.prepare('SELECT DISTINCT rule_id FROM edge_rules WHERE rule_hash IN (SELECT value FROM json_each(?)) ORDER BY rule_id')
    .all(JSON.stringify(hashes)) as Array<{ rule_id: string }>).map((x) => x.rule_id);
  return { ...r, rule_hashes: hashes, report_ids: JSON.parse(r.report_ids) as number[], rule_ids: ids };
}

export const FIX_STATUSES = ['queued', 'sent', 'done'] as const;

/** The fix requests, oldest first. `key` keeps the requests of one reason. */
export function listFixRequests(db: DatabaseSync, o: { status?: FixRequestRow['status']; key?: string } = {}): FixRequestRow[] {
  const rows = db.prepare(`SELECT * FROM fix_requests WHERE (? IS NULL OR status = ?) ORDER BY id`)
    .all(o.status ?? null, o.status ?? null) as unknown as FixRow[];
  return rows.filter((r) => o.key === undefined || reasonKey(JSON.parse(r.rule_hashes) as string[]) === o.key).map((r) => fixView(db, r));
}

export function getFixRequest(db: DatabaseSync, id: number): FixRequestRow {
  const r = db.prepare('SELECT * FROM fix_requests WHERE id = ?').get(id) as unknown as FixRow | undefined;
  if (!r) throw new FixRequestError('not_found', `no fix request ${id}`);
  return fixView(db, r);
}

/** The session names of the earlier fix requests, the last used first: the suggestions of the form. */
export function sessionNames(db: DatabaseSync): string[] {
  return (db.prepare('SELECT session_name FROM fix_requests GROUP BY session_name ORDER BY MAX(id) DESC').all() as
    Array<{ session_name: string }>).map((r) => r.session_name);
}

/** A file-name part from a session name: lower case, letters and digits, joined by '-'. */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '') || 'session';
}

/** The folder of the brief files: data/fix-requests next to the database file. */
export function defaultFixRequestDir(db: DatabaseSync): string {
  const file = db.location();
  return file ? join(dirname(file), 'fix-requests') : join(tmpdir(), 'mtga-fix-requests');
}

export interface FixRequestInput {
  session_name: string; rule_hashes: string[]; build_id?: number; edge_key?: string; note?: string;
}

/**
 * Saves a fix request with status 'queued' and writes its brief file. The request takes every
 * report on the reason. The link counts come from `build_id`, or from the newest build.
 */
export function createFixRequest(db: DatabaseSync, indexOf: IndexOf, dir: string, input: FixRequestInput, now = new Date()): FixRequestRow {
  const name = input.session_name.trim();
  if (!name || name.length > 80 || !/[A-Za-z0-9]/.test(name)) {
    throw new FixRequestError('invalid', 'the session name needs 1 to 80 characters, with at least one letter or digit');
  }
  const hashes = reasonKey(input.rule_hashes).split(',').filter(Boolean);
  if (hashes.length === 0) throw new FixRequestError('invalid', 'a fix request needs the rule_hashes of the reason');
  const build = input.build_id !== undefined
    ? (db.prepare('SELECT id, rule_set_id, scope FROM graph_builds WHERE id = ?').get(input.build_id) as { id: number; rule_set_id: number; scope: string } | undefined)
    : newestBuild(db) ?? undefined;
  if (input.build_id !== undefined && !build) throw new FixRequestError('not_found', `no graph build ${input.build_id}`);
  const labels = typeLabels(db);
  const rules = reasonRules(db, hashes, labels, build?.rule_set_id ?? null);
  const missing = hashes.filter((h) => !rules.some((r) => r.rule_hash === h));
  if (missing.length) throw new FixRequestError('not_found', `no edge rule with hash ${missing.join(', ')}`);
  const key = reasonKey(hashes);
  const reports = reportRows(db, 'all').filter((r) => reasonKey(JSON.parse(r.rule_hashes) as string[]) === key);
  const idx = build ? indexOf(build.id) : null;
  const group: ReasonGroup = {
    key, rule_hashes: hashes, rules, sentence: rules.map((r) => r.sentence).join(' '),
    report_count: reports.length, reports: reportItems(db, reports, indexOf),
    links: idx && build ? reasonLinks(db, idx, build.id, rules, MAX_EXAMPLES) : null, fix_requests: [],
  };
  const clicked = input.edge_key && idx ? edgeExample(db, idx, input.edge_key) : null;
  const note = (input.note ?? '').trim();

  mkdirSync(dir, { recursive: true });
  db.exec('BEGIN IMMEDIATE');
  try {
    const id = Number(db.prepare(
      `INSERT INTO fix_requests (session_name, rule_hashes, report_ids, build_id, edge_key, brief_path, status, note, created_at)
       VALUES (?, ?, ?, ?, ?, '', 'queued', ?, ?)`,
    ).run(name, JSON.stringify(hashes), JSON.stringify(reports.map((r) => r.id)), build?.id ?? null, input.edge_key ?? null,
      note, now.toISOString()).lastInsertRowid);
    const path = join(dir, `${id}-${slug(name)}.md`);
    writeFileSync(path, briefMarkdown({
      id, session_name: name, created_at: now.toISOString(), brief_path: path, note, group, labels,
      build: build ?? null, clicked,
    }), 'utf8');
    db.prepare('UPDATE fix_requests SET brief_path = ? WHERE id = ?').run(path, id);
    db.exec('COMMIT');
    return getFixRequest(db, id);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * The mod sent the brief to the session (`sessionId`), or the session finished. A second call on a
 * sent request changes nothing.
 */
export function markFixRequest(db: DatabaseSync, id: number, to: 'sent' | 'done', now = new Date(), sessionId?: string): FixRequestRow {
  const r = getFixRequest(db, id);
  if (r.status === to) return r;
  if (to === 'sent' && r.status !== 'queued') throw new FixRequestError('conflict', `fix request ${id} is ${r.status}, not queued`);
  if (to === 'sent') {
    db.prepare("UPDATE fix_requests SET status = 'sent', sent_at = ?, session_id = ?, delivery_error = NULL, delivery_at = NULL WHERE id = ?")
      .run(now.toISOString(), sessionId ?? null, id);
  } else db.prepare("UPDATE fix_requests SET status = 'done', sent_at = COALESCE(sent_at, ?) WHERE id = ?").run(now.toISOString(), id);
  return getFixRequest(db, id);
}

/** The mod could not deliver a queued request: no open session has the title, or it is archived. */
export function failFixRequest(db: DatabaseSync, id: number, error: string, now = new Date()): FixRequestRow {
  const r = getFixRequest(db, id);
  if (r.status !== 'queued') throw new FixRequestError('conflict', `fix request ${id} is ${r.status}, not queued`);
  const text = error.trim();
  if (!text) throw new FixRequestError('invalid', 'a failed delivery needs an error text');
  db.prepare('UPDATE fix_requests SET delivery_error = ?, delivery_at = ? WHERE id = ?').run(text, now.toISOString(), id);
  return getFixRequest(db, id);
}

// ---------- the dispatcher ----------

/** A failed delivery waits this long before the mod tries again (the owner can rename a session). */
export const RETRY_MS = 60_000;
/** A dispatcher keeps the lease while it polls within this time. The mod polls every 20 seconds. */
export const LEASE_MS = 60_000;

export interface SessionTitle { title: string; archived: boolean }

export interface DispatcherView {
  /** The last poll of any dispatcher, and the holder of the lease. */
  seen_at: string; holder: string;
  /** The session titles that the holder last reported, and when; null before its first report. */
  sessions: SessionTitle[] | null; sessions_at: string | null;
  /** The error of the holder's last poll (it cannot read the session list); null when it had none. */
  error: string | null;
}

/**
 * The dispatcher lease, in memory: many Claude sessions run the mod, and one of them delivers.
 * A poll from the holder, or from any session when the lease is older than LEASE_MS, gets the lease.
 */
export class DispatchLease {
  private holder: string | null = null;
  private heldAt = 0;
  private seenAt = 0;
  private sessions: SessionTitle[] | null = null;
  private sessionsAt = 0;
  private error: string | null = null;

  /** True when `by` holds the lease after this poll. */
  poll(by: string, now: number, sessions?: SessionTitle[], error?: string): boolean {
    this.seenAt = now;
    if (this.holder !== by && this.holder !== null && now - this.heldAt < LEASE_MS) return false;
    this.holder = by;
    this.heldAt = now;
    if (sessions) { this.sessions = sessions; this.sessionsAt = now; }
    this.error = error ?? null;
    // A holder that cannot work (an old copy of the mod, a session without the tools) gives the
    // lease to the next dispatcher that polls; it takes the lease again when no other one does.
    if (error) this.heldAt = now - LEASE_MS;
    return true;
  }

  view(): DispatcherView | null {
    if (this.holder === null) return null;
    return {
      seen_at: new Date(this.seenAt).toISOString(), holder: this.holder,
      sessions: this.sessions, sessions_at: this.sessions ? new Date(this.sessionsAt).toISOString() : null, error: this.error,
    };
  }
}

/** The queued requests that are due: never tried, or the last failed try is RETRY_MS old. */
export function dueFixRequests(db: DatabaseSync, now = new Date()): FixRequestRow[] {
  return listFixRequests(db, { status: 'queued' })
    .filter((r) => r.delivery_at === null || now.getTime() - Date.parse(r.delivery_at) >= RETRY_MS);
}

/** The link with this key in a build, as an example; null when the build has no such link. */
function edgeExample(db: DatabaseSync, idx: BuildIndex, edgeKey: string): LinkExample | null {
  const k = parseMergeKey(edgeKey);
  const d = k ? idx.atoms.get(k.demand_atom_id) : undefined;
  if (!d) return null;
  const ce = idx.edgesForCard(d.oracle_id);
  const e = [...ce.in, ...ce.classes, ...ce.anti, ...ce.out].find((x) => x.key === edgeKey);
  return e ? examples(db, idx, [e])[0]! : null;
}

// ---------- the brief ----------

/** The instructions of the receiving session, as the owner wrote them (owner request 2026-10-18). */
export const BRIEF_INSTRUCTIONS =
  'The owner reports say this reason is wrong or too broad. Treat the owner notes as owner decisions. ' +
  'Use your own Magic knowledge (CLAUDE.md). Find why the reason links these cards, propose the smallest fix ' +
  '(rule predicate, rule status, a new param, or a v15 item), and do not change rules or rebuild without a clear plan; write a short report.';

/** The commands that mark a request done. On Windows, `curl` in PowerShell is Invoke-WebRequest, so use `curl.exe`. */
export function doneCommands(id: number): string[] {
  const url = `http://127.0.0.1:8787/api/fix-requests/${id}/done`;
  return [
    `  - Bash or cmd: \`curl.exe -s -X POST ${url}\``,
    `  - PowerShell: \`Invoke-RestMethod -Method Post -Uri ${url}\``,
  ];
}

const quoteBlock = (text: string) => text.split(/\r?\n/).map((l) => `> ${l}`).join('\n');

const marked = (quote: string) => (quote ? `"${quote}"` : '(no text is marked)');

function exampleLine(e: LinkExample): string {
  const grade = e.grade === 'confirmed' ? 'strong match' : 'possible match';
  return `**${e.supply_name}** gives ${marked(e.supply_quote)} → **${e.demand_name}** needs ${marked(e.demand_quote)} ` +
    `(${e.polarity === '-' ? 'conflict, ' : ''}${grade}, strength ${e.strength.toFixed(2)}; link key \`${e.key}\`)`;
}

function displayPath(p: string): string {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith('..') && !isAbsolute(r) ? r.replace(/\\/g, '/') : p;
}

export function briefMarkdown(b: {
  id: number; session_name: string; created_at: string; brief_path: string; note: string;
  group: ReasonGroup; labels: Record<string, string>; build: { id: number; rule_set_id: number; scope: string } | null;
  clicked: LinkExample | null;
}): string {
  const g = b.group;
  const ids = g.rules.map((r) => r.rule_id).join(', ');
  const out: string[] = [];
  out.push(`# Fix request ${b.id}: reason ${ids}`, '');
  out.push('**Language:** ASD-STE100', '');
  out.push(`- Session name: ${b.session_name}`);
  out.push(`- Created: ${b.created_at}`);
  out.push(`- Brief file: ${displayPath(b.brief_path)}`);
  out.push(b.build ? `- Graph build: ${b.build.id} (scope ${b.build.scope}, rule set ${b.build.rule_set_id})` : '- Graph build: none');
  out.push(`- Reports on this reason: ${g.report_count}`, '');

  out.push('## Instructions', '', BRIEF_INSTRUCTIONS, '');
  out.push('- Use only the card text, the rule evidence and the owner notes in this file, and the project data.');
  out.push('- Some owner notes come from voice input. Some words can be wrong. Read the note for its meaning.');
  out.push('- When your report is ready, mark this request done. Run one of these commands:', '');
  out.push(...doneCommands(b.id), '');

  out.push('## The reason', '');
  for (const r of g.rules) {
    out.push(`### ${r.rule_id}`, '');
    out.push(`- Plain sentence: ${r.sentence}`);
    out.push(`- Technical form: \`${r.technical}\``);
    out.push(`- Rule hash: \`${r.rule_hash}\` (rule set ${r.rule_set_id})`);
    out.push(`- Status: ${r.status}, ${r.votes} of 3 runs wrote this rule`);
    out.push(`- Supply type: ${'intrinsic' in r.supply ? kindName(r.supply.intrinsic, r.supply.value) : `${typeName(typeId(r.supply), b.labels)} (\`${typeId(r.supply)}\`)`}`);
    out.push(`- Demand type: ${typeName(typeId(r.demand), b.labels)} (\`${typeId(r.demand)}\`)`);
    if (r.param_links.length) out.push(`- Param links: ${r.param_links.map((p) => `\`${p.supply} -> ${p.demand}\``).join(', ')}`);
    else out.push('- Param links: none');
    if (r.implications.length) {
      out.push('- Implications:');
      for (const i of r.implications) out.push(`  - \`${i.demand_param} = ${JSON.stringify(i.value)}\`: ${i.evidence.map((e) => `${e.source === 'rule' ? `CR ${e.ref}` : e.ref} "${e.quote}"`).join('; ')}`);
    }
    out.push('- Evidence quotes:');
    for (const e of r.evidence) out.push(`  - ${e.source === 'rule' ? `CR ${e.ref}` : e.ref}: "${e.quote}"`);
    out.push('');
  }

  out.push(`## Owner reports (${g.report_count})`, '');
  if (g.reports.length === 0) out.push('No report is on this reason yet. The owner sent this request from one link.', '');
  for (const r of g.reports) {
    out.push(`### Report ${r.id} (${r.created_at}, build ${r.build_id}, status ${r.status})`, '');
    out.push(`- Link: **${r.supply_name}** → **${r.demand_name}**`);
    out.push(`- Link key: \`${r.edge_key}\``);
    out.push('- Owner note (an owner decision):', '');
    out.push(quoteBlock(r.note), '');
  }

  if (b.clicked) {
    out.push('## The link that the owner opened this request from', '', `- ${exampleLine(b.clicked)}`, '');
  }

  out.push('## Links of this reason', '');
  if (g.links) {
    const l = g.links;
    out.push(`In build ${l.build_id}, this reason makes ${l.count} links (${l.strong} strong matches, ${l.possible} possible matches) between ${l.card_pairs} card pairs.`, '');
    out.push('Example card pairs (the strongest link of each pair):', '');
    l.examples.forEach((e, i) => out.push(`${i + 1}. ${exampleLine(e)}`));
    out.push('');
  } else {
    out.push('No graph build is available, so the link count is not known.', '');
  }

  out.push('## Owner note on this request', '');
  out.push(b.note ? quoteBlock(b.note) : 'No note.', '');
  return out.join('\n');
}
