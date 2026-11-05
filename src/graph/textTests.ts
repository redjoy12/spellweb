/**
 * The mechanical text tests of ability groups (Phase 3 spec sec. 4.2, plan D2).
 *
 * Each test lives in config/text-tests.json with its basis. A `cr_quote` entry names a lookup
 * term and a verbatim quote, never a rule number: verifyTextTests resolves the term through
 * rule_term_index and finds the quote in the rule, its subrules or the term's glossary
 * definition. A quote that fails stops the build. The mana letters are read from the verified
 * quote of `mana_symbols` - no letter list exists anywhere else.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { normalizeTermKey } from '../rules/parse.js';
import { canonicalJson } from './policy.js';
import { normalizeQuote, quoteInReference } from './quotes.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TESTS = resolve(here, '../../config/text-tests.json');

const TEST_NAMES = ['reminder_strip', 'prefix_strip', 'triggered', 'activated', 'mana_symbols',
  'tap_symbol', 'timing_limit', 'turn_word', 'cost_residue'] as const;

const CrQuote = z.object({ lookup: z.string().min(1), quote: z.string().min(1) });

const TextTestSchema = z.object({
  test: z.enum(TEST_NAMES),
  pattern: z.record(z.string(), z.unknown()),
  basis: z.enum(['cr_quote', 'project_decision']),
  cr: z.array(CrQuote).min(1).optional(),
  decision: z.object({ reason: z.string().min(1), gap_kind: z.enum(['trigger_word_inside', 'test_decision']) }).optional(),
}).refine((t) => t.basis !== 'cr_quote' || t.cr, { message: 'a cr_quote test needs cr' })
  .refine((t) => t.basis !== 'project_decision' || t.decision, { message: 'a project_decision test needs decision' });

const TextTestsSchema = z.object({
  tests_version: z.number().int().min(1),
  owner_approved_version: z.number().int().min(1).optional(),
  owner_approved_sha: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  tests: z.array(TextTestSchema),
}).refine((t) => TEST_NAMES.every((n) => t.tests.filter((x) => x.test === n).length === 1),
  { message: `config/text-tests.json needs exactly one entry for each of: ${TEST_NAMES.join(', ')}` });

export type TextTestName = typeof TEST_NAMES[number];
export type TextTest = z.infer<typeof TextTestSchema>;
export type TextTests = z.infer<typeof TextTestsSchema>;

/**
 * The content that the owner approves (plan D14): SHA-256 of the canonical JSON of the version
 * and the test entries. The approval fields and the _comment are not part of it.
 */
export function textTestsSha(t: TextTests): string {
  return createHash('sha256').update(canonicalJson({ tests_version: t.tests_version, tests: t.tests })).digest('hex');
}

/** Null when the owner approved this exact content; else the reason it is not approved. */
export function approvalProblem(t: TextTests): string | null {
  if (t.owner_approved_version !== t.tests_version) {
    return `tests_version ${t.tests_version} has no owner approval (owner_approved_version is ${t.owner_approved_version ?? 'absent'})`;
  }
  if (t.owner_approved_sha !== textTestsSha(t)) {
    return 'the test entries changed after the owner approved them (owner_approved_sha does not agree): '
      + 'increment tests_version and ask the owner again';
  }
  return null;
}

