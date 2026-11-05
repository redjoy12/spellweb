/**
 * The carry-forward of an edge-rule set to a new schema version (schema v15 plan, Task 5 Step 1).
 *
 * A new schema version changes the params of some types. A demand type whose params do not
 * change keeps its Stage B rules: a supply param can only help a demand that has params (plan
 * sec. 4.3). Stage A roles do not change with params (plan sec. 4.2). Thus the new set copies the
 * roles of the earlier set and the rules of each unchanged demand type, and Stage B runs again
 * only for the changed demand types.
 *
 * The copies keep their rule hash and rule id, their votes and status, and the debate records of
 * the earlier set. The review items stay on the earlier set: the edge queue lists every set, so a
 * copy would show each pending item two times. A carried demand type keeps the supply candidates
 * of its earlier batches (`shownCandidates`): only a candidate that no earlier batch showed gets a
 * supplementary batch.
 */
import type { DatabaseSync } from 'node:sqlite';
import { createRuleSet, getRuleSet, RuleSetError } from './ruleSet.js';
import { isIntrinsic, ruleHash, type EdgeRuleContent, type Predicate, type SupplySide, type TypeSide } from './ruleSchema.js';

export interface CarryResult {
  setId: number;
  version: number;
  fromSetId: number;
  schemaVersion: number;
  /** The demand types of the earlier set whose params change: Stage B runs again for these. */
  changed: string[];
  /** The demand types whose rules the new set copies. */
  carried: Array<{ demand: string; rules: number }>;
  roles: number;
  rules: number;
  /** With `all`: the copied rules and roles whose type the new schema does not have, now removed. */
  dropped?: { rules: number; roles: number };
  /** With `moves`: the rules moved to the type that keeps the fact, and the moved rules that were the same as a rule of the set. */
  moved?: { rules: number; merged: number };
  /** With `splits`: the rules copied to the new type, and the rules that moved there. */
  split?: { copied: number; moved: number };
  /** With `values`: the rules whose predicate named the old value. */
  values?: number;
  /** With `drop`: the rule ids that the new set does not have. */
  removed?: string[];
}

/**
 * spec sec. 21: `all` keeps every rule of a kept type. A rule that tests a param that its type does not
 * have on the new schema would never hold, so the carry refuses it (the transaction rolls back).
 */
function refuseUnknownParams(db: DatabaseSync, setId: number, schemaVersion: number): void {
  const params = new Map((db.prepare('SELECT family, type_key, params_schema FROM atom_types WHERE schema_version = ?').all(schemaVersion) as
    Array<{ family: string; type_key: string; params_schema: string }>).map((t) => [`${t.family}.${t.type_key}`,
    new Set(Object.keys((JSON.parse(t.params_schema) as { properties?: object }).properties ?? {}))]));
  const bad: string[] = [];
  for (const r of db.prepare('SELECT rule_id, supply_json, demand_json, param_links, implications FROM edge_rules WHERE set_id = ?').all(setId) as
    Array<{ rule_id: string; supply_json: string; demand_json: string; param_links: string; implications: string }>) {
    const supply = JSON.parse(r.supply_json) as SupplySide;
    const demand = JSON.parse(r.demand_json) as TypeSide;
    const has = (s: TypeSide, p: string) => params.get(`${s.family}.${s.type_key}`)?.has(p) ?? false;
    const used: Array<[TypeSide, string]> = [
      ...(isIntrinsic(supply) ? [] : supply.where.map((w): [TypeSide, string] => [supply, w.param])),
      ...demand.where.map((w): [TypeSide, string] => [demand, w.param]),
      ...(JSON.parse(r.param_links) as EdgeRuleContent['param_links']).flatMap((l): Array<[TypeSide, string]> =>
        [...(isIntrinsic(supply) ? [] : [[supply, l.supply] as [TypeSide, string]]), [demand, l.demand]]),
      ...(JSON.parse(r.implications) as EdgeRuleContent['implications']).map((i): [TypeSide, string] => [demand, i.demand_param]),
    ];
    for (const [s, p] of used) if (!has(s, p)) bad.push(`${r.rule_id}: ${s.family}.${s.type_key}.${p}`);
  }
  if (bad.length) throw new RuleSetError('invalid', `schema v${schemaVersion} does not have params that carried rules test: ${bad.slice(0, 10).join('; ')}${bad.length > 10 ? ` (and ${bad.length - 10} more)` : ''}`);
}

