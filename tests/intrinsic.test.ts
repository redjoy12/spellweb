import { it, expect } from 'vitest';
import { crCardTypes } from '../src/graph/crContent.js';
import { crSubtypeLists } from '../src/graph/subtypes.js';
import { intrinsicClasses, isClassMember, KINDS_FOR, permittedIntrinsicValues, scopeCards } from '../src/graph/intrinsic.js';
import { isIntrinsic, sideId } from '../src/graph/ruleSchema.js';
import { currentRuleSet, setRules } from '../src/graph/ruleSet.js';
import { maybe, realDb as db, realCorpusId as corpusId } from './helpers/realDb.js';

/** The BR scope by its own query: live cards whose colour identity has only B and R. */
const SCOPE_SQL = `SELECT c.* FROM cards c WHERE c.rotated = 0
  AND NOT EXISTS (SELECT 1 FROM json_each(c.color_identity) j WHERE j.value NOT IN ('B', 'R'))`;

it('KINDS_FOR has the table of spec rev. 7 sec. 12.2', () => {
  expect(KINDS_FOR).toEqual({
    type_line: ['card_type', 'subtype'],
    mana_value: ['mana_value'],
    color_identity: ['color_identity'],
    power_toughness: [],
  });
});

maybe('permitted intrinsic values and class membership (spec rev. 6 sec. 6.1)', () => {
  it('gives the 9 glossary card types, the parser subtypes, the scope cmc values and colour letters', () => {
    const v = permittedIntrinsicValues(db, corpusId, 'BR');
    const glossary = (db.prepare("SELECT term FROM glossary_entries WHERE corpus_id = ? AND definition LIKE 'A card type.%' ORDER BY term")
      .all(corpusId) as Array<{ term: string }>).map((r) => r.term);
    expect(glossary).toHaveLength(9);
    expect(v.card_type).toEqual(glossary);
    expect(v.subtype).toEqual([...new Set([...crSubtypeLists(db, corpusId).values()].flat())].sort());
    expect(v.mana_value).toEqual((db.prepare(`SELECT DISTINCT cmc FROM (${SCOPE_SQL}) ORDER BY cmc`).all() as Array<{ cmc: number }>).map((r) => r.cmc));
    expect(v.color_identity).toEqual((db.prepare(
      `SELECT DISTINCT j.value AS l FROM (${SCOPE_SQL}) s, json_each(s.color_identity) j ORDER BY l`,
    ).all() as Array<{ l: string }>).map((r) => r.l));
  });

  it('card_type: a word of a face type line is equal to the term, without case', () => {
    for (const term of crCardTypes(db, corpusId).keys()) {
      const hit = db.prepare(`SELECT oracle_id FROM card_faces WHERE (' ' || lower(type_line) || ' ') LIKE ? LIMIT 1`)
        .get(`% ${term.toLowerCase()} %`) as { oracle_id: string } | undefined;
      if (!hit) continue;
      expect(isClassMember(db, hit.oracle_id, { intrinsic: 'card_type', value: term })).toBe(true);
      const miss = db.prepare(
        `SELECT oracle_id FROM cards c WHERE NOT EXISTS (SELECT 1 FROM card_faces f WHERE f.oracle_id = c.oracle_id AND lower(f.type_line) LIKE ?) LIMIT 1`,
      ).get(`%${term.toLowerCase()}%`) as { oracle_id: string };
      expect(isClassMember(db, miss.oracle_id, { intrinsic: 'card_type', value: term })).toBe(false);
    }
  });

  it('subtype: the subtype is in the part of a face type line after the long dash', () => {
    const permitted = new Set(permittedIntrinsicValues(db, corpusId, 'BR').subtype as string[]);
    const faces = db.prepare("SELECT oracle_id, type_line FROM card_faces WHERE type_line LIKE '%—%' LIMIT 200")
      .all() as Array<{ oracle_id: string; type_line: string }>;
    const f = faces.find((x) => permitted.has(x.type_line.split('—')[1]!.trim().split(/\s+/)[0]!))!;
    const sub = f.type_line.split('—')[1]!.trim().split(/\s+/)[0]!;
    expect(isClassMember(db, f.oracle_id, { intrinsic: 'subtype', value: sub })).toBe(true);
    const before = f.type_line.split('—')[0]!.trim().split(/\s+/).at(-1)!;
    expect(isClassMember(db, f.oracle_id, { intrinsic: 'subtype', value: before })).toBe(false);
  });

  it('mana_value: a member only when cmc is equal to the value', () => {
    const c = db.prepare('SELECT oracle_id, cmc FROM cards WHERE cmc = 2 LIMIT 1').get() as { oracle_id: string; cmc: number };
    expect(isClassMember(db, c.oracle_id, { intrinsic: 'mana_value', value: 2 })).toBe(true);
    expect(isClassMember(db, c.oracle_id, { intrinsic: 'mana_value', value: 3 })).toBe(false);
  });

  it('color_identity: a card with two letters is a member of both single-letter classes', () => {
    const c = db.prepare(`SELECT oracle_id FROM cards WHERE color_identity = '["B","R"]' LIMIT 1`).get() as { oracle_id: string };
    expect(isClassMember(db, c.oracle_id, { intrinsic: 'color_identity', value: 'B' })).toBe(true);
    expect(isClassMember(db, c.oracle_id, { intrinsic: 'color_identity', value: 'R' })).toBe(true);
    expect(isClassMember(db, c.oracle_id, { intrinsic: 'color_identity', value: 'G' })).toBe(false);
  });
});

maybe('intrinsicClasses (plan Task 4 Step 4)', () => {
  it('makes one class for each intrinsic supply side of the accepted rules, with isClassMember members', { timeout: 60_000 }, () => {
    const set = currentRuleSet(db);
    if (!set) return;
    const rules = setRules(db, set.id, 'accepted');
    const classes = intrinsicClasses(db, 'BR', rules);
    const sides = new Set(rules.filter((r) => isIntrinsic(r.supply)).map((r) => sideId(r.supply)));
    expect(classes.map((c) => c.id).sort()).toEqual([...sides].sort());
    const cards = scopeCards(db, 'BR');
    for (const c of classes) {
      const n = cards.filter((id) => isClassMember(db, id, { intrinsic: c.intrinsic, value: c.value })).length;
      expect(c.members).toHaveLength(n);
    }
  });
  it('gives the same classes in the same order on a second call', { timeout: 60_000 }, () => {
    const set = currentRuleSet(db);
    if (!set) return;
    const rules = setRules(db, set.id, 'accepted');
    expect(intrinsicClasses(db, 'BR', rules)).toEqual(intrinsicClasses(db, 'BR', [...rules].reverse()));
  });
});
