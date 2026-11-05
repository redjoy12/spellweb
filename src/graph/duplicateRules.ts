/**
 * The duplicate-rule analysis of an accepted edge-rule set (Phase 3 spec rev. 11 sec. 5.8). Read
 * only. It sorts the rules of each type pair with two or more accepted rules into three classes:
 * - subsumed: another accepted rule of the type pair subsumes it (`subsume.ts`), so it adds no edge;
 * - conflicting: two or more rules of the type pair stay after the subsumption, and neither
 *   subsumes the other (they disagree on a predicate, a link or an implication);
 * - supply twins: two supply types of one family whose accepted rules have the same content
 *   except the supply type key. These are candidates for the schema v15 decision, not a build change.
 * It also counts the merged edges of a build that each class touches, and compares the merged
 * edges of the build with all accepted rules and with the build rules (the proof of sec. 5.8).
 */
import type { DatabaseSync } from 'node:sqlite';
import { BuildIndex } from './buildIndex.js';
import { cardPairs, mergeEdges, type MergedEdge } from './merge.js';
import { canonicalJson } from './policy.js';
import { canonicalRule, isIntrinsic, type Predicate } from './ruleSchema.js';
import { setRules, type StoredRule } from './ruleSet.js';
import { subsumedRules, typePair, type Subsumption } from './subsume.js';

export interface ConflictGroup {
  type_pair: string;
  rules: StoredRule[];
  /** What differs between the rules that stay: supply where, demand where, links, implications. */
  differs: string[];
}

export interface TwinPair {
  supply_types: [string, string]; shared: number; a_rules: number; b_rules: number; jaccard: number;
  /** All accepted rules of the two supply types. */
  rules: StoredRule[];
}

export interface EdgeTouch { merged_edges: number; card_pairs: number }

export interface DuplicateAnalysis {
  set_id: number;
  build_id: number | null;
  accepted: number;
  type_pairs: number;
  multi_type_pairs: number;
  multi_rules: number;
  subsumed: Subsumption[];
  conflicts: ConflictGroup[];
  /** Supply twins (jaccard 1) and near twins (from NEAR_TWIN). */
  twins: TwinPair[];
  /** Merged edges and card pairs of the build that each class touches (rules with all accepted rules). */
  touch: { subsumed: EdgeTouch; conflicting: EdgeTouch; twins: EdgeTouch; multi_rule_edges_before: number; multi_rule_edges_after: number } | null;
  /** The merged edges with all accepted rules against the merged edges with the build rules. */
  proof: EdgeProof | null;
}

export interface EdgeProof {
  cards: number;
  merged_before: number;
  merged_after: number;
  /** Merged edges whose key, polarity, grade, unresolved params or weight differ, or that only one side has. */
  differences: string[];
  pairs_before: number;
  pairs_after: number;
  /** Merged edges whose rule list became shorter. */
  shorter_rule_lists: number;
}

const canon = (ps: readonly Predicate[]) => canonicalJson(canonicalRule({
  polarity: '+', supply: { family: '', type_key: '', where: [...ps] }, demand: { family: '', type_key: '', where: [] }, param_links: [], implications: [],
}).supply);

function differs(rules: readonly StoredRule[]): string[] {
  const c = rules.map((r) => canonicalRule(r));
  const out: string[] = [];
  const varies = (f: (x: (typeof c)[number]) => unknown) => new Set(c.map((x) => canonicalJson(f(x)))).size > 1;
  if (varies((x) => (isIntrinsic(x.supply) ? null : canon(x.supply.where)))) out.push('supply where');
  if (varies((x) => canon(x.demand.where))) out.push('demand where');
  if (varies((x) => x.param_links)) out.push('param links');
  if (varies((x) => x.implications)) out.push('implications');
  return out;
}

/** The content of a typed rule without its supply type key: equal for two supply twins. */
function twinKey(r: StoredRule): string {
  const c = canonicalRule(r);
  return canonicalJson({ ...c, supply: { ...c.supply, type_key: '*' } });
}

