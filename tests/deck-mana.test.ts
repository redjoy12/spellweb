import { describe, it, expect } from 'vitest';
import type { DeckCard } from '../src/deck/assemble.js';
import type { Goal } from '../src/deck/goal.js';
import { atLeast, buildCards, colourNeeds, colourSymbols, curveTurn, landCount, manaBase, sourcesFor, type LandOptions } from '../src/deck/manaBase.js';
import type { PairTable } from '../src/deck/pairs.js';
import { loadDeckPolicy } from '../src/deck/policy.js';

const policy = loadDeckPolicy();
const basics = { B: 'swamp', R: 'mountain' };
const opts = (duals: LandOptions['duals'] = [], b: LandOptions['basics'] = basics): LandOptions => ({ duals, basics: b });
const spell = (cost: string, cmc: number) => ({ costs: [cost], cmc });
const land = (lands: ReturnType<typeof manaBase>['lands'], id: string) => lands.find((l) => l.oracle_id === id)?.copies ?? 0;

describe('atLeast (values worked by hand)', () => {
  it('two draws of four cards with two hits: 5/6', () => {
    expect(atLeast(4, 2, 2, 1)).toBeCloseTo(5 / 6, 12);
  });
  it('three draws of ten cards with three hits, all hits: 1/120', () => {
    expect(atLeast(10, 3, 3, 3)).toBeCloseTo(1 / 120, 12);
  });
  it('a land in seven cards of sixty with 24 lands: 1 - C(36,7) / C(60,7)', () => {
    expect(atLeast(60, 24, 7, 1)).toBeCloseTo(1 - 8347680 / 386206920, 12);
  });
  it('the limits: all cards are hits, and too few hits', () => {
    expect(atLeast(5, 5, 2, 2)).toBeCloseTo(1, 12);
    expect(atLeast(5, 1, 2, 2)).toBe(0);
    expect(atLeast(60, 20, 8, 0)).toBeCloseTo(1, 12);
  });
});

describe('land count (design sec. 7 step 1)', () => {
  it('T is the mana value at the 75th percentile of the copies, between 2 and 6', () => {
    expect(curveTurn([1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 6, 6], policy)).toBe(4);
    expect(curveTurn([1, 1, 1, 1], policy)).toBe(2);
    expect(curveTurn([9, 9, 9, 9], policy)).toBe(6);
  });
  it('L is the smallest count from 20 that reaches 0.60', () => {
    const l = landCount(4, policy);
    expect(atLeast(60, l, 10, 4)).toBeGreaterThanOrEqual(0.6);
    expect(atLeast(60, l - 1, 10, 4)).toBeLessThan(0.6);
    expect(landCount(2, policy)).toBe(20);
  });
  it('L is 26 when no count reaches 0.60', () => {
    expect(atLeast(60, 26, 12, 6)).toBeLessThan(0.6);
    expect(landCount(6, policy)).toBe(26);
  });
});

describe('colour needs (design sec. 7 step 2)', () => {
  it('counts the symbols of a colour; a hybrid symbol names each of its colours', () => {
    expect(colourSymbols('{1}{B}{B}', 'B')).toBe(2);
    expect(colourSymbols('{1}{B}{B}', 'R')).toBe(0);
    expect(colourSymbols('{B/R}{B/R}', 'R')).toBe(2);
    expect(colourSymbols('{2/R}', 'R')).toBe(1);
    expect(colourSymbols('{X}{R}', 'B')).toBe(0);
  });
  it('the need is the smallest source count that reaches 0.80', () => {
    const s = sourcesFor(2, 3, policy);
    expect(atLeast(60, s, 9, 2)).toBeGreaterThanOrEqual(0.8);
    expect(atLeast(60, s - 1, 9, 2)).toBeLessThan(0.8);
  });
  it('the need of a colour is the highest result of its spells', () => {
    const n = colourNeeds([spell('{R}', 1), spell('{1}{B}', 2), spell('{B}{B}', 2)], policy);
    expect(n.B).toBe(sourcesFor(2, 2, policy));
    expect(n.R).toBe(sourcesFor(1, 1, policy));
  });
  it('a card uses the face with the most symbols', () => {
    expect(colourNeeds([{ costs: ['{1}{B}', '{B}{B}'], cmc: 2 }], policy).B).toBe(sourcesFor(2, 2, policy));
  });
});

