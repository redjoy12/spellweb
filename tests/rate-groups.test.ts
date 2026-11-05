import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/client.js';
import {
  COST_PARAMS, SIZE_PARAMS, groupCounts, groupKey, isCostAtom, isRewardType, isSupplyType, keyParams, loadGroupInput, makeGroups, maskedWords, rewardTest,
  sampleGroups, wordings, type GroupInput, type RewardAtom, type RewardCard, type TypeRole,
} from '../src/rate/groups.js';

const value = { kind: 'value' } as const;
const cost = { kind: 'cost' } as const;
const role = (family: string, type_key: string, r: TypeRole['role'], resources: TypeRole['resources'] = [value], status: TypeRole['status'] = 'accepted'): TypeRole =>
  ({ family, type_key, role: r, status, resources });
const roles: TypeRole[] = [
  role('PRODUCES', 'CARD_DRAW', 'supply'),
  role('PRODUCES', 'DAMAGE', 'supply'),
  role('PRODUCES', 'LIFE_LOSS', 'supply'),
  role('PRODUCES', 'SACRIFICE', 'both'),
  role('PRODUCES', 'DISCARD', 'both'),
  role('PRODUCES', 'EXILE', 'supply'),
  role('INTERACTION', 'TARGETED_REMOVAL', 'both'),
  role('ENABLES', 'ACTIVATE', 'both', [cost]),
  role('ENABLES', 'SHUFFLE', 'supply', []),
  role('CARES_ABOUT', 'ENTERS_BATTLEFIELD', 'demand', []),
  role('COMBAT', 'FLYING', 'none', []),
];

let nextId = 1;
const atom = (oracle_id: string, type: string, params: RewardAtom['params'] = {}, quote = `${type} text`): RewardAtom => {
  const [family, type_key] = type.split('.') as [string, string];
  return { id: nextId++, oracle_id, face_index: 0, family, type_key, params, quote };
};
const card = (oracle_id: string, cmc: number): RewardCard => ({ oracle_id, name: `Card ${oracle_id}`, cmc });
const input = (spells: RewardCard[], atoms: RewardAtom[]): GroupInput => ({ spells, atoms, roles });

describe('the reward rule', () => {
  it('a reward type has an accepted supply side and a value resource', () => {
    expect(isRewardType(role('PRODUCES', 'CARD_DRAW', 'supply'))).toBe(true);
    expect(isRewardType(role('INTERACTION', 'TARGETED_REMOVAL', 'both'))).toBe(true);
  });
  it('a demand or none role, or a disputed role, is not a reward', () => {
    expect(isRewardType(role('COMBAT', 'FLYING', 'none'))).toBe(false);
    expect(isRewardType(role('ENABLES', 'WARD', 'demand'))).toBe(false);
    expect(isRewardType(role('PRODUCES', 'CARD_DRAW', 'supply', [value], 'disputed'))).toBe(false);
  });
  it('a type with only a cost resource, or with no resource, is not a reward', () => {
    expect(isRewardType(role('ENABLES', 'ACTIVATE', 'both', [cost]))).toBe(false);
    expect(isRewardType(role('ENABLES', 'SHUFFLE', 'supply', []))).toBe(false);
    expect(isRewardType(role('ENABLES', 'CAST', 'both', [cost, value]))).toBe(true);
  });
  it('a trigger is never a reward, also with a supply role', () => {
    expect(isSupplyType(role('CARES_ABOUT', 'DISCARD', 'both'))).toBe(false);
    expect(isRewardType(role('CARES_ABOUT', 'DISCARD', 'supply'))).toBe(false);
  });
  it('an atom that pays, or that takes your own resource, is a cost', () => {
    expect(isCostAtom(atom('a', 'PRODUCES.SACRIFICE', { actor: 'opponent', decision: 'cost' }))).toBe(true);
    expect(isCostAtom(atom('a', 'PRODUCES.SACRIFICE', { actor: 'you', decision: 'forced' }))).toBe(true);
    expect(isCostAtom(atom('a', 'PRODUCES.DISCARD', { actor: 'you' }))).toBe(true);
    expect(isCostAtom(atom('a', 'PRODUCES.LIFE_LOSS', { player: 'you' }))).toBe(true);
    expect(isCostAtom(atom('a', 'PRODUCES.EXILE', { object: 'self' }))).toBe(true);
  });
  it('the same atom on an opponent is a reward', () => {
    const test = rewardTest(roles);
    expect(test(atom('a', 'PRODUCES.EXILE', { object: 'any' }))).toBe(true);
    expect(test(atom('a', 'PRODUCES.EXILE', { object: 'self' }))).toBe(false);
    expect(test(atom('a', 'PRODUCES.SACRIFICE', { actor: 'opponent', decision: 'forced' }))).toBe(true);
    expect(test(atom('a', 'PRODUCES.DISCARD', { actor: 'opponent' }))).toBe(true);
    expect(test(atom('a', 'PRODUCES.LIFE_LOSS', { player: 'opponent' }))).toBe(true);
    expect(test(atom('a', 'PRODUCES.LIFE_LOSS', { player: 'you' }))).toBe(false);
  });
});