/**
 * Supply-type pairs of one family whose accepted rules have the same content except the supply
 * type key. `jaccard` is the shared contents over all contents of the two types. A pair with
 * jaccard 1 has the same rules for each demand type: a supply twin. Pairs from NEAR_TWIN upward
 * are listed for information.
 */
export const NEAR_TWIN = 0.9;
export function twinPairs(rules: readonly StoredRule[]): TwinPair[] {
  const byType = new Map<string, { keys: Set<string>; rules: StoredRule[] }>();
  for (const r of rules) {
    if (isIntrinsic(r.supply)) continue;
    const t = `${r.supply.family}.${r.supply.type_key}`;
    const v = byType.get(t) ?? { keys: new Set<string>(), rules: [] };
    v.keys.add(twinKey(r));
    v.rules.push(r);
    byType.set(t, v);
  }
  const types = [...byType.keys()].sort();
  const out: TwinPair[] = [];
  for (let i = 0; i < types.length; i++) {
    for (let j = i + 1; j < types.length; j++) {
      const [ta, tb] = [types[i]!, types[j]!];
      if (ta.split('.')[0] !== tb.split('.')[0]) continue;
      const a = byType.get(ta)!;
      const b = byType.get(tb)!;
      let shared = 0;
      for (const k of a.keys) if (b.keys.has(k)) shared++;
      const jaccard = shared / (a.keys.size + b.keys.size - shared);
      if (shared < 2 || jaccard < NEAR_TWIN) continue;
      out.push({ supply_types: [ta, tb], shared, a_rules: a.rules.length, b_rules: b.rules.length, jaccard, rules: [...a.rules, ...b.rules] });
    }
  }
  return out.sort((x, y) => y.jaccard - x.jaccard || y.shared - x.shared || (x.supply_types[0] < y.supply_types[0] ? -1 : 1));
}

function mergedOfCard(index: BuildIndex, card: string): MergedEdge[] {
  const ae = index.cardAtomEdges(card);
  return [...mergeEdges(ae.supply, index.ctx), ...mergeEdges(ae.classes, index.ctx)];
}

const edgeFace = (e: MergedEdge) => canonicalJson({ k: e.key, p: e.polarity, g: e.grade, u: e.unresolved, w: e.weight.total });

