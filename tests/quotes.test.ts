import { describe, it, expect } from 'vitest';
import { scanCrCitations } from '../src/rules/parse.js';
import { checkEvidence, glossaryRef, quoteInReference, ruleWithSubrules } from '../src/graph/quotes.js';
import { maybe, realDb as db, realCorpusId as corpusId } from './helpers/realDb.js';

describe('scanCrCitations (plan D3)', () => {
  it('gives each "CR NNN" citation in order, without duplicates', () => {
    expect(scanCrCitations('... CR 700.4 defines ... CR 701.21a and CR 700.4')).toEqual(['700.4', '701.21a']);
  });

  it('does not read the "see rule" form', () => {
    expect(scanCrCitations('see rule 700.4')).toEqual([]);
  });
});

/** Rule text is read from the corpus, never written into the test (plan Task 0 Step 3). */
maybe('checkEvidence and quoteInReference (spec sec. 5.4, rev. 6 sec. 4.2, plan D16)', () => {
  const row = (n: string) => db.prepare('SELECT number, text, section_number, subsection_number FROM rules WHERE corpus_id = ? AND number = ?')
    .get(corpusId, n) as { number: string; text: string; section_number: string; subsection_number: string | null };
  /** A lettered subrule with text whose parent "NNN.N" rule also has text. */
  const subrule = () => db.prepare(
    `SELECT c.number FROM rules c JOIN rules p ON p.corpus_id = c.corpus_id AND p.number = c.subsection_number
      WHERE c.corpus_id = ? AND c.number GLOB '*[a-z]' AND c.text <> '' AND p.text <> '' AND length(c.text) > 40
      ORDER BY c.ordinal LIMIT 1`,
  ).get(corpusId) as { number: string };
  const termRef = (term: string) => {
    const r = db.prepare("SELECT term, rule_numbers FROM rule_term_index WHERE corpus_id = ? AND term_key = ? AND source = 'glossary'")
      .get(corpusId, term) as { term: string; rule_numbers: string };
    return { term: r.term, ref: (JSON.parse(r.rule_numbers) as string[])[0]! };
  };

  it('passes a quote that is a substring of the rule text', () => {
    const r = row(subrule().number);
    expect(checkEvidence(db, corpusId, { source: 'rule', ref: r.number, quote: r.text.slice(5, 35) }, new Set([r.number]))).toBeNull();
  });

  it('passes a quote with other whitespace and curly quote marks', () => {
    const r = row(subrule().number);
    const quote = r.text.slice(0, 40).replace(/ /g, '  ').replace(/'/g, '’');
    expect(checkEvidence(db, corpusId, { source: 'rule', ref: r.number, quote }, new Set([r.number]))).toBeNull();
  });

  it('gives not_verbatim for a quote with one changed character', () => {
    const r = row(subrule().number);
    const q = r.text.slice(5, 35);
    const changed = q.slice(0, 10) + (q[10] === 'x' ? 'y' : 'x') + q.slice(11);
    expect(checkEvidence(db, corpusId, { source: 'rule', ref: r.number, quote: changed }, new Set([r.number]))).toBe('not_verbatim');
  });

  it('gives not_in_packet for a rule that is not in the packet references', () => {
    const r = row(subrule().number);
    expect(checkEvidence(db, corpusId, { source: 'rule', ref: r.number, quote: r.text.slice(0, 20) }, new Set())).toBe('not_in_packet');
  });

  it('gives not_in_packet for a subrule when the packet has only its parent rule and section (no containment)', () => {
    const r = row(subrule().number);
    const refs = new Set([r.subsection_number!, r.section_number]);
    expect(checkEvidence(db, corpusId, { source: 'rule', ref: r.number, quote: r.text.slice(0, 20) }, refs)).toBe('not_in_packet');
  });

  it('gives unknown_ref for a rule number that is not in the corpus', () => {
    expect(checkEvidence(db, corpusId, { source: 'rule', ref: '999.999z', quote: 'x' }, new Set(['999.999z']))).toBe('unknown_ref');
    expect(checkEvidence(db, corpusId, { source: 'glossary', ref: 'no such term zz', quote: 'x' }, new Set())).toBe('unknown_ref');
  });

  it('checks a glossary quote against the glossary definition', () => {
    const g = db.prepare('SELECT term, definition FROM glossary_entries WHERE corpus_id = ? AND length(definition) > 40 LIMIT 1')
      .get(corpusId) as { term: string; definition: string };
    const refs = new Set([glossaryRef(g.term)]);
    expect(checkEvidence(db, corpusId, { source: 'glossary', ref: g.term, quote: g.definition.slice(2, 30) }, refs)).toBeNull();
    expect(checkEvidence(db, corpusId, { source: 'glossary', ref: g.term, quote: `${g.definition.slice(2, 30)} zzqq` }, refs)).toBe('not_verbatim');
    expect(checkEvidence(db, corpusId, { source: 'glossary', ref: g.term, quote: g.definition.slice(2, 30) }, new Set())).toBe('not_in_packet');
  });

  it('selects subrules by column, not by prefix: a quote of NNN.10 is not found under NNN.1', () => {
    const pair = db.prepare(
      `SELECT a.subsection_number AS one FROM rules a
        WHERE a.corpus_id = ? AND a.subsection_number GLOB '*.1'
          AND EXISTS (SELECT 1 FROM rules b WHERE b.corpus_id = a.corpus_id AND b.subsection_number = a.subsection_number || '0' AND b.text <> '')
        LIMIT 1`,
    ).get(corpusId) as { one: string };
    const underOne = ruleWithSubrules(db, corpusId, pair.one).map((r) => r.text).join('\n');
    const ten = ruleWithSubrules(db, corpusId, `${pair.one}0`).find((r) => !underOne.includes(r.text.slice(0, 40)))!;
    expect(ruleWithSubrules(db, corpusId, pair.one).every((r) => r.number === pair.one || r.number.startsWith(pair.one) && /[a-z]$/.test(r.number))).toBe(true);
    expect(quoteInReference(db, corpusId, { term: 'no such term zz', ref: pair.one }, ten.text.slice(0, 40))).toBeNull();
    expect(quoteInReference(db, corpusId, { term: 'no such term zz', ref: `${pair.one}0` }, ten.text.slice(0, 40))).toBe(ten.number);
  });

  it('finds a quote in a subrule of a bare section reference, and returns that subrule', () => {
    const { term, ref } = termRef('triggered ability');
    expect(ref).not.toContain('.');
    expect(db.prepare('SELECT 1 FROM rules WHERE corpus_id = ? AND number = ?').get(corpusId, ref)).toBeUndefined();
    const sub = ruleWithSubrules(db, corpusId, ref).find((r) => /[a-z]$/.test(r.number) && r.text.length > 40)!;
    const quote = sub.text.slice(0, 40);
    const first = ruleWithSubrules(db, corpusId, ref).find((r) => r.text.includes(quote))!;
    expect(quoteInReference(db, corpusId, { term, ref }, quote)).toBe(first.number);
  });

  it('searches the glossary definition of the lookup term, and returns glossary:<term>', () => {
    const { term, ref } = termRef('triggered ability');
    const def = (db.prepare('SELECT definition FROM glossary_entries WHERE corpus_id = ? AND term = ?').get(corpusId, term) as { definition: string }).definition;
    const quote = def.slice(0, 30);
    expect(ruleWithSubrules(db, corpusId, ref).some((r) => r.text.includes(quote))).toBe(false);   // precondition
    expect(quoteInReference(db, corpusId, { term, ref }, quote)).toBe(glossaryRef(term));
  });

  it('returns null for a quote that is in no rule of the reference', () => {
    const { term, ref } = termRef('triggered ability');
    expect(quoteInReference(db, corpusId, { term, ref }, 'zzqq this text is in no rule')).toBeNull();
  });
});
