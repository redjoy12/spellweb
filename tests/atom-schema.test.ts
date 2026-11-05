import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/client.js';
import {
  loadAtomSchema, persistAtomSchema, currentSchemaVersion, validateAtomParams,
  sameVocabulary, promotedTypes, mergePromoted, chooseSchemaVersion,
} from '../src/atoms/schema.js';
import type { AtomSchema, AtomTypeDef } from '../src/atoms/schema.js';

/** Minimal fixture type, independent of the real 297-entry config, for isolated persist tests. */
function fixture(
  schemaVersion: number,
  params_schema: Record<string, unknown> = { type: 'object', properties: {}, additionalProperties: false },
  evidence = 'test fixture - not a real atom type',
): AtomSchema {
  return {
    schema_version: schemaVersion,
    types: [{
      family: 'PRODUCES',
      type_key: 'FIXTURE_TYPE',
      label: 'Fixture type',
      params_schema,
      provenance: 'spec_4_1',
      evidence,
    }],
  };
}

describe('atom schema', () => {
  const schema = loadAtomSchema();

  it('covers all six families from spec sec. 4.1', () => {
    const fams = new Set(schema.types.map((t) => t.family));
    for (const f of ['PRODUCES','CARES_ABOUT','ENABLES','COMBAT','INTERACTION','CONSTRAINTS']) {
      expect(fams, `missing family ${f}`).toContain(f);
    }
  });

  it('records provenance and evidence for every type — nothing is authored from memory', () => {
    for (const t of schema.types) {
      expect(['spec_4_1','cr_701','cr_702','review_promoted']).toContain(t.provenance);
      expect(t.evidence.length, `${t.type_key} has no evidence`).toBeGreaterThan(0);
    }
  });

  // sec. 4.2: "A third provenance, `review_promoted`, is never used AT SEEDING TIME; it is added
  // only by the human promotion path in sec. 4.3." v1 was pure seed, so this test could assert the
  // count was zero outright. sec. 4.3 promotion "increments `schema_version`", and the promoted
  // type has nowhere to live but this same generated file - so from v2 on, the file is seed plus
  // promotions and a flat zero would forbid the mechanism the spec requires. The invariant that
  // actually matters is unchanged and is what's asserted instead: the SEED version carries no
  // promotions, and any promotion names sec. 4.3 in its evidence rather than appearing unexplained.
  const SEED_VERSION = 1;
  it('never seeds a type as review_promoted (sec. 4.2)', () => {
    const promoted = schema.types.filter((t) => t.provenance === 'review_promoted');
    if (schema.schema_version === SEED_VERSION) {
      expect(promoted).toHaveLength(0);
      return;
    }
    for (const t of promoted) {
      expect(t.evidence, `${t.family}.${t.type_key} is review_promoted but does not cite sec. 4.3`)
        .toMatch(/sec\. 4\.3/);
    }
  });

  it('has unique type keys within a family', () => {
    const seen = new Set<string>();
    for (const t of schema.types) {
      const id = `${t.family}::${t.type_key}`;
      expect(seen.has(id), `duplicate ${id}`).toBe(false);
      seen.add(id);
    }
  });

  it('persists and reads back at its version', () => {
    const db = openDb(':memory:');
    persistAtomSchema(db, schema);
    expect(currentSchemaVersion(db)).toBe(schema.schema_version);
    const n = db.prepare('SELECT COUNT(*) n FROM atom_types WHERE schema_version = ?')
      .get(schema.schema_version) as { n: number };
    expect(n.n).toBe(schema.types.length);
  });

  it('rejects an unknown atom type', () => {
    const db = openDb(':memory:'); persistAtomSchema(db, schema);
    expect(validateAtomParams(db, schema.schema_version, 'PRODUCES', 'NO_SUCH_TYPE', {}).ok).toBe(false);
  });

  it('rejects a param value outside its enum', () => {
    const db = openDb(':memory:'); persistAtomSchema(db, schema);
    const r = validateAtomParams(db, schema.schema_version, 'CARES_ABOUT', 'CREATURE_DEATH', { controller: 'banana' });
    expect(r.ok).toBe(false);
  });

  it('rejects params that are not a plain object', () => {
    const db = openDb(':memory:'); persistAtomSchema(db, schema);
    for (const bad of [42, [], 'str', null]) {
      expect(validateAtomParams(db, schema.schema_version, 'CARES_ABOUT', 'CREATURE_DEATH', bad).ok).toBe(false);
    }
  });

  // ---- Task 2 fix pass, finding 3: versioning/immutability had zero coverage - every test
  // above opens a fresh :memory: db and persists exactly once, so the `existing.length > 0`
  // branch in persistAtomSchema was never entered by any of them. These persist TWICE against
  // the same schema_version specifically to exercise it. ----

  it('throws when a persisted version\'s params_schema is later changed', () => {
    const db = openDb(':memory:');
    persistAtomSchema(db, fixture(9001));
    const changed = fixture(9001, {
      type: 'object',
      properties: { amount: { type: 'integer' } },
      required: ['amount'],
      additionalProperties: false,
    });
    expect(() => persistAtomSchema(db, changed)).toThrow(/already persisted and differs/);
  });

  it('persists an evidence-only correction to an already-persisted version without throwing', () => {
    const db = openDb(':memory:');
    persistAtomSchema(db, fixture(9002));
    const corrected = fixture(9002, undefined, 'corrected evidence text');
    expect(() => persistAtomSchema(db, corrected)).not.toThrow();
    const row = db
      .prepare('SELECT evidence FROM atom_types WHERE schema_version = ? AND family = ? AND type_key = ?')
      .get(9002, 'PRODUCES', 'FIXTURE_TYPE') as { evidence: string };
    expect(row.evidence).toBe('corrected evidence text');
  });

  it('currentSchemaVersion throws when no schema has been persisted', () => {
    const db = openDb(':memory:');
    expect(() => currentSchemaVersion(db)).toThrow(/No atom schema persisted/);
  });

  // ---- Task 2 fix pass, finding 4: the immutability comparison was key-order sensitive ----

  it('does not throw when params_schema keys are merely reordered (finding 4)', () => {
    const db = openDb(':memory:');
    const original = {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'string' } },
      required: ['a', 'b'],
      additionalProperties: false,
    };
    persistAtomSchema(db, fixture(9003, original));
    const reordered = {
      additionalProperties: false,
      required: ['a', 'b'],
      properties: { b: { type: 'string' }, a: { type: 'integer' } },
      type: 'object',
    };
    expect(() => persistAtomSchema(db, fixture(9003, reordered))).not.toThrow();
  });

  // ---- Task 2 fix pass, finding 5: the add-a-type error named neither the change ----

  it('names the added type in the error message when a type is added at an existing version', () => {
    const db = openDb(':memory:');
    const base = fixture(9004);
    persistAtomSchema(db, base);
    const withAddition: AtomSchema = {
      schema_version: 9004,
      types: [
        ...base.types,
        {
          family: 'PRODUCES',
          type_key: 'FIXTURE_TYPE_2',
          label: 'Second fixture type',
          params_schema: { type: 'object', properties: {}, additionalProperties: false },
          provenance: 'spec_4_1',
          evidence: 'test fixture - not a real atom type',
        },
      ],
    };
    expect(() => persistAtomSchema(db, withAddition)).toThrow(/added: PRODUCES::FIXTURE_TYPE_2/);
  });
});

