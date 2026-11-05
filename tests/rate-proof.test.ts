import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/client.js';
import { cardFields, type RateCard } from '../src/rate/fields.js';
import { groupKey, kindKey, loadGroupInput, makeGroups, rewardTest, type GroupInput, type RewardAtom, type TypeRole } from '../src/rate/groups.js';
import {
  alignAtoms, bareWords, bodyOrder, cardClasses, classifyGroups, classifyPair, costOrder, deckDemandTest, demandTest, fieldCheck, limitOrder, linkGap, loadProofCards, maskNumbers,
  speedOrder, targetCount, type LinkFacts, type LinkSource, type ProofCard, type ProofFace,
} from '../src/rate/proof.js';

const value = { kind: 'value' } as const;
const role = (family: string, type_key: string, r: TypeRole['role'], resources: TypeRole['resources'] = [value], status: TypeRole['status'] = 'accepted'): TypeRole =>
  ({ family, type_key, role: r, status, resources });
const roles: TypeRole[] = [
  role('PRODUCES', 'CARD_DRAW', 'supply'),
  role('PRODUCES', 'DAMAGE', 'supply'),
  role('PRODUCES', 'LIFE_LOSS', 'supply'),
  role('COMBAT', 'STAT_CHANGE', 'both'),
  role('COMBAT', 'FIRST_STRIKE', 'supply'),
  role('INTERACTION', 'TARGETED_REMOVAL', 'both'),
  role('CARES_ABOUT', 'SPELL_CAST', 'demand', []),
  role('CARES_ABOUT', 'ENTERS_BATTLEFIELD', 'demand', []),
  role('ENABLES', 'COST_REDUCTION', 'demand', []),
  role('CARES_ABOUT', 'PERMANENT_DIES', 'demand', [], 'disputed'),
  role('ENABLES', 'FLASH', 'none', []),
];
const reward = rewardTest(roles);
const condition = deckDemandTest(roles);

let nextId = 1;
const atom = (oracle_id: string, type: string, params: RewardAtom['params'], quote: string, face_index = 0): RewardAtom => {
  const [family, type_key] = type.split('.') as [string, string];
  return { id: nextId++, oracle_id, face_index, family, type_key, params, quote, kind: 'other' };
};

interface Spec {
  id: string; cost?: string | null; type?: string; text?: string; atoms?: RewardAtom[]; power?: string; toughness?: string;
  colours?: string[]; extra_faces?: Array<Partial<ProofFace>>; layout?: string;
}
function card(s: Spec): ProofCard {
  const name = `Card ${s.id}`;
  const first: ProofFace = {
    face_index: 0, name, type_line: s.type ?? 'Instant', oracle_text: s.text ?? '', mana_cost: s.cost === undefined ? '{1}{B}' : s.cost, power: s.power ?? null, toughness: s.toughness ?? null,
  };
  const faces = [first, ...(s.extra_faces ?? []).map((f, i) => ({ ...first, face_index: i + 1, name: `${name} back`, ...f }))];
  const rate: RateCard = { oracle_id: s.id, layout: s.layout ?? 'normal', faces };
  const atoms = s.atoms ?? [];
  const { atoms: fields, speed } = cardFields(rate, atoms);
  return { oracle_id: s.id, name, layout: rate.layout, color_identity: s.colours ?? ['B'], faces, atoms, fields, speed };
}
const stat = (id: string, n: number, cost?: string) => card({
  id, cost, text: `Target creature gets -${n}/-${n} until end of turn.`,
  atoms: [atom(id, 'COMBAT.STAT_CHANGE', { sign: '-', scope: 'one' }, `Target creature gets -${n}/-${n} until end of turn.`)],
});
const removal = (id: string, words: string, cost?: string) => card({
  id, cost, text: `Destroy ${words}.`, atoms: [atom(id, 'INTERACTION.TARGETED_REMOVAL', { removal_type: 'destroy' }, `Destroy ${words}.`)],
});

const noFacts = (): LinkFacts => ({ out: new Set(), in: new Set(), anti: new Set(), class_in: new Set(), class_of: new Set() });
const noLinks: LinkSource = () => noFacts();
const linksOf = (m: Record<string, Partial<LinkFacts>>): LinkSource => (id) => ({ ...noFacts(), ...m[id] });
const ctx = { reward, condition, links: noLinks };

