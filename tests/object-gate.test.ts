import { describe, it, expect } from 'vitest';
import { BuildIndex, type IndexAtom } from '../src/graph/buildIndex.js';
import {
  fixedObject, newObjectTypes, objectFactsOf, objectGateBlocks, objectSubtypes, objectTypes, opponentObject, ownObject,
  phraseTypes, selfNames, selfSubject, typeLineSubtypes, typeVocab,
} from '../src/graph/objectGate.js';
import { loadGraphPolicy } from '../src/graph/policy.js';
import type { StoredRule } from '../src/graph/ruleSet.js';
import { ruleSpecificity } from '../src/graph/weights.js';

// spec rev. 16 sec. 7.9 and 7.4. The quotes are build 6 and build 7 atom quotes
// (docs/phase-3-link-logic-review.md sec. 4 and 7).
const NAMES = selfNames(['Winter, Tormented Loner']);

describe('object facts (spec rev. 16 sec. 7.9)', () => {
  it('finds a trigger on the card itself, by "this" or by name', () => {
    const t = 'CARES_ABOUT.ENTERS_BATTLEFIELD';
    expect(selfSubject(t, 'When this creature enters, surveil 2.', [])).toBe(true);
    expect(selfSubject(t, 'When this Vehicle enters, search your library for a basic land card.', [])).toBe(true);
    expect(selfSubject(t, 'When Winter enters, you may sacrifice a creature or planeswalker.', NAMES)).toBe(true);
    expect(selfSubject(t, 'Raid — When this creature enters, if you attacked this turn, draw a card.', [])).toBe(true);
    expect(selfSubject('CARES_ABOUT.PERMANENT_DIES', 'When this creature enters or dies, create a Food token.', [])).toBe(true);
    // Another object: not the card itself.
    expect(selfSubject(t, 'Whenever another creature you control enters, put a +1/+1 counter on it.', [])).toBe(false);
    expect(selfSubject('CARES_ABOUT.PERMANENT_DIES', 'When enchanted creature dies, return it to the battlefield tapped.', [])).toBe(false);
    expect(selfSubject('CARES_ABOUT.PERMANENT_DIES', 'Whenever this creature or another creature you control dies, target opponent loses 1 life.', [])).toBe(false);
    // Review sec. 7.3 pair 123: the self word is in the trigger, but the LIFEGAIN fact is not about the card.
    expect(selfSubject('CARES_ABOUT.LIFEGAIN', 'When this creature enters, up to one target creature gets -X/-X, where X is the amount of life you gained this turn.', [])).toBe(false);
  });

  it('finds a fixed object or an opponent act of a sacrifice or discard', () => {
    const s = 'PRODUCES.SACRIFICE';
    expect(fixedObject(s, '{4}, {T}, Sacrifice this land: Draw a card.', [])).toBe('self');
    expect(fixedObject(s, 'Sacrifice it at the beginning of the next end step.', [])).toBe('self');
    expect(fixedObject(s, 'Each opponent sacrifices a creature of their choice.', [])).toBe('opponent');
    expect(fixedObject('PRODUCES.DISCARD', 'When this creature enters, each opponent discards a card.', [])).toBe('opponent');
    // An open choice is a demand for objects.
    expect(fixedObject(s, '{2}{B}, Sacrifice another creature: Draw a card.', [])).toBeNull();
    expect(fixedObject(s, 'As an additional cost to cast this spell, sacrifice a creature.', [])).toBeNull();
    expect(fixedObject(s, 'Each player sacrifices a creature of their choice.', [])).toBeNull();
    expect(fixedObject(s, 'When Winter enters, you may sacrifice a creature or planeswalker.', NAMES)).toBeNull();
  });

  it('finds an act on an opponent object, and a demand on your own objects', () => {
    expect(opponentObject('PRODUCES.DESTROY', 'Destroy target creature an opponent controls.')).toBe(true);
    expect(opponentObject('INTERACTION.DISCARD', 'When this creature enters, each opponent discards a card.')).toBe(true);
    expect(opponentObject('PRODUCES.DESTROY', 'Destroy target creature.')).toBe(false);
    expect(opponentObject('PRODUCES.DESTROY', 'Destroy target creature you control or an opponent controls.')).toBe(false);
    expect(opponentObject('PRODUCES.CREATE', 'Destroy target creature an opponent controls. Create a 1/1 token.')).toBe(false);
    expect(ownObject('CARES_ABOUT.PERMANENT_DIES', 'Whenever a creature you control dies, draw a card.', { controller: 'you' })).toBe(true);
    expect(ownObject('CARES_ABOUT.PERMANENT_DIES', 'Whenever a creature dies, draw a card.', { controller: 'any' })).toBe(false);
    expect(ownObject('CARES_ABOUT.POPULATED_GRAVEYARD', 'This creature gets +2/+0 for every seven cards in your graveyard.', {})).toBe(true);
    expect(ownObject('CARES_ABOUT.POPULATED_GRAVEYARD', 'as long as there are seven or more cards in a graveyard', {})).toBe(false);
  });

  it('keeps the old Anthem fact on a STAT_CHANGE atom of scope set (spec sec. 23 B2)', () => {
    const facts = (scope: string) => objectFactsOf({ family: 'COMBAT', type_key: 'STAT_CHANGE', params: { scope } }, 'Target creature an opponent controls gets -1/-1.', []);
    expect(facts('one').opponent_object).toBe(true);
    expect(facts('set').opponent_object).toBeUndefined();
  });

  it('finds the new-object types from the labels and evidence of the schema', () => {
    const types = newObjectTypes([
      { family: 'PRODUCES', type_key: 'CREATE', label: 'Create', evidence: 'CR 701.7: "To create one or more tokens …"' },
      { family: 'PRODUCES', type_key: 'POPULATE', label: 'Populate', evidence: 'create a token that\'s a copy of that creature token' },
      { family: 'PRODUCES', type_key: 'SACRIFICE_FODDER', label: 'Creates a permanent intended to be sacrificed', evidence: null },
      { family: 'PRODUCES', type_key: 'SACRIFICE', label: 'Sacrifice', evidence: 'moves it to the graveyard' },
    ]);
    expect([...types].sort()).toEqual(['PRODUCES.CREATE', 'PRODUCES.SACRIFICE_FODDER']);
  });
});

