/**
 * Subsumed edge rules (Phase 3 spec rev. 11 sec. 5.8). An accepted rule is subsumed when another
 * accepted rule of the same set makes an atom edge for each atom pair that it matches, with the
 * same or a better resolution of each demand param. Then the narrow rule adds no edge and changes
 * no grade: the merge (sec. 7.3) takes the best part, and the wide rule gives that part.
 *
 * The check is mechanical and knows no Magic. Rule W subsumes rule N when:
 * - the polarity, the supply side (type or intrinsic class) and the demand type are the same;
 * - each predicate of W (supply and demand) follows from a predicate of N on the same param;
 * - each demand param of the demand type resolves in W at least as well as in N (sec. 7.2):
 *   W and N have the same link, the same implication and the same array operator for it; or N
 *   has no link and no implication for it (so it stays unresolved) and an `eq` or `in` predicate
 *   of N limits it to values that agree with an implication of W (W has no link for it).
 *   In the second case W gives a better or equal part, and the merge keeps the better part.
 *
 * The build and the explorer use the accepted rules that are not subsumed (`buildRules`). The
 * subsumed rules stay in `edge_rules` with status `accepted`; nothing is written.
 */
import type { DatabaseSync } from 'node:sqlite';
import { demandParamLists } from './buildIndex.js';
import { agreement, predicateHolds } from './match.js';
import { canonicalJson } from './policy.js';
import { isIntrinsic, sideId, type EdgeRuleContent, type Predicate, type TypeSide } from './ruleSchema.js';
import { getRuleSet, setRules, type StoredRule } from './ruleSet.js';