describe('targetCount', () => {
  it('reads the count words', () => {
    expect(targetCount('Destroy target creature.')).toEqual({ min: 1, max: 1 });
    expect(targetCount('~ deals 2 damage to any target.')).toEqual({ min: 1, max: 1 });
    expect(targetCount('Destroy up to two target creatures.')).toEqual({ min: 0, max: 2 });
    expect(targetCount('Return up to six target creature cards.')).toEqual({ min: 0, max: 6 });
    expect(targetCount('Tap two target creatures.')).toEqual({ min: 2, max: 2 });
    expect(targetCount('~ deals 2 damage divided as you choose among one or two targets.')).toEqual({ min: 1, max: 2 });
    expect(targetCount('Gain control of target creature until end of turn.')).toEqual({ min: 1, max: 1 });
  });
  it('adds each word "target"', () => {
    expect(targetCount('Destroy target creature and target artifact.')).toEqual({ min: 2, max: 2 });
    expect(targetCount('~ deals 6 damage to target creature and 2 damage to up to one target creature token.')).toEqual({ min: 1, max: 2 });
  });
  it('gives 0 with no word "target", and that is a read value', () => {
    expect(targetCount('Each creature gets -1/-1 until end of turn.')).toEqual({ min: 0, max: 0 });
  });
  it('stays null on a word that it cannot read', () => {
    for (const q of ['Tap any number of target creatures.', 'Tap X target creatures.', 'Whenever you cast a spell that targets a creature, draw a card.', 'You may choose new targets for the copy.',
      'Whenever this creature becomes the target of a spell, draw a card.', 'Destroy target artifact or target enchantment.']) {
      expect(targetCount(q)).toBeNull();
    }
  });
  it('reads no reminder text', () => {
    expect(targetCount('Fight. (Target creature fights target creature.)')).toEqual({ min: 0, max: 0 });
  });
});

describe('the words of a proof', () => {
  it('removes reminder text and names, and keeps the numbers', () => {
    expect(bareWords('Grim Bolt deals 3 damage. (It stays.)\nDraw a card.', ['Grim Bolt'])).toBe('~ deals 3 damage. Draw a card.');
  });
  it('masks digits, X and number words, and two digits too', () => {
    expect(maskNumbers('Draw two cards, then gets +10/+X and deals 3.')).toBe('Draw N cards, then gets +N/+N and deals N.');
  });
});

describe('costOrder', () => {
  const c = (cost: string | null, colours = ['B']) => ({ faces: [{ mana_cost: cost } as ProofFace], color_identity: colours });
  it('a lower mana value is better', () => {
    expect(costOrder(c('{1}{B}'), c('{2}{B}'))).toBe(1);
    expect(costOrder(c('{2}{B}'), c('{1}{B}'))).toBe(-1);
  });
  it('fewer coloured symbols at the same mana value is better', () => {
    expect(costOrder(c('{2}{B}'), c('{1}{B}{B}'))).toBe(1);
  });
  it('a lower mana value with more coloured symbols is a trade', () => {
    expect(costOrder(c('{B}{B}'), c('{3}{B}'))).toBeNull();
  });
  it('the same cost is 0, also with a symbol that the rule cannot read', () => {
    expect(costOrder(c('{X}{B}'), c('{X}{B}'))).toBe(0);
    expect(costOrder(c('{B/R}'), c('{B/R}'))).toBe(0);
  });
  it('an {X} or a hybrid in one cost is unread', () => {
    expect(costOrder(c('{X}{B}'), c('{3}{B}'))).toBeNull();
    expect(costOrder(c('{B/R}'), c('{2}{B}'))).toBeNull();
    expect(costOrder(c('{2/R}'), c('{2}{R}', ['R']))).toBeNull();
  });
  it('fewer colours is better, and other colours are a trade', () => {
    expect(costOrder(c('{2}', []), c('{1}{B}'))).toBe(1);
    expect(costOrder(c('{1}{R}', ['R']), c('{1}{B}'))).toBeNull();
  });
});

describe('bodyOrder', () => {
  const b = (power: string | null, toughness: string | null) => ({ faces: [{ power, toughness } as ProofFace] });
  it('reads both numbers', () => {
    expect(bodyOrder(b('3', '3'), b('2', '3'))).toBe(1);
    expect(bodyOrder(b('2', '2'), b('2', '3'))).toBe(-1);
    expect(bodyOrder(b('3', '1'), b('2', '2'))).toBeNull();
  });
  it('agrees a star only with a star', () => {
    expect(bodyOrder(b('*', '*'), b('*', '*'))).toBe(0);
    expect(bodyOrder(b('*', '2'), b('1', '2'))).toBeNull();
  });
  it('no body on both cards is 0', () => {
    expect(bodyOrder(b(null, null), b(null, null))).toBe(0);
  });
});

describe('speedOrder', () => {
  const flash = atom('f', 'ENABLES.FLASH', {}, 'Flash');
  it('reads an instant against a sorcery', () => {
    expect(speedOrder(card({ id: 'i' }), card({ id: 's', type: 'Sorcery' }))).toBe(1);
  });
  it('a Flash creature against a Haste creature is null, because each wins on one axis', () => {
    const a = card({ id: 'f', type: 'Creature — Rat', text: 'Flash', atoms: [flash], power: '1', toughness: '1' });
    const b = card({ id: 'h', type: 'Creature — Rat', text: 'Haste', atoms: [atom('h', 'COMBAT.HASTE', {}, 'Haste')], power: '1', toughness: '1' });
    expect(speedOrder(a, b)).toBeNull();
  });
  it('another count of faces is null', () => {
    expect(speedOrder(card({ id: 'a' }), card({ id: 'b', extra_faces: [{}] }))).toBeNull();
  });
});

