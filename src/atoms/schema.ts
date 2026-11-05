import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA = resolve(here, '../../config/atom-schema.json');

export type AtomFamily =
  | 'PRODUCES' | 'CARES_ABOUT' | 'ENABLES' | 'COMBAT' | 'INTERACTION' | 'CONSTRAINTS';

export interface AtomTypeDef {
  family: AtomFamily;
  type_key: string;
  label: string;
  params_schema: Record<string, unknown>;
  provenance: 'spec_4_1' | 'cr_701' | 'cr_702' | 'review_promoted';
  evidence: string;
}

export interface AtomSchema {
  schema_version: number;
  types: AtomTypeDef[];
}

export function loadAtomSchema(path: string = DEFAULT_SCHEMA): AtomSchema {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return {
    schema_version: raw['schema_version'] as number,
    types: raw['types'] as AtomTypeDef[],
  };
}

/**
 * Deterministic stringify with object keys sorted at every level (Task 2 fix pass, finding 4).
 * Used only to compare two params_schema values for semantic equality - never for what's
 * written to the database, which keeps whatever key order the source object had.
 */
function canonicalJSON(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sortKeys((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

/**
 * Idempotent for an unchanged config. A persisted version is IMMUTABLE with respect to
 * `params_schema`: `atoms` and `golden_atoms` both FK to (schema_version, family, type_key),
 * so silently rewriting a version's params_schema would retroactively change what
 * already-validated atoms were checked against. Changing the vocabulary means a new
 * version (sec. 4.3), not an edit - that half is enforced by throwing.
 *
 * `label`, `provenance` and `evidence` are documentation, not validation surface - nothing
 * downstream keys on their exact text the way `validateAtomParams` keys on `params_schema`.
 * A typo fix in `evidence` must still land in the database, so those columns ARE refreshed
 * via upsert even when a version already has rows, as long as no `params_schema` differs.
 */
export function persistAtomSchema(db: DatabaseSync, schema: AtomSchema): void {
  const existing = db
    .prepare('SELECT family, type_key, params_schema FROM atom_types WHERE schema_version = ?')
    .all(schema.schema_version) as Array<{ family: string; type_key: string; params_schema: string }>;
  if (existing.length > 0) {
    // Compared with a sorted-key replacer (Task 2 fix pass, finding 4): plain JSON.stringify
    // is byte-wise, so a params_schema that's semantically unchanged but has its keys emitted
    // in a different order (a prettier run, a codegen rerun) would otherwise trip this guard
    // and tell the operator to bump the version for a no-op edit. Canonicalizing both sides
    // makes the comparison care about content, not serialization order.
    const before = new Map(existing.map((r) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.params_schema);
      } catch (err) {
        // Task 2 fix pass 2, Minor finding 4: a bare JSON.parse here surfaces as an
        // uncontextualized SyntaxError from inside persistAtomSchema, naming neither the
        // row nor why persistAtomSchema was even parsing it. Name the offending row instead.
        throw new Error(
          `corrupt params_schema JSON for already-persisted atom type ` +
          `(family=${r.family}, type_key=${r.type_key}, schema_version=${schema.schema_version}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return [`${r.family}::${r.type_key}`, canonicalJSON(parsed)];
    }));
    const after = new Map(schema.types.map((t) => [`${t.family}::${t.type_key}`, canonicalJSON(t.params_schema)]));
    const changed = [...after].filter(([k, v]) => before.has(k) && before.get(k) !== v).map(([k]) => k);
    const removed = [...before.keys()].filter((k) => !after.has(k));
    const added = [...after.keys()].filter((k) => !before.has(k)); // Task 2 fix pass, finding 5
    if (changed.length || removed.length || added.length) {
      throw new Error(
        `atom schema v${schema.schema_version} is already persisted and differs ` +
        `(changed: ${changed.join(', ') || 'none'}; removed: ${removed.join(', ') || 'none'}; ` +
        `added: ${added.join(', ') || 'none'}). ` +
        `Bump schema_version instead of editing a published version.`,
      );
    }
    // params_schema is identical for every type - fall through to the upsert below so that
    // any label/provenance/evidence correction still reaches the database instead of being
    // silently dropped.
  }
  db.exec('BEGIN');
  try {
    const ins = db.prepare(
      `INSERT INTO atom_types (schema_version, family, type_key, label, params_schema, provenance, evidence)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(schema_version, family, type_key) DO UPDATE SET
         label = excluded.label, params_schema = excluded.params_schema,
         provenance = excluded.provenance, evidence = excluded.evidence`,
    );
    for (const t of schema.types) {
      ins.run(schema.schema_version, t.family, t.type_key, t.label,
              JSON.stringify(t.params_schema), t.provenance, t.evidence);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const typeId = (t: { family: string; type_key: string }) => `${t.family}::${t.type_key}`;

/**
 * True when `types` is exactly the vocabulary persisted at `version`: the same family::type_key
 * set with the same params_schema (canonical JSON, so key order does not matter). Label,
 * provenance and evidence are documentation and are not compared - the same rule as
 * persistAtomSchema's immutability check.
 */
export function sameVocabulary(db: DatabaseSync, version: number, types: readonly AtomTypeDef[]): boolean {
  const rows = db.prepare('SELECT family, type_key, params_schema FROM atom_types WHERE schema_version = ?')
    .all(version) as Array<{ family: string; type_key: string; params_schema: string }>;
  if (rows.length !== types.length) return false;
  const persisted = new Map(rows.map((r) => [typeId(r), canonicalJSON(JSON.parse(r.params_schema))]));
  return types.every((t) => persisted.get(typeId(t)) === canonicalJSON(t.params_schema));
}

/**
 * The types the review queue promoted (sec. 4.3, `promoteAtomType`). Promotion copies the whole
 * vocabulary forward, so the current version holds every one of them.
 */
export function promotedTypes(db: DatabaseSync): AtomTypeDef[] {
  const v = (db.prepare('SELECT MAX(schema_version) v FROM atom_types').get() as { v: number | null }).v;
  if (v === null) return [];
  return (db.prepare(
    `SELECT family, type_key, label, params_schema, provenance, evidence FROM atom_types
      WHERE schema_version = ? AND provenance = 'review_promoted' ORDER BY family, type_key`,
  ).all(v) as Array<Omit<AtomTypeDef, 'params_schema'> & { params_schema: string }>)
    .map((r) => ({ ...r, params_schema: JSON.parse(r.params_schema) as Record<string, unknown> }));
}

/**
 * Generated vocabulary + review promotions, for `generate:atom-schema`. Promotions come from
 * every source given (the database, and the committed config so a fresh checkout keeps them);
 * the same promotion in two sources must agree on params, and a promotion may not reuse a key
 * the generator now produces itself - both are conflicts a human has to settle, so they throw.
 */
export function mergePromoted(generated: readonly AtomTypeDef[], ...sources: ReadonlyArray<readonly AtomTypeDef[]>): AtomTypeDef[] {
  const own = new Map(generated.map((t) => [typeId(t), t]));
  const promoted = new Map<string, AtomTypeDef>();
  for (const t of sources.flat()) {
    if (t.provenance !== 'review_promoted') continue;
    const id = typeId(t);
    const gen = own.get(id);
    if (gen) {
      // A promotion the generator itself carries (as LEAVES_BATTLEFIELD is) is the same type, not a collision.
      if (gen.provenance === 'review_promoted' && canonicalJSON(gen.params_schema) === canonicalJSON(t.params_schema)) continue;
      if (gen.provenance === 'review_promoted') {
        throw new Error(`promoted type ${id} has different params in the generator and the database or committed config`);
      }
      throw new Error(`promoted type ${id} is now also generated - remove the promotion or rename one of them`);
    }
    const seen = promoted.get(id);
    if (seen && canonicalJSON(seen.params_schema) !== canonicalJSON(t.params_schema)) {
      throw new Error(`promoted type ${id} has different params in the database and the committed config`);
    }
    if (!seen) promoted.set(id, t);
  }
  return [...generated, ...[...promoted.values()].sort((a, b) => typeId(a).localeCompare(typeId(b)))];
}

/**
 * The version a generated vocabulary is published as. Unchanged from the database's current
 * version -> that version (re-running the generator is a no-op). Changed -> the next version
 * above it, never a hard-coded number: a review promotion may already have taken the number
 * the generator would have picked. `floor` is the generator's own minimum (its frozen history).
 */
export function chooseSchemaVersion(db: DatabaseSync, types: readonly AtomTypeDef[], floor: number): number {
  const v = (db.prepare('SELECT MAX(schema_version) v FROM atom_types').get() as { v: number | null }).v;
  if (v === null) return floor;
  if (sameVocabulary(db, v, types)) return v;
  return Math.max(floor, v + 1);
}

/** The label of each type ("FAMILY.TYPE_KEY") in the latest schema version that has the type. */
export function latestLabels(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare('SELECT family, type_key, label FROM atom_types ORDER BY schema_version').all() as Array<{ family: string; type_key: string; label: string }>;
  return new Map(rows.map((r) => [`${r.family}.${r.type_key}`, r.label]));
}

export function currentSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(schema_version) v FROM atom_types').get() as { v: number | null };
  if (row.v === null) throw new Error('No atom schema persisted - run the Task 2 seed first');
  return row.v;
}

export function validateAtomParams(
  db: DatabaseSync,
  schemaVersion: number,
  family: string,
  typeKey: string,
  params: unknown,
): { ok: true } | { ok: false; error: string } {
  const row = db
    .prepare('SELECT params_schema FROM atom_types WHERE schema_version = ? AND family = ? AND type_key = ?')
    .get(schemaVersion, family, typeKey) as { params_schema: string } | undefined;
  if (!row) return { ok: false, error: `unknown atom type ${family}.${typeKey} at v${schemaVersion}` };

  type PropSpec = { enum?: unknown[]; type?: string | string[]; items?: { enum?: unknown[]; type?: string } };
  const spec = JSON.parse(row.params_schema) as {
    properties?: Record<string, PropSpec>;
    required?: string[];
    additionalProperties?: boolean;
  };

  // params must be a plain object. An array, a number or a string would otherwise
  // pass every check below and produce a nonsensical "unexpected param 0".
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, error: `params must be an object, got ${Array.isArray(params) ? 'array' : typeof params}` };
  }
  const value = params as Record<string, unknown>;

  for (const key of spec.required ?? []) {
    if (!(key in value)) return { ok: false, error: `missing required param "${key}"` };
  }
  if (spec.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in (spec.properties ?? {}))) return { ok: false, error: `unexpected param "${key}"` };
    }
  }

  const typeOk = (v: unknown, t: string): boolean =>
    t === 'integer' ? Number.isInteger(v)
    : t === 'number' ? typeof v === 'number'
    : t === 'string' ? typeof v === 'string'
    : t === 'boolean' ? typeof v === 'boolean'
    : t === 'null' ? v === null
    : t === 'array' ? Array.isArray(v)
    : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v)
    : false;

  for (const [key, propSpec] of Object.entries(spec.properties ?? {})) {
    if (!(key in value)) continue;
    const v = value[key];
    if (propSpec.enum && !propSpec.enum.includes(v)) {
      return { ok: false, error: `param "${key}" = ${JSON.stringify(v)} is not one of ${JSON.stringify(propSpec.enum)}` };
    }
    if (propSpec.type) {
      const types = Array.isArray(propSpec.type) ? propSpec.type : [propSpec.type];
      if (!types.some((t) => typeOk(v, t))) {
        return { ok: false, error: `param "${key}" is not of type ${types.join('|')}` };
      }
    }
    // Array items (schema v15 token_types and subtypes; the SPELL_CAST card-type lists).
    if (propSpec.items && Array.isArray(v)) {
      const { enum: allowed, type: itemType } = propSpec.items;
      const bad = v.find((x) => (allowed && !allowed.includes(x)) || (itemType && !typeOk(x, itemType)));
      if (bad !== undefined) {
        return { ok: false, error: `param "${key}" has an item ${JSON.stringify(bad)} that is not ${allowed ? `one of ${JSON.stringify(allowed)}` : `of type ${itemType}`}` };
      }
    }
  }
  return { ok: true };
}