describe('the group key', () => {
  it('has no size param and no cost param', () => {
    const params = Object.fromEntries([...SIZE_PARAMS, ...COST_PARAMS].map((p) => [p, 'x']));
    expect(keyParams({ ...params, recipient: 'creature' })).toEqual({ recipient: 'creature' });
  });
  it('keeps the kind of the reward', () => {
    expect(groupKey(atom('a', 'PRODUCES.DAMAGE', { amount: 2, recipient: 'creature', targeted: true })))
      .not.toBe(groupKey(atom('b', 'PRODUCES.DAMAGE', { amount: 2, recipient: 'opponent', targeted: false })));
  });
  it('does not change with param order, array order or an empty value', () => {
    const a = atom('a', 'PRODUCES.DAMAGE', { recipient: 'any', targeted: true, tags: ['b', 'a'], none: null, text: '', list: [] });
    const b = atom('b', 'PRODUCES.DAMAGE', { tags: ['a', 'b'], targeted: true, recipient: 'any' });
    expect(groupKey(a)).toBe(groupKey(b));
    expect(groupKey(a)).toBe('PRODUCES.DAMAGE {"recipient":"any","tags":["a","b"],"targeted":true}');
  });
});

describe('makeGroups', () => {
  it('puts cards with a different size and cost in one group', () => {
    const g = makeGroups(input([card('a', 2), card('b', 5)], [
      atom('a', 'PRODUCES.CARD_DRAW', { amount: 1 }), atom('b', 'PRODUCES.CARD_DRAW', { amount: 3 }),
    ]));
    expect(g).toHaveLength(1);
    expect(g[0]!.members.map((m) => m.oracle_id)).toEqual(['a', 'b']);
    expect(g[0]!.mana_values).toEqual([2, 5]);
    expect(g[0]!.spread).toBe(true);
  });
  it('a trigger makes no group, and its reward does', () => {
    const g = makeGroups(input([card('a', 2), card('b', 4)], [
      atom('a', 'CARES_ABOUT.ENTERS_BATTLEFIELD'), atom('a', 'PRODUCES.CARD_DRAW', { amount: 1 }),
      atom('b', 'CARES_ABOUT.ENTERS_BATTLEFIELD'),
    ]));
    expect(g.map((x) => x.key)).toEqual(['PRODUCES.CARD_DRAW {}']);
  });
  it('a card is in one group for each kind of reward, and once in each group', () => {
    const g = makeGroups(input([card('a', 2)], [
      atom('a', 'PRODUCES.CARD_DRAW', { amount: 1 }), atom('a', 'PRODUCES.CARD_DRAW', { amount: 2 }),
      atom('a', 'PRODUCES.DAMAGE', { amount: 2, recipient: 'any', targeted: true }),
    ]));
    expect(g).toHaveLength(2);
    const draw = g.find((x) => x.type === 'PRODUCES.CARD_DRAW')!;
    expect(draw.members).toHaveLength(1);
    expect(draw.members[0]!.atoms).toHaveLength(2);
  });
  it('one mana value gives no spread', () => {
    const g = makeGroups(input([card('a', 3), card('b', 3)], [atom('a', 'PRODUCES.CARD_DRAW'), atom('b', 'PRODUCES.CARD_DRAW')]));
    expect(g[0]!.spread).toBe(false);
  });
  it('leaves out the atoms of a card that is not in the spell list', () => {
    expect(makeGroups(input([card('a', 3)], [atom('land', 'PRODUCES.CARD_DRAW')]))).toEqual([]);
  });
  it('sorts the largest group first', () => {
    const g = makeGroups(input([card('a', 1), card('b', 2)], [
      atom('a', 'PRODUCES.DAMAGE', { recipient: 'any' }), atom('a', 'PRODUCES.CARD_DRAW'), atom('b', 'PRODUCES.CARD_DRAW'),
    ]));
    expect(g.map((x) => x.members.length)).toEqual([2, 1]);
  });
  it('takes another atom test', () => {
    const g = makeGroups(input([card('a', 1)], [atom('a', 'COMBAT.FLYING')]), () => true);
    expect(g.map((x) => x.key)).toEqual(['COMBAT.FLYING {}']);
  });
});

