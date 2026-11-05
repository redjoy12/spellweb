import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyV15 } from '../src/atoms/schemaV15.js';
import type { V15Enums } from '../src/atoms/schemaV15.js';
import { ACTIVATE_KINDS, applyV16, typesOf, V16_MARK } from '../src/atoms/schemaV16.js';
import { discardParamsV16, v16Changes, type V16Atom } from '../src/atoms/migrateV16.js';
import { persistAtomSchema } from '../src/atoms/schema.js';
import type { AtomTypeDef } from '../src/atoms/schema.js';
import { INSTRUCTIONS, instructionsFor, validateResponse } from '../src/atoms/extract.js';
import { sideHolds } from '../src/graph/match.js';
import { fixtureWithClauses } from './helpers/fixture.js';
import { maybe, realCorpusId, realDb } from './helpers/realDb.js';

// Schema v16 (spec sec. 21): the owner's merge decisions of 2026-10-23.

const ENUMS: V15Enums = {
  permanentTypes: ['artifact', 'creature', 'any'],
  cardTypes: ['artifact', 'creature', 'instant', 'land'],
  zones: ['library', 'hand', 'battlefield', 'graveyard', 'stack', 'exile', 'command'],
};
const EMPTY = { type: 'object', properties: {}, additionalProperties: false };
const def = (family: AtomTypeDef['family'], type_key: string): AtomTypeDef =>
  ({ family, type_key, label: type_key, params_schema: EMPTY, provenance: 'spec_4_1', evidence: 'e' });
const kinds = ACTIVATE_KINDS.map((k) => def('ENABLES', k.type.split('.')[1]!));
const v15 = () => applyV15([
  def('ENABLES', 'ACTIVATE'), def('ENABLES', 'SEARCH'), def('ENABLES', 'TUTOR'), def('INTERACTION', 'DISCARD'),
  def('PRODUCES', 'DISCARD'), ...kinds,
], ENUMS);

describe('applyV16', () => {
  it('removes TUTOR and INTERACTION.DISCARD, and gives the keyword kinds the ACTIVATE cost params', () => {
    const t = applyV16(v15(), ENUMS, { requireAll: true });
    const ids = t.map((x) => `${x.family}.${x.type_key}`);
    expect(ids).not.toContain('ENABLES.TUTOR');
    expect(ids).not.toContain('INTERACTION.DISCARD');
    const equip = t.find((x) => x.type_key === 'EQUIP')!;
    expect(Object.keys((equip.params_schema as { properties: object }).properties)).toEqual(['cost_mana', 'cost_tap']);
    expect(equip.evidence).toContain(V16_MARK);
    const discard = t.find((x) => x.family === 'PRODUCES' && x.type_key === 'DISCARD')!;
    expect(Object.keys((discard.params_schema as { properties: object }).properties))
      .toEqual(['object', 'card_types', 'excluded_card_types', 'actor', 'card_choice']);
  });
  it('the committed config is at v16 or later and has the v16 changes', () => {
    const schema = JSON.parse(readFileSync('config/atom-schema.json', 'utf8')) as { schema_version: number; types: AtomTypeDef[] };
    expect(schema.schema_version).toBeGreaterThanOrEqual(16);
    const ids = schema.types.map((x) => `${x.family}.${x.type_key}`);
    expect(ids).not.toContain('ENABLES.TUTOR');
    expect(ids).not.toContain('INTERACTION.DISCARD');
    for (const k of ACTIVATE_KINDS) expect(schema.types.find((x) => `${x.family}.${x.type_key}` === k.type)?.evidence, k.type).toContain(V16_MARK);
  });
  it('is a no-op the second time, and throws when a named type is missing', () => {
    const once = applyV16(v15(), ENUMS);
    expect(applyV16(once, ENUMS)).toEqual(once);
    expect(() => applyV16([def('ENABLES', 'ACTIVATE')], ENUMS, { requireAll: true })).toThrow(/not in the vocabulary/);
  });
});

describe('typesOf and sideHolds - a keyword kind is also ACTIVATE (M3)', () => {
  const equip = { id: 1, oracle_id: 'o', face_index: 0, family: 'ENABLES', type_key: 'EQUIP', params: { cost_mana: 'yes', cost_tap: 'no' }, span_start: 0, span_end: 5 };
  const side = (where: Array<{ param: string; op: 'eq'; value: string }> = []) => ({ family: 'ENABLES', type_key: 'ACTIVATE', where });
  it('matches an ACTIVATE side only on v16 builds, with the ACTIVATE predicates', () => {
    expect(typesOf('ENABLES.EQUIP')).toEqual(['ENABLES.EQUIP', 'ENABLES.ACTIVATE']);
    expect(typesOf('ENABLES.SEARCH')).toEqual(['ENABLES.SEARCH']);
    expect(sideHolds(side(), equip)).toBe(false);
    expect(sideHolds(side(), equip, true)).toBe(true);
    expect(sideHolds(side([{ param: 'cost_mana', op: 'eq', value: 'yes' }]), equip, true)).toBe(true);
    expect(sideHolds(side([{ param: 'cost_tap', op: 'eq', value: 'yes' }]), equip, true)).toBe(false);
  });
});

