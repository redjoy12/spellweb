import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyV15, V15_MARK, V15_TYPE_KEYS, zonesFrom400_1 } from '../src/atoms/schemaV15.js';
import { V18_REMOVED } from '../src/atoms/schemaV18.js';
import type { V15Enums } from '../src/atoms/schemaV15.js';
import { persistAtomSchema, validateAtomParams } from '../src/atoms/schema.js';
import type { AtomTypeDef } from '../src/atoms/schema.js';
import { validateResponse, renderAtomTypes } from '../src/atoms/extract.js';
import { fixtureWithClauses } from './helpers/fixture.js';

// Schema v15 (spec sec. 20, plan docs/superpowers/plans/2026-10-18-schema-v15.md, Task 1).

const ENUMS: V15Enums = {
  permanentTypes: ['artifact', 'creature', 'any'],
  cardTypes: ['artifact', 'creature', 'instant'],
  zones: ['library', 'hand', 'battlefield', 'graveyard', 'stack', 'exile', 'command'],
};
const EMPTY = { type: 'object', properties: {}, additionalProperties: false };
const def = (family: AtomTypeDef['family'], type_key: string): AtomTypeDef =>
  ({ family, type_key, label: type_key, params_schema: EMPTY, provenance: 'spec_4_1', evidence: 'e' });

describe('zonesFrom400_1', () => {
  it('reads the seven zones of CR 400.1', () => {
    const text = 'A zone is a place where objects can be during a game. There are normally seven zones: library, hand, battlefield, graveyard, stack, exile, and command. Some older cards also use the ante zone.';
    expect(zonesFrom400_1(text)).toEqual(ENUMS.zones);
  });
  it('throws when the sentence changes', () => {
    expect(() => zonesFrom400_1('No zones here.')).toThrow(/zone rule/);
  });
});

describe('applyV15', () => {
  it('replaces the params of an item type, adds its source once, and leaves other types alone', () => {
    const once = applyV15([def('ENABLES', 'DOUBLE'), def('PRODUCES', 'CARD_DRAW')], ENUMS);
    const twice = applyV15(once, ENUMS);
    expect(twice).toEqual(once);
    expect(once[0]!.params_schema).toMatchObject({ required: ['object'] });
    expect(once[0]!.evidence.split(V15_MARK)).toHaveLength(2);
    expect(once[0]!.evidence).toContain('CR 701.10');
    expect(once[1]).toEqual(def('PRODUCES', 'CARD_DRAW'));
  });
  it('throws with requireAll when an item names a type the vocabulary does not have', () => {
    expect(() => applyV15([def('ENABLES', 'DOUBLE')], ENUMS, { requireAll: true })).toThrow(/not in the vocabulary/);
  });
  it('every item cites a CR rule or a project_decision (invariant I1)', () => {
    const all = applyV15(V15_TYPE_KEYS.map((k) => def(k.split('.')[0] as AtomTypeDef['family'], k.split('.')[1]!)), ENUMS, { requireAll: true });
    for (const t of all) expect(t.evidence, `${t.family}.${t.type_key}`).toMatch(/CR \d{3}|project_decision|COMBAT\.STAT_CHANGE|PRODUCES\.CREATE/);
  });
  it('the ENTERS_BATTLEFIELD origin zone leaves out the battlefield and adds any', () => {
    const [t] = applyV15([def('CARES_ABOUT', 'ENTERS_BATTLEFIELD')], ENUMS);
    const zone = (t!.params_schema as { properties: { origin_zone: { enum: string[] } } }).properties.origin_zone.enum;
    expect(zone).toEqual(['library', 'hand', 'graveyard', 'stack', 'exile', 'command', 'any']);
  });
  it('the committed config is at v15 or later and carries every item', () => {
    const schema = JSON.parse(readFileSync('config/atom-schema.json', 'utf8')) as { schema_version: number; types: AtomTypeDef[] };
    expect(schema.schema_version).toBeGreaterThanOrEqual(15);
    // A later schema can remove a type (spec sec. 23 items B2, B3).
    for (const k of V15_TYPE_KEYS.filter((x) => !V18_REMOVED.some((r) => r.type === x))) {
      const t = schema.types.find((x) => `${x.family}.${x.type_key}` === k);
      expect(t?.evidence, k).toContain(V15_MARK);
    }
  });
});

function v15Db(text: string) {
  const db = fixtureWithClauses(text);
  const types = applyV15([
    def('PRODUCES', 'CREATE'), def('PRODUCES', 'TOKENS'), def('PRODUCES', 'MILL'), def('PRODUCES', 'CARDS_TO_GRAVEYARD'),
  ], ENUMS);
  persistAtomSchema(db, { schema_version: 15, types });
  return db;
}
const tokenParams = { amount: 2, token_types: ['creature'], subtypes: ['Goblin'], controller: 'you' };
const atom = (type_key: string, quote: string, params: Record<string, unknown> = tokenParams) =>
  ({ face_index: 0, family: 'PRODUCES', type_key, params, quote, rule_numbers: ['700'], confidence: 0.9 });

describe('validateAtomParams - array items (v15)', () => {
  it('rejects a token type that is not in the enum, and a subtype that is not a string', () => {
    const db = v15Db('Create two 1/1 red Goblin creature tokens.');
    expect(validateAtomParams(db, 15, 'PRODUCES', 'CREATE', tokenParams)).toEqual({ ok: true });
    expect(validateAtomParams(db, 15, 'PRODUCES', 'CREATE', { ...tokenParams, token_types: ['goblin'] }))
      .toMatchObject({ ok: false, error: expect.stringContaining('item "goblin"') });
    expect(validateAtomParams(db, 15, 'PRODUCES', 'CREATE', { ...tokenParams, subtypes: [3] }))
      .toMatchObject({ ok: false, error: expect.stringContaining('of type string') });
  });
});

describe('validateResponse - V9 supply twins', () => {
  const text = 'Create two 1/1 red Goblin creature tokens.';
  it('drops TOKENS when CREATE covers the same text at v15', () => {
    const db = v15Db(text);
    db.exec('UPDATE extraction_runs SET schema_version = 15 WHERE id = 1');
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: ['700'] }, {
      atoms: [atom('TOKENS', text), atom('CREATE', 'Create two 1/1 red Goblin creature tokens')],
    });
    expect(r.atoms.map((a) => a.type_key)).toEqual(['CREATE']);
    expect(r.rejected[0]!.reason).toMatch(/^twin: PRODUCES\.TOKENS .* V9/);
  });
  it('keeps TOKENS when no CREATE atom overlaps it', () => {
    const db = v15Db(text);
    db.exec('UPDATE extraction_runs SET schema_version = 15 WHERE id = 1');
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: ['700'] }, { atoms: [atom('TOKENS', text)] });
    expect(r.atoms.map((a) => a.type_key)).toEqual(['TOKENS']);
  });
});

describe('renderAtomTypes - required params from v15', () => {
  it('lists the required params at v15 and not at older versions', () => {
    const db = v15Db('Draw a card.');
    expect(renderAtomTypes(db, 15)).toMatch(/PRODUCES CREATE - CREATE params: .* required: \["amount","token_types","subtypes","controller"\]/);
    expect(renderAtomTypes(db, 1)).not.toContain('required:');
  });
});
