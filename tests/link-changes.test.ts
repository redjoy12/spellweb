import { describe, expect, it } from 'vitest';
import { desktopLink, applyPrompt, isStale, withOwnerLinks } from '../src/deck/linkChanges.js';
import { OWNER_KEY, type PairLink, type PairTable } from '../src/deck/pairs.js';

// Link review design sec. 8: owner links in the pair table, the stale test and the desktop link.

const link = (supply: string, demand: string, weight = 1): PairLink => ({
  supply, demand, weight, key: `k:${supply}>${demand}`, grade: 'confirmed', rule_hashes: ['h1'], atom_ids: [1, 2], demand_atom_id: 2,
});

function table(): PairTable {
  const pos = new Map([['A', new Map([['B', link('A', 'B')]])]]);
  const anti = new Map([['A', new Map([['C', link('A', 'C')]])], ['C', new Map([['A', link('C', 'A')]])]]);
  const linked = new Map([['A', new Set(['B'])], ['B', new Set(['A'])]]);
  return { buildId: 36, pos, anti, linked };
}

const row = (id: number, supply: string, demand: string, effect: 'add' | 'block', sign: '+' | '-' = '+', weak = 0) => ({
  id, supply_oracle: supply, demand_oracle: demand, effect, sign, weak, suggestion_id: null, note: '', created_at: '', removed_at: null,
});

describe('withOwnerLinks', () => {
  it('adds a + link with the owner weight, and a weak one with the weak part', () => {
    const t = table();
    const out = withOwnerLinks(t, [row(1, 'B', 'C', 'add'), row(2, 'C', 'D', 'add', '+', 1)], 0.4, 0.25);
    expect(out.pos.get('B')?.get('C')).toMatchObject({ weight: 0.4, key: `${OWNER_KEY}1`, rule_hashes: [], atom_ids: [] });
    expect(out.pos.get('C')?.get('D')).toMatchObject({ weight: 0.1, weak: true });
    expect(out.linked.get('B')?.has('C')).toBe(true);
    expect(out.linked.get('C')?.has('B')).toBe(true);
    expect(out.linked.get('D')?.has('C')).toBe(true);
    // The table in memory does not change.
    expect(t.pos.get('B')).toBeUndefined();
    expect(t.linked.get('B')?.has('C')).toBe(false);
  });

  it('a block removes the link of that direction only, and the cards stay linked by the other direction', () => {
    const t = table();
    t.pos.set('B', new Map([['A', link('B', 'A')]]));
    const out = withOwnerLinks(t, [row(1, 'A', 'B', 'block')], 0.4, 0.25);
    expect(out.pos.get('A')?.get('B')).toBeUndefined();
    expect(out.pos.get('B')?.get('A')).toBeDefined();
    expect(out.linked.get('A')?.has('B')).toBe(true);
    const both = withOwnerLinks(t, [row(1, 'A', 'B', 'block'), row(2, 'B', 'A', 'block')], 0.4, 0.25);
    expect(both.linked.get('A')?.has('B') ?? false).toBe(false);
    expect(t.pos.get('A')?.get('B')).toBeDefined();
  });

  it('a - link goes in both orders, and a block on a - link removes both', () => {
    const out = withOwnerLinks(table(), [row(1, 'B', 'D', 'add', '-'), row(2, 'A', 'C', 'block', '-')], 0.4, 0.25);
    expect(out.anti.get('B')?.get('D')?.weight).toBe(0.4);
    expect(out.anti.get('D')?.get('B')?.supply).toBe('D');
    expect(out.anti.get('A')?.get('C')).toBeUndefined();
    expect(out.anti.get('C')?.get('A')).toBeUndefined();
  });

  it('a newer owner link on the same pair wins', () => {
    const out = withOwnerLinks(table(), [row(1, 'A', 'B', 'block'), row(2, 'A', 'B', 'add')], 0.4, 0.25);
    expect(out.pos.get('A')?.get('B')?.key).toBe(`${OWNER_KEY}2`);
  });

  it('no owner link gives the same table', () => {
    const t = table();
    expect(withOwnerLinks(t, [], 0.4, 0.25)).toBe(t);
  });
});

describe('isStale', () => {
  const s = (kind: 'delete' | 'add' | 'correct', supply: string, demand: string, change: 'weak' | 'not_weak' | 'wrong_reason' | null = null, sign: '+' | '-' = '+') =>
    ({ kind, change, sign, supply_oracle: supply, demand_oracle: demand });
  it('a delete is stale when the link is gone, and an add when the link exists', () => {
    const t = table();
    expect(isStale(s('delete', 'A', 'B'), t, new Set())).toBe(false);
    expect(isStale(s('delete', 'B', 'A'), t, new Set())).toBe(true);
    expect(isStale(s('add', 'A', 'B'), t, new Set())).toBe(true);
    expect(isStale(s('add', 'B', 'C'), t, new Set())).toBe(false);
    expect(isStale(s('delete', 'A', 'C', null, '-'), t, new Set())).toBe(false);
  });
  it('a weak correction is stale when the pair is already weak', () => {
    const t = table();
    expect(isStale(s('correct', 'A', 'B', 'weak'), t, new Set())).toBe(false);
    expect(isStale(s('correct', 'A', 'B', 'weak'), t, new Set(['A>B']))).toBe(true);
    expect(isStale(s('correct', 'A', 'B', 'not_weak'), t, new Set())).toBe(true);
    expect(isStale(s('correct', 'A', 'B', 'wrong_reason'), t, new Set())).toBe(false);
  });
});

describe('the desktop link', () => {
  it('opens a new Code session with the prompt and the folder, both encoded', () => {
    const l = desktopLink(applyPrompt(3), 'C:\\code\\spellweb');
    expect(l.startsWith('claude://code/new?q=')).toBe(true);
    const q = new URLSearchParams(l.slice(l.indexOf('?') + 1));
    expect(q.get('q')).toBe('Apply link change request 3 of the MTGA deck builder. Follow config/link-apply-procedure.md. Start with: npm run link-apply -- --show 3');
    expect(q.get('folder')).toBe('C:\\code\\spellweb');
    expect(l).not.toMatch(/[ \\]/);
  });
});
