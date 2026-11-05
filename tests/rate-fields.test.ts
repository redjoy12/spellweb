import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { atomFields, cardFields, compareSpeed, faceSpeed, readBuildCards, type RateAtom, type RateCard, type RateFace } from '../src/rate/fields.js';

const atom = (family: string, type_key: string, quote: string, params: Record<string, unknown> = {}, id = 1, face_index = 0): RateAtom =>
  ({ id, oracle_id: 'c', face_index, family, type_key, params, quote });
const face = (name: string, type_line: string, oracle_text = '', face_index = 0): RateFace => ({ face_index, name, type_line, oracle_text });
const card = (faces: RateFace[], layout = 'normal'): RateCard => ({ oracle_id: 'c', layout, faces });

const stat = (quote: string, sign = '+') => atomFields(atom('COMBAT', 'STAT_CHANGE', quote, { sign }), undefined);
const token = (quote: string, f?: RateFace) => atomFields(atom('PRODUCES', 'CREATE', quote), f);
const mana = (quote: string, color: string, f?: RateFace) => atomFields(atom('PRODUCES', 'MANA_PRODUCTION', quote, { color }), f);
const limit = (quote: string) => atomFields(atom('INTERACTION', 'TARGETED_REMOVAL', quote, { removal_type: 'destroy' }), undefined);

describe('stat change size', () => {
  it('reads each part with its sign', () => {
    const f = stat('Target creature gets +3/+1 until end of turn.');
    expect([f.stat_power, f.stat_toughness]).toEqual([3, 1]);
    const g = stat('Target creature gets -0/-9999 until end of turn.', '-');
    expect([g.stat_power, g.stat_toughness]).toEqual([0, -9999]);
    expect(Object.is(g.stat_power, 0)).toBe(true);
    const h = stat('Up to one target creature gets -4/-1 until your next turn.', '-');
    expect([h.stat_power, h.stat_toughness]).toEqual([-4, -1]);
  });

  it('takes the size of the atom sign from a quote with two sizes', () => {
    const q = 'Until end of turn, target creature you control gets +1/+1 and target creature an opponent controls gets -1/-1.';
    expect(stat(q, '+').stat_power).toBe(1);
    expect(stat(q, '-').stat_power).toBe(-1);
  });

  it('keeps an X part null and reads the other part', () => {
    const f = stat('Target creature gets +X/+0 and gains first strike until end of turn.');
    expect([f.stat_power, f.stat_toughness, f.notes]).toEqual([null, 0, ['stat:x']]);
    const g = stat('Target creature gets -X/-X until end of turn.', '-');
    expect([g.stat_power, g.stat_toughness]).toEqual([null, null]);
  });

  it('keeps a size that scales null', () => {
    const f = stat('This creature gets +2/+0 for each other Goblin you control.');
    expect([f.stat_power, f.stat_toughness, f.notes]).toEqual([null, null, ['stat:for_each']]);
    expect(stat('Whenever this creature attacks, it gets +1/+0 until end of turn for each attacking creature.').stat_power).toBeNull();
  });

  it('keeps a quote with no size null', () => {
    const f = stat("Double target creature's power until end of turn.");
    expect([f.stat_power, f.stat_toughness, f.notes]).toEqual([null, null, ['stat:no_size']]);
  });

  it('reads a removal atom of the kind minus, and no other removal', () => {
    const q = 'Target creature gets -2/-2 until end of turn.';
    const minus = atomFields(atom('INTERACTION', 'TARGETED_REMOVAL', q, { removal_type: 'minus' }), undefined);
    expect(minus.stat_toughness).toBe(-2);
    expect(minus.target_limit?.head).toBe('creature');
    expect(limit('Destroy target creature.').stat_toughness).toBeNull();
  });
});

