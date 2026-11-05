import { normalizeTermKey, type ParsedCorpus } from './parse.js';

export interface TypeMapping {
  term: string;
  term_key: string;
  kind: 'subtype' | 'card_form';
  rule_number: string;
  resolution: 'subtype_crossref' | 'section_title';
  evidence: string;
}

/**
 * `Attraction (see rule 717)` / `Equipment (see rule 301.5)` as written in 205.3's
 * subtype enumerations. The name may be one or two capitalised words.
 */
const RE_SUBTYPE_REF =
  /([A-Z][A-Za-z'-]*(?:\s[A-Z][A-Za-z]*)?)\s*\(see rule (\d{3}(?:\.\d+[a-z]?)?)\)/g;

/**
 * `714. Saga Cards` -> term "Saga".
 *
 * The trailing "s" is REQUIRED, not optional. Every card-form section is titled with
 * a plural ("Split Cards", "Preparation Cards"), while `121. Drawing a Card` is a
 * singular verb phrase - an optional `s` here silently invents a card form called
 * "Drawing a" mapped to rule 121. Narrowing the pattern is the fix; filtering on
 * "sections under top-level 7" would work too but would author a rule number.
 */
const RE_FORM_TITLE = /^(.+?) Cards$/;

/**
 * Derives subtype -> rule and card-form -> rule entirely by parsing (I2, sec. 5.3's
 * "subtype-specific rules implied by the type line").
 *
 * Two independent sources, neither of them a number anyone typed:
 *   - `subtype_crossref`: the parentheticals inside rules 205.3a-205.3q, which are
 *     how the CR itself points a subtype at its rules. These give finer targets than
 *     a whole section - Equipment resolves to 301.5, not 301.
 *   - `section_title`: every section titled "<X> Cards", which is how the CR names
 *     the rules for a card *form* (Scryfall's `layout`).
 *
 * A subtype with neither - Siege, Room - correctly produces no entry. "No rules
 * section exists" is an answer, not a gap to paper over.
 */
export function buildTypeRuleMap(corpus: ParsedCorpus): TypeMapping[] {
  const out: TypeMapping[] = [];
  const seen = new Set<string>();

  const push = (m: TypeMapping) => {
    const dedupe = `${m.kind}:${m.term_key}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push(m);
  };

  const validSubsections = new Set(
    corpus.rules.map((r) => r.subsection_number).filter((n): n is string => n !== null),
  );
  const validSections = new Set(corpus.sections.map((s) => s.number));
  const exists = (n: string) => validSections.has(n) || validSubsections.has(n);

  for (const rule of corpus.rules) {
    if (!/^205\.3[a-z]?$/.test(rule.number)) continue;   // i2-ok: filters the corpus by its own numbering, selects no content
    for (const [, term, ruleNumber] of rule.text.matchAll(RE_SUBTYPE_REF)) {
      if (!exists(ruleNumber!)) continue;
      push({
        term: term!,
        term_key: normalizeTermKey(term!),
        kind: 'subtype',
        rule_number: ruleNumber!,
        resolution: 'subtype_crossref',
        evidence: `${rule.number} - ${term} (see rule ${ruleNumber})`,
      });
    }
  }

  for (const section of corpus.sections) {
    const m = RE_FORM_TITLE.exec(section.title);
    if (!m) continue;
    push({
      term: m[1]!,
      term_key: normalizeTermKey(m[1]!),
      kind: 'card_form',
      rule_number: section.number,
      resolution: 'section_title',
      evidence: `${section.number}. ${section.title}`,
    });
  }

  out.sort((a, b) =>
    a.kind === b.kind
      ? a.term_key < b.term_key ? -1 : a.term_key > b.term_key ? 1 : 0
      : a.kind < b.kind ? -1 : 1,
  );
  return out;
}
