import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/client.js';
import { cardFields, type RateCard } from '../src/rate/fields.js';
import {
  adjustByMana, bestGroups, chooseLambda, designMatrix, features, fitRidge, fitRows, foldOf, FOLDS, heldOutTest, LAMBDAS, manaBin, manaValue, MAX_CORRELATION, median, noValueReason,
  passesResultRule, pearson, predict,
  printedMana, rateOf, rateSpells, SIZE_CAP, wordCost, writeRates, type FitRow, type RateRow, type SparseRow,
} from '../src/rate/fit.js';
import { kindKey, loadGroupInput, makeGroups, rewardTest, type GroupInput, type RewardAtom, type RewardCard, type TypeRole } from '../src/rate/groups.js';
import { linkSource, type LinkIndex, type StoredDegree } from '../src/rate/links.js';
import { cardClasses, deckDemandTest, loadProofCards, type ProofCard, type ProofFace } from '../src/rate/proof.js';
import { maybe, realDb } from './helpers/realDb.js';

const value = { kind: 'value' } as const;
const role = (family: string, type_key: string, r: TypeRole['role'], resources: TypeRole['resources'] = [value]): TypeRole =>
  ({ family, type_key, role: r, status: 'accepted', resources });
const roles: TypeRole[] = [
  role('PRODUCES', 'CARD_DRAW', 'supply'),
  role('PRODUCES', 'SACRIFICE', 'supply'),
  role('PRODUCES', 'MANA_PRODUCTION', 'supply'),
  role('PRODUCES', 'CREATE', 'supply'),
  role('COMBAT', 'STAT_CHANGE', 'both'),
  role('INTERACTION', 'TARGETED_REMOVAL', 'both'),
  role('CARES_ABOUT', 'SPELL_CAST', 'demand', []),
];
const reward = rewardTest(roles);

let nextId = 1;
const atom = (oracle_id: string, type: string, params: RewardAtom['params'], quote: string, face_index = 0): RewardAtom => {
  const [family, type_key] = type.split('.') as [string, string];
  return { id: nextId++, oracle_id, face_index, family, type_key, params, quote, kind: 'other' };
};
const draw = (id: string, amount: unknown = 1) => atom(id, 'PRODUCES.CARD_DRAW', { amount }, `Draw ${String(amount)} cards.`);

interface Spec { id: string; cost?: string | null; type?: string; atoms?: RewardAtom[]; power?: string | null; toughness?: string | null; extra_faces?: Array<Partial<ProofFace>>; layout?: string }
function card(s: Spec): ProofCard {
  const first: ProofFace = {
    face_index: 0, name: `Card ${s.id}`, type_line: s.type ?? 'Sorcery', oracle_text: '', mana_cost: s.cost === undefined ? '{1}{B}' : s.cost, power: s.power ?? null, toughness: s.toughness ?? null,
  };
  const faces = [first, ...(s.extra_faces ?? []).map((f, i) => ({ ...first, face_index: i + 1, name: `Card ${s.id} back`, ...f }))];
  const rate: RateCard = { oracle_id: s.id, layout: s.layout ?? 'normal', faces };
  const atoms = s.atoms ?? [];
  const { atoms: fields, speed } = cardFields(rate, atoms);
  return { oracle_id: s.id, name: first.name, layout: rate.layout, color_identity: ['B'], faces, atoms, fields, speed };
}

describe('manaValue and printedMana', () => {
  it('reads each symbol', () => {
    expect(manaValue('{2}{B}{R}')).toBe(4);
    expect(manaValue('{0}')).toBe(0);
    expect(manaValue('{B/R}{B/R}')).toBe(2);
    expect(manaValue('{2/R}')).toBe(2);
  });
  it('reads no value from {X} or an empty cost', () => {
    expect(manaValue('{X}{B}')).toBeNull();
    expect(manaValue(null)).toBeNull();
    expect(manaValue('')).toBeNull();
  });
  it('adds the faces with a cost, and a face with no cost adds nothing', () => {
    expect(printedMana([{ mana_cost: '{2}' }, { mana_cost: '{1}{B}' }])).toBe(4);
    expect(printedMana([{ mana_cost: '{2}' }, { mana_cost: null }])).toBe(2);
  });
});

describe('cards in the fit (plan sec. 2.1 Q5, sec. 2.3)', () => {
  it('keeps out a spell with {X}, on any face', () => {
    expect(noValueReason(card({ id: 'x', cost: '{X}{B}' }), reward)).toBe('x_cost');
    expect(noValueReason(card({ id: 'x2', extra_faces: [{ mana_cost: '{X}' }] }), reward)).toBe('x_cost');
  });
  it('keeps out a card with a reward on a face with no cost', () => {
    const c = card({ id: 'b', extra_faces: [{ mana_cost: null }], atoms: [atom('b', 'PRODUCES.CARD_DRAW', {}, 'Draw a card.', 1)] });
    expect(noValueReason(c, reward)).toBe('face_no_cost');
  });
  it('keeps in a card with only a non-reward atom on that face', () => {
    const c = card({ id: 'b2', extra_faces: [{ mana_cost: null }], atoms: [atom('b2', 'CARES_ABOUT.SPELL_CAST', {}, 'Whenever you cast a spell', 1)] });
    expect(noValueReason(c, reward)).toBeNull();
  });
  it('keeps in a reward on a face with a cost', () => {
    const c = card({ id: 'a', extra_faces: [{ mana_cost: '{B}' }], atoms: [atom('a', 'PRODUCES.CARD_DRAW', {}, 'Draw a card.', 1)] });
    expect(noValueReason(c, reward)).toBeNull();
  });
  it('keeps out a card with no read cost', () => {
    expect(noValueReason(card({ id: 'n', cost: null }), reward)).toBe('no_cost');
  });
});

