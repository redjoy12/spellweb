import { describe, it, expect } from 'vitest';
import { GOLDEN_V19 } from '../src/atoms/goldenV19.js';
import { INSTRUCTIONS, instructionsFor } from '../src/atoms/extract.js';
import { persistAtomSchema, validateAtomParams, type AtomTypeDef } from '../src/atoms/schema.js';
import {
  applyV19, BECOMES_TAPPED_TAG, CARD_DRAW_TAG, COMMIT_CRIME_TAG, DEALT_DAMAGE_TAG, DISCARD_ROLE, DISCARD_TAG, LEAVES_GRAVEYARD_TAG, v19Role, V19_MARK, V19_ROLES, V19_TAGS,
} from '../src/atoms/schemaV19.js';
import { openDb } from '../src/db/client.js';
import { demandTypes, setRoles, setRules } from '../src/graph/ruleSet.js';
import { maybe, realCorpusId, realDb } from './helpers/realDb.js';

// Schema v19 (spec sec. 24): six event trigger tags. The vocabulary rows are synthetic.

const discard = (): AtomTypeDef => ({
  family: 'PRODUCES', type_key: 'DISCARD', label: 'Discard', provenance: 'cr_701', evidence: 'e',
  params_schema: { type: 'object', additionalProperties: false, required: ['card_types'], properties: { card_types: { type: 'array', items: { enum: ['creature', 'land'] } } } },
});
const find = (t: readonly AtomTypeDef[], id: string) => t.find((x) => `${x.family}.${x.type_key}` === id);
const props = (t: AtomTypeDef | undefined) => (t!.params_schema as { properties: Record<string, { enum?: string[]; items?: unknown }> }).properties;

describe('applyV19', () => {
  it('adds the six tags, each as a promoted type with its evidence', () => {
    const types = applyV19([discard()]);
    expect(types).toHaveLength(7);
    for (const t of V19_TAGS) {
      const def = find(types, t.type)!;
      expect(def.family).toBe('CARES_ABOUT');
      expect(def.provenance).toBe('review_promoted');
      expect(def.evidence).toContain(V19_MARK);
      expect(def.evidence).toContain(`CR ${t.ref} "${t.quote}"`);
    }
  });
  it('gives each tag the details of plan section 9.2, all required', () => {
    const types = applyV19([discard()]);
    expect(Object.keys(props(find(types, DISCARD_TAG)))).toEqual(['player', 'card_types']);
    expect(Object.keys(props(find(types, LEAVES_GRAVEYARD_TAG)))).toEqual(['card_types']);
    expect(props(find(types, BECOMES_TAPPED_TAG))['subject']!.enum).toEqual(['self', 'attached']);
    expect(props(find(types, CARD_DRAW_TAG))['which']!.enum).toEqual(['any', 'second']);
    expect(props(find(types, COMMIT_CRIME_TAG))).toEqual({});
    expect(props(find(types, DEALT_DAMAGE_TAG))['subject']!.enum).toEqual(['self', 'attached', 'creature', 'player']);
    expect(props(find(types, DEALT_DAMAGE_TAG))['damage_kind']!.enum).toEqual(['any', 'noncombat']);
    expect((find(types, DEALT_DAMAGE_TAG)!.params_schema as { required: string[] }).required).toEqual(['subject', 'damage_kind']);
  });
  it('takes the card types from PRODUCES.DISCARD', () => {
    expect(props(find(applyV19([discard()]), DISCARD_TAG))['card_types']!.items).toEqual({ enum: ['creature', 'land'] });
  });
  it('is a no-op on a second run', () => {
    const once = applyV19([discard()]);
    expect(applyV19(once)).toEqual(once);
  });
  it('refuses a vocabulary with no PRODUCES.DISCARD', () => {
    expect(() => applyV19([])).toThrow('PRODUCES.DISCARD');
  });
});

describe('instructionsFor on v19', () => {
  it('leaves a v18 packet as it was', () => {
    expect(instructionsFor(18)).not.toContain('CARES_ABOUT DISCARD');
    expect(instructionsFor(15)).toBe(INSTRUCTIONS);
  });
  it('has one line for each tag, and each line sits before the reminder text line', () => {
    const s = instructionsFor(19);
    const reminder = s.indexOf('- Reminder text (in parentheses)');
    for (const t of V19_TAGS) {
      const at = s.indexOf(`- ${t.type.replace('.', ' ')}: a trigger`);
      expect(at, t.type).toBeGreaterThan(0);
      expect(at, t.type).toBeLessThan(reminder);
    }
  });
  it('keeps the v18 lines, and adds the forms of review 1 F6', () => {
    const s = instructionsFor(19);
    expect(s).toContain('with removal_type destroy and the param object, and no PRODUCES DESTROY');
    for (const words of ['"X or Y" objects', 'removal_type damage', '"this token" in an ability', 'An additional cost with an alternative', 'The object_type of "sacrifice it"']) {
      expect(s, words).toContain(words);
    }
  });
});

