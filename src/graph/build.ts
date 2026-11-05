/**
 * The graph build (Phase 3 spec sec. 7, plan Task 4). Deterministic code only: it matches the
 * build atoms through the accepted rules, grades and merges the edges, and counts them. It
 * stores the build record, the atom set, the per-card degree and the gap counts. It stores no
 * edge (parent spec sec. 4.4): BuildIndex calculates the edges of one card on request.
 *
 * The degree uses one bit matrix (explicit synergy pairs), one float32 weight matrix (the pair
 * weights) and one bit matrix (anti-synergy, both directions) for the scope (sec. 7.5).
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { currentCorpusId } from '../atoms/golden.js';
import { currentSchemaVersion } from '../atoms/schema.js';
import { GRADE_VERSION } from './match.js';
import { typesOf as kindTypes } from '../atoms/schemaV16.js';
import { LINK_GATE_VERSION } from './linkRuleV2.js';
import { OBJECT_GATE_VERSION } from './objectGate.js';
import { atomInfo, atomSetSha, BuildIndex, currentScopeAtoms, demandParamLists, indexClasses, objectGateData, type IndexedAtomEdge } from './buildIndex.js';
import { refreshRuleRanks, retireStaleEdgeReports } from './edgeQueue.js';
import { addEffects, emptyEffects, groupsForCard, persistGroups, type GroupEffects } from './groups.js';
import { scopeCards, type Scope } from './intrinsic.js';
import { cardPairs, mergeEdges, type MergedEdge } from './merge.js';
import { canonicalJson, excludedRuleHashes, loadGraphPolicy, weightsSha, type GraphPolicy } from './policy.js';
import { currentRuleSet, getRuleSet, setRoles, setRules } from './ruleSet.js';
import { selectBuildRules, subsumedRules } from './subsume.js';
import { loadTextTests, type TextTests } from './textTests.js';

export interface BuildInput {
  atomSetSha: string; schemaVersion: number; ruleSetVersion: number; corpusId: number;
  poolSnapshotId: number; testsVersion: number; weightsSha: string; scope: Scope;
  /**
   * spec rev. 11 sec. 5.8: the SHA of the sorted hashes of the build rules (the accepted rules that are not subsumed).
   * From rev. 13 the build rules also leave out the owner exclusion list (sec. 7.7), so the list is in this SHA.
   */
  buildRulesSha: string;
  /** spec rev. 12 sec. 7.6: the build applies the mana cost gate. */
  manaCostGate: boolean;
  /** spec rev. 14 sec. 7.8: the build applies the "Double" object gate. Absent before rev. 14, so older keys stay. */
  doubleObjectGate?: boolean;
  /**
   * spec rev. 16 sec. 7.9: the version of the object gate that the build applies (build 8 stored
   * `true`, version 1). Absent before rev. 16, so older keys stay.
   */
  objectGate?: boolean | number;
  /** spec rev. 19 sec. 7.2: the grade version. Absent before rev. 19 (version 1), so older keys stay. */
  gradeVersion?: number;
  /** spec rev. 21 sec. 7.10: the version of the link gate. Absent before rev. 21, so older keys stay. */
  linkGate?: number;
}

/**
 * spec sec. 7.1 and plan D4: the SHA of the atom set, the schema version, the rule-set version,
 * the corpus, the pool snapshot, the text-tests version and the weights. The scope is also in
 * the key, so two scopes never share a build. The cycle limits and the golden values are not.
 * From spec rev. 11 the SHA of the build rules is also in the key (sec. 5.8), and from rev. 12
 * the mana cost gate (sec. 7.6), and from rev. 14 the "Double" object gate (sec. 7.8), and from
 * rev. 16 the object gate (sec. 7.9), and from rev. 21 the link gate (sec. 7.10).
 */
export function buildKey(input: BuildInput): string {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}

type Tally = { confirmed: number; plausible: number };
const tally = (): Tally => ({ confirmed: 0, plausible: 0 });
const byPolarity = () => ({ '+': tally(), '-': tally() });