describe('limitOrder', () => {
  const l = (limit: string | null, number: { stat: 'mana_value'; bound: 'max' | 'min'; value: number } | null = null, head = 'creature') => ({ head, limit, number });
  it('no limit is wider than a limit on one head', () => {
    expect(limitOrder(l(null), l('nonblack'))).toBe(1);
    expect(limitOrder(l('nonblack'), l(null))).toBe(-1);
  });
  it('two number limits compare by value', () => {
    const max = (n: number) => l(`with mana value ${n} or less`, { stat: 'mana_value', bound: 'max', value: n });
    const min = (n: number) => l(`with mana value ${n} or greater`, { stat: 'mana_value', bound: 'min', value: n });
    expect(limitOrder(max(4), max(3))).toBe(1);
    expect(limitOrder(min(2), min(3))).toBe(1);
    expect(limitOrder(max(3), max(3))).toBe(0);
  });
  it('other words, another head or a null field stay unread', () => {
    expect(limitOrder(l('nonblack'), l('nonwhite'))).toBeNull();
    expect(limitOrder(l(null), l(null, null, 'creature or planeswalker'))).toBeNull();
    expect(limitOrder(null, l(null))).toBeNull();
  });
});

describe('fieldCheck', () => {
  it('same words at a lower cost pass', () => {
    expect(fieldCheck(stat('a', 2, '{B}'), stat('b', 2, '{1}{B}'), reward)).toEqual({ ok: true, gains: ['cost'] });
  });
  it('a bigger size passes, with the size in the gains', () => {
    const r = fieldCheck(stat('a', 4), stat('b', 3), reward);
    expect(r).toEqual({ ok: true, gains: ['stat power 4 against 3', 'stat toughness 4 against 3'] });
  });
  it('a bigger size at a higher cost fails in each order', () => {
    expect(fieldCheck(stat('a', 4, '{2}{B}'), stat('b', 3, '{1}{B}'), reward)).toEqual({ ok: false, reason: 'cost_higher' });
    expect(fieldCheck(stat('b', 3, '{1}{B}'), stat('a', 4, '{2}{B}'), reward)).toEqual({ ok: false, reason: 'field_lower' });
  });
  it('the same card gives no gain', () => {
    expect(fieldCheck(stat('a', 3), stat('b', 3), reward)).toEqual({ ok: false, reason: 'no_gain' });
  });
  it('another type word fails, also on a subtype', () => {
    const a = card({ id: 'a', type: 'Creature — Rat', text: 'Haste', power: '2', toughness: '2' });
    const b = card({ id: 'b', type: 'Creature — Zombie', text: 'Haste', power: '1', toughness: '1' });
    expect(fieldCheck(a, b, reward)).toEqual({ ok: false, reason: 'type_words' });
  });
  it('a type with a printed number that the record lacks fails', () => {
    const a = card({ id: 'a', type: 'Legendary Planeswalker — Liliana', cost: '{1}{B}', text: 'Draw.' });
    const b = card({ id: 'b', type: 'Legendary Planeswalker — Liliana', cost: '{2}{B}', text: 'Draw.' });
    expect(fieldCheck(a, b, reward)).toEqual({ ok: false, reason: 'unread_size' });
  });
  it('more power and toughness is a gain, and less is a fail', () => {
    const a = card({ id: 'a', type: 'Creature — Rat', text: 'Haste', power: '3', toughness: '2' });
    const b = card({ id: 'b', type: 'Creature — Rat', text: 'Haste', power: '2', toughness: '2' });
    expect(fieldCheck(a, b, reward)).toEqual({ ok: true, gains: ['power or toughness'] });
    expect(fieldCheck(b, a, reward)).toEqual({ ok: false, reason: 'body_lower' });
  });
  it('a size that goes both ways is a trade, not a proof', () => {
    const make = (id: string, s: string) => card({ id, text: `Target creature gets ${s} until end of turn.`, atoms: [atom(id, 'COMBAT.STAT_CHANGE', { sign: '+' }, `Target creature gets ${s} until end of turn.`)] });
    expect(fieldCheck(make('a', '+2/+0'), make('b', '+1/+1'), reward)).toEqual({ ok: false, reason: 'unread_field' });
  });
  it('a smaller cost atom is a gain', () => {
    const make = (id: string, n: number) => card({ id, text: `Draw a card. You lose ${n} life.`, atoms: [
      atom(id, 'PRODUCES.CARD_DRAW', { amount: 1 }, 'Draw a card.'), atom(id, 'PRODUCES.LIFE_LOSS', { player: 'you', amount: n }, `You lose ${n} life.`),
    ] });
    expect(fieldCheck(make('a', 1), make('b', 2), reward)).toEqual({ ok: true, gains: ['amount 1 against 2'] });
    expect(fieldCheck(make('b', 2), make('a', 1), reward)).toEqual({ ok: false, reason: 'field_lower' });
  });
  it('a size on an atom that is neither reward nor cost is unread', () => {
    const make = (id: string, n: number) => card({ id, text: `Reveal ${n} cards.`, atoms: [atom(id, 'ENABLES.REVEAL', { amount: n }, `Reveal ${n} cards.`)] });
    expect(fieldCheck(make('a', 2), make('b', 1), reward)).toEqual({ ok: false, reason: 'unread_field' });
  });
  it('a number that no field reads fails, when one quote holds a read number too', () => {
    const make = (id: string, x: number, y: number) => card({ id, text: `~ deals ${x} damage to target creature and ${y} damage to you.`, atoms: [
      atom(id, 'PRODUCES.DAMAGE', { amount: x }, `~ deals ${x} damage to target creature and ${y} damage to you.`),
    ] });
    expect(fieldCheck(make('a', 4, 1), make('b', 3, 2), reward)).toEqual({ ok: false, reason: 'unread_field' });
    expect(fieldCheck(make('a', 4, 1), make('b', 3, 1), reward)).toEqual({ ok: true, gains: ['amount 4 against 3'] });
  });
  it('a number outside each atom fails on the words', () => {
    const make = (id: string, n: number) => card({ id, cost: id === 'a' ? '{B}' : '{1}{B}', text: `Draw a card. Scry ${n}.`, atoms: [atom(id, 'PRODUCES.CARD_DRAW', { amount: 1 }, 'Draw a card.')] });
    expect(fieldCheck(make('a', 1), make('b', 2), reward)).toEqual({ ok: false, reason: 'text_differs' });
  });
  it('extra words on the better card fail', () => {
    const a = card({ id: 'a', text: 'Draw a card. Scry 1.', atoms: [atom('a', 'PRODUCES.CARD_DRAW', { amount: 1 }, 'Draw a card.')], cost: '{B}' });
    const b = card({ id: 'b', text: 'Draw a card.', atoms: [atom('b', 'PRODUCES.CARD_DRAW', { amount: 1 }, 'Draw a card.')], cost: '{1}{B}' });
    expect(fieldCheck(a, b, reward)).toEqual({ ok: false, reason: 'text_differs' });
  });
  it('a number in a second atom of one sentence needs only one field', () => {
    const make = (id: string, n: number) => {
      const q = `Target creature gets +${n}/+0 and gains first strike until end of turn.`;
      return card({ id, text: q, atoms: [atom(id, 'COMBAT.STAT_CHANGE', { sign: '+' }, q), atom(id, 'COMBAT.FIRST_STRIKE', {}, q)] });
    };
    expect(fieldCheck(make('a', 3), make('b', 2), reward)).toEqual({ ok: true, gains: ['stat power 3 against 2'] });
  });
  it('a field proves a limit in the words', () => {
    const r = fieldCheck(removal('a', 'target creature'), removal('b', 'target creature with mana value 3 or less'), reward);
    expect(r).toEqual({ ok: true, gains: ['target limit "none" against "with mana value 3 or less"'] });
  });
  it('a field proves a wider number limit', () => {
    const r = fieldCheck(removal('a', 'target creature with mana value 4 or less'), removal('b', 'target creature with mana value 3 or less'), reward);
    expect(r).toEqual({ ok: true, gains: ['target limit "with mana value 4 or less" against "with mana value 3 or less"'] });
  });
  it('limits with other words fail', () => {
    expect(fieldCheck(removal('a', 'target nonblack creature'), removal('b', 'target nonwhite creature'), reward)).toEqual({ ok: false, reason: 'unread_field' });
  });
  it('a speed field proves a keyword line', () => {
    const body = { type: 'Creature — Rat', power: '1', toughness: '1' };
    const a = card({ ...body, id: 'a', text: 'Flash\nDraw a card.', atoms: [atom('a', 'ENABLES.FLASH', {}, 'Flash'), atom('a', 'PRODUCES.CARD_DRAW', { amount: 1 }, 'Draw a card.')] });
    const b = card({ ...body, id: 'b', text: 'Draw a card.', atoms: [atom('b', 'PRODUCES.CARD_DRAW', { amount: 1 }, 'Draw a card.')] });
    expect(fieldCheck(a, b, reward)).toEqual({ ok: true, gains: ['speed'] });
  });
  it('another count of faces or another layout fails', () => {
    expect(fieldCheck(card({ id: 'a', text: 'x' }), card({ id: 'b', text: 'x', extra_faces: [{}] }), reward)).toEqual({ ok: false, reason: 'faces_differ' });
    expect(fieldCheck(card({ id: 'a', text: 'x' }), card({ id: 'b', text: 'x', layout: 'saga' }), reward)).toEqual({ ok: false, reason: 'faces_differ' });
  });
});