describe('fitRows', () => {
  it('gives one row to a card with one cost, with all its atoms', () => {
    const c = card({ id: 't', cost: '{2}', extra_faces: [{ mana_cost: null }], atoms: [atom('t', 'COMBAT.STAT_CHANGE', {}, 'x', 1)] });
    const rows = fitRows(c);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mana).toBe(2);
    expect(rows[0]!.card.atoms).toHaveLength(1);
  });
  it('gives each cost its own atoms and its own body', () => {
    const front = atom('p', 'PRODUCES.CARD_DRAW', { amount: 1 }, 'Draw a card.');
    const back = atom('p', 'PRODUCES.CARD_DRAW', { amount: 2 }, 'Draw two cards.', 1);
    const c = card({ id: 'p', cost: '{3}', type: 'Creature — Bear', power: '2', toughness: '2', extra_faces: [{ mana_cost: '{B}', type_line: 'Sorcery', power: null, toughness: null }], atoms: [front, back] });
    const [one, two] = fitRows(c);
    expect([one!.mana, two!.mana]).toEqual([3, 1]);
    expect(features(one!.card).get('body#power')).toBe(2);
    expect(features(two!.card).has('body#power')).toBe(false);
    expect(features(one!.card).get('PRODUCES.CARD_DRAW#amount')).toBe(1);
    expect(features(two!.card).get('PRODUCES.CARD_DRAW#amount')).toBe(2);
  });
});