describe('token size', () => {
  it('reads the size of the token', () => {
    const f = token('Create a 1/1 red Mercenary creature token with "{T}: Target creature you control gets +1/+0 until end of turn."');
    expect([f.token_power, f.token_toughness]).toEqual([1, 1]);
    expect(token("If you exiled a card this way, create a token that's a copy of that card, except it's a 5/5 black Demon.").token_power).toBe(5);
    expect(token('0: Create a 3/2 colorless Vehicle artifact token with crew 1.').token_toughness).toBe(2);
  });

  it('does not read a stat change as a token size', () => {
    const f = token('Create a 2/2 colorless Wizard Soldier creature token named Cadet, then put a +1/+1 counter on each other Wizard token you control.');
    expect([f.token_power, f.token_toughness]).toEqual([2, 2]);
  });

  it('keeps a token with no size in the text null', () => {
    expect(token('When this creature enters, create a Treasure token.').notes).toEqual(['token:no_size']);
    expect(token("Create a token that's a copy of target Goblin you control.").notes).toEqual(['token:copy']);
    expect(token('Create an X/X black Zombie creature token, where X is the number of cards in your hand.').notes).toEqual(['token:x']);
  });

  it('reads the reminder text after a keyword quote', () => {
    const f = face('Brigade', 'Creature — Goblin', 'Mobilize 1 (Whenever this creature attacks, create a tapped and attacking 1/1 red Warrior creature token. Sacrifice it at the beginning of the next end step.)');
    expect(token('Mobilize 1', f).token_power).toBe(1);
    expect(token('Mobilize 1', face('Other', 'Creature — Goblin', 'Mobilize 1')).notes).toEqual(['token:no_size']);
  });

  it('does not read a size of the reminder text that is not of a token', () => {
    const q = 'When this creature enters, create a Cursed Role token attached to target creature you control.';
    const f = face('Hexmage', 'Creature — Human', `${q} (If you control another Role on it, put that one into the graveyard. Enchanted creature is 1/1.)`);
    expect(token(q, f).notes).toEqual(['token:no_size']);
  });
});

describe('mana amount', () => {
  it('counts symbols and number words', () => {
    expect(mana('{T}: Add {C}{C}.', 'C').mana_amount).toBe(2);
    expect(mana('{T}: Add one mana of any color.', 'any').mana_amount).toBe(1);
    expect(mana('Add ten mana of any one color.', 'any').mana_amount).toBe(10);
    expect(mana('add an additional {R}.', 'R').mana_amount).toBe(1);
  });

  it('gives each colour of a choice or of a pair its own amount', () => {
    expect(mana('{T}: Add {B} or {R}.', 'B').mana_amount).toBe(1);
    expect(mana('{T}: Add {B} or {R}.', 'R').mana_amount).toBe(1);
    expect(mana('{T}, Sacrifice another Goblin: Add {B}{R}.', 'R').mana_amount).toBe(1);
  });

  it('keeps an amount that the text does not fix null', () => {
    expect(mana('Add X mana of any one color, where X is the number of charge counters on it.', 'any').notes).toEqual(['mana:no_amount']);
    expect(mana('Then add that much {R}.', 'R').notes).toEqual(['mana:no_amount']);
    expect(mana('{T}: For each color among monocolored permanents you control, add one mana of that color.', 'any').notes).toEqual(['mana:for_each']);
    expect(mana('', 'B').mana_amount).toBeNull();
    expect(mana('{T}: Add {B}.', 'R').mana_amount).toBeNull();
  });

  it('reads the reminder text of a keyword, and only when it is there', () => {
    const f = face('Rioter', 'Creature — Human', 'Firebending 3 (Whenever this creature attacks, add {R}{R}{R}. This mana lasts until end of combat.)');
    expect(mana('Firebending 3', 'R', f).mana_amount).toBe(3);
    expect(mana('firebending 2', 'R', face('Ran', 'Creature — Dragon', 'firebending 2')).mana_amount).toBeNull();
  });
});