export function loadTextTests(path: string = DEFAULT_TESTS): TextTests {
  return TextTestsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

let cached: TextTests | null = null;
/** The default file, read once: for helpers whose callers do not pass the tests. */
function defaultTests(): TextTests {
  return (cached ??= loadTextTests());
}

export function testEntry(t: TextTests, name: TextTestName): TextTest {
  return t.tests.find((x) => x.test === name)!;
}

function patternString(t: TextTests, name: TextTestName, key: string): string {
  const v = testEntry(t, name).pattern[key];
  if (typeof v !== 'string' || v === '') throw new Error(`text test ${name}: pattern.${key} must be a non-empty string`);
  return v;
}

function patternStrings(t: TextTests, name: TextTestName, key: string): string[] {
  const v = testEntry(t, name).pattern[key];
  if (!Array.isArray(v) || v.length === 0 || !v.every((s) => typeof s === 'string' && s !== '')) {
    throw new Error(`text test ${name}: pattern.${key} must be a list of non-empty strings`);
  }
  return v as string[];
}

/** The rule references of a lookup term, in rule_term_index order (glossary first). */
function termRefs(db: DatabaseSync, corpusId: number, term: string): string[] {
  const rows = db.prepare(
    `SELECT rule_numbers FROM rule_term_index WHERE corpus_id = ? AND term_key = ?
      ORDER BY CASE source WHEN 'glossary' THEN 0 WHEN 'subsection_title' THEN 1 ELSE 2 END`,
  ).all(corpusId, normalizeTermKey(term)) as Array<{ rule_numbers: string }>;
  return [...new Set(rows.flatMap((r) => JSON.parse(r.rule_numbers) as string[]))];
}

/** Where one quote is: the rule (or 'glossary:<term>') that holds it, or an Error that says why not. */
function resolveQuote(db: DatabaseSync, corpusId: number, name: string, c: { lookup: string; quote: string }): string {
  if (/see rule/i.test(c.quote)) throw new Error(`text test ${name}: the quote must stop before its "See rule" part`);
  const refs = termRefs(db, corpusId, c.lookup);
  if (refs.length === 0) throw new Error(`text test ${name}: the lookup "${c.lookup}" resolves to no rule`);
  for (const ref of refs) {
    const hit = quoteInReference(db, corpusId, { term: c.lookup, ref }, c.quote);
    if (hit) return hit;
  }
  throw new Error(`text test ${name}: the quote "${c.quote}" is not in the CR text of "${c.lookup}"`);
}

/**
 * Checks every quote against the current corpus and returns where each one is (one item per
 * quote; a bare-section lookup gives the subrule that holds the quote). A `project_decision`
 * test can carry a supporting quote; it is checked too. Throws on the first failure: the build
 * must stop (spec sec. 4.2). Also checks that the words and symbols of the patterns that a
 * quote supports are in that quote, so a pattern cannot drift from its evidence.
 */
export function verifyTextTests(db: DatabaseSync, corpusId: number, t: TextTests): Array<{ test: string; rule: string }> {
  const out: Array<{ test: string; rule: string }> = [];
  for (const test of t.tests) {
    for (const c of test.cr ?? []) out.push({ test: test.test, rule: resolveQuote(db, corpusId, test.test, c) });
  }
  const quoted = (name: TextTestName) => normalizeQuote((testEntry(t, name).cr ?? []).map((c) => c.quote).join(' ')).toLowerCase();
  for (const w of patternStrings(t, 'triggered', 'starts_with_word')) {
    if (!quoted('triggered').includes(`"${w.toLowerCase()}`)) throw new Error(`text test triggered: the word "${w}" is not in its quote`);
  }
  if (!quoted('tap_symbol').includes(patternString(t, 'tap_symbol', 'symbol').toLowerCase())) {
    throw new Error('text test tap_symbol: the symbol is not in its quote');
  }
  if (!quoted('activated').includes(patternString(t, 'activated', 'separator'))) {
    throw new Error('text test activated: the separator is not in its quote');
  }
  return out;
}

/** The mana letters: each single-letter brace symbol of the verified `mana_symbols` quote. */
export function manaLetters(db: DatabaseSync, corpusId: number, t: TextTests): string[] {
  const entry = testEntry(t, 'mana_symbols');
  if (!entry.cr) throw new Error('text test mana_symbols has no quote to read the mana letters from');
  const letters: string[] = [];
  for (const c of entry.cr) {
    resolveQuote(db, corpusId, 'mana_symbols', c);
    for (const m of c.quote.matchAll(/\{([A-Z])\}/g)) if (!letters.includes(m[1]!)) letters.push(m[1]!);
  }
  if (letters.length === 0) throw new Error('text test mana_symbols: its quote has no single-letter mana symbol');
  return letters;
}

export function tapSymbol(t: TextTests = defaultTests()): string {
  return patternString(t, 'tap_symbol', 'symbol');
}

// ---------- the pattern tests ----------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pairs of `pattern[key]`: a list of [open, close] strings. */
function patternPairs(t: TextTests, name: TextTestName, key: string): Array<[string, string]> {
  const v = testEntry(t, name).pattern[key];
  if (!Array.isArray(v) || v.length === 0 || !v.every((p) => Array.isArray(p) && p.length === 2
      && p.every((s) => typeof s === 'string' && s !== ''))) {
    throw new Error(`text test ${name}: pattern.${key} must be a list of [open, close] pairs`);
  }
  return v as Array<[string, string]>;
}

/** The reminder_strip delimiters, one character each. */
function reminderDelimiters(t: TextTests): [string, string] {
  const d = patternStrings(t, 'reminder_strip', 'remove_between');
  if (d.length !== 2 || d.some((s) => s.length !== 1)) throw new Error('text test reminder_strip: remove_between must be two characters');
  return d as [string, string];
}

/** The brace-symbol syntax of `mana_symbols`: open and close characters, and the mark of an unknown symbol. */
export interface SymbolSyntax { open: string; close: string; unknownIfContains: string }

export function symbolSyntax(t: TextTests = defaultTests()): SymbolSyntax {
  const s = {
    open: patternString(t, 'mana_symbols', 'open'),
    close: patternString(t, 'mana_symbols', 'close'),
    unknownIfContains: patternString(t, 'mana_symbols', 'unknown_if_contains'),
  };
  if (s.open.length !== 1 || s.close.length !== 1) throw new Error('text test mana_symbols: open and close must be one character each');
  return s;
}

/** Every brace symbol of a text; group 1 is the symbol body. */
function symbolRe(s: SymbolSyntax): RegExp {
  return new RegExp(`${escapeRe(s.open)}([^${escapeRe(s.close)}]*)${escapeRe(s.close)}`, 'g');
}

/** The text without its brace symbols. */
export function removeSymbols(text: string, t: TextTests = defaultTests()): string {
  return text.replace(symbolRe(symbolSyntax(t)), '');
}

/** True when the text has a symbol whose body has the unknown mark (a hybrid symbol). */
export function hasHybridSymbol(text: string, t: TextTests = defaultTests()): boolean {
  const s = symbolSyntax(t);
  return [...text.matchAll(symbolRe(s))].some((m) => m[1]!.includes(s.unknownIfContains));
}

export interface StrippedText {
  text: string;
  /** toFace[i] is the face offset of stripped character i. */
  toFace: number[];
  reminderStripped: boolean;
  prefixStripped: boolean;
  /** A text before the prefix marker that prefix_strip refuses to remove (it is not a prefix). */
  prefixRefused: boolean;
  /** An open delimiter with no close: its text stays (it is not reminder text that the test can see). */
  unclosed: boolean;
}

const PREFIX_REFUSALS = ['starts_with_trigger_word', 'has_activated_separator'];

/**
 * prefix_strip removes the text before its marker only when that text can be a prefix: the
 * refusals of `refuse_when_prefix` are named checks or single characters. A refused prefix
 * stays in the text, and the gap report counts it (`test_decision`).
 */
function prefixIsRefused(prefix: string, t: TextTests): boolean {
  const refusals = patternStrings(t, 'prefix_strip', 'refuse_when_prefix');
  const bad = refusals.filter((r) => r.length > 1 && !PREFIX_REFUSALS.includes(r));
  if (bad.length > 0) throw new Error(`text test prefix_strip: unknown refusal ${bad.join(', ')} (${PREFIX_REFUSALS.join(', ')} or one character)`);
  return refusals.some((r) => (r === 'starts_with_trigger_word' ? isTriggered(prefix.trimStart(), t)
    : r === 'has_activated_separator' ? prefix.includes(activatedSeparator(t))
    : prefix.includes(r)));
}

/**
 * Removes each text between the reminder_strip delimiters (nested, with one space before it),
 * then a prefix that ends with the prefix_strip marker, unless a refusal holds. An open delimiter with no close keeps
 * its text. `toFace[i]` is the face offset of stripped character i, so a span found in the
 * stripped text maps back to the atom spans of the face (`groupStart` is the face offset of
 * the group).
 */
export function stripGroupText(text: string, groupStart: number, t: TextTests = defaultTests()): StrippedText {
  const [open, close] = reminderDelimiters(t);
  const removed = new Array<boolean>(text.length).fill(false);
  const stack: number[] = [];
  let reminderStripped = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === open) stack.push(i);
    else if (text[i] === close && stack.length > 0) {
      const from = stack.pop()!;
      for (let k = from; k <= i; k++) removed[k] = true;
      if (from > 0 && text[from - 1] === ' ') removed[from - 1] = true;
      reminderStripped = true;
    }
  }
  let chars: number[] = [];
  for (let i = 0; i < text.length; i++) if (!removed[i]) chars.push(i);

  const marker = patternString(t, 'prefix_strip', 'prefix_ends_with');
  const joined = chars.map((i) => text[i]).join('');
  const at = joined.indexOf(marker);
  const prefixRefused = at > 0 && prefixIsRefused(joined.slice(0, at), t);
  const prefixStripped = at > 0 && !prefixRefused;
  if (prefixStripped) chars = chars.slice(at + marker.length);
  while (chars.length > 0 && /\s/.test(text[chars[0]!]!)) chars = chars.slice(1);
  while (chars.length > 0 && /\s/.test(text[chars[chars.length - 1]!]!)) chars = chars.slice(0, -1);
  return {
    text: chars.map((i) => text[i]).join(''), toFace: chars.map((i) => i + groupStart),
    reminderStripped, prefixStripped, prefixRefused, unclosed: stack.length > 0,
  };
}

