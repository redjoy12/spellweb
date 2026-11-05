import type { DeckCard } from '../../src/deck/assemble.js';
import type { Goal } from '../../src/deck/goal.js';
import type { PairLink, PairTable } from '../../src/deck/pairs.js';

export interface FixtureGoal { name: string; goal: Goal; copies: number }

const pad = (i: number) => `c${String(i).padStart(3, '0')}`;

/**
 * A fixed pool, pair table and goals for the off path test (card rate plan Task 5). The numbers come
 * from a small generator, so they never change and no file holds them. The weights come from a short
 * list, so the search has many ties.
 */
export function deckFixture(): { cards: DeckCard[]; table: PairTable; goals: FixtureGoal[] } {
  let x = 12345;
  const next = (n: number) => { x = (x * 48271) % 2147483647; return x % n; };
  const cards = Array.from({ length: 160 }, (_, i): DeckCard => {
    const creature = next(5) < 3;
    return {
      oracle_id: pad(i), name: `Card ${pad(i)}`, type_line: creature ? 'Creature — Test' : 'Sorcery', cmc: 1 + next(7), costs: ['{1}{B}'],
      identity: ['B'], arena_id: i + 1, land: false, creature, legendary: next(10) === 0, interaction: next(4) === 0, tags: [],
    };
  });
  const table: PairTable = { buildId: null, pos: new Map(), anti: new Map(), linked: new Map() };
  const link = (a: string, b: string, weight: number): PairLink => ({ supply: a, demand: b, weight, key: `${a}>${b}`, grade: 'confirmed', rule_hashes: [], atom_ids: [], demand_atom_id: 0 });
  const row = <V>(m: Map<string, V>, k: string, v: () => V) => { if (!m.has(k)) m.set(k, v()); return m.get(k)!; };
  for (let n = 0; n < 2400; n++) {
    const a = pad(next(160));
    const b = pad(next(160));
    if (a === b) continue;
    const w = [0.25, 0.5, 0.75, 1][next(4)]!;
    if (next(12) === 0) {
      row(table.anti, a, () => new Map()).set(b, link(a, b, w));
      row(table.anti, b, () => new Map()).set(a, link(a, b, w));
    } else {
      row(table.pos, a, () => new Map()).set(b, link(a, b, w));
      row(table.linked, a, () => new Set()).add(b);
      row(table.linked, b, () => new Set()).add(a);
    }
  }
  const base: Goal = { colours: 'B', seeds: [], excluded: [], target_turn: 6, interaction: 'some', min_creatures: 14, use_rate: false, pinned: [], excluded_tags: [] };
  return {
    cards, table,
    goals: [
      { name: 'one seed', goal: { ...base, seeds: [pad(7)] }, copies: 36 },
      { name: 'two seeds, heavy', goal: { ...base, seeds: [pad(20), pad(33)], interaction: 'heavy', min_creatures: 10, target_turn: 5 }, copies: 40 },
      { name: 'no seed', goal: { ...base, interaction: 'none', min_creatures: 0, target_turn: 8 }, copies: 36 },
      { name: 'excluded cards', goal: { ...base, seeds: [pad(50)], excluded: [pad(1), pad(2), pad(3), pad(4), pad(5)], target_turn: 4 }, copies: 34 },
      { name: 'four seeds', goal: { ...base, seeds: [pad(60), pad(61), pad(62), pad(63)], min_creatures: 20 }, copies: 38 },
    ],
  };
}

/** One line of text for a deck: each spell with its copies and role. */
export const deckLine = (spells: ReadonlyArray<{ oracle_id: string; copies: number; role: string }>) => spells.map((s) => `${s.oracle_id} ${s.copies} ${s.role}`).join(', ');
