import { describe, it, expect } from 'vitest';
import { crDuplicates, groupSentences, isCrossReference, splitSentences, tierOf, type CrSentence } from '../src/rules/crDuplicates.js';
import { normaliseText } from '../src/rules/sameText.js';
import { evidenceText, locateEvidence, locateQuote, mapEvidenceList, mapToMain } from '../src/graph/evidenceRefs.js';
import { maybe, realCorpusId, realDb } from './helpers/realDb.js';

// Synthetic sentences check the mechanics only. The real-corpus tests copy CR text (owner request 2026-10-18).
let order = 0;
const sentence = (source: 'rule' | 'glossary', ref: string, text: string): CrSentence =>
  ({ key: `${source}|${ref}|0`, source, ref, start: 0, end: text.length, text, norm: normaliseText(text), order: order++ });

describe('splitSentences', () => {
  it('splits at a full stop before a capital letter, a quote or a bracket', () => {
    const t = 'First one here. Second "quoted" one! (Third one.) Last';
    expect(splitSentences(t).map((s) => t.slice(s.start, s.end))).toEqual(['First one here.', 'Second "quoted" one!', '(Third one.)', 'Last']);
  });
  it('does not split inside a number or before a lower-case word', () => {
    const t = 'See rule 702.19c for details. e.g. this stays.';
    expect(splitSentences(t)).toHaveLength(1);
  });
});

describe('tierOf and isCrossReference', () => {
  it('exact, contained as whole words, or fuzzy', () => {
    expect(tierOf('a b c d', 'a b c d')).toBe('exact');
    expect(tierOf('x a b c d y', 'a b c d')).toBe('contained');
    expect(tierOf('a b c d', 'a b x d')).toBe('fuzzy');
  });
  it('a sentence that starts with "see" is a cross reference', () => {
    expect(isCrossReference(normaliseText('(See rule 603, "Handling Triggered Abilities.")'))).toBe(true);
    expect(isCrossReference(normaliseText('Seek the top card.'))).toBe(false);
  });
});

describe('groupSentences', () => {
  it('the main sentence is the first that covers all members; exact and contained members are applied', () => {
    const a = sentence('rule', '1', 'A multiplayer game is a game that begins with more than two players.');
    const b = sentence('glossary', 'Multiplayer Game', 'A game that begins with more than two players.');
    const c = sentence('rule', '2', 'A multiplayer game is a game that begins with more than two players.');
    const d = groupSentences([a, b, c]);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0]!.main.key).toBe(a.key);
    expect(d.groups[0]!.members.map((m) => [m.ref, m.tier])).toEqual([['Multiplayer Game', 'contained'], ['2', 'exact']]);
    expect(d.mainOf.get(b.key)?.key).toBe(a.key);
  });
  it('a fuzzy member is grouped but not applied', () => {
    const a = sentence('rule', '3', 'To activate an ability is to put it onto the stack and pay its costs, so that it will eventually resolve and have its effect.');
    const b = sentence('rule', '4', 'To activate an activated ability is to put it onto the stack and pay its costs, so that it will eventually resolve and have its effect.');
    const d = groupSentences([a, b]);
    expect(d.groups[0]!.members.map((m) => m.tier)).toEqual(['fuzzy']);
    expect(d.mainOf.size).toBe(0);
  });
  it('cross-reference sentences and different sentences are not grouped', () => {
    const d = groupSentences([sentence('rule', '5', 'See rule 704.'), sentence('rule', '6', 'See rule 704.'),
      sentence('rule', '7', 'Damage dealt to a planeswalker results in that many loyalty counters being removed from it.'),
      sentence('rule', '8', 'Damage dealt to a battle results in that many defense counters being removed from it.')]);
    expect(d.groups).toHaveLength(0);
  });
});

describe('locateQuote (spec sec. 5.4 quote test)', () => {
  it('finds the offsets with any run of white space and curly punctuation', () => {
    const t = 'One line.\nIt’s the  second   line.';
    const at = locateQuote(t, "It's the second line.")!;
    expect(t.slice(at.start, at.end)).toBe('It’s the  second   line.');
    expect(locateQuote(t, 'not here')).toBeNull();
  });
});

maybe('CR repeats on the real corpus', () => {
  const d = crDuplicates(realDb, realCorpusId);
  it('the glossary entry Multiplayer Game is also stated in rule 100.1b (applied)', () => {
    const g = d.groups.find((x) => x.members.some((m) => m.source === 'glossary' && m.ref === 'Multiplayer Game'));
    expect(g?.main.ref).toBe('100.1b');
    expect(g?.members.find((m) => m.ref === 'Multiplayer Game')?.tier).toBe('contained');
  });
  it('701.2a and 602.2 are a fuzzy candidate with main 602.2, not applied', () => {
    const g = d.groups.find((x) => x.main.ref === '602.2' && x.members.some((m) => m.ref === '701.2a' && m.tier === 'fuzzy'));
    expect(g).toBeDefined();
    const m = g!.members.find((x) => x.ref === '701.2a')!;
    expect(d.mainOf.has(m.key)).toBe(false);
  });
  it('a reference reads back its quote, and an applied member maps to its main sentence', () => {
    const e = { source: 'glossary' as const, ref: 'Multiplayer Game', quote: 'A game that begins with more than two players.' };
    const r = locateEvidence(realDb, realCorpusId, e)!;
    expect(evidenceText(realDb, realCorpusId, r).quote).toBe(e.quote);
    const m = mapToMain(realDb, realCorpusId, r, d);
    expect(m.mapped).toBe(true);
    expect(m.ref.ref).toBe('100.1b');
    // The quote test is case-sensitive, so the reference moves to the whole main sentence.
    expect(evidenceText(realDb, realCorpusId, m.ref).quote).toBe('A multiplayer game is a game that begins with more than two players.');
    const both = mapEvidenceList(realDb, realCorpusId, [
      { source: 'rule', ref: '100.1b', quote: 'a game that begins with more than two players' }, e], d);
    expect(both.refs).toHaveLength(1);
    expect(both.dropped).toBe(1);
  });
});