describe('v16Changes - the move of stored atoms', () => {
  let next = 1;
  const a = (type: string, span: [number, number], params: Record<string, unknown> = {}, face = 0): V16Atom => {
    const [family, type_key] = type.split('.') as [string, string];
    return { id: next++, face_index: face, family, type_key, span_start: span[0], span_end: span[1], params };
  };
  it('drops a removed type when its keeper is on the face, and converts it when not (M1, M2)', () => {
    const tutor = a('ENABLES.TUTOR', [0, 10]);
    const search = a('ENABLES.SEARCH', [0, 10]);
    const alone = a('ENABLES.TUTOR', [0, 10], {}, 1);
    const c = v16Changes([tutor, search, alone]);
    expect(c).toContainEqual({ kind: 'drop', id: tutor.id, item: 'M1', into: 'ENABLES.SEARCH' });
    expect(c).toContainEqual({ kind: 'convert', id: alone.id, item: 'M1', into: 'ENABLES.SEARCH', params: {} });
    const idis = a('INTERACTION.DISCARD', [0, 9], { whose: 'opponent' });
    const c2 = v16Changes([idis]);
    expect(c2).toEqual([{ kind: 'convert', id: idis.id, item: 'M2', into: 'PRODUCES.DISCARD',
      params: { actor: 'opponent' } }]);
  });
  it('gives PRODUCES.DISCARD the v16 params (M2)', () => {
    expect(discardParamsV16({ object: 'self', object_type: 'creature', actor: 'you' }))
      .toEqual({ object: 'self', card_types: ['creature'], excluded_card_types: [], actor: 'you' });
    expect(discardParamsV16({ object: 'any', object_type: 'any', actor: 'any' }))
      .toEqual({ object: 'any', card_types: [], excluded_card_types: [], actor: 'any' });
  });
  it('drops an ACTIVATE that overlaps a keyword kind, and moves its cost params (M3)', () => {
    const act = a('ENABLES.ACTIVATE', [0, 12], { cost_mana: 'yes', cost_tap: 'no' });
    const equip = a('ENABLES.EQUIP', [0, 12]);
    const other = a('ENABLES.ACTIVATE', [20, 30], { cost_mana: 'no', cost_tap: 'yes' });
    const c = v16Changes([act, equip, other]);
    expect(c).toContainEqual({ kind: 'drop', id: act.id, item: 'M3', into: 'ENABLES.EQUIP' });
    expect(c).toContainEqual({ kind: 'params', id: equip.id, item: 'M3', params: { cost_mana: 'yes', cost_tap: 'no' } });
    expect(c.some((x) => x.id === other.id)).toBe(false);
  });
  it('drops a Discard atom that overlaps a Cycling atom, and keeps a Discard atom elsewhere (M4)', () => {
    const cycling = a('ENABLES.CYCLING', [0, 10]);
    const discard = a('PRODUCES.DISCARD', [0, 10], { object: 'self', card_types: [], excluded_card_types: [], actor: 'you' });
    const other = a('PRODUCES.DISCARD', [20, 40], { object: 'any', card_types: [], excluded_card_types: [], actor: 'opponent' });
    const c = v16Changes([cycling, discard, other]);
    expect(c).toEqual([{ kind: 'drop', id: discard.id, item: 'M4', into: 'ENABLES.CYCLING' }]);
  });
  it('drops Card draw, Search, Shuffle and Reveal atoms on a Cycling text too (M4)', () => {
    const cycling = a('ENABLES.CYCLING', [0, 20]);
    const parts = ['PRODUCES.CARD_DRAW', 'ENABLES.SEARCH', 'ENABLES.SHUFFLE', 'ENABLES.REVEAL'].map((t) => a(t, [0, 20]));
    const elsewhere = a('PRODUCES.CARD_DRAW', [30, 40]);
    const c = v16Changes([cycling, ...parts, elsewhere]);
    expect(c.map((x) => x.id).sort((p, q) => p - q)).toEqual(parts.map((p) => p.id));
    expect(c.every((x) => x.kind === 'drop' && x.item === 'M4')).toBe(true);
  });
  it('converts a removed atom when the only keeper on the face is a Cycling twin that M4 drops', () => {
    const cycling = a('ENABLES.CYCLING', [0, 10]);
    const discard = a('PRODUCES.DISCARD', [0, 10], { object: 'self', card_types: [], excluded_card_types: [], actor: 'you' });
    const forced = a('INTERACTION.DISCARD', [20, 40], { whose: 'opponent' });
    const c = v16Changes([cycling, discard, forced]);
    expect(c).toContainEqual({ kind: 'drop', id: discard.id, item: 'M4', into: 'ENABLES.CYCLING' });
    expect(c).toContainEqual({ kind: 'convert', id: forced.id, item: 'M2', into: 'PRODUCES.DISCARD', params: { actor: 'opponent' } });
  });
});

