import { describe, it, expect } from 'vitest';
import { BuildIndex, type IndexAtom } from '../src/graph/buildIndex.js';
import type { GroupKind } from '../src/graph/groups.js';
import { loadGraphPolicy } from '../src/graph/policy.js';
import type { StoredRule } from '../src/graph/ruleSet.js';
import { DatabaseSync } from 'node:sqlite';
import { weakPairKeys } from '../src/deck/deck.js';
import { antiWeight, linkCounts, pairTable, posWeight, withWeakPairs } from '../src/deck/pairs.js';

const atom = (id: number, card: string, kind: GroupKind, family: string, type_key: string): IndexAtom => ({
  id, oracle_id: card, face_index: 0, family, type_key, params: {}, span_start: id * 10, span_end: id * 10 + 5,
  group: `${card}#0#${id}`, kind, span: [id * 10, id * 10 + 5], mv: 2,
});
const side = (family: string, type_key: string) => ({ family, type_key, where: [] });
const rule = (hash: string, polarity: '+' | '-', supply: StoredRule['supply'], demand: StoredRule['demand']): StoredRule => ({
  rule_hash: hash, rule_id: hash, votes: 3, status: 'accepted', polarity, supply, demand, param_links: [], implications: [], evidence: [],
});

// Card A makes tokens; B and C care about tokens, and A also cares about tokens (a self pair).
// D makes a thing that is bad for tokens. Class Z has member E and feeds C.
const atoms = [
  atom(1, 'A', 'other', 'PRODUCES', 'TOKENS'),
  atom(2, 'A', 'triggered', 'CARES_ABOUT', 'TOKENS'),
  atom(3, 'B', 'triggered', 'CARES_ABOUT', 'TOKENS'),
  atom(4, 'C', 'other', 'CARES_ABOUT', 'TOKENS'),
  atom(5, 'D', 'other', 'INTERACTION', 'SWEEPER'),
  atom(6, 'E', 'other', 'PRODUCES', 'OTHER'),
];
const rules = [
  rule('tokens', '+', side('PRODUCES', 'TOKENS'), side('CARES_ABOUT', 'TOKENS')),
  rule('sweep', '-', side('INTERACTION', 'SWEEPER'), side('CARES_ABOUT', 'TOKENS')),
  rule('class', '+', { intrinsic: 'subtype', value: 'Z' }, side('CARES_ABOUT', 'TOKENS')),
];
const index = () => new BuildIndex({
  atoms: new Map(atoms.map((a) => [a.id, a])), rules,
  classes: [{ id: 'INTRINSIC.subtype(Z)', intrinsic: 'subtype', value: 'Z', members: ['E'] }],
  params: new Map(), policy: loadGraphPolicy(),
});
const all = ['A', 'B', 'C', 'D', 'E'];

describe('weakPairKeys', () => {
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';
  const C = '33333333-3333-3333-3333-333333333333';
  const rows = (...r: Array<[string, string, string]>) => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE owner_decisions (item_key TEXT, choice TEXT, decided_at TEXT)');
    db.exec('CREATE TABLE edge_golden_pairs (supply_oracle TEXT, demand_oracle TEXT, owner_note TEXT)');
    for (const [k, c, at] of r) db.prepare('INSERT INTO owner_decisions VALUES (?, ?, ?)').run(k, c, at);
    return db;
  };
  it('reads a weak answer of any round, with its direction', () => {
    expect([...weakPairKeys(rows([`lr2:${A}>${B}`, 'weak_link', '1'], [`dk:${B}>${C}`, 'weak_link', '2'], [`lr3:${A}>${C}`, 'no_link', '3'])).values()].sort())
      .toEqual([`${A}>${B}`, `${B}>${C}`]);
  });
  it('takes the newest answer of a pair', () => {
    expect(weakPairKeys(rows([`lr2:${A}>${B}`, 'weak_link', '1'], [`lrf:${A}>${B}`, 'link', '2'])).size).toBe(0);
    expect([...weakPairKeys(rows([`lr2:${A}>${B}`, 'no_link', '1'], [`lrf:${A}>${B}`, 'weak_link', '2']))]).toEqual([`${A}>${B}`]);
  });
  it('gives nothing for a key without a pair', () => {
    expect(weakPairKeys(rows(['pair-12', 'weak_link', '1'])).size).toBe(0);
  });
  it('reads a weak golden note, and a newer answer on the pair decides', () => {
    const db = rows([`lr2:${B}>${C}`, 'link', '1']);
    const add = db.prepare('INSERT INTO edge_golden_pairs VALUES (?, ?, ?)');
    add.run(A, B, 'owner golden check 2026-10-24: weak_link (very weak link)');
    add.run(B, C, 'owner golden check 2026-10-24: weak_link');
    add.run(A, C, 'owner golden check 2026-10-24: link');
    expect([...weakPairKeys(db)]).toEqual([`${A}>${B}`]);
  });
});