describe('target limit', () => {
  it('reads a number limit', () => {
    expect(limit('Destroy target creature with mana value 3 or less.').target_limit).toEqual({
      head: 'creature', limit: 'with mana value 3 or less', number: { stat: 'mana_value', bound: 'max', value: 3 },
    });
    expect(limit('When Elektra enters, destroy target creature an opponent controls with power 3 or less.').target_limit?.number)
      .toEqual({ stat: 'power', bound: 'max', value: 3 });
    expect(limit('Exile target creature with mana value 3 or greater.').target_limit?.number).toEqual({ stat: 'mana_value', bound: 'min', value: 3 });
  });

  it('reads a limit in words', () => {
    expect(limit('Destroy target green or white creature.').target_limit).toEqual({ head: 'creature', limit: 'green or white', number: null });
    expect(limit('Destroy target non-outlaw creature.').target_limit?.limit).toBe('non-outlaw');
    expect(limit('• Destroy target noncreature, nonland permanent.').target_limit).toEqual({ head: 'permanent', limit: 'noncreature, nonland', number: null });
    expect(limit('Destroy target creature an opponent controls that was dealt damage this turn.').target_limit?.limit).toBe('that was dealt damage this turn');
    expect(limit("Destroy target creature or planeswalker that's blue or red.").target_limit).toEqual({ head: 'creature or planeswalker', limit: "that's blue or red", number: null });
    expect(limit('Exile target nonland permanent an opponent controls with mana value less than or equal to the number of Rats.').target_limit)
      .toEqual({ head: 'permanent', limit: 'nonland with mana value less than or equal to the number of Rats', number: null });
  });

  it('gives no limit when the target has only type words', () => {
    expect(limit('Destroy target creature.').target_limit).toEqual({ head: 'creature', limit: null, number: null });
    expect(limit('Destroy target creature an opponent controls.').target_limit?.limit).toBeNull();
    expect(limit('When Armaggon enters, destroy up to three target creatures.').target_limit?.head).toBe('creature');
    expect(limit('Burn deals 3 damage to any target.').target_limit?.head).toBe('any target');
    expect(limit('Target creature gets -1/-1 and gains menace until end of turn.').target_limit?.head).toBe('creature');
  });

  it('cuts the phrase at the next clause', () => {
    expect(limit('Burn deals 2 damage to target creature and 2 damage to that creature\'s controller.').target_limit?.head).toBe('creature');
    expect(limit('Burn deals X damage to target creature, where X is 2 plus the number of cards in your graveyard.').target_limit?.limit).toBeNull();
  });

  it('gives a value for two targets only when both read the same', () => {
    expect(limit('{6}, {T}, Sacrifice this artifact: Destroy up to one target land, up to one target land.').target_limit?.head).toBe('land');
    expect(limit('Burn deals 2 damage to target creature and 2 damage to up to one other target creature token.').notes).toEqual(['target:several']);
  });

  it('keeps a target that the rule cannot read null', () => {
    expect(limit('If this spell was kicked, that creature gets -5/-5 until end of turn instead.').notes).toEqual(['target:no_target']);
    expect(limit('Destroy target land creature or nonbasic land.').notes).toEqual(['target:unread']);
    expect(limit('Destroy target creature if it has flying.').notes).toEqual(['target:unread']);
  });
});