describe('alignAtoms', () => {
  it('pairs atoms of one key in order, and an atom with no partner stays out', () => {
    const a = [atom('a', 'PRODUCES.CARD_DRAW', { amount: 1 }, 'x'), atom('a', 'PRODUCES.CARD_DRAW', { amount: 2 }, 'y'), atom('a', 'PRODUCES.DAMAGE', {}, 'z')];
    const b = [atom('b', 'PRODUCES.CARD_DRAW', { amount: 3 }, 'p')];
    expect(alignAtoms(a, b).map(([x, y]) => [x.quote, y.quote])).toEqual([['x', 'p']]);
  });
});

describe('linkGap', () => {
  const a = stat('a', 4);
  const b = stat('b', 3);
  it('is empty when the stronger card has each link', () => {
    expect(linkGap(a, b, linksOf({ a: { out: new Set(['c', 'd']) }, b: { out: new Set(['c']) } }))).toEqual([]);
  });
  it('names a link of the weaker card, in each direction', () => {
    expect(linkGap(a, b, linksOf({ b: { out: new Set(['c']) } }))).toEqual(['out c']);
    expect(linkGap(a, b, linksOf({ b: { in: new Set(['c']) } }))).toEqual(['in c']);
  });
  it('does not take a link in for a link out', () => {
    expect(linkGap(a, b, linksOf({ a: { in: new Set(['c']) }, b: { out: new Set(['c']) } }))).toEqual(['out c']);
  });
  it('reads a class on each side', () => {
    expect(linkGap(a, b, linksOf({ b: { class_in: new Set(['k']) } }))).toEqual(['class_in k']);
    expect(linkGap(a, b, linksOf({ b: { class_of: new Set(['k']) } }))).toEqual(['class_of k']);
  });
  it('a `-` pair goes the other way: the stronger card has none that the weaker card lacks', () => {
    expect(linkGap(a, b, linksOf({ a: { anti: new Set(['c']) } }))).toEqual(['anti c']);
    expect(linkGap(a, b, linksOf({ b: { anti: new Set(['c']) } }))).toEqual([]);
  });
  it('the two cards count as one card, so a link to itself agrees with a link to the other card', () => {
    expect(linkGap(a, b, linksOf({ a: { out: new Set(['b']) }, b: { out: new Set(['b']) } }))).toEqual([]);
    expect(linkGap(a, b, linksOf({ b: { out: new Set(['b']) } }))).toEqual(['out this pair']);
  });
});

