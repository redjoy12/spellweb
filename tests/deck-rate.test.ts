import { describe, it, expect } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/client.js';
import { assembleSpells, candidates, type DeckCard, type SpellSlot } from '../src/deck/assemble.js';
import { checkGoal, GoalError, storedGoal, type Goal } from '../src/deck/goal.js';
import type { PairLink, PairTable } from '../src/deck/pairs.js';
import { deckPolicySha, loadDeckPolicy, type DeckPolicy } from '../src/deck/policy.js';
import { rateReady, ratesOfBuild, withRates, type CardRate } from '../src/deck/rates.js';
import { deckFixture, deckLine } from './helpers/deckFixture.js';

const policy = loadDeckPolicy();
const atWeight = (rate_weight: number): DeckPolicy => ({ ...policy, score: { ...policy.score, rate_weight } });

const card = (id: string, over: Partial<DeckCard> = {}): DeckCard => ({
  oracle_id: id, name: id, type_line: 'Sorcery', cmc: 2, costs: ['{1}{B}'], identity: ['B'], arena_id: 1,
  land: false, creature: false, legendary: false, interaction: false, tags: [], ...over,
});
const rated = (rate: number | null, role_gap: number | null = rate): CardRate => ({ rate, role_gap, reason: rate === null ? 'x_cost' : rate === 0 ? 'under_line' : 'gap' });
const goal = (over: Partial<Goal> = {}): Goal => ({ colours: 'B', seeds: ['seed'], excluded: [], target_turn: 6, interaction: 'none', min_creatures: 0, use_rate: true, pinned: [], excluded_tags: [], ...over });

function table(pos: Array<[string, string, number]>): PairTable {
  const link = (a: string, b: string, w: number): PairLink => ({ supply: a, demand: b, weight: w, key: `${a}>${b}`, grade: 'confirmed', rule_hashes: [], atom_ids: [], demand_atom_id: 0 });
  const t: PairTable = { buildId: null, pos: new Map(), anti: new Map(), linked: new Map() };
  const row = <V>(m: Map<string, V>, k: string, v: () => V) => { if (!m.has(k)) m.set(k, v()); return m.get(k)!; };
  for (const [a, b, w] of pos) {
    row(t.pos, a, () => new Map()).set(b, link(a, b, w));
    row(t.linked, a, () => new Set()).add(b);
    row(t.linked, b, () => new Set()).add(a);
  }
  return t;
}

/** `n` plain cards that link to the seed with one weight, so each fit ties. */
const filler = (n: number, over: (id: string, i: number) => Partial<DeckCard> = () => ({})) => {
  const cards = Array.from({ length: n }, (_, i) => { const id = `f${String(i).padStart(2, '0')}`; return card(id, over(id, i)); });
  return { cards, pos: cards.map((c): [string, string, number] => [c.oracle_id, 'seed', 0.1]) };
};
const ids = (r: SpellSlot[]) => r.map((s) => s.oracle_id);

/** The decks of `deckFixture`, recorded with the code of commit 73f6673, before this task. */
const BEFORE_THE_RATE: Record<string, string> = {
  'one seed': 'c108 4 link, c114 2 link, c116 3 quota, c034 4 quota, c055 3 quota, c001 3 quota, c043 2 link, c060 2 quota, c077 4 link, c089 2 quota, c102 3 link, c007 4 seed',
  'two seeds, heavy': 'c116 2 quota, c019 3 link, c022 4 link, c052 4 quota, c087 3 link, c148 2 quota, c020 4 seed, c023 2 quota, c151 4 link, c154 3 quota, c060 2 quota, c118 3 link, c033 4 seed',
  'no seed': 'c053 3 link, c105 2 link, c130 2 link, c155 2 link, c075 4 link, c152 2 link, c125 3 link, c035 3 link, c137 4 link, c154 3 link, c083 4 link, c092 4 link',
  'excluded cards': 'c029 3 quota, c081 2 quota, c106 4 quota, c108 2 link, c017 3 link, c036 3 link, c052 2 quota, c070 2 quota, c028 2 quota, c034 4 quota, c124 3 link, c050 4 seed',
  'four seeds': 'c029 3 quota, c052 3 quota, c129 3 link, c064 2 quota, c032 2 quota, c061 4 seed, c074 2 quota, c091 2 quota, c012 3 quota, c021 4 link, c060 4 seed, c063 2 seed, c062 4 seed',
};

