/**
 * The answer shapes of the edge-rule deriver and the canonical rule hash (Phase 3 spec sec. 5.1,
 * 5.3, plan Task 3).
 *
 * The zod schemas check the SHAPE of an answer only. Whether a type, a param, an enum value, a
 * resource or a quote is permitted is the job of `ruleValidate.ts` (spec sec. 5.4): a shape error
 * fails the whole response, a validation error rejects one item.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { IntrinsicKind } from './intrinsic.js';
import { canonicalJson } from './policy.js';
import type { Evidence } from './quotes.js';

export type Op = 'eq' | 'in' | 'overlaps' | 'disjoint';
export const OPS: readonly Op[] = ['eq', 'in', 'overlaps', 'disjoint'];
export const ROLES = ['supply', 'demand', 'both', 'none'] as const;
export type Role = typeof ROLES[number];

export interface Predicate { param: string; op: Op; value: unknown }
export interface TypeSide { family: string; type_key: string; where: Predicate[] }
export interface IntrinsicSide { intrinsic: IntrinsicKind; value: string | number }
export type SupplySide = TypeSide | IntrinsicSide;
export interface Implication { demand_param: string; value: unknown; evidence: Evidence[] }

export interface EdgeRuleContent {
  polarity: '+' | '-';
  supply: SupplySide;
  demand: TypeSide;
  param_links: Array<{ supply: string; demand: string }>;
  implications: Implication[];
}
export interface EdgeRuleItem extends EdgeRuleContent { evidence: Evidence[] }

export interface ResourceEffect {
  resource: string;
  sign: '+' | '-';
  kind: 'cost' | 'value';
  /** Required when `resource` is 'other' (spec sec. 5.3). */
  note?: string;
  evidence: Evidence[];
}
export interface RoleItem {
  family: string;
  type_key: string;
  role: Role;
  demand_note?: string;
  resources: ResourceEffect[];
  evidence: Evidence[];
}
export interface MissingRule { needed: string; rationale: string }

export const EvidenceZ = z.object({
  source: z.enum(['rule', 'glossary']),
  ref: z.string().min(1),
  quote: z.string().min(1),
}).strict();

const PredicateZ = z.object({ param: z.string().min(1), op: z.enum(['eq', 'in', 'overlaps', 'disjoint']), value: z.unknown() }).strict();
const TypeSideZ = z.object({ family: z.string().min(1), type_key: z.string().min(1), where: z.array(PredicateZ) }).strict();
// An intrinsic class has no params. An empty `where` is accepted and dropped, so that one
// extra field does not fail the whole response.
const IntrinsicSideZ = z.object({
  intrinsic: z.enum(['card_type', 'subtype', 'mana_value', 'color_identity']),
  value: z.union([z.string().min(1), z.number()]),
  where: z.array(PredicateZ).length(0).optional(),
}).strict().transform(({ intrinsic, value }) => ({ intrinsic, value }));

/** A free-text note: absent, null or a string. Null becomes absent. */
const NoteZ = z.string().nullish().transform((v) => v ?? undefined);

export const EdgeRuleItemZ = z.object({
  polarity: z.enum(['+', '-']),
  supply: z.union([TypeSideZ, IntrinsicSideZ]),
  demand: TypeSideZ,
  param_links: z.array(z.object({ supply: z.string().min(1), demand: z.string().min(1) }).strict()),
  implications: z.array(z.object({ demand_param: z.string().min(1), value: z.unknown(), evidence: z.array(EvidenceZ) }).strict()),
  evidence: z.array(EvidenceZ),
}).strict();

export const RoleItemZ = z.object({
  family: z.string().min(1),
  type_key: z.string().min(1),
  role: z.enum(ROLES),
  demand_note: NoteZ,
  resources: z.array(z.object({
    resource: z.string().min(1),
    sign: z.enum(['+', '-']),
    kind: z.enum(['cost', 'value']),
    note: NoteZ,
    evidence: z.array(EvidenceZ),
  }).strict()),
  evidence: z.array(EvidenceZ),
}).strict();

export const MissingRuleZ = z.object({ needed: z.string().min(1), rationale: z.string().min(1) }).strict();

export const RolesResponse = z.object({ roles: z.array(RoleItemZ), missing_rules: z.array(MissingRuleZ) }).strict();
export const PairsResponse = z.object({ rules: z.array(EdgeRuleItemZ), missing_rules: z.array(MissingRuleZ) }).strict();

export function isIntrinsic(s: SupplySide): s is IntrinsicSide {
  return 'intrinsic' in s;
}

/** `FAMILY.TYPE_KEY` of a type side, or `INTRINSIC.<kind>(<value>)` of a class (spec sec. 6.1). */
export function sideId(s: SupplySide): string {
  return isIntrinsic(s) ? `INTRINSIC.${s.intrinsic}(${String(s.value)})` : `${s.family}.${s.type_key}`;
}

/** A value list whose order and repeats have no meaning: `in`, `overlaps` and `disjoint` compare sets. */
function setValue(op: Op, value: unknown): unknown {
  if (op === 'eq' || !Array.isArray(value)) return value;
  const unique = [...new Map(value.map((v) => [canonicalJson(v), v])).values()];
  return unique.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

function byJson<T>(xs: T[]): T[] {
  return [...xs].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

function canonicalSide<S extends SupplySide>(s: S): S {
  if (isIntrinsic(s)) return { intrinsic: s.intrinsic, value: s.value } as S;
  return {
    family: s.family, type_key: s.type_key,
    where: byJson(s.where.map((p) => ({ param: p.param, op: p.op, value: setValue(p.op, p.value) }))),
  } as S;
}

/**
 * The rule content in one fixed form: no evidence (also none inside the implications), the
 * predicates, links and implications sorted, and the value lists of the set operators sorted.
 */
export function canonicalRule(r: EdgeRuleContent): EdgeRuleContent {
  return {
    polarity: r.polarity,
    supply: canonicalSide(r.supply),
    demand: canonicalSide(r.demand),
    param_links: byJson(r.param_links.map((l) => ({ supply: l.supply, demand: l.demand }))),
    implications: byJson(r.implications.map((i) => ({ demand_param: i.demand_param, value: i.value, evidence: [] }))),
  };
}

/** spec sec. 5.1: the SHA of the canonical JSON of the rule content. Evidence is excluded. */
export function ruleHash(r: EdgeRuleContent): string {
  return createHash('sha256').update(canonicalJson(canonicalRule(r)), 'utf8').digest('hex');
}

/** The evidence key for a union of verified quotes (spec sec. 5.3). */
export function evidenceKey(e: Evidence): string {
  return `${e.source}|${e.ref}|${e.quote}`;
}

/** The union of evidence lists, first occurrence first, no repeats. */
export function unionEvidence(...lists: Evidence[][]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const l of lists) {
    for (const e of l) {
      const k = evidenceKey(e);
      if (!seen.has(k)) { seen.add(k); out.push(e); }
    }
  }
  return out;
}