describe('pairTable (design sec. 6)', () => {
  it('a card does not link to itself', () => {
    const t = pairTable(index(), all);
    expect(posWeight(t, 'A', 'A')).toBe(0);
    expect(t.linked.get('A')!.has('A')).toBe(false);
  });
  it('holds the + pairs from supply to demand, in one direction', () => {
    const t = pairTable(index(), all);
    expect(posWeight(t, 'A', 'B')).toBeGreaterThan(0);
    expect(posWeight(t, 'A', 'C')).toBeGreaterThan(0);
    expect(posWeight(t, 'B', 'A')).toBe(0);
  });
  it('a weak pair keeps its link and counts for less', () => {
    const full = posWeight(pairTable(index(), all), 'A', 'B');
    const t = withWeakPairs(pairTable(index(), all), { keys: new Set(['A>B']), factor: 0.25 });
    expect(posWeight(t, 'A', 'B')).toBeCloseTo(full * 0.25);
    expect(t.pos.get('A')!.get('B')!.weak).toBe(true);
    expect(t.linked.get('A')!.has('B')).toBe(true);
    expect(t.linked.get('B')!.has('A')).toBe(true);
    expect(t.pos.get('A')!.get('C')!.weak).toBeUndefined();
  });
  it('a weak answer has a direction, and it does not touch a - pair', () => {
    const t = withWeakPairs(pairTable(index(), all), { keys: new Set(['B>A', 'D>B']), factor: 0.25 });
    expect(t.pos.get('A')!.get('B')!.weak).toBeUndefined();
    expect(antiWeight(t, 'D', 'B')).toBe(antiWeight(pairTable(index(), all), 'D', 'B'));
  });
  it('two weak pairs of one supply both count, and the table of the server does not change', () => {
    const base = pairTable(index(), all);
    const full = posWeight(base, 'A', 'B');
    const t = withWeakPairs(base, { keys: new Set(['A>B', 'A>C']), factor: 0.25 });
    expect(t.pos.get('A')!.get('B')!.weak).toBe(true);
    expect(t.pos.get('A')!.get('C')!.weak).toBe(true);
    expect(posWeight(base, 'A', 'B')).toBe(full);
    expect(base.pos.get('A')!.get('B')!.weak).toBeUndefined();
  });
  it('a class edge makes no pair', () => {
    const t = pairTable(index(), all);
    expect(t.pos.has('E')).toBe(false);
    expect(t.linked.has('E')).toBe(false);
  });
  it('holds a - pair in both orders', () => {
    const t = pairTable(index(), all);
    expect(antiWeight(t, 'D', 'B')).toBeGreaterThan(0);
    expect(antiWeight(t, 'B', 'D')).toBe(antiWeight(t, 'D', 'B'));
    expect(antiWeight(t, 'B', 'C')).toBe(0);
  });
  it('keeps the rule hash, the atom IDs and the edge key of a pair', () => {
    const l = pairTable(index(), all).pos.get('A')!.get('B')!;
    expect(l).toMatchObject({ supply: 'A', demand: 'B', rule_hashes: ['tokens'], atom_ids: [1, 3], demand_atom_id: 3, key: '+|A#0#1|10|15|3' });
  });
  it('two reads give the same maps', () => {
    expect(pairTable(index(), all)).toEqual(pairTable(index(), [...all].reverse()));
  });
  it('holds only the pairs among the cards that it reads', () => {
    const t = pairTable(index(), ['A', 'B', 'D']);
    expect(posWeight(t, 'A', 'B')).toBeGreaterThan(0);
    expect(posWeight(t, 'A', 'C')).toBe(0);
  });
  it('links(c) counts the linked cards in the candidate set, in both directions', () => {
    const t = pairTable(index(), all);
    expect(linkCounts(t, new Set(all))).toEqual(new Map([['A', 2], ['B', 1], ['C', 1], ['D', 0], ['E', 0]]));
    expect(linkCounts(t, new Set(['A', 'C'])).get('A')).toBe(1);
  });
});