describe('the off path (card rate plan Task 5)', () => {
  const f = deckFixture();
  const withRate = f.cards.map((c, i) => ({ ...c, rate: rated(i % 3 === 0 ? 3 - (i % 7) : 0, 0.5 - (i % 5) / 5) }));
  const off = (cards: DeckCard[], g: (typeof f.goals)[number], p = policy) => deckLine(assembleSpells(candidates(cards, g.goal), g.goal, f.table, g.copies, p));

  it('the record has at least 4 goals', () => {
    expect(f.goals.length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(BEFORE_THE_RATE)).toEqual(f.goals.map((g) => g.name));
  });
  it.each(f.goals.map((g) => [g.name, g] as const))('%s: the same deck as the code before this task', (name, g) => {
    expect(off(f.cards, g)).toBe(BEFORE_THE_RATE[name]);
  });
  it.each(f.goals.map((g) => [g.name, g] as const))('%s: rates on the cards and a high weight change nothing', (name, g) => {
    expect(off(withRate, g, atWeight(50))).toBe(BEFORE_THE_RATE[name]);
  });
  it('the same rates with the switch on change the deck, so these tests can fail', () => {
    const changed = f.goals.filter((g) => off(withRate, { ...g, goal: { ...g.goal, use_rate: true, pinned: [], excluded_tags: [] } }) !== BEFORE_THE_RATE[g.name]);
    expect(changed.length).toBeGreaterThanOrEqual(4);
  });
});

describe('the rate in the fit (plan sec. 2.5)', () => {
  it('adds rate_weight * rate to the fit of a card', () => {
    const pos: Array<[string, string, number]> = [['a', 'seed', 1], ['b', 'seed', 1]];
    const cards = [card('seed'), card('a', { rate: rated(2) }), card('b')];
    const fit = (r: SpellSlot[], id: string) => r.find((s) => s.oracle_id === id)!.fit;
    const on = assembleSpells(cards, goal(), table(pos), 10, atWeight(0.1));
    expect(fit(on, 'a') - fit(on, 'b')).toBeCloseTo(0.2, 10);
  });
  it('a high rate wins over a card with the same links, and a low rate loses to a rate of 0', () => {
    const f = filler(30, (id) => (id === 'f20' ? { rate: rated(2) } : id === 'f00' ? { rate: rated(-2) } : {}));
    const r = assembleSpells([card('seed'), ...f.cards], goal(), table(f.pos), 11, atWeight(0.1));
    expect(ids(r)).toContain('f20');
    expect(ids(r)).not.toContain('f00');
  });
  it('a null rate reads as 0, in the fit and in the ties', () => {
    const f = filler(10, (id) => (id === 'f00' ? { rate: rated(null) } : { rate: rated(0, 0) }));
    const r = assembleSpells([card('seed'), ...f.cards], goal(), table(f.pos), 9, atWeight(0.5));
    expect(ids(r)).toContain('f00');
  });
  it('a card with a high rate and no link can enter: the term reaches each search step', () => {
    const f = filler(30);
    const big = card('big', { rate: rated(3) });
    const low = assembleSpells([card('seed'), big, ...f.cards], goal(), table(f.pos), 36, atWeight(0));
    const high = assembleSpells([card('seed'), big, ...f.cards], goal(), table(f.pos), 36, atWeight(1));
    expect(ids(low)).not.toContain('big');
    expect(ids(high)).toContain('big');
  });
  it('the switch changes no link', () => {
    const f = filler(30, (_, i) => ({ rate: rated(i - 15) }));
    const t = table(f.pos);
    const before = structuredClone(t);
    assembleSpells([card('seed'), ...f.cards], goal(), t, 36, policy);
    expect(t).toEqual(before);
  });
  it('each spell stays a candidate: a low rate never cuts a card', () => {
    const f = filler(4, () => ({ rate: rated(-3) }));
    const r = assembleSpells([card('seed'), ...f.cards], goal(), table(f.pos), 16, policy);
    expect(ids(r).sort()).toEqual(['f00', 'f01', 'f02', 'f03', 'seed']);
  });
});

describe('each tie reads the rate, then role_gap, then the lower oracle_id (plan sec. 2.5)', () => {
  // A weight of 0 leaves only the ties, so the fit of each filler card is the same.
  const tied = atWeight(0);
  const run = (rate: (id: string) => CardRate | undefined, copies = 11) => {
    const f = filler(30, (id) => { const r = rate(id); return r ? { rate: r } : {}; });
    return ids(assembleSpells([card('seed'), ...f.cards], goal(), table(f.pos), copies, tied)).filter((x) => x !== 'seed');
  };
  it('the rate decides first', () => {
    expect(run((id) => (id === 'f25' ? rated(1, 0) : id === 'f26' ? rated(2, -5) : rated(0, 9)))).toEqual(['f25', 'f26', 'f00'].sort());
  });
  it('then role_gap', () => {
    expect(run((id) => (id === 'f25' ? rated(0, 0.2) : id === 'f26' ? rated(0, 0.4) : rated(0, 0)))).toEqual(['f00', 'f25', 'f26']);
  });
  it('a null gap reads as 0, so it stands between a higher gap and a lower gap', () => {
    expect(run((id) => (id === 'f00' ? rated(0, -0.1) : id === 'f25' ? rated(0, 0.1) : rated(0, null)))).toEqual(['f01', 'f02', 'f25']);
  });
  it('then the lower oracle_id', () => {
    expect(run(() => rated(0, 0))).toEqual(['f00', 'f01', 'f02']);
  });
  it('the copies read the same ties', () => {
    const f = filler(5, (id) => ({ rate: id === 'f04' ? rated(1) : rated(0, 0) }));
    const r = assembleSpells([card('seed'), ...f.cards], goal({ seeds: ['seed'] }), table(f.pos), 19, tied);
    const copies = (id: string) => r.find((s) => s.oracle_id === id)!.copies;
    expect(copies('f04')).toBeGreaterThan(copies('f03'));
  });
  it('the off path keeps the lower oracle_id', () => {
    const f = filler(30, (id) => (id === 'f25' ? { rate: rated(2) } : {}));
    const r = assembleSpells([card('seed'), ...f.cards], goal({ use_rate: false, pinned: [], excluded_tags: [] }), table(f.pos), 11, tied);
    expect(ids(r).filter((x) => x !== 'seed')).toEqual(['f00', 'f01', 'f02']);
  });
});

