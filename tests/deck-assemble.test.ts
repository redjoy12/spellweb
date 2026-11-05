import { describe, it, expect } from 'vitest';
import { assembleSpells, candidates, type DeckCard, type SpellSlot } from '../src/deck/assemble.js';
import type { Goal } from '../src/deck/goal.js';
import type { PairLink, PairTable } from '../src/deck/pairs.js';
import { loadDeckPolicy } from '../src/deck/policy.js';

const policy = loadDeckPolicy();

const card = (id: string, over: Partial<DeckCard> = {}): DeckCard => ({
  oracle_id: id, name: id, type_line: 'Sorcery', cmc: 2, costs: ['{1}{B}'], identity: ['B'], arena_id: 1,
  land: false, creature: false, legendary: false, interaction: false, tags: [], ...over,
});
const goal = (over: Partial<Goal> = {}): Goal => ({ colours: 'B', seeds: ['seed'], excluded: [], target_turn: 6, interaction: 'none', min_creatures: 0, use_rate: false, pinned: [], excluded_tags: [], ...over });

/** A pair table from `[supply, demand, weight]` rows; `anti` rows hold both orders. */
function table(pos: Array<[string, string, number]>, anti: Array<[string, string, number]> = []): PairTable {
  const link = (a: string, b: string, w: number): PairLink => ({ supply: a, demand: b, weight: w, key: `${a}>${b}`, grade: 'confirmed', rule_hashes: [], atom_ids: [], demand_atom_id: 0 });
  const t: PairTable = { buildId: null, pos: new Map(), anti: new Map(), linked: new Map() };
  const row = <V>(m: Map<string, V>, k: string, v: () => V) => { if (!m.has(k)) m.set(k, v()); return m.get(k)!; };
  for (const [a, b, w] of pos) {
    row(t.pos, a, () => new Map()).set(b, link(a, b, w));
    row(t.linked, a, () => new Set()).add(b);
    row(t.linked, b, () => new Set()).add(a);
  }
  for (const [a, b, w] of anti) {
    row(t.anti, a, () => new Map()).set(b, link(a, b, w));
    row(t.anti, b, () => new Map()).set(a, link(a, b, w));
  }
  return t;
}

/** Plain filler cards that link to the seed with weight `w`. */
const filler = (n: number, w = 0.1) => {
  const cards = Array.from({ length: n }, (_, i) => card(`f${String(i).padStart(2, '0')}`));
  return { cards, pos: cards.map((c): [string, string, number] => [c.oracle_id, 'seed', w]) };
};
const ids = (r: SpellSlot[]) => r.map((s) => s.oracle_id);
const total = (r: SpellSlot[]) => r.reduce((s, x) => s + x.copies, 0);

describe('candidates (design sec. 5 step 1)', () => {
  const list = [card('seed', { cmc: 9 }), card('a', { cmc: 6 }), card('b', { cmc: 7 }), card('land', { land: true, cmc: 0 }), card('x')];
  it('leaves out lands, excluded cards and a mana value above the target turn; a seed stays', () => {
    expect(candidates(list, goal({ excluded: ['x'] })).map((c) => c.oracle_id)).toEqual(['seed', 'a']);
  });
  it('a pinned card stays above the target turn, and a "never" tag removes a card unless it is a seed or pinned', () => {
    const tagged = [card('seed', { tags: ['PRODUCES.DISCARD'] }), card('p', { cmc: 8, tags: ['PRODUCES.DISCARD'] }), card('t', { tags: ['PRODUCES.DISCARD'] }), card('u', { tags: ['PRODUCES.MILL'] })];
    expect(candidates(tagged, goal({ pinned: ['p'], excluded_tags: ['PRODUCES.DISCARD'] })).map((c) => c.oracle_id)).toEqual(['seed', 'p', 'u']);
  });
});

describe('pinned cards (build chat design sec. 3)', () => {
  it('a pinned card always enters with the role pin and at least 1 copy, with no link', () => {
    const f = filler(30);
    const r = assembleSpells([card('seed'), card('lone'), ...f.cards], goal({ pinned: ['lone'] }), table(f.pos), 36, policy);
    expect(r.find((s) => s.oracle_id === 'lone')).toMatchObject({ role: 'pin' });
    expect(r.find((s) => s.oracle_id === 'lone')!.copies).toBeGreaterThanOrEqual(1);
    expect(total(r)).toBe(36);
  });
  it('pinned cards with no seed start the deck', () => {
    const f = filler(30);
    const r = assembleSpells([card('seed'), card('lone'), ...f.cards], goal({ seeds: [], pinned: ['lone'] }), table(f.pos), 36, policy);
    expect(r.find((s) => s.oracle_id === 'lone')?.role).toBe('pin');
  });
});