const atom = (id: number, card: string, family: string, type_key: string, quote: string, params: Record<string, unknown> = {}): IndexAtom => ({
  id, oracle_id: card, face_index: 0, family, type_key, params,
  span_start: id * 10, span_end: id * 10 + 5, group: `${card}#0#${id}`, kind: 'other', span: [id * 10, id * 10 + 5], mv: 2,
  object_facts: objectFactsOf({ family, type_key, params }, quote, []),
});
const rule = (hash: string, supply: StoredRule['supply'], demand: { family: string; type_key: string }, polarity: '+' | '-' = '+'): StoredRule => ({
  rule_hash: hash, rule_id: hash, votes: 3, status: 'accepted', polarity, supply, demand: { ...demand, where: [] },
  param_links: [], implications: [], evidence: [],
});
const NEW = new Set(['PRODUCES.CREATE']);
const TOKEN = atom(1, 'Maker', 'PRODUCES', 'CREATE', 'Create a 1/1 black Rat creature token.');
const COPY = atom(2, 'Copier', 'PRODUCES', 'CREATE', "Create a token that's a copy of target creature you control.");
const OUTLET = atom(3, 'Outlet', 'PRODUCES', 'SACRIFICE', '{1}, Sacrifice another creature: Draw a card.');
const REMOVAL = atom(4, 'Removal', 'PRODUCES', 'DESTROY', 'Destroy target creature an opponent controls.');
const SELF_ETB = atom(10, 'Diviner', 'CARES_ABOUT', 'ENTERS_BATTLEFIELD', 'When this creature enters, surveil 2.', { controller: 'you', permanent_type: 'creature' });
const OTHER_ETB = atom(11, 'Watcher', 'CARES_ABOUT', 'ENTERS_BATTLEFIELD', 'Whenever another creature you control enters, you gain 1 life.', { controller: 'you', permanent_type: 'creature' });
const SELF_DIES = atom(12, 'Martyr', 'CARES_ABOUT', 'PERMANENT_DIES', 'When this creature dies, draw a card.', { controller: 'you', permanent_type: 'creature' });
const SELF_SAC = atom(13, 'Prison', 'PRODUCES', 'SACRIFICE', '{4}, {T}, Sacrifice this land: Draw a card.');
const OPEN_SAC = atom(14, 'Coroner', 'PRODUCES', 'SACRIFICE', '{2}{B}, Sacrifice another creature: Draw a card.');
const OWN_DIES = atom(15, 'Avatar', 'CARES_ABOUT', 'PERMANENT_DIES', 'Whenever a creature you control dies, you gain 1 life.', { controller: 'you', permanent_type: 'creature' });
const ANY_DIES = atom(16, 'Ghoul', 'CARES_ABOUT', 'PERMANENT_DIES', 'Whenever a creature dies, put a +1/+1 counter on this creature.', { controller: 'any', permanent_type: 'creature' });

const CREATE_ETB = rule('create-etb', { family: 'PRODUCES', type_key: 'CREATE', where: [] }, { family: 'CARES_ABOUT', type_key: 'ENTERS_BATTLEFIELD' });
const CREATE_SAC = rule('create-sac', { family: 'PRODUCES', type_key: 'CREATE', where: [] }, { family: 'PRODUCES', type_key: 'SACRIFICE' });
const SAC_DIES = rule('sac-dies', { family: 'PRODUCES', type_key: 'SACRIFICE', where: [] }, { family: 'CARES_ABOUT', type_key: 'PERMANENT_DIES' });
const DESTROY_DIES = rule('destroy-dies', { family: 'PRODUCES', type_key: 'DESTROY', where: [] }, { family: 'CARES_ABOUT', type_key: 'PERMANENT_DIES' });
const CLASS_ETB = rule('class-etb', { intrinsic: 'card_type', value: 'Creature' }, { family: 'CARES_ABOUT', type_key: 'ENTERS_BATTLEFIELD' });

describe('object gate (spec rev. 16 sec. 7.9)', () => {
  it('G1: a new token or another card does not supply a trigger on the card itself; a copy does', () => {
    expect(objectGateBlocks(CREATE_ETB, TOKEN, SELF_ETB, NEW)).toBe(true);
    expect(objectGateBlocks(CREATE_ETB, COPY, SELF_ETB, NEW)).toBe(false);
    expect(objectGateBlocks(CREATE_ETB, TOKEN, OTHER_ETB, NEW)).toBe(false);
    expect(objectGateBlocks(CLASS_ETB, null, SELF_ETB, NEW)).toBe(true);
    // A sacrifice outlet acts on an existing object, so it can supply "When this creature dies".
    expect(objectGateBlocks(SAC_DIES, OUTLET, SELF_DIES, NEW)).toBe(false);
  });

  it('G2: a fixed-object sacrifice takes no fodder; an open one does', () => {
    expect(objectGateBlocks(CREATE_SAC, TOKEN, SELF_SAC, NEW)).toBe(true);
    expect(objectGateBlocks(CREATE_SAC, TOKEN, OPEN_SAC, NEW)).toBe(false);
  });

  it('G3: removal of an opponent creature does not supply "a creature you control dies"', () => {
    expect(objectGateBlocks(DESTROY_DIES, REMOVAL, OWN_DIES, NEW)).toBe(true);
    expect(objectGateBlocks(DESTROY_DIES, REMOVAL, ANY_DIES, NEW)).toBe(false);
  });

  it('never changes an anti-synergy rule', () => {
    expect(objectGateBlocks(rule('anti', CREATE_SAC.supply, CREATE_SAC.demand, '-'), TOKEN, SELF_SAC, NEW)).toBe(false);
  });

  it('the index applies the gate only when the build has it', () => {
    const atoms = [TOKEN, COPY, OUTLET, REMOVAL, SELF_ETB, OTHER_ETB, SELF_DIES, SELF_SAC, OPEN_SAC, OWN_DIES, ANY_DIES];
    const ix = (gate: boolean) => new BuildIndex({
      atoms: new Map(atoms.map((a) => [a.id, a])), rules: [CREATE_ETB, CREATE_SAC, SAC_DIES, DESTROY_DIES],
      classes: [], params: new Map(), policy: loadGraphPolicy(), ...(gate ? { objectGate: { newObjectTypes: NEW } } : {}),
    });
    const demandsOf = (x: BuildIndex, a: IndexAtom) => x.edgesFromSupply(a).map((e) => x.atoms.get(e.demand_atom_id)!.oracle_id).sort();
    expect(demandsOf(ix(false), TOKEN)).toEqual(['Coroner', 'Diviner', 'Outlet', 'Prison', 'Watcher']);
    expect(demandsOf(ix(true), TOKEN)).toEqual(['Coroner', 'Outlet', 'Watcher']);
    expect(demandsOf(ix(true), COPY)).toEqual(['Coroner', 'Diviner', 'Outlet', 'Prison', 'Watcher']
      .filter((c) => c !== 'Prison'));
    expect(demandsOf(ix(true), REMOVAL)).toEqual(['Ghoul', 'Martyr'].filter((c) => c !== 'Martyr'));
    expect(ix(true).edgesToDemand(SELF_SAC)).toEqual([]);
  });
});

// G4 and G5 with a small vocabulary in the shape of the CR text (glossary card types and the
// subtype list sentences). The real vocabulary comes from the corpus at build time.
const VOCAB = typeVocab(['Artifact', 'Creature', 'Enchantment', 'Instant', 'Land', 'Sorcery'], [
  { sentence: 'The artifact types are Clue, Equipment, Food, Treasure, and Vehicle.', items: ['Clue', 'Equipment', 'Food', 'Treasure', 'Vehicle'] },
  { sentence: 'The enchantment types are Aura and Role.', items: ['Aura', 'Role'] },
  { sentence: 'The spell types are Adventure and Lesson.', items: ['Adventure', 'Lesson'] },
  { sentence: 'All other creature types are one word long: Goblin, Lizard, Pirate, Rat, Robot, and Sliver.', items: ['Goblin', 'Lizard', 'Pirate', 'Rat', 'Robot', 'Sliver'] },
]);
const typed = (id: number, card: string, family: string, type_key: string, quote: string, params: Record<string, unknown> = {}, own: string[] = []): IndexAtom => ({
  ...atom(id, card, family, type_key, quote, params),
  object_facts: objectFactsOf({ family, type_key, params }, quote, [], own, VOCAB),
});

