/**
 * Edge-rule sets: create, rule ids, accept, supersede, and a person's decision on a disputed
 * role (Phase 3 spec sec. 5.3, 5.5, plan Task 3 and D13).
 *
 * The session never decides a role. `decideRole` copies the proposal of one pass, with the
 * evidence that the submit verified, and `keepRoleNone` keeps the role 'none'. Both record the
 * note in `edge_role_decisions` and resolve the review item of the type. The decider is a person
 * or, until the first demo, an agreed debate of isolated subagents (spec rev. 9 sec. 5.6).
 */
import type { DatabaseSync } from 'node:sqlite';
import { currentSchemaVersion } from '../atoms/schema.js';
import { isIntrinsic, type EdgeRuleItem, type Role, type RoleItem, type SupplySide, type TypeSide } from './ruleSchema.js';

/** A refusal: `invalid` is a 400, `not_found` a 404. */
export class RuleSetError extends Error {
  constructor(readonly kind: 'invalid' | 'not_found', message: string) { super(message); }
}

export interface RuleSetRow {
  id: number; version: number; schema_version: number; corpus_id: number; packet_sha: string;
  model: string; status: 'in_progress' | 'accepted' | 'superseded'; created_at: string;
}

export function getRuleSet(db: DatabaseSync, setId: number): RuleSetRow | undefined {
  return db.prepare('SELECT * FROM edge_rule_sets WHERE id = ?').get(setId) as RuleSetRow | undefined;
}

function requireSet(db: DatabaseSync, setId: number): RuleSetRow {
  const s = getRuleSet(db, setId);
  if (!s) throw new RuleSetError('not_found', `no edge-rule set ${setId}`);
  return s;
}

/**
 * spec sec. 5.5: a new set, status `in_progress`, on the current schema and corpus. The packet
 * SHA is filled by the prepare of each stage (`addPacketSha`).
 */
export function createRuleSet(db: DatabaseSync, model: string, over: { schemaVersion?: number; corpusId?: number } = {}): { setId: number; version: number } {
  const open = db.prepare("SELECT id FROM edge_rule_sets WHERE status = 'in_progress'").get() as { id: number } | undefined;
  if (open) throw new RuleSetError('invalid', `set ${open.id} is in progress: finish or accept it first`);
  const corpus = over.corpusId ?? (db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as { id: number } | undefined)?.id;
  if (corpus === undefined) throw new Error('no current rules corpus');
  const version = ((db.prepare('SELECT MAX(version) v FROM edge_rule_sets').get() as { v: number | null }).v ?? 0) + 1;
  const setId = Number(db.prepare(
    `INSERT INTO edge_rule_sets (version, schema_version, corpus_id, packet_sha, model, status, created_at)
     VALUES (?, ?, ?, '', ?, 'in_progress', ?)`,
  ).run(version, over.schemaVersion ?? currentSchemaVersion(db), corpus, model, new Date().toISOString()).lastInsertRowid);
  return { setId, version };
}

/**
 * The SHA of the packets of a set: the SHA of the batch packet SHAs, in batch order. Each
 * prepare calls it again, so the value covers every batch of both stages.
 */
export function refreshPacketSha(db: DatabaseSync, setId: number, sha: (s: string) => string): void {
  const shas = (db.prepare('SELECT packet_sha FROM edge_rule_batches WHERE set_id = ? ORDER BY stage, batch_key').all(setId) as
    Array<{ packet_sha: string }>).map((r) => r.packet_sha);
  db.prepare('UPDATE edge_rule_sets SET packet_sha = ? WHERE id = ?').run(sha(shas.join('\n')), setId);
}

const ruleNumber = (id: string) => Number(id.slice(3));
const formatId = (n: number) => `ER-${String(n).padStart(4, '0')}`;

/**
 * spec sec. 5.1: a rule with a `rule_hash` of an earlier set keeps its earlier `rule_id`; a new
 * rule gets the next free id. Each call gives its new ids in `rule_hash` order. A Stage B submit
 * in parts calls it after each part, so the ids follow the order of the parts. Idempotent.
 */