export interface BuildCounts {
  rule_set: { id: number; version: number };
  weights: GraphPolicy['weights'];
  weights_sha: string;
  scope_cards: number;
  cards_with_atoms: number;
  atoms: number;
  ambiguous_atoms: number;
  classes: number;
  /** Atom edges (sec. 7.1 keys), explicit and class, by polarity and grade. */
  atom_edges: { '+': Tally; '-': Tally };
  class_atom_edges: { '+': Tally; '-': Tally };
  /** Merged explicit edges (sec. 7.3) by polarity and grade. */
  merged_edges: { '+': Tally; '-': Tally };
  /** Merged class edges by polarity and grade. */
  class_edges: { '+': Tally; '-': Tally };
  /** spec rev. 12 sec. 7.6: true when the build applies the mana cost gate (absent in older builds). */
  mana_cost_gate?: boolean;
  /** spec rev. 14 sec. 7.8: true when the build applies the "Double" object gate (absent in older builds). */
  double_object_gate?: boolean;
  /** spec rev. 16 sec. 7.9: the version of the object gate (`true` in build 8 is version 1). */
  object_gate?: boolean | number;
  /** spec rev. 21 sec. 7.10: the version of the link gate (absent: off). */
  link_gate?: number;
  /** spec rev. 19 sec. 7.2: the grade version (absent: 1). */
  grade_version?: number;
  /** Atom edges that a merge joined to another atom edge: atom edges minus merged edges. */
  merges: number;
  /** Merged edges with two or more rules. */
  multi_rule_edges: number;
  synergy_pairs: number;
  self_pairs: number;
  anti_pairs: number;
  /** Build rules (accepted, not subsumed) with and without atom edges. */
  rules_with_edges: number;
  rules_without_edges: number;
  /** spec rev. 11 sec. 5.8: accepted rules that another accepted rule subsumes; the build leaves them out. */
  subsumed_rules?: number;
  /**
   * spec rev. 13 sec. 7.7: the hashes of the accepted, not subsumed rules that the owner exclusion
   * list leaves out, sorted. An index of the build leaves out these rules (absent in older builds).
   */
  excluded_rules?: string[];
  ranks_refreshed: number;
  timings_ms: Record<string, number>;
}

/** Gap rows (sec. 13.3): `gap_kind|type_key|param` to count. */
type Gaps = Map<string, number>;
const addGap = (g: Gaps, kind: string, type: string, param = '', n = 1) => {
  const k = `${kind}|${type}|${param}`;
  g.set(k, (g.get(k) ?? 0) + n);
};

/** The effect counts that measure each test with a `test_decision` gap (spec sec. 4.2, config/text-tests.json). */
export const TEST_DECISION_EFFECTS: Record<string, Array<keyof GroupEffects>> = {
  reminder_strip: ['reminder_stripped', 'unclosed_reminder'],
  prefix_strip: ['prefix_stripped', 'prefix_refused'],
  activated: ['colon_in_quotes'],
  mana_symbols: ['hybrid_cost', 'unknown_mana'],
  timing_limit: ['timing_atoms'],
  turn_word: ['turn_word'],
  cost_residue: ['cost_unparsed'],
};

/** The pool snapshot of the live cards: the latest snapshot that the cards table has applied. */
export function poolSnapshotId(db: DatabaseSync): number {
  const r = db.prepare('SELECT MAX(last_seen_snapshot_id) id FROM cards WHERE rotated = 0').get() as { id: number | null };
  if (r.id === null) throw new Error('no live cards: sync the pool first');
  return r.id;
}

const typeId = (x: { family: string; type_key: string }) => `${x.family}.${x.type_key}`;

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * spec sec. 20.5: from the first v15 build the params `ENABLES.ACTIVATE.cost_mana` and
 * `ENABLES.DOUBLE.object` replace the mana cost gate (sec. 7.6) and the "Double" object gate
 * (sec. 7.8). A build on a v14 rule set keeps both gates. The object gate (sec. 7.9) stays.
 */
export function v14Gates(ruleSchemaVersion: number): Pick<BuildInput, 'manaCostGate' | 'doubleObjectGate'> {
  const on = ruleSchemaVersion < 15;
  return { manaCostGate: on, doubleObjectGate: on };
}

export interface BuildOptions { tests?: TextTests; policy?: GraphPolicy; ruleSetId?: number }