describe('the goal and the policy', () => {
  const d = openDb(':memory:');
  d.exec("INSERT INTO snapshots (source_type,source_uri,source_updated_at,ingested_at,status) VALUES ('t','u','t','t','complete')");
  d.prepare(`INSERT INTO cards (oracle_id,name,layout,cmc,type_line,colors,color_identity,keywords,rarity,arena_id,set_code,collector_number,oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id,rotated)
    VALUES ('a','a','normal',2,'Sorcery','[]','["B"]','[]','c',1,'s','1','h',1,1,0)`).run();
  const old = { colours: 'B', seeds: ['a'], excluded: [], target_turn: 6, interaction: 'some', min_creatures: 14 } satisfies Omit<Goal, 'use_rate' | 'pinned' | 'excluded_tags'>;

  it('an old stored goal reads as off', () => {
    expect(checkGoal(d, old, policy).use_rate).toBe(false);
    expect(storedGoal(old).use_rate).toBe(false);
    expect(storedGoal({ ...old, use_rate: true, pinned: [], excluded_tags: [] }).use_rate).toBe(true);
    expect(JSON.parse(JSON.stringify(storedGoal(old)))).toEqual({ ...old, use_rate: false, pinned: [], excluded_tags: [] });
  });
  it('the switch takes only true or false', () => {
    expect(checkGoal(d, { ...old, use_rate: true, pinned: [], excluded_tags: [] }, policy).use_rate).toBe(true);
    expect(() => checkGoal(d, { ...old, use_rate: 'yes' }, policy)).toThrow(GoalError);
  });
  it('rate_weight is in the policy and in its SHA', () => {
    expect(policy.score.rate_weight).toBeGreaterThan(0);
    expect(deckPolicySha(atWeight(0.5))).not.toBe(deckPolicySha(policy));
  });
});

describe('the rate table (Task 4 hand-over)', () => {
  /** A database with one build in `card_rates`. `card_rates.build_id` has a foreign key, and this test needs no real build. */
  function db(): DatabaseSync {
    const d = openDb(':memory:');
    d.exec('PRAGMA foreign_keys = OFF');
    d.exec("INSERT INTO snapshots (source_type,source_uri,source_updated_at,ingested_at,status) VALUES ('t','u','t','t','complete')");
    const add = d.prepare(`INSERT INTO cards (oracle_id,name,layout,cmc,type_line,colors,color_identity,keywords,rarity,arena_id,set_code,collector_number,oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id,rotated)
      VALUES (?,?,'normal',2,'Sorcery','[]','["B"]','[]','c',1,'s','1',?,1,1,0)`);
    const rate = d.prepare(`INSERT INTO card_rates (oracle_id,oracle_hash,build_id,predicted_mana,printed_mana,role_gap,rate,class,reason) VALUES (?,?,7,3,2,?,?,'plain',?)`);
    for (const id of ['strong', 'none', 'nogroup', 'changed', 'norow']) add.run(id, id, 'h');
    rate.run('strong', 'h', 1.5, 1.5, 'gap');
    rate.run('none', 'h', null, null, 'x_cost');
    rate.run('nogroup', 'h', null, 0, 'no_group');
    rate.run('changed', 'older hash', 2, 2, 'gap');
    return d;
  }

  it('rateReady reads the build', () => {
    expect(rateReady(db(), 7)).toBe(true);
    expect(rateReady(db(), 8)).toBe(false);
  });
  it('another build gives an error that says what to run', () => {
    expect(() => ratesOfBuild(db(), 8)).toThrow(GoalError);
    expect(() => ratesOfBuild(db(), 8)).toThrow(/Run npm run rate-fit/);
    expect(() => ratesOfBuild(db(), undefined)).toThrow(/Run npm run rate-fit/);
  });
  it('gives the rate and the reason, and a card with no row or a changed text has no value', () => {
    const r = ratesOfBuild(db(), 7);
    expect(r.get('strong')).toEqual({ rate: 1.5, role_gap: 1.5, reason: 'gap' });
    expect(r.get('none')).toEqual({ rate: null, role_gap: null, reason: 'x_cost' });
    expect(r.get('nogroup')).toEqual({ rate: 0, role_gap: null, reason: 'no_group' });
    const cards = withRates([card('changed'), card('norow')], r);
    expect(cards.map((c) => c.rate)).toEqual([{ rate: null, role_gap: null, reason: 'no_row' }, { rate: null, role_gap: null, reason: 'no_row' }]);
  });
});
