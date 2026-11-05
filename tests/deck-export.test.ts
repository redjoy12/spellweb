import { describe, it, expect } from 'vitest';
import { arenaText, exportName, type ExportCard } from '../src/deck/exportArena.js';
import { loadDeckPolicy } from '../src/deck/policy.js';
import { maybe, realDb as db } from './helpers/realDb.js';

const policy = loadDeckPolicy();
const front = { ...policy, export: { name_form: { default: 'full' as const, adventure: 'front' as const } } };

const line = (over: Partial<ExportCard> = {}): ExportCard => ({
  copies: 4, name: 'Card Name', front_name: 'Card Name', layout: 'normal', set_code: 'abc', collector_number: '123', ...over,
});

describe('arenaText (design sec. 10)', () => {
  it('is one header line and one line for each card, with the set in upper case', () => {
    expect(arenaText([line(), line({ copies: 20, name: 'Swamp', front_name: 'Swamp', set_code: 'ktk', collector_number: '259' })], policy))
      .toBe('Deck\n4 Card Name (ABC) 123\n20 Swamp (KTK) 259');
  });
  it('a layout key of the policy overrides the default name form', () => {
    const two = { name: 'One // Two', front_name: 'One' };
    expect(exportName({ ...two, layout: 'adventure' }, front)).toBe('One');
    expect(exportName({ ...two, layout: 'split' }, front)).toBe('One // Two');
    expect(exportName({ ...two, layout: 'adventure' }, policy)).toBe('One // Two');
  });
});

// One card of each layout in the pool (plan Task 6). The cards come from the database by query.
maybe('the export of one card of each layout in the pool', () => {
  const rows = db.prepare(
    `SELECT c.name, c.layout, c.set_code, c.collector_number, f.name AS front_name FROM cards c JOIN card_faces f ON f.oracle_id = c.oracle_id AND f.face_index = 0
      WHERE c.rotated = 0 AND c.arena_id IS NOT NULL AND c.oracle_id = (
        SELECT MIN(x.oracle_id) FROM cards x WHERE x.rotated = 0 AND x.arena_id IS NOT NULL AND x.layout = c.layout)
      ORDER BY c.layout`,
  ).all() as unknown as Array<Omit<ExportCard, 'copies'>>;

  it('has more than one layout, and two-face layouts', () => {
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.some((r) => r.name.includes(' // '))).toBe(true);
  });
  it('gives one good line for each layout, with the full name', () => {
    for (const r of rows) {
      const text = arenaText([{ ...r, copies: 4 }], policy).split('\n');
      expect(text).toHaveLength(2);
      expect(text[0]).toBe('Deck');
      expect(text[1]).toBe(`4 ${r.name} (${r.set_code.toUpperCase()}) ${r.collector_number}`);
      expect(text[1]).toMatch(/^4 .+ \([A-Z0-9]+\) \S+$/);
    }
  });
  it('the front name form gives the name of face 0', () => {
    const f = { ...policy, export: { name_form: { default: 'front' as const } } };
    for (const r of rows) expect(arenaText([{ ...r, copies: 1 }], f).split('\n')[1]).toBe(`1 ${r.front_name} (${r.set_code.toUpperCase()}) ${r.collector_number}`);
  });
});