describe('the card of an event (spec rev. 25 sec. 7.9 G6)', () => {
  const blocks = (s: Record<string, unknown>, d: Record<string, unknown>, version?: number, demandType = 'DISCARD', supplyType = 'DISCARD') => {
    const supply = { family: 'PRODUCES', type_key: supplyType };
    const demand = { family: 'CARES_ABOUT', type_key: demandType };
    const facts = (t: { family: string; type_key: string }, params: Record<string, unknown>) => ({ ...t, object_facts: objectFactsOf({ ...t, params }, 'text', []) });
    return objectGateBlocks(rule('h', { ...supply, where: [] }, demand), facts(supply, s), facts(demand, d), new Set(), null, version);
  };
  const LAND = { card_types: ['land'] };
  it('removes a discard that excludes the card type of the trigger', () => {
    expect(blocks({ card_types: [], excluded_card_types: ['creature', 'land'] }, LAND)).toBe(true);
  });
  it('removes a discard that names other card types', () => {
    expect(blocks({ card_types: ['instant', 'sorcery'], excluded_card_types: [] }, LAND)).toBe(true);
  });
  it('keeps a discard of any card, and a discard that names the card type', () => {
    expect(blocks({ card_types: [], excluded_card_types: [] }, LAND)).toBe(false);
    expect(blocks({ card_types: ['land', 'creature'], excluded_card_types: [] }, LAND)).toBe(false);
  });
  it('keeps a trigger that names no card type', () => {
    expect(blocks({ card_types: [], excluded_card_types: ['land'] }, { card_types: [] })).toBe(false);
  });
  it('removes the edge only when the supply can give none of the card types of the trigger', () => {
    const two = { card_types: ['land', 'creature'] };
    expect(blocks({ card_types: [], excluded_card_types: ['land'] }, two)).toBe(false);
    expect(blocks({ card_types: [], excluded_card_types: ['land', 'creature'] }, two)).toBe(true);
  });
  it('has no effect on a build of version 2, or on another type', () => {
    expect(blocks({ card_types: [], excluded_card_types: ['land'] }, LAND, 2)).toBe(false);
    expect(blocks({ card_types: [], excluded_card_types: ['land'] }, LAND, 3, 'SPELL_CAST')).toBe(false);
    expect(blocks({ card_types: [], excluded_card_types: ['land'] }, LAND, 3, 'DISCARD', 'MILL')).toBe(false);
  });
});

describe('damage that can hit only a player (spec rev. 32 sec. 7.9 G7)', () => {
  const EACH = 'When this creature enters, it deals 1 damage to each opponent.';
  const blocks = (recipient: string, quote = EACH, demandType = 'PERMANENT_DIES', version?: number) => {
    const supply = { family: 'PRODUCES', type_key: 'DAMAGE' };
    const demand = { family: 'CARES_ABOUT', type_key: demandType };
    const s = { ...supply, object_facts: objectFactsOf({ ...supply, params: { amount: 1, recipient } }, quote, []) };
    const d = { ...demand, object_facts: objectFactsOf({ ...demand, params: {} }, 'Whenever another creature dies, draw a card.', []) };
    return objectGateBlocks(rule('h', { ...supply, where: [] }, demand), s, d, new Set(), null, version);
  };
  it('removes damage to a player from "dies" and "leaves the battlefield"', () => {
    for (const r of ['opponent', 'you', 'player']) {
      expect(blocks(r)).toBe(true);
      expect(blocks(r, EACH, 'LEAVES_BATTLEFIELD')).toBe(true);
    }
  });
  it('keeps damage that can hit a creature, and "target player or planeswalker"', () => {
    expect(blocks('creature')).toBe(false);
    expect(blocks('any')).toBe(false);
    expect(blocks('player', 'When this creature enters, it deals 2 damage to target player or planeswalker.')).toBe(false);
  });
  it('has no effect on a build of version 3, or on another demand type', () => {
    expect(blocks('opponent', EACH, 'PERMANENT_DIES', 3)).toBe(false);
    expect(blocks('opponent', EACH, 'DEALT_DAMAGE')).toBe(false);
  });
  it('keeps an atom with no recipient', () => {
    const facts = objectFactsOf({ family: 'PRODUCES', type_key: 'DAMAGE', params: { amount: 1 } }, EACH, []);
    expect(facts.player_damage).toBeUndefined();
  });
});

describe('a discard that only an opponent makes (spec rev. 33 sec. 7.9 G8)', () => {
  const EACH = 'When this creature enters, each opponent discards a card.';
  const blocks = (actor: string, demandType = 'MAYHEM', demandFamily = 'ENABLES', version?: number) => {
    const supply = { family: 'PRODUCES', type_key: 'DISCARD' };
    const demand = { family: demandFamily, type_key: demandType };
    const s = { ...supply, object_facts: objectFactsOf({ ...supply, params: { object: 'any', actor } }, EACH, []) };
    const d = { ...demand, object_facts: objectFactsOf({ ...demand, params: {} }, 'Mayhem {B}', []) };
    return objectGateBlocks(rule('h', { ...supply, where: [] }, demand), s, d, new Set(), null, version);
  };
  it('removes an opponent discard from mayhem', () => {
    expect(blocks('opponent')).toBe(true);
  });
  it('keeps a discard that you can make', () => {
    expect(blocks('you')).toBe(false);
    expect(blocks('any')).toBe(false);
  });
  it('has no effect on a build of version 4, or on another demand type', () => {
    expect(blocks('opponent', 'MAYHEM', 'ENABLES', 4)).toBe(false);
    expect(blocks('opponent', 'DISCARD', 'CARES_ABOUT')).toBe(false);
  });
  it('keeps an atom with no actor', () => {
    const facts = objectFactsOf({ family: 'PRODUCES', type_key: 'DISCARD', params: { object: 'any' } }, EACH, []);
    expect(facts.opponent_discard).toBeUndefined();
  });
});

// spec rev. 34 sec. 7.9. The owner marked these links false on decks 2 and 3 (edge_reports 10 to 58).
describe('a cost reduction of its own card (spec rev. 34 sec. 7.9 G9)', () => {
  const COST = { family: 'ENABLES', type_key: 'COST_REDUCTION' };
  const blocks = (supplyType: string[], quote: string, version?: number) => {
    const [family, type_key] = supplyType as [string, string];
    const supply = { family, type_key };
    const s = { ...supply, object_facts: objectFactsOf({ ...supply, params: {} }, 'Cast it.', []) };
    const d = { ...COST, object_facts: objectFactsOf({ ...COST, params: { object: 'spell' } }, quote, []) };
    return objectGateBlocks(rule('h', { ...supply, where: [] }, COST), s, d, new Set(), null, version);
  };
  const MACABRE = 'This spell costs {2} less to cast if a creature card was put into your graveyard from anywhere this turn.';
  const SURVEY = 'This ability costs {X} less to activate, where X is the number of differently named lands you control.';
  const MOUNTAIN = 'This ability costs {1} less to activate for each Equipment you control.';
  it('removes a cast or an activation from "This spell costs" and "This ability costs"', () => {
    expect(blocks(['ENABLES', 'CAST'], MACABRE)).toBe(true);
    expect(blocks(['ENABLES', 'ACTIVATE'], SURVEY)).toBe(true);
    expect(blocks(['ENABLES', 'CAST'], `Void — ${MACABRE}`)).toBe(true);
  });
  it('keeps an Equip supply on a text that counts Equipment, and no other', () => {
    expect(blocks(['ENABLES', 'EQUIP'], MOUNTAIN)).toBe(false);
    expect(blocks(['ENABLES', 'EQUIP'], SURVEY)).toBe(true);
    expect(blocks(['ENABLES', 'ACTIVATE'], MOUNTAIN)).toBe(true);
  });
  it('keeps a reduction that acts on other cards', () => {
    expect(blocks(['ENABLES', 'CAST'], 'Black spells you cast cost {1} less to cast.')).toBe(false);
    expect(blocks(['ENABLES', 'CAST'], 'Max speed — Spells you cast cost {1} less to cast.')).toBe(false);
  });
  it('version 7 reads "Affinity for" and "This cost is reduced"; version 6 does not', () => {
    for (const quote of ['Affinity for artifacts', 'This cost is reduced by {1} for each instant and sorcery card in your graveyard.']) {
      expect(blocks(['ENABLES', 'CAST'], quote)).toBe(true);
      expect(blocks(['ENABLES', 'CAST'], quote, 6)).toBe(false);
    }
  });
  it('keeps a class edge on "Affinity for"', () => {
    const d = { ...COST, object_facts: objectFactsOf({ ...COST, params: { object: 'spell' } }, 'Affinity for artifacts', []) };
    expect(objectGateBlocks(rule('h', { intrinsic: 'card_type', value: 'Artifact' }, COST), null, d, new Set())).toBe(false);
  });
  it('keeps a class edge: a class tests the condition', () => {
    const d = { ...COST, object_facts: objectFactsOf({ ...COST, params: { object: 'spell' } }, 'This spell costs {2} less to cast if you control a Vehicle.', []) };
    expect(objectGateBlocks(rule('h', { intrinsic: 'subtype', value: 'Vehicle' }, COST), null, d, new Set())).toBe(false);
  });
  it('has no effect on a build of version 5', () => {
    expect(blocks(['ENABLES', 'CAST'], MACABRE, 5)).toBe(false);
  });
});

