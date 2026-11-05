import { describe, it, expect } from 'vitest';
import { validateDescribed } from '../src/atoms/tagDescribe.js';

const schemas = new Map([
  ['PRODUCES.CARD_DRAW', JSON.stringify({ properties: { amount: { type: ['integer', 'string'] } } })],
  ['PRODUCES.DISCARD', JSON.stringify({ properties: { actor: { enum: ['you', 'opponent', 'any'] }, card_types: { type: 'array', items: { enum: ['land', 'creature'] } } } })],
]);
const ctx = { self: 'PRODUCES.CONNIVE', schemas, packetRules: new Set(['701.50a']) };

describe('tag descriptions (owner request 2026-10-24)', () => {
  it('accepts a description with parts from the vocabulary', () => {
    expect(validateDescribed({ description: 'Draw a card, then discard a card.', parts: [{ type: 'PRODUCES.CARD_DRAW', when: 'always', params: { amount: 1 } }, { type: 'PRODUCES.DISCARD', when: 'always', params: { actor: 'you' } }], rules: ['701.50a'] }, ctx)).toEqual([]);
  });

  it('refuses unknown parts, bad values, the type itself and rules not in the packet', () => {
    const e = validateDescribed({
      description: 'x',
      parts: [{ type: 'PRODUCES.NOPE', when: 'always' }, { type: 'PRODUCES.CONNIVE', when: 'always' }, { type: 'PRODUCES.DISCARD', when: 'often' as never, params: { actor: 'me', card_types: ['artifact'], who: 1 } }],
      rules: ['999.1'],
    }, ctx);
    expect(e).toEqual(expect.arrayContaining([
      'part PRODUCES.NOPE is not in the vocabulary', 'a part is the type itself', 'part PRODUCES.DISCARD has no param who',
      'part PRODUCES.DISCARD param card_types has a value not in the list', 'rule 999.1 is not in the packet',
      'part PRODUCES.DISCARD has "when" "often", not one of always, may, if',
    ]));
    expect(e.some((x) => x.startsWith('part PRODUCES.DISCARD param actor has value "me"'))).toBe(true);
  });

  it('refuses an empty or too long description', () => {
    expect(validateDescribed({ description: ' ', parts: [], rules: [] }, ctx)).toEqual(['no description']);
    expect(validateDescribed({ description: Array(50).fill('word').join(' '), parts: [], rules: [] }, ctx)).toEqual(['description has more than 35 words']);
  });
});
