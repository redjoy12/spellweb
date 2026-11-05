/**
 * Evidence as a reference into the stored CR text (owner request 2026-10-18): a rule number or a
 * glossary term, and the offsets of the quote in its stored text. The text itself is stored once,
 * in `rules` and `glossary_entries`. `locateEvidence` finds the offsets of a verified quote;
 * `evidenceText` reads the quote back. `mapToMain` moves a reference from a repeated CR sentence
 * to the main sentence of its group (src/rules/crDuplicates.ts), so that one text is cited.
 *
 * Mechanical code only; it knows no Magic.
 */
import type { DatabaseSync } from 'node:sqlite';
import { crDuplicates, textKey, type CrDuplicates, type CrSentence } from '../rules/crDuplicates.js';
import { normalizePunctuation, normalizeTermKey } from '../rules/parse.js';
import type { Evidence } from './quotes.js';

/** A quote as a reference: the source, the rule number or glossary term, and the offsets in its stored text. */
export interface EvidenceRef { source: 'rule' | 'glossary'; ref: string; start: number; end: number }

/** The stored text of a rule or a glossary definition, with the canonical ref (the glossary term as stored). */
export function sourceText(db: DatabaseSync, corpusId: number, source: 'rule' | 'glossary', ref: string): { ref: string; text: string } | null {
  if (source === 'rule') {
    const r = db.prepare('SELECT number, text FROM rules WHERE corpus_id = ? AND number = ?').get(corpusId, ref) as { number: string; text: string } | undefined;
    return r ? { ref: r.number, text: r.text } : null;
  }
  const g = db.prepare('SELECT term, definition FROM glossary_entries WHERE corpus_id = ? AND term_key = ?')
    .get(corpusId, normalizeTermKey(ref)) as { term: string; definition: string } | undefined;
  return g ? { ref: g.term, text: g.definition } : null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The offsets of `quote` in `text`, with the quote test of spec sec. 5.4 (`normalizeQuote`:
 * punctuation-normalised, any run of white space equal). Null when the text does not hold it.
 */
export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const words = normalizePunctuation(quote).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const m = new RegExp(words.map(escape).join('\\s+')).exec(normalizePunctuation(text));
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/** The reference of a verified quote, or null when its source text does not hold it. */
export function locateEvidence(db: DatabaseSync, corpusId: number, e: Evidence): EvidenceRef | null {
  const src = sourceText(db, corpusId, e.source, e.ref);
  if (!src) return null;
  const at = locateQuote(src.text, e.quote);
  return at ? { source: e.source, ref: src.ref, ...at } : null;
}

/** The quote of a reference, read from the stored text. Throws when the reference is not valid. */
export function evidenceText(db: DatabaseSync, corpusId: number, r: EvidenceRef): Evidence {
  const src = sourceText(db, corpusId, r.source, r.ref);
  if (!src || r.start < 0 || r.end > src.text.length || r.start >= r.end) throw new Error(`evidence reference ${r.source} ${r.ref} ${r.start}-${r.end} is not valid`);
  return { source: r.source, ref: src.ref, quote: src.text.slice(r.start, r.end) };
}

/** The sentences of a source text that a reference touches. */
function touched(d: CrDuplicates, r: EvidenceRef): CrSentence[] {
  return (d.byText.get(textKey(r.source, r.ref)) ?? []).filter((s) => s.start < r.end && r.start < s.end);
}

export interface MappedRef { ref: EvidenceRef; mapped: boolean; cited: EvidenceRef }

/**
 * spec rev. 11 (owner request 2026-10-18): the reference of the main text. A reference that lies
 * in one applied member sentence (tier `exact` or `contained`) moves to the main sentence: to the
 * same words in the main sentence when it has them verbatim, else to the whole main sentence. A
 * reference that touches two or more sentences, or a sentence that is not an applied member,
 * stays. `cited` is the reference as cited, for the packet-reference check of sec. 5.4.
 */
export function mapToMain(db: DatabaseSync, corpusId: number, r: EvidenceRef, d: CrDuplicates = crDuplicates(db, corpusId)): MappedRef {
  const t = touched(d, r);
  const main = t.length === 1 ? d.mainOf.get(t[0]!.key) : undefined;
  if (!main) return { ref: r, mapped: false, cited: r };
  const src = sourceText(db, corpusId, main.source, main.ref)!;
  const quote = evidenceText(db, corpusId, r).quote;
  const at = locateQuote(main.text, quote);
  const ref: EvidenceRef = at
    ? { source: main.source, ref: main.ref, start: main.start + at.start, end: main.start + at.end }
    : { source: main.source, ref: main.ref, start: main.start, end: main.end };
  if (ref.end > src.text.length) throw new Error(`main sentence ${main.key} is outside its text`);
  return { ref, mapped: true, cited: r };
}

const inside = (a: EvidenceRef, b: EvidenceRef) => a.source === b.source && a.ref === b.ref && b.start <= a.start && a.end <= b.end;

/**
 * The evidence of one rule or role, mapped to the main texts, with repeats removed: a reference
 * that lies inside another reference of the same text after the mapping goes (for two equal
 * references, the first one stays).
 */
export function mapEvidenceList(db: DatabaseSync, corpusId: number, list: readonly Evidence[], d: CrDuplicates = crDuplicates(db, corpusId)):
  { refs: MappedRef[]; unlocated: Evidence[]; mapped: number; dropped: number } {
  const all: MappedRef[] = [];
  const unlocated: Evidence[] = [];
  let mapped = 0;
  for (const e of list) {
    const r = locateEvidence(db, corpusId, e);
    if (!r) { unlocated.push(e); continue; }
    const m = mapToMain(db, corpusId, r, d);
    if (m.mapped) mapped++;
    all.push(m);
  }
  const refs = all.filter((m, i) => !all.some((o, j) => j !== i && inside(m.ref, o.ref)
    && (!inside(o.ref, m.ref) || j < i)));
  return { refs, unlocated, mapped, dropped: all.length - refs.length };
}