/** The type pairs with two or more accepted rules that stay after the subsumption (class (b)). */
export function conflictGroups(accepted: readonly StoredRule[], sub: ReadonlyMap<string, unknown>): ConflictGroup[] {
  const groups = new Map<string, StoredRule[]>();
  for (const r of accepted) {
    const k = typePair(r);
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  const out: ConflictGroup[] = [];
  for (const [k, g] of groups) {
    const stay = g.filter((r) => !sub.has(r.rule_hash));
    if (stay.length > 1) out.push({ type_pair: k, rules: stay, differs: differs(stay) });
  }
  return out;
}

export function analyseDuplicates(db: DatabaseSync, setId: number, buildId: number | null): DuplicateAnalysis {
  const accepted = setRules(db, setId, 'accepted');
  const groups = new Map<string, StoredRule[]>();
  for (const r of accepted) {
    const k = typePair(r);
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  const multi = [...groups].filter(([, g]) => g.length > 1);
  const sub = subsumedRules(db, setId, accepted);
  const conflicts = conflictGroups(accepted, sub);
  const twins = twinPairs(accepted);
  const out: DuplicateAnalysis = {
    set_id: setId, build_id: buildId, accepted: accepted.length, type_pairs: groups.size,
    multi_type_pairs: multi.length, multi_rules: multi.reduce((s, [, g]) => s + g.length, 0),
    subsumed: [...sub.values()].sort((a, b) => (a.narrow.rule_id < b.narrow.rule_id ? -1 : 1)),
    conflicts, twins, touch: null, proof: null,
  };
  if (buildId === null) return out;

  const before = BuildIndex.load(db, buildId, accepted);
  const after = BuildIndex.load(db, buildId, accepted.filter((r) => !sub.has(r.rule_hash)));
  const classes = {
    subsumed: new Set(sub.keys()),
    conflicting: new Set(conflicts.flatMap((c) => c.rules.map((r) => r.rule_hash))),
    twins: new Set(twins.filter((t) => t.jaccard === 1).flatMap((t) => t.rules.map((r) => r.rule_hash))),
  };
  const touch = {
    subsumed: { merged_edges: 0, card_pairs: 0 }, conflicting: { merged_edges: 0, card_pairs: 0 }, twins: { merged_edges: 0, card_pairs: 0 },
    multi_rule_edges_before: 0, multi_rule_edges_after: 0,
  };
  const proof: EdgeProof = { cards: 0, merged_before: 0, merged_after: 0, differences: [], pairs_before: 0, pairs_after: 0, shorter_rule_lists: 0 };
  for (const card of before.cards()) {
    proof.cards++;
    const mb = mergedOfCard(before, card);
    const ma = mergedOfCard(after, card);
    proof.merged_before += mb.length;
    proof.merged_after += ma.length;
    for (const [name, set] of Object.entries(classes) as Array<[keyof typeof classes, Set<string>]>) {
      const hit = mb.filter((e) => e.rule_hashes.some((h) => set.has(h)));
      touch[name].merged_edges += hit.length;
      touch[name].card_pairs += cardPairs(hit).size;
    }
    touch.multi_rule_edges_before += mb.filter((e) => e.rule_hashes.length > 1).length;
    touch.multi_rule_edges_after += ma.filter((e) => e.rule_hashes.length > 1).length;
    const fa = new Map(ma.map((e) => [e.key, e]));
    const fb = new Map(mb.map((e) => [e.key, e]));
    for (const e of mb) {
      const a = fa.get(e.key);
      if (!a || edgeFace(a) !== edgeFace(e)) proof.differences.push(`${card}: ${e.key}`);
      else if (a.rule_hashes.length < e.rule_hashes.length) proof.shorter_rule_lists++;
    }
    for (const e of ma) if (!fb.has(e.key)) proof.differences.push(`${card}: ${e.key} (new)`);
    const pairFace = (es: MergedEdge[]) => [...cardPairs(es)].map(([k, p]) => `${k}|${p.weight}`).sort().join(';');
    for (const pol of ['+', '-'] as const) {
      const pb = mb.filter((e) => e.polarity === pol);
      const pa = ma.filter((e) => e.polarity === pol);
      proof.pairs_before += cardPairs(pb).size;
      proof.pairs_after += cardPairs(pa).size;
      if (pairFace(pb) !== pairFace(pa)) proof.differences.push(`${card}: card pairs ${pol} differ`);
    }
  }
  out.touch = touch;
  out.proof = proof;
  return out;
}

/** A type pair for a Markdown table cell: `+ SUPPLY -> DEMAND` (no pipe). */
const pairCell = (k: string) => { const [p, sup, dem] = k.split('|'); return `\`${p} ${sup} -> ${dem}\``; };

const asPercent = (x: number, digits = 1) => x.toLocaleString('en-US', { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (n: number, d: number) => (d === 0 ? '0%' : asPercent(n / d));

/** A short JSON-like view of the predicates, links and implications of a rule, for the report. */
export function ruleShape(r: StoredRule): string {
  const where = (ps: readonly Predicate[]) => ps.map((p) => `${p.param} ${p.op} ${canonicalJson(p.value)}`).join(', ') || '-';
  const parts = [
    isIntrinsic(r.supply) ? '' : `supply: ${where(r.supply.where)}`,
    `demand: ${where(r.demand.where)}`,
    `links: ${r.param_links.map((l) => `${l.supply}->${l.demand}`).join(', ') || '-'}`,
    `implies: ${r.implications.map((i) => `${i.demand_param}=${canonicalJson(i.value)}`).join(', ') || '-'}`,
  ].filter(Boolean);
  return parts.join('; ').replace(/\|/g, '\\|');
}

/** The tables of the report (docs/phase-3-duplicate-reasons.md): counts, the subsumed rules, the conflicts, the twins. */
export function renderDuplicateTables(a: DuplicateAnalysis): string {
  const L: string[] = [];
  L.push('| Item | Count |', '|---|---|');
  L.push(`| Accepted rules (set ${a.set_id}) | ${a.accepted} |`);
  L.push(`| Type pairs (polarity, supply, demand) | ${a.type_pairs} |`);
  L.push(`| Type pairs with 2 or more rules | ${a.multi_type_pairs} (${a.multi_rules} rules) |`);
  L.push(`| (a) Subsumed rules | ${a.subsumed.length} |`);
  L.push(`| (b) Conflicting type pairs | ${a.conflicts.length} (${a.conflicts.reduce((s, c) => s + c.rules.length, 0)} rules) |`);
  const tw = a.twins.filter((t) => t.jaccard === 1);
  L.push(`| (c) Supply-twin type pairs | ${tw.length} (${tw.reduce((s, t) => s + t.rules.length, 0)} rules) |`);
  if (a.touch && a.proof) {
    const t = a.touch;
    L.push('', `Merged edges of build ${a.build_id} that each class touches (a merged edge with a rule of the class):`, '');
    L.push('| Class | Merged edges | Card pairs |', '|---|---|---|');
    L.push(`| (a) subsumed | ${t.subsumed.merged_edges} (${pct(t.subsumed.merged_edges, a.proof.merged_before)}) | ${t.subsumed.card_pairs} |`);
    L.push(`| (b) conflicting | ${t.conflicting.merged_edges} (${pct(t.conflicting.merged_edges, a.proof.merged_before)}) | ${t.conflicting.card_pairs} |`);
    L.push(`| (c) supply twins | ${t.twins.merged_edges} (${pct(t.twins.merged_edges, a.proof.merged_before)}) | ${t.twins.card_pairs} |`);
    L.push(`| All merged edges | ${a.proof.merged_before} | ${a.proof.pairs_before} |`);
    L.push('', `Merged edges with 2 or more rules: ${t.multi_rule_edges_before} with all accepted rules, ${t.multi_rule_edges_after} with the build rules.`);
  }
  L.push('', '### (a) Subsumed rules', '', '| Subsumed rule | Kept rule | Type pair | Subsumed rule shape |', '|---|---|---|---|');
  for (const s of a.subsumed) L.push(`| ${s.narrow.rule_id} | ${s.wide.rule_id} | ${pairCell(typePair(s.narrow))} | ${ruleShape(s.narrow)} |`);
  L.push('', '### (b) Conflicting rules', '', '| Type pair | Rules | Differs in | Rule shapes |', '|---|---|---|---|');
  for (const c of a.conflicts) {
    L.push(`| ${pairCell(c.type_pair)} | ${c.rules.map((r) => r.rule_id).join(', ')} | ${c.differs.join(', ')} | ${c.rules.map((r) => `${r.rule_id}: ${ruleShape(r)}`).join('<br>')} |`);
  }
  const twins = a.twins.filter((t) => t.jaccard === 1);
  const near = a.twins.filter((t) => t.jaccard < 1);
  L.push('', '### (c) Supply twins (schema v15 candidates)', '', '| Supply types | Rules of each type | Same content |', '|---|---|---|');
  for (const t of twins) L.push(`| ${t.supply_types.join(' + ')} | ${t.a_rules} + ${t.b_rules} | ${t.shared} |`);
  L.push('', `Near twins (the same content for ${asPercent(NEAR_TWIN, 0)} or more of the contents of the two types), for information:`, '');
  L.push('| Supply types | Rules of each type | Same content | Share |', '|---|---|---|---|');
  for (const t of near) L.push(`| ${t.supply_types.join(' + ')} | ${t.a_rules} + ${t.b_rules} | ${t.shared} | ${t.jaccard.toFixed(2)} |`);
  return L.join('\n');
}
