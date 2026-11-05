/**
 * One atom pair through one edge rule (Phase 3 spec sec. 5.1 and 7.2): the predicates, the
 * resolution of each demand param and the grade. Pure functions; no database, no build.
 *
 * The value rules are the ones of sec. 7.2 and nothing more:
 * - a demand value `any` agrees with all supply values; a supply value `any` against a
 *   specific demand value is `partial`;
 * - equal specific values agree, different ones disagree;
 * - for arrays, the operator of the demand predicate on the param (`overlaps` or `disjoint`)
 *   gives the agreement; `overlaps` is the default, and an empty demand array agrees with all.
 * A demand predicate filters the demand atoms of a rule. It does not resolve a param: only a
 * link or an implication does (sec. 7.2 table).
 */
import type { IntrinsicClass } from './intrinsic.js';
import { canonicalJson } from './policy.js';
import { isIntrinsic, sideId, type EdgeRuleContent, type Predicate, type TypeSide } from './ruleSchema.js';
import { typesOf } from '../atoms/schemaV16.js';

export type Resolution = 'agrees' | 'partial' | 'unresolved' | 'disagrees';
export type Grade = 'confirmed' | 'plausible' | 'rejected';

export interface AtomLite {
  id: number; oracle_id: string; face_index: number; family: string; type_key: string;
  params: Record<string, unknown>; span_start: number; span_end: number;
}