describe('the card of an opponent and "your graveyard" (spec rev. 34 sec. 7.9 G10)', () => {
  const EMBALM = { family: 'ENABLES', type_key: 'EMBALM' };
  const FORAGE = { family: 'PRODUCES', type_key: 'FORAGE' };
  const DISCARD = { family: 'PRODUCES', type_key: 'DISCARD' };
  const blocks = (actor: string, quote: string, demand = EMBALM, version?: number) => {
    const s = { ...DISCARD, object_facts: objectFactsOf({ ...DISCARD, params: { object: 'any', actor } }, quote, []) };
    const d = { ...demand, object_facts: objectFactsOf({ ...demand, params: {} }, '{T}: Target creature card in your graveyard gains embalm until end of turn.', []) };
    return objectGateBlocks(rule('h', { ...DISCARD, where: [] }, demand), s, d, new Set(), null, version);
  };
  it('removes the discard of an opponent from embalm and forage', () => {
    expect(blocks('opponent', 'When this creature enters, each opponent discards a card.')).toBe(true);
    expect(blocks('opponent', 'When this creature enters, each opponent discards a card.', FORAGE)).toBe(true);
    // Duress: the quote has no word "opponent", so the test reads the `actor` param.
    expect(blocks('opponent', 'That player discards that card.')).toBe(true);
  });
  it('keeps a discard that you make or can make', () => {
    expect(blocks('you', 'As an additional cost to cast this spell, discard a card.')).toBe(false);
    expect(blocks('any', 'Each player discards a card.')).toBe(false);
    expect(blocks('any', 'Target player discards a card.', EMBALM, 7)).toBe(false);
  });
  it('removes an act on the object of an opponent, and keeps your own sacrifice', () => {
    const SAC = { family: 'PRODUCES', type_key: 'SACRIFICE' };
    const d = { ...EMBALM, object_facts: objectFactsOf({ ...EMBALM, params: {} }, 'Embalm {3}{B}', []) };
    const edge = (quote: string) => objectGateBlocks(rule('h', { ...SAC, where: [] }, EMBALM),
      { ...SAC, object_facts: objectFactsOf({ ...SAC, params: {} }, quote, []) }, d, new Set());
    expect(edge('Target opponent sacrifices a creature.')).toBe(true);
    expect(edge('{10}, Sacrifice this creature: It deals 3 damage to any target.')).toBe(false);
  });
  it('has no effect on a build of version 5', () => {
    expect(blocks('opponent', 'When this creature enters, each opponent discards a card.', EMBALM, 5)).toBe(false);
  });
});

describe('an act aimed at an opponent (spec rev. 35 sec. 7.9 G12)', () => {
  const EVIDENCE = { family: 'PRODUCES', type_key: 'COLLECT_EVIDENCE' };
  const DESCENDED = { family: 'CARES_ABOUT', type_key: 'DESCENDED' };
  const MAYHEM = { family: 'ENABLES', type_key: 'MAYHEM' };
  const CRAFT = { family: 'ENABLES', type_key: 'CRAFT' };
  const HARMONIZE = { family: 'ENABLES', type_key: 'HARMONIZE' };
  const WHEN_DISCARD = { family: 'CARES_ABOUT', type_key: 'DISCARD' };
  const DISCARD = { family: 'PRODUCES', type_key: 'DISCARD' };
  const REMOVAL = { family: 'INTERACTION', type_key: 'TARGETED_REMOVAL' };
  const SAC = { family: 'PRODUCES', type_key: 'SACRIFICE' };
  type Side = { family: string; type_key: string };
  const blocks = (supply: Side, params: Record<string, unknown>, quote: string, demand: Side, demandParams: Record<string, unknown> = {}, version?: number) => {
    const s = { ...supply, object_facts: objectFactsOf({ ...supply, params }, quote, []) };
    const d = { ...demand, object_facts: objectFactsOf({ ...demand, params: demandParams }, 'As an additional cost to cast this spell, you may collect evidence 6.', []) };
    return objectGateBlocks(rule('h', { ...supply, where: [] }, demand), s, d, new Set(), null, version);
  };
  const OPPONENT = { actor: 'opponent', card_types: [] };
  const ANY = { actor: 'any', card_types: [] };
  const RAT = 'When this creature enters, each opponent discards a card.';
  const OZAI = 'That player discards two cards.';

  it('removes the discard of an opponent from each "your graveyard" demand', () => {
    for (const d of [EVIDENCE, CRAFT, HARMONIZE, DESCENDED]) expect(blocks(DISCARD, OPPONENT, RAT, d)).toBe(true);
  });
  it('removes a discard on one target player, and keeps it on a discard of an opponent', () => {
    for (const d of [EVIDENCE, CRAFT, HARMONIZE, DESCENDED, MAYHEM]) expect(blocks(DISCARD, ANY, OZAI, d)).toBe(true);
    expect(blocks(DISCARD, ANY, 'Converge — Target player discards X cards, where X is the number of colors of mana spent to cast this spell.', EVIDENCE)).toBe(true);
    expect(blocks(DISCARD, ANY, OZAI, WHEN_DISCARD, { player: 'you' })).toBe(true);
    expect(blocks(DISCARD, ANY, OZAI, WHEN_DISCARD, { player: 'opponent' })).toBe(false);
    expect(blocks(DISCARD, ANY, OZAI, WHEN_DISCARD, { player: 'any' })).toBe(false);
  });
  it('keeps a discard with a reward, and a discard where you can choose yourself too', () => {
    expect(blocks(DISCARD, ANY, 'Target player discards any number of cards, then draws that many cards.', EVIDENCE)).toBe(false);
    expect(blocks(DISCARD, ANY, 'Any number of target players each discard a card.', EVIDENCE)).toBe(false);
    expect(blocks(DISCARD, ANY, 'When this creature enters, each player discards a card.', EVIDENCE)).toBe(false);
  });
  it('removes a removal of any target, and keeps a removal of your own object', () => {
    const quote = 'Destroy target creature.';
    expect(blocks(REMOVAL, { object_controller: 'any', object: 'any', removal_type: 'destroy' }, quote, EVIDENCE)).toBe(true);
    expect(blocks(REMOVAL, { object_controller: 'opponent', object: 'any', removal_type: 'destroy' }, quote, EVIDENCE)).toBe(true);
    expect(blocks(REMOVAL, { object_controller: 'you', object: 'any', removal_type: 'destroy' }, quote, EVIDENCE)).toBe(false);
    expect(blocks(REMOVAL, { object_controller: 'any', object: 'self', removal_type: 'destroy' }, quote, EVIDENCE)).toBe(false);
  });
  it('keeps your own sacrifice when the quote also names an opponent', () => {
    const quote = '{2}, {T}, Sacrifice this artifact: Target opponent loses 3 life.';
    expect(blocks(SAC, { actor: 'you', object: 'self' }, quote, EVIDENCE)).toBe(false);
    expect(blocks(SAC, { actor: 'you', object: 'self' }, quote, DESCENDED)).toBe(false);
    expect(blocks(SAC, { actor: 'opponent' }, 'Target opponent sacrifices a creature of their choice.', EVIDENCE)).toBe(true);
  });
  it('keeps a stat change on your creature when the quote also names an opponent', () => {
    const STAT = { family: 'COMBAT', type_key: 'STAT_CHANGE' };
    const gandalf = "Whenever you cast a noncreature spell, Gandalf gets +1/+1 until end of turn and deals 1 damage to each opponent.";
    expect(blocks(STAT, { sign: '+', scope: 'one' }, gandalf, HARMONIZE)).toBe(false);
  });
  it('has no effect on a build of version 7', () => {
    expect(blocks(DISCARD, OPPONENT, RAT, EVIDENCE, {}, 7)).toBe(false);
    expect(blocks(DISCARD, ANY, OZAI, MAYHEM, {}, 7)).toBe(false);
  });
});

