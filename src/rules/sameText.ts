/**
 * Two texts that say the same thing in nearly the same words (owner request 2026-10-18). Pure
 * code on the words only; it knows no Magic. The UI quote merge (src/web/lib/quoteMerge.ts) and
 * the CR sentence groups (src/rules/crDuplicates.ts) use it.
 *
 * Two texts are the same when, after normalisation (lower case, punctuation and repeated spaces
 * removed), the texts are equal, one text contains the other as whole words (MIN_CONTAINED words or
 * more), or all of these are true:
 * - the shorter text shares SIMILAR of its word pairs with the longer text;
 * - the longer text shares SIMILAR_LONG of its word pairs with the shorter text, so that a short
 *   text does not join a longer, different sentence;
 * - each content word of one text (not a STOP word; compared on its first STEM letters) is in
 *   the other text, so that two parallel sentences with one different noun stay apart;
 * - the longest common run of words is RUN of the shorter text or more, so that two parallel
 *   sentences that swap words between their halves stay apart.
 * `covers(m, M)` is the same test in one direction: text M says all that text m says.
 */

export const normaliseText = (q: string) => q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** A text of fewer words than this is the same as another text only when equal. */
const MIN_CONTAINED = 4;
/** True when normalised text `inner` is a run of whole words of normalised text `outer`. */
function inside(outer: string, inner: string): boolean {
  return inner.split(' ').length >= MIN_CONTAINED && ` ${outer} `.includes(` ${inner} `);
}

/** The share of word pairs of the shorter quote that the longer quote has. */
export const SIMILAR = 0.7;
/** The share of word pairs of the longer quote that the shorter quote has. */
export const SIMILAR_LONG = 0.5;
/** The share of the shorter quote's words that one common run of words must cover. */
export const RUN = 0.5;
/** Words that do not count as content words. */
const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'it', 'is', 'its', 'that', 'this', 'and', 'or', 'be', 'as', 'in', 'on', 'for', 'by', 'from', 'with', 'are', 'was', 's']);
/** Content words compare on their first letters only, so that two forms of one word agree. */
const STEM = 4;
/** A quote with fewer word pairs than this is merged only when equal or contained. */
const MIN_PAIRS = 4;

function wordPairs(norm: string): Set<string> {
  const w = norm.split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 1 < w.length; i++) out.add(`${w[i]} ${w[i + 1]}`);
  return out;
}

/** The length of the longest run of words that both texts have, in the same order. */
function longestRun(a: string[], b: string[]): number {
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) { row[j] = prev[j - 1]! + 1; if (row[j]! > best) best = row[j]!; }
    }
    prev = row;
  }
  return best;
}

const contentStems = (norm: string) => new Set(norm.split(' ').filter((w) => w && !STOP.has(w)).map((w) => w.slice(0, STEM)));

/** True when two normalised texts are the same text (see the file header). */
export function sameText(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (inside(a, b) || inside(b, a)) return true;
  const pa = wordPairs(a);
  const pb = wordPairs(b);
  const [small, large] = pa.size <= pb.size ? [pa, pb] : [pb, pa];
  if (small.size < MIN_PAIRS) return false;
  let shared = 0;
  for (const p of small) if (large.has(p)) shared++;
  if (shared / small.size < SIMILAR || shared / large.size < SIMILAR_LONG) return false;
  const [short, long] = a.split(' ').length <= b.split(' ').length ? [a, b] : [b, a];
  const [sa, sb] = [contentStems(a), contentStems(b)];
  if (![...sa].every((w) => sb.has(w)) && ![...sb].every((w) => sa.has(w))) return false;
  const sw = short.split(' ');
  return longestRun(sw, long.split(' ')) >= RUN * sw.length;
}

/**
 * True when normalised text `main` says all that normalised text `m` says: equal, `m` inside
 * `main`, or the same text by the word-pair tests with each content word of `m` in `main`.
 */
export function covers(main: string, m: string): boolean {
  if (main === m) return true;
  if (!main || !m) return false;
  if (inside(main, m)) return true;
  if (inside(m, main) || !sameText(main, m)) return false;
  const sm = contentStems(m);
  const sM = contentStems(main);
  return [...sm].every((w) => sM.has(w));
}
