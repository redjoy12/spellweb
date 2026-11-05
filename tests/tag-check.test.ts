import { it, expect } from 'vitest';
import { makeTagCheckSample, readingDifferences } from '../src/atoms/tagCheck.js';
import { maybe, realDb } from './helpers/realDb.js';

maybe('the tag-check sample (owner request 2026-10-21)', () => {
  it('draws distinct cards with their current tags, the same each time', () => {
    const a = makeTagCheckSample(realDb, { size: 8 });
    const b = makeTagCheckSample(realDb, { size: 8 });
    expect(a.items.map((i) => i.key)).toEqual(b.items.map((i) => i.key));
    expect(new Set(a.items.map((i) => i.key)).size).toBe(8);
    for (const i of a.items) {
      expect(i.key).toBe(`tag:${i.card.oracle_id}`);
      expect(i.tags.length).toBeGreaterThan(0);
      expect(i.schema_versions.length).toBeGreaterThan(0);
      for (const t of i.tags) expect(t.type).toMatch(/^[A-Z_]+\.[A-Z0-9_]+$/);
    }
  });

  it('a later round has no card of an earlier round', () => {
    const first = makeTagCheckSample(realDb, { size: 8 });
    const next = makeTagCheckSample(realDb, { size: 8, round: 2, exclude: new Set(first.items.map((i) => i.card.oracle_id)) });
    expect(next.items.every((i) => i.round === 2)).toBe(true);
    const old = new Set(first.items.map((i) => i.key));
    expect(next.items.some((i) => old.has(i.key))).toBe(false);
  });

  it('round 2: draws only current-schema cards, and two-readings cards show the other reading', () => {
    const runs = realDb.prepare("SELECT id FROM extraction_runs WHERE batch_kind = 'requeue' AND model <> 'none' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
    if (!runs) return;
    const earlier = realDb.prepare("SELECT MAX(run_id) r FROM atoms WHERE run_id < ? AND oracle_id IN (SELECT oracle_id FROM atoms WHERE run_id = ?)").get(runs.id, runs.id) as { r: number | null };
    if (earlier.r === null) return;
    const diffs = readingDifferences(realDb, runs.id, earlier.r);
    const s = makeTagCheckSample(realDb, { size: 6, round: 2, minSchema: 16, twoReadings: { run: runs.id, earlier: earlier.r, size: 4 } });
    expect(s.items.every((i) => i.schema_versions.every((v) => v >= 16))).toBe(true);
    const two = s.items.filter((i) => i.reason === 'two_readings');
    expect(two.length).toBe(Math.min(4, diffs.size));
    for (const i of two) {
      expect(diffs.has(i.card.oracle_id)).toBe(true);
      expect(i.new_tags!.length + i.other_tags!.length).toBeGreaterThan(0);
      for (const k of i.new_tags!) expect(k).toBeLessThan(i.tags.length);
    }
    expect(s.items.filter((i) => i.reason === 'random').length).toBe(6);
    expect(new Set(s.items.map((i) => i.key)).size).toBe(s.items.length);
  });
});