describe('assembleSpells (design sec. 5 and 6)', () => {
  it('a seed always enters, and the deck has its exact copies', () => {
    const f = filler(30);
    const r = assembleSpells([card('seed'), ...f.cards], goal(), table(f.pos), 36, policy);
    expect(r.find((s) => s.oracle_id === 'seed')).toMatchObject({ role: 'seed' });
    expect(total(r)).toBe(36);
  });
  it('a seed with the top fit has 4 copies, and a seed with a low fit has the copies of its third', () => {
    const f = filler(30);
    const top = assembleSpells([card('seed'), ...f.cards], goal(), table(f.pos.map(([a, b]) => [a, b, 1] as [string, string, number])), 20, { ...policy, score: { ...policy.score, hub_power: 0 } });
    expect(top.find((s) => s.role === 'seed')!.copies).toBe(4);
    const c = Array.from({ length: 9 }, (_, i) => card(`c${i}`));
    const linked = c.flatMap((a, i) => c.slice(i + 1).map((b): [string, string, number] => [a.oracle_id, b.oracle_id, 1]));
    const low = assembleSpells([card('seed'), ...c], goal(), table([...linked, ['c0', 'seed', 0.01]]), 31, policy);
    expect(low.find((s) => s.role === 'seed')!.copies).toBe(2);
  });
  it('a seed with the lowest fit keeps 1 copy when the other cards take the rest', () => {
    const r = assembleSpells([card('a'), card('b'), card('seed')], goal(), table([['a', 'b', 1]]), 8, policy);
    expect(r.map((s) => [s.oracle_id, s.copies]).sort()).toEqual([['a', 4], ['b', 3], ['seed', 1]]);
  });
  it('seed_weight keeps the deck on the links of the seed, away from a group that links only to itself', () => {
    const near = Array.from({ length: 9 }, (_, i) => card(`n${i}`));
    const far = Array.from({ length: 9 }, (_, i) => card(`x${i}`));
    const pos: Array<[string, string, number]> = [
      ...far.flatMap((a, i) => far.slice(i + 1).map((b): [string, string, number] => [a.oracle_id, b.oracle_id, 0.5])),
      ...near.map((c): [string, string, number] => [c.oracle_id, 'seed', 0.5]),
      ['x0', 'seed', 0.6],
    ];
    const run = (seed_weight: number) => assembleSpells([card('seed'), ...near, ...far], goal(), table(pos), 28, { ...policy, score: { ...policy.score, hub_power: 0, seed_weight } });
    const nearCount = (r: SpellSlot[]) => ids(r).filter((x) => x.startsWith('n')).length;
    expect(nearCount(run(3))).toBeGreaterThan(nearCount(run(1)));
  });
  it('a seed with no link and a high mana value enters', () => {
    const f = filler(30);
    const r = assembleSpells([card('zzz', { cmc: 9 }), ...f.cards], goal({ seeds: ['zzz'] }), table(f.pos), 36, policy);
    expect(ids(r)).toContain('zzz');
  });
  it('an excluded card never enters, also when it has the best link', () => {
    const f = filler(30);
    const best = card('best');
    const g = goal({ excluded: ['best'] });
    const r = assembleSpells(candidates([card('seed'), best, ...f.cards], g), g, table([...f.pos, ['best', 'seed', 5]]), 36, policy);
    expect(ids(r)).not.toContain('best');
  });
  it('a hub card with many weak links loses to a card with fewer links of the same weight', () => {
    const f = filler(40, 0.01);
    const hubLinks = f.cards.map((c): [string, string, number] => ['hub', c.oracle_id, 0.01]);
    const r = assembleSpells([card('seed'), card('hub'), card('small'), ...f.cards], goal(),
      table([...f.pos, ...hubLinks, ['hub', 'seed', 1], ['small', 'seed', 1]]), 12, policy);
    const small = r.find((s) => s.oracle_id === 'small');
    const hub = r.find((s) => s.oracle_id === 'hub');
    expect(small).toBeDefined();
    expect(small!.fit).toBeGreaterThan(hub?.fit ?? 0);
  });
  it('a plain sum (hub power 0) keeps the hub first: the score correction makes the change', () => {
    const f = filler(40, 0.01);
    const hubLinks = f.cards.map((c): [string, string, number] => ['hub', c.oracle_id, 0.01]);
    const plain = { ...policy, score: { ...policy.score, hub_power: 0 } };
    const r = assembleSpells([card('seed'), card('hub'), card('small'), ...f.cards], goal(),
      table([...f.pos, ...hubLinks, ['hub', 'seed', 1], ['small', 'seed', 1]]), 12, plain);
    expect(r.find((s) => s.oracle_id === 'hub')!.fit).toBeGreaterThan(r.find((s) => s.oracle_id === 'small')?.fit ?? 0);
  });
  it('a card with a - link to the deck loses to the same card with no - link', () => {
    const f = filler(30, 0.01);
    const r = assembleSpells([card('seed'), card('bad'), card('good'), ...f.cards], goal(),
      table([...f.pos, ['bad', 'seed', 0.5], ['good', 'seed', 0.5]], [['bad', 'seed', 1]]), 7, policy);
    expect(ids(r)).toContain('good');
    expect(ids(r)).not.toContain('bad');
  });
  it('the copies follow the thirds of the fit; the top third has 4 and the last third has 2', () => {
    const cards = Array.from({ length: 9 }, (_, i) => card(`c${i}`));
    const pos = cards.map((c, i): [string, string, number] => [c.oracle_id, 'seed', 1 - i / 10]);
    const r = assembleSpells([card('seed'), ...cards], goal(), table(pos), 31, policy);
    const copies = (id: string) => r.find((s) => s.oracle_id === id)?.copies;
    expect([copies('c0'), copies('c1'), copies('c2')]).toEqual([4, 4, 4]);
    expect([copies('c3'), copies('c4'), copies('c5')]).toEqual([3, 3, 3]);
    expect([copies('c6'), copies('c7'), copies('c8')]).toEqual([2, 2, 2]);
    expect(total(r)).toBe(31);
  });
  it('a legendary card has at most 2 copies, also when it is a seed', () => {
    const cards = Array.from({ length: 12 }, (_, i) => card(`c${String(i).padStart(2, '0')}`, { legendary: true }));
    const pos = cards.map((c): [string, string, number] => [c.oracle_id, 'seed', 1]);
    const r = assembleSpells([card('seed', { legendary: true }), ...cards], goal(), table(pos), 20, policy);
    expect(r.find((s) => s.role === 'seed')!.copies).toBeGreaterThanOrEqual(1);
    expect(r.every((s) => s.copies <= 2)).toBe(true);
    expect(total(r)).toBe(20);
  });
  it('a goal with no seed starts at the card with the highest fit against all candidates', () => {
    const f = filler(30, 0.5);
    const pos = f.cards.map((c): [string, string, number] => [c.oracle_id, 'centre', 0.5]);
    const plain = Array.from({ length: 5 }, (_, i) => card(`a${i}`));
    const r = assembleSpells([...plain, card('centre'), ...f.cards], goal({ seeds: [] }), table(pos), 36, policy);
    expect(ids(r)).toContain('centre');
    expect(ids(r).filter((x) => x.startsWith('a'))).toEqual([]);
    expect(r.every((s) => s.role !== 'seed')).toBe(true);
    expect(total(r)).toBe(36);
  });
  it('a goal with no seed and no candidate gives no spell', () => {
    expect(assembleSpells([], goal({ seeds: [] }), table([]), 36, policy)).toEqual([]);
  });
  it('the quotas take the cards with the highest fit of their kind, and the role says so', () => {
    const f = filler(30, 0.5);
    const r1 = card('r1', { interaction: true });
    const r2 = card('r2', { interaction: true });
    const c1 = card('c1', { creature: true });
    const c2 = card('c2', { creature: true });
    const g = goal({ interaction: 'some', min_creatures: 4 });
    const r = assembleSpells([card('seed'), r1, r2, card('r3', { interaction: true }), c1, c2, ...f.cards], g,
      table([...f.pos, ['r1', 'seed', 0.2], ['r2', 'seed', 0.2], ['c1', 'seed', 0.2], ['c2', 'seed', 0.2]]), 36, policy);
    const role = (id: string) => r.find((s) => s.oracle_id === id)?.role;
    expect([role('r1'), role('r2'), role('c1'), role('c2')]).toEqual(['quota', 'quota', 'quota', 'quota']);
    expect(role('f00')).toBe('link');
  });
  it('the same input gives the same deck', () => {
    const f = filler(30);
    const run = () => assembleSpells([card('seed'), ...f.cards], goal(), table(f.pos), 36, policy);
    expect(run()).toEqual(run());
  });
  it('a tie goes to the lower oracle_id', () => {
    const f = filler(30);
    const r = assembleSpells([card('seed'), ...f.cards], goal(), table(f.pos), 11, policy);
    expect(ids(r).filter((x) => x !== 'seed')).toEqual(['f00', 'f01', 'f02']);
  });
  it('a short pool raises the copies and still reaches the count when it can', () => {
    const r = assembleSpells([card('seed'), card('a'), card('b'), card('c')], goal(), table([['a', 'seed', 1], ['b', 'seed', 1], ['c', 'seed', 1]]), 16, policy);
    expect(total(r)).toBe(16);
    expect(r.every((s) => s.copies <= 4)).toBe(true);
  });
});
