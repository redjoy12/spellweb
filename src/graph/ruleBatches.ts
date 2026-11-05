/**
 * The file protocol of the edge-rule deriver (Phase 3 spec sec. 5.2-5.4, plan Task 3 and D5).
 *
 * `prepareRoles` and `preparePairs` write one directory for each pass of each batch. A FRESH
 * `edge-rule-deriver` subagent reads its `packet.md` and writes `response.json`. `submitStage`
 * validates each item (sec. 5.4), votes (sec. 5.3) and stores. The code makes no model call.
 *
 * Layout: <ruleBatchesDir>/set-<n>/<stage>/<batch_key>/pass-<k>/{manifest.json, packet.md, response.json}
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { isCoverageGap, typeCrContent, typeEntries } from './crContent.js';
import { enqueueEdgeFinding } from './edgeQueue.js';
import { BATCH_PART_TITLE, packetContext, planPairBatchPart, planRolePackets, typeId, type PacketChunk, type PacketContext } from './edgePackets.js';
import {
  checkTwoPart, debaterAgent, deriverAgents, isTwoPart, twoPartSha, writeAgentFiles, type GeneratedAgent, type TwoPartManifest,
} from './pairFixed.js';
import { stageBTypes } from './liveTypes.js';
import { carriedDemands, shownCandidates } from './ruleCarry.js';
import { baseContext, canonicalIntrinsic, validateRole, validateRule, type RejectCause, type ValidateContext } from './ruleValidate.js';
import {
  PairsResponse, RolesResponse, isIntrinsic, ruleHash, unionEvidence, type EdgeRuleItem, type MissingRule, type RoleItem,
} from './ruleSchema.js';
import {
  assignRuleIds, createRuleSet, getRuleSet, pendingRoleItems, refreshPacketSha, refreshRoleRanks,
} from './ruleSet.js';
import { voteRoles, voteRules, type VotedRule } from './ruleVotes.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = resolve(here, '../../data/edge-rule-batches');

/** Read on every call, so tests can point it at a temp directory and never touch `data/`. */
export function ruleBatchesDir(): string {
  return process.env['EDGE_RULE_BATCHES_DIR'] ?? DEFAULT_DIR;
}

/** spec sec. 5.3: each batch runs three times. */
export const PASSES = 3;
export type Stage = 'roles' | 'pairs';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
export const passDir = (setId: number, stage: Stage, batchKey: string, pass: number) =>
  join(ruleBatchesDir(), `set-${setId}`, stage, batchKey, `pass-${pass}`);

export interface RuleManifest {
  set_id: number;
  stage: Stage;
  batch_key: string;
  pass_index: number;
  corpus_id: number;
  schema_version: number;
  demand: string | null;
  types: string[];
  packet_sha: string;
  packet_bytes: number;
  /** Two-part Stage B packets (spec rev. 10 sec. 5.2): the generated agent and its file sha. */
  agent?: string;
  agent_sha?: string;
}

interface BatchRow { batch_key: string; demand: string | null; types_json: string; refs_json: string; packet_sha: string; packet_bytes: number }

/** The types of a schema version with no CR content from sets 1 to 3 (spec sec. 5.2). */
export function coverageGapTypes(db: DatabaseSync, ctx: PacketContext): string[] {
  return typeEntries(db, ctx.schemaVersion)
    .filter((e) => isCoverageGap(typeCrContent(db, ctx.corpusId, ctx.schemaVersion, e, ctx.termPolicy)))
    .map(typeId);
}

