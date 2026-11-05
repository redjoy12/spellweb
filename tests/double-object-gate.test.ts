import { describe, it, expect } from 'vitest';
import { BuildIndex, doubleObjectsAgree, doubleObjectsOfQuote, doubleObjectsOfRule, type IndexAtom } from '../src/graph/buildIndex.js';
import { loadGraphPolicy } from '../src/graph/policy.js';
import type { StoredRule } from '../src/graph/ruleSet.js';

// spec rev. 14 sec. 7.8 (fix request 5). The quotes are the build 6 "Double" atoms. ER-1774
// (Anthem -> Double) quotes CR 701.10b (power); ER-1873 (mana -> Double) quotes CR 701.10f (mana).
const atom = (id: number, card: string, family: string, type_key: string, quote?: string): IndexAtom => ({
  id, oracle_id: card, face_index: 0, family, type_key, params: { subject_type: 'creature' },
  span_start: id * 10, span_end: id * 10 + 5, group: `${card}#0#${id}`, kind: 'other', span: [id * 10, id * 10 + 5], mv: 2,
  ...(quote === undefined ? {} : { double_objects: doubleObjectsOfQuote(quote) }),
});
const ev = (...refs: string[]) => refs.map((ref) => ({ source: 'rule' as const, ref, quote: '' }));
const rule = (hash: string, family: string, type_key: string, evidence: StoredRule['evidence'], polarity: '+' | '-' = '+'): StoredRule => ({
  rule_hash: hash, rule_id: hash, votes: 3, status: 'accepted', polarity,
  supply: { family, type_key, where: [] }, demand: { family: 'ENABLES', type_key: 'DOUBLE', where: [] },
  param_links: [], implications: [], evidence,
});
const ANTHEM = rule('anthem', 'COMBAT', 'ANTHEM', ev('613.4c', '701.10b'));
const MANA = rule('mana', 'PRODUCES', 'MANA_PRODUCTION', ev('701.10f', '106.4'));
const COUNTERS = rule('counters', 'PRODUCES', 'COUNTER_PRODUCTION', ev('701.10e'));
const NO_BASIS = rule('nobasis', 'ENABLES', 'EVOLVE', ev('702.100a'));

const atoms = [
  atom(1, 'Kavaron', 'COMBAT', 'ANTHEM'),
  atom(2, 'Land', 'PRODUCES', 'MANA_PRODUCTION'),
  atom(3, 'Counters', 'PRODUCES', 'COUNTER_PRODUCTION'),
  atom(4, 'Evolve', 'ENABLES', 'EVOLVE'),
  atom(5, 'Mjolnir', 'ENABLES', 'DOUBLE', 'Double all damage equipped creature would deal.'),
  atom(6, 'Bulk Up', 'ENABLES', 'DOUBLE', "Double target creature's power until end of turn."),
  atom(7, 'Calendar', 'ENABLES', 'DOUBLE', '{2}, {T}: Double the number of time counters on The Millennium Calendar.'),
  atom(8, 'Unknown', 'ENABLES', 'DOUBLE', 'Double it.'),
];
const index = (doubleObjectGate: boolean) => new BuildIndex({
  atoms: new Map(atoms.map((a) => [a.id, a])), rules: [ANTHEM, MANA, COUNTERS, NO_BASIS],
  classes: [], params: new Map(), policy: loadGraphPolicy(), doubleObjectGate,
});
const links = (ix: BuildIndex, hash: string) => [...ix.atoms.values()].flatMap((d) => ix.edgesToDemand(d))
  .filter((e) => e.rule_hash === hash).map((e) => ix.atoms.get(e.demand_atom_id)!.oracle_id).sort();

describe('"Double" object gate (spec rev. 14 sec. 7.8)', () => {
  it('reads the CR 701.10 nouns of a quote', () => {
    expect(doubleObjectsOfQuote('If a source you control would deal damage to an opponent, it deals double that damage instead.')).toEqual(['damage']);
    expect(doubleObjectsOfQuote("Double target creature's power until end of turn.")).toEqual(['power']);
    expect(doubleObjectsOfQuote('double the number of +1/+1 counters on it.')).toEqual(['counters']);
    expect(doubleObjectsOfQuote('Double your life total.')).toEqual(['life']);
    expect(doubleObjectsOfQuote('Creatures you control have lifelink.')).toEqual([]);
  });

  it('reads the objects of a + rule into DOUBLE from its 701.10 evidence', () => {
    expect([...doubleObjectsOfRule(ANTHEM)!].sort()).toEqual(['power', 'toughness']);
    expect([...doubleObjectsOfRule(MANA)!]).toEqual(['mana']);
    expect(doubleObjectsOfRule(NO_BASIS)).toBeNull();
    expect(doubleObjectsOfRule(rule('anti', 'COMBAT', 'ANTHEM', ev('701.10b'), '-'))).toBeNull();
    expect(doubleObjectsAgree(MANA, {})).toBe(true);
  });

  it('ER-1774: Kavaron (Anthem) links to Bulk Up (power), not to Mjolnir (damage) or the Calendar (counters)', () => {
    expect(index(true).edgesFromSupply(atoms[0]!).map((e) => e.demand_atom_id)).toEqual([6, 8]);
    expect(links(index(true), 'anthem')).toEqual(['Bulk Up', 'Unknown']);
  });

  it('ER-1873: a mana source links to no "Double" atom that names another object', () => {
    expect(links(index(true), 'mana')).toEqual(['Unknown']);
    expect(links(index(true), 'counters')).toEqual(['Calendar', 'Unknown']);
  });

  it('keeps a rule with no 701.10 evidence, and an index without the gate links all', () => {
    expect(links(index(true), 'nobasis')).toEqual(['Bulk Up', 'Calendar', 'Mjolnir', 'Unknown']);
    expect(links(index(false), 'anthem')).toEqual(['Bulk Up', 'Calendar', 'Mjolnir', 'Unknown']);
  });
});
