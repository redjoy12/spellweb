import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/client.js';
import { selectStratifiedBatch, selectColourSlice, LAYOUT_FLOOR } from '../src/cli/select-batch.js';

// Every pool fact below is read from the live DB, never hard-coded: the pool grew from the plan's
// 4,702 to 5,167 cards, and the next sync will move it again (Task 11 ruling R11-2).
const db = openDb();
const spec = { size: 400, seed: 1 };
const poolSize = (db.prepare('SELECT COUNT(*) n FROM cards WHERE rotated = 0').get() as { n: number }).n;
const maybe = poolSize >= spec.size ? describe : describe.skip;

maybe('selectStratifiedBatch (live pool)', () => {
  const batch = selectStratifiedBatch(db, spec);
  const info = (ids: string[]) => db.prepare(
    `SELECT layout, rarity, rotated, oracle_id FROM cards WHERE oracle_id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as Array<{ layout: string; rarity: string; rotated: number; oracle_id: string }>;
  const col = <T>(sql: string, key: string) =>
    (db.prepare(sql).all() as Array<Record<string, T>>).map((r) => r[key]!);

  it('returns the requested size, with no duplicates', () => {
    expect(batch).toHaveLength(spec.size);
    expect(new Set(batch).size).toBe(spec.size);
  });

  it('draws only from the live pool: no rotated card', () => {
    expect(info(batch).filter((r) => r.rotated !== 0)).toEqual([]);
  });

  it('includes at least min(count, floor) cards of every non-normal layout present in the pool', () => {
    const counts = db.prepare(
      "SELECT layout, COUNT(*) n FROM cards WHERE rotated = 0 AND layout <> 'normal' GROUP BY layout",
    ).all() as Array<{ layout: string; n: number }>;
    expect(counts.length).toBeGreaterThan(0);
    const got = info(batch);
    for (const { layout, n } of counts) {
      expect(got.filter((r) => r.layout === layout).length, `layout ${layout}`)
        .toBeGreaterThanOrEqual(Math.min(n, LAYOUT_FLOOR));
    }
  });

  it('includes every card of any layout at or under the floor (the meld cards today)', () => {
    const small = col<string>(
      `SELECT oracle_id FROM cards WHERE rotated = 0 AND layout IN
         (SELECT layout FROM cards WHERE rotated = 0 GROUP BY layout HAVING COUNT(*) <= ${LAYOUT_FLOOR})`,
      'oracle_id',
    );
    const meld = col<string>("SELECT oracle_id FROM cards WHERE rotated = 0 AND layout = 'meld'", 'oracle_id');
    for (const id of meld) expect(small).toContain(id);
    for (const id of small) expect(batch).toContain(id);
  });

  it('covers every rarity in the pool', () => {
    const all = col<string>('SELECT DISTINCT rarity FROM cards WHERE rotated = 0', 'rarity');
    const got = new Set(info(batch).map((r) => r.rarity));
    for (const r of all) expect(got).toContain(r);
  });

  it('includes a card with an empty-text face (zero clauses, coverage 1.0 by definition)', () => {
    const empty = new Set(col<string>(
      `SELECT DISTINCT f.oracle_id FROM card_faces f JOIN cards c USING (oracle_id)
        WHERE c.rotated = 0 AND COALESCE(f.oracle_text, '') = ''`, 'oracle_id'));
    if (empty.size > 0) expect(batch.some((id) => empty.has(id))).toBe(true);
  });

  it('spans the oracle-text length distribution, including the longest face and longest card', () => {
    const longestFace = db.prepare(
      `SELECT f.oracle_id FROM card_faces f JOIN cards c USING (oracle_id) WHERE c.rotated = 0
        ORDER BY LENGTH(COALESCE(f.oracle_text, '')) DESC, f.oracle_id LIMIT 1`,
    ).get() as { oracle_id: string };
    const longestCard = db.prepare(
      `SELECT f.oracle_id FROM card_faces f JOIN cards c USING (oracle_id) WHERE c.rotated = 0
        GROUP BY f.oracle_id ORDER BY SUM(LENGTH(COALESCE(f.oracle_text, ''))) DESC, f.oracle_id LIMIT 1`,
    ).get() as { oracle_id: string };
    expect(batch).toContain(longestFace.oracle_id);
    expect(batch).toContain(longestCard.oracle_id);

    // Every length decile of the pool holds at least 2% of the batch (proportional would be 10%).
    const lens = db.prepare(
      `SELECT f.oracle_id, SUM(LENGTH(COALESCE(f.oracle_text, ''))) len FROM card_faces f
         JOIN cards c USING (oracle_id) WHERE c.rotated = 0 GROUP BY f.oracle_id ORDER BY len, f.oracle_id`,
    ).all() as Array<{ oracle_id: string; len: number }>;
    const inBatch = new Set(batch);
    for (let d = 0; d < 10; d++) {
      const slice = lens.slice(Math.floor((d * lens.length) / 10), Math.floor(((d + 1) * lens.length) / 10));
      const hit = slice.filter((r) => inBatch.has(r.oracle_id)).length;
      expect(hit, `length decile ${d}`).toBeGreaterThanOrEqual(spec.size * 0.02);
    }
  });

  it('is deterministic for a given seed, so a rerun is comparable', () => {
    expect(selectStratifiedBatch(db, spec)).toEqual(batch);
    expect(selectStratifiedBatch(db, { ...spec, seed: 2 })).not.toEqual(batch);
  });

  it('rejects a size it cannot honour', () => {
    expect(() => selectStratifiedBatch(db, { size: 0, seed: 1 })).toThrow();
    expect(() => selectStratifiedBatch(db, { size: poolSize + 1, seed: 1 })).toThrow();
  });
});

// Task 12a: the colour slice. Every non-rotated card whose colour identity is a subset of the
// chosen colours - their mono and gold cards, the colourless cards, and the lands among them.
describe('selectColourSlice (live pool)', () => {
  const identities = new Map((db.prepare('SELECT oracle_id, rotated, color_identity FROM cards').all() as
    Array<{ oracle_id: string; rotated: number; color_identity: string | null }>)
    .map((r) => [r.oracle_id, { rotated: r.rotated, ci: JSON.parse(r.color_identity ?? '[]') as string[] }]));
  const expected = (colours: string[]) => [...identities]
    .filter(([, c]) => c.rotated === 0 && c.ci.every((x) => colours.includes(x)))
    .map(([id]) => id).sort();
  const slice = selectColourSlice(db, 'BR');

  it('is exactly the live cards whose colour identity is a subset of the colours', () => {
    expect(slice).toEqual(expected(['B', 'R']));
    expect(new Set(slice).size).toBe(slice.length);
  });

  it('holds mono, gold and colourless cards, and nothing outside the colours or rotated', () => {
    const got = slice.map((id) => identities.get(id)!);
    const key = (ci: string[]) => [...ci].sort().join('');
    for (const k of ['B', 'R', 'BR', '']) {
      if (expected(['B', 'R']).some((id) => key(identities.get(id)!.ci) === k)) {
        expect(got.some((c) => key(c.ci) === k), `identity "${k}"`).toBe(true);
      }
    }
    expect(got.filter((c) => c.rotated !== 0 || c.ci.some((x) => x !== 'B' && x !== 'R'))).toEqual([]);
  });

  it('ignores colour order and case', () => {
    expect(selectColourSlice(db, 'rb')).toEqual(slice);
  });

  it('rejects an empty or unknown colour', () => {
    expect(() => selectColourSlice(db, '')).toThrow();
    expect(() => selectColourSlice(db, 'BX')).toThrow();
  });
});