describe('the golden table of v19', () => {
  const db = openDb(':memory:');
  persistAtomSchema(db, { schema_version: 19, types: applyV19([discard()]) });
  it('has values that pass the params of each type', () => {
    for (const g of GOLDEN_V19) {
      const [family, key] = g.type.split('.') as [string, string];
      expect(validateAtomParams(db, 19, family, key, g.params), g.quote).toEqual({ ok: true });
    }
  });
  it('has at least 2 cards for each tag', () => {
    for (const t of V19_TAGS) expect(new Set(GOLDEN_V19.filter((g) => g.type === t.type).map((g) => g.card)).size, t.type).toBeGreaterThanOrEqual(2);
  });
  it('uses each value of player and subject, except `any` of the draw tag, which no gap card has', () => {
    const values = (type: string, param: string) => new Set(GOLDEN_V19.filter((g) => g.type === type).map((g) => g.params[param]));
    expect(values(DISCARD_TAG, 'player')).toEqual(new Set(['you', 'opponent', 'any']));
    expect(values(BECOMES_TAPPED_TAG, 'subject')).toEqual(new Set(['self', 'attached']));
    expect(values(CARD_DRAW_TAG, 'player')).toEqual(new Set(['you', 'opponent']));
    expect(values(DEALT_DAMAGE_TAG, 'subject')).toEqual(new Set(['self', 'attached', 'creature', 'player']));
    expect(values(DEALT_DAMAGE_TAG, 'damage_kind')).toEqual(new Set(['any', 'noncombat']));
  });
});

describe('the role of a v19 tag', () => {
  it('takes the ref and the quote from V19_TAGS', () => {
    const e1 = V19_TAGS.find((t) => t.type === DISCARD_TAG)!;
    expect(DISCARD_ROLE).toMatchObject({ type: DISCARD_TAG, evidence: [{ source: 'rule', ref: e1.ref, quote: e1.quote }] });
    expect(DISCARD_ROLE.demand_note).not.toBe('');
  });
  it('refuses a type that is not a v19 tag', () => {
    expect(() => v19Role('CARES_ABOUT.DESCENDED', 'n')).toThrow('not a v19 tag');
  });
  it('each tag has one role with a note and the evidence of its row (plan Task 18)', () => {
    expect(Object.keys(V19_ROLES).sort()).toEqual(V19_TAGS.map((t) => t.type).sort());
    for (const t of V19_TAGS) {
      const r = V19_ROLES[t.type]!;
      expect(r.demand_note, t.type).not.toBe('');
      expect(r.evidence, t.type).toEqual([{ source: 'rule', ref: t.ref, quote: t.quote }]);
    }
  });
});

maybe('schema v19 against the stored data', () => {
  it('each tag has stored CR text as its evidence', () => {
    for (const t of V19_TAGS) {
      const r = realDb.prepare('SELECT text FROM rules WHERE corpus_id = ? AND number = ?').get(realCorpusId, t.ref) as { text: string };
      expect(r.text, t.type).toContain(t.quote);
    }
  });
  it('on the first v19 rule set, the discard tag has the accepted role demand, and the other five tags have no role', () => {
    const v19 = realDb.prepare('SELECT id FROM edge_rule_sets WHERE schema_version = 19 ORDER BY id').get() as { id: number } | undefined;
    if (!v19) return;
    expect(demandTypes(realDb, v19.id)).toContain(DISCARD_TAG);
    const roles = setRoles(realDb, v19.id);
    expect(roles.find((r) => `${r.family}.${r.type_key}` === DISCARD_TAG)).toMatchObject({ role: 'demand', status: 'accepted', votes: 0, evidence: DISCARD_ROLE.evidence });
    for (const t of V19_TAGS.filter((x) => x.type !== DISCARD_TAG)) expect(roles.find((r) => `${r.family}.${r.type_key}` === t.type), t.type).toBeUndefined();
  });
  it('on the first v19 rule set, each rule of the v18 set is there, with its id, votes and status', () => {
    const v19 = realDb.prepare('SELECT id FROM edge_rule_sets WHERE schema_version = 19 ORDER BY id').get() as { id: number } | undefined;
    if (!v19) return;
    const rules = new Map(setRules(realDb, v19.id, 'all').map((r) => [r.rule_hash, r]));
    for (const o of setRules(realDb, 6, 'all')) {
      const n = rules.get(o.rule_hash);
      expect(n, o.rule_id).toBeDefined();
      expect([n!.rule_id, n!.votes, n!.status], o.rule_id).toEqual([o.rule_id, o.votes, o.status]);
    }
  });
});