describe('the controller of a target (spec rev. 35 sec. 7.9 G13)', () => {
  const AMASS = { family: 'PRODUCES', type_key: 'AMASS' };
  const CONVOKE = { family: 'ENABLES', type_key: 'CONVOKE' };
  const blocks = (quote: string, version?: number) => objectGateBlocks(rule('h', { ...AMASS, where: [] }, CONVOKE),
    { ...AMASS, object_facts: objectFactsOf({ ...AMASS, params: {} }, quote, []) }, { ...CONVOKE }, new Set(), null, version);
  it('removes an act of the controller of the target', () => {
    expect(blocks("Its controller amasses Goblins X, where X is that creature's power.")).toBe(true);
    expect(blocks('Its controller creates a Clue token.')).toBe(true);
    expect(blocks('Its controller may search their library for a basic land card, put it onto the battlefield tapped, then shuffle.')).toBe(true);
    expect(blocks('For each land destroyed this way, its controller may search their library for a basic land card, put it onto the battlefield tapped, then shuffle.')).toBe(true);
  });
  it('keeps your own act, a trigger on any creature, and a draw that can be for you', () => {
    expect(blocks('Amass Goblins 2.')).toBe(false);
    expect(blocks('Whenever a creature is dealt damage, its controller may exile that many cards from the top of their library.')).toBe(false);
    expect(blocks("If that creature wasn't dealt damage this turn, its controller draws two cards.")).toBe(false);
  });
  it('has no effect on a build of version 7', () => {
    expect(blocks("Its controller amasses Goblins X, where X is that creature's power.", 7)).toBe(false);
  });
});

describe('a duration is not an event (spec rev. 35 sec. 7.9 G14)', () => {
  const SWEEPER = { family: 'INTERACTION', type_key: 'SWEEPER' };
  const LEAVES = { family: 'CARES_ABOUT', type_key: 'LEAVES_BATTLEFIELD' };
  const blocks = (quote: string, version?: number) => objectGateBlocks(rule('h', { ...SWEEPER, where: [] }, LEAVES), { ...SWEEPER },
    { ...LEAVES, object_facts: objectFactsOf({ ...LEAVES, params: {} }, quote, selfNames(['Deep-Cavern Bat'])) }, new Set(), null, version);
  it('removes the edge into "until this creature leaves the battlefield"', () => {
    expect(blocks('You may exile a nonland card from it until this creature leaves the battlefield.')).toBe(true);
    expect(blocks('When this creature enters, exile target tapped creature an opponent controls until this creature leaves the battlefield.')).toBe(true);
    expect(blocks('You may exile a nonland card from it until Deep-Cavern Bat leaves the battlefield.')).toBe(true);
  });
  it('keeps a trigger, and a duration of another kind', () => {
    expect(blocks('When this creature leaves the battlefield, draw a card.')).toBe(false);
    expect(blocks('Void — That creature gets -10/-10 until end of turn instead if a nonland permanent left the battlefield this turn.')).toBe(false);
  });
  it('has no effect on a build of version 7', () => {
    expect(blocks('You may exile a nonland card from it until this creature leaves the battlefield.', 7)).toBe(false);
  });
});

describe('blight below the toughness of the card (spec rev. 35 sec. 7.9 G15)', () => {
  const BLIGHT = { family: 'PRODUCES', type_key: 'BLIGHT' };
  const DIES = { family: 'CARES_ABOUT', type_key: 'PERMANENT_DIES' };
  const ACLAZOTZ = selfNames(['Aclazotz, Deepest Betrayal']);
  const blocks = (blight: string, dies: string, toughness: string | null, version?: number) => objectGateBlocks(rule('h', { ...BLIGHT, where: [] }, DIES),
    { ...BLIGHT, object_facts: objectFactsOf({ ...BLIGHT, params: {} }, blight, []) },
    { ...DIES, object_facts: objectFactsOf({ ...DIES, params: {} }, dies, ACLAZOTZ, [], undefined, [], toughness) }, new Set(), null, version);
  const SELF = 'When Aclazotz dies, return it to the battlefield tapped and transformed under its owner\'s control.';
  const HEX = 'As an additional cost to cast this spell, you may blight 1.';
  it('removes a blight that cannot kill the card', () => {
    expect(blocks(HEX, SELF, '4')).toBe(true);
    expect(blocks('Pay 1 life, Blight 2: Target opponent blights 2.', SELF, '3')).toBe(true);
  });
  it('keeps a blight that can kill the card', () => {
    expect(blocks(HEX, SELF, '1')).toBe(false);
    expect(blocks('Whenever this creature enters or attacks, you may blight 2.', SELF, '2')).toBe(false);
  });
  it('keeps the edge when it cannot decide', () => {
    expect(blocks('As an additional cost to cast this spell, blight X.', SELF, '4')).toBe(false);
    expect(blocks(HEX, SELF, '*')).toBe(false);
    expect(blocks(HEX, SELF, null)).toBe(false);
  });
  it('keeps the edge into a "dies" trigger on another creature', () => {
    expect(blocks(HEX, 'Whenever another creature you control dies, draw a card.', '4')).toBe(false);
  });
  it('has no effect on a build of version 7', () => {
    expect(blocks(HEX, SELF, '4', 7)).toBe(false);
  });
});

