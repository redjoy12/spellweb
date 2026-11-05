import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { splitOracleText, SPLITTER_VERSION } from '../src/atoms/clauses.js';

describe('splitOracleText', () => {
  it('returns no clauses for empty text (20 such faces exist)', () => {
    expect(splitOracleText('', 0)).toHaveLength(0);
  });

  it('splits sentences within one ability line', () => {
    const t = 'Target creature gets -2/-2 until end of turn. You gain 2 life.';
    const cs = splitOracleText(t, 0);
    expect(cs).toHaveLength(2);
    expect(cs.every((c) => c.kind === 'ability')).toBe(true);
    expect(cs[0]!.text).toBe('Target creature gets -2/-2 until end of turn.');
  });

  it('splits abilities on newlines', () => {
    const cs = splitOracleText('Flying\nVigilance', 0);
    expect(cs.map((c) => c.text)).toEqual(['Flying', 'Vigilance']);
  });

  it('classifies parenthesised reminder text separately', () => {
    const t = 'Flying (This creature can\'t be blocked except by creatures with flying or reach.)';
    const cs = splitOracleText(t, 0);
    expect(cs.map((c) => c.kind)).toEqual(['ability', 'reminder']);
    expect(cs[1]!.text.startsWith('(')).toBe(true);
  });

  it('does not split sentences inside reminder text', () => {
    const t = 'Cascade (When you cast this spell, exile cards. You may cast it. Put the rest on the bottom.)';
    const cs = splitOracleText(t, 0);
    expect(cs.filter((c) => c.kind === 'reminder')).toHaveLength(1);
  });

  it('classifies an ability word as one whole clause including its marker', () => {
    const cs = splitOracleText('Landfall — Whenever a land you control enters, draw a card.', 0);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.kind).toBe('flavor_word');
    expect(cs[0]!.text.startsWith('Landfall —')).toBe(true);
  });

  it('classifies saga chapters and keeps the marker', () => {
    const cs = splitOracleText('I, II — Draw a card.\nIII — You gain 3 life.', 0);
    expect(cs.map((c) => c.kind)).toEqual(['chapter', 'chapter']);
  });

  it('classifies loyalty abilities', () => {
    const cs = splitOracleText('+1: Draw a card.\n−3: Destroy target creature.', 0);
    expect(cs.map((c) => c.kind)).toEqual(['loyalty', 'loyalty']);
  });

  it('classifies bulleted modes', () => {
    const cs = splitOracleText('Choose one —\n• Draw a card.\n• You gain 3 life.', 0);
    expect(cs.filter((c) => c.kind === 'mode')).toHaveLength(2);
  });

  it('produces spans that slice back to the clause text exactly', () => {
    const fixture = JSON.parse(readFileSync('tests/fixtures/clauses.cases.json', 'utf8')) as
      Array<{ rows: Array<{ oracle_text: string }> }>;
    for (const bucket of fixture) {
      for (const row of bucket.rows) {
        for (const c of splitOracleText(row.oracle_text, 0)) {
          expect(row.oracle_text.slice(c.span_start, c.span_end)).toBe(c.text);
        }
      }
    }
  });

  it('covers the whole face apart from whitespace between clauses', () => {
    const t = 'Flying\nWhenever this creature attacks, draw a card.';
    const covered = splitOracleText(t, 0).reduce((n, c) => n + (c.span_end - c.span_start), 0);
    expect(covered).toBe(t.replace(/\n/g, '').length);
  });

  it('exposes a version so a splitter change can invalidate stored clauses', () => {
    expect(typeof SPLITTER_VERSION).toBe('number');
  });

  it('splits a multi-sentence marker line, keeping the marker on the first clause', () => {
    const cs = splitOracleText('• Draw a card. You gain 3 life.', 0);
    expect(cs).toHaveLength(2);
    expect(cs.every((c) => c.kind === 'mode')).toBe(true);
    expect(cs[0]!.text.startsWith('•')).toBe(true);
  });

  it('never emits a punctuation-only clause around mid-line reminder text', () => {
    const t = 'III — Destroy target permanent. Return it to the battlefield (front face up).';
    const cs = splitOracleText(t, 0);
    expect(cs.filter((c) => !/[\p{L}\p{N}]/u.test(c.text))).toHaveLength(0);
  });

  it('classifies Case chapters as chapter, per sec. 5.1', () => {
    const cs = splitOracleText('To solve — You control three creatures.\nSolved — Draw a card.', 0);
    expect(cs.map((c) => c.kind)).toEqual(['chapter', 'chapter']);
  });

  it('classifies an ability word with a digit as flavor_word (Descend 8)', () => {
    const cs = splitOracleText('Descend 8 — If you have eight or more cards in your graveyard, put a card from your hand onto the battlefield.', 0);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.kind).toBe('flavor_word');
    expect(cs[0]!.text.startsWith('Descend 8 —')).toBe(true);
  });

  it('classifies an ability word with an internal hyphen as flavor_word (Animal May-Ham)', () => {
    const cs = splitOracleText('Animal May-Ham — Whenever this creature attacks, create a token.', 0);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.kind).toBe('flavor_word');
  });

  it('classifies a multi-word ability word as flavor_word and keeps the marker', () => {
    const cs = splitOracleText('Will of the Planeswalker — Whenever a planeswalker you control enters, draw a card.', 0);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.kind).toBe('flavor_word');
    expect(cs[0]!.text.startsWith('Will of the Planeswalker —')).toBe(true);
  });

  it('classifies a zero-cost loyalty ability with no sign', () => {
    const cs = splitOracleText('0: Draw a card.', 0);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.kind).toBe('loyalty');
  });

  it('keeps nested parentheses inside one reminder clause', () => {
    const t = 'Cascade (When you cast this spell, exile cards (face up). You may cast it.)';
    const reminders = splitOracleText(t, 0).filter((c) => c.kind === 'reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.text).toBe('(When you cast this spell, exile cards (face up). You may cast it.)');
  });
});