const ANY = 'any';
const key = (v: unknown) => canonicalJson(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const common = (a: unknown[], b: unknown[]) => {
  const set = new Set(a.map(key));
  return b.some((v) => set.has(key(v)));
};

/**
 * spec sec. 5.1 operators on the params of one atom. An absent param never holds. For
 * `overlaps`, an empty param array agrees with all values (the demand rule of sec. 5.1).
 */
export function predicateHolds(p: Predicate, params: Record<string, unknown>): boolean {
  if (!(p.param in params)) return false;
  const v = params[p.param];
  switch (p.op) {
    case 'eq':
      return key(v) === key(p.value);
    case 'in':
      return asArray(p.value).some((x) => key(x) === key(v));
    case 'overlaps': {
      const arr = asArray(v);
      return arr.length === 0 || common(arr, asArray(p.value));
    }
    case 'disjoint':
      return !common(asArray(v), asArray(p.value));
  }
}

/**
 * True when the atom has the side's type and the side's predicates hold. With `kinds` (a build on
 * schema v16, spec sec. 21 item M3) a keyword activated ability also has the type ACTIVATE.
 */
export const sideHolds = (side: TypeSide, a: AtomLite, kinds = false) =>
  (kinds ? typesOf(`${a.family}.${a.type_key}`).includes(`${side.family}.${side.type_key}`) : a.family === side.family && a.type_key === side.type_key)
  && side.where.every((p) => predicateHolds(p, a.params));

/** The agreement of a supply value (linked or implied) with a demand value (sec. 7.2). */
export function agreement(supply: unknown, demand: unknown, arrayOp: 'overlaps' | 'disjoint'): Resolution {
  if (Array.isArray(demand) || Array.isArray(supply)) {
    const d = asArray(demand);
    const s = asArray(supply);
    if (d.length === 0 || d.some((x) => x === ANY)) return 'agrees';
    if (s.some((x) => x === ANY)) return 'partial';
    const hit = common(s, d);
    return (arrayOp === 'overlaps' ? hit : !hit) ? 'agrees' : 'disagrees';
  }
  if (demand === ANY) return 'agrees';
  if (supply === ANY) return 'partial';
  return key(supply) === key(demand) ? 'agrees' : 'disagrees';
}

/**
 * spec rev. 19 sec. 7.2: the grade version of new builds. Version 2 resolves a demand param that
 * states no restriction, or that a demand predicate of the rule names, to `agrees`. Version 3
 * (rev. 26): a supply atom with an empty `subtypes` names no subtype, so an `overlaps` predicate of
 * the supply side on that param does not hold. A stored build without a version is version 1.
 */
export const GRADE_VERSION = 3;

/** The supply params where an empty array names nothing (version 3). `token_types` and `card_types` stay out. */
const NAMED_SUPPLY_PARAMS: readonly string[] = ['subtypes'];

const namesNothing = (p: Predicate, a: AtomLite) => {
  const v = a.params[p.param];
  return p.op === 'overlaps' && NAMED_SUPPLY_PARAMS.includes(p.param) && Array.isArray(v) && v.length === 0;
};

/** sec. 7.2 version 2 step 1: `any`, `""`, `not_stated`, `[]`, or an array with `any` (sec. 20.1). */
export function statesNoRestriction(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0 || v.some((x) => x === ANY);
  return v === ANY || v === '' || v === 'not_stated';
}

/**
 * spec sec. 7.2: the resolution of each demand param that the demand atom has. `demandParams`
 * is the param list of the demand type, in schema order. `version` is the grade version.
 */
export function resolveParams(rule: EdgeRuleContent, supply: AtomLite | IntrinsicClass, demand: AtomLite,
  demandParams: readonly string[], version = 1): Map<string, Resolution> {
  const out = new Map<string, Resolution>();
  const supplyParams = 'params' in supply ? supply.params : null;
  for (const dp of demandParams) {
    if (!(dp in demand.params)) continue;
    const dv = demand.params[dp];
    if (version >= 2 && statesNoRestriction(dv)) { out.set(dp, 'agrees'); continue; }
    const op = rule.demand.where.find((p) => p.param === dp && (p.op === 'overlaps' || p.op === 'disjoint'))?.op as
      'overlaps' | 'disjoint' | undefined;
    let res: Resolution = 'unresolved';
    const link = rule.param_links.find((l) => l.demand === dp);
    const imp = rule.implications.find((i) => i.demand_param === dp);
    if (link && supplyParams && link.supply in supplyParams) {
      res = agreement(supplyParams[link.supply], dv, op ?? 'overlaps');
    } else if (imp) {
      res = agreement(imp.value, dv, op ?? 'overlaps');
    } else if (version >= 2 && !link && rule.demand.where.some((p) => p.param === dp)) {
      // Step 4: the edge exists only when the predicate holds on the demand atom.
      res = 'agrees';
    }
    out.set(dp, res);
  }
  return out;
}

/** spec sec. 7.2: the grade, and the sorted names of the params that are `partial` or `unresolved`. */
export function gradeOf(res: Map<string, Resolution>): { grade: Grade; unresolved: string[] } {
  const values = [...res.values()];
  if (values.includes('disagrees')) return { grade: 'rejected', unresolved: [] };
  const unresolved = [...res].filter(([, r]) => r !== 'agrees').map(([p]) => p).sort();
  return { grade: unresolved.length === 0 ? 'confirmed' : 'plausible', unresolved };
}

/** True when the supply side of a typed rule holds for the atom (its type and predicates). `version` is the grade version. */
export function supplyHolds(rule: EdgeRuleContent, a: AtomLite, kinds = false, version = 1): boolean {
  return !isIntrinsic(rule.supply) && sideHolds(rule.supply, a, kinds)
    && (version < 3 || !rule.supply.where.some((p) => namesNothing(p, a)));
}

/**
 * One atom edge, or null: the types and predicates of both sides must hold, and the grade must
 * not be `rejected`. An intrinsic supply is the class of the rule's supply side. An atom never
 * supplies itself (a card can supply its own demand through two atoms, sec. 7.3). `partial`
 * names the unresolved params whose resolution is `partial`, for the gap report (sec. 13.3).
 */
export function matchRule(rule: EdgeRuleContent, supply: AtomLite | IntrinsicClass, demand: AtomLite,
  demandParams: readonly string[], version = 1, kinds = false): { grade: Exclude<Grade, 'rejected'>; unresolved: string[]; partial: string[] } | null {
  if (!sideHolds(rule.demand, demand, kinds)) return null;
  if (isIntrinsic(rule.supply)) {
    if ('params' in supply || supply.id !== sideId(rule.supply)) return null;
  } else {
    if (!('params' in supply) || !supplyHolds(rule, supply, kinds, version) || supply.id === demand.id) return null;
  }
  const res = resolveParams(rule, supply, demand, demandParams, version);
  const g = gradeOf(res);
  if (g.grade === 'rejected') return null;
  return { grade: g.grade, unresolved: g.unresolved, partial: g.unresolved.filter((p) => res.get(p) === 'partial') };
}
