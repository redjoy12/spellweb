import { describe, it, expect } from 'vitest';
import { mergeQuotes, normaliseQuote, sameQuote, type QuoteEvidence } from '../src/web/lib/quoteMerge.js';

// The quotes are copied from the evidence of accepted rules of set 2. The tests check the text
// comparison only (owner request 2026-10-18).
const rule = (ref: string, quote: string): QuoteEvidence => ({ source: 'rule', ref, quote });
const glossary = (ref: string, quote: string): QuoteEvidence => ({ source: 'glossary', ref, quote });
const same = (a: string, b: string) => sameQuote(normaliseQuote(a), normaliseQuote(b));

describe('sameQuote', () => {
  it('equal after normalisation, or one text inside the other', () => {
    expect(same('A battle is a permanent.', 'a  battle is a permanent')).toBe(true);
    expect(same('A card type. A battle is a permanent.', 'A battle is a permanent.')).toBe(true);
  });
  it('a reworded sentence with the same content words is the same quote', () => {
    expect(same('Players spend mana to pay costs, usually when casting spells and activating abilities.',
      'It is spent to pay costs, usually when casting spells and activating abilities.')).toBe(true);
    expect(same('To activate an activated ability is to put it onto the stack and pay its costs, so that it will eventually resolve and have its effect.',
      'To activate an ability is to put it onto the stack and pay its costs, so that it will eventually resolve and have its effect.')).toBe(true);
  });
  it('two parallel sentences with a different noun are different quotes', () => {
    expect(same('Damage dealt to a planeswalker results in that many loyalty counters being removed from it.',
      'Damage dealt to a battle results in that many defense counters being removed from it.')).toBe(false);
    expect(same('For each colored mana in this spell\'s total cost, you may tap an untapped creature of that color you control rather than pay that mana.',
      'For each generic mana in this spell\'s total cost, you may tap an untapped creature you control rather than pay that mana.')).toBe(false);
    expect(same('Any time a player controls a permanent with nightbound, if it\'s neither day nor night and there are no permanents with daybound on the battlefield, it becomes night.',
      'Any time a player controls a permanent with daybound, if it\'s neither day nor night, it becomes day.')).toBe(false);
  });
  it('a short quote does not join a longer, different sentence', () => {
    expect(same('Put that card onto the battlefield face down.',
      'A keyword action that puts a card onto the battlefield face down as a 2/2 creature.')).toBe(false);
  });
});

describe('mergeQuotes', () => {
  it('ER-0645: five quotes become three, each with all its sources', () => {
    const m = mergeQuotes([
      rule('106.1', 'Players spend mana to pay costs, usually when casting spells and activating abilities.'),
      glossary('Mana', 'It is spent to pay costs, usually when casting spells and activating abilities.'),
      rule('701.2a', 'To activate an activated ability is to put it onto the stack and pay its costs, so that it will eventually resolve and have its effect.'),
      rule('602.1a', 'An ability\'s activation cost must be paid by the player who is activating it.'),
      rule('602.2', 'To activate an ability is to put it onto the stack and pay its costs, so that it will eventually resolve and have its effect.'),
    ]);
    expect(m.map((q) => q.sources)).toEqual([['CR 106.1', 'glossary Mana'], ['CR 701.2a', 'CR 602.2'], ['CR 602.1a']]);
    expect(m[0]!.quote).toBe('Players spend mana to pay costs, usually when casting spells and activating abilities.');
    expect(m[0]!.variants).toEqual(['It is spent to pay costs, usually when casting spells and activating abilities.']);
    expect(m[2]!.variants).toEqual([]);
  });
  it('shows the longest text of a group; an equal text is no variant', () => {
    const m = mergeQuotes([
      glossary('Battle', 'A battle is a permanent.'),
      rule('310.1', 'A card type. A battle is a permanent.'),
      rule('310.1', 'A battle is a permanent'),
    ]);
    expect(m).toHaveLength(1);
    expect(m[0]!.quote).toBe('A card type. A battle is a permanent.');
    expect(m[0]!.sources).toEqual(['glossary Battle', 'CR 310.1']);
    expect(m[0]!.variants).toEqual(['A battle is a permanent.']);
  });
  it('a quote that matches two groups joins them', () => {
    const m = mergeQuotes([rule('1', 'alpha beta gamma delta'), rule('2', 'epsilon zeta eta theta'), rule('3', 'alpha beta gamma delta epsilon zeta eta theta')]);
    expect(m).toHaveLength(1);
    expect(m[0]!.sources).toEqual(['CR 1', 'CR 2', 'CR 3']);
  });
});
