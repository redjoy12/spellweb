import { describe, it, expect } from 'vitest';
import { GOLDEN_V20_ADD, GOLDEN_V20_SET } from '../src/atoms/goldenV20.js';
import { INSTRUCTIONS, instructionsFor, validateResponse } from '../src/atoms/extract.js';
import { retireWouldDieRiders } from '../src/atoms/migrateV20.js';
import { persistAtomSchema, validateAtomParams, type AtomTypeDef } from '../src/atoms/schema.js';
import { applyV20, isWouldDieRider, V20_MARK, V20_REPLACED } from '../src/atoms/schemaV20.js';
import { openDb } from '../src/db/client.js';
import { fixtureWithClauses, insertAtom } from './helpers/fixture.js';

// Schema v20 (spec sec. 25): the details of PRODUCES.DAMAGE. The vocabulary rows are synthetic.

const damage = (): AtomTypeDef => ({
  family: 'PRODUCES', type_key: 'DAMAGE', label: 'Deals damage', provenance: 'spec_4_1', evidence: 'e',
  params_schema: { type: 'object', additionalProperties: false, required: ['amount'], properties: { amount: { type: ['integer', 'string'] } } },
});
const other = (): AtomTypeDef => ({ family: 'PRODUCES', type_key: 'MILL', label: 'Mill', provenance: 'cr_701', evidence: 'e', params_schema: { type: 'object', properties: {} } });
const props = (t: AtomTypeDef) => (t.params_schema as { properties: Record<string, { enum?: string[]; type?: unknown }>; required: string[] });

describe('applyV20', () => {
  it('gives PRODUCES.DAMAGE recipient and targeted beside amount, all required', () => {
    const [d] = applyV20([damage()]);
    expect(Object.keys(props(d!).properties)).toEqual(['amount', 'recipient', 'targeted']);
    expect(props(d!).required).toEqual(['amount', 'recipient', 'targeted']);
    expect(props(d!).properties['recipient']!.enum).toEqual(['creature', 'opponent', 'you', 'player', 'any']);
    expect(props(d!).properties['targeted']!.type).toBe('boolean');
    expect(d!.evidence).toContain(V20_MARK);
  });
  it('changes no other type, and a second run is a no-op', () => {
    const once = applyV20([damage(), other()]);
    expect(once[1]).toEqual(other());
    expect(applyV20(once)).toEqual(once);
  });
  it('refuses a vocabulary with no PRODUCES.DAMAGE', () => {
    expect(() => applyV20([other()])).toThrow(/no PRODUCES.DAMAGE/);
  });
});

describe('the extractor text', () => {
  it('has the v20 lines only on v20 and later', () => {
    expect(instructionsFor(19)).not.toContain('set recipient and targeted');
    expect(instructionsFor(20)).toContain('- PRODUCES DAMAGE: set recipient and targeted as their descriptions say.');
    expect(instructionsFor(20)).toContain('takes the recipient and targeted of the clause that it changes');
    expect(instructionsFor(20).length).toBeGreaterThan(INSTRUCTIONS.length);
  });
  it('has the "would die this turn" line only on v20 and later', () => {
    expect(instructionsFor(19)).not.toContain('would die this turn');
    expect(instructionsFor(20)).toContain('"would die this turn, exile it instead." gets PRODUCES EXILE and no CARES_ABOUT PERMANENT_DIES atom.');
  });
});

