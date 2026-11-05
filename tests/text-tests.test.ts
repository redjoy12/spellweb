import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  activatedCost, approvalProblem, costResidueSteps, countManaSymbols, textTestsSha, hasHybridSymbol, hasTapSymbol, hasTriggerWordInside, hasTurnWord, isTriggered, loadTextTests,
  manaLetters, stripGroupText, testEntry, verifyTextTests, type TextTests,
} from '../src/graph/textTests.js';
import { realDb, realCorpusId, maybe } from './helpers/realDb.js';

const tests = loadTextTests();
const clone = (): TextTests => JSON.parse(JSON.stringify(tests));

maybe('verifyTextTests on the real corpus', () => {
  let resolved: Array<{ test: string; rule: string }>;
  beforeAll(() => { resolved = verifyTextTests(realDb, realCorpusId, tests); });

  it('resolves one rule for each quote of the file', () => {
    const quotes = tests.tests.flatMap((t) => (t.cr ?? []).map(() => t.test));
    expect(resolved.map((r) => r.test)).toEqual(quotes);
    for (const r of resolved) expect(r.rule).toMatch(/^(\d+(\.\d+[a-z]?)?|glossary:.+)$/);
  });

  it('a bare-section lookup resolves to the subrule or glossary entry that holds the quote', () => {
    // "activated ability" looks up a bare section, which has no text row of its own.
    const section = JSON.parse((realDb.prepare(
      "SELECT rule_numbers FROM rule_term_index WHERE corpus_id = ? AND term_key = 'activated ability' AND source = 'glossary'",
    ).get(realCorpusId) as { rule_numbers: string }).rule_numbers)[0] as string;
    expect(realDb.prepare('SELECT 1 FROM rules WHERE corpus_id = ? AND number = ?').get(realCorpusId, section)).toBeUndefined();
    const activated = resolved.filter((r) => r.test === 'activated').map((r) => r.rule);
    expect(activated[0]!.startsWith(`${section}.`)).toBe(true);
    expect(activated[0]).not.toBe(section);
  });

  it('a changed quote makes it throw', () => {
    const t = clone();
    const cr = testEntry(t, 'tap_symbol').cr![0]!;
    cr.quote = cr.quote.replace(/s/, 'z');
    expect(() => verifyTextTests(realDb, realCorpusId, t)).toThrow(/not in the CR text/);
  });

  it('a quote with a "See rule" part makes it throw', () => {
    const t = clone();
    testEntry(t, 'tap_symbol').cr![0]!.quote += ' See rule';
    expect(() => verifyTextTests(realDb, realCorpusId, t)).toThrow(/See rule/);
  });

  it('a trigger word that is not in the quote makes it throw', () => {
    const t = clone();
    (testEntry(t, 'triggered').pattern['starts_with_word'] as string[]).push('Zzz');
    expect(() => verifyTextTests(realDb, realCorpusId, t)).toThrow(/Zzz/);
  });

  it('manaLetters reads a non-empty list of single capital letters from the verified quote', () => {
    const letters = manaLetters(realDb, realCorpusId, tests);
    expect(letters.length).toBeGreaterThan(0);
    for (const l of letters) expect(l).toMatch(/^[A-Z]$/);
    const quote = testEntry(tests, 'mana_symbols').cr![0]!.quote;
    for (const l of letters) expect(quote).toContain(`{${l}}`);
  });
});

describe('config/text-tests.json', () => {
  it('has no rule-number literal', () => {
    expect(readFileSync('config/text-tests.json', 'utf8')).not.toMatch(/(?<![\w.])[1-9]\d{2}(?:\.\d+[a-z]?)?(?![\w.])/);
  });

  it('every cr_quote test has a quote, every project_decision test a reason and a gap kind', () => {
    for (const t of tests.tests) {
      if (t.basis === 'cr_quote') expect(t.cr?.length, t.test).toBeGreaterThan(0);
      else expect(t.decision?.gap_kind, t.test).toBeTruthy();
    }
  });
});