describe('speed', () => {
  const speedOf = (f: RateFace, atoms: RateAtom[] = [], layout = 'normal') => faceSpeed(card([f], layout), f, atoms);
  const haste = atom('COMBAT', 'HASTE', 'Haste');

  it('reads the cast axis from the type line and Flash', () => {
    expect(speedOf(face('A', 'Instant')).cast).toBe('instant');
    expect(speedOf(face('A', 'Sorcery')).cast).toBe('sorcery');
    expect(speedOf(face('A', 'Artifact — Equipment'), [atom('ENABLES', 'FLASH', 'Flash')]).cast).toBe('instant');
    expect(speedOf(face('A', 'Land — Swamp')).cast).toBeNull();
    expect(speedOf(face('A', 'Instant'), [atom('ENABLES', 'FLASH', 'A has flash as long as you control a Goblin.')]).cast).toBe('instant');
    expect(speedOf(face('A', 'Sorcery'), [atom('ENABLES', 'FLASH', 'A has flash as long as you control a Goblin.')]).cast).toBeNull();
  });

  it('gives no cast value to the back face of a transform card', () => {
    const back = face('B', 'Legendary Creature — Avatar', '', 1);
    const front = face('A', 'Enchantment — Saga');
    expect(faceSpeed(card([front, back], 'transform'), back, []).cast).toBeNull();
    expect(faceSpeed(card([front, back], 'adventure'), back, []).cast).toBe('sorcery');
  });

  it('reads the wait axis from the type line and Haste', () => {
    expect(speedOf(face('A', 'Sorcery')).wait).toBe('now');
    expect(speedOf(face('A', 'Creature — Goblin')).wait).toBe('next_turn');
    expect(speedOf(face('A', 'Creature — Goblin'), [haste]).wait).toBe('now');
    expect(speedOf(face('A', 'Artifact')).wait).toBe('now');
  });

  it('keeps a haste with a condition null, and ignores a haste for another creature', () => {
    const own = atom('COMBAT', 'HASTE', 'This creature has haste as long as you control another Goblin.');
    const named = atom('COMBAT', 'HASTE', 'As long as you have an enduring story, Óin gets +1/+0 and has haste.');
    const other = atom('COMBAT', 'HASTE', 'Slivers you control have double strike and haste.');
    expect(speedOf(face('A', 'Creature — Goblin'), [own]).wait).toBeNull();
    expect(speedOf(face('Óin the Brave', 'Creature — Dwarf'), [named]).wait).toBeNull();
    expect(speedOf(face('A', 'Creature — Sliver'), [other]).wait).toBe('next_turn');
    expect(speedOf(face('The Rat King', 'Creature — Rat'), [atom('COMBAT', 'HASTE', 'They gain haste until end of turn.')]).wait).toBe('next_turn');
  });

  it('reads enters tapped of the face only', () => {
    const plain = atom('CONSTRAINTS', 'ENTERS_TAPPED', 'This creature enters tapped.', { conditional: false });
    const named = atom('CONSTRAINTS', 'ENTERS_TAPPED', 'Whiplash enters tapped.', { conditional: false });
    const unless = atom('CONSTRAINTS', 'ENTERS_TAPPED', 'This land enters tapped unless you control an Equipment.', { conditional: true });
    const others = atom('CONSTRAINTS', 'ENTERS_TAPPED', 'Nonbasic lands enter tapped.', { conditional: true });
    expect(speedOf(face('A', 'Creature — Zombie')).tapped).toBe(false);
    expect(speedOf(face('A', 'Creature — Zombie'), [plain]).tapped).toBe(true);
    expect(speedOf(face('Whiplash, Vengeful Engineer', 'Creature — Human'), [named]).tapped).toBe(true);
    expect(speedOf(face('A', 'Land'), [unless]).tapped).toBeNull();
    expect(speedOf(face('A', 'Creature — Human'), [others]).tapped).toBe(false);
  });

  it('reads the limit of an activated ability, and not of a quoted ability', () => {
    const sorcery = atom('CONSTRAINTS', 'TIMING', 'Activate only as a sorcery.');
    const yourTurn = atom('CONSTRAINTS', 'TIMING', 'Activate only during your turn and only once each turn.');
    const onceEach = atom('CONSTRAINTS', 'TIMING', 'Activate only once each turn.');
    const quoted = atom('CONSTRAINTS', 'TIMING', 'Create a 1/1 red Mercenary creature token with "{T}: Target creature gets +1/+0 until end of turn. Activate only as a sorcery."');
    const equip = atom('CONSTRAINTS', 'TIMING', 'Equip {5}');
    expect(speedOf(face('A', 'Creature — Goblin'), [sorcery]).ability_limit).toBe(true);
    expect(speedOf(face('A', 'Creature — Goblin'), [yourTurn]).ability_limit).toBe(true);
    expect(speedOf(face('A', 'Creature — Goblin'), [onceEach]).ability_limit).toBe(false);
    expect(speedOf(face('A', 'Enchantment'), [quoted]).ability_limit).toBe(false);
    expect(speedOf(face('A', 'Artifact — Equipment', 'Equip {5} ({5}: Attach to target creature you control. Equip only as a sorcery.)'), [equip]).ability_limit).toBe(true);
  });

  it('orders two faces only when no axis trades against another', () => {
    const instant = speedOf(face('A', 'Instant'));
    const sorcery = speedOf(face('B', 'Sorcery'));
    const creature = speedOf(face('C', 'Creature — Goblin'));
    const flashCreature = speedOf(face('D', 'Creature — Goblin'), [atom('ENABLES', 'FLASH', 'Flash')]);
    const hasteCreature = speedOf(face('E', 'Creature — Goblin'), [haste]);
    expect(compareSpeed(instant, sorcery)).toBe(1);
    expect(compareSpeed(sorcery, instant)).toBe(-1);
    expect(compareSpeed(sorcery, sorcery)).toBe(0);
    expect(compareSpeed(hasteCreature, creature)).toBe(1);
    expect(compareSpeed(flashCreature, creature)).toBe(1);
    expect(compareSpeed(flashCreature, hasteCreature)).toBeNull();
  });

  it('gives no order when an axis is unread', () => {
    const land = speedOf(face('A', 'Land'));
    expect(compareSpeed(land, speedOf(face('B', 'Sorcery')))).toBeNull();
  });
});