describe('features', () => {
  it('counts one effect for atoms of one type with one quote, and does not add their sizes', () => {
    const q = 'Add {B} or {R}.';
    const m = features(card({ id: 'm', atoms: [atom('m', 'PRODUCES.MANA_PRODUCTION', { color: 'B' }, q), atom('m', 'PRODUCES.MANA_PRODUCTION', { color: 'R' }, q)] }));
    expect(m.get('PRODUCES.MANA_PRODUCTION')).toBe(1);
    expect(m.get('PRODUCES.MANA_PRODUCTION#mana_amount')).toBe(1);
  });
  it('counts two effects for two quotes', () => {
    const m = features(card({ id: 'd', atoms: [draw('d', 1), draw('d', 2)] }));
    expect(m.get('PRODUCES.CARD_DRAW')).toBe(2);
    expect(m.get('PRODUCES.CARD_DRAW#amount')).toBe(3);
  });
  it('gives each counter type its own column and its own size', () => {
    const m = features(card({ id: 'k', atoms: [
      atom('k', 'PRODUCES.COUNTER_PRODUCTION', { counter_type: '-1/-1', amount: 6 }, 'Put six -1/-1 counters on target creature.'),
      atom('k', 'PRODUCES.COUNTER_PRODUCTION', { counter_type: '+1/+1', amount: 2 }, 'Put two +1/+1 counters on it.'),
    ] }));
    expect(m.get('PRODUCES.COUNTER_PRODUCTION[-1/-1]')).toBe(1);
    expect(m.get('PRODUCES.COUNTER_PRODUCTION[-1/-1]#amount')).toBe(6);
    expect(m.get('PRODUCES.COUNTER_PRODUCTION[+1/+1]')).toBe(1);
    expect(m.get('PRODUCES.COUNTER_PRODUCTION[+1/+1]#amount')).toBe(2);
    expect(m.has('PRODUCES.COUNTER_PRODUCTION')).toBe(false);
  });
  it('gives a counter that a card enters with its own column, for each counter type (plan sec. 2.5)', () => {
    const m = features(card({ id: 'e', atoms: [
      atom('e', 'PRODUCES.COUNTER_PRODUCTION', { counter_type: '-1/-1', amount: 6 }, 'This creature enters with six -1/-1 counters on it.'),
      atom('e', 'PRODUCES.COUNTER_PRODUCTION', { counter_type: '-1/-1', amount: 4 }, 'Put four -1/-1 counters on target creature.'),
      atom('e', 'PRODUCES.COUNTER_PRODUCTION', { counter_type: '+1/+1', amount: 3 }, 'This creature enters with three +1/+1 counters on it.'),
    ] }));
    expect(m.get('PRODUCES.COUNTER_PRODUCTION[-1/-1]:enters#amount')).toBe(6);
    expect(m.get('PRODUCES.COUNTER_PRODUCTION[-1/-1]#amount')).toBe(4);
    expect(m.get('PRODUCES.COUNTER_PRODUCTION[+1/+1]:enters#amount')).toBe(3);
  });
  it('reads the words "enters with" only on a counter atom', () => {
    const m = features(card({ id: 'f', atoms: [atom('f', 'PRODUCES.CARD_DRAW', { amount: 1 }, 'When this creature enters with a counter on it, draw a card.')] }));
    expect(m.get('PRODUCES.CARD_DRAW')).toBe(1);
  });
  it('gives a cost its own column', () => {
    const m = features(card({ id: 's', atoms: [atom('s', 'PRODUCES.SACRIFICE', { actor: 'you' }, 'Sacrifice a creature:'), atom('s', 'PRODUCES.SACRIFICE', { actor: 'opponent' }, 'Each opponent sacrifices a creature.')] }));
    expect(m.get('PRODUCES.SACRIFICE:cost')).toBe(1);
    expect(m.get('PRODUCES.SACRIFICE')).toBe(1);
  });
  it('puts an unread size in its own column, with no number', () => {
    const m = features(card({ id: 'u', atoms: [draw('u', 'X')] }));
    expect(m.get('PRODUCES.CARD_DRAW#amount?')).toBe(1);
    expect(m.has('PRODUCES.CARD_DRAW#amount')).toBe(false);
  });
  it('reads a stat size with no sign', () => {
    const m = features(card({ id: 'st', atoms: [atom('st', 'COMBAT.STAT_CHANGE', { sign: '-' }, 'Target creature gets -3/-2 until end of turn.')] }));
    expect(m.get('COMBAT.STAT_CHANGE#stat_power')).toBe(3);
    expect(m.get('COMBAT.STAT_CHANGE#stat_toughness')).toBe(2);
  });
  it('holds a very large size at the cap', () => {
    const m = features(card({ id: 'o', atoms: [atom('o', 'COMBAT.STAT_CHANGE', { sign: '-' }, 'Target creature gets -0/-9999 until end of turn.'), draw('o', 1000)] }));
    expect(m.get('COMBAT.STAT_CHANGE#stat_toughness')).toBe(SIZE_CAP);
    expect(m.get('PRODUCES.CARD_DRAW#amount')).toBe(SIZE_CAP);
  });
  it('holds a very large body at the cap', () => {
    expect(features(card({ id: 'w2', type: 'Creature — Wall', power: '0', toughness: '30' })).get('body#toughness')).toBe(SIZE_CAP);
  });
  it('reads a limit on a removal target', () => {
    const narrow = features(card({ id: 'l', atoms: [atom('l', 'INTERACTION.TARGETED_REMOVAL', { removal_type: 'destroy' }, 'Destroy target nonblack creature.')] }));
    const wide = features(card({ id: 'w', atoms: [atom('w', 'INTERACTION.TARGETED_REMOVAL', { removal_type: 'destroy' }, 'Destroy target creature.')] }));
    expect(narrow.get('INTERACTION.TARGETED_REMOVAL#limited')).toBe(1);
    expect(wide.has('INTERACTION.TARGETED_REMOVAL#limited')).toBe(false);
  });
  it('reads the body of a creature, and a * has its own column', () => {
    expect(features(card({ id: 'c', type: 'Creature — Bear', power: '2', toughness: '3' }))).toEqual(new Map([['body#creature', 1], ['body#power', 2], ['body#toughness', 3]]));
    const star = features(card({ id: 'c2', type: 'Creature — Bear', power: '*', toughness: '3' }));
    expect(star.get('body#power?')).toBe(1);
    expect(star.has('body#power')).toBe(false);
  });
  it('gives no body to a card that is not a creature, or to a face with no cost', () => {
    expect(features(card({ id: 'v', type: 'Artifact — Vehicle', power: '4', toughness: '4' })).size).toBe(0);
    const back = card({ id: 'b3', extra_faces: [{ mana_cost: null, type_line: 'Creature — Bear', power: '9', toughness: '9' }] });
    expect(features(back).size).toBe(0);
  });
  it('reads no rarity and no speed: each column comes from an atom or a body', () => {
    const m = features(card({ id: 'r', type: 'Instant', atoms: [draw('r')] }));
    expect([...m.keys()].sort()).toEqual(['PRODUCES.CARD_DRAW', 'PRODUCES.CARD_DRAW#amount']);
  });
});

describe('designMatrix', () => {
  it('sorts the columns, whatever the order of a row', () => {
    const a = designMatrix([new Map([['b', 1], ['a', 2]]), new Map([['c', 3]])]);
    const b = designMatrix([new Map([['a', 2], ['b', 1]]), new Map([['c', 3]])]);
    expect(a).toEqual(b);
    expect(a.columns).toEqual(['a', 'b', 'c']);
    expect(a.rows[0]).toEqual([[0, 2], [1, 1]]);
  });
});

/** A fixed list of numbers, so the tests have no random draw. */
function sequence(n: number): number[] {
  let x = 12345;
  return Array.from({ length: n }, () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; });
}
function synthetic(n: number) {
  const s = sequence(3 * n);
  const rows: SparseRow[] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const [a, b, c] = [Math.floor(s[3 * i]! * 4), Math.floor(s[3 * i + 1]! * 3), Math.floor(s[3 * i + 2]! * 2)];
    rows.push([[0, a], [1, b], [2, c]]);
    y.push(1 + 0.5 * a + b + 2 * c + (i % 2 ? 0.25 : -0.25));
  }
  return { rows, y, folds: rows.map((_, i) => i % FOLDS) };
}