// Synthetic strings: these test text mechanics, not Magic facts.
describe('pattern tests', () => {
  it('stripGroupText removes text in parentheses and a prefix that ends with " — "', () => {
    expect(stripGroupText('Alpha (beta gamma) delta.', 0, tests).text).toBe('Alpha delta.');
    expect(stripGroupText('Alpha (beta (nested) gamma) delta.', 0, tests).text).toBe('Alpha delta.');
    expect(stripGroupText('Wordy — Whenever x, y.', 0, tests).text).toBe('Whenever x, y.');
    expect(stripGroupText('(All of it.)', 0, tests).text).toBe('');
  });

  it('stripGroupText maps each stripped character to its face offset', () => {
    const face = 'Line one.\nWordy — Abc (r) def: g.';
    const start = face.indexOf('Wordy');
    const s = stripGroupText(face.slice(start), start, tests);
    expect(s.text).toBe('Abc def: g.');
    s.text.split('').forEach((ch, i) => expect(face[s.toFace[i]!]).toBe(ch));
  });

  it('isTriggered is true for text that starts with each trigger word, false when the word is inside', () => {
    for (const w of testEntry(tests, 'triggered').pattern['starts_with_word'] as string[]) {
      expect(isTriggered(`${w} something happens, do a thing.`, tests), w).toBe(true);
      expect(isTriggered(`Do a thing ${w.toLowerCase()} something happens.`, tests), w).toBe(false);
      expect(hasTriggerWordInside(`Do a thing ${w.toLowerCase()} something happens.`, tests), w).toBe(true);
      expect(isTriggered(`${w}xyz is a longer word.`, tests), w).toBe(false);
    }
  });

  it('activatedCost finds the first colon outside quotation marks and parentheses', () => {
    const c = activatedCost(stripGroupText('{1}, Do x: Do y.', 0, tests), tests);
    expect(c).toEqual({ cost: '{1}, Do x', faceStart: 0, faceEnd: 9 });
    expect(activatedCost(stripGroupText('Things have "{1}: Do y."', 0, tests), tests)).toBeNull();
    expect(activatedCost(stripGroupText('Things have “{1}: Do y.”', 0, tests), tests)).toBeNull();
    expect(activatedCost(stripGroupText('No separator here.', 0, tests), tests)).toBeNull();
  });

  it('activatedCost gives face offsets when reminder text is before the colon', () => {
    const face = 'First.\n{2}, Do x (a reminder): Do y.';
    const start = face.indexOf('{2}');
    const c = activatedCost(stripGroupText(face.slice(start), start, tests), tests)!;
    expect(c.cost).toBe('{2}, Do x');
    expect(face.slice(c.faceStart, c.faceEnd)).toBe('{2}, Do x');
  });

  it('countManaSymbols counts numbers and letters, and gives unknown for X, other letters and slashes', () => {
    expect(countManaSymbols('{2}{Y}{Y}', ['Y'], tests)).toBe(4);
    expect(countManaSymbols('{X}{Y}', ['Y'], tests)).toBe('unknown');
    expect(countManaSymbols('{Q}', ['Y'], tests)).toBe('unknown');
    expect(countManaSymbols('{Y/Q}', ['Y', 'Q'], tests)).toBe('unknown');
    expect(countManaSymbols('no symbols', ['Y'], tests)).toBe(0);
    expect(hasHybridSymbol('{1}{Y/Q}', tests)).toBe(true);
    expect(hasHybridSymbol('{1}{Y}', tests)).toBe(false);
  });

  it('removes the tap symbol of the file before the count', () => {
    const tap = testEntry(tests, 'tap_symbol').pattern['symbol'] as string;
    expect(countManaSymbols(`${tap}, {1}`, ['Y'], tests)).toBe(1);
    expect(countManaSymbols(`${tap}, {1}`, ['Y'])).toBe(1);
  });

  it('an open delimiter with no close keeps its text, and is marked', () => {
    const s = stripGroupText('Alpha (beta delta.', 0, tests);
    expect(s.text).toBe('Alpha (beta delta.');
    expect(s.unclosed).toBe(true);
    expect(s.reminderStripped).toBe(false);
    const nested = stripGroupText('Alpha (beta (gamma) delta.', 0, tests);
    expect(nested.text).toBe('Alpha (beta delta.');
    expect(nested.unclosed).toBe(true);
    expect(stripGroupText('Alpha) beta.', 0, tests).text).toBe('Alpha) beta.');
  });

  it('prefix_strip keeps a text before the marker that starts with a trigger word, has the separator or a period', () => {
    const word = (testEntry(tests, 'triggered').pattern['starts_with_word'] as string[])[0]!;
    for (const text of [`${word} x happens, do y — z.`, '{1}, Do x: Do y — z.', 'Do x. Do y — z.']) {
      const s = stripGroupText(text, 0, tests);
      expect(s.text, text).toBe(text);
      expect(s, text).toMatchObject({ prefixStripped: false, prefixRefused: true });
    }
    expect(stripGroupText('Wordy words — z.', 0, tests)).toMatchObject({ text: 'z.', prefixStripped: true, prefixRefused: false });
    const t = clone();
    (testEntry(t, 'prefix_strip').pattern['refuse_when_prefix'] as string[]).push('unknown_check');
    expect(() => stripGroupText('A — b.', 0, t)).toThrow(/unknown refusal unknown_check/);
  });

  it('the approval holds only for the approved content', () => {
    const t = clone();
    t.owner_approved_version = t.tests_version;
    t.owner_approved_sha = textTestsSha(t);
    expect(approvalProblem(t)).toBeNull();
    testEntry(t, 'turn_word').pattern['word'] = 'other';
    expect(approvalProblem(t)).toMatch(/changed after the owner approved/);
    const v = clone();
    v.owner_approved_version = v.tests_version + 1;
    expect(approvalProblem(v)).toMatch(/has no owner approval/);
  });

  it('the file carries an approval that agrees with its content', () => {
    expect(approvalProblem(tests)).toBeNull();
  });

  it('reports which strips happened', () => {
    expect(stripGroupText('Wordy — Abc (r) def.', 0, tests)).toMatchObject({ prefixStripped: true, reminderStripped: true, unclosed: false });
    expect(stripGroupText('Abc def.', 0, tests)).toMatchObject({ prefixStripped: false, reminderStripped: false, unclosed: false });
  });

  it('the pattern tests read their characters from the file, not from the code', () => {
    const t = clone();
    testEntry(t, 'reminder_strip').pattern['remove_between'] = ['[', ']'];
    expect(stripGroupText('Alpha [beta] (gamma).', 0, t).text).toBe('Alpha (gamma).');
    // activatedCost ignores a separator inside the reminder delimiters of the file.
    expect(activatedCost({ text: 'Do [x: y] z.', toFace: [...'Do [x: y] z.'].map((_, i) => i) }, t)).toBeNull();
    expect(activatedCost({ text: 'Do (x: y) z.', toFace: [...'Do (x: y) z.'].map((_, i) => i) }, t)).not.toBeNull();
    const noQuotes = clone();
    testEntry(noQuotes, 'activated').pattern['outside'] = ['parentheses'];
    expect(activatedCost(stripGroupText('Have "{1}: Do y."', 0, noQuotes), noQuotes)?.cost).toBe('Have "{1}');
    const sym = clone();
    Object.assign(testEntry(sym, 'mana_symbols').pattern, { open: '<', close: '>' });
    expect(countManaSymbols('<2><Y>', ['Y'], sym)).toBe(3);
  });

  it('refuses an unknown region of activated.outside and an unknown cost_residue step', () => {
    const t = clone();
    testEntry(t, 'activated').pattern['outside'] = ['brackets'];
    expect(() => activatedCost(stripGroupText('a: b', 0, t), t)).toThrow(/unknown region brackets/);
    const r = clone();
    (testEntry(r, 'cost_residue').pattern['remove'] as string[]).push('dashes');
    expect(() => costResidueSteps(r)).toThrow(/unknown step dashes/);
  });

  it('hasTapSymbol is true for a cost with the tap symbol', () => {
    expect(hasTapSymbol('{T}, Sacrifice x', tests)).toBe(true);
    expect(hasTapSymbol('{1}, Sacrifice x', tests)).toBe(false);
  });

  it('hasTurnWord finds the word, not a longer word', () => {
    expect(hasTurnWord('Do this only once each turn.', tests)).toBe(true);
    expect(hasTurnWord('Return x.', tests)).toBe(false);
  });
});