// ---- Task 9 carry-over: the generator and review promotions share one version sequence ----

const NO_PARAMS = { type: 'object', properties: {}, additionalProperties: false };
const def = (type_key: string, provenance: AtomTypeDef['provenance'] = 'spec_4_1',
             params_schema: Record<string, unknown> = NO_PARAMS): AtomTypeDef =>
  ({ family: 'PRODUCES', type_key, label: type_key, params_schema, provenance, evidence: 'sec. 4.3 test fixture' });

/** What promoteAtomType does: copy version `from` forward to `from + 1` and add one promoted type. */
function promote(db: ReturnType<typeof openDb>, from: number, t: AtomTypeDef): void {
  db.prepare(
    `INSERT INTO atom_types (schema_version, family, type_key, label, params_schema, provenance, evidence)
     SELECT ?, family, type_key, label, params_schema, provenance, evidence FROM atom_types WHERE schema_version = ?`,
  ).run(from + 1, from);
  db.prepare(
    `INSERT INTO atom_types (schema_version, family, type_key, label, params_schema, provenance, evidence)
     VALUES (?,?,?,?,?, 'review_promoted', ?)`,
  ).run(from + 1, t.family, t.type_key, t.label, JSON.stringify(t.params_schema), t.evidence);
}

describe('schema versions shared by the generator and review promotions', () => {
  it('sameVocabulary compares type keys and params, ignoring key order and documentation', () => {
    const db = openDb(':memory:');
    const a = def('A', 'spec_4_1', { type: 'object', properties: {}, additionalProperties: false });
    persistAtomSchema(db, { schema_version: 2, types: [a, def('B')] });
    const reordered = { ...a, label: 'relabelled', params_schema: { additionalProperties: false, properties: {}, type: 'object' } };
    expect(sameVocabulary(db, 2, [def('B'), reordered])).toBe(true);
    expect(sameVocabulary(db, 2, [a])).toBe(false);
    expect(sameVocabulary(db, 2, [a, def('C')])).toBe(false);
    expect(sameVocabulary(db, 2, [a, def('B', 'spec_4_1', { type: 'object' })])).toBe(false);
  });

  it('promotedTypes returns only the current version\'s promotions', () => {
    const db = openDb(':memory:');
    persistAtomSchema(db, { schema_version: 2, types: [def('A')] });
    expect(promotedTypes(db)).toEqual([]);
    promote(db, 2, def('P', 'review_promoted', { type: 'object' }));
    expect(promotedTypes(db).map((t) => [t.type_key, t.provenance, t.params_schema]))
      .toEqual([['P', 'review_promoted', { type: 'object' }]]);
  });

  it('mergePromoted appends promotions from every source once, sorted, and ignores non-promoted rows', () => {
    const gen = [def('A'), def('B')];
    const merged = mergePromoted(gen, [def('Z', 'review_promoted'), def('M', 'review_promoted')],
                                 [def('M', 'review_promoted'), def('A'), def('OLD_SEED')]);
    expect(merged.map((t) => t.type_key)).toEqual(['A', 'B', 'M', 'Z']);
  });

  it('mergePromoted throws when a promotion is now generated, or two sources disagree on its params', () => {
    expect(() => mergePromoted([def('A')], [def('A', 'review_promoted')]))
      .toThrow(/PRODUCES::A is now also generated/);
    expect(() => mergePromoted([], [def('P', 'review_promoted')], [def('P', 'review_promoted', { type: 'object' })]))
      .toThrow(/different params/);
  });

  it('mergePromoted keeps a promotion the generator itself carries (same params) once, without throwing', () => {
    // CARES_ABOUT.LEAVES_BATTLEFIELD is a v2 promotion baked into the generator's spec types; the database and the
    // committed config also hold it. Before Task 11 this threw, so the generator could not run at all.
    const baked = def('L', 'review_promoted');
    expect(mergePromoted([def('A'), baked], [def('L', 'review_promoted')], [def('L', 'review_promoted')])
      .map((t) => t.type_key)).toEqual(['A', 'L']);
    expect(() => mergePromoted([baked], [def('L', 'review_promoted', { type: 'object' })]))
      .toThrow(/different params/);
  });

  it('chooseSchemaVersion: floor on an empty database, current when unchanged, next when changed', () => {
    const db = openDb(':memory:');
    expect(chooseSchemaVersion(db, [def('A')], 2)).toBe(2);
    persistAtomSchema(db, { schema_version: 2, types: [def('A')] });
    expect(chooseSchemaVersion(db, [def('A')], 2)).toBe(2);
    expect(chooseSchemaVersion(db, [def('A'), def('B')], 2)).toBe(3);
    expect(chooseSchemaVersion(db, [def('A'), def('B')], 7)).toBe(7);
  });

  it('a promotion then a generator re-run neither collides nor bumps; a real vocabulary change goes above it', () => {
    const db = openDb(':memory:');
    persistAtomSchema(db, { schema_version: 2, types: [def('A')] });
    promote(db, 2, def('P', 'review_promoted'));                     // the review queue takes v3

    const rerun = mergePromoted([def('A')], promotedTypes(db), []);
    const v = chooseSchemaVersion(db, rerun, 2);
    expect(v).toBe(3);                                               // unchanged: a no-op, not v4
    expect(() => persistAtomSchema(db, { schema_version: v, types: rerun })).not.toThrow();

    const grown = mergePromoted([def('A'), def('B')], promotedTypes(db), []);
    const next = chooseSchemaVersion(db, grown, 2);
    expect(next).toBe(4);                                            // never the promotion's v3
    persistAtomSchema(db, { schema_version: next, types: grown });
    expect(currentSchemaVersion(db)).toBe(4);
    expect(promotedTypes(db).map((t) => t.type_key)).toEqual(['P']); // the promotion survived
  });
});

describe('the committed vocabulary holds the Task 11 promotions (Task 12 precondition: a stable schema)', () => {
  const schema = loadAtomSchema();
  const has = (family: string, key: string) => schema.types.some((t) => t.family === family && t.type_key === key);

  it.each([
    ['ENABLES', 'PREPARED'], ['CONSTRAINTS', 'ENTERS_TAPPED'], ['CARES_ABOUT', 'UNLOCK'], ['COMBAT', 'STAT_CHANGE'],
    ['PRODUCES', 'LIFE_LOSS'], ['CARES_ABOUT', 'COMBAT_DAMAGE_TO_PLAYER'], ['COMBAT', 'BASE_PT_SET'],
  ])('%s %s is in config/atom-schema.json, as review_promoted', (family, key) => {
    expect(has(family, key)).toBe(true);
    expect(schema.types.find((t) => t.type_key === key)!.provenance).toBe('review_promoted');
  });

  it('CR 701.70 Recruit has a generated type (PRODUCES: draws, discards and may create a token)', () => {
    const t = schema.types.find((x) => x.type_key === 'RECRUIT');
    expect(t).toMatchObject({ family: 'PRODUCES', provenance: 'cr_701' });
  });
});