describe('two more forms of a reduction of its own ability (spec rev. 36 sec. 7.9 G9)', () => {
  const COST = { family: 'ENABLES', type_key: 'COST_REDUCTION' };
  const EQUIP = { family: 'ENABLES', type_key: 'EQUIP' };
  const facts = (quote: string) => objectFactsOf({ ...COST, params: { object: 'ability' } }, quote, []);
  const blocks = (quote: string, version?: number) => objectGateBlocks(rule('h', { ...EQUIP, where: [] }, COST), { ...EQUIP }, { ...COST, object_facts: facts(quote) }, new Set(), null, version);
  const HEIRLOOM = "For each mana in this ability's activation cost, you may tap an untapped creature you control rather than pay that mana.";
  const QUICKSILVER = 'Power-up — {4}{R}: Put a +1/+1 counter and a double strike counter on Quicksilver.';
  it('removes an Equip supply from Heirloom Epic and Quicksilver, Brash Blur', () => {
    expect(blocks(HEIRLOOM)).toBe(true);
    expect(blocks(QUICKSILVER)).toBe(true);
  });
  it('keeps Equip on a reduction that reads Equip or counts Equipment', () => {
    expect(blocks('Equip abilities you activate that target this creature cost {2} less to activate.')).toBe(false);
    expect(blocks('This ability costs {1} less to activate for each Equipment you control.')).toBe(false);
    expect(blocks('Whenever a nontoken Equipment you control enters, create a token that\'s a copy of it, except it has "This Equipment\'s equip abilities cost {2} less to activate."')).toBe(false);
  });
  it('keeps a class edge', () => {
    expect(objectGateBlocks(rule('h', { intrinsic: 'card_type', value: 'Artifact' }, COST), null, { ...COST, object_facts: facts(HEIRLOOM) }, new Set())).toBe(false);
  });
  it('has no effect on a build of version 8', () => {
    expect(blocks(HEIRLOOM, 8)).toBe(false);
    expect(blocks(QUICKSILVER, 8)).toBe(false);
  });
});

describe('a reward for the target into a crime (spec rev. 37 sec. 7.9 G17)', () => {
  const LOSS = { family: 'PRODUCES', type_key: 'LIFE_LOSS' };
  const CRIME = { family: 'CARES_ABOUT', type_key: 'COMMIT_CRIME' };
  const facts = (a: { family: string; type_key: string }, quote: string, params: Record<string, unknown> = {}) => ({ ...a, object_facts: objectFactsOf({ ...a, params }, quote, []) });
  const blocks = (quote: string, version?: number) => objectGateBlocks(rule('h', { ...LOSS, where: [] }, CRIME), facts(LOSS, quote, { player: 'target' }),
    facts(CRIME, 'Whenever you commit a crime, put a +1/+1 counter on Vadmir.'), new Set(), null, version);

  it('removes "target player draws" and keeps "target player loses"', () => {
    expect(blocks('When this creature enters, target player draws a card and loses 1 life.')).toBe(true);
    expect(blocks('Target player draws two cards and loses 2 life.')).toBe(true);
    expect(blocks('{2}, Sacrifice a Food: Target player loses 2 life.')).toBe(false);
    expect(blocks('If you do, target player loses 2 life and you gain 2 life.')).toBe(false);
  });
  it('keeps damage in the same quote, because that target can be an opponent', () => {
    const DAMAGE = { family: 'PRODUCES', type_key: 'DAMAGE' };
    const quote = 'Converge — Target player draws X cards, Together as One deals X damage to any target, and you gain X life.';
    expect(objectGateBlocks(rule('h', { ...DAMAGE, where: [] }, CRIME), facts(DAMAGE, quote, { recipient: 'any', targeted: true }),
      facts(CRIME, 'Whenever you commit a crime, put a +1/+1 counter on Vadmir.'), new Set())).toBe(false);
  });
  it('acts only on a crime', () => {
    expect(objectGateBlocks(rule('h', { ...LOSS, where: [] }, { family: 'CARES_ABOUT', type_key: 'SPELL_CAST' }),
      facts(LOSS, 'Target player draws two cards and loses 2 life.', { player: 'target' }),
      facts({ family: 'CARES_ABOUT', type_key: 'SPELL_CAST' }, 'Whenever you cast a spell, you gain 1 life.'), new Set())).toBe(false);
  });
  it('has no effect on a build of version 9', () => {
    expect(blocks('Target player draws two cards and loses 2 life.', 9)).toBe(false);
  });
});