function wordsRe(words: string[], anchored: boolean, caseInsensitive: boolean): RegExp {
  return new RegExp(`${anchored ? '^' : ''}\\b(?:${words.map(escapeRe).join('|')})\\b`, caseInsensitive ? 'i' : '');
}

/** True when the stripped text starts with a trigger word (spec sec. 4.2 `triggered`). */
export function isTriggered(stripped: string, t: TextTests = defaultTests()): boolean {
  const p = testEntry(t, 'triggered').pattern;
  return wordsRe(patternStrings(t, 'triggered', 'starts_with_word'), true, p['case_insensitive'] === true).test(stripped);
}

/** True when a trigger word is in the text but not at its start: the `trigger_word_inside` gap. */
export function hasTriggerWordInside(stripped: string, t: TextTests = defaultTests()): boolean {
  const p = testEntry(t, 'triggered').pattern;
  return !isTriggered(stripped, t)
    && wordsRe(patternStrings(t, 'triggered', 'starts_with_word'), false, p['case_insensitive'] === true).test(stripped);
}

export function activatedSeparator(t: TextTests = defaultTests()): string {
  return patternString(t, 'activated', 'separator');
}

const OUTSIDE = ['quotation_marks', 'parentheses'];

/**
 * The cost of an activated group: the text before the first separator that is outside each
 * region that `activated.outside` names (spec sec. 4.2 `activated`). Face offsets, as atom
 * spans are. Null when the text has no such separator.
 */
