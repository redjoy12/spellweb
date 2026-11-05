import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseComprehensiveRules, normalizeTermKey } from '../src/rules/parse.js';

const text = readFileSync('tests/fixtures/cr.sample.txt', 'utf8');
const corpus = parseComprehensiveRules(text);

describe('parseComprehensiveRules', () => {
  it('reads the effective date from the document itself', () => {
    expect(corpus.effective_date).toBe('2026-06-19');
  });

  it('skips the table of contents and parses body sections once', () => {
    const numbers = corpus.sections.map((s) => s.number);
    expect(numbers.filter((n) => n === '702')).toHaveLength(1);
    expect(numbers).toContain('1');
    expect(numbers).toContain('100');
    expect(numbers).toContain('702');
  });

  it('links three-digit sections to their top-level parent', () => {
    const s = corpus.sections.find((x) => x.number === '702')!;
    expect(s.parent_number).toBe('7');
    expect(s.title).toBe('Keyword Abilities');
  });

  it('parses numbered rules with their section and lettered subrules', () => {
    const r = corpus.rules.find((x) => x.number === '702.2a')!;
    expect(r.section_number).toBe('702');
    expect(r.subsection_number).toBe('702.2');
    expect(r.text).toMatch(/static ability/);
  });

  it('attaches the titled-subsection name to every rule beneath it', () => {
    const rules = corpus.rules.filter((r) => r.subsection_number === '702.2');
    expect(rules.length).toBeGreaterThanOrEqual(2);
    expect(rules.every((r) => r.subsection_title === 'Deathtouch')).toBe(true);
  });

  it('does not treat a titled subsection heading as a rule with body text', () => {
    const heading = corpus.rules.find((r) => r.number === '702.2');
    expect(heading?.text ?? '').not.toMatch(/^Deathtouch$/);
  });

  it('recognises a titled subsection whose title does not begin with a letter', () => {
    // 702.186 is titled "\u221e (Infinity)". A /^[A-Z]/ opener test loses it silently.
    const sub = corpus.rules.filter((r) => r.subsection_number === '702.186');
    expect(sub.length).toBeGreaterThan(0);
    expect(sub.every((r) => r.subsection_title === '\u221e (Infinity)')).toBe(true);
  });

  it('parses glossary entries and their rule cross-references', () => {
    const g = Object.fromEntries(corpus.glossary.map((e) => [e.term_key, e]));
    expect(g['megamorph']!.cross_refs).toEqual(['702.37']);
    expect(g['sacrifice']!.cross_refs).toEqual(['701.16']);
    expect(g['ability word']!.cross_refs).toEqual(['207.2c']);
  });

  it('yields no cross-reference when a glossary entry names a term rather than a rule', () => {
    const g = Object.fromEntries(corpus.glossary.map((e) => [e.term_key, e]));
    expect(g['forestwalk']!.definition).toBe('See Landwalk.');
    expect(g['forestwalk']!.cross_refs).toEqual([]);
  });

  it('excludes the Credits block from the glossary', () => {
    expect(corpus.glossary.map((e) => e.term_key)).not.toContain('magic: the gathering was designed by richard garfield.');
  });

  it('captures multiple cross-references in one glossary entry and dedupes', () => {
    const src = [
      'These rules are effective as of June 19, 2026.',
      '1. Game Concepts', '',
      'Glossary', '',
      'Fake Term',
      'A thing. See rule 702.2 and See rule 702.14. Also See rule 702.2 again.',
      '',
      'Credits', '',
    ].join('\n');
    const c = parseComprehensiveRules(src);
    const g = Object.fromEntries(c.glossary.map((e) => [e.term_key, e]));
    expect(g['fake term']!.cross_refs).toEqual(['702.2', '702.14']);
  });

  it('ends a titled subsection scope when a non-titled numeric sub follows', () => {
    // The parser skips the TOC by taking the SECOND "1. Game Concepts" / "Glossary"
    // / "Credits" as the body/marker start, so the synthetic src must include a
    // TOC stub before the real body (mirroring the real CR layout).
    const src = [
      'These rules are effective as of June 19, 2026.',
      'Contents', '',
      '1. Game Concepts', '',
      'Glossary', '',
      'Credits', '',
      '',
      '1. Game Concepts', '', '702. Keyword Abilities', '',
      '702.2. Deathtouch', '', '702.2a Deathtouch is a static ability.', '',
      '702.3. This one has a full sentence body and is not a title.', '',
      '702.3a A subrule under the non-titled subsection.', '',
      '',
      'Glossary', '',
      'Credits', '',
    ].join('\n');
    const c = parseComprehensiveRules(src);
    const a = c.rules.find((r) => r.number === '702.2a')!;
    expect(a.subsection_title).toBe('Deathtouch');
    const plain = c.rules.find((r) => r.number === '702.3')!;
    expect(plain.subsection_title).toBeNull();
    expect(plain.text).toMatch(/full sentence/);
    const sub = c.rules.find((r) => r.number === '702.3a')!;
    expect(sub.subsection_title).toBeNull();
  });

  it('does not leak a titled subsection across a prefix collision (702.2 -> 702.20)', () => {
    // The removed scope-end block used startsWith(currentSubsection) to decide
    // whether to reset the title. For 702.20 after 702.2, "702.20".startsWith("702.2")
    // is true, so it would NOT reset, leaking "Deathtouch" onto 702.20a. The push's
    // strict-equality guard (numericSub === currentSubsection) is what prevents this.
    const src = [
      'These rules are effective as of June 19, 2026.',
      'Contents', '',
      '1. Game Concepts', '',
      'Glossary', '',
      'Credits', '',
      '',
      '1. Game Concepts', '', '702. Keyword Abilities', '',
      '702.2. Deathtouch', '', '702.2a Deathtouch is a static ability.', '',
      '702.20. This is a full sentence body and is not a title.', '',
      '702.20a A subrule under the non-titled subsection.', '',
      '',
      'Glossary', '',
      'Credits', '',
    ].join('\n');
    const c = parseComprehensiveRules(src);
    const titled = c.rules.find((r) => r.number === '702.2a')!;
    expect(titled.subsection_title).toBe('Deathtouch');
    const plain = c.rules.find((r) => r.number === '702.20')!;
    expect(plain.subsection_title).toBeNull();
    expect(plain.text).toMatch(/full sentence/);
    const sub = c.rules.find((r) => r.number === '702.20a')!;
    expect(sub.subsection_title).toBeNull();
  });

  it('treats U+2028 LINE SEPARATOR as a line break, in rules and in the glossary', () => {
    // CR 20260925 replaced some hard newlines with U+2028: inside 205.4c / 509.1b
    // (before an indented continuation paragraph) and between the numbered senses
    // of glossary entries. JS `.` does not match U+2028, so RE_RULE failed on those
    // lines and both rules were silently dropped. The file must parse exactly as
    // its newline-separated equivalent did.
    const withNewlines = [
      'These rules are effective as of September 25, 2026.',
      'Contents', '',
      '1. Game Concepts', '',
      'Glossary', '',
      'Credits', '',
      '',
      '2. Parts of a Card', '', '205. Type Line', '',
      '205.4c Any land with the supertype "basic" is a basic land.',
      '     Cards printed in sets prior to the Eighth Edition core set didn\'t use the word "basic".', '',
      '205.4d Any permanent with the supertype "legendary" is subject to the legend rule.', '',
      '',
      'Glossary', '',
      'Ability',
      '1. Text on an object that explains what that object does or can do.',
      '2. An activated or triggered ability on the stack.',
      'See rule 113, "Abilities."', '',
      'Credits', '',
    ].join('\n');
    const withSeparators = withNewlines
      .replace('basic land.\n     Cards', 'basic land.\u2028\u00a0\u00a0\u00a0\u00a0 Cards')
      .replace('do.\n2. An', 'do.\u20282. An')
      .replace('stack.\nSee rule', 'stack.\u2028See rule');
    expect(withSeparators).toContain('\u2028');

    const expected = parseComprehensiveRules(withNewlines);
    const actual = parseComprehensiveRules(withSeparators);
    expect(actual.rules.map((r) => r.number)).toEqual(['205.4c', '205.4d']);
    expect(actual).toEqual(expected);
    expect(actual.glossary[0]!.definition).not.toContain('\u2028');
  });
});

describe('normalizeTermKey', () => {
  it('lowercases, collapses whitespace, and normalises curly punctuation', () => {
    expect(normalizeTermKey('  Partner   With ')).toBe('partner with');
    expect(normalizeTermKey('Hexproof\u2019s')).toBe("hexproof's");
  });
});
