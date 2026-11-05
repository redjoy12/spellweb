import { describe, it, expect } from 'vitest';
import { BuildIndex, costHasMana, isManaCostGated, type IndexAtom } from '../src/graph/buildIndex.js';
import type { GroupKind } from '../src/graph/groups.js';
import { loadGraphPolicy } from '../src/graph/policy.js';
import type { StoredRule } from '../src/graph/ruleSet.js';

// spec rev. 12 sec. 7.6 (fix request 2, report 1). A land with "{T}: Add {R}." supplies mana.
// Garruk's "+2: ..." costs no mana; Kavaron's "{1}{R}, {T}, Sacrifice a land: ..." costs 2 mana;
// "Equip {2}" is an `other` group with 2 mana symbols in its quote; "Crew 2" has none.
const atom = (id: number, card: string, kind: GroupKind, family: string, type_key: string,
  cost_mana?: number | 'unknown'): IndexAtom => ({
  id, oracle_id: card, face_index: 0, family, type_key, params: {}, span_start: id * 10, span_end: id * 10 + 5,
  group: `${card}#0#${id}`, kind, span: [id * 10, id * 10 + 5], mv: 2,
  ...(cost_mana === undefined ? {} : { cost_mana }),
});
const side = (family: string, type_key: string) => ({ family, type_key, where: [] });
const rule = (hash: string, supply: StoredRule['supply'], demand: StoredRule['demand'], polarity: '+' | '-' = '+'): StoredRule => ({
  rule_hash: hash, rule_id: hash, votes: 3, status: 'accepted', polarity, supply, demand,
  param_links: [], implications: [], evidence: [],
});
const MANA_TO_ACTIVATE = rule('mana', side('PRODUCES', 'MANA_PRODUCTION'), side('ENABLES', 'ACTIVATE'));
const SWAMP_TO_ACTIVATE = rule('swamp', { intrinsic: 'subtype', value: 'Swamp' }, side('ENABLES', 'ACTIVATE'));
const EQUIP_TO_ACTIVATE = rule('equip', side('ENABLES', 'EQUIP'), side('ENABLES', 'ACTIVATE'));

const atoms = [
  atom(1, 'Land', 'activated', 'PRODUCES', 'MANA_PRODUCTION', 0),
  atom(2, 'Garruk', 'activated', 'ENABLES', 'ACTIVATE', 0),
  atom(3, 'Kavaron', 'activated', 'ENABLES', 'ACTIVATE', 2),
  atom(4, 'Plate', 'other', 'ENABLES', 'ACTIVATE', 2),
  atom(5, 'Vehicle', 'other', 'ENABLES', 'ACTIVATE', 0),
  atom(6, 'Hellkite', 'activated', 'ENABLES', 'ACTIVATE', 'unknown'),
  atom(7, 'Old', 'activated', 'ENABLES', 'ACTIVATE'),
  atom(8, 'Plate', 'other', 'ENABLES', 'EQUIP'),
];

function index(manaCostGate: boolean): BuildIndex {
  return new BuildIndex({
    atoms: new Map(atoms.map((a) => [a.id, a])),
    rules: [MANA_TO_ACTIVATE, SWAMP_TO_ACTIVATE, EQUIP_TO_ACTIVATE],
    classes: [{ id: 'INTRINSIC.subtype(Swamp)', intrinsic: 'subtype', value: 'Swamp', members: ['Swamp'] }],
    params: new Map(), policy: loadGraphPolicy(), manaCostGate,
  });
}
const demandCards = (ix: BuildIndex, hash: string) =>
  [...ix.atoms.values()].flatMap((d) => ix.edgesToDemand(d)).filter((e) => e.rule_hash === hash)
    .map((e) => ix.atoms.get(e.demand_atom_id)!.oracle_id).sort();

describe('mana cost gate (spec rev. 12 sec. 7.6)', () => {
  it('gates only a + mana supply rule into ENABLES.ACTIVATE', () => {
    expect(isManaCostGated(MANA_TO_ACTIVATE)).toBe(true);
    expect(isManaCostGated(SWAMP_TO_ACTIVATE)).toBe(true);
    expect(isManaCostGated(EQUIP_TO_ACTIVATE)).toBe(false);
    expect(isManaCostGated(rule('anti', side('PRODUCES', 'MANA_PRODUCTION'), side('ENABLES', 'ACTIVATE'), '-'))).toBe(false);
    expect(isManaCostGated(rule('pw', { intrinsic: 'card_type', value: 'Planeswalker' }, side('ENABLES', 'ACTIVATE')))).toBe(false);
  });

  it('treats an unknown or absent count as mana', () => {
    expect(costHasMana({ cost_mana: 0 })).toBe(false);
    expect(costHasMana({ cost_mana: 1 })).toBe(true);
    expect(costHasMana({ cost_mana: 'unknown' })).toBe(true);
    expect(costHasMana({})).toBe(true);
  });

  it('a land gives no link to Garruk (+2) and a link to Kavaron ({1}{R})', () => {
    const ix = index(true);
    const out = ix.edgesFromSupply(ix.atoms.get(1)!).map((e) => ix.atoms.get(e.demand_atom_id)!.oracle_id).sort();
    expect(out).toEqual(['Hellkite', 'Kavaron', 'Old', 'Plate']);
    expect(demandCards(ix, 'mana')).toEqual(['Hellkite', 'Kavaron', 'Old', 'Plate']);
  });

  it('gates the basic land type class edges the same way', () => {
    expect(demandCards(index(true), 'swamp')).toEqual(['Hellkite', 'Kavaron', 'Old', 'Plate']);
  });

  it('does not gate other rules into ACTIVATE, and an index without the gate links all', () => {
    expect(demandCards(index(true), 'equip')).toEqual(['Garruk', 'Hellkite', 'Kavaron', 'Old', 'Plate', 'Vehicle']);
    expect(demandCards(index(false), 'mana')).toEqual(['Garruk', 'Hellkite', 'Kavaron', 'Old', 'Plate', 'Vehicle']);
  });
});