/**
 * A removed type whose rules move to the type that keeps its fact, with its param names there, and
 * the predicates that the moved side takes (spec sec. 22.1 item S3).
 */
export interface TypeMove { type: string; into: string; params?: Readonly<Record<string, string>>; where?: readonly Predicate[] }

/**
 * spec sec. 23 item B1: a type that stays for some atoms, and whose other atoms move to `into`. Its
 * rules also go to `into`, with the limit `where`. A rule that tests `targeted` false stays. A rule
 * that tests `targeted` true moves, because the source type has no such atom now.
 */
export interface TypeSplit { type: string; into: string; where: readonly Predicate[] }

/**
 * spec sec. 23 item B5: the atoms of `type` replace the value `old` of `param` with a name. A rule
 * predicate that names `old` becomes "not one of the `named` values that it leaves out".
 */
export interface ValueChange { type: string; param: string; old: string; named: readonly string[] }

interface RuleRow { rule_hash: string; polarity: '+' | '-'; supply_json: string; demand_json: string; param_links: string; implications: string }

const ruleRows = (db: DatabaseSync, setId: number) => db.prepare('SELECT rule_hash, polarity, supply_json, demand_json, param_links, implications FROM edge_rules WHERE set_id = ?')
  .all(setId) as unknown as RuleRow[];

/**
 * Writes a new content over a rule of the set. A rule keeps its rule id, votes, status and evidence.
 * A rule with the same content as a rule of the set is removed (the set keeps the other rule). The
 * rule hash covers `where`, so a rule with a limit keeps its own row. Returns true for a merge.
 */
function replacerOf(db: DatabaseSync, setId: number): (oldHash: string, content: EdgeRuleContent) => boolean {
  const exists = db.prepare('SELECT 1 FROM edge_rules WHERE set_id = ? AND rule_hash = ?');
  const update = db.prepare('UPDATE edge_rules SET rule_hash = ?, supply_json = ?, demand_json = ?, param_links = ?, implications = ? WHERE set_id = ? AND rule_hash = ?');
  const updDecisions = db.prepare('UPDATE edge_rule_decisions SET rule_hash = ? WHERE set_id = ? AND rule_hash = ?');
  const updOutcomes = db.prepare("UPDATE edge_debate_outcomes SET item_key = ? WHERE set_id = ? AND stage = 'pairs' AND item_key = ?");
  const delDecisions = db.prepare('DELETE FROM edge_rule_decisions WHERE set_id = ? AND rule_hash = ?');
  const delOutcomes = db.prepare("DELETE FROM edge_debate_outcomes WHERE set_id = ? AND stage = 'pairs' AND item_key = ?");
  const del = db.prepare('DELETE FROM edge_rules WHERE set_id = ? AND rule_hash = ?');
  const keepStatus = db.prepare(
    `UPDATE edge_rules SET
       status = CASE WHEN status = 'accepted' OR (SELECT status FROM edge_rules WHERE set_id = ?1 AND rule_hash = ?2) = 'accepted' THEN 'accepted' ELSE status END,
       votes = MAX(votes, (SELECT votes FROM edge_rules WHERE set_id = ?1 AND rule_hash = ?2))
     WHERE set_id = ?3 AND rule_hash = ?4`,
  );
  return (oldHash, content) => {
    const hash = ruleHash(content);
    if (exists.get(setId, hash)) {
      // The same content: the kept rule is accepted when either rule is accepted, with the higher vote count.
      keepStatus.run(setId, oldHash, setId, hash);
      delDecisions.run(setId, oldHash);
      delOutcomes.run(setId, oldHash);
      del.run(setId, oldHash);
      return true;
    }
    update.run(hash, JSON.stringify(content.supply), JSON.stringify(content.demand), JSON.stringify(content.param_links),
      JSON.stringify(content.implications), setId, oldHash);
    updDecisions.run(hash, setId, oldHash);
    updOutcomes.run(hash, setId, oldHash);
    return false;
  };
}