describe('fitRidge', () => {
  it('finds the true prices with a small penalty', () => {
    const rows: SparseRow[] = [[[0, 1]], [[1, 1]], [[0, 1], [1, 1]], [], [[0, 2], [1, 1]]];
    const y = rows.map((r) => r.reduce((s, [c, v]) => s + v * (c === 0 ? 2 : 3), 1));
    const fit = fitRidge(rows, y, 2, 1e-9);
    expect(fit.intercept).toBeCloseTo(1, 6);
    expect(fit.prices[0]).toBeCloseTo(2, 6);
    expect(fit.prices[1]).toBeCloseTo(3, 6);
  });
  it('keeps the intercept out of the penalty', () => {
    const { rows, y } = synthetic(50);
    const fit = fitRidge(rows, y, 3, 1e12);
    const mean = y.reduce((s, v) => s + v, 0) / y.length;
    for (const r of rows) expect(predict(fit, r)).toBeCloseTo(mean, 4);
  });
  it('gives equal prices to two columns that always appear together', () => {
    const rows: SparseRow[] = [[[0, 1], [1, 1]], [[0, 1], [1, 1]], [], [[0, 1], [1, 1], [2, 1]], [[2, 1]]];
    const fit = fitRidge(rows, [4, 4, 1, 5, 2], 3, 1);
    expect(fit.prices[0]).toBeCloseTo(fit.prices[1]!, 9);
  });
  it('fits only the rows of `use`', () => {
    const rows: SparseRow[] = [[[0, 1]], [], [[0, 1]], []];
    const fit = fitRidge(rows, [3, 1, 999, 999], 1, 1e-9, [0, 1]);
    expect(fit.prices[0]).toBeCloseTo(2, 6);
  });
});

describe('the held-out test (plan sec. 2.3)', () => {
  it('has a fixed split by a hash of oracle_id', () => {
    expect(foldOf('abc')).toBe(foldOf('abc'));
    const seen = new Set(Array.from({ length: 200 }, (_, i) => foldOf(`card-${i}`)));
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
  });
  it('gives each card a prediction that does not read its own mana value', () => {
    const { rows, y, folds } = synthetic(60);
    const base = heldOutTest(rows, y, 3, folds);
    const changed = [...y];
    changed[7] = 50;
    expect(heldOutTest(rows, changed, 3, folds).predictions[7]).toBe(base.predictions[7]);
  });
  it('chooses the ridge strength with no read of the held-out fold', () => {
    // The held-out fold is large, and its mana values are a mirror image, so a read of it moves the choice.
    const { rows, y } = synthetic(240);
    const folds = rows.map((_, i) => (i < 20 ? 0 : i < 40 ? 1 : 2));
    const mean = y.reduce((s, v) => s + v, 0) / y.length;
    const mirror = y.map((v, i) => (folds[i] === 2 ? 2 * mean - v : v));
    expect(chooseLambda(rows, mirror, 3, folds, 2)).toBe(chooseLambda(rows, y, 3, folds, 2));
  });
  it('chooses from the grid, and a real signal gets a small strength', () => {
    const { rows, y, folds } = synthetic(60);
    const lambda = chooseLambda(rows, y, 3, folds, null);
    expect(LAMBDAS).toContain(lambda);
    expect(lambda).toBeLessThanOrEqual(1);
  });
  it('beats the constant median on a real signal', () => {
    const { rows, y, folds } = synthetic(60);
    const t = heldOutTest(rows, y, 3, folds);
    expect(t.error).toBeLessThan(0.5);
    expect(t.baseline_error).toBeGreaterThan(t.error);
    expect(passesResultRule(t, 0)).toBe(true);
  });
  it('takes the constant from the training folds', () => {
    const rows: SparseRow[] = [[], [], [], []];
    const t = heldOutTest(rows, [1, 1, 5, 5], 0, [0, 0, 1, 1]);
    expect(t.baseline_error).toBe(4);
    expect(t.baseline_root_mean_square).toBe(4);
  });
});

describe('passesResultRule', () => {
  it('needs an error of at most 1.5 mana', () => {
    expect(passesResultRule({ error: 1.5, baseline_error: 2 }, 0)).toBe(true);
    expect(passesResultRule({ error: 1.51, baseline_error: 2 }, 0)).toBe(false);
  });
  it('needs an error lower than the constant median', () => {
    expect(passesResultRule({ error: 1, baseline_error: 1 }, 0)).toBe(false);
    expect(passesResultRule({ error: 1.2, baseline_error: 1.1 }, 0)).toBe(false);
  });
  it('needs an absolute correlation of at most 0.15 (plan sec. 2.4)', () => {
    const t = { error: 1, baseline_error: 2 };
    expect(MAX_CORRELATION).toBe(0.15);
    expect(passesResultRule(t, 0.15)).toBe(true);
    expect(passesResultRule(t, -0.15)).toBe(true);
    expect(passesResultRule(t, 0.151)).toBe(false);
    expect(passesResultRule(t, -0.646)).toBe(false);
  });
  it('fails a correlation that is not a number', () => {
    expect(passesResultRule({ error: 1, baseline_error: 2 }, Number.NaN)).toBe(false);
  });
});

