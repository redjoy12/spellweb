import type { DatabaseSync } from 'node:sqlite';
import { describe, it, expect } from 'vitest';
import type { BuildIndex } from '../src/graph/buildIndex.js';
import type { AtomEdge, AtomPlace, MergeContext } from '../src/graph/merge.js';
import type { BuildPairs } from '../src/graph/pairCompare.js';
import { loadGraphPolicy } from '../src/graph/policy.js';
import { allTagPairs, compareBuilds, explainBuilds, INTRINSIC, tagPairs } from '../src/graph/tagMeasure.js';

// Plan 2026-10-31-schema-v17 Task 18 step 3. The rows are synthetic: no item states a Magic fact.

const TAG = 'CARES_ABOUT.NEW_EVENT';
const atom = (id: number, oracle_id: string, family: string, type_key: string) => ({ id, oracle_id, family, type_key, group: `${oracle_id}#0#${id}`, kind: 'other', span: [id, id + 1], mv: 2 });
const ATOMS = [atom(1, 'a', 'PRODUCES', 'X'), atom(2, 'b', 'PRODUCES', 'Y'), atom(3, 'd', 'CARES_ABOUT', 'NEW_EVENT'), atom(4, 'e', 'CARES_ABOUT', 'OTHER_EVENT')];

/** A fake index with the fields that `tagPairs` reads. */
function fakeIndex(supply: Record<string, AtomEdge[]>, classes: Record<string, AtomEdge[]> = {}): BuildIndex {
  const atoms = new Map(ATOMS.map((a) => [a.id, a]));
  const ctx: MergeContext = { atom: (id) => atoms.get(id) as unknown as AtomPlace, classSize: () => 2, policy: loadGraphPolicy() };
  return {
    atoms, ctx, classes: new Map([['c1', { members: new Set(['a', 'd', 'k']) }]]),
    cards: () => ['a', 'b', 'd', 'e'],
    cardAtomEdges: (c: string) => ({ supply: supply[c] ?? [], classes: classes[c] ?? [] }),
  } as unknown as BuildIndex;
}
const edge = (supply: number, demand: number, polarity: '+' | '-', grade: 'confirmed' | 'plausible', rule: string): AtomEdge =>
  ({ rule_hash: rule, polarity, supply_atom_id: supply, class_id: null, demand_atom_id: demand, grade, unresolved: [] });

describe('tagPairs', () => {
  it('reads the pairs into the tag, with their types, rules and grade, and a `-` pair apart', () => {
    const r = tagPairs(fakeIndex({
      a: [edge(1, 3, '+', 'plausible', 'r1'), edge(1, 4, '+', 'confirmed', 'r9')],
      b: [edge(2, 3, '-', 'confirmed', 'r2')],
    }), TAG);
    expect([...r.plus.keys()]).toEqual(['a>d']);
    expect(r.plus.get('a>d')).toEqual({ types: new Set(['PRODUCES.X']), rules: new Set(['r1']), confirmed: false });
    expect([...r.minus]).toEqual(['b>d']);
  });
  it('gives a class edge a pair for each member, with no self pair', () => {
    const cls: AtomEdge = { rule_hash: 'r3', polarity: '+', supply_atom_id: null, class_id: 'c1', demand_atom_id: 3, grade: 'confirmed', unresolved: [] };
    const r = tagPairs(fakeIndex({}, { d: [cls] }), TAG);
    expect([...r.plus.keys()].sort()).toEqual(['a>d', 'k>d']);
    expect(r.plus.get('k>d')?.types).toEqual(new Set([INTRINSIC]));
  });
});

describe('allTagPairs', () => {
  it('gives the pairs of each demand type, and tagPairs is one of its rows', () => {
    const index = fakeIndex({ a: [edge(1, 3, '+', 'plausible', 'r1'), edge(1, 4, '+', 'confirmed', 'r9')] });
    const all = allTagPairs(index);
    expect([...all.keys()].sort()).toEqual(['CARES_ABOUT.NEW_EVENT', 'CARES_ABOUT.OTHER_EVENT']);
    expect(all.get('CARES_ABOUT.OTHER_EVENT')?.plus.get('a>e')?.confirmed).toBe(true);
    expect(tagPairs(index, 'CARES_ABOUT.NO_SUCH_TYPE')).toEqual({ plus: new Map(), minus: new Set() });
  });
});