describe('a cast into an "enters" demand (spec rev. 36 sec. 7.9 G16)', () => {
  const CAST = { family: 'ENABLES', type_key: 'CAST' };
  const ENTERS = { family: 'CARES_ABOUT', type_key: 'ENTERS_BATTLEFIELD' };
  const V = typeVocab(['Artifact', 'Creature', 'Enchantment', 'Instant', 'Land', 'Sorcery'], [
    { sentence: 'The artifact types are Equipment.', items: ['Equipment'] },
    { sentence: 'The enchantment types are Aura.', items: ['Aura'] },
    { sentence: 'All other creature types are one word long: Ally, Dragon, Drix, Kavu, Villain, Warlock, and Zombie.', items: ['Ally', 'Dragon', 'Drix', 'Kavu', 'Villain', 'Warlock', 'Zombie'] },
  ]);
  const demand = (quote: string, subtype_filter: string, names: string[] = []) => ({ ...ENTERS, object_facts: objectFactsOf({ ...ENTERS, params: { subtype_filter } }, quote, names, [], V) });
  const supply = (quote: string, own: string[] = [], subtypes: string[] = [], type = CAST) => ({ ...type, object_facts: objectFactsOf({ ...type, params: {} }, quote, [], own, V, [], null, subtypes) });
  const blocks = (s: ReturnType<typeof supply>, d: ReturnType<typeof demand>, version?: number) => objectGateBlocks(rule('h', { ...CAST, where: [] }, ENTERS), s, d, new Set(), V, version);
  const VILLAIN = demand('Whenever a Villain you control enters, each opponent loses 1 life and you gain 1 life.', 'Villain');
  const ZOMBIE = demand('Whenever another Zombie you control enters, you gain 1 life.', 'Zombie');
  const CREATURE = demand('Whenever another creature you control enters, you gain 1 life.', '');
  const TINYBONES = "Whenever Tinybones deals combat damage to a player, you may cast target nonland permanent card from that player's graveyard, and mana of any type can be spent to cast that spell.";

  it('removes a cast that gives none of the subtypes of the demand, and keeps it on an open demand', () => {
    expect(blocks(supply(TINYBONES), VILLAIN)).toBe(true);
    expect(blocks(supply('If you do, discover 4.'), VILLAIN)).toBe(true);
    expect(blocks(supply(TINYBONES), CREATURE)).toBe(false);
  });
  it('keeps a cast that names the subtype', () => {
    expect(blocks(supply('You may cast Dragon spells without paying their mana costs.'), demand('Whenever a Dragon you control enters, put a +1/+1 counter on Sarkhan.', 'Dragon'))).toBe(false);
    expect(blocks(supply('Whenever this creature attacks, you may cast an Ally spell from among cards you own exiled with this creature.'), demand('Whenever another Ally you control enters, put a +1/+1 counter on that creature.', 'Ally'))).toBe(false);
    expect(blocks(supply('{T}: You may cast target Zombie creature card from your graveyard this turn.'), ZOMBIE)).toBe(false);
  });
  it('reads the subtypes of the card when the card casts itself', () => {
    expect(blocks(supply('You may cast this card from your graveyard.', ['creature'], ['Human', 'Villain']), VILLAIN)).toBe(false);
    expect(blocks(supply('You may cast this card from your graveyard.', ['creature'], ['Warrior', 'Zombie']), VILLAIN)).toBe(true);
    expect(blocks(supply('You may cast this card from your graveyard if a non-Zombie creature died this turn.', ['creature'], ['Zombie']), ZOMBIE)).toBe(false);
  });
  it('reads Warp and Sneak as a cast of the card itself (CR 702.185a, 702.190a)', () => {
    const warlock = demand('Whenever another Warlock you control enters, you gain 1 life.', 'Warlock');
    expect(blocks(supply('Warp—{B}, Pay 2 life.', ['creature'], ['Drix', 'Warlock']), warlock)).toBe(false);
    expect(blocks(supply('Warp—{B}, Pay 2 life.', ['creature'], ['Drix', 'Warlock']), VILLAIN)).toBe(true);
    expect(blocks(supply('Sneak {B}', ['creature'], ['Villain']), VILLAIN)).toBe(false);
    expect(blocks(supply('Sneak {B}', ['creature'], ['Zombie']), CREATURE)).toBe(false);
  });
  it('tests only the type ENABLES.CAST, so another supply type stays', () => {
    const warp = supply('Warp {1}{R}', ['creature'], ['Zombie'], { family: 'ENABLES', type_key: 'WARP' });
    expect(objectGateBlocks(rule('h', { family: 'ENABLES', type_key: 'WARP', where: [] }, ENTERS), warp, VILLAIN, new Set(), V)).toBe(false);
  });
  it('removes a cast of an instant or a sorcery only', () => {
    expect(blocks(supply('During your turn, you may cast instant and sorcery spells from your graveyard by paying 1 life in addition to their other costs.'), CREATURE)).toBe(true);
    expect(blocks(supply('Whenever The Dawning Archaic attacks, you may cast target instant or sorcery card from your graveyard without paying its mana cost.'), CREATURE)).toBe(true);
    expect(blocks(supply('If an instant or sorcery card is exiled this way, you may cast it for as long as you control this creature, and mana of any type can be spent to cast that spell.'), CREATURE)).toBe(true);
    expect(blocks(supply('You may cast this card from your graveyard.', ['sorcery']), CREATURE)).toBe(true);
  });
  it('keeps a cast that can be a permanent', () => {
    expect(blocks(supply('You may cast creature spells from your graveyard using their sneak abilities.'), CREATURE)).toBe(false);
    expect(blocks(supply('You may cast this card from your graveyard.', ['creature', 'sorcery']), CREATURE)).toBe(false);
    expect(blocks(supply('You may cast an instant, a sorcery or a permanent spell from among them.'), CREATURE)).toBe(false);
    expect(blocks(supply('You may play lands and cast instant and sorcery spells from the top of your library.'), CREATURE)).toBe(false);
  });
  it('reads a named subtype from `subtype_filter`, not from the old fact, and only a word of the CR lists', () => {
    const goddric = 'Celebration — As long as two or more nonland permanents entered the battlefield under your control this turn, Goddric is a Dragon with base power and toughness 4/4, flying, and "{R}: Dragons you control get +1/+0 until end of turn."';
    const facts = demand(goddric, '', ['Goddric']).object_facts;
    expect(facts.object_subtypes).toEqual(['Dragon']);
    expect(facts.enters_subtypes).toEqual([]);
    expect(demand('Whenever another outlaw you control enters, Vial Smasher deals 1 damage to target opponent.', 'outlaw').object_facts.enters_subtypes).toEqual([]);
    expect(VILLAIN.object_facts.enters_subtypes).toEqual(['Villain']);
  });
  it('a card type word beside the subtype accepts any object, but "this creature" is the card itself', () => {
    const hydra = demand('Whenever another Villain and/or artifact you control enters, this creature deals 1 damage to target opponent.', 'Villain');
    expect(hydra.object_facts.enters_subtypes).toEqual([]);
    expect(blocks(supply(TINYBONES), hydra)).toBe(false);
    const kavu = demand('Whenever this creature or another Kavu you control enters, exile the top card of your library.', 'Kavu');
    expect(kavu.object_facts.enters_subtypes).toEqual(['Kavu']);
    expect(blocks(supply(TINYBONES), kavu)).toBe(true);
  });
  it('keeps a class edge, and has no effect on a build of version 8', () => {
    expect(objectGateBlocks(rule('h', { intrinsic: 'subtype', value: 'Villain' }, ENTERS), null, CREATURE, new Set(), V)).toBe(false);
    expect(blocks(supply(TINYBONES), VILLAIN, 8)).toBe(false);
    expect(blocks(supply('During your turn, you may cast instant and sorcery spells from your graveyard by paying 1 life in addition to their other costs.'), CREATURE, 8)).toBe(false);
  });
  it('reads the subtypes of each face of a type line', () => {
    expect(typeLineSubtypes(['Legendary Creature — Human Rogue Villain'], V)).toEqual(['Villain']);
    expect(typeLineSubtypes(['Enchantment // Creature — Drix Warlock', 'Enchantment — Aura'], V)).toEqual(['Aura', 'Drix', 'Warlock']);
    expect(typeLineSubtypes(['Artifact'], V)).toEqual([]);
  });
});

describe('a flashback card and a cast with a limit (spec rev. 34 sec. 7.9 G11)', () => {
  const FB = { family: 'ENABLES', type_key: 'FLASHBACK' };
  const CAST = { family: 'CARES_ABOUT', type_key: 'SPELL_CAST' };
  const DREAM = "Whenever you cast a spell during an opponent's turn, up to one target creature an opponent controls gets -1/-1 until end of turn.";
  const UGIN = "Whenever you cast a colorless spell, exile up to one target permanent that's one or more colors.";
  const blocks = (quote: string, types: string[], colours: string[], demand: string, version?: number) => {
    const s = { ...FB, object_facts: objectFactsOf({ ...FB, params: {} }, quote, [], types, undefined, colours) };
    const d = { ...CAST, object_facts: objectFactsOf({ ...CAST, params: {} }, demand, []) };
    return objectGateBlocks(rule('h', { ...FB, where: [] }, CAST), s, d, new Set(), null, version);
  };
  it('removes a sorcery with flashback from a cast on an opponent\'s turn', () => {
    expect(blocks('Flashback {4}{B}', ['sorcery'], ['B'], DREAM)).toBe(true);
  });
  it('keeps an instant with flashback on that cast', () => {
    expect(blocks('Flashback {1}{R}', ['instant'], ['R'], DREAM)).toBe(false);
  });
  it('removes a coloured card with flashback from a "colorless spell", and keeps a colorless card', () => {
    expect(blocks('Flashback {4}{B}', ['sorcery'], ['B'], UGIN)).toBe(true);
    expect(blocks('Flashback {4}', ['sorcery'], [], UGIN)).toBe(false);
  });
  it('keeps a card that gives flashback to another card', () => {
    const quote = 'Target instant or sorcery card in your graveyard gains flashback until end of turn.';
    expect(blocks(quote, ['sorcery'], ['B'], DREAM)).toBe(false);
    expect(blocks(quote, ['sorcery'], ['B'], UGIN)).toBe(false);
  });
  it('keeps a cast with no limit, and has no effect on a build of version 5', () => {
    expect(blocks('Flashback {4}{B}', ['sorcery'], ['B'], 'Whenever you cast a spell, draw a card.')).toBe(false);
    expect(blocks('Flashback {4}{B}', ['sorcery'], ['B'], DREAM, 5)).toBe(false);
  });
});

