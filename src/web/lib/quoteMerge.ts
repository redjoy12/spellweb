/**
 * Repeated evidence quotes of one reason (owner request 2026-10-18). A reason can cite the same
 * sentence twice: a rule and the glossary entry that repeats it, or two rules with nearly the same
 * words. The "why" section shows each distinct quote once, with all its sources.
 *
 * Two quotes are the same by `sameText` (src/rules/sameText.ts): a comparison on the words only.
 */
import { normaliseText, sameText } from '../../rules/sameText.js';

export interface QuoteEvidence { source: 'rule' | 'glossary'; ref: string; quote: string }

export interface MergedQuote {
  /** The text that is shown: the longest of the group. */
  quote: string;
  /** The labels of the sources, in the order of the evidence: "CR 106.1", "glossary Mana". */
  sources: string[];
  /** The other wordings of the group, when they are not the same text after normalisation. */
  variants: string[];
}

export const normaliseQuote = normaliseText;
export const sameQuote = sameText;

export const sourceLabel = (e: QuoteEvidence) => (e.source === 'rule' ? `CR ${e.ref}` : `glossary ${e.ref}`);

/** The distinct quotes of an evidence list, first occurrence first, each with all its sources. */
export function mergeQuotes(evidence: readonly QuoteEvidence[]): MergedQuote[] {
  const groups: Array<{ items: QuoteEvidence[]; norms: string[] }> = [];
  for (const e of evidence) {
    const n = normaliseQuote(e.quote);
    const hit = groups.filter((g) => g.norms.some((m) => sameQuote(m, n)));
    if (hit.length === 0) { groups.push({ items: [e], norms: [n] }); continue; }
    // A quote that joins two groups merges them into the first.
    const first = hit[0]!;
    first.items.push(e);
    first.norms.push(n);
    for (const g of hit.slice(1)) {
      first.items.push(...g.items);
      first.norms.push(...g.norms);
      groups.splice(groups.indexOf(g), 1);
    }
  }
  return groups.map((g) => {
    const order = [...g.items].sort((x, y) => evidence.indexOf(x) - evidence.indexOf(y));
    const shown = order.reduce((a, b) => (b.quote.length > a.quote.length ? b : a));
    const sources = [...new Set(order.map(sourceLabel))];
    const seen = new Set([normaliseQuote(shown.quote)]);
    const variants: string[] = [];
    for (const e of order) {
      const n = normaliseQuote(e.quote);
      if (!seen.has(n)) { seen.add(n); variants.push(e.quote); }
    }
    return { quote: shown.quote, sources, variants };
  });
}