describe('pearson', () => {
  it('reads a straight line as 1 or -1', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 9);
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 9);
  });
  it('reads no relation as 0, and a list with no spread as not a number', () => {
    expect(pearson([1, 2, 1, 2], [1, 1, 2, 2])).toBeCloseTo(0, 9);
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNaN();
  });
});

describe('adjustByMana (plan sec. 2.4)', () => {
  it('has the bins 0 to 1, 2, 3, 4, 5, 6 and 7 or more', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 12].map(manaBin)).toEqual([1, 1, 2, 3, 4, 5, 6, 7, 7, 7]);
  });
  it('takes off the median residual of the bin', () => {
    const residuals = new Map([['a', 1], ['b', 2], ['c', 6], ['d', -2], ['e', -4]]);
    const mana = new Map([['a', 0], ['b', 1], ['c', 1], ['d', 7], ['e', 9]]);
    const { adjusted, bins } = adjustByMana(residuals, mana);
    expect(bins).toEqual(new Map([[1, 2], [7, -3]]));
    expect(adjusted).toEqual(new Map([['a', -1], ['b', 0], ['c', 4], ['d', 1], ['e', -1]]));
  });
});

describe('median', () => {
  it('reads the middle, or the mean of the two middle values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('rateOf (the formula of the report)', () => {
  it('gives 0 under 1 mana, in each class', () => {
    expect(rateOf(0.99, 'plain')).toEqual({ rate: 0, reason: 'under_line' });
    expect(rateOf(-0.99, 'plain')).toEqual({ rate: 0, reason: 'under_line' });
    expect(rateOf(0.5, 'conditional')).toEqual({ rate: 0, reason: 'under_line' });
  });
  it('gives the gap from 1 mana', () => {
    expect(rateOf(1, 'plain')).toEqual({ rate: 1, reason: 'gap' });
    expect(rateOf(-2, 'plain')).toEqual({ rate: -2, reason: 'gap' });
    expect(rateOf(-2, 'dominated_in_pool')).toEqual({ rate: -2, reason: 'gap' });
  });
  it('gives a conditional card no penalty', () => {
    expect(rateOf(-2, 'conditional')).toEqual({ rate: 0, reason: 'no_penalty' });
    expect(rateOf(2, 'conditional')).toEqual({ rate: 2, reason: 'gap' });
  });
});

const groupInput = (spells: RewardCard[], atoms: RewardAtom[]): GroupInput => ({ spells, atoms, roles });
const spell = (id: string, cmc: number): RewardCard => ({ oracle_id: id, name: `Card ${id}`, cmc });

describe('bestGroups (plan sec. 2.3)', () => {
  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const wide = ids('w', 7);
  const small = ids('s', 5);
  const tiny = ids('t', 4);
  const spells = [...wide, ...small, ...tiny].map((id, i) => spell(id, 1 + (i % 3)));
  const atoms = [
    ...wide.map((id) => draw(id)),
    ...small.flatMap((id) => [draw(id), atom(id, 'PRODUCES.CREATE', {}, 'Create a token.')]),
    ...tiny.flatMap((id) => [draw(id), atom(id, 'COMBAT.STAT_CHANGE', {}, 'gets +1/+1')]),
  ];
  const best = bestGroups(makeGroups(groupInput(spells, atoms), reward, kindKey));

  it('takes the smallest group with at least 5 cards', () => {
    expect(best.get('s0')!.type).toBe('PRODUCES.CREATE');
    expect(best.get('w0')!.type).toBe('PRODUCES.CARD_DRAW');
  });
  it('passes over a group of 4 cards', () => {
    expect(best.get('t0')!.type).toBe('PRODUCES.CARD_DRAW');
  });
  it('passes over a group with one mana value', () => {
    const same = ids('z', 6);
    const groups = makeGroups(groupInput(same.map((id) => spell(id, 2)), same.map((id) => draw(id))), reward, kindKey);
    expect(bestGroups(groups).size).toBe(0);
  });
  it('takes the lower key on a tie, whatever the input order', () => {
    const cards = ids('e', 6);
    const both = cards.flatMap((id) => [draw(id), atom(id, 'PRODUCES.CREATE', {}, 'Create a token.')]);
    const list = cards.map((id, i) => spell(id, 1 + (i % 2)));
    const one = bestGroups(makeGroups(groupInput(list, both), reward, kindKey)).get('e0')!;
    const two = bestGroups(makeGroups(groupInput(list, [...both].reverse()), reward, kindKey)).get('e0')!;
    expect(one.key).toBe(two.key);
    expect(one.type).toBe('PRODUCES.CARD_DRAW');
  });
});

describe('rateSpells', () => {
  // Each card pays 1 mana for each card it draws, less `cheap`, `dear` and `dearcond`. A card has
  // others of its printed mana, so the bin step does not take its gap.
  const list: ProofCard[] = [];
  for (let i = 0; i < 30; i++) list.push(card({ id: `a${i}`, cost: `{${1 + (i % 3)}}`, atoms: [draw(`a${i}`, 1 + (i % 3))] }));
  list.push(card({ id: 'cheap', cost: '{1}', atoms: [draw('cheap', 3)] }));
  list.push(card({ id: 'dear', cost: '{3}', atoms: [draw('dear', 1)] }));
  // Other cards hold the condition, so its column does not take the whole gap of `dearcond`.
  for (const [id, cost] of [['dearcond', '{3}'], ['cond1', '{1}'], ['cond2', '{1}'], ['cond3', '{1}'], ['cond4', '{1}'], ['cond5', '{1}']] as const) {
    list.push(card({ id, cost, atoms: [draw(id, 1), atom(id, 'CARES_ABOUT.SPELL_CAST', {}, 'Whenever you cast a spell')] }));
  }
  list.push(card({ id: 'lonely', cost: '{2}', atoms: [atom('lonely', 'COMBAT.STAT_CHANGE', { sign: '+' }, 'gets +1/+1')] }));
  list.push(card({ id: 'xcard', cost: '{X}{1}', atoms: [draw('xcard', 'X')] }));
  // Four cards of the fit and one with no value: the group is too small.
  for (let i = 0; i < 4; i++) list.push(card({ id: `t${i}`, cost: `{${1 + (i % 2)}}`, atoms: [atom(`t${i}`, 'PRODUCES.CREATE', {}, 'Create a token.')] }));
  list.push(card({ id: 'tx', cost: '{X}', atoms: [atom('tx', 'PRODUCES.CREATE', {}, 'Create a token.')] }));
  list.push(card({ id: 'backed', cost: '{2}', extra_faces: [{ mana_cost: null }], atoms: [atom('backed', 'PRODUCES.CARD_DRAW', { amount: 1 }, 'Draw a card.', 1)] }));
  const input: GroupInput = {
    spells: list.map((c) => spell(c.oracle_id, ['xcard', 'tx'].includes(c.oracle_id) ? 1 : printedMana(c.faces))),
    atoms: list.flatMap((c) => c.atoms),
    roles,
  };
  const cards = new Map(list.map((c) => [c.oracle_id, c]));
  const classes = cardClasses(input, deckDemandTest(roles), new Set());
  const run = rateSpells(input, cards, classes);
  const row = new Map(run.rows.map((r) => [r.oracle_id, r]));

  it('gives one row to each spell', () => {
    expect(run.rows).toHaveLength(list.length);
    expect(run.fit_rows).toHaveLength(list.length - 3);
  });
  it('gives a null rate where the plan gives no value', () => {
    expect(row.get('xcard')).toMatchObject({ rate: null, predicted_mana: null, role_gap: null, reason: 'x_cost', group_key: null, printed_mana: 1 });
    expect(row.get('backed')).toMatchObject({ rate: null, predicted_mana: null, reason: 'face_no_cost' });
  });
  it('gives rate 0 and no gap to a spell with no group', () => {
    expect(row.get('lonely')).toMatchObject({ rate: 0, role_gap: null, reason: 'no_group', group_key: null });
    expect(row.get('lonely')!.predicted_mana).not.toBeNull();
  });
  it('counts only the cards of the fit toward the 5 cards of a group', () => {
    expect(row.get('t0')).toMatchObject({ reason: 'no_group', group_key: null });
  });
  it('computes the gap in two steps: the mana bin, then the group, with cards of the fit only', () => {
    const r = row.get('dear')!;
    const valued = run.rows.filter((x) => x.predicted_mana !== null);
    const binOf = (m: number) => median(valued.filter((x) => manaBin(x.printed_mana) === manaBin(m)).map((x) => x.predicted_mana! - x.printed_mana));
    const adjusted = (x: RateRow) => x.predicted_mana! - x.printed_mana - binOf(x.printed_mana);
    const members = run.rows.filter((x) => x.group_key === r.group_key);
    expect(members.map((m) => m.oracle_id)).not.toContain('xcard');
    expect(r.role_gap).toBeCloseTo(adjusted(r) - median(members.map(adjusted)), 9);
    expect(run.bin_medians.get(manaBin(r.printed_mana))).toBeCloseTo(binOf(r.printed_mana), 9);
  });
  it('gives each cost of a card its own bin, and adds the results', () => {
    const two = card({ id: 'two', cost: '{5}', extra_faces: [{ mana_cost: '{5}' }], atoms: [draw('two', 1), atom('two', 'PRODUCES.CARD_DRAW', { amount: 2 }, 'Draw two cards.', 1)] });
    const all = [...list, two];
    const more: GroupInput = { ...input, spells: [...input.spells, spell('two', 5)], atoms: all.flatMap((c) => c.atoms) };
    const r = rateSpells(more, new Map(all.map((c) => [c.oracle_id, c])), cardClasses(more, deckDemandTest(roles), new Set()));
    const prices = new Map(r.prices.map((x) => [x.column, x.price]));
    const residual = (row: FitRow) => [...features(row.card)].reduce((s, [k, v]) => s + v * prices.get(k)!, r.intercept) - row.mana;
    const own = r.fit_rows.filter((x) => x.oracle_id === 'two');
    // The sum of 10 mana is in the bin of 7 or more, and neither cost is.
    expect(r.bin_medians.has(5)).toBe(true);
    expect(r.adjusted.get('two')).toBeCloseTo(own.reduce((s, x) => s + residual(x) - r.bin_medians.get(5)!, 0), 9);
  });
  it('gives the correlation of the gap with printed mana', () => {
    const gapped = run.rows.filter((x) => x.role_gap !== null);
    expect(run.gap_correlation).toBeCloseTo(pearson(gapped.map((x) => x.role_gap!), gapped.map((x) => x.printed_mana)), 9);
  });
  it('rates the cheap card above its group and the dear card below it', () => {
    expect(row.get('cheap')!.rate!).toBeGreaterThan(1);
    expect(row.get('dear')!.rate!).toBeLessThan(-1);
  });
  it('gives no penalty to a conditional card with a low gap', () => {
    expect(row.get('dearcond')).toMatchObject({ rate: 0, reason: 'no_penalty', class: 'conditional' });
    expect(row.get('dearcond')!.role_gap!).toBeLessThan(-1);
    expect(row.get('dearcond')!.class_reason).toContain('CARES_ABOUT.SPELL_CAST');
  });
  it('gives the same values for another input order', () => {
    const again = rateSpells({ ...input, spells: [...input.spells].reverse(), atoms: [...input.atoms].reverse() }, cards, classes);
    expect(again.rows).toEqual(run.rows);
    expect(again.test).toEqual(run.test);
  });
  it('adds the rows of a card with two costs', () => {
    const two = card({ id: 'two', cost: '{2}', extra_faces: [{ mana_cost: '{1}' }], atoms: [draw('two', 1), atom('two', 'PRODUCES.CARD_DRAW', { amount: 2 }, 'Draw two cards.', 1)] });
    const all = [...list, two];
    const more: GroupInput = { ...input, spells: [...input.spells, spell('two', 2)], atoms: all.flatMap((c) => c.atoms) };
    const r = rateSpells(more, new Map(all.map((c) => [c.oracle_id, c])), cardClasses(more, deckDemandTest(roles), new Set()));
    expect(r.fit_rows.filter((x) => x.oracle_id === 'two').map((x) => x.mana)).toEqual([2, 1]);
    expect(r.rows.find((x) => x.oracle_id === 'two')!.printed_mana).toBe(3);
  });
});

describe('wordCost (Task 2, question 4)', () => {
  const blight = (quote: string) => ({ type_key: 'BLIGHT', quote });
  it('finds the action before the colon only', () => {
    expect(wordCost(blight('{T}, Blight 1: Surveil 1.'))).toBe(true);
    expect(wordCost({ type_key: 'EXILE', quote: '{T}, Exile a card from your graveyard: Add {R}.' })).toBe(true);
  });
  it('finds an additional cost', () => {
    expect(wordCost(blight('As an additional cost to cast this spell, you may blight 1.'))).toBe(true);
  });
  it('passes over an action after the colon', () => {
    expect(wordCost({ type_key: 'COUNTER_PRODUCTION', quote: '{4}: Put a +1/+1 counter on this creature.' })).toBe(false);
    expect(wordCost({ type_key: 'EXILE', quote: '{T}, Exile this artifact: Exile target card.' })).toBe(false);
  });
  it('reads only its five types', () => {
    expect(wordCost({ type_key: 'CARD_DRAW', quote: 'As an additional cost, draw a card.' })).toBe(false);
  });
  it('leaves reminder text out', () => {
    expect(wordCost(blight('Draw a card. (Blight 1: this is a reminder.)'))).toBe(false);
  });
});

describe('the table card_rates (migration 22)', () => {
  const row = (oracle_id: string, over: Partial<RateRow> = {}): RateRow => ({
    oracle_id, predicted_mana: 3, printed_mana: 2, role_gap: 1.5, rate: 1.5, class: 'plain', reason: 'gap', class_reason: null, group_key: 'k', ...over,
  });
  function fresh() {
    const db = openDb(':memory:');
    db.exec('PRAGMA foreign_keys = OFF');
    const insert = db.prepare(
      `INSERT INTO cards (oracle_id, name, layout, cmc, type_line, colors, color_identity, keywords, rarity, set_code, collector_number, oracle_hash, first_seen_snapshot_id, last_seen_snapshot_id)
       VALUES (?, ?, 'normal', 2, 'Sorcery', '[]', '[]', '[]', 'common', 'x', '1', ?, 1, 1)`,
    );
    for (const id of ['a', 'b', 'c']) insert.run(id, id, `hash-${id}`);
    return db;
  }
  it('exists on a fresh database, with migration 22', () => {
    const db = openDb(':memory:');
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'card_rates'").get()).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM schema_migrations WHERE id = 22').get()).toBeTruthy();
  });
  it('stores each value and the hash of the card', () => {
    const db = fresh();
    writeRates(db, 7, [row('a'), row('b', { rate: null, predicted_mana: null, role_gap: null, reason: 'x_cost', group_key: null })]);
    expect({ ...db.prepare('SELECT * FROM card_rates WHERE oracle_id = ?').get('a') as object }).toEqual({
      oracle_id: 'a', oracle_hash: 'hash-a', build_id: 7, predicted_mana: 3, printed_mana: 2, role_gap: 1.5, rate: 1.5, class: 'plain', reason: 'gap', class_reason: null, group_key: 'k',
    });
    expect((db.prepare('SELECT rate FROM card_rates WHERE oracle_id = ?').get('b') as { rate: number | null }).rate).toBeNull();
  });
  it('replaces the whole table, so it holds one build', () => {
    const db = fresh();
    writeRates(db, 7, [row('a'), row('b')]);
    writeRates(db, 8, [row('c')]);
    expect((db.prepare('SELECT oracle_id, build_id FROM card_rates').all() as unknown[]).map((r) => ({ ...(r as object) }))).toEqual([{ oracle_id: 'c', build_id: 8 }]);
  });
  it('goes with its build, so a delete of a build does not stop on a rate', () => {
    const db = fresh();
    db.exec(`INSERT INTO graph_builds (id, build_key, rule_set_id, schema_version, corpus_id, pool_snapshot_id, tests_version, atom_set_sha, scope, built_at, counts_json)
             VALUES (7, 'k', 1, 20, 1, 1, 1, 'sha', 'BR', 'now', '{}')`);
    writeRates(db, 7, [row('a')]);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('DELETE FROM graph_builds');
    expect((db.prepare('SELECT COUNT(*) n FROM card_rates').get() as { n: number }).n).toBe(0);
  });
  it('keeps the old rows when a write fails', () => {
    const db = fresh();
    writeRates(db, 7, [row('a')]);
    expect(() => writeRates(db, 8, [row('b'), row('no such card')])).toThrow();
    expect((db.prepare('SELECT oracle_id FROM card_rates').all() as unknown[]).map((r) => ({ ...(r as object) }))).toEqual([{ oracle_id: 'a' }]);
  });
});

describe('linkSource', () => {
  const edge = (supply: string | null, demand: string, class_id: string | null = null) => ({ supply_oracle: supply, demand_oracle: demand, class_id });
  const index = {
    cards: () => ['a', 'b'],
    edgesForCard: (id: string) => (id === 'a'
      ? { out: [edge('a', 'b')], in: [], classes: [edge(null, 'a', 'k')], anti: [edge('b', 'a')] }
      : { out: [], in: [edge('a', 'b')], classes: [], anti: [edge('b', 'a')] }),
    classes: new Map([['k', { members: ['b'] }]]),
  } as unknown as LinkIndex;
  const degree = (oracle_id: string, out_degree: number, in_degree: number, class_edges: number, anti_degree: number): StoredDegree => ({ oracle_id, out_degree, in_degree, class_edges, anti_degree });
  const stored = [degree('a', 1, 0, 1, 1), degree('b', 0, 1, 0, 1)];

  it('gives the links of each card, seen from that card', () => {
    const { links, cards } = linkSource(index, stored, 7);
    expect(cards).toBe(2);
    expect([...links('a').out]).toEqual(['b']);
    expect([...links('a').anti]).toEqual(['b']);
    expect([...links('b').anti]).toEqual(['a']);
    expect([...links('b').in]).toEqual(['a']);
  });
  it('joins a class to its members', () => {
    const { links } = linkSource(index, stored, 7);
    expect([...links('a').class_in]).toEqual(['k']);
    expect([...links('b').class_of]).toEqual(['k']);
  });
  it('stops when a card differs from card_degree, or has no row', () => {
    expect(() => linkSource(index, [degree('a', 9, 0, 1, 1), stored[1]!], 7)).toThrow(/1 of 2 cards differ/);
    expect(() => linkSource(index, [stored[0]!], 7)).toThrow(/1 of 2 cards differ/);
  });
  it('stops on a card outside the build', () => {
    expect(() => linkSource(index, stored, 7).links('z')).toThrow(/no links in build 7/);
  });
});

maybe('the real pool', () => {
  const buildId = (realDb.prepare('SELECT MAX(id) id FROM graph_builds').get() as { id: number }).id;
  const input = loadGroupInput(realDb, buildId);
  const cards = loadProofCards(realDb, input, buildId);
  const rule = rewardTest(input.roles);

  it('reads the same mana value as cards.cmc on each card with one cost', () => {
    for (const s of input.spells) {
      const c = cards.get(s.oracle_id)!;
      if (noValueReason(c, rule) === null && c.faces.filter((f) => f.mana_cost).length === 1) expect([c.name, printedMana(c.faces)]).toEqual([c.name, s.cmc]);
    }
  });
  it('gives the same values twice, and passes the result rule', () => {
    const classes = cardClasses(input, deckDemandTest(input.roles), new Set());
    const one = rateSpells(input, cards, classes);
    const two = rateSpells({ ...input, spells: [...input.spells].reverse() }, cards, classes);
    expect(two.rows).toEqual(one.rows);
    expect(one.rows).toHaveLength(input.spells.length);
    expect(passesResultRule(one.test, one.gap_correlation)).toBe(true);
    // No fold takes the edge of the grid, so the grid is wide enough.
    expect(Math.max(...one.test.lambdas)).toBeLessThan(LAMBDAS.at(-1)!);
    expect(Math.min(...one.test.lambdas)).toBeGreaterThan(LAMBDAS[0]!);
  });
  it('finds the 20 cost atoms of Task 2, question 4', () => {
    expect(input.atoms.filter((a) => rule(a) && wordCost(a))).toHaveLength(20);
  });
});