describe('card types and subtypes of objects (spec rev. 16 sec. 7.9 G4 and G5)', () => {
  it('reads the card type of each CR subtype list from its sentence', () => {
    expect(VOCAB.subtypes.get('Food')).toBe('artifact');
    expect(VOCAB.subtypes.get('Role')).toBe('enchantment');
    expect(VOCAB.subtypes.get('Goblin')).toBe('creature');
    expect(VOCAB.subtypes.get('Lesson')).toBe('spell');
    expect(phraseTypes('a 1/1 black Rat creature ', VOCAB)).toEqual(['creature']);
    expect(phraseTypes('two Treasure ', VOCAB)).toEqual(['artifact']);
    expect(phraseTypes('another nonland permanent', VOCAB)).toBeNull();
    expect(phraseTypes('two or more instant and/or sorcery ', VOCAB)).toEqual(['instant', 'sorcery']);
  });

  it('reads the object types of tokens, sacrifices and graveyard demands', () => {
    expect(objectTypes('PRODUCES.CREATE', 'When this creature enters, create two Treasure tokens.', {}, [], VOCAB)).toEqual(['artifact']);
    expect(objectTypes('PRODUCES.CREATE', "Create a token that's a copy of target creature you control.", {}, [], VOCAB)).toBeNull();
    expect(objectTypes('PRODUCES.SACRIFICE', '{6}, {T}, Sacrifice this artifact: Put each creature card exiled with this artifact onto the battlefield.', {}, ['artifact'], VOCAB)).toEqual(['artifact']);
    expect(objectTypes('PRODUCES.SACRIFICE', 'As an additional cost to cast this spell, sacrifice an artifact or discard a card.', {}, [], VOCAB)).toEqual(['artifact']);
    expect(objectTypes('ENABLES.RECURSION', '{T}: Return target creature card from your graveyard to the battlefield.', {}, [], VOCAB)).toEqual(['creature']);
    expect(objectTypes('CARES_ABOUT.POPULATED_GRAVEYARD', 'This creature gets +2/+0 for every seven cards in your graveyard.', {}, [], VOCAB)).toBeNull();
    expect(objectTypes('CARES_ABOUT.PERMANENT_DIES', 'Whenever a creature you control dies, draw a card.', { permanent_type: 'creature' }, [], VOCAB)).toEqual(['creature']);
    expect(objectTypes('CARES_ABOUT.PERMANENT_DIES', 'Whenever a permanent you control dies, draw a card.', { permanent_type: 'any' }, [], VOCAB)).toBeNull();
  });

  it('reads the subtypes that a demand requires, and the subtypes of a token', () => {
    expect(objectSubtypes('ENABLES.AFFINITY', 'Affinity for Lizards', VOCAB, [])).toEqual(['Lizard']);
    expect(objectSubtypes('CARES_ABOUT.PERMANENT_DIES', 'Whenever another Goblin you control dies, this creature deals 1 damage to each opponent.', VOCAB, [])).toEqual(['Goblin']);
    // Review pair 109: "creature or Vehicle" accepts any creature, so the subtype does not restrict.
    expect(objectSubtypes('PRODUCES.SACRIFICE', 'Max speed — {B}, Sacrifice another creature or Vehicle: Draw a card.', VOCAB, [])).toBeNull();
    expect(objectSubtypes('PRODUCES.CREATE', 'At the beginning of your upkeep, create two 1/1 colorless Sliver creature tokens.', VOCAB, [])).toEqual(['Sliver']);
    expect(objectSubtypes('PRODUCES.CREATE', 'Create a 1/1 black creature token.', VOCAB, [])).toEqual([]);
  });

  it('G4: a creature token is not fodder for "sacrifice an artifact"; a Treasure token is', () => {
    const tokens = typed(30, 'Troopers', 'PRODUCES', 'CREATE', 'When this creature enters, create a tapped 2/1 black Villain creature token.');
    const treasure = typed(31, 'Dragon', 'PRODUCES', 'CREATE', 'When this creature enters, create two Treasure tokens.');
    const demand = typed(32, 'Answers', 'PRODUCES', 'SACRIFICE', 'As an additional cost to cast this spell, sacrifice an artifact or discard a card.');
    expect(objectGateBlocks(CREATE_SAC, tokens, demand, NEW, VOCAB)).toBe(true);
    expect(objectGateBlocks(CREATE_SAC, treasure, demand, NEW, VOCAB)).toBe(false);
    // Version 1 (build 8) has no G4.
    expect(objectGateBlocks(CREATE_SAC, tokens, demand, NEW, VOCAB, 1)).toBe(false);
  });

  it('G4: a sacrificed artifact does not supply "return target creature card from your graveyard"', () => {
    const vacuum = typed(33, 'Vacuum', 'PRODUCES', 'SACRIFICE', '{6}, {T}, Sacrifice this artifact: Put each creature card exiled with this artifact onto the battlefield.', {}, ['artifact']);
    const raise = typed(34, 'Raise', 'ENABLES', 'RECURSION', '{T}: Return target creature card from your graveyard to the battlefield.');
    const SAC_REC = rule('sac-rec', { family: 'PRODUCES', type_key: 'SACRIFICE', where: [] }, { family: 'ENABLES', type_key: 'RECURSION' });
    expect(objectGateBlocks(SAC_REC, vacuum, raise, NEW, VOCAB)).toBe(true);
  });

  it('G5: Sliver tokens do not supply "Affinity for Lizards"; a Robot token is fodder for "creature or Vehicle"', () => {
    const slivers = typed(35, 'Hivepool', 'PRODUCES', 'CREATE', 'At the beginning of your upkeep, create two 1/1 colorless Sliver creature tokens.');
    const affinity = typed(36, 'Scales', 'ENABLES', 'AFFINITY', 'Affinity for Lizards');
    const CREATE_AFF = rule('create-aff', { family: 'PRODUCES', type_key: 'CREATE', where: [] }, { family: 'ENABLES', type_key: 'AFFINITY' });
    expect(objectGateBlocks(CREATE_AFF, slivers, affinity, NEW, VOCAB)).toBe(true);
    const robot = typed(37, 'Starforge', 'PRODUCES', 'CREATE', '{5}, {T}: Create a 2/2 colorless Robot artifact creature token.');
    const guzzler = typed(38, 'Guzzler', 'PRODUCES', 'SACRIFICE', 'Max speed — {B}, Sacrifice another creature or Vehicle: Draw a card.');
    expect(objectGateBlocks(CREATE_SAC, robot, guzzler, NEW, VOCAB)).toBe(false);
  });
});

describe('specificity part of the weight (spec rev. 16 sec. 7.4)', () => {
  it('keeps 1 for one partner per card or fewer, and falls by log2 for wider rules', () => {
    expect(ruleSpecificity(7, 7, 1940)).toBe(1);
    expect(ruleSpecificity(1940, 1, 1940)).toBe(1);
    expect(ruleSpecificity(306, 290, 1940)).toBeCloseTo(1 / Math.log2(1 + (306 * 290) / 1940), 10);
    expect(ruleSpecificity(306, 290, 1940)).toBeLessThan(0.2);
    expect(ruleSpecificity(5, 5, 0)).toBe(1);
  });

  it('a narrow rule outweighs a wide rule in the index when the policy has the part', () => {
    const wide = Array.from({ length: 40 }, (_, i) => atom(100 + i, `W${i}`, 'PRODUCES', 'CREATE', 'Create a 1/1 token.'));
    const payoffs = Array.from({ length: 40 }, (_, i) => atom(200 + i, `P${i}`, 'PRODUCES', 'SACRIFICE', 'Sacrifice another creature: Draw a card.'));
    const atoms = [...wide, ...payoffs];
    const policy = loadGraphPolicy();
    const ix = (specificity: boolean) => new BuildIndex({
      atoms: new Map(atoms.map((a) => [a.id, a])), rules: [CREATE_SAC], classes: [], params: new Map(),
      policy: { ...policy, weights: { ...policy.weights, specificity } },
    });
    const w = (x: BuildIndex) => x.edgesForCard('W0').out[0]!.weight;
    expect(w(ix(false)).size).toBe(1);
    expect(w(ix(true)).size).toBeCloseTo(1 / Math.log2(1 + (40 * 40) / 80), 10);
  });
});
