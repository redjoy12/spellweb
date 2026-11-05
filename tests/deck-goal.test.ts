import { describe, it, expect } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/client.js';
import { appliedMigrations } from '../src/db/migrate.js';
import { checkGoal, coloursFit, GoalError, isLand } from '../src/deck/goal.js';
import { deckPolicySha, loadDeckPolicy } from '../src/deck/policy.js';

const policy = loadDeckPolicy();

/** A small database with the cards of the goal tests. */
function db(): DatabaseSync {
  const d = openDb(':memory:');
  d.exec("INSERT INTO snapshots (source_type,source_uri,source_updated_at,ingested_at,status) VALUES ('t','u','t','t','complete')");
  const add = d.prepare(`INSERT INTO cards (oracle_id,name,layout,cmc,type_line,colors,color_identity,keywords,rarity,arena_id,set_code,collector_number,oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id,rotated)
    VALUES (?,?,'normal',2,?,'[]',?,'[]','c',?,'s','1','h',1,1,?)`);
  const row = (id: string, type: string, identity: string, arena: number | null = 1, rotated = 0) => add.run(id, `name ${id}`, type, identity, arena, rotated);
  row('b1', 'Creature — Human', '["B"]');
  row('b2', 'Sorcery', '["B"]');
  row('b3', 'Instant', '["B"]');
  row('b4', 'Instant', '["B"]');
  row('b5', 'Instant', '["B"]');
  row('r1', 'Instant', '["R"]');
  row('gold', 'Instant', '["B","R"]');
  row('none', 'Artifact', '[]');
  row('w1', 'Instant', '["W"]');
  row('land', 'Land', '["B"]');
  row('off', 'Instant', '["B"]', null);
  row('old', 'Instant', '["B"]', 1, 1);
  return d;
}

const goal = (over: Record<string, unknown> = {}) => ({ colours: 'B', seeds: ['b1'], target_turn: 6, interaction: 'some', ...over });

describe('checkGoal (design sec. 4)', () => {
  const d = db();
  const bad = (over: Record<string, unknown>, text: RegExp) => {
    let err: unknown;
    try { checkGoal(d, goal(over), policy); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GoalError);
    expect((err as Error).message).toMatch(text);
  };

  it('accepts a good goal and fills the defaults', () => {
    expect(checkGoal(d, goal(), policy)).toEqual({ colours: 'B', seeds: ['b1'], excluded: [], target_turn: 6, interaction: 'some', min_creatures: 14, use_rate: false, pinned: [], excluded_tags: [] });
  });
  it('accepts a colourless seed and a two-colour seed in a BR goal', () => {
    expect(checkGoal(d, goal({ colours: 'BR', seeds: ['none', 'gold', 'r1', 'b1'] }), policy).seeds).toHaveLength(4);
  });
  it('a wrong card ID gives an error', () => {
    bad({ seeds: ['nothing'] }, /no card with ID nothing/);
    bad({ excluded: ['nothing'] }, /no card with ID nothing/);
  });
  it('a card outside the colours gives an error', () => {
    bad({ seeds: ['r1'] }, /outside the colours B/);
    bad({ colours: 'BR', seeds: ['w1'] }, /outside the colours BR/);
  });
  it('more than 4 seeds give an error', () => {
    bad({ seeds: ['b1', 'b2', 'b3', 'b4', 'b5'] }, /seeds/);
  });
  it('seeds are optional: an empty list and a goal with no list are good', () => {
    expect(checkGoal(d, goal({ seeds: [] }), policy).seeds).toEqual([]);
    const { seeds: _, ...noList } = goal();
    expect(checkGoal(d, noList, policy).seeds).toEqual([]);
  });
  it('the form limits give errors', () => {
    bad({ target_turn: 3 }, /target_turn/);
    bad({ target_turn: 9 }, /target_turn/);
    bad({ min_creatures: 31 }, /min_creatures/);
    bad({ colours: 'WB' }, /colours/);
    bad({ interaction: 'lots' }, /interaction/);
    bad({ other: 1 }, /other/);
  });
  it('a seed that is rotated, not on Arena, a land, a repeat or also excluded gives an error', () => {
    bad({ seeds: ['old'] }, /rotated/);
    bad({ seeds: ['off'] }, /not on Arena/);
    bad({ seeds: ['land'] }, /is a land/);
    bad({ seeds: ['b1', 'b1'] }, /two times/);
    bad({ excluded: ['b1'] }, /excluded/);
  });
  it('a "must have" card has the checks of a seed (build chat design sec. 3)', () => {
    expect(checkGoal(d, goal({ pinned: ['b2', 'gold'], colours: 'BR' }), policy).pinned).toEqual(['b2', 'gold']);
    bad({ pinned: ['r1'] }, /outside the colours B/);
    bad({ pinned: ['land'] }, /is a land/);
    bad({ pinned: ['old'] }, /rotated/);
    bad({ pinned: ['b2', 'b2'] }, /two times/);
    bad({ pinned: ['b1'] }, /seed card and a "must have" card/);
    bad({ pinned: ['b2'], excluded: ['b2'] }, /"must have" card and an excluded card/);
    bad({ pinned: ['nothing'] }, /no card with ID nothing/);
  });
  it('a "never" tag must be in the atom schema', () => {
    expect(checkGoal(d, goal({ excluded_tags: ['PRODUCES.DISCARD'] }), policy).excluded_tags).toEqual(['PRODUCES.DISCARD']);
    bad({ excluded_tags: ['PRODUCES.NOTHING'] }, /no tag PRODUCES.NOTHING/);
    bad({ excluded_tags: ['lower.case'] }, /FAMILY.TYPE_KEY/);
    bad({ themes: ['PRODUCES.DISCARD'] }, /themes/);
  });
});

describe('card facts', () => {
  it('isLand reads the front face only', () => {
    expect(isLand('Basic Land — Swamp')).toBe(true);
    expect(isLand('Land — Town // Instant — Adventure')).toBe(true);
    expect(isLand('Legendary Creature — God // Land')).toBe(false);
    expect(isLand('Creature — Human')).toBe(false);
  });
  it('coloursFit tests each letter', () => {
    expect(coloursFit([], 'B')).toBe(true);
    expect(coloursFit(['B', 'R'], 'BR')).toBe(true);
    expect(coloursFit(['B', 'R'], 'B')).toBe(false);
  });
});

describe('decks table and policy (design sec. 11)', () => {
  it('a fresh database has the table and migration 21', () => {
    const d = openDb(':memory:');
    expect(appliedMigrations(d)).toContain(21);
    expect((d.prepare('PRAGMA table_info(decks)').all() as Array<{ name: string }>).map((c) => c.name))
      .toEqual(['id', 'build_id', 'goal_json', 'policy_sha', 'deck_json', 'created_at', 'brief']); // brief: migration 25
  });
  it('the policy has the values of the design', () => {
    expect(policy.score).toEqual({ hub_power: 0.5, anti_penalty: 0.25, seed_weight: 3, weak_factor: 0.25, rate_weight: 0.046, owner_link_weight: 0.373 });
    expect(policy.search.beam_width).toBe(12);
    expect(policy.copies.thirds).toEqual([4, 3, 2]);
    expect([policy.mana.land_probability, policy.mana.colour_probability]).toEqual([0.6, 0.8]);
    expect([policy.mana.lands_min, policy.mana.lands_max]).toEqual([20, 26]);
  });
  it('the SHA changes with a value', () => {
    expect(deckPolicySha(policy)).not.toBe(deckPolicySha({ ...policy, score: { ...policy.score, hub_power: 0.6 } }));
  });
});
