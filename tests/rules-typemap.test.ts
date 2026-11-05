import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseComprehensiveRules, type ParsedCorpus } from '../src/rules/parse.js';
import { buildTypeRuleMap } from '../src/rules/typemap.js';

const corpus = parseComprehensiveRules(readFileSync('tests/fixtures/cr.sample.txt', 'utf8'));
const map = buildTypeRuleMap(corpus);
const find = (key: string, kind: 'subtype' | 'card_form') =>
  map.find((m) => m.term_key === key && m.kind === kind);

describe('buildTypeRuleMap', () => {
  it('derives a subtype mapping from a 205.3 parenthetical', () => {
    const m = find('class', 'subtype')!;
    expect(m.rule_number).toBe('716');
    expect(m.resolution).toBe('subtype_crossref');
    expect(m.evidence).toContain('Class (see rule 716)');
  });

  it('keeps the fine-grained target the cross-reference actually names', () => {
    // Equipment is 301.5, not the whole of 301.
    expect(find('equipment', 'subtype')!.rule_number).toBe('301.5');
    expect(find('aura', 'subtype')!.rule_number).toBe('303.4');
  });

  it('derives a card-form mapping from a "<X> Cards" section title', () => {
    const m = find('class', 'card_form')!;
    expect(m.rule_number).toBe('716');
    expect(m.resolution).toBe('section_title');
    expect(m.evidence).toBe('716. Class Cards');
  });

  it('does not confuse Class with Attraction', () => {
    expect(find('attraction', 'card_form')!.rule_number).toBe('717');
    expect(find('class', 'card_form')!.rule_number).not.toBe('717');
  });

  it('emits nothing for a subtype with no cross-reference and no section', () => {
    expect(find('siege', 'subtype')).toBeUndefined();
    expect(find('room', 'subtype')).toBeUndefined();
  });

  it('does not mistake a singular "... Card" section title for a card form', () => {
    // `121. Drawing a Card` is a verb phrase, not a card form. An optional trailing
    // "s" in the title pattern invents a form called "Drawing a" pointing at rule 121.
    expect(map.some((m) => m.kind === 'card_form' && m.term.startsWith('Drawing'))).toBe(false);
  });

  it('never emits a rule number absent from the corpus', () => {
    const known = new Set(corpus.sections.map((s) => s.number));
    const subs = new Set(corpus.rules.map((r) => r.subsection_number).filter(Boolean) as string[]);
    for (const m of map) {
      expect(known.has(m.rule_number) || subs.has(m.rule_number), `${m.term} -> ${m.rule_number}`).toBe(true);
    }
  });

  it('rejects a subtype cross-reference to a rule absent from the corpus', () => {
    // The exists() guard is the defense against a wrong number that parses fine but
    // names a rule the corpus does not actually contain. Foo -> 999.9 is dangling;
    // Equipment -> 301.5 is real (a titled subsection) and must still be kept.
    const fakeCorpus: ParsedCorpus = {
      effective_date: '2026-06-19',
      sections: [{ number: '205', parent_number: '2', title: 'Type Line', ordinal: 0 }],
      rules: [
        { number: '205.3g', section_number: '205', subsection_number: null, subsection_title: null,
          text: 'The artifact types are Foo (see rule 999.9) and Equipment (see rule 301.5).', ordinal: 0 },
        { number: '301.5', section_number: '301', subsection_number: '301.5', subsection_title: null,
          text: '', ordinal: 1 },
      ],
      glossary: [],
    };
    const m = buildTypeRuleMap(fakeCorpus);
    expect(m.find((x) => x.term_key === 'foo' && x.kind === 'subtype')).toBeUndefined();
    expect(m.find((x) => x.term_key === 'equipment' && x.kind === 'subtype')).toBeDefined();
  });
});
