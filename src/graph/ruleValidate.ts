/**
 * The item checks of Phase 3 spec sec. 5.4 for the edge-rule deriver (plan Task 3).
 *
 * Each check rejects one item with one cause. The checks run in the order of sec. 5.4: types
 * (check 1), intrinsic classes (check 6), params and enum values (check 2), evidence present
 * (check 3), quotes (checks 4 and 5, through `checkEvidence`), resource names (check 7).
 * The code makes no model call and knows no Magic: every permitted value comes from schema v14,
 * from CR text or from the scope cards.
 */
import type { DatabaseSync } from 'node:sqlite';
import { typeEntries } from './crContent.js';
import { INTRINSIC_KINDS, permittedIntrinsicValues, type IntrinsicKind, type Scope } from './intrinsic.js';
import { checkEvidence, type Evidence } from './quotes.js';
import { isIntrinsic, type EdgeRuleItem, type IntrinsicSide, type Op, type Predicate, type RoleItem } from './ruleSchema.js';

export type RejectCause = 'unknown_type' | 'unknown_param' | 'unknown_enum' | 'no_evidence'
                        | 'not_verbatim' | 'not_in_packet' | 'unknown_ref' | 'unknown_resource' | 'bad_intrinsic';

/** The JSON schema of one param, as `atom_types.params_schema` stores it. */
export interface ParamSchema { enum?: unknown[]; type?: string | string[]; items?: ParamSchema }

export interface ValidateContext {
  corpusId: number;
  /** All types of the schema version: FAMILY.TYPE_KEY -> params. */
  types: ReadonlyMap<string, Record<string, ParamSchema>>;
  /** The types that the packet shows. A type outside it is `unknown_type` for this batch. */
  packetTypes: ReadonlySet<string>;
  /** Stage B: the demand type of the batch. A rule for a different demand type is `unknown_type`. */
  demand?: string;
  /** Plan D16: the exact rule numbers and `glossary:<term>` keys of the packet. */
  refs: ReadonlySet<string>;
  /** The closed resource list of the graph policy, with 'other' (spec sec. 5.3). */
  resources: readonly string[];
  intrinsic: Record<IntrinsicKind, Array<string | number>>;
}

/** The type map of a schema version, for `ValidateContext.types`. */
export function schemaTypes(db: DatabaseSync, schemaVersion: number): Map<string, Record<string, ParamSchema>> {
  return new Map(typeEntries(db, schemaVersion).map((e) => [
    `${e.family}.${e.type_key}`,
    ((e.params_schema as { properties?: Record<string, ParamSchema> }).properties ?? {}),
  ]));
}

/** The parts of a context that do not depend on the batch. */
export function baseContext(
  db: DatabaseSync, o: { corpusId: number; schemaVersion: number; scope: Scope; resources: readonly string[] },
): Omit<ValidateContext, 'packetTypes' | 'refs' | 'demand'> {
  return {
    corpusId: o.corpusId,
    types: schemaTypes(db, o.schemaVersion),
    resources: o.resources,
    intrinsic: permittedIntrinsicValues(db, o.corpusId, o.scope),
  };
}

const isObj = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One scalar against a param schema: the enum when it has one, else the JSON type. */
function scalarFits(s: ParamSchema, v: unknown): boolean {
  if (s.enum) return s.enum.some((e) => e === v);
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  if (types.length === 0) return !isObj(v) && !Array.isArray(v);
  return types.some((t) => (t === 'integer' ? Number.isInteger(v)
    : t === 'number' ? typeof v === 'number'
      : t === 'string' ? typeof v === 'string'
        : t === 'boolean' ? typeof v === 'boolean' : false));
}

/** A value that the param can have: an array of fitting items for an array param. */
export function valueFits(s: ParamSchema, v: unknown): boolean {
  if (s.type === 'array') return Array.isArray(v) && v.every((x) => scalarFits(s.items ?? {}, x));
  return scalarFits(s, v);
}

/**
 * spec sec. 5.1, the operators: `overlaps` and `disjoint` need an array param and an array
 * value; `in` needs a non-empty list of values the param can have; `eq` one such value.
 * An operator that the param cannot take is an `unknown_param`; a value outside the schema is
 * an `unknown_enum`.
 */
function predicateCause(params: Record<string, ParamSchema>, p: Predicate): RejectCause | null {
  const s = params[p.param];
  if (!s) return 'unknown_param';
  const isArrayParam = s.type === 'array';
  const setOp = (op: Op) => op === 'overlaps' || op === 'disjoint';
  if (setOp(p.op) !== isArrayParam) return 'unknown_param';
  if (p.op === 'eq') return valueFits(s, p.value) ? null : 'unknown_enum';
  if (p.op === 'in') {
    return Array.isArray(p.value) && p.value.length > 0 && p.value.every((v) => valueFits(s, v)) ? null : 'unknown_enum';
  }
  return valueFits(s, p.value) ? null : 'unknown_enum';
}

/** The JSON types of a scalar param schema; an enum gives the types of its values. */
function scalarTypes(s: ParamSchema): Set<string> {
  if (s.enum) return new Set(s.enum.map((v) => (Number.isInteger(v) ? 'integer' : typeof v)));
  const t = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  return new Set(t.flatMap((x) => (x === 'number' ? ['number', 'integer'] : [x])));
}