/** spec sec. 21: the rules of a moved type become rules of the type that keeps its fact, with their params renamed. */
function moveRuleTypes(db: DatabaseSync, setId: number, moves: readonly TypeMove[]): { rules: number; merged: number } {
  const replace = replacerOf(db, setId);
  const moveOf = (s: { family?: string; type_key?: string }) => moves.find((m) => m.type === `${s.family}.${s.type_key}`);
  let n = 0;
  let merged = 0;
  for (const r of ruleRows(db, setId)) {
    const supply = JSON.parse(r.supply_json) as SupplySide;
    const demand = JSON.parse(r.demand_json) as TypeSide;
    const ms = isIntrinsic(supply) ? undefined : moveOf(supply);
    const md = moveOf(demand);
    if (!ms && !md) continue;
    const rename = (m: TypeMove | undefined, p: string) => m?.params?.[p] ?? p;
    const side = <S extends TypeSide>(s: S, m: TypeMove | undefined): S => {
      if (!m) return s;
      const [family, type_key] = m.into.split('.') as [string, string];
      return { ...s, family, type_key, where: [...s.where.map((w) => ({ ...w, param: rename(m, w.param) })), ...(m.where ?? [])] };
    };
    const content: EdgeRuleContent = {
      polarity: r.polarity,
      supply: isIntrinsic(supply) ? supply : side(supply, ms),
      demand: side(demand, md),
      param_links: (JSON.parse(r.param_links) as EdgeRuleContent['param_links']).map((l) => ({ supply: rename(ms, l.supply), demand: rename(md, l.demand) })),
      implications: (JSON.parse(r.implications) as EdgeRuleContent['implications']).map((i) => ({ ...i, demand_param: rename(md, i.demand_param) })),
    };
    n++;
    if (replace(r.rule_hash, content)) merged++;
  }
  return { rules: n, merged };
}

const testsTargeted = (s: TypeSide, value: boolean) => s.where.some((w) => w.param === 'targeted' && w.op === 'eq' && w.value === value);

/**
 * spec sec. 23 item B1: see `TypeSplit`. A copy is a new rule of the set: it has the votes, status,
 * evidence, decisions and debate outcomes of its source, and the accept gives it a rule id. A split
 * type has the role `supply`, so a rule with it on the demand side is refused.
 */