export function assignRuleIds(db: DatabaseSync, setId: number): void {
  const rows = db.prepare("SELECT rule_hash FROM edge_rules WHERE set_id = ? AND rule_id NOT LIKE 'ER-%' ORDER BY rule_hash")
    .all(setId) as Array<{ rule_hash: string }>;
  if (rows.length === 0) return;
  const earlier = db.prepare(
    "SELECT rule_id FROM edge_rules WHERE rule_hash = ? AND set_id <> ? AND rule_id LIKE 'ER-%' ORDER BY set_id DESC LIMIT 1",
  );
  let next = Math.max(0, ...(db.prepare("SELECT rule_id FROM edge_rules WHERE rule_id LIKE 'ER-%'").all() as Array<{ rule_id: string }>)
    .map((r) => ruleNumber(r.rule_id))) + 1;
  const set = db.prepare('UPDATE edge_rules SET rule_id = ? WHERE set_id = ? AND rule_hash = ?');
  for (const r of rows) {
    const old = (earlier.get(r.rule_hash, setId) as { rule_id: string } | undefined)?.rule_id;
    set.run(old ?? formatId(next++), setId, r.rule_hash);
  }
}

/** The batches of a set with fewer than three stored passes: not answered or not submitted. */
export function openBatches(db: DatabaseSync, setId: number): string[] {
  return (db.prepare(
    `SELECT b.stage || ' ' || b.batch_key k FROM edge_rule_batches b WHERE b.set_id = ?
        AND (SELECT COUNT(*) FROM edge_rule_passes p WHERE p.set_id = b.set_id AND p.stage = b.stage AND p.batch_key = b.batch_key) < 3
      ORDER BY b.stage, b.batch_key`,
  ).all(setId) as Array<{ k: string }>).map((r) => r.k);
}

/** The pending role review items of a set, as FAMILY.TYPE_KEY. */
export function pendingRoleItems(db: DatabaseSync, setId: number): string[] {
  return (db.prepare(
    `SELECT t.family || '.' || t.type_key k FROM review_queue q JOIN edge_type_roles t ON t.rowid = q.detail_id
      WHERE q.domain = 'edge' AND q.rule_set_id = ? AND q.severity = 'edge_role_disagreement'
        AND q.detail_table = 'edge_type_roles' AND q.status = 'pending' ORDER BY k`,
  ).all(setId) as Array<{ k: string }>).map((r) => r.k);
}

/**
 * spec sec. 5.5: the set becomes `accepted`, and the set accepted before it `superseded`.
 * Refused while a batch has no three stored passes, or with no Stage B batch. Refused while a
 * role item is pending, unless `force` (plan Step 7: a role that nobody decides stays `none`).
 */
