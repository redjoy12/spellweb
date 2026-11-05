import { describe, it, expect } from 'vitest';
import {
  BECOMES_TAPPED_TAG, CARD_DRAW_TAG, COMMIT_CRIME_TAG, DEALT_DAMAGE_TAG, DISCARD_TAG, LEAVES_GRAVEYARD_TAG,
} from '../src/atoms/schemaV19.js';
import { answeredReports, eventTriggers, limitPairs, tagOfTrigger, triggerGaps, type SpanAtom } from '../src/graph/triggerGap.js';

// Plan 2026-10-31-schema-v17 Task 13. The rows are synthetic: no item states a Magic fact.

const face = (text: string, oracle_id = 'o') => ({ oracle_id, name: oracle_id, face_index: 0, text });
const atom = (span_start: number, span_end: number, family = 'CARES_ABOUT', oracle_id = 'o'): SpanAtom =>
  ({ oracle_id, face_index: 0, family, type_key: 'X', span_start, span_end, params_json: '{}' });

describe('eventTriggers', () => {
  it('reads a trigger up to the first comma or colon, with the stored spans', () => {
    expect(eventTriggers('Flying\nWhenever you discard a card, draw a card.')).toEqual([{ span_start: 7, span_end: 34, quote: 'Whenever you discard a card' }]);
  });
  it('skips reminder text and "when you do"', () => {
    expect(eventTriggers('(Whenever this happens, gain 1.) When you do, draw.')).toEqual([]);
  });
});

describe('tagOfTrigger', () => {
  it('gives each trigger its tag', () => {
    expect(tagOfTrigger('Whenever one or more players discard one or more cards')).toBe(DISCARD_TAG);
    expect(tagOfTrigger('Whenever a creature card leaves your graveyard')).toBe(LEAVES_GRAVEYARD_TAG);
    expect(tagOfTrigger('Whenever equipped creature becomes tapped')).toBe(BECOMES_TAPPED_TAG);
    expect(tagOfTrigger('Whenever you draw your second card each turn')).toBe(CARD_DRAW_TAG);
    expect(tagOfTrigger('Whenever you commit a crime during your turn')).toBe(COMMIT_CRIME_TAG);
    expect(tagOfTrigger('Whenever one or more opponents are dealt noncombat damage')).toBe(DEALT_DAMAGE_TAG);
  });
  it('gives no tag to the other triggers', () => {
    expect(tagOfTrigger('Whenever a player loses life')).toBeNull();
    expect(tagOfTrigger('Whenever this creature becomes untapped')).toBeNull();
    expect(tagOfTrigger('Whenever this creature deals combat damage')).toBeNull();
  });
});

describe('triggerGaps', () => {
  const text = 'Whenever you discard a card, draw a card.';
  it('keeps a trigger with no atom, or with an atom of another family', () => {
    expect(triggerGaps([face(text)], [])).toHaveLength(1);
    expect(triggerGaps([face(text)], [atom(0, 27, 'PRODUCES')])[0]!.tag).toBe(DISCARD_TAG);
  });
  it('drops a trigger that a CARES_ABOUT atom overlaps, and looks only at its own card', () => {
    expect(triggerGaps([face(text)], [atom(5, 10)])).toEqual([]);
    expect(triggerGaps([face(text)], [atom(5, 10, 'CARES_ABOUT', 'p')])).toHaveLength(1);
  });
  it('keeps a trigger when the atom ends where the trigger starts', () => {
    expect(triggerGaps([face(text)], [atom(40, 41)])).toHaveLength(1);
  });
});

describe('limitPairs', () => {
  it('counts demand x supply, with no self pair, and leaves out the pairs with a link', () => {
    const r = limitPairs(['d', 's'], new Set(['s', 't']), new Set(['s>d']));
    expect([...r.pairs].sort()).toEqual(['s>d', 't>d', 't>s']);
    expect([...r.fresh].sort()).toEqual(['t>d', 't>s']);
  });
});

describe('answeredReports', () => {
  it('takes a report whose text has a trigger of a tag, and no other report', () => {
    const open = [
      { id: 1, quote: 'Whenever you commit a crime, draw a card.' },
      { id: 2, quote: 'if you committed a crime this turn' },
      { id: 3, quote: 'Whenever a player loses life' },
    ];
    expect(answeredReports(open)).toEqual([{ id: 1, quote: 'Whenever you commit a crime, draw a card.', tag: COMMIT_CRIME_TAG }]);
  });
});