/**
 * spec sec. 5.1: a link pairs a supply param and a demand param that must agree. The two params
 * must be able to have the same value: two enums need a common value; otherwise the JSON types
 * must meet. An array param links by its items, to an array param or to a scalar param: the
 * matcher (match.ts `agreement`) reads a scalar as a one-value array, so a token's
 * `token_types` can link to `permanent_type`.
 */
export function linkCompatible(a: ParamSchema, b: ParamSchema): boolean {
  const x = a.type === 'array' ? a.items ?? {} : a;
  const y = b.type === 'array' ? b.items ?? {} : b;
  if (x.enum && y.enum) return x.enum.some((v) => y.enum!.includes(v));
  const tx = scalarTypes(x);
  return [...scalarTypes(y)].some((t) => tx.has(t));
}

/** The permitted spelling of an intrinsic value (spec sec. 6.1), or null when it is not permitted. */
export function canonicalIntrinsic(ctx: Pick<ValidateContext, 'intrinsic'>, s: IntrinsicSide): string | number | null {
  if (!INTRINSIC_KINDS.includes(s.intrinsic)) return null;
  const values = ctx.intrinsic[s.intrinsic];
  if (s.intrinsic === 'mana_value') {
    return typeof s.value === 'number' && values.includes(s.value) ? s.value : null;
  }
  // Card types and subtypes are compared without case, as class membership is (sec. 6.1).
  const want = String(s.value).toLowerCase();
  return values.find((v) => String(v).toLowerCase() === want) ?? null;
}

function evidenceCause(db: DatabaseSync, ctx: ValidateContext, evidence: Evidence[]): RejectCause | null {
  if (evidence.length === 0) return 'no_evidence';
  for (const e of evidence) {
    const f = checkEvidence(db, ctx.corpusId, e, ctx.refs);
    if (f) return f;
  }
  return null;
}

/** spec sec. 5.4 for one Stage A item: type, evidence, resource names, and the evidence of each effect. */
export function validateRole(db: DatabaseSync, ctx: ValidateContext, item: RoleItem): RejectCause | null {
  const id = `${item.family}.${item.type_key}`;
  if (!ctx.types.has(id) || !ctx.packetTypes.has(id)) return 'unknown_type';
  const own = evidenceCause(db, ctx, item.evidence);
  if (own) return own;
  for (const r of item.resources) {
    const c = evidenceCause(db, ctx, r.evidence);
    if (c) return c;
  }
  for (const r of item.resources) {
    if (!ctx.resources.includes(r.resource)) return 'unknown_resource';
    if (r.resource === 'other' && !r.note?.trim()) return 'unknown_resource';
  }
  return null;
}

/** spec sec. 5.4 for one Stage B rule, its predicates, its links and its implications. */
export function validateRule(db: DatabaseSync, ctx: ValidateContext, item: EdgeRuleItem): RejectCause | null {
  // Check 1: the types are in the schema and in this packet; the demand is the batch demand.
  const demandId = `${item.demand.family}.${item.demand.type_key}`;
  if (!ctx.types.has(demandId) || !ctx.packetTypes.has(demandId)) return 'unknown_type';
  if (ctx.demand !== undefined && demandId !== ctx.demand) return 'unknown_type';
  let supplyParams: Record<string, ParamSchema> = {};
  if (isIntrinsic(item.supply)) {
    // Check 6: the class kind and value are in the permitted sets of sec. 6.1.
    if (canonicalIntrinsic(ctx, item.supply) === null) return 'bad_intrinsic';
  } else {
    const supplyId = `${item.supply.family}.${item.supply.type_key}`;
    if (!ctx.types.has(supplyId) || !ctx.packetTypes.has(supplyId)) return 'unknown_type';
    supplyParams = ctx.types.get(supplyId)!;
  }
  const demandParams = ctx.types.get(demandId)!;

  // Check 2: predicates, links and implications refer to params and values of the schema.
  // An intrinsic class has no params, so it can have no predicate and no link.
  if (!isIntrinsic(item.supply)) {
    for (const p of item.supply.where) {
      const c = predicateCause(supplyParams, p);
      if (c) return c;
    }
  }
  for (const p of item.demand.where) {
    const c = predicateCause(demandParams, p);
    if (c) return c;
  }
  for (const l of item.param_links) {
    const a = supplyParams[l.supply];
    const b = demandParams[l.demand];
    if (!a || !b || !linkCompatible(a, b)) return 'unknown_param';
  }
  for (const i of item.implications) {
    const s = demandParams[i.demand_param];
    if (!s) return 'unknown_param';
    if (!valueFits(s, i.value)) return 'unknown_enum';
  }

  // Checks 3-5: the rule evidence, then the evidence of each implication, the same way.
  const own = evidenceCause(db, ctx, item.evidence);
  if (own) return own;
  for (const i of item.implications) {
    const c = evidenceCause(db, ctx, i.evidence);
    if (c) return c;
  }
  return null;
}