describe('explainBuilds', () => {
  const fakeDb = (rows: Array<{ rule_hash: string; rule_id: string; supply: string | null }>) => ({ prepare: () => ({ all: () => rows }) }) as unknown as DatabaseSync;
  const db = fakeDb([{ rule_hash: 'r1', rule_id: 'ER-1', supply: 'PRODUCES.X' }, { rule_hash: 'r2', rule_id: 'ER-2', supply: 'PRODUCES.Y' }, { rule_hash: 'r9', rule_id: 'ER-9', supply: 'PRODUCES.Z' }]);
  const ids = { base: 1, build: 2 };
  const base = fakeIndex({ a: [edge(1, 3, '+', 'plausible', 'r1')], b: [edge(2, 4, '+', 'plausible', 'r2')] });
  const after = fakeIndex({ a: [edge(1, 3, '+', 'plausible', 'r1'), edge(1, 4, '+', 'plausible', 'r9')], b: [edge(2, 3, '+', 'plausible', 'r2')] });

  it('separates a pair with no earlier link from a pair that another rule linked', () => {
    const r = explainBuilds(db, base, after, ids);
    expect(r.links.find((x) => x.key === 'PRODUCES.X -> CARES_ABOUT.OTHER_EVENT')).toMatchObject({ pairs: 1, reach_new: 1, link_new: 1, lost: 0 });
    expect(r.links.find((x) => x.key === 'PRODUCES.Y -> CARES_ABOUT.OTHER_EVENT')).toMatchObject({ pairs: 0, reach_new: 0, link_new: 0, lost: 1 });
    expect(r.rules.find((x) => x.key === 'ER-9 -> CARES_ABOUT.OTHER_EVENT')).toMatchObject({ pairs: 1, link_new: 1 });
    // ER-1 had this pair before: the pair is in the row, and it is not new.
    expect(r.rules.find((x) => x.key === 'ER-1 -> CARES_ABOUT.NEW_EVENT')).toMatchObject({ pairs: 1, reach_new: 0, link_new: 0, lost: 0 });
  });
  it('counts the `-` pairs of each demand type', () => {
    const was = fakeIndex({ a: [edge(1, 3, '-', 'confirmed', 'r1')] });
    const now = fakeIndex({ b: [edge(2, 3, '-', 'confirmed', 'r2')] });
    expect(explainBuilds(db, was, now, ids).minus).toEqual([{ key: TAG, pairs: 1, reach_new: 1, link_new: 1, lost: 1 }]);
  });
  it('limits the rule rows to one supply type and to one demand card', () => {
    expect(explainBuilds(db, base, after, ids, { only: 'PRODUCES.Y' }).rules.map((x) => x.key).sort()).toEqual(['ER-2 -> CARES_ABOUT.NEW_EVENT', 'ER-2 -> CARES_ABOUT.OTHER_EVENT']);
    // `only` reads the rule: ER-9 is on a PRODUCES.X atom, and its supply side names another type.
    expect(explainBuilds(db, base, after, ids, { only: 'PRODUCES.X' }).rules.map((x) => x.key)).toEqual(['ER-1 -> CARES_ABOUT.NEW_EVENT']);
    expect(explainBuilds(db, base, after, ids, { demandCard: 'e' }).rules.map((x) => x.key).sort()).toEqual(['ER-2 -> CARES_ABOUT.OTHER_EVENT', 'ER-9 -> CARES_ABOUT.OTHER_EVENT']);
  });
});

describe('compareBuilds', () => {
  const pairs = (plus: Record<string, 'confirmed' | 'plausible'>, minus: string[] = []): BuildPairs => ({
    plus: new Map(Object.entries(plus).map(([k, grade]) => [k, { grade, weight: 1 }])), minus: new Map(minus.map((k) => [k, 'confirmed'])), classes: new Map(),
  });
  it('counts each pair one time in either direction, with no self pair', () => {
    const r = compareBuilds(pairs({ 'a|b': 'plausible', 'b|a': 'confirmed', 'a|a': 'confirmed' }), pairs({ 'a|b': 'confirmed', 'c|d': 'plausible' }, ['a|c']));
    expect(r.link).toEqual({ before: 1, after: 2, added: 1, lost: 0 });
    expect(r.confirmed).toEqual({ before: 1, after: 1, added: 0, lost: 0 });
    expect(r.bad).toEqual({ before: 0, after: 1, added: 1, lost: 0 });
  });
});