const key = (v: unknown) => canonicalJson(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const subset = (a: unknown[], b: unknown[]) => {
  const set = new Set(b.map(key));
  return a.every((v) => set.has(key(v)));
};

/** The canonical form of a predicate value: the set operators compare sorted, unique lists. */
function canon(p: Predicate): string {
  if (p.op === 'eq' || !Array.isArray(p.value)) return key(p);
  return key({ ...p, value: [...new Set(p.value.map(key))].sort() });
}

/**
 * True when predicate `a` holding on an atom makes predicate `b` hold on it (same param). The
 * operators are the ones of sec. 5.1 (`predicateHolds`). When `a` is `eq` or `in`, the param has
 * one of a finite list of values, and `b` must hold for each of them.
 */
export function predicateImplies(a: Predicate, b: Predicate): boolean {
  if (a.param !== b.param) return false;
  if (canon(a) === canon(b)) return true;
  if (a.op === 'eq' || a.op === 'in') {
    const values = a.op === 'eq' ? [a.value] : asArray(a.value);
    return values.every((v) => predicateHolds(b, { [b.param]: v }));
  }
  if (a.op === 'overlaps' && b.op === 'overlaps') return subset(asArray(a.value), asArray(b.value));
  if (a.op === 'disjoint' && b.op === 'disjoint') return subset(asArray(b.value), asArray(a.value));
  return false;
}

/** True when each predicate of `wide` follows from a predicate of `narrow`. */
export function whereImplies(narrow: readonly Predicate[], wide: readonly Predicate[]): boolean {
  return wide.every((b) => narrow.some((a) => predicateImplies(a, b)));
}

/** The array operator of the demand param in the rule (the lookup of `resolveParams`). */
const arrayOp = (r: EdgeRuleContent, dp: string): 'overlaps' | 'disjoint' =>
  (r.demand.where.find((p) => p.param === dp && (p.op === 'overlaps' || p.op === 'disjoint'))?.op as 'overlaps' | 'disjoint' | undefined) ?? 'overlaps';

/** How the rule resolves one demand param (sec. 7.2): its link, its implication and its array operator. */
function resolutionSource(r: EdgeRuleContent, dp: string): string {
  const link = r.param_links.find((l) => l.demand === dp)?.supply ?? null;
  const imp = r.implications.find((i) => i.demand_param === dp);
  return key({ link, imp: imp ? { v: imp.value } : null, op: link !== null || imp ? arrayOp(r, dp) : null });
}

/**
 * True when `wide` resolves the demand param `dp` at least as well as `narrow` on each demand atom
 * that `narrow` matches (see the file header).
 */
function resolvesAsWell(wide: EdgeRuleContent, narrow: EdgeRuleContent, dp: string, version = 1): boolean {
  if (resolutionSource(wide, dp) === resolutionSource(narrow, dp)) {
    // Grade version 2 (sec. 7.2 step 4): a demand predicate without a link or an implication
    // resolves the param, so the narrow rule's predicate needs one in the wide rule too.
    const named = (r: EdgeRuleContent) => r.demand.where.some((p) => p.param === dp);
    const viaPredicate = (r: EdgeRuleContent) => named(r)
      && !r.param_links.some((l) => l.demand === dp) && !r.implications.some((i) => i.demand_param === dp);
    return !(version >= 2 && viaPredicate(narrow) && !named(wide));
  }
  if (narrow.param_links.some((l) => l.demand === dp) || narrow.implications.some((i) => i.demand_param === dp)) return false;
  if (wide.param_links.some((l) => l.demand === dp)) return false;
  const imp = wide.implications.find((i) => i.demand_param === dp);
  if (!imp) return false;
  const op = arrayOp(wide, dp);
  return narrow.demand.where.some((p) => p.param === dp && (p.op === 'eq' || p.op === 'in')
    && (p.op === 'eq' ? [p.value] : asArray(p.value)).every((v) => agreement(imp.value, v, op) === 'agrees'));
}

/** The type pair of a rule: polarity, supply side, demand type. */
export function typePair(r: EdgeRuleContent): string {
  return `${r.polarity}|${sideId(r.supply)}|${r.demand.family}.${r.demand.type_key}`;
}

/**
 * True when rule `wide` subsumes rule `narrow` (see the file header). `demandParams` is the param
 * list of the demand type; with none, the params of both rules' links and implications count.
 */
export function subsumes(wide: EdgeRuleContent, narrow: EdgeRuleContent, demandParams?: readonly string[], version = 1): boolean {
  if (typePair(wide) !== typePair(narrow)) return false;
  if (!isIntrinsic(wide.supply) && !whereImplies((narrow.supply as TypeSide).where, wide.supply.where)) return false;
  if (!whereImplies(narrow.demand.where, wide.demand.where)) return false;
  const params = demandParams ?? [...new Set([wide, narrow].flatMap((r) => [...r.param_links.map((l) => l.demand),
    ...r.implications.map((i) => i.demand_param), ...(version >= 2 ? r.demand.where.map((p) => p.param) : [])]))];
  return params.every((dp) => resolvesAsWell(wide, narrow, dp, version));
}

export interface Subsumption { narrow: StoredRule; wide: StoredRule }

/**
 * The subsumed rules of a rule list, each with the wide rule that replaces it. Two rules that
 * subsume each other are equal in effect: the lower rule ID stays. The wide rule is a rule that
 * is not subsumed itself (the lowest rule ID of those that subsume the narrow rule). A rule with
 * no such wide rule is not subsumed.
 */
export function findSubsumed(rules: readonly StoredRule[], paramsOf: (demandType: string) => readonly string[] | undefined,
  version = 1): Map<string, Subsumption> {
  const groups = new Map<string, StoredRule[]>();
  for (const r of rules) {
    const k = typePair(r);
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  const out = new Map<string, Subsumption>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((a, b) => (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : a.rule_hash < b.rule_hash ? -1 : 1));
    const params = paramsOf(`${g[0]!.demand.family}.${g[0]!.demand.type_key}`);
    const sub = (w: StoredRule, n: StoredRule) => w !== n && subsumes(w, n, params, version);
    // `beats(w, n)`: w replaces n. Equal rules: the first in rule-ID order stays.
    const beats = (w: StoredRule, n: StoredRule) => sub(w, n) && (!sub(n, w) || sorted.indexOf(w) < sorted.indexOf(n));
    const kept = sorted.filter((n) => !sorted.some((w) => beats(w, n)));
    for (const n of sorted) {
      if (kept.includes(n)) continue;
      const wide = kept.find((w) => sub(w, n));
      if (wide) out.set(n.rule_hash, { narrow: n, wide });
    }
  }
  return out;
}

/** The subsumed accepted rules of a set (keyed by rule hash), for a grade version (sec. 7.2). */
export function subsumedRules(db: DatabaseSync, setId: number, accepted: readonly StoredRule[] = setRules(db, setId, 'accepted'),
  version = 1): Map<string, Subsumption> {
  const set = getRuleSet(db, setId);
  if (!set) throw new Error(`no edge-rule set ${setId}`);
  const params = demandParamLists(db, set.schema_version);
  return findSubsumed(accepted, (t) => params.get(t), version);
}

/**
 * spec rev. 11 sec. 5.8: the rules of a build - the accepted rules that are not subsumed. From
 * rev. 13 (sec. 7.7) also not in `excluded` (the owner exclusion list that the build recorded).
 * Subsumption uses all accepted rules, so an exclusion does not bring back a subsumed rule.
 */
export function buildRules(db: DatabaseSync, setId: number, excluded: ReadonlySet<string> = new Set(), version = 1): StoredRule[] {
  const accepted = setRules(db, setId, 'accepted');
  return selectBuildRules(accepted, subsumedRules(db, setId, accepted, version), excluded).rules;
}

/**
 * The build rules of the accepted rules (sec. 5.8 and 7.7) and the sorted hashes of the rules
 * that the exclusion list leaves out. A subsumed rule is not counted as excluded.
 */
export function selectBuildRules(accepted: readonly StoredRule[], subsumed: ReadonlyMap<string, unknown>,
  excluded: ReadonlySet<string>): { rules: StoredRule[]; excluded: string[] } {
  const live = accepted.filter((r) => !subsumed.has(r.rule_hash));
  return {
    rules: live.filter((r) => !excluded.has(r.rule_hash)),
    excluded: live.filter((r) => excluded.has(r.rule_hash)).map((r) => r.rule_hash).sort(),
  };
}