function splitRuleTypes(db: DatabaseSync, setId: number, splits: readonly TypeSplit[]): { copied: number; moved: number } {
  const replace = replacerOf(db, setId);
  const exists = db.prepare('SELECT 1 FROM edge_rules WHERE set_id = ? AND rule_hash = ?');
  const copyRule = db.prepare(
    `INSERT INTO edge_rules (set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status)
     SELECT set_id, ?, ?, polarity, ?, demand_json, param_links, implications, evidence_json, votes, status FROM edge_rules WHERE set_id = ? AND rule_hash = ?`,
  );
  const copyDecisions = db.prepare(
    `INSERT INTO edge_rule_decisions (set_id, rule_hash, decision, decided_by, debate_round, note, decided_at)
     SELECT set_id, ?, decision, decided_by, debate_round, note, decided_at FROM edge_rule_decisions WHERE set_id = ? AND rule_hash = ?`,
  );
  const copyOutcomes = db.prepare(
    `INSERT INTO edge_debate_outcomes (set_id, stage, item_key, outcome, choice, round, cause, decided_at)
     SELECT set_id, stage, ?, outcome, choice, round, cause, decided_at FROM edge_debate_outcomes WHERE set_id = ? AND stage = 'pairs' AND item_key = ?`,
  );
  let copied = 0;
  let moved = 0;
  for (const r of ruleRows(db, setId)) {
    const supply = JSON.parse(r.supply_json) as SupplySide;
    const demand = JSON.parse(r.demand_json) as TypeSide;
    if (splits.some((s) => s.type === `${demand.family}.${demand.type_key}`)) {
      throw new RuleSetError('invalid', `rule ${r.rule_hash} has the split type ${demand.family}.${demand.type_key} as its demand`);
    }
    if (isIntrinsic(supply)) continue;
    const split = splits.find((s) => s.type === `${supply.family}.${supply.type_key}`);
    if (!split || testsTargeted(supply, false)) continue;
    const [family, type_key] = split.into.split('.') as [string, string];
    const into: SupplySide = { ...supply, family, type_key, where: [...supply.where.filter((w) => w.param !== 'targeted'), ...split.where] };
    const content: EdgeRuleContent = {
      polarity: r.polarity, supply: into, demand,
      param_links: JSON.parse(r.param_links) as EdgeRuleContent['param_links'],
      implications: JSON.parse(r.implications) as EdgeRuleContent['implications'],
    };
    if (testsTargeted(supply, true)) {
      replace(r.rule_hash, content);
      moved++;
      continue;
    }
    const hash = ruleHash(content);
    if (exists.get(setId, hash)) continue;
    // `assignRuleIds` replaces this id at the accept.
    copyRule.run(hash, `copy-${hash}`, JSON.stringify(into), setId, r.rule_hash);
    copyDecisions.run(hash, setId, r.rule_hash);
    copyOutcomes.run(hash, setId, r.rule_hash);
    copied++;
  }
  return { copied, moved };
}

/** spec sec. 23 item B5: see `ValueChange`. */
function changeRuleValues(db: DatabaseSync, setId: number, changes: readonly ValueChange[]): number {
  const replace = replacerOf(db, setId);
  let n = 0;
  for (const r of ruleRows(db, setId)) {
    const supply = JSON.parse(r.supply_json) as SupplySide;
    if (isIntrinsic(supply)) continue;
    const c = changes.find((x) => x.type === `${supply.family}.${supply.type_key}`);
    const names = (w: Predicate) => (w.op === 'eq' ? [w.value] : Array.isArray(w.value) ? w.value : [w.value]);
    if (!c || !supply.where.some((w) => w.param === c.param && names(w).includes(c.old))) continue;
    const where = supply.where.map((w): Predicate => (w.param === c.param && names(w).includes(c.old)
      ? { param: w.param, op: 'disjoint', value: c.named.filter((v) => !names(w).includes(v)) } : w));
    replace(r.rule_hash, {
      polarity: r.polarity, supply: { ...supply, where }, demand: JSON.parse(r.demand_json) as TypeSide,
      param_links: JSON.parse(r.param_links) as EdgeRuleContent['param_links'],
      implications: JSON.parse(r.implications) as EdgeRuleContent['implications'],
    });
    n++;
  }
  return n;
}

const DEMAND_ID = "json_extract(demand_json, '$.family') || '.' || json_extract(demand_json, '$.type_key')";

/** spec sec. 25.5: removes rules of the new set, with their decisions and debate outcomes. */
function dropRules(db: DatabaseSync, setId: number, ids: readonly string[]): string[] {
  const hashOf = db.prepare('SELECT rule_hash FROM edge_rules WHERE set_id = ? AND rule_id = ?');
  for (const id of ids) {
    const r = hashOf.get(setId, id) as { rule_hash: string } | undefined;
    if (!r) throw new RuleSetError('invalid', `rule ${id} is not in the carried set`);
    db.prepare('DELETE FROM edge_rule_decisions WHERE set_id = ? AND rule_hash = ?').run(setId, r.rule_hash);
    db.prepare("DELETE FROM edge_debate_outcomes WHERE set_id = ? AND stage = 'pairs' AND item_key = ?").run(setId, r.rule_hash);
    db.prepare('DELETE FROM edge_rules WHERE set_id = ? AND rule_hash = ?').run(setId, r.rule_hash);
  }
  return [...ids];
}