describe('words of a group', () => {
  it('masks numbers, X and the card name, and removes reminder text', () => {
    expect(maskedWords('Grim Bolt deals 3 damage. (It stays.) Draw X cards.', 'Grim Bolt')).toBe('~ deals N damage. Draw N cards.');
    expect(maskedWords('Back Face draws 1.', 'Front Face // Back Face')).toBe('~ draws N.');
  });
  it('counts the cards of each wording, the most common first', () => {
    const [g] = makeGroups(input([card('a', 1), card('b', 2), card('c', 3)], [
      atom('a', 'PRODUCES.CARD_DRAW', {}, 'Draw 1 card.'), atom('b', 'PRODUCES.CARD_DRAW', {}, 'Draw 2 card.'),
      atom('c', 'PRODUCES.CARD_DRAW', {}, 'You draw a card.'),
    ]));
    expect(wordings(g!)).toEqual([{ words: 'Draw N card.', cards: 2 }, { words: 'You draw a card.', cards: 1 }]);
  });
});

describe('groupCounts', () => {
  const spells = [card('a', 1), card('b', 2), card('c', 2), card('d', 4), card('e', 4)];
  const groups = makeGroups(input(spells, [
    atom('a', 'PRODUCES.CARD_DRAW', {}, 'Draw a card.'), atom('b', 'PRODUCES.CARD_DRAW', {}, 'Draw a card.'),
    atom('b', 'PRODUCES.DAMAGE', { recipient: 'any' }, 'Hit.'), atom('c', 'PRODUCES.DAMAGE', { recipient: 'any' }, 'Hit.'),
    atom('d', 'PRODUCES.DAMAGE', { recipient: 'creature' }, 'Hit.'),
  ]));
  const c = groupCounts(groups, spells.length);
  it('counts groups and spells', () => {
    expect(c).toMatchObject({ spells: 5, groups: 3, groups_of_2: 2, spread_groups: 1, spells_in_any: 4, spells_in_2: 3, spells_in_spread: 2, same_words: 1 });
    expect(c.mean_groups).toBe(1);
    expect(c.narrowest).toEqual({ '2-9': 2, '10-49': 0, '50+': 0 });
  });
  it('gives a spell the size of its smallest spread group', () => {
    const many = Array.from({ length: 12 }, (_, i) => card(`m${i}`, i));
    const atoms = many.map((m) => atom(m.oracle_id, 'PRODUCES.CARD_DRAW'));
    atoms.push(atom('m0', 'PRODUCES.DAMAGE', { recipient: 'any' }), atom('m1', 'PRODUCES.DAMAGE', { recipient: 'any' }));
    expect(groupCounts(makeGroups(input(many, atoms)), 12).narrowest).toEqual({ '2-9': 2, '10-49': 10, '50+': 0 });
  });
});