describe('manaBase (design sec. 7 steps 3 to 5)', () => {
  const spells = [spell('{B}', 1), spell('{R}', 1)];
  const copies = [4, 4];

  it('a mono-colour deck uses one basic type', () => {
    const m = manaBase([spell('{B}{B}', 2)], [4], 24, opts([], { B: 'swamp', R: '' }), policy);
    expect(m.lands).toEqual([{ oracle_id: 'swamp', copies: 24, kind: 'basic' }]);
    expect(m.sources).toEqual({ B: 24, R: 0 });
  });
  it('a mono-colour deck with no coloured symbol uses its one basic type', () => {
    const m = manaBase([spell('{3}', 3)], [4], 24, opts([], { B: '', R: 'mountain' }), policy);
    expect(m.lands).toEqual([{ oracle_id: 'mountain', copies: 24, kind: 'basic' }]);
  });
  it('a BR deck takes untapped dual lands first, up to 4 copies each', () => {
    const m = manaBase(spells, copies, 24, opts([{ oracle_id: 'open', tapped: false }, { oracle_id: 'open2', tapped: false }, { oracle_id: 'slow', tapped: true }]), policy);
    expect(land(m.lands, 'open')).toBe(4);
    expect(land(m.lands, 'open2')).toBe(4);
    expect(land(m.lands, 'slow')).toBe(0);
    expect(m.lands.reduce((s, l) => s + l.copies, 0)).toBe(24);
  });
  it('a dual land with "enters tapped" text enters only while the basic lands cannot meet the needs', () => {
    const heavy = [spell('{B}{B}{B}', 3), spell('{R}{R}{R}', 3)];
    const need = colourNeeds(heavy, policy);
    const m = manaBase(heavy, [4, 4], 24, opts([{ oracle_id: 'open', tapped: false }, { oracle_id: 'slow', tapped: true }, { oracle_id: 'slow2', tapped: true }]), policy);
    expect(land(m.lands, 'open')).toBe(4);
    expect(land(m.lands, 'slow') + land(m.lands, 'slow2')).toBe(Math.min(8, need.B + need.R - 24 - 4));
    expect(m.sources.B + m.sources.R).toBe(24 + land(m.lands, 'open') + land(m.lands, 'slow') + land(m.lands, 'slow2'));
  });
  it('the basic lands follow the need that remains, and the sources meet both needs', () => {
    const m = manaBase([spell('{2}{B}{B}', 4), spell('{5}{R}', 6)], [4, 4], 24, opts(), policy);
    expect(m.needs).toEqual({ B: 16, R: 7 });
    expect(land(m.lands, 'swamp')).toBeGreaterThan(land(m.lands, 'mountain'));
    expect(m.short).toBe(false);
    expect(m.sources.B).toBeGreaterThanOrEqual(m.needs.B);
    expect(m.sources.R).toBeGreaterThanOrEqual(m.needs.R);
  });
  it('a land count that cannot meet both needs keeps the proportion and is short', () => {
    const m = manaBase([spell('{B}{B}{B}', 3), spell('{R}{R}{R}', 3)], [4, 4], 24, opts(), policy);
    expect(m.short).toBe(true);
    expect(land(m.lands, 'swamp')).toBe(12);
    expect(land(m.lands, 'mountain')).toBe(12);
  });
  it('a BR deck with spells of one colour takes no dual land', () => {
    const m = manaBase([spell('{B}', 1)], [4], 24, opts([{ oracle_id: 'open', tapped: false }]), policy);
    expect(m.lands).toEqual([{ oracle_id: 'swamp', copies: 24, kind: 'basic' }]);
  });
});

describe('buildCards (design sec. 5 step 6)', () => {
  const table: PairTable = { buildId: null, pos: new Map(), anti: new Map(), linked: new Map() };
  const card = (id: string, cmc: number): DeckCard => ({
    oracle_id: id, name: id, type_line: 'Sorcery', cmc, costs: ['{B}'], identity: ['B'], arena_id: 1,
    land: false, creature: false, legendary: false, interaction: false, tags: [],
  });
  const goal: Goal = { colours: 'B', seeds: ['s'], excluded: [], target_turn: 8, interaction: 'none', min_creatures: 0, use_rate: false, pinned: [], excluded_tags: [] };

  it('a deck with a low curve gets the low land count, and spells and lands make 60 cards', () => {
    const cards = [card('s', 1), ...Array.from({ length: 30 }, (_, i) => card(`c${String(i).padStart(2, '0')}`, 1))];
    const r = buildCards(cards, goal, table, opts([], { B: 'swamp', R: '' }), policy);
    expect(r.mana.land_count).toBe(20);
    expect(r.stable).toBe(true);
    expect(r.loops).toBeLessThanOrEqual(3);
    expect(r.spells.reduce((s, x) => s + x.copies, 0) + r.mana.land_count).toBe(60);
  });
  it('the loop stops at the limit, and the deck keeps exactly 60 cards', () => {
    const cards = [card('s', 1), ...Array.from({ length: 30 }, (_, i) => card(`c${String(i).padStart(2, '0')}`, 1))];
    const r = buildCards(cards, goal, table, opts([], { B: 'swamp', R: '' }), { ...policy, search: { ...policy.search, mana_loops: 1 } });
    expect(r.loops).toBe(1);
    expect(r.stable).toBe(false);
    expect(r.spells.reduce((s, x) => s + x.copies, 0) + r.mana.land_count).toBe(60);
  });
});