describe('validateResponse - M3 keyword twins at v16', () => {
  const text = 'Equip {2}';
  it('drops ACTIVATE when a keyword kind covers the same text, and moves the cost params', () => {
    const db = fixtureWithClauses(text);
    persistAtomSchema(db, { schema_version: 16, types: applyV16(v15(), ENUMS) });
    db.exec('UPDATE extraction_runs SET schema_version = 16 WHERE id = 1');
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: ['700'] }, {
      atoms: [
        { face_index: 0, family: 'ENABLES', type_key: 'ACTIVATE', params: { cost_mana: 'yes', cost_tap: 'no' }, quote: text, rule_numbers: ['700'], confidence: 0.9 },
        { face_index: 0, family: 'ENABLES', type_key: 'EQUIP', params: { cost_mana: 'yes', cost_tap: 'no' }, quote: text, rule_numbers: ['700'], confidence: 0.9 },
      ],
    });
    expect(r.atoms.map((x) => x.type_key)).toEqual(['EQUIP']);
    expect(r.rejected[0]!.reason).toMatch(/^twin: ENABLES\.ACTIVATE .* M3/);
  });
  it('gives a keyword atom with no cost params the params of its ACTIVATE twin before the params check', () => {
    const db = fixtureWithClauses('Crew 1');
    persistAtomSchema(db, { schema_version: 16, types: applyV16(v15(), ENUMS) });
    db.exec('UPDATE extraction_runs SET schema_version = 16 WHERE id = 1');
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: ['700'] }, {
      atoms: [
        { face_index: 0, family: 'ENABLES', type_key: 'CREW', params: {}, quote: 'Crew 1', rule_numbers: ['700'], confidence: 0.9 },
        { face_index: 0, family: 'ENABLES', type_key: 'ACTIVATE', params: { cost_mana: 'no', cost_tap: 'yes' }, quote: 'Crew 1', rule_numbers: ['700'], confidence: 0.9 },
      ],
    });
    expect(r.atoms.map((x) => [x.type_key, JSON.parse(x.params_json)])).toEqual([['CREW', { cost_mana: 'no', cost_tap: 'yes' }]]);
  });
  it('drops a Discard atom on a Cycling text (M4)', () => {
    const db = fixtureWithClauses('Cycling {2}');
    persistAtomSchema(db, { schema_version: 16, types: applyV16(v15(), ENUMS) });
    db.exec('UPDATE extraction_runs SET schema_version = 16 WHERE id = 1');
    const discard = { object: 'self', card_types: [], excluded_card_types: [], actor: 'you', card_choice: 'specific' };
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: ['700'] }, {
      atoms: [
        { face_index: 0, family: 'ENABLES', type_key: 'CYCLING', params: { cost_mana: 'yes', cost_tap: 'no' }, quote: 'Cycling {2}', rule_numbers: ['700'], confidence: 0.9 },
        { face_index: 0, family: 'PRODUCES', type_key: 'DISCARD', params: discard, quote: 'Cycling {2}', rule_numbers: ['700'], confidence: 0.9 },
      ],
    });
    expect(r.atoms.map((x) => x.type_key)).toEqual(['CYCLING']);
    expect(r.rejected[0]!.reason).toMatch(/^twin: PRODUCES\.DISCARD .* M4/);
  });
});

describe('instructionsFor', () => {
  it('keeps the old text before v16, and states M3 and M4 from v16', () => {
    expect(instructionsFor(15)).toBe(INSTRUCTIONS);
    const v16 = instructionsFor(16);
    expect(v16).not.toContain('get ACTIVATE beside their own type');
    expect(v16).toContain('gets only CYCLING: no DISCARD, CARD_DRAW, SEARCH, SHUFFLE or REVEAL atom');
    expect(v16).toContain('gets CREW (with cost_mana and cost_tap), not ACTIVATE');
  });
});

maybe('ACTIVATE_KINDS against the stored CR text', () => {
  it('names a CR rule that calls each keyword an activated ability', () => {
    const text = realDb.prepare('SELECT text FROM rules WHERE corpus_id = ? AND number = ?');
    for (const k of ACTIVATE_KINDS) {
      const t = (text.get(realCorpusId, k.evidence) as { text: string } | undefined)?.text ?? '';
      expect(t, `${k.type} ${k.evidence}`).toMatch(/activated abilit/i);
    }
  });
});