export function activatedCost(
  stripped: { text: string; toFace: number[] }, t: TextTests = defaultTests(),
): { cost: string; faceStart: number; faceEnd: number } | null {
  const sep = activatedSeparator(t);
  const outside = patternStrings(t, 'activated', 'outside');
  const bad = outside.filter((o) => !OUTSIDE.includes(o));
  if (bad.length > 0) throw new Error(`text test activated: unknown region ${bad.join(', ')} (${OUTSIDE.join(', ')})`);
  const quotes = outside.includes('quotation_marks') ? patternPairs(t, 'activated', 'quotation_marks') : [];
  const [open, close] = outside.includes('parentheses') ? reminderDelimiters(t) : [null, null];
  let closeQuote: string | null = null;
  let paren = 0;
  const s = stripped.text;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (closeQuote !== null) { if (ch === closeQuote) closeQuote = null; continue; }
    const q = quotes.find((p) => p[0] === ch);
    if (q) { closeQuote = q[1]; continue; }
    if (ch === open) { paren++; continue; }
    if (ch === close && paren > 0) { paren--; continue; }
    if (paren === 0 && s.startsWith(sep, i)) {
      let end = i;
      while (end > 0 && /\s/.test(s[end - 1]!)) end--;
      if (end === 0) return null;
      return { cost: s.slice(0, end), faceStart: stripped.toFace[0]!, faceEnd: stripped.toFace[end - 1]! + 1 };
    }
  }
  return null;
}