describe('classifyPair', () => {
  it('gives a proof, with the stronger card first in either order', () => {
    for (const [x, y] of [[stat('a', 4), stat('b', 3)], [stat('b', 3), stat('a', 4)]] as const) {
      const r = classifyPair(x, y, ctx);
      expect(r).toMatchObject({ a: 'a', b: 'b', class: 'dominated_in_pool', reason: 'proof', link_gap: [] });
    }
  });
  it('fails the proof when only the weaker card has a link', () => {
    const r = classifyPair(stat('a', 4), stat('b', 3), { ...ctx, links: linksOf({ b: { out: new Set(['c']) } }) });
    expect(r).toMatchObject({ a: 'a', b: 'b', class: 'not_comparable', reason: 'link_gap', link_gap: ['out c'] });
    expect(r.gains).toHaveLength(2);
  });
  it('reads links only after the field check passes', () => {
    const r = classifyPair(stat('a', 3), stat('b', 3), { ...ctx, links: () => { throw new Error('no link read'); } });
    expect(r).toMatchObject({ class: 'not_comparable', reason: 'no_gain' });
  });
  it('a trade of speed against cost stays not_comparable, also with a condition on one card', () => {
    const fast = card({ id: 'a', cost: '{1}{B}{B}', text: 'Draw a card.', atoms: [atom('a', 'PRODUCES.CARD_DRAW', {}, 'Draw a card.')] });
    const slow = card({ id: 'b', cost: '{1}{B}', type: 'Sorcery', text: 'Draw a card.', atoms: [
      atom('b', 'PRODUCES.CARD_DRAW', {}, 'Draw a card.'), atom('b', 'CARES_ABOUT.SPELL_CAST', { subject: 'any' }, 'Whenever you cast a spell.'),
    ] });
    expect(classifyPair(fast, slow, ctx)).toMatchObject({ class: 'not_comparable', reason: 'speed_against_cost' });
  });
  it('faster at the same cost is a gain, not a trade', () => {
    const fast = card({ id: 'a', text: 'Draw a card.', atoms: [atom('a', 'PRODUCES.CARD_DRAW', {}, 'Draw a card.')] });
    const slow = card({ id: 'b', type: 'Instant', text: 'Draw a card.', atoms: [atom('b', 'PRODUCES.CARD_DRAW', {}, 'Draw a card.'), atom('b', 'CONSTRAINTS.TIMING', {}, 'Activate only as a sorcery.')] });
    expect(classifyPair(fast, slow, ctx)).toMatchObject({ a: 'a', class: 'dominated_in_pool', gains: ['speed'] });
  });
  it('a null from compareSpeed is not_comparable', () => {
    const body = { type: 'Creature — Rat', power: '1', toughness: '1', text: 'Draw a card.' };
    const unread = card({ ...body, id: 'a', atoms: [atom('a', 'ENABLES.FLASH', {}, 'You may cast this spell as though it had flash if you control a Rat.')] });
    expect(classifyPair(unread, card({ ...body, id: 'b' }), ctx)).toMatchObject({ class: 'not_comparable', reason: 'speed_null' });
  });
  it('another target head is not_comparable', () => {
    expect(classifyPair(removal('a', 'target creature'), removal('b', 'target creature or planeswalker'), ctx)).toMatchObject({ class: 'not_comparable', reason: 'target_head' });
  });
  it('another target count is not_comparable', () => {
    expect(classifyPair(removal('a', 'target creature', '{B}'), removal('b', 'up to two target creatures'), ctx)).toMatchObject({ class: 'not_comparable', reason: 'target_count' });
  });
  it('an unread target count fails the proof', () => {
    const r = classifyPair(removal('a', 'any number of target creatures', '{B}'), removal('b', 'target creature'), ctx);
    expect(r).toMatchObject({ class: 'not_comparable', reason: 'unread_field' });
  });
  it('a reward on a face with no cost is not_comparable', () => {
    const face = { extra_faces: [{ mana_cost: null, type_line: 'Instant' }], layout: 'modal_dfc' };
    const a = card({ ...face, id: 'a', text: 'Draw a card.', atoms: [atom('a', 'PRODUCES.CARD_DRAW', {}, 'Draw a card.', 1)] });
    const b = card({ id: 'b', text: 'Draw a card.', atoms: [atom('b', 'PRODUCES.CARD_DRAW', {}, 'Draw a card.')] });
    expect(classifyPair(a, b, ctx)).toMatchObject({ class: 'not_comparable', reason: 'face_no_cost' });
  });
  it('a condition on one card is conditional, and the reason names its type', () => {
    const plain = card({ id: 'a', text: 'Draw a card.', atoms: [atom('a', 'PRODUCES.CARD_DRAW', {}, 'Draw a card.')] });
    const needs = card({ id: 'b', text: 'Draw a card.', atoms: [atom('b', 'PRODUCES.CARD_DRAW', {}, 'Draw a card.'), atom('b', 'CARES_ABOUT.SPELL_CAST', { subject: 'any' }, 'Whenever you cast a spell.')] });
    expect(classifyPair(plain, needs, ctx)).toMatchObject({ class: 'conditional', reason: 'CARES_ABOUT.SPELL_CAST' });
  });
  it('one condition on both cards is not conditional, and a self trigger is not a condition', () => {
    const shared = (id: string, n: number) => card({ id, text: `Whenever you cast a spell, target creature gets -${n}/-${n}.`, atoms: [
      atom(id, 'CARES_ABOUT.SPELL_CAST', { subject: 'any' }, 'Whenever you cast a spell'),
      atom(id, 'COMBAT.STAT_CHANGE', { sign: '-' }, `target creature gets -${n}/-${n}`),
    ] });
    expect(classifyPair(shared('a', 4), shared('b', 3), ctx)).toMatchObject({ class: 'dominated_in_pool' });
    const own = card({ id: 'a', text: 'Draw a card.', atoms: [atom('a', 'CARES_ABOUT.ENTERS_BATTLEFIELD', { subject: 'self' }, 'When this creature enters')] });
    expect(classifyPair(own, card({ id: 'b', text: 'Draw a card.' }), ctx).class).not.toBe('conditional');
  });
  it('keeps the reason of the order that passed more checks', () => {
    expect(classifyPair(stat('a', 4, '{2}{B}'), stat('b', 3, '{1}{B}'), ctx)).toMatchObject({ class: 'not_comparable', reason: 'field_lower' });
  });
});