/** Plan 2026-11-01-schema-v20 Task 6: the same removal on an open set, after its Stage B pass gave the rules that replace them. */
export function dropFromOpenSet(db: DatabaseSync, setId: number, ids: readonly string[]): string[] {
  const s = getRuleSet(db, setId);
  if (!s) throw new RuleSetError('not_found', `no edge-rule set ${setId}`);
  if (s.status !== 'in_progress') throw new RuleSetError('invalid', `set ${setId} is ${s.status}: only an in-progress set can lose a rule`);
  db.exec('BEGIN');
  try {
    const removed = dropRules(db, setId, ids);
    db.prepare(`UPDATE edge_rule_carry SET rules = (SELECT COUNT(*) FROM edge_rules WHERE set_id = edge_rule_carry.set_id AND ${DEMAND_ID} = edge_rule_carry.demand)
                WHERE set_id = ?`).run(setId);
    db.exec('COMMIT');
    return removed;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * The demand types of `fromSetId` (accepted role `demand` or `both`) whose label or params schema
 * at `schemaVersion` is not the one at the schema version of the set, or that `schemaVersion`
 * does not have.
 */
export function changedDemandTypes(db: DatabaseSync, fromSetId: number, schemaVersion: number): string[] {
  const from = getRuleSet(db, fromSetId);
  if (!from) throw new RuleSetError('not_found', `no edge-rule set ${fromSetId}`);
  return (db.prepare(
    `SELECT r.family || '.' || r.type_key id FROM edge_type_roles r
       LEFT JOIN atom_types a ON a.schema_version = ? AND a.family = r.family AND a.type_key = r.type_key
       LEFT JOIN atom_types b ON b.schema_version = ? AND b.family = r.family AND b.type_key = r.type_key
      WHERE r.set_id = ? AND r.status = 'accepted' AND r.role IN ('demand','both')
        AND (a.type_key IS NULL OR b.type_key IS NULL OR a.label <> b.label OR a.params_schema <> b.params_schema)
      ORDER BY id`,
  ).all(from.schema_version, schemaVersion, fromSetId) as Array<{ id: string }>).map((r) => r.id);
}

/** Copies the rules of one demand type with their decisions and debate outcomes, and records the carry. */
function copyDemand(db: DatabaseSync, setId: number, fromSetId: number, demand: string): number {
  const n = Number(db.prepare(
    `INSERT INTO edge_rules (set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status)
     SELECT ?, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status
       FROM edge_rules WHERE set_id = ? AND ${DEMAND_ID} = ?`,
  ).run(setId, fromSetId, demand).changes);
  db.prepare(
    `INSERT INTO edge_rule_decisions (set_id, rule_hash, decision, decided_by, debate_round, note, decided_at)
     SELECT ?, d.rule_hash, d.decision, d.decided_by, d.debate_round, d.note, d.decided_at FROM edge_rule_decisions d
       JOIN edge_rules r ON r.set_id = d.set_id AND r.rule_hash = d.rule_hash WHERE d.set_id = ? AND ${DEMAND_ID} = ?`,
  ).run(setId, fromSetId, demand);
  db.prepare(
    `INSERT INTO edge_debate_outcomes (set_id, stage, item_key, outcome, choice, round, cause, decided_at)
     SELECT ?, o.stage, o.item_key, o.outcome, o.choice, o.round, o.cause, o.decided_at FROM edge_debate_outcomes o
       JOIN edge_rules r ON r.set_id = o.set_id AND r.rule_hash = o.item_key WHERE o.set_id = ? AND o.stage = 'pairs' AND ${DEMAND_ID} = ?`,
  ).run(setId, fromSetId, demand);
  db.prepare('INSERT INTO edge_rule_carry (set_id, from_set_id, demand, rules) VALUES (?, ?, ?, ?)').run(setId, fromSetId, demand, n);
  return n;
}

/**
 * Plan Task 17: a set that was carried before `stored` was in carryForwardSet can lack the rules of
 * a type that a rule move made. This copies each demand type of the source set that the set does
 * not have. No model runs, and each rule keeps its id, votes and status. A second run does nothing.
 */
export function repairCarry(db: DatabaseSync, setId: number, opts: { dryRun?: boolean } = {}): { from: number; repaired: CarryResult['carried'] } {
  const from = carrySource(db, setId);
  if (from === null) throw new RuleSetError('invalid', `set ${setId} is not a carried set`);
  const demands = (db.prepare(
    `SELECT ${DEMAND_ID} demand, COUNT(*) n FROM edge_rules WHERE set_id = ? AND ${DEMAND_ID} NOT IN (SELECT ${DEMAND_ID} FROM edge_rules WHERE set_id = ?)
      GROUP BY demand ORDER BY demand`,
  ).all(from, setId) as Array<{ demand: string; n: number }>);
  if (opts.dryRun) return { from, repaired: demands.map((d) => ({ demand: d.demand, rules: d.n })) };
  db.exec('BEGIN');
  try {
    const repaired = demands.map((d) => ({ demand: d.demand, rules: copyDemand(db, setId, from, d.demand) }));
    db.exec('COMMIT');
    return { from, repaired };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * A new in-progress set on `schemaVersion` (default: the current schema) that copies the roles of
 * the accepted set `fromSetId`, and the rules of each demand type that has a Stage B batch in that
 * set and whose params do not change. The corpus must be the corpus of `fromSetId`: the copied
 * evidence quotes its CR text. A demand type with no earlier batch (a deferred type) is not
 * carried, so that the next prepare gives it a batch when a current atom has it.
 *
 * `sameSchema` (plan 2026-10-31-schema-v17 Task 18) permits a carry on the schema of `fromSetId`,
 * for a new demand type of that schema. It needs `all`, because no demand type changes.
 *
 * `drop` (spec sec. 25.5) lists rule ids that the new set does not copy, because a Stage B pass of the
 * new set gives the rules that replace them. An id that is not in the source set is refused.
 */
export function carryForwardSet(
  db: DatabaseSync, fromSetId: number, model: string,
  over: { schemaVersion?: number; corpusId?: number; all?: boolean; sameSchema?: boolean; moves?: readonly TypeMove[]; splits?: readonly TypeSplit[]; values?: readonly ValueChange[]; drop?: readonly string[] } = {},
): CarryResult {
  const from = getRuleSet(db, fromSetId);
  if (!from) throw new RuleSetError('not_found', `no edge-rule set ${fromSetId}`);
  if (from.status !== 'accepted') throw new RuleSetError('invalid', `set ${fromSetId} is ${from.status}: carry forward only the accepted set`);
  const corpusId = over.corpusId ?? (db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as { id: number } | undefined)?.id;
  if (corpusId !== from.corpus_id) {
    throw new RuleSetError('invalid', `set ${fromSetId} has corpus ${from.corpus_id}, not ${corpusId}: its evidence does not carry to another corpus`);
  }
  const schemaVersion = over.schemaVersion
    ?? (db.prepare('SELECT MAX(schema_version) v FROM atom_types').get() as { v: number | null }).v;
  if (over.sameSchema && !over.all) throw new RuleSetError('invalid', 'sameSchema needs all: a carry on the same schema copies every demand type');
  if (schemaVersion === null || (schemaVersion === from.schema_version && !over.sameSchema)) {
    throw new RuleSetError('invalid', `set ${fromSetId} is on schema v${from.schema_version} already: a carry-forward needs a new schema version`);
  }
  const changed = changedDemandTypes(db, fromSetId, schemaVersion);
  const changedSet = new Set(changed);
  const batched = (db.prepare("SELECT DISTINCT demand FROM edge_rule_batches WHERE set_id = ? AND stage = 'pairs' ORDER BY demand")
    .all(fromSetId) as Array<{ demand: string }>).map((r) => r.demand);
  // A carried set carries its own carried types too: their batches are in an earlier set.
  const earlier = [...carriedDemands(db, fromSetId).keys()];
  // `all` (spec sec. 21): the new schema only adds params that no rule tests, and removes types.
  // Every demand type keeps its rules; the rules and roles of a removed type go. A type that a rule
  // move made has rules, but no batch and no carry row of its own (spec sec. 23).
  const stored = over.all
    ? (db.prepare(`SELECT DISTINCT ${DEMAND_ID} demand FROM edge_rules WHERE set_id = ?`).all(fromSetId) as Array<{ demand: string }>).map((r) => r.demand)
    : [];
  const carriedIds = [...new Set([...batched, ...earlier, ...stored])].filter((d) => over.all || !changedSet.has(d)).sort();

  db.exec('BEGIN');
  try {
    const { setId, version } = createRuleSet(db, model, { schemaVersion, corpusId });
    const roles = db.prepare(
      `INSERT INTO edge_type_roles (set_id, family, type_key, role, demand_note, resources_json, evidence_json, votes, status)
       SELECT ?, family, type_key, role, demand_note, resources_json, evidence_json, votes, status FROM edge_type_roles WHERE set_id = ?`,
    ).run(setId, fromSetId).changes;
    db.prepare(
      `INSERT INTO edge_role_decisions (set_id, family, type_key, decision, pass_index, note, decided_at, decided_by, debate_round)
       SELECT ?, family, type_key, decision, pass_index, note, decided_at, decided_by, debate_round FROM edge_role_decisions WHERE set_id = ?`,
    ).run(setId, fromSetId);
    db.prepare(
      `INSERT INTO edge_debate_outcomes (set_id, stage, item_key, outcome, choice, round, cause, decided_at)
       SELECT ?, stage, item_key, outcome, choice, round, cause, decided_at FROM edge_debate_outcomes WHERE set_id = ? AND stage = 'roles'`,
    ).run(setId, fromSetId);

    const carried: CarryResult['carried'] = [];
    let rules = 0;
    for (const d of carriedIds) {
      const n = copyDemand(db, setId, fromSetId, d);
      carried.push({ demand: d, rules: n });
      rules += n;
    }
    let dropped: CarryResult['dropped'];
    let moved: CarryResult['moved'];
    let split: CarryResult['split'];
    let values: CarryResult['values'];
    let removed: CarryResult['removed'];
    if (over.drop?.length) {
      removed = dropRules(db, setId, over.drop);
      rules -= removed.length;
    }
    if (over.all && over.moves?.length) moved = moveRuleTypes(db, setId, over.moves);
    if (over.all && over.splits?.length) {
      split = splitRuleTypes(db, setId, over.splits);
      rules += split.copied;
    }
    if (over.all && over.values?.length) values = changeRuleValues(db, setId, over.values);
    if (over.all) {
      const missing = (side: string) =>
        `(json_extract(${side}, '$.family') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM atom_types t WHERE t.schema_version = ${Number(schemaVersion)}
           AND t.family = json_extract(${side}, '$.family') AND t.type_key = json_extract(${side}, '$.type_key')))`;
      const gone = `SELECT rule_hash FROM edge_rules WHERE set_id = ? AND (${missing('supply_json')} OR ${missing('demand_json')})`;
      db.prepare(`DELETE FROM edge_rule_decisions WHERE set_id = ? AND rule_hash IN (${gone})`).run(setId, setId);
      db.prepare(`DELETE FROM edge_debate_outcomes WHERE set_id = ? AND stage = 'pairs' AND item_key IN (${gone})`).run(setId, setId);
      const r = Number(db.prepare(`DELETE FROM edge_rules WHERE set_id = ? AND rule_hash IN (${gone})`).run(setId, setId).changes);
      const o = Number(db.prepare(
        `DELETE FROM edge_type_roles WHERE set_id = ? AND NOT EXISTS (SELECT 1 FROM atom_types t WHERE t.schema_version = ?
           AND t.family = edge_type_roles.family AND t.type_key = edge_type_roles.type_key)`,
      ).run(setId, schemaVersion).changes);
      // The role records of a removed type go with its role.
      const goneType = (t: string) => `NOT EXISTS (SELECT 1 FROM atom_types a WHERE a.schema_version = ${Number(schemaVersion)} AND a.family || '.' || a.type_key = ${t})`;
      db.prepare(`DELETE FROM edge_role_decisions WHERE set_id = ? AND ${goneType("edge_role_decisions.family || '.' || edge_role_decisions.type_key")}`).run(setId);
      db.prepare(`DELETE FROM edge_debate_outcomes WHERE set_id = ? AND stage = 'roles' AND ${goneType('edge_debate_outcomes.item_key')}`).run(setId);
      dropped = { rules: r, roles: o };
      rules -= r;
      refuseUnknownParams(db, setId, Number(schemaVersion));
      // The carry rows count the rules of each demand type after the moves and the drops.
      db.prepare(`UPDATE edge_rule_carry SET rules = (SELECT COUNT(*) FROM edge_rules WHERE set_id = edge_rule_carry.set_id AND ${DEMAND_ID} = edge_rule_carry.demand)
                  WHERE set_id = ?`).run(setId);
    }
    db.exec('COMMIT');
    if (moved) rules -= moved.merged;
    return { setId, version, fromSetId, schemaVersion, changed, carried, roles: Number(roles) - (dropped?.roles ?? 0), rules,
      ...(dropped ? { dropped } : {}), ...(moved ? { moved } : {}), ...(split ? { split } : {}), ...(values === undefined ? {} : { values }), ...(removed ? { removed } : {}) };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** The carried demand types of a set, each with the set that its rules are copies of. */
export function carriedDemands(db: DatabaseSync, setId: number): Map<string, { from_set_id: number; rules: number }> {
  return new Map((db.prepare('SELECT demand, from_set_id, rules FROM edge_rule_carry WHERE set_id = ? ORDER BY demand').all(setId) as
    Array<{ demand: string; from_set_id: number; rules: number }>).map((r) => [r.demand, { from_set_id: r.from_set_id, rules: r.rules }]));
}

/** The set whose roles and rules a carried set copies, else null. */
export function carrySource(db: DatabaseSync, setId: number): number | null {
  return (db.prepare('SELECT MIN(from_set_id) s FROM edge_rule_carry WHERE set_id = ?').get(setId) as { s: number | null }).s;
}

export interface SourceBatch { set_id: number; stage: 'roles' | 'pairs'; batch_key: string; demand: string | null; types_json: string; refs_json: string }

/**
 * The batches that showed the items of a set: its own batches; for a carried set also the Stage A
 * batches of its source set (the roles are copies) and the Stage B batches of each carried demand
 * type in the set that showed its rules. The quote trace (spec sec. 12.2) checks a copied quote
 * against these references.
 */
export function sourceBatches(db: DatabaseSync, setId: number): SourceBatch[] {
  const own = db.prepare('SELECT set_id, stage, batch_key, demand, types_json, refs_json FROM edge_rule_batches WHERE set_id = ? ORDER BY stage, batch_key')
    .all(setId) as unknown as SourceBatch[];
  const src = carrySource(db, setId);
  if (src === null) return own;
  const carried = carriedDemands(db, setId);
  const earlier = sourceBatches(db, src).filter((b) => b.stage === 'roles' || carried.has(b.demand ?? ''));
  return [...own, ...earlier];
}

/**
 * The supply candidates that the Stage B batches of each demand type show, and the batch count:
 * the batches of the set, and for a carried demand type also the batches of its source set. The
 * Stage B plan gives a demand type a supplementary batch only for the candidates not shown.
 */
export function shownCandidates(db: DatabaseSync, setId: number): Map<string, { types: Set<string>; n: number }> {
  const shown = new Map<string, { types: Set<string>; n: number }>();
  for (const b of sourceBatches(db, setId)) {
    if (b.stage !== 'pairs' || b.demand === null) continue;
    const s = shown.get(b.demand) ?? { types: new Set<string>(), n: 0 };
    for (const t of (JSON.parse(b.types_json) as string[]).slice(1)) s.types.add(t);
    s.n++;
    shown.set(b.demand, s);
  }
  return shown;
}