function writeBatch(
  db: DatabaseSync, setId: number, ctx: PacketContext, batchKey: string, c: PacketChunk, demand: string | null, agent?: GeneratedAgent,
): string[] {
  const packetSha = agent ? twoPartSha(agent.sha, c.markdown) : sha(c.markdown);
  const two: TwoPartManifest | Record<string, never> = agent ? { agent: agent.name, agent_sha: agent.sha } : {};
  const dirs: string[] = [];
  for (let k = 1; k <= PASSES; k++) {
    const dir = passDir(setId, c.stage, batchKey, k);
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, 'response.json'), { force: true });   // never an old answer next to a new packet
    const m: RuleManifest = {
      set_id: setId, stage: c.stage, batch_key: batchKey, pass_index: k, corpus_id: ctx.corpusId,
      schema_version: ctx.schemaVersion, demand, types: c.types, packet_sha: packetSha, packet_bytes: c.bytes, ...two,
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
    writeFileSync(join(dir, 'packet.md'), c.markdown);
    dirs.push(dir);
  }
  db.prepare(
    `INSERT INTO edge_rule_batches (set_id, stage, batch_key, demand, types_json, refs_json, packet_sha, packet_bytes, prepared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(setId, c.stage, batchKey, demand, JSON.stringify(c.types), JSON.stringify(c.refs), packetSha, c.bytes, new Date().toISOString());
  return dirs;
}

/**
 * Stage A (spec sec. 5.3): a new set, and three pass directories for each chunk of all types.
 * A coverage-gap type is not in a packet: the gap blocks that type (sec. 5.2). Its role is not
 * derived, so it gets no Stage B batch.
 */
export function prepareRoles(
  db: DatabaseSync, model: string, over: Partial<PacketContext> = {},
): { setId: number; version: number; dirs: string[]; gaps: string[] } {
  const ctx = packetContext(db, over);
  const gaps = coverageGapTypes(db, ctx);
  const chunks = planRolePackets(db, ctx, new Set(gaps));
  const dirs: string[] = [];
  // The set row is in the same transaction: a failed write leaves no in-progress set behind.
  db.exec('BEGIN');
  try {
    const { setId, version } = createRuleSet(db, model, { schemaVersion: ctx.schemaVersion, corpusId: ctx.corpusId });
    chunks.forEach((c, i) => dirs.push(...writeBatch(db, setId, ctx, `roles-${i}`, c, null)));
    refreshPacketSha(db, setId, sha);
    db.exec('COMMIT');
    return { setId, version, dirs, gaps };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * The Stage B plan of a set (spec sec. 5.3): one batch for each demand type of Stage A, with the
 * accepted supply types as candidates, in chunks. A role that is decided later gets its batches at
 * the next prepare: a new demand type gets a batch; a demand type that has batches already gets a
 * supplementary batch with only the supply candidates that its batches do not show, and none when
 * there are none (`skipped`). A carried demand type (ruleCarry.ts) is such a type: its source batches
 * count. `first` is the chunk number of the first new chunk of a demand type.
 * `only` limits the plan to some demand types (a pilot); the other types wait for a later prepare.
 * `again` (spec sec. 25.5) shows these supply candidates although a batch showed them: a new param on
 * a supply type can give a new rule. It needs `only`, and each named type must be a supply candidate.
 */
export interface PairBatchPlan {
  demand: string;
  first: number;
  /** One two-part batch for each deriver group with candidates (spec rev. 10 sec. 5.2). */
  chunks: PacketChunk[];
  /** The generated deriver agent of each chunk. */
  agents: GeneratedAgent[];
}

export function planSetPairs(
  db: DatabaseSync, setId: number, over: Partial<PacketContext> = {}, only?: ReadonlySet<string>, again?: ReadonlySet<string>,
): { ctx: PacketContext; batches: PairBatchPlan[]; skipped: string[]; deferred: string[]; agents: GeneratedAgent[] } {
  const set = getRuleSet(db, setId);
  if (!set) throw new Error(`no edge-rule set ${setId}`);
  const open = db.prepare(
    `SELECT b.batch_key FROM edge_rule_batches b WHERE b.set_id = ? AND b.stage = 'roles'
        AND (SELECT COUNT(*) FROM edge_rule_passes p WHERE p.set_id = b.set_id AND p.stage = 'roles' AND p.batch_key = b.batch_key) < ?`,
  ).all(setId, PASSES) as Array<{ batch_key: string }>;
  if (open.length) throw new Error(`Stage A is not submitted for: ${open.map((o) => o.batch_key).join(', ')}`);
  // The supply candidates that the batches of each demand type show, and the batch count. A
  // carried demand type (ruleCarry.ts) counts the batches of its source set too.
  const shown = shownCandidates(db, setId);
  const fixed = deriverAgents(db, setId, over);
  // spec rev. 10 sec. 5.3: only the types in the Stage B scope; the deferred ones wait for a card.
  const { supply, demand: all, deferred } = stageBTypes(db, setId, fixed.ctx);
  if (only) {
    const late = [...only].filter((d) => deferred.includes(d));
    if (late.length) throw new Error(`deferred (no current atom has the type, spec rev. 10 sec. 5.3): ${late.join(', ')}`);
    const bad = [...only].filter((d) => !all.includes(d));
    if (bad.length) throw new Error(`not a demand type of set ${setId}: ${bad.join(', ')}`);
  }
  if (again) {
    if (!only) throw new Error('--supply needs --demand');
    const unknown = [...again].filter((t) => !supply.includes(t));
    if (unknown.length) throw new Error(`not a supply candidate of set ${setId}: ${unknown.join(', ')}`);
  }
  const batches: PairBatchPlan[] = [];
  const skipped: string[] = [];
  for (const d of all.filter((x) => !only || only.has(x))) {
    const old = shown.get(d);
    const candidates = old ? supply.filter((t) => !old.types.has(t) || again?.has(t)) : supply;
    if (old && candidates.length === 0) { skipped.push(d); continue; }
    const b: PairBatchPlan = { demand: d, first: old?.n ?? 0, chunks: [], agents: [] };
    for (const g of fixed.groups) {
      const sub = candidates.filter((t) => g.supply.includes(t));
      if (sub.length === 0) continue;
      b.chunks.push(planPairBatchPart(db, fixed.ctx, d, sub, g.shared, g.group));
      b.agents.push(g.agent);
    }
    batches.push(b);
  }
  return { ctx: fixed.ctx, batches, skipped, deferred, agents: fixed.groups.map((g) => g.agent) };
}

/**
 * Stage B: three pass directories for each chunk of each new demand type, and of each supplementary
 * batch (planSetPairs). `pendingRoles` lists the role items that nobody decided: those types stay
 * `none` (plan Step 7).
 */
export function preparePairs(
  db: DatabaseSync, setId: number, over: Partial<PacketContext> = {}, only?: ReadonlySet<string>, again?: ReadonlySet<string>,
): {
  dirs: string[]; batches: number; skipped: string[]; deferred: string[]; pendingRoles: string[]; agentsWritten: string[]; agentOf: Map<string, string>;
} {
  const set = getRuleSet(db, setId);
  if (!set) throw new Error(`no edge-rule set ${setId}`);
  if (set.status !== 'in_progress') throw new Error(`set ${setId} is ${set.status}, not in_progress`);
  const plan = planSetPairs(db, setId, over, only, again);
  // The debater agent too: a debate of these batches needs it, and it has the same basis.
  const agentsWritten = writeAgentFiles([...plan.agents, debaterAgent(db, setId, over)]);
  const dirs: string[] = [];
  const agentOf = new Map<string, string>();
  db.exec('BEGIN');
  try {
    for (const b of plan.batches) {
      b.chunks.forEach((c, i) => {
        const written = writeBatch(db, setId, plan.ctx, `${b.demand}-${b.first + i}`, c, b.demand, b.agents[i]);
        for (const w of written) agentOf.set(w, b.agents[i]!.name);
        dirs.push(...written);
      });
    }
    refreshPacketSha(db, setId, sha);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return {
    dirs, batches: plan.batches.length, skipped: plan.skipped, deferred: plan.deferred, pendingRoles: pendingRoleItems(db, setId), agentsWritten, agentOf,
  };
}

// ---- submit -------------------------------------------------------------------------------------

export interface SubmitResult {
  batches: number;
  /** Batches with fewer than three responses: not stored. */
  waiting: string[];
  /** Responses that do not parse: their batch is not stored, so that the pass can run again. */
  unreadable: string[];
  items_valid: number;
  items_rejected: number;
  accepted: number;
  disputed: number;
  missing_rules: number;
  queued: number;
}

type Parsed = { stage: 'roles'; items: RoleItem[]; missing: MissingRule[] } | { stage: 'pairs'; items: EdgeRuleItem[]; missing: MissingRule[] };

function parseResponse(stage: Stage, file: string): Parsed {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (stage === 'roles') {
    const r = RolesResponse.safeParse(raw);
    if (!r.success) throw new Error(r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; '));
    return { stage, items: r.data.roles, missing: r.data.missing_rules };
  }
  const r = PairsResponse.safeParse(raw);
  if (!r.success) throw new Error(r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; '));
  return { stage, items: r.data.rules as EdgeRuleItem[], missing: r.data.missing_rules };
}

/** An intrinsic value in its permitted spelling, so that equal classes get equal hashes. */
function normalizeRule(ctx: ValidateContext, r: EdgeRuleItem): EdgeRuleItem {
  if (!isIntrinsic(r.supply)) return r;
  return { ...r, supply: { intrinsic: r.supply.intrinsic, value: canonicalIntrinsic(ctx, r.supply)! } };
}

/**
 * Reads, validates, votes and stores each batch of a stage whose three responses are present
 * and not yet stored. A batch that is stored already is skipped, so a second submit adds no rows.
 */
export function submitStage(db: DatabaseSync, setId: number, stage: Stage, over: { resources?: readonly string[] } = {}): SubmitResult {
  const set = getRuleSet(db, setId);
  if (!set) throw new Error(`no edge-rule set ${setId}`);
  if (set.status !== 'in_progress') throw new Error(`set ${setId} is ${set.status}, not in_progress`);
  const batches = db.prepare(
    `SELECT b.batch_key, b.demand, b.types_json, b.refs_json, b.packet_sha, b.packet_bytes FROM edge_rule_batches b
      WHERE b.set_id = ? AND b.stage = ?
        AND NOT EXISTS (SELECT 1 FROM edge_rule_passes p WHERE p.set_id = b.set_id AND p.stage = b.stage AND p.batch_key = b.batch_key)
      ORDER BY b.batch_key`,
  ).all(setId, stage) as unknown as BatchRow[];
  const pctx = packetContext(db, { corpusId: set.corpus_id, schemaVersion: set.schema_version });
  const base = baseContext(db, {
    corpusId: set.corpus_id, schemaVersion: set.schema_version, scope: pctx.scope,
    resources: over.resources ?? pctx.graph.resources,
  });

  const out: SubmitResult = { batches: 0, waiting: [], unreadable: [], items_valid: 0, items_rejected: 0, accepted: 0, disputed: 0, missing_rules: 0, queued: 0 };
  const ready: Array<{ b: BatchRow; files: string[]; parsed: Parsed[] }> = [];
  for (const b of batches) {
    const files = Array.from({ length: PASSES }, (_, k) => join(passDir(setId, stage, b.batch_key, k + 1), 'response.json'));
    if (files.some((f) => !existsSync(f))) { out.waiting.push(b.batch_key); continue; }
    const parsed: Parsed[] = [];
    let bad = false;
    for (const f of files) {
      try { parsed.push(parseResponse(stage, f)); } catch (err) { out.unreadable.push(`${f} (${(err as Error).message})`); bad = true; }
    }
    if (!bad) ready.push({ b, files, parsed });
  }
  // A two-part batch (spec rev. 10 sec. 5.2) counts only with the fixed part of its prepare.
  for (const { b } of ready) {
    for (let k = 1; k <= PASSES; k++) {
      const dir = passDir(setId, stage, b.batch_key, k);
      if (isTwoPart(dir, BATCH_PART_TITLE)) checkTwoPart(dir, b.packet_sha);
    }
  }

  const insPass = db.prepare(
    `INSERT INTO edge_rule_passes (set_id, stage, batch_key, pass_index, packet_bytes, response_sha, items_valid, items_rejected)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insItem = db.prepare(
    'INSERT OR IGNORE INTO edge_rule_pass_items (set_id, stage, batch_key, pass_index, item_key, item_json) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insReject = db.prepare('INSERT INTO edge_rule_rejections (set_id, stage, batch_key, pass_index, item_json, cause) VALUES (?, ?, ?, ?, ?, ?)');
  const insMissing = db.prepare(
    "INSERT INTO edge_missing_rule_reports (set_id, stage, batch_key, pass_index, needed, rationale, status) VALUES (?, ?, ?, ?, ?, ?, 'open')",
  );

  db.exec('BEGIN');
  try {
    for (const { b, files, parsed } of ready) {
      const ctx: ValidateContext = {
        ...base,
        packetTypes: new Set(JSON.parse(b.types_json) as string[]),
        refs: new Set(JSON.parse(b.refs_json) as string[]),
        ...(b.demand ? { demand: b.demand } : {}),
      };
      const valid: Array<Array<RoleItem | EdgeRuleItem>> = [];
      parsed.forEach((p, k) => {
        const keep: Array<RoleItem | EdgeRuleItem> = [];
        let rejected = 0;
        for (const item of p.items) {
          const cause: RejectCause | null = p.stage === 'roles'
            ? validateRole(db, ctx, item as RoleItem)
            : validateRule(db, ctx, item as EdgeRuleItem);
          if (cause) {
            insReject.run(setId, stage, b.batch_key, k + 1, JSON.stringify(item), cause);
            rejected++;
            continue;
          }
          const v = p.stage === 'roles' ? item as RoleItem : normalizeRule(ctx, item as EdgeRuleItem);
          keep.push(v);
          const key = p.stage === 'roles' ? `${(v as RoleItem).family}.${(v as RoleItem).type_key}` : ruleHash(v as EdgeRuleItem);
          insItem.run(setId, stage, b.batch_key, k + 1, key, JSON.stringify(v));
        }
        for (const m of p.missing) insMissing.run(setId, stage, b.batch_key, k + 1, m.needed, m.rationale);
        insPass.run(setId, stage, b.batch_key, k + 1, b.packet_bytes, sha(readFileSync(files[k]!, 'utf8')), keep.length, rejected);
        out.items_valid += keep.length;
        out.items_rejected += rejected;
        out.missing_rules += p.missing.length;
        valid.push(keep);
      });
      if (stage === 'roles') storeRoles(db, setId, valid as RoleItem[][], JSON.parse(b.types_json) as string[], out);
      else storeRules(db, setId, valid as EdgeRuleItem[][], out);
      out.batches++;
    }
    if (stage === 'pairs') {
      assignRuleIds(db, setId);
      refreshRoleRanks(db, setId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return out;
}

const roleRowid = (db: DatabaseSync, setId: number, id: string) => (db.prepare(
  "SELECT rowid FROM edge_type_roles WHERE set_id = ? AND family || '.' || type_key = ?",
).get(setId, id) as { rowid: number }).rowid;

/**
 * Stage A: each type of the batch gets one row. A type with no majority role - also a type that
 * no pass gave - gets the role `none`, status `disputed` and a review item. A type for which any
 * valid pass item names the resource `other` also gets a review item (spec sec. 5.3).
 */
function storeRoles(db: DatabaseSync, setId: number, passes: RoleItem[][], types: string[], out: SubmitResult): void {
  const { accepted, disputed } = voteRoles(passes);
  const ins = db.prepare(
    `INSERT INTO edge_type_roles (set_id, family, type_key, role, demand_note, resources_json, evidence_json, votes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const given = new Set<string>();
  const queue = (id: string) => {
    out.queued += enqueueEdgeFinding(db, {
      severity: 'edge_role_disagreement', ruleSetId: setId, detailTable: 'edge_type_roles',
      detailId: roleRowid(db, setId, id), rankScore: 0,
    });
  };
  for (const r of accepted) {
    given.add(`${r.family}.${r.type_key}`);
    ins.run(setId, r.family, r.type_key, r.role, r.demand_note ?? null, JSON.stringify(r.resources), JSON.stringify(r.evidence), r.votes, 'accepted');
    out.accepted++;
  }
  for (const r of disputed) {
    const id = `${r.family}.${r.type_key}`;
    given.add(id);
    ins.run(setId, r.family, r.type_key, 'none', null, JSON.stringify(r.resources), '[]', r.votes, 'disputed');
    out.disputed++;
    queue(id);
  }
  for (const id of types.filter((t) => !given.has(t))) {
    const [family, typeKey] = [id.slice(0, id.indexOf('.')), id.slice(id.indexOf('.') + 1)];
    ins.run(setId, family, typeKey, 'none', null, '[]', '[]', 0, 'disputed');
    out.disputed++;
    queue(id);
  }
  const other = new Set(passes.flat().filter((r) => r.resources.some((e) => e.resource === 'other')).map((r) => `${r.family}.${r.type_key}`));
  for (const id of other) queue(id);
}

/**
 * Stage B: accepted and disputed rules go into `edge_rules`; only accepted ones reach a build.
 * Each disputed rule gets a review item with rank score 0 until the first build (sec. 10.1).
 * The same intrinsic rule can come from two chunks of one demand type: the rows merge, with the
 * higher vote count and the union of the evidence.
 */
function storeRules(db: DatabaseSync, setId: number, passes: EdgeRuleItem[][], out: SubmitResult): void {
  const { accepted, disputed } = voteRules(passes);
  const get = db.prepare('SELECT votes, status, evidence_json, implications FROM edge_rules WHERE set_id = ? AND rule_hash = ?');
  const ins = db.prepare(
    `INSERT INTO edge_rules (set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upd = db.prepare('UPDATE edge_rules SET votes = ?, status = ?, evidence_json = ?, implications = ? WHERE set_id = ? AND rule_hash = ?');
  const store = (r: VotedRule, status: 'accepted' | 'disputed') => {
    const old = get.get(setId, r.rule_hash) as { votes: number; status: string; evidence_json: string; implications: string } | undefined;
    if (!old) {
      ins.run(setId, r.rule_hash, `pending:${r.rule_hash}`, r.polarity, JSON.stringify(r.supply), JSON.stringify(r.demand),
        JSON.stringify(r.param_links), JSON.stringify(r.implications), JSON.stringify(r.evidence), r.votes, status);
    } else {
      const oldImpl = JSON.parse(old.implications) as EdgeRuleItem['implications'];
      const impl = r.implications.map((i, n) => ({ ...i, evidence: unionEvidence(oldImpl[n]?.evidence ?? [], i.evidence) }));
      const st = old.status === 'accepted' || status === 'accepted' ? 'accepted' : 'disputed';
      upd.run(Math.max(old.votes, r.votes), st, JSON.stringify(unionEvidence(JSON.parse(old.evidence_json), r.evidence)),
        JSON.stringify(impl), setId, r.rule_hash);
    }
  };
  for (const r of accepted) { store(r, 'accepted'); out.accepted++; }
  for (const r of disputed) { store(r, 'disputed'); out.disputed++; }
  // A rule disputed in one chunk and accepted in another is accepted: its review item is not made.
  for (const r of disputed) {
    const row = db.prepare('SELECT rowid, status FROM edge_rules WHERE set_id = ? AND rule_hash = ?').get(setId, r.rule_hash) as { rowid: number; status: string };
    if (row.status !== 'disputed') continue;
    out.queued += enqueueEdgeFinding(db, {
      severity: 'edge_rule_disagreement', ruleSetId: setId, detailTable: 'edge_rules', detailId: row.rowid, rankScore: 0,
    });
  }
  // A rule accepted now that was disputed before: its earlier review item is resolved.
  for (const r of accepted) {
    const row = db.prepare('SELECT rowid FROM edge_rules WHERE set_id = ? AND rule_hash = ?').get(setId, r.rule_hash) as { rowid: number };
    db.prepare(
      `UPDATE review_queue SET status = 'resolved' WHERE domain = 'edge' AND rule_set_id = ? AND severity = 'edge_rule_disagreement'
          AND detail_table = 'edge_rules' AND detail_id = ? AND status = 'pending'`,
    ).run(setId, row.rowid);
  }
}

// ---- status -------------------------------------------------------------------------------------

export interface SetStatus {
  set: { id: number; version: number; status: string; model: string; schema_version: number; corpus_id: number; packet_sha: string };
  stages: Record<Stage, { batches: number; submitted: number; passes: number; items_valid: number; items_rejected: number }>;
  roles: Record<string, number>;
  roles_disputed: number;
  rules: { accepted: number; disputed: number; plus: number; minus: number; intrinsic: number };
  rejections: Record<string, number>;
  missing_rules_open: number;
  queue_pending: Record<string, number>;
  /** A carry-forward set (ruleCarry.ts): the source set, the carried demand types and their copied rules. */
  carried: { from_set_id: number; demands: number; rules: number } | null;
}

export function setStatus(db: DatabaseSync, setId: number): SetStatus {
  const s = getRuleSet(db, setId);
  if (!s) throw new Error(`no edge-rule set ${setId}`);
  const stage = (st: Stage) => {
    const b = db.prepare('SELECT COUNT(*) n FROM edge_rule_batches WHERE set_id = ? AND stage = ?').get(setId, st) as { n: number };
    const p = db.prepare(
      `SELECT COUNT(DISTINCT batch_key) sub, COUNT(*) n, COALESCE(SUM(items_valid), 0) v, COALESCE(SUM(items_rejected), 0) r
         FROM edge_rule_passes WHERE set_id = ? AND stage = ?`,
    ).get(setId, st) as { sub: number; n: number; v: number; r: number };
    return { batches: b.n, submitted: p.sub, passes: p.n, items_valid: p.v, items_rejected: p.r };
  };
  const carried = carriedDemands(db, setId);
  const group = (sql: string) => Object.fromEntries((db.prepare(sql).all(setId) as Array<{ k: string; n: number }>).map((r) => [r.k, r.n]));
  const rules = db.prepare(
    `SELECT SUM(status = 'accepted') a, SUM(status = 'disputed') d, SUM(status = 'accepted' AND polarity = '+') p,
            SUM(status = 'accepted' AND polarity = '-') m, SUM(status = 'accepted' AND supply_json LIKE '{"intrinsic"%') i
       FROM edge_rules WHERE set_id = ?`,
  ).get(setId) as Record<string, number | null>;
  return {
    set: { id: s.id, version: s.version, status: s.status, model: s.model, schema_version: s.schema_version, corpus_id: s.corpus_id, packet_sha: s.packet_sha },
    stages: { roles: stage('roles'), pairs: stage('pairs') },
    roles: group("SELECT role k, COUNT(*) n FROM edge_type_roles WHERE set_id = ? AND status = 'accepted' GROUP BY role"),
    roles_disputed: (db.prepare("SELECT COUNT(*) n FROM edge_type_roles WHERE set_id = ? AND status = 'disputed'").get(setId) as { n: number }).n,
    rules: { accepted: rules['a'] ?? 0, disputed: rules['d'] ?? 0, plus: rules['p'] ?? 0, minus: rules['m'] ?? 0, intrinsic: rules['i'] ?? 0 },
    rejections: group('SELECT cause k, COUNT(*) n FROM edge_rule_rejections WHERE set_id = ? GROUP BY cause'),
    missing_rules_open: (db.prepare("SELECT COUNT(*) n FROM edge_missing_rule_reports WHERE set_id = ? AND status = 'open'").get(setId) as { n: number }).n,
    queue_pending: group("SELECT severity k, COUNT(*) n FROM review_queue WHERE domain = 'edge' AND rule_set_id = ? AND status = 'pending' GROUP BY severity"),
    carried: carried.size === 0 ? null : {
      from_set_id: [...carried.values()][0]!.from_set_id, demands: carried.size, rules: [...carried.values()].reduce((n, c) => n + c.rules, 0),
    },
  };
}
