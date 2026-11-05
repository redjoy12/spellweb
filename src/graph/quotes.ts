import type { DatabaseSync } from 'node:sqlite';
import { normalizePunctuation, normalizeTermKey } from '../rules/parse.js';

/** One item of CR evidence: a rule number or a glossary term, and a verbatim quote from it. */
export interface Evidence { source: 'rule' | 'glossary'; ref: string; quote: string }
export type QuoteFault = 'not_in_packet' | 'not_verbatim' | 'unknown_ref';

/** The packet-reference key of a glossary term (plan D16): 'glossary:<term>'. */
export function glossaryRef(term: string): string {
  return `glossary:${term}`;
}

/**
 * The corpus normalisation (parse.ts stores CR text punctuation-normalised), plus whitespace.
 * Applied to both sides of a quote test, so a curly quote or a line break cannot fail a quote.
 */
export function normalizeQuote(s: string): string {
  return normalizePunctuation(s).replace(/\s+/g, ' ').trim();
}

function quoteIn(text: string, quote: string): boolean {
  const q = normalizeQuote(quote);
  return q !== '' && normalizeQuote(text).includes(q);
}

/**
 * A rule and all its subrules, in CR order, without the rows that have no text (spec rev. 6
 * sec. 4.2). Subrules come from the `section_number` and `subsection_number` columns, never from
 * a prefix match: a prefix match on "NNN.1" also gives NNN.10. A bare section ("113") has no
 * text row of its own, so it gives its subrules only. A lettered rule has no subrules.
 */
export function ruleWithSubrules(
  db: DatabaseSync, corpusId: number, ref: string,
): Array<{ number: string; text: string }> {
  const sql = /[a-z]$/.test(ref)
    ? 'SELECT number, text FROM rules WHERE corpus_id = ? AND number = ? ORDER BY ordinal'
    : ref.includes('.')
      ? 'SELECT number, text FROM rules WHERE corpus_id = ? AND subsection_number = ? ORDER BY ordinal'
      : 'SELECT number, text FROM rules WHERE corpus_id = ? AND section_number = ? ORDER BY ordinal';
  return (db.prepare(sql).all(corpusId, ref) as Array<{ number: string; text: string }>)
    .filter((r) => r.text !== '');
}

function glossaryEntry(db: DatabaseSync, corpusId: number, term: string): { term: string; definition: string } | undefined {
  return db.prepare('SELECT term, definition FROM glossary_entries WHERE corpus_id = ? AND term_key = ?')
    .get(corpusId, normalizeTermKey(term)) as { term: string; definition: string } | undefined;
}

/**
 * spec sec. 5.4, checks 4 and 5. `packetRefs` holds the exact rule numbers of the rule rows the
 * packet shows, and `glossary:<term>` for each glossary term it shows (plan D16). The test is
 * exact membership: a subrule does not pass because the packet shows its parent rule or section.
 * Do not use `isCovered` here - it is containment.
 */
export function checkEvidence(
  db: DatabaseSync, corpusId: number, e: Evidence, packetRefs: ReadonlySet<string>,
): QuoteFault | null {
  if (e.source === 'glossary') {
    const entry = glossaryEntry(db, corpusId, e.ref);
    if (!entry) return 'unknown_ref';
    if (!packetRefs.has(glossaryRef(entry.term))) return 'not_in_packet';
    return quoteIn(entry.definition, e.quote) ? null : 'not_verbatim';
  }
  const row = db.prepare('SELECT text FROM rules WHERE corpus_id = ? AND number = ?')
    .get(corpusId, e.ref) as { text: string } | undefined;
  if (!row) {
    const section = db.prepare('SELECT 1 FROM rule_sections WHERE corpus_id = ? AND number = ?').get(corpusId, e.ref);
    return section ? 'not_in_packet' : 'unknown_ref';      // a bare section shows no text row
  }
  if (!packetRefs.has(e.ref)) return 'not_in_packet';
  return quoteIn(row.text, e.quote) ? null : 'not_verbatim';
}

/**
 * spec rev. 6 sec. 4.2: where a quote of a looked-up reference is. Searches the referenced rule
 * and all its subrules (a bare section has no text row), then the glossary definition of the
 * lookup term. Returns the rule number that holds the quote, `glossary:<term>`, or null.
 */
export function quoteInReference(
  db: DatabaseSync, corpusId: number, lookup: { term: string; ref: string }, quote: string,
): string | null {
  for (const r of ruleWithSubrules(db, corpusId, lookup.ref)) {
    if (quoteIn(r.text, quote)) return r.number;
  }
  const entry = glossaryEntry(db, corpusId, lookup.term);
  return entry && quoteIn(entry.definition, quote) ? glossaryRef(entry.term) : null;
}