describe('classifyGroups', () => {
  it('gives a pair in two groups one class, and counts two rows', () => {
    const q = (id: string, n: number) => `Target creature gets -${n}/-${n} until end of turn.`;
    const make = (id: string, n: number) => card({ id, text: q(id, n), atoms: [atom(id, 'COMBAT.STAT_CHANGE', { sign: '-' }, q(id, n)), atom(id, 'INTERACTION.TARGETED_REMOVAL', { removal_type: 'minus' }, q(id, n))] });
    const cards = new Map([['a', make('a', 4)], ['b', make('b', 3)]]);
    const input: GroupInput = { spells: [{ oracle_id: 'a', name: 'Card a', cmc: 2 }, { oracle_id: 'b', name: 'Card b', cmc: 2 }], atoms: [...cards.values()].flatMap((c) => c.atoms), roles };
    const groups = makeGroups(input, reward, kindKey);
    expect(groups).toHaveLength(2);
    const run = classifyGroups(groups, { ...ctx, cards });
    expect(run.pairs.size).toBe(1);
    expect(run.rows).toEqual({ dominated_in_pool: 2, conditional: 0, not_comparable: 0 });
  });
  it('leaves a group of one card out', () => {
    const cards = new Map([['a', stat('a', 4)]]);
    const input: GroupInput = { spells: [{ oracle_id: 'a', name: 'Card a', cmc: 2 }], atoms: cards.get('a')!.atoms, roles };
    expect(classifyGroups(makeGroups(input, reward, kindKey), { ...ctx, cards }).pairs.size).toBe(0);
  });
});