export function buildGraph(db: DatabaseSync, scope: Scope, opts: BuildOptions = {}): { buildId: number; reused: boolean; counts: BuildCounts } {
  const t0 = performance.now();
  // plan Task 7 Step 3: an open edge report of an atom that is no longer current becomes stale.
  retireStaleEdgeReports(db);
  const tests = opts.tests ?? loadTextTests();
  const policy = opts.policy ?? loadGraphPolicy();
  const setId = opts.ruleSetId ?? currentRuleSet(db)?.id;
  if (setId === undefined) throw new Error('no accepted edge-rule set');
  const set = getRuleSet(db, setId);
  if (!set || set.status !== 'accepted') throw new Error(`edge-rule set ${setId} is not accepted`);

  const atomIds = currentScopeAtoms(db, scope);
  // spec rev. 11 sec. 5.8: the build uses the accepted rules that no other accepted rule subsumes.
  const allAccepted = setRules(db, setId, 'accepted');
  const subsumed = subsumedRules(db, setId, allAccepted, GRADE_VERSION);
  // spec rev. 13 sec. 7.7: the build also leaves out the rules of the owner exclusion list.
  const { rules: accepted, excluded } = selectBuildRules(allAccepted, subsumed, excludedRuleHashes(policy));
  const input: BuildInput = {
    atomSetSha: atomSetSha(atomIds), schemaVersion: currentSchemaVersion(db), ruleSetVersion: set.version,
    corpusId: currentCorpusId(db), poolSnapshotId: poolSnapshotId(db), testsVersion: tests.tests_version,
    weightsSha: weightsSha(policy), scope,
    buildRulesSha: createHash('sha256').update(accepted.map((r) => r.rule_hash).sort().join(','), 'utf8').digest('hex'),
    ...v14Gates(set.schema_version),
    objectGate: OBJECT_GATE_VERSION,
    gradeVersion: GRADE_VERSION,
    linkGate: LINK_GATE_VERSION,
  };
  const key = buildKey(input);
  const old = db.prepare('SELECT id, counts_json FROM graph_builds WHERE build_key = ?').get(key) as { id: number; counts_json: string } | undefined;
  if (old) return { buildId: old.id, reused: true, counts: JSON.parse(old.counts_json) as BuildCounts };

  const timings: Record<string, number> = {};
  const lap = (name: string, since: number) => { timings[name] = Math.round(performance.now() - since); return performance.now(); };

  db.exec('BEGIN');
  try {
    // 1. Ability groups of the build atoms (sec. 4). Existing rows must agree (persistGroups).
    let t = performance.now();
    const cards = scopeCards(db, scope);
    const byCard = new Map<string, number[]>();
    for (const r of db.prepare('SELECT a.id, a.oracle_id FROM atoms a JOIN json_each(?) j ON j.value = a.id ORDER BY a.id')
      .all(JSON.stringify(atomIds)) as Array<{ id: number; oracle_id: string }>) {
      const l = byCard.get(r.oracle_id);
      if (l) l.push(r.id); else byCard.set(r.oracle_id, [r.id]);
    }
    const effects = emptyEffects();
    const gaps: Gaps = new Map();
    const roles = new Map(setRoles(db, setId).filter((r) => r.status === 'accepted').map((r) => [typeId(r), r.role]));
    // sec. 21 item M3: on a v16 set a keyword kind is also ACTIVATE.
    const kindsOf = (a: { family: string; type_key: string }) => (set.schema_version >= 16 ? kindTypes(typeId(a)) : [typeId(a)]);
    const isDemand = (a: { family: string; type_key: string }) =>
      a.family === 'CARES_ABOUT' || kindsOf(a).some((t) => ['demand', 'both'].includes(roles.get(t) ?? ''));
    const atomType = new Map((db.prepare('SELECT a.id, a.face_index, a.family, a.type_key FROM atoms a JOIN json_each(?) j ON j.value = a.id')
      .all(JSON.stringify(atomIds)) as Array<{ id: number; face_index: number; family: string; type_key: string }>).map((r) => [r.id, r]));
    let ambiguous = 0;
    let triggerWithoutDemand = 0;
    for (const id of cards) {
      const ids = byCard.get(id);
      if (!ids) continue;
      const r = groupsForCard(db, id, tests, ids);
      persistGroups(db, r.groups);
      addEffects(effects, r.effects);
      ambiguous += r.ambiguous;
      // sec. 4.4: a triggered group with no demand atom cannot receive an edge.
      for (const g of r.groups) {
        if (g.kind !== 'triggered') continue;
        const has = ids.some((a) => atomType.get(a)!.face_index === g.face_index && r.atomGroup.get(a) === g.group_index && isDemand(atomType.get(a)!));
        if (!has) triggerWithoutDemand++;
      }
    }
    addGap(gaps, 'trigger_without_demand', '*', '', triggerWithoutDemand);
    addGap(gaps, 'trigger_word_inside', '*', '', effects.trigger_word_inside);
    for (const test of tests.tests) {
      if (test.decision?.gap_kind !== 'test_decision') continue;
      const keys = TEST_DECISION_EFFECTS[test.test];
      if (!keys) throw new Error(`text test ${test.test} has a test_decision gap but no effect count`);
      for (const k of keys) addGap(gaps, 'test_decision', test.test, k, effects[k]);
    }
    t = lap('groups', t);

    // 2. The index: build atoms, build rules, class nodes.
    const disputed = setRules(db, setId, 'disputed');
    const atoms = atomInfo(db, atomIds, tests.tests_version);
    const params = demandParamLists(db, set.schema_version);
    const classes = indexClasses(db, scope, accepted, atoms, input.linkGate ?? 0);
    const gate = {
      ...(input.objectGate ? { objectGate: objectGateData(db, set.schema_version, input.objectGate === true ? 1 : input.objectGate) } : {}),
      linkGate: input.linkGate ?? 0,
    };
    const index = new BuildIndex({ atoms, rules: accepted, classes, params, policy, manaCostGate: input.manaCostGate,
      doubleObjectGate: input.doubleObjectGate, gradeVersion: input.gradeVersion ?? 1, activateKinds: set.schema_version >= 16, ...gate });
    t = lap('index', t);

    // 3. Edges, card by card: atom edges, merge, matrices, gaps. The edges are then discarded.
    const n = cards.length;
    const pos = new Map(cards.map((c, i) => [c, i]));
    const words = Math.ceil(n / 32);
    const synergy = new Uint32Array(n * words);
    const anti = new Uint32Array(n * words);
    const weight = new Float32Array(n * n);
    const classEdges = new Int32Array(n);
    const setBit = (m: Uint32Array, i: number, j: number) => { m[i * words + (j >>> 5)]! |= 1 << (j & 31); };

    const counts = {
      atom_edges: byPolarity(), class_atom_edges: byPolarity(), merged_edges: byPolarity(), class_edges: byPolarity(),
      merges: 0, multi_rule_edges: 0, self_pairs: 0,
    };
    const ruleEdges = new Map<string, number>();
    const ruleDemand = new Map([...accepted, ...disputed].map((r) => [r.rule_hash, r.demand]));
    const countAtomEdge = (e: IndexedAtomEdge, into: { '+': Tally; '-': Tally }) => {
      into[e.polarity][e.grade]++;
      ruleEdges.set(e.rule_hash, (ruleEdges.get(e.rule_hash) ?? 0) + 1);
      // The demand type of the rule: the atom's own type, or ACTIVATE for a keyword kind (sec. 21 M3).
      const demand = ruleDemand.get(e.rule_hash) ?? atoms.get(e.demand_atom_id)!;
      const dt = typeId(demand);
      if (index.paramsOf(demand).length === 0) addGap(gaps, 'no_param_type', dt);
      for (const p of e.unresolved) addGap(gaps, e.partial.includes(p) ? 'partial_param' : 'unresolved_param', dt, p);
    };
    const countMerged = (es: MergedEdge[], into: { '+': Tally; '-': Tally }) => {
      for (const e of es) {
        into[e.polarity][e.grade]++;
        if (e.rule_hashes.length > 1) counts.multi_rule_edges++;
      }
    };

    for (const c of index.cards()) {
      const i = pos.get(c)!;
      const ae = index.cardAtomEdges(c);
      for (const e of ae.supply) countAtomEdge(e, counts.atom_edges);
      for (const e of ae.classes) countAtomEdge(e, counts.class_atom_edges);
      const merged = mergeEdges(ae.supply, index.ctx);
      const mergedCls = mergeEdges(ae.classes, index.ctx);
      counts.merges += ae.supply.length - merged.length + ae.classes.length - mergedCls.length;
      countMerged(merged, counts.merged_edges);
      countMerged(mergedCls, counts.class_edges);
      for (const [k, p] of cardPairs(merged.filter((e) => e.polarity === '+'))) {
        const j = pos.get(k.split('|')[1]!)!;
        setBit(synergy, i, j);
        weight[i * n + j] = p.weight;
        if (i === j) counts.self_pairs++;
      }
      for (const k of cardPairs(merged.filter((e) => e.polarity === '-')).keys()) {
        const j = pos.get(k.split('|')[1]!)!;
        setBit(anti, i, j);
        setBit(anti, j, i);
      }
      classEdges[i] = mergedCls.filter((e) => e.polarity === '+').length;
    }
    t = lap('edges', t);

    // 4. Atom edges of the disputed rules, for the review-queue rank only (sec. 10.1 rank 2).
    const disputedIndex = new BuildIndex({ atoms, rules: disputed, classes: indexClasses(db, scope, disputed, atoms, input.linkGate ?? 0), params, policy, manaCostGate: input.manaCostGate,
      doubleObjectGate: input.doubleObjectGate, gradeVersion: input.gradeVersion ?? 1, activateKinds: set.schema_version >= 16, ...gate });
    for (const c of disputedIndex.cards()) {
      const ae = disputedIndex.cardAtomEdges(c);
      for (const e of [...ae.supply, ...ae.classes]) ruleEdges.set(e.rule_hash, (ruleEdges.get(e.rule_hash) ?? 0) + 1);
    }
    t = lap('disputed_rules', t);

    // 5. Degree (sec. 7.5).
    const degree = cards.map((oracle, i) => {
      let outD = 0; let inD = 0; let antiD = 0; let outW = 0; let inW = 0;
      for (let w = 0; w < words; w++) { outD += popcount(synergy[i * words + w]!); antiD += popcount(anti[i * words + w]!); }
      for (let j = 0; j < n; j++) {
        outW += weight[i * n + j]!;
        inW += weight[j * n + i]!;
        if ((synergy[j * words + (i >>> 5)]! >>> (i & 31)) & 1) inD++;
      }
      return { oracle, outD, inD, outW, inW, cls: classEdges[i]!, antiD };
    });
    const synergyPairs = degree.reduce((s, d) => s + d.outD, 0);
    const antiPairs = degree.reduce((s, d) => s + d.antiD, 0);
    t = lap('degree', t);

    // 6. Write the build record, the atom set, the degree, the gaps, and the ranks.
    const out: BuildCounts = {
      rule_set: { id: setId, version: set.version }, weights: policy.weights, weights_sha: input.weightsSha,
      scope_cards: n, cards_with_atoms: index.cards().length, atoms: atomIds.length, ambiguous_atoms: ambiguous,
      classes: classes.length, mana_cost_gate: input.manaCostGate, double_object_gate: input.doubleObjectGate === true,
      ...(input.objectGate ? { object_gate: input.objectGate } : {}),
      ...(input.gradeVersion ? { grade_version: input.gradeVersion } : {}),
      ...(input.linkGate ? { link_gate: input.linkGate } : {}),
      atom_edges: counts.atom_edges, class_atom_edges: counts.class_atom_edges,
      merged_edges: counts.merged_edges, class_edges: counts.class_edges,
      merges: counts.merges, multi_rule_edges: counts.multi_rule_edges,
      synergy_pairs: synergyPairs, self_pairs: counts.self_pairs, anti_pairs: antiPairs,
      rules_with_edges: accepted.filter((r) => ruleEdges.has(r.rule_hash)).length,
      rules_without_edges: accepted.filter((r) => !ruleEdges.has(r.rule_hash)).length,
      subsumed_rules: subsumed.size,
      ...(excluded.length ? { excluded_rules: excluded } : {}),
      ranks_refreshed: 0, timings_ms: timings,
    };
    const buildId = Number(db.prepare(
      `INSERT INTO graph_builds (build_key, rule_set_id, schema_version, corpus_id, pool_snapshot_id, tests_version,
                                 atom_set_sha, scope, built_at, counts_json) VALUES (?,?,?,?,?,?,?,?,?,'{}')`,
    ).run(key, setId, input.schemaVersion, input.corpusId, input.poolSnapshotId, input.testsVersion, input.atomSetSha, scope,
      new Date().toISOString()).lastInsertRowid);
    const insAtom = db.prepare('INSERT INTO graph_build_atoms (build_id, atom_id) VALUES (?, ?)');
    for (const id of atomIds) insAtom.run(buildId, id);
    const insDeg = db.prepare(
      `INSERT INTO card_degree (build_id, oracle_id, out_degree, in_degree, out_weight, in_weight, class_edges, anti_degree)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (const d of degree) insDeg.run(buildId, d.oracle, d.outD, d.inD, d.outW, d.inW, d.cls, d.antiD);
    const insGap = db.prepare('INSERT INTO graph_gaps (build_id, gap_kind, type_key, param, count) VALUES (?,?,?,?,?)');
    for (const [k, v] of [...gaps].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const [kind, type, param] = k.split('|') as [string, string, string];
      insGap.run(buildId, kind, type, param, v);
    }
    // sec. 10.1 rank 2: the atom edges of the rule in this build.
    out.ranks_refreshed = refreshRuleRanks(db, setId, ruleEdges);
    lap('write', t);
    timings['total'] = Math.round(performance.now() - t0);
    db.prepare('UPDATE graph_builds SET counts_json = ? WHERE id = ?').run(JSON.stringify(out), buildId);
    db.exec('COMMIT');
    return { buildId, reused: false, counts: out };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
