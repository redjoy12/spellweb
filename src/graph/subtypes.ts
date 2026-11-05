import type { DatabaseSync } from 'node:sqlite';
import { normalizeTermKey } from '../rules/parse.js';
import { ruleWithSubrules } from './quotes.js';

/**
 * spec rev. 6 sec. 11.2 step 2: a sentence ends at a period that whitespace and a capital letter
 * follow, or at the end of the text. A colon does not end a sentence.
 */
export function splitSentences(text: string): string[] {
  return text.split(/(?<=\.)\s+(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
}

/**
 * spec rev. 6 sec. 11.2 steps 3-6, for one sentence. Null when it is not a list sentence.
 *
 * 3. A list sentence has the whole words "type is" or "types are". The word boundary before
 *    "type" is what stops "subtypes are" from matching.
 * 4. The list runs from those words to the end of the sentence, or from a colon in it.
 * 5. Split at ", " and at "and " (as a whole word, so a name that ends in "and" stays whole).
 *    Remove each "(see rule ...)" part.
 * 6. Each item must start with a capital letter, or the sentence is not a list sentence.
 */
export function parseListSentence(sentence: string): string[] | null {
  const m = /\b(?:type is|types are)\b/.exec(sentence);
  if (!m) return null;
  let list = sentence.slice(m.index + m[0].length);
  const colon = list.indexOf(':');
  if (colon >= 0) list = list.slice(colon + 1);
  list = list.replace(/\.\s*$/, '');
  const items = list.split(', ')
    .flatMap((part) => part.split(/\band /))
    .map((item) => item.replace(/\(see rule[^)]*\)/g, '').trim())
    .filter(Boolean);
  if (items.length === 0 || !items.every((i) => /^[A-Z]/.test(i))) return null;
  return items;
}

export interface ListSentence { rule: string; sentence: string; items: string[] }

/**
 * spec rev. 6 sec. 11.2 step 1: the term lookup "Subtype", then the rule it gives and all its
 * subrules. The lookup gives the reference; this code has no rule number.
 */
export function subtypeListSentences(db: DatabaseSync, corpusId: number): ListSentence[] {
  const hit = db.prepare(
    "SELECT rule_numbers FROM rule_term_index WHERE corpus_id = ? AND term_key = ? AND source = 'glossary'",
  ).get(corpusId, normalizeTermKey('Subtype')) as { rule_numbers: string } | undefined;
  if (!hit) throw new Error(`corpus ${corpusId}: the term lookup "Subtype" gives no glossary entry`);
  const out: ListSentence[] = [];
  for (const ref of JSON.parse(hit.rule_numbers) as string[]) {
    for (const row of ruleWithSubrules(db, corpusId, ref)) {
      for (const sentence of splitSentences(row.text)) {
        const items = parseListSentence(sentence);
        if (items) out.push({ rule: row.number, sentence, items });
      }
    }
  }
  return out;
}

/**
 * The CR subtype lists: rule number -> its subtypes, in CR order. One subtype can be in two
 * lists. Nobody corrects this result by hand (plan D15): a wrong result stops the task.
 */
export function crSubtypeLists(db: DatabaseSync, corpusId: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of subtypeListSentences(db, corpusId)) out.set(s.rule, [...(out.get(s.rule) ?? []), ...s.items]);
  return out;
}
