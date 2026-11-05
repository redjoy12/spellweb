import { describe, it, expect } from 'vitest';
import { isPoolLegal, pickPreferredPrinting } from '../src/scryfall/filter.js';
import type { ScryfallCard } from '../src/scryfall/types.js';

const base = (over: Partial<ScryfallCard> = {}): ScryfallCard => ({
  object: 'card', id: 'x', oracle_id: 'o1', name: 'Card', lang: 'en', layout: 'normal',
  released_at: '2025-01-01', cmc: 1, type_line: 'Creature', color_identity: [], keywords: [],
  rarity: 'common', set: 'aaa', collector_number: '1', games: ['paper', 'arena'],
  digital: false, legalities: { standard: 'legal' }, ...over,
});

describe('isPoolLegal', () => {
  it('accepts a Standard-legal card available on Arena', () => {
    expect(isPoolLegal(base())).toBe(true);
  });
  it('rejects a Standard-legal card that is not on Arena', () => {
    expect(isPoolLegal(base({ games: ['paper', 'mtgo'] }))).toBe(false);
  });
  it('rejects an Arena card that is not Standard-legal', () => {
    expect(isPoolLegal(base({ legalities: { standard: 'not_legal' } }))).toBe(false);
  });
  it('rejects a non-English printing', () => {
    expect(isPoolLegal(base({ lang: 'ja' }))).toBe(false);
  });
  it('rejects a record with no oracle_id', () => {
    const c = base(); delete (c as any).oracle_id;
    expect(isPoolLegal(c)).toBe(false);
  });
});

describe('pickPreferredPrinting', () => {
  it('prefers a non-promo printing over a promo', () => {
    const promo = base({ id: 'p', set: 'aaa', promo: true, released_at: '2024-01-01' });
    const norm  = base({ id: 'n', set: 'bbb', released_at: '2025-01-01' });
    expect(pickPreferredPrinting([promo, norm]).id).toBe('n');
  });
  it('prefers a printing that carries an arena_id', () => {
    const noId = base({ id: 'a', set: 'aaa', released_at: '2024-01-01' });
    const withId = base({ id: 'b', set: 'bbb', released_at: '2025-01-01', arena_id: 42 });
    expect(pickPreferredPrinting([noId, withId]).id).toBe('b');
  });
  it('breaks remaining ties by earliest release, then set code, then collector number', () => {
    const a = base({ id: 'a', set: 'zzz', released_at: '2024-06-01', arena_id: 1 });
    const b = base({ id: 'b', set: 'aaa', released_at: '2024-01-01', arena_id: 2 });
    expect(pickPreferredPrinting([a, b]).id).toBe('b');
  });
  it('orders collector numbers numerically, not lexicographically', () => {
    const nine = base({ id: 'a', collector_number: '9' });
    const ten  = base({ id: 'b', collector_number: '10' });
    expect(pickPreferredPrinting([ten, nine]).id).toBe('a');
  });
  it('sorts a non-numeric collector number after numeric ones', () => {
    const num = base({ id: 'b', collector_number: '5' });
    const gr  = base({ id: 'a', collector_number: 'GR1' });
    expect(pickPreferredPrinting([gr, num]).id).toBe('b');
  });
  it('breaks a release-date tie by set code', () => {
    const zzz = base({ id: 'a', set: 'zzz' });
    const aaa = base({ id: 'b', set: 'aaa' });
    expect(pickPreferredPrinting([zzz, aaa]).id).toBe('b');
  });
  it('is deterministic regardless of input order', () => {
    const a = base({ id: 'a', set: 'aaa', released_at: '2024-01-01', arena_id: 1 });
    const b = base({ id: 'b', set: 'bbb', released_at: '2024-01-01', arena_id: 2 });
    expect(pickPreferredPrinting([a, b]).id).toBe(pickPreferredPrinting([b, a]).id);
  });
});
