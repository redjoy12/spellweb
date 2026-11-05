import { describe, it, expect } from 'vitest';
import { compareAtoms, compareGolden, renderCompare, type CompareAtom } from '../src/atoms/runCompare.js';
import { maybe, realDb } from './helpers/realDb.js';

const a = (type: string, span: [number, number], params: Record<string, unknown> = {}, oracle_id = 'o', face_index = 0): CompareAtom => {
  const [family, type_key] = type.split('.') as [string, string];
  return { oracle_id, name: oracle_id, face_index, family, type_key, span_start: span[0], span_end: span[1], quote: `${type} text`, params };
};
const MOVED = new Map([['ENABLES.SACRIFICE_OUTLET', 'PRODUCES.SACRIFICE']]);

describe('compareAtoms', () => {
  it('matches the same type on an overlap, and counts each param that the earlier atom has', () => {
    const r = compareAtoms(
      [a('PRODUCES.CREATE', [0, 10], { amount: 1, controller: 'you' })],
      [a('PRODUCES.CREATE', [5, 20], { amount: 2, controller: 'you', extra: 'new' })],
      MOVED,
    );
    expect(r.matched).toBe(1);
    expect(r.params).toMatchObject({ agree: 1, total: 2 });
    expect(r.params.by).toEqual([
      { type: 'PRODUCES.CREATE', param: 'amount', agree: 0, total: 1 },
      { type: 'PRODUCES.CREATE', param: 'controller', agree: 1, total: 1 },
    ]);
  });
  it('does not match another face, another type or a span with no overlap', () => {
    const r = compareAtoms(
      [a('PRODUCES.CREATE', [0, 10]), a('PRODUCES.MILL', [0, 10]), a('COMBAT.FLYING', [0, 5])],
      [a('PRODUCES.CREATE', [0, 10], {}, 'o', 1), a('PRODUCES.DRAW', [0, 10]), a('COMBAT.FLYING', [5, 9])],
      MOVED,
    );
    expect(r.matched).toBe(0);
    expect(r.lost.map((l) => l.type)).toEqual(['PRODUCES.CREATE', 'PRODUCES.MILL', 'COMBAT.FLYING']);
    expect(r.added).toHaveLength(3);
  });
  it('matches each atom once, the largest overlap first', () => {
    const r = compareAtoms(
      [a('PRODUCES.DAMAGE', [0, 10]), a('PRODUCES.DAMAGE', [8, 30])],
      [a('PRODUCES.DAMAGE', [9, 30])],
      MOVED,
    );
    expect(r.matched).toBe(1);
    expect(r.lost.map((l) => [l.quote, l.types_on_span])).toEqual([['PRODUCES.DAMAGE text', ['PRODUCES.DAMAGE']]]);
  });
  it('keeps a removed type when a new atom of its keeper overlaps, also when an earlier atom took that atom', () => {
    const r = compareAtoms(
      [a('ENABLES.SACRIFICE_OUTLET', [0, 20], { cost_type: 'free' }), a('PRODUCES.SACRIFICE', [0, 20], { actor: 'you' })],
      [a('PRODUCES.SACRIFICE', [0, 20], { actor: 'you', cost_type: 'free', decision: 'cost' })],
      MOVED,
    );
    expect(r).toMatchObject({ matched: 1, moved: 1, lost: [], added: [] });
  });
  it('loses a removed type when no atom of its keeper overlaps', () => {
    const r = compareAtoms([a('ENABLES.SACRIFICE_OUTLET', [0, 20])], [a('PRODUCES.CREATE', [0, 20])], MOVED);
    expect(r.lost.map((l) => [l.type, l.types_on_span])).toEqual([['ENABLES.SACRIFICE_OUTLET', ['PRODUCES.CREATE']]]);
  });
  it('renders the measures and each lost atom', () => {
    const md = renderCompare(compareAtoms([a('PRODUCES.MILL', [0, 10], { amount: 1 })], [], MOVED));
    expect(md).toContain('| Atoms lost, atoms added | 1, 0 |');
    expect(md).toContain('| o | 0 | `PRODUCES.MILL` | PRODUCES.MILL text | none |');
  });
});

maybe('compareGolden on the stored data', () => {
  it('counts each golden atom of a run as matched or missed, and gives a focus row for each', () => {
    const run = realDb.prepare(
      `SELECT r.id FROM extraction_runs r WHERE EXISTS (SELECT 1 FROM atoms a JOIN golden_cards g USING (oracle_id) WHERE a.run_id = r.id) ORDER BY r.id DESC`,
    ).get() as { id: number };
    const g = compareGolden(realDb, run.id, new Set(['PRODUCES.SACRIFICE']));
    expect(g.cards).toBeGreaterThan(0);
    expect(g.matched + g.misses.length).toBe(g.atoms);
    expect(g.focus.every((f) => f.type === 'PRODUCES.SACRIFICE')).toBe(true);
    expect(g.focus.filter((f) => f.agree).every((f) => f.matched && f.diffs.length === 0)).toBe(true);
  });
});