describe('the classes of a card', () => {
  const demand = atom('a', 'CARES_ABOUT.SPELL_CAST', { subject: 'any', controller: 'you' }, 'Whenever you cast a spell, draw a card.');
  it('the rule of the brief reads an accepted demand role only', () => {
    const test = demandTest(roles);
    expect(test(demand)).toBe(true);
    expect(test(atom('a', 'PRODUCES.CARD_DRAW', {}, 'x'))).toBe(false);
    expect(test(atom('a', 'CARES_ABOUT.PERMANENT_DIES', { subject: 'any' }, 'x'))).toBe(false);
  });
  it('the narrower rule leaves out what the card or an opponent supplies', () => {
    expect(condition(demand)).toBe(true);
    expect(condition(atom('a', 'ENABLES.COST_REDUCTION', {}, 'x'))).toBe(true);
    expect(condition(atom('a', 'CARES_ABOUT.ENTERS_BATTLEFIELD', { subject: 'self' }, 'x'))).toBe(false);
    expect(condition(atom('a', 'CARES_ABOUT.SPELL_CAST', { subject: 'any', controller: 'opponent' }, 'x'))).toBe(false);
    expect(condition(atom('a', 'CARES_ABOUT.SPELL_CAST', { subject: 'any', whose: 'opponent' }, 'x'))).toBe(false);
    expect(condition(atom('a', 'CARES_ABOUT.SPELL_CAST', { subject: 'any', player: 'opponent' }, 'x'))).toBe(false);
  });
  const spells = [{ oracle_id: 'a', name: 'A', cmc: 1 }, { oracle_id: 'b', name: 'B', cmc: 1 }, { oracle_id: 'c', name: 'C', cmc: 1 }];
  it('gives each spell one class, with a short reason', () => {
    const got = cardClasses({ spells, atoms: [demand] }, condition, new Set(['a', 'b']));
    expect(got).toEqual([
      { oracle_id: 'a', class: 'conditional', reason: 'needs CARES_ABOUT.SPELL_CAST: Whenever you cast a spell, draw a card.' },
      { oracle_id: 'b', class: 'dominated_in_pool', reason: null },
      { oracle_id: 'c', class: 'plain', reason: null },
    ]);
  });
  it('cuts a long quote in the reason', () => {
    const long = atom('a', 'CARES_ABOUT.SPELL_CAST', { subject: 'any' }, `Whenever you cast ${'a very long '.repeat(20)}spell.`);
    expect(cardClasses({ spells: spells.slice(0, 1), atoms: [long] }, condition, new Set())[0]!.reason!.length).toBeLessThan(110);
  });
});

describe('the key of plan sec. 2.1', () => {
  const trigger = { ...atom('a', 'PRODUCES.CARD_DRAW', { amount: 1 }, 'Draw a card.'), kind: 'triggered' as const };
  const activated = { ...atom('b', 'PRODUCES.CARD_DRAW', { amount: 1 }, 'Draw a card.'), kind: 'activated' as const };
  const input: GroupInput = { spells: [{ oracle_id: 'a', name: 'A', cmc: 1 }, { oracle_id: 'b', name: 'B', cmc: 2 }], atoms: [trigger, activated], roles };
  it('adds the kind to the key, and the old key stays', () => {
    expect(kindKey(trigger)).toBe('PRODUCES.CARD_DRAW {} triggered');
    expect(groupKey(trigger)).toBe(groupKey(activated));
  });
  it('splits a group by kind only when the caller asks', () => {
    expect(makeGroups(input)).toHaveLength(1);
    expect(makeGroups(input, reward, kindKey).map((g) => g.key).sort()).toEqual(['PRODUCES.CARD_DRAW {} activated', 'PRODUCES.CARD_DRAW {} triggered']);
  });
  it('an atom with no kind keeps its own part of the key', () => {
    expect(kindKey({ ...trigger, kind: null })).toBe('PRODUCES.CARD_DRAW {} no_kind');
  });
});

