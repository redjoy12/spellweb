import type { ScryfallCard } from './types.js';

/**
 * §5.1: the pool is the intersection of Standard legality and Arena availability.
 * Both conditions are required. English-only, and oracle_id is mandatory because
 * every downstream table keys on it.
 */
export function isPoolLegal(card: ScryfallCard): boolean {
  if (!card.oracle_id) return false;
  if (card.lang !== 'en') return false;
  if (card.legalities?.standard !== 'legal') return false;
  return card.games?.includes('arena') === true;
}

/**
 * Deterministic printing preference, lower wins:
 *   1. non-promo before promo
 *   2. has arena_id before lacks it   (Phase 4 export needs the Arena identity)
 *   3. earliest release date
 *   4. set code ascending
 *   5. collector number ascending, numerically where possible
 */
export function printingRank(card: ScryfallCard): [number, number, string, string, number] {
  const promo = card.promo === true ? 1 : 0;
  const noArena = card.arena_id === undefined ? 1 : 0;
  const collector = Number.parseInt(card.collector_number, 10);
  return [promo, noArena, card.released_at, card.set, Number.isNaN(collector) ? 1e9 : collector];
}

function compareRank(a: ScryfallCard, b: ScryfallCard): number {
  const ra = printingRank(a);
  const rb = printingRank(b);
  for (let i = 0; i < ra.length; i++) {
    const x = ra[i]!;
    const y = rb[i]!;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function pickPreferredPrinting(printings: ScryfallCard[]): ScryfallCard {
  if (printings.length === 0) throw new Error('pickPreferredPrinting called with no printings');
  return [...printings].sort(compareRank)[0]!;
}