describe('readBuildCards', () => {
  it('reads the atoms of one build, with the faces of each card', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE cards (oracle_id TEXT, layout TEXT, name TEXT, type_line TEXT, oracle_text TEXT);
      CREATE TABLE card_faces (oracle_id TEXT, face_index INTEGER, name TEXT, type_line TEXT, oracle_text TEXT);
      CREATE TABLE atoms (id INTEGER, oracle_id TEXT, face_index INTEGER, family TEXT, type_key TEXT, params_json TEXT, quote TEXT);
      CREATE TABLE graph_build_atoms (build_id INTEGER, atom_id INTEGER);
      INSERT INTO cards VALUES ('one', 'normal', 'Stab', 'Instant', 'Target creature gets -2/-2.'), ('two', 'adventure', 'A // B', 'Creature // Sorcery', NULL);
      INSERT INTO card_faces VALUES ('two', 0, 'A', 'Creature', 'Haste'), ('two', 1, 'B', 'Sorcery', 'Draw a card.');
      INSERT INTO atoms VALUES (1, 'one', 0, 'COMBAT', 'STAT_CHANGE', '{"sign":"-"}', 'Target creature gets -2/-2.'),
        (2, 'two', 1, 'PRODUCES', 'DRAW', '{}', 'Draw a card.'), (3, 'one', 0, 'COMBAT', 'HASTE', '{}', 'Haste');
      INSERT INTO graph_build_atoms VALUES (7, 1), (7, 2), (8, 3);
    `);
    const read = readBuildCards(db, 7);
    expect(read.map((r) => [r.card.oracle_id, r.card.layout, r.card.faces.length, r.atoms.map((a) => a.id)]))
      .toEqual([['one', 'normal', 1, [1]], ['two', 'adventure', 2, [2]]]);
    expect(read[0]!.atoms[0]!.params).toEqual({ sign: '-' });
    expect(read[0]!.card.faces[0]).toEqual({ face_index: 0, name: 'Stab', type_line: 'Instant', oracle_text: 'Target creature gets -2/-2.' });
    db.close();
  });
});

describe('cardFields', () => {
  it('gives each atom the reminder text of its own face', () => {
    const front = face('A', 'Creature — Goblin', 'Haste');
    const back = face('B', 'Sorcery — Adventure', 'Firebending 2 (Whenever this creature attacks, add {R}{R}.)', 1);
    const atoms = [atom('COMBAT', 'HASTE', 'Haste', {}, 1, 0), atom('PRODUCES', 'MANA_PRODUCTION', 'Firebending 2', { color: 'R' }, 2, 1)];
    const f = cardFields(card([front, back], 'adventure'), atoms);
    expect(f.atoms.get(2)?.mana_amount).toBe(2);
    expect(f.speed.map((s) => [s.cast, s.wait])).toEqual([['sorcery', 'now'], ['sorcery', 'now']]);
  });

  it('leaves each field of another kind of atom null', () => {
    const f = atomFields(atom('PRODUCES', 'DRAW', 'Target creature gets +1/+1. Add {B}.'), undefined);
    expect(f).toEqual({ stat_power: null, stat_toughness: null, token_power: null, token_toughness: null, mana_amount: null, target_limit: null, notes: [] });
  });
});