/** True when the cost has the tap symbol (spec sec. 4.2 `tap_symbol`). */
export function hasTapSymbol(cost: string, t: TextTests = defaultTests()): boolean {
  return cost.includes(tapSymbol(t));
}

/**
 * The mana count of a text (spec sec. 4.2 `mana_symbols`): the tap symbol is removed first; a
 * number symbol counts as its value; a mana letter counts 1. A symbol with another letter, or
 * with the unknown mark, makes the count `unknown`.
 */
export function countManaSymbols(text: string, letters: readonly string[], t: TextTests = defaultTests()): number | 'unknown' {
  const s = symbolSyntax(t);
  let n = 0;
  for (const m of text.split(tapSymbol(t)).join('').matchAll(symbolRe(s))) {
    const body = m[1]!;
    if (body.includes(s.unknownIfContains)) return 'unknown';
    if (/^\d+$/.test(body)) n += Number(body);
    else if (letters.includes(body)) n += 1;
    else return 'unknown';
  }
  return n;
}

/** True when the text has the `turn_word` word. */
export function hasTurnWord(stripped: string, t: TextTests = defaultTests()): boolean {
  const p = testEntry(t, 'turn_word').pattern;
  return wordsRe([patternString(t, 'turn_word', 'word')], false, p['case_insensitive'] === true).test(stripped);
}

/** The atom type that the `timing_limit` test treats as a possible per-turn limit. */
export function timingLimitType(t: TextTests = defaultTests()): { family: string; type_key: string } {
  return { family: patternString(t, 'timing_limit', 'family'), type_key: patternString(t, 'timing_limit', 'type_key') };
}

const RESIDUE_STEPS = ['mana_symbols', 'tap_symbol', 'cost_atom_spans'];

/**
 * The removals of `cost_residue`, in file order: the named steps (brace symbols, the tap symbol,
 * the cost atom spans) and single characters. An unknown name stops the build.
 */
export function costResidueSteps(t: TextTests = defaultTests()): { symbols: boolean; tap: boolean; atomSpans: boolean; chars: string[] } {
  const remove = patternStrings(t, 'cost_residue', 'remove');
  const bad = remove.filter((r) => r.length > 1 && !RESIDUE_STEPS.includes(r));
  if (bad.length > 0) throw new Error(`text test cost_residue: unknown step ${bad.join(', ')} (${RESIDUE_STEPS.join(', ')} or one character)`);
  return {
    symbols: remove.includes('mana_symbols'), tap: remove.includes('tap_symbol'),
    atomSpans: remove.includes('cost_atom_spans'), chars: remove.filter((r) => r.length === 1),
  };
}