// Spec sec. 25.8: round 5, the "would die this turn, exile it instead" text.
describe('the would die text', () => {
  const RIDER = 'If that creature would die this turn, exile it instead.';
  const dies = (quote: string) => ({ family: 'CARES_ABOUT', type_key: 'PERMANENT_DIES', quote });
  const fixture = () => {
    const db = fixtureWithClauses(RIDER);
    const empty = { type: 'object', properties: {}, additionalProperties: false };
    persistAtomSchema(db, { schema_version: 20, types: [
      { family: 'CARES_ABOUT', type_key: 'PERMANENT_DIES', label: 'x', params_schema: empty, provenance: 'spec_4_1', evidence: 'e' },
      { family: 'PRODUCES', type_key: 'EXILE', label: 'x', params_schema: empty, provenance: 'spec_4_1', evidence: 'e' },
    ] });
    db.exec('UPDATE extraction_runs SET schema_version = 20 WHERE id = 1');
    // `insertAtom` writes schema version 1, and that version does not have these two types.
    db.exec('PRAGMA foreign_keys = OFF');
    return db;
  };
  const current = (db: ReturnType<typeof fixture>, id: number) => (db.prepare('SELECT is_current FROM atoms WHERE id = ?').get(id) as { is_current: number }).is_current;

  it('matches the end of the quote, on PERMANENT_DIES only', () => {
    for (const q of [RIDER, 'If that permanent would die this turn, exile it instead.', 'If a permanent dealt damage by Torch the Tower would die this turn, exile it instead.',
      'If a creature an opponent controls would die this turn, exile it instead.']) expect(isWouldDieRider(dies(q))).toBe(true);
    for (const q of ['If a creature an opponent controls would die, exile it instead.', 'If a nontoken creature an opponent controls would die, instead exile it and you gain 2 life.',
      'Whenever a creature you control dies, draw a card.']) expect(isWouldDieRider(dies(q))).toBe(false);
    expect(isWouldDieRider({ family: 'PRODUCES', type_key: 'EXILE', quote: RIDER })).toBe(false);
  });
  it('validateResponse rejects the demand atom and keeps PRODUCES.EXILE', () => {
    const r = validateResponse(fixture(), 'o', { runId: 1, passIndex: 0, packetRules: ['700'] }, {
      atoms: [
        { face_index: 0, family: 'CARES_ABOUT', type_key: 'PERMANENT_DIES', params: {}, quote: RIDER, rule_numbers: ['700'], confidence: 0.9 },
        { face_index: 0, family: 'PRODUCES', type_key: 'EXILE', params: {}, quote: RIDER, rule_numbers: ['700'], confidence: 0.9 },
      ],
    });
    expect(r.atoms.map((x) => x.type_key)).toEqual(['EXILE']);
    expect(r.rejected[0]!.reason).toMatch(/^would die: /);
  });
  it('retires the live atom and keeps PRODUCES.EXILE, and a dry run writes nothing', () => {
    const db = fixture();
    const exile = insertAtom(db, { family: 'PRODUCES', type_key: 'EXILE' });
    const die = insertAtom(db, { family: 'CARES_ABOUT', type_key: 'PERMANENT_DIES' });
    expect(retireWouldDieRiders(db, { dryRun: true })).toEqual([{ id: die, name: 'N', quote: RIDER }]);
    expect(current(db, die)).toBe(1);
    expect(retireWouldDieRiders(db).map((a) => a.id)).toEqual([die]);
    expect([current(db, die), current(db, exile)]).toEqual([0, 1]);
    expect(retireWouldDieRiders(db)).toEqual([]);
  });
  it('refuses a card with no PRODUCES.EXILE atom on the text', () => {
    const db = fixture();
    insertAtom(db, { family: 'CARES_ABOUT', type_key: 'PERMANENT_DIES' });
    expect(() => retireWouldDieRiders(db)).toThrow(/no PRODUCES\.EXILE atom on this text: N/);
  });
});

describe('the golden values', () => {
  it('have each value of recipient, and targeted true and false', () => {
    const rows = [...GOLDEN_V20_SET, ...GOLDEN_V20_ADD.map((g) => g.params)];
    expect(new Set(rows.map((r) => r.recipient))).toEqual(new Set(['creature', 'opponent', 'you', 'player', 'any']));
    for (const v of ['creature', 'opponent', 'player', 'any']) {
      expect(new Set(rows.filter((r) => r.recipient === v).map((r) => r.targeted)), v).toEqual(new Set([true, false]));
    }
  });
  it('agree with the words that each param description names', () => {
    for (const g of GOLDEN_V20_SET) {
      if (/\bany (other )?target\b/.test(g.quote)) expect(g.recipient, g.quote).toBe('any');
      if (/each opponent/.test(g.quote)) expect(g, g.quote).toMatchObject({ recipient: 'opponent', targeted: false });
      if (/target (tapped )?creature an opponent controls/.test(g.quote)) expect(g, g.quote).toMatchObject({ recipient: 'creature', targeted: true });
    }
  });
  it('name the rules that the carry removes', () => {
    expect(V20_REPLACED).toEqual(['ER-3173', 'ER-3199']);
  });
});

describe('the v20 params check', () => {
  it('refuses a Damage atom with no detail, and takes one with both', () => {
    const db = openDb(':memory:');
    persistAtomSchema(db, { schema_version: 20, types: applyV20([damage()]) });
    expect(validateAtomParams(db, 20, 'PRODUCES', 'DAMAGE', { amount: 2 }).ok).toBe(false);
    expect(validateAtomParams(db, 20, 'PRODUCES', 'DAMAGE', { amount: 2, recipient: 'opponent', targeted: false }).ok).toBe(true);
    expect(validateAtomParams(db, 20, 'PRODUCES', 'DAMAGE', { amount: 2, recipient: 'creature or player', targeted: false }).ok).toBe(false);
  });
});