export function acceptRuleSet(db: DatabaseSync, setId: number, opts: { force?: boolean; carriedAll?: boolean } = {}): void {
  const s = requireSet(db, setId);
  if (s.status !== 'in_progress') throw new RuleSetError('invalid', `set ${setId} is ${s.status}, not in_progress`);
  const open = openBatches(db, setId);
  if (open.length) throw new RuleSetError('invalid', `set ${setId} has batches with no stored passes: ${open.join(', ')}`);
  // spec sec. 21: a set that carries every demand type of an earlier set needs no Stage B batch.
  const carriedAll = opts.carriedAll === true && Boolean(db.prepare('SELECT 1 FROM edge_rule_carry WHERE set_id = ?').get(setId));
  if (!carriedAll && !db.prepare("SELECT 1 FROM edge_rule_batches WHERE set_id = ? AND stage = 'pairs'").get(setId)) {
    throw new RuleSetError('invalid', `set ${setId} has no Stage B batch`);
  }
  const pending = pendingRoleItems(db, setId);
  if (pending.length && !opts.force) {
    throw new RuleSetError('invalid', `set ${setId} has ${pending.length} pending role item(s): ${pending.join(', ')}. Decide them, or accept with force: they keep the role none`);
  }
  db.exec('BEGIN');
  try {
    assignRuleIds(db, setId);
    db.prepare("UPDATE edge_rule_sets SET status = 'superseded' WHERE status = 'accepted'").run();
    db.prepare("UPDATE edge_rule_sets SET status = 'accepted' WHERE id = ?").run(setId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Plan Task 3 Step 11: a set that fails the model gate, or a prepare that failed, must not block
 * a new set. The set rows go (the cascade), and its edge review items with them. The pass
 * directories stay on disk; a new set gets a new id. An accepted set is never removed.
 */
export function abandonRuleSet(db: DatabaseSync, setId: number): void {
  const s = requireSet(db, setId);
  if (s.status !== 'in_progress') throw new RuleSetError('invalid', `set ${setId} is ${s.status}: only an in-progress set can be abandoned`);
  db.exec('BEGIN');
  try {
    db.prepare("DELETE FROM review_queue WHERE domain = 'edge' AND rule_set_id = ?").run(setId);
    db.prepare('DELETE FROM edge_rule_sets WHERE id = ?').run(setId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function currentRuleSet(db: DatabaseSync): { id: number; version: number } | null {
  return (db.prepare("SELECT id, version FROM edge_rule_sets WHERE status = 'accepted'").get() as { id: number; version: number } | undefined) ?? null;
}

/** The in-progress set, else null. */
export function openRuleSet(db: DatabaseSync): { id: number; version: number } | null {
  return (db.prepare("SELECT id, version FROM edge_rule_sets WHERE status = 'in_progress'").get() as { id: number; version: number } | undefined) ?? null;
}

export interface StoredRule extends EdgeRuleItem { rule_hash: string; rule_id: string; votes: number; status: 'accepted' | 'disputed' }

/**
 * The rules of a set. The build uses `status = 'accepted'` only: a disputed rule stays out until
 * a person adopts it in a new set version (spec rev. 6 sec. 5.3).
 */
export function setRules(db: DatabaseSync, setId: number, status: 'accepted' | 'disputed' | 'all' = 'accepted'): StoredRule[] {
  const rows = db.prepare(
    `SELECT rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status
       FROM edge_rules WHERE set_id = ? AND (? = 'all' OR status = ?) ORDER BY rule_id, rule_hash`,
  ).all(setId, status, status) as Array<Record<string, string | number>>;
  return rows.map((r) => ({
    rule_hash: String(r['rule_hash']), rule_id: String(r['rule_id']), votes: Number(r['votes']),
    status: r['status'] as StoredRule['status'],
    polarity: r['polarity'] as '+' | '-',
    supply: JSON.parse(String(r['supply_json'])) as SupplySide,
    demand: JSON.parse(String(r['demand_json'])) as TypeSide,
    param_links: JSON.parse(String(r['param_links'])) as EdgeRuleItem['param_links'],
    implications: JSON.parse(String(r['implications'])) as EdgeRuleItem['implications'],
    evidence: JSON.parse(String(r['evidence_json'])) as EdgeRuleItem['evidence'],
  }));
}

/** plan D13: adopt one pass, keep `none`, or keep the voted role (an `other` resource item). */
export type Decision = 'pass' | 'none' | 'keep';

/** Who made a decision: a person (plan D13) or an agreed debate (spec rev. 9 sec. 5.6). */
export interface DecidedBy { by: 'owner' | 'debate'; round?: number }
const OWNER: DecidedBy = { by: 'owner' };

export interface StoredRole {
  family: string; type_key: string; role: RoleItem['role']; demand_note: string | null;
  resources: RoleItem['resources']; evidence: RoleItem['evidence']; votes: number; status: 'accepted' | 'disputed';
  decision: { decision: Decision; pass_index: number | null; note: string; decided_at: string } | null;
}

export function setRoles(db: DatabaseSync, setId: number): StoredRole[] {
  const rows = db.prepare(
    `SELECT r.family, r.type_key, r.role, r.demand_note, r.resources_json, r.evidence_json, r.votes, r.status,
            d.decision, d.pass_index, d.note, d.decided_at
       FROM edge_type_roles r LEFT JOIN edge_role_decisions d USING (set_id, family, type_key)
      WHERE r.set_id = ? ORDER BY r.family, r.type_key`,
  ).all(setId) as Array<Record<string, string | number | null>>;
  return rows.map((r) => ({
    family: String(r['family']), type_key: String(r['type_key']), role: r['role'] as StoredRole['role'],
    demand_note: r['demand_note'] as string | null,
    resources: JSON.parse(String(r['resources_json'])) as StoredRole['resources'],
    evidence: JSON.parse(String(r['evidence_json'])) as StoredRole['evidence'],
    votes: Number(r['votes']), status: r['status'] as StoredRole['status'],
    decision: r['decision'] === null ? null : {
      decision: r['decision'] as Decision, pass_index: r['pass_index'] as number | null,
      note: String(r['note']), decided_at: String(r['decided_at']),
    },
  }));
}

/** spec sec. 5.3: the Stage B demand types - accepted roles `demand` or `both`. */
export function demandTypes(db: DatabaseSync, setId: number): string[] {
  return (db.prepare(
    "SELECT family || '.' || type_key id FROM edge_type_roles WHERE set_id = ? AND status = 'accepted' AND role IN ('demand','both') ORDER BY family, type_key",
  ).all(setId) as Array<{ id: string }>).map((r) => r.id);
}

/** spec sec. 5.3: the Stage B supply candidates - accepted roles `supply` or `both`. */
export function supplyTypes(db: DatabaseSync, setId: number): string[] {
  return (db.prepare(
    "SELECT family || '.' || type_key id FROM edge_type_roles WHERE set_id = ? AND status = 'accepted' AND role IN ('supply','both') ORDER BY family, type_key",
  ).all(setId) as Array<{ id: string }>).map((r) => r.id);
}

/**
 * spec sec. 22.5: a type that is new in a carried set has no Stage A pass, so it has no role and no
 * Stage B pass can start. This gives a CARES_ABOUT type of the set's schema the accepted role
 * `demand`, as the build treats it (build.ts, `isDemand`). No pass voted, so `votes` is 0. Each
 * evidence quote must be stored rule text of the set's corpus.
 */
export function giveDemandRole(db: DatabaseSync, setId: number, item: { type: string; demand_note: string; evidence: readonly RoleItem['evidence'][number][] }): void {
  const s = requireSet(db, setId);
  if (s.status !== 'in_progress') throw new RuleSetError('invalid', `set ${setId} is ${s.status}, not in_progress`);
  const [family, typeKey] = [item.type.slice(0, item.type.indexOf('.')), item.type.slice(item.type.indexOf('.') + 1)];
  if (family !== 'CARES_ABOUT') throw new RuleSetError('invalid', `${item.type} is not a CARES_ABOUT type`);
  if (!db.prepare('SELECT 1 FROM atom_types WHERE schema_version = ? AND family = ? AND type_key = ?').get(s.schema_version, family, typeKey)) {
    throw new RuleSetError('invalid', `schema v${s.schema_version} has no type ${item.type}`);
  }
  if (db.prepare('SELECT 1 FROM edge_type_roles WHERE set_id = ? AND family = ? AND type_key = ?').get(setId, family, typeKey)) {
    throw new RuleSetError('invalid', `set ${setId} has a role for ${item.type} already`);
  }
  const ruleText = db.prepare('SELECT text FROM rules WHERE corpus_id = ? AND number = ?');
  if (item.evidence.length === 0) throw new RuleSetError('invalid', `the role of ${item.type} needs evidence`);
  for (const e of item.evidence) {
    const text = (ruleText.get(s.corpus_id, e.ref) as { text: string } | undefined)?.text ?? '';
    if (e.source !== 'rule' || !text.includes(e.quote)) throw new RuleSetError('invalid', `the evidence quote of ${item.type} is not in CR ${e.ref}`);
  }
  db.prepare(
    `INSERT INTO edge_type_roles (set_id, family, type_key, role, demand_note, resources_json, evidence_json, votes, status)
     VALUES (?, ?, ?, 'demand', ?, '[]', ?, 0, 'accepted')`,
  ).run(setId, family, typeKey, item.demand_note, JSON.stringify(item.evidence));
}

/**
 * spec sec. 23: the role of a type that takes the fact of removed types, on an open set. The rows
 * come from the source set `fromSetId`: the types in `from`, and `type` when it has a row there. The
 * role, the resources and the evidence are the union of the rows, and the votes are the lowest.
 * No model runs: each row was voted, and each quote is in a batch of its type (`quoteTrace`).
 */
export function mergeRole(db: DatabaseSync, setId: number, fromSetId: number, item: { type: string; from: readonly string[] }): void {
  const s = requireSet(db, setId);
  if (s.status !== 'in_progress') throw new RuleSetError('invalid', `set ${setId} is ${s.status}, not in_progress`);
  const rows = setRoles(db, fromSetId).filter((r) => [item.type, ...item.from].includes(`${r.family}.${r.type_key}`));
  const missing = item.from.filter((t) => !rows.some((r) => `${r.family}.${r.type_key}` === t));
  if (missing.length) throw new RuleSetError('invalid', `set ${fromSetId} has no role for ${missing.join(', ')}`);
  if (rows.some((r) => r.status !== 'accepted')) throw new RuleSetError('invalid', `a source role of ${item.type} is not accepted`);
  const has = (...roles: string[]) => rows.some((r) => roles.includes(r.role));
  const role = has('both') || (has('supply') && has('demand')) ? 'both' : has('demand') ? 'demand' : 'supply';
  const unique = <T>(list: T[]) => [...new Map(list.map((x) => [JSON.stringify(x), x])).values()];
  const [family, typeKey] = [item.type.slice(0, item.type.indexOf('.')), item.type.slice(item.type.indexOf('.') + 1)];
  db.prepare('DELETE FROM edge_type_roles WHERE set_id = ? AND family = ? AND type_key = ?').run(setId, family, typeKey);
  db.prepare(
    `INSERT INTO edge_type_roles (set_id, family, type_key, role, demand_note, resources_json, evidence_json, votes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`,
  ).run(setId, family, typeKey, role, rows.map((r) => r.demand_note).filter(Boolean).join('\n') || null,
    JSON.stringify(unique(rows.flatMap((r) => r.resources))), JSON.stringify(unique(rows.flatMap((r) => r.evidence))), Math.min(...rows.map((r) => r.votes)));
}

/** spec sec. 10.1, rank 1: the number of Stage B rules of the set that use the type. */
export function refreshRoleRanks(db: DatabaseSync, setId: number): void {
  const rules = setRules(db, setId, 'all');
  const uses = new Map<string, number>();
  for (const r of rules) {
    const ids = new Set([`${r.demand.family}.${r.demand.type_key}`, ...(isIntrinsic(r.supply) ? [] : [`${r.supply.family}.${r.supply.type_key}`])]);
    for (const id of ids) uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  const items = db.prepare(
    `SELECT q.id, t.family || '.' || t.type_key type FROM review_queue q JOIN edge_type_roles t ON t.rowid = q.detail_id
      WHERE q.domain = 'edge' AND q.rule_set_id = ? AND q.severity = 'edge_role_disagreement' AND q.detail_table = 'edge_type_roles'`,
  ).all(setId) as Array<{ id: number; type: string }>;
  const set = db.prepare('UPDATE review_queue SET rank_score = ? WHERE id = ?');
  for (const it of items) set.run(uses.get(it.type) ?? 0, it.id);
}

function roleRow(db: DatabaseSync, setId: number, family: string, typeKey: string): { rowid: number } {
  const row = db.prepare('SELECT rowid FROM edge_type_roles WHERE set_id = ? AND family = ? AND type_key = ?')
    .get(setId, family, typeKey) as { rowid: number } | undefined;
  if (!row) throw new RuleSetError('not_found', `set ${setId} has no role for ${family}.${typeKey}`);
  return row;
}

/** The review item of a role; a decision is only for a type that a person reviews. */
function roleItem(db: DatabaseSync, setId: number, rowid: number, id: string): void {
  const item = db.prepare(
    `SELECT 1 FROM review_queue WHERE domain = 'edge' AND rule_set_id = ? AND severity = 'edge_role_disagreement'
        AND detail_table = 'edge_type_roles' AND detail_id = ?`,
  ).get(setId, rowid);
  if (!item) throw new RuleSetError('invalid', `${id} has no review item in set ${setId}`);
}

function resolveRoleItem(db: DatabaseSync, setId: number, rowid: number): void {
  db.prepare(
    `UPDATE review_queue SET status = 'resolved' WHERE domain = 'edge' AND rule_set_id = ? AND severity = 'edge_role_disagreement'
        AND detail_table = 'edge_type_roles' AND detail_id = ? AND status = 'pending'`,
  ).run(setId, rowid);
}

/**
 * A role change after Stage B is prepared must not leave the Stage B batches wrong: a type that a
 * Stage B batch shows (as demand or as supply candidate) keeps its role. A new `demand` role gets
 * its batch at the next prepare. A new `supply` or `both` role gets a supplementary batch for each
 * demand type that has batches already, at the next prepare (`ruleBatches.ts`, planSetPairs).
 * The decision 'keep' changes no role (newRole null), so it is always permitted.
 */
function guardStageB(db: DatabaseSync, setId: number, id: string, newRole: Role | null): void {
  const batches = db.prepare("SELECT types_json FROM edge_rule_batches WHERE set_id = ? AND stage = 'pairs'").all(setId) as Array<{ types_json: string }>;
  if (batches.length === 0 || newRole === null) return;
  if (batches.some((b) => (JSON.parse(b.types_json) as string[]).includes(id))) {
    throw new RuleSetError('invalid', `${id} is in a Stage B batch already: its role cannot change in set ${setId}`);
  }
}

function decide(db: DatabaseSync, setId: number, d: { family: string; type_key: string; note: string }, newRole: Role | null,
  apply: (rowid: number) => { decision: Decision; pass_index: number | null }, who: DecidedBy): void {
  const s = requireSet(db, setId);
  if (s.status !== 'in_progress') throw new RuleSetError('invalid', `set ${setId} is ${s.status}: a correction makes a new set (spec sec. 5.5)`);
  if (!d.note.trim()) throw new RuleSetError('invalid', 'a decision needs a note');
  const { rowid } = roleRow(db, setId, d.family, d.type_key);
  roleItem(db, setId, rowid, `${d.family}.${d.type_key}`);
  guardStageB(db, setId, `${d.family}.${d.type_key}`, newRole);
  db.exec('BEGIN');
  try {
    const r = apply(rowid);
    db.prepare(
      `INSERT OR REPLACE INTO edge_role_decisions (set_id, family, type_key, decision, pass_index, note, decided_at, decided_by, debate_round)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(setId, d.family, d.type_key, r.decision, r.pass_index, d.note.trim(), new Date().toISOString(), who.by, who.round ?? null);
    resolveRoleItem(db, setId, rowid);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Plan D13: a person adopts the proposal of one pass. The role, the demand note, the resource
 * effects and the evidence come from that pass's `edge_rule_pass_items` row, which holds only
 * verified evidence. The role becomes `accepted`, and its review item resolved.
 */
export function decideRole(db: DatabaseSync, setId: number,
  d: { family: string; type_key: string; pass_index: number; note: string }, who: DecidedBy = OWNER): void {
  const key = `${d.family}.${d.type_key}`;
  const row = db.prepare("SELECT item_json FROM edge_rule_pass_items WHERE set_id = ? AND stage = 'roles' AND item_key = ? AND pass_index = ?")
    .get(setId, key, d.pass_index) as { item_json: string } | undefined;
  if (!getRuleSet(db, setId)) throw new RuleSetError('not_found', `no edge-rule set ${setId}`);
  if (!row) throw new RuleSetError('invalid', `pass ${d.pass_index} did not propose a valid role for ${key}`);
  const item = JSON.parse(row.item_json) as RoleItem;
  // The same accepted role with other effects does not change the Stage B batches: only the role
  // decides the demand types and the supply candidates.
  const now = db.prepare('SELECT role, status FROM edge_type_roles WHERE set_id = ? AND family = ? AND type_key = ?')
    .get(setId, d.family, d.type_key) as { role: Role; status: string } | undefined;
  const newRole = now?.status === 'accepted' && now.role === item.role ? null : item.role;
  decide(db, setId, d, newRole, (rowid) => {
    db.prepare(
      `UPDATE edge_type_roles SET role = ?, demand_note = ?, resources_json = ?, evidence_json = ?, status = 'accepted' WHERE rowid = ?`,
    ).run(item.role, item.demand_note?.trim() || null, JSON.stringify(item.resources), JSON.stringify(item.evidence), rowid);
    return { decision: 'pass', pass_index: d.pass_index };
  }, who);
}

/** Plan D13: a person keeps the role `none`. The type gets no Stage B batch. */
export function keepRoleNone(db: DatabaseSync, setId: number, d: { family: string; type_key: string; note: string }, who: DecidedBy = OWNER): void {
  decide(db, setId, d, 'none', (rowid) => {
    db.prepare("UPDATE edge_type_roles SET role = 'none', demand_note = NULL, status = 'accepted' WHERE rowid = ?").run(rowid);
    return { decision: 'none', pass_index: null };
  }, who);
}

/**
 * An `other` resource item on a role that the votes accepted: the person keeps the voted role,
 * its union evidence and its voted resources, and resolves the item with a note. A disputed role
 * has no voted role to keep.
 */
export function keepVotedRole(db: DatabaseSync, setId: number, d: { family: string; type_key: string; note: string }, who: DecidedBy = OWNER): void {
  const status = (db.prepare('SELECT status FROM edge_type_roles WHERE set_id = ? AND family = ? AND type_key = ?')
    .get(setId, d.family, d.type_key) as { status: string } | undefined)?.status;
  if (status === 'disputed') throw new RuleSetError('invalid', `${d.family}.${d.type_key} is disputed: it has no voted role to keep`);
  decide(db, setId, d, null, () => ({ decision: 'keep', pass_index: null }), who);
}

/**
 * A decision on a disputed rule of an in-progress set (spec sec. 5.3, rev. 9 sec. 5.6): `adopt`
 * makes it accepted, so that the build uses it; `reject` keeps it out of the build. Both record
 * the note and resolve the review item. The rule content is the content that a pass gave and
 * that the submit verified: a decision never writes a rule.
 */
export function decideRule(db: DatabaseSync, setId: number,
  d: { rule_hash: string; decision: 'adopt' | 'reject'; note: string }, who: DecidedBy = OWNER): void {
  const s = requireSet(db, setId);
  if (s.status !== 'in_progress') throw new RuleSetError('invalid', `set ${setId} is ${s.status}: a correction makes a new set (spec sec. 5.5)`);
  if (!d.note.trim()) throw new RuleSetError('invalid', 'a decision needs a note');
  const row = db.prepare('SELECT rowid, status FROM edge_rules WHERE set_id = ? AND rule_hash = ?').get(setId, d.rule_hash) as
    { rowid: number; status: string } | undefined;
  if (!row) throw new RuleSetError('not_found', `set ${setId} has no rule ${d.rule_hash}`);
  if (row.status !== 'disputed') throw new RuleSetError('invalid', `rule ${d.rule_hash} is ${row.status}, not disputed`);
  db.exec('BEGIN');
  try {
    if (d.decision === 'adopt') db.prepare("UPDATE edge_rules SET status = 'accepted' WHERE rowid = ?").run(row.rowid);
    db.prepare(
      `INSERT OR REPLACE INTO edge_rule_decisions (set_id, rule_hash, decision, decided_by, debate_round, note, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(setId, d.rule_hash, d.decision, who.by, who.round ?? null, d.note.trim(), new Date().toISOString());
    db.prepare(
      `UPDATE review_queue SET status = 'resolved' WHERE domain = 'edge' AND rule_set_id = ? AND severity = 'edge_rule_disagreement'
          AND detail_table = 'edge_rules' AND detail_id = ? AND status = 'pending'`,
    ).run(setId, row.rowid);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** The valid proposals of each pass for one type (Stage A), for the decision form. */
export function roleProposals(db: DatabaseSync, setId: number, family: string, typeKey: string): Array<{ pass_index: number; item: RoleItem }> {
  return (db.prepare("SELECT pass_index, item_json FROM edge_rule_pass_items WHERE set_id = ? AND stage = 'roles' AND item_key = ? ORDER BY pass_index")
    .all(setId, `${family}.${typeKey}`) as Array<{ pass_index: number; item_json: string }>)
    .map((r) => ({ pass_index: r.pass_index, item: JSON.parse(r.item_json) as RoleItem }));
}
