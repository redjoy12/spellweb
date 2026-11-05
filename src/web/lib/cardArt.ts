/**
 * Maps a card's color identity to one of the mockup's placeholder gradient
 * classes (`.art-w/u/b/r/g/wu/ub/multi/c`), used only when the real Scryfall
 * art URL is null. Purely decorative — never affects data flow.
 */
const WUBRG_ORDER = ['W', 'U', 'B', 'R', 'G'];

export function getArtClass(colors: string[] | null | undefined): string {
  const upper = (colors ?? []).map((c) => c.toUpperCase()).filter((c) => WUBRG_ORDER.includes(c));
  if (upper.length === 0) return 'art-c';

  const sorted = [...upper].sort((a, b) => WUBRG_ORDER.indexOf(a) - WUBRG_ORDER.indexOf(b));
  const key = sorted.join('');

  if (sorted.length === 1) return `art-${key.toLowerCase()}`;
  if (key === 'WU') return 'art-wu';
  if (key === 'UB') return 'art-ub';
  return 'art-multi';
}