describe('sampleGroups', () => {
  const spells = Array.from({ length: 12 }, (_, i) => card(`s${i}`, i));
  const atoms = spells.flatMap((s, i) => Array.from({ length: i + 1 }, (_, k) => atom(s.oracle_id, 'PRODUCES.DAMAGE', { recipient: `r${k}` })));
  const groups = makeGroups(input(spells, atoms));
  it('takes equal steps from the largest group, with spread groups only', () => {
    const s = sampleGroups(groups, 3);
    expect(s).toHaveLength(3);
    expect(s[0]).toBe(groups[0]);
    expect(s.every((g) => g.spread)).toBe(true);
    expect(s[0]!.members.length).toBeGreaterThan(s[2]!.members.length);
  });
  it('gives each spread group when the sample is larger', () => {
    expect(sampleGroups(groups, 100)).toEqual(groups.filter((g) => g.spread));
  });
  it('gives the same sample each time', () => {
    expect(sampleGroups(groups, 5).map((g) => g.key)).toEqual(sampleGroups(groups, 5).map((g) => g.key));
  });
});

describe('loadGroupInput', () => {
  function db() {
    const d = openDb(':memory:');
    d.exec('PRAGMA foreign_keys = OFF');
    const addCard = d.prepare(`INSERT INTO cards (oracle_id,name,layout,cmc,type_line,colors,color_identity,keywords,rarity,arena_id,set_code,collector_number,oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id,rotated)
      VALUES (?,?,'normal',?,?,'[]','[]','[]','c',?,'s','1','h',1,1,?)`);
    addCard.run('spell', 'A Spell', 3, 'Sorcery', 1, 0);
    addCard.run('land', 'A Land', 0, 'Land', 2, 0);
    addCard.run('off', 'Not On Arena', 3, 'Sorcery', null, 0);
    addCard.run('old', 'Rotated', 3, 'Sorcery', 3, 1);
    addCard.run('other', 'Other Build', 3, 'Sorcery', 4, 0);
    const addAtom = d.prepare(`INSERT INTO atoms (id,run_id,oracle_id,face_index,schema_version,family,type_key,params_json,span_start,span_end,quote,rule_numbers,confidence,confidence_source,oracle_hash)
      VALUES (?,1,?,0,20,'PRODUCES','CARD_DRAW','{"amount":1}',0,1,'Draw a card.','[]',1,'model','h')`);
    ['spell', 'land', 'off', 'old', 'other'].forEach((id, i) => addAtom.run(i + 1, id));
    const addRole = d.prepare(`INSERT INTO edge_type_roles (set_id,family,type_key,role,resources_json,evidence_json,votes,status) VALUES (?,?,?,?,?,'[]',3,'accepted')`);
    addRole.run(2, 'PRODUCES', 'CARD_DRAW', 'supply', '[{"resource":"cards_in_hand","sign":"+","kind":"value"}]');
    addRole.run(1, 'PRODUCES', 'CARD_DRAW', 'demand', '[]');
    const addBuild = d.prepare(`INSERT INTO graph_builds (id,build_key,rule_set_id,schema_version,corpus_id,pool_snapshot_id,tests_version,atom_set_sha,scope,built_at,counts_json) VALUES (?,?,?,20,1,1,1,'s','BR','t','{}')`);
    addBuild.run(7, 'k7', 2);
    const addLink = d.prepare('INSERT INTO graph_build_atoms (build_id,atom_id) VALUES (?,?)');
    for (const id of [1, 2, 3, 4]) addLink.run(7, id);
    return d;
  }
  it('reads the spells of the build and the roles of its rule set', () => {
    const got = loadGroupInput(db(), 7);
    expect(got.spells).toEqual([{ oracle_id: 'spell', name: 'A Spell', cmc: 3 }]);
    expect(got.atoms.map((a) => a.oracle_id)).toEqual(['spell']);
    expect(got.atoms[0]!.params).toEqual({ amount: 1 });
    expect(got.roles).toEqual([expect.objectContaining({ role: 'supply', resources: [expect.objectContaining({ kind: 'value' })] })]);
    expect(makeGroups(got).map((g) => g.key)).toEqual(['PRODUCES.CARD_DRAW {}']);
  });
  it('refuses a build that does not exist', () => {
    expect(() => loadGroupInput(db(), 99)).toThrow('there is no build 99');
  });
});