describe('loading from a build', () => {
  const shaOf = (ids: number[]) => createHash('sha256').update(ids.join(','), 'utf8').digest('hex').slice(0, 16);
  function db() {
    const d = openDb(':memory:');
    d.exec('PRAGMA foreign_keys = OFF');
    d.prepare(`INSERT INTO cards (oracle_id,name,layout,mana_cost,cmc,type_line,oracle_text,colors,color_identity,keywords,power,toughness,rarity,arena_id,set_code,collector_number,oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id,rotated)
      VALUES ('s','A Spell','normal','{1}{B}',2,'Creature — Rat','Draw a card.','["B"]','["B"]','[]','2','1','c',1,'s','1','h',1,1,0)`).run();
    d.prepare(`INSERT INTO card_faces (oracle_id,face_index,name,mana_cost,type_line,oracle_text,power,toughness,colors) VALUES ('s',0,'A Spell','{1}{B}','Creature — Rat','Draw a card.','2','1','["B"]')`).run();
    const addAtom = d.prepare(`INSERT INTO atoms (id,run_id,oracle_id,face_index,schema_version,family,type_key,params_json,span_start,span_end,quote,rule_numbers,confidence,confidence_source,oracle_hash)
      VALUES (?,1,'s',0,20,'PRODUCES','CARD_DRAW','{"amount":1}',?,?,'Draw a card.','[]',1,'model','h')`);
    addAtom.run(1, 0, 5);
    addAtom.run(2, 30, 35);
    d.prepare(`INSERT INTO edge_type_roles (set_id,family,type_key,role,resources_json,evidence_json,votes,status) VALUES (2,'PRODUCES','CARD_DRAW','supply','[{"resource":"cards_in_hand","sign":"+","kind":"value"}]','[]',3,'accepted')`).run();
    d.prepare(`INSERT INTO graph_builds (id,build_key,rule_set_id,schema_version,corpus_id,pool_snapshot_id,tests_version,atom_set_sha,scope,built_at,counts_json) VALUES (7,'k7',2,20,1,1,1,'s','BR','t','{}')`).run();
    const addLink = d.prepare('INSERT INTO graph_build_atoms (build_id,atom_id) VALUES (7,?)');
    addLink.run(1);
    addLink.run(2);
    return d;
  }
  const addGroup = (d: ReturnType<typeof db>, index: number, start: number, kind: string, sha: string, tests = 1) =>
    d.prepare(`INSERT INTO ability_groups (oracle_id,face_index,group_index,span_start,span_end,kind,oracle_hash,tests_version,atom_sha) VALUES ('s',0,?,?,?,?,'h',?,?)`)
      .run(index, start, start + 10, kind, tests, sha);

  it('gives each atom the kind of the last group that starts at or before it', () => {
    const d = db();
    addGroup(d, 0, 0, 'triggered', shaOf([1, 2]));
    addGroup(d, 1, 20, 'activated', shaOf([1, 2]));
    expect(loadGroupInput(d, 7).atoms.map((a) => a.kind)).toEqual(['triggered', 'activated']);
  });
  it('takes the rows of the atom set first, and the old rows after them', () => {
    const d = db();
    addGroup(d, 0, 0, 'other', '');
    addGroup(d, 0, 0, 'triggered', shaOf([1, 2]));
    expect(loadGroupInput(d, 7).atoms[0]!.kind).toBe('triggered');
    const old = db();
    addGroup(old, 0, 0, 'other', '');
    expect(loadGroupInput(old, 7).atoms[0]!.kind).toBe('other');
  });
  it('reads the tests version of the build', () => {
    const d = db();
    addGroup(d, 0, 0, 'triggered', shaOf([1, 2]), 9);
    expect(loadGroupInput(d, 7).atoms[0]!.kind).toBeNull();
  });
  it('reads the card records for a proof', () => {
    const d = db();
    const input = loadGroupInput(d, 7);
    const c = loadProofCards(d, input, 7).get('s')!;
    expect(c).toMatchObject({ name: 'A Spell', layout: 'normal', color_identity: ['B'] });
    expect(c.faces[0]).toMatchObject({ mana_cost: '{1}{B}', power: '2', toughness: '1', type_line: 'Creature — Rat' });
    expect(c.speed).toHaveLength(1);
    expect(c.fields.size).toBe(2);
  });
});
