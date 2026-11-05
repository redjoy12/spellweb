import { describe, it, expect } from 'vitest';
import { crSubtypeLists, parseListSentence, splitSentences, subtypeListSentences } from '../src/graph/subtypes.js';
import { maybe, realDb as db, realCorpusId as corpusId } from './helpers/realDb.js';

describe('the subtype parser on synthetic text (spec rev. 6 sec. 11.2)', () => {
  it('ends a sentence at a period that whitespace and a capital letter follow', () => {
    expect(splitSentences('One thing: Two. Three things. four. Five')).toEqual(['One thing: Two.', 'Three things. four.', 'Five']);
  });

  it('does not count a sentence with "subtypes are"', () => {
    expect(parseListSentence('These subtypes are called Alpha.')).toBeNull();
  });

  it('gives the text after a colon, split at ", " and "and "', () => {
    expect(parseListSentence('The thing types are as follows: Alpha, Beta Gamma, and Delta.')).toEqual(['Alpha', 'Beta Gamma', 'Delta']);
  });

  it('removes each "(see rule ...)" part', () => {
    expect(parseListSentence('The thing types are Alpha (see rule 1), Beta, and Gamma.')).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('rejects a sentence with an item that does not start with a capital letter', () => {
    expect(parseListSentence('That thing type is alpha.')).toBeNull();
  });

  it('keeps a name that ends in "and" whole', () => {
    // A literal split at "and " would give "Gr" and "Beta" here; the word boundary keeps "Grand Beta".
    expect(parseListSentence('The thing types are Alpha, Grand Beta, and Gamma.')).toEqual(['Alpha', 'Grand Beta', 'Gamma']);
  });
});

/** Counts and patterns only - no subtype names (plan Task 0 Step 6a). If a count differs, stop (D15). */
maybe('the subtype parser on the real corpus', () => {
  it('finds 10 list sentences and 546 items, of which 545 are distinct', () => {
    const sentences = subtypeListSentences(db, corpusId);
    const items = sentences.flatMap((s) => s.items);
    expect(sentences).toHaveLength(10);
    expect(items).toHaveLength(546);
    expect(new Set(items).size).toBe(545);
  });

  it('keeps the items by rule', () => {
    const lists = crSubtypeLists(db, corpusId);
    expect([...lists.values()].flat()).toHaveLength(546);
    for (const rule of lists.keys()) expect(rule).toMatch(/^\d+\.\d+[a-z]$/);
  });

  it('gives no item with "called", "(see rule" or a rule number, and each item starts with a capital letter', () => {
    for (const item of [...crSubtypeLists(db, corpusId).values()].flat()) {
      expect(item).not.toMatch(/called|\(see rule|\d{3}/);
      expect(item).toMatch(/^[A-Z]/);
    }
  });
});
