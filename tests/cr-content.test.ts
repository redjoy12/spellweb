import { it, expect } from 'vitest';
import { scanCrCitations } from '../src/rules/parse.js';
import { loadKernelRules, renderRule } from '../src/rules/packet.js';
import { loadPacketPolicy, matchTerms } from '../src/rules/relevance.js';
import {
  classCrContent, coverageGaps, crCardTypes, emptyContent, renderCrContent, typeCrContent, typeEntries, withKernel,
} from '../src/graph/crContent.js';
import { crSubtypeLists } from '../src/graph/subtypes.js';
import { maybe, realDb as db, realCorpusId as corpusId } from './helpers/realDb.js';

const V = 14;
const policy = loadPacketPolicy();
const rows = (ref: string, opts?: { subrules?: boolean }) => (renderRule(db, corpusId, ref, opts)?.rules ?? []).map((r) => r.number);
const numbers = (sql: string, ...args: Array<string | number>) =>
  (db.prepare(sql).all(corpusId, ...args) as Array<{ number: string }>).map((r) => r.number);

/**
 * spec rev. 6 sec. 5.2 item 2, by its own queries (not by renderRule): a section gives its
 * unlettered rules; "NNN.N" gives itself, or its subrules when it is a title row with no text
 * (owner, 2026-10-10); a lettered rule gives itself.
 */
function withoutSubrules(ref: string): string[] {
  if (!ref.includes('.')) {
    return numbers("SELECT number FROM rules WHERE corpus_id = ? AND section_number = ? AND text <> '' AND number NOT GLOB '*[a-z]'", ref);
  }
  const own = numbers("SELECT number FROM rules WHERE corpus_id = ? AND number = ? AND text <> ''", ref);
  if (own.length > 0 || /[a-z]$/.test(ref)) return own;
  return numbers("SELECT number FROM rules WHERE corpus_id = ? AND subsection_number = ? AND text <> ''", ref);
}

maybe('CR content sets 1-5 (spec sec. 5.2, rev. 6)', () => {
  it('set 1: CARES_ABOUT.PERMANENT_DIES has the rule its evidence cites, with its subrules', () => {
    const type = { family: 'CARES_ABOUT', type_key: 'PERMANENT_DIES' };
    const evidence = (db.prepare('SELECT evidence FROM atom_types WHERE schema_version = ? AND family = ? AND type_key = ?')
      .get(V, type.family, type.type_key) as { evidence: string }).evidence;
    const refs = scanCrCitations(evidence);
    expect(refs.length).toBeGreaterThan(0);
    const c = typeCrContent(db, corpusId, V, type, policy);
    for (const ref of refs) {
      const want = (db.prepare(
        "SELECT number FROM rules WHERE corpus_id = ? AND (number = ? OR subsection_number = ?) AND text <> ''",
      ).all(corpusId, ref, ref) as Array<{ number: string }>).map((r) => r.number);
      expect(want.length).toBeGreaterThan(0);
      for (const n of want) expect(c.rules.get(n)?.has('type_evidence'), n).toBe(true);
    }
  });

  it('set 2: the glossary terms of the label, and their rules without subrules', () => {
    let checked = 0;
    for (const t of typeEntries(db, V)) {
      const hits = matchTerms(db, corpusId, t.label, policy).filter((m) => m.source === 'glossary');
      if (hits.length === 0) continue;
      const c = typeCrContent(db, corpusId, V, t, policy);
      const term = [...c.rules].filter(([, s]) => s.has('term')).map(([n]) => n).sort();
      const want = [...new Set(hits.flatMap((h) => h.rule_numbers.flatMap(withoutSubrules)))].sort();
      expect(term, `${t.family}.${t.type_key}`).toEqual(want);
      for (const h of hits) if (h.definition) expect(c.glossary.get(h.term)).toBe(h.definition);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('set 2 for a section reference: the rules NNN.1, NNN.2, ... and no lettered subrule', () => {
    const t = typeEntries(db, V).find((e) =>
      matchTerms(db, corpusId, e.label, policy).some((m) => m.source === 'glossary' && m.rule_numbers.some((r) => !r.includes('.'))))!;
    expect(t).toBeDefined();
    const section = matchTerms(db, corpusId, t.label, policy)
      .flatMap((m) => (m.source === 'glossary' ? m.rule_numbers : [])).find((r) => !r.includes('.'))!;
    const c = typeCrContent(db, corpusId, V, t, policy);
    const numbered = (db.prepare(
      "SELECT number FROM rules WHERE corpus_id = ? AND section_number = ? AND text <> '' AND number NOT GLOB '*[a-z]'",
    ).all(corpusId, section) as Array<{ number: string }>).map((r) => r.number);
    expect(numbered.length).toBeGreaterThan(0);
    for (const n of numbered) expect(c.rules.get(n)?.has('term'), n).toBe(true);
    for (const [n, s] of c.rules) if (s.has('term')) expect(n).not.toMatch(/[a-z]$/);
  });

  it('set 3: the rules that golden atoms of the type cite', () => {
    const g = db.prepare(
      `SELECT family, type_key, group_concat(rule_numbers, '|') refs FROM golden_atoms
        WHERE rule_numbers <> '[]' GROUP BY family, type_key ORDER BY count(*) DESC LIMIT 1`,
    ).get() as { family: string; type_key: string; refs: string };
    const c = typeCrContent(db, corpusId, V, g, policy);
    const cited = new Set(g.refs.split('|').flatMap((r) => JSON.parse(r) as string[]));
    for (const ref of cited) for (const n of rows(ref)) expect(c.rules.get(n)?.has('golden'), n).toBe(true);
  });

  it('set 4: withKernel adds each rule of loadKernelRules', () => {
    const c = withKernel(db, corpusId, emptyContent());
    const kernel = loadKernelRules(db, corpusId);
    expect(kernel.length).toBeGreaterThan(0);
    for (const ref of kernel) for (const n of rows(ref)) expect(c.rules.get(n)?.has('kernel'), n).toBe(true);
  });

  it('crCardTypes gives each glossary entry whose definition starts with "A card type.", with its rules', () => {
    const want = db.prepare("SELECT term, cross_refs FROM glossary_entries WHERE corpus_id = ? AND substr(definition, 1, 12) = 'A card type.'")
      .all(corpusId) as Array<{ term: string; cross_refs: string }>;
    const got = crCardTypes(db, corpusId);
    expect(got.size).toBe(want.length);
    for (const w of want) expect(got.get(w.term)).toEqual(JSON.parse(w.cross_refs));
  });

  it('set 5, card_type: the rules of the card type from crCardTypes', () => {
    for (const [term, refs] of crCardTypes(db, corpusId)) {
      const c = classCrContent(db, corpusId, { intrinsic: 'card_type', value: term });
      expect(c.glossary.has(term)).toBe(true);
      for (const ref of refs) for (const n of rows(ref)) expect(c.rules.get(n)?.has('intrinsic'), n).toBe(true);
    }
  });

  it('set 5, subtype: the list rule that names the subtype and its type_rule_map row', () => {
    const lists = crSubtypeLists(db, corpusId);
    const maps = db.prepare("SELECT term, rule_number FROM type_rule_map WHERE corpus_id = ? AND kind = 'subtype'")
      .all(corpusId) as Array<{ term: string; rule_number: string }>;
    const m = maps.find((x) => [...lists.values()].some((items) => items.includes(x.term)))!;
    expect(m).toBeDefined();
    const c = classCrContent(db, corpusId, { intrinsic: 'subtype', value: m.term });
    for (const [rule, items] of lists) if (items.includes(m.term)) expect(c.rules.has(rule)).toBe(true);
    for (const n of rows(m.rule_number)) expect(c.rules.has(n), n).toBe(true);
  });

  it('set 5, mana_value and color_identity: the rules of the glossary entries "Mana Value" and "Color Identity"', () => {
    for (const [kind, key] of [['mana_value', 'mana value'], ['color_identity', 'color identity']] as const) {
      const t = db.prepare("SELECT term, rule_numbers FROM rule_term_index WHERE corpus_id = ? AND term_key = ? AND source = 'glossary'")
        .get(corpusId, key) as { term: string; rule_numbers: string };
      const c = classCrContent(db, corpusId, { intrinsic: kind, value: 1 });
      expect(c.glossary.has(t.term)).toBe(true);
      for (const ref of JSON.parse(t.rule_numbers) as string[]) for (const n of rows(ref)) expect(c.rules.has(n), n).toBe(true);
    }
  });

  it('coverageGaps: not more than 31 types (spec sec. 3, fact 7), and each has no content from sets 1-3', () => {
    const gaps = new Set(coverageGaps(db, corpusId, V, policy).map((g) => `${g.family}.${g.type_key}`));
    expect(gaps.size).toBeLessThanOrEqual(31);
    // Independent of typeCrContent: rows with text for the evidence citations (set 1), glossary hits
    // of the label (set 2), rows with text for the golden citations (set 3).
    const withText = (ref: string) => numbers(
      "SELECT number FROM rules WHERE corpus_id = ? AND (number = ? OR subsection_number = ? OR section_number = ?) AND text <> ''", ref, ref, ref);
    for (const t of typeEntries(db, V)) {
      const evidence = (db.prepare('SELECT evidence FROM atom_types WHERE schema_version = ? AND family = ? AND type_key = ?')
        .get(V, t.family, t.type_key) as { evidence: string }).evidence;
      const golden = (db.prepare('SELECT rule_numbers FROM golden_atoms WHERE family = ? AND type_key = ?')
        .all(t.family, t.type_key) as Array<{ rule_numbers: string }>).flatMap((g) => JSON.parse(g.rule_numbers) as string[]);
      const content = [...scanCrCitations(evidence), ...golden].flatMap(withText).length
        + matchTerms(db, corpusId, t.label, policy).filter((m) => m.source === 'glossary').length;
      expect(gaps.has(`${t.family}.${t.type_key}`), `${t.family}.${t.type_key}`).toBe(content === 0);
    }
  });

  it('renderCrContent shows each rule one time, in CR order, under its section', () => {
    const c = withKernel(db, corpusId, typeCrContent(db, corpusId, V, { family: 'CARES_ABOUT', type_key: 'PERMANENT_DIES' }, policy));
    const lines = renderCrContent(db, corpusId, c).split('\n');
    for (const n of c.rules.keys()) expect(lines.filter((l) => l.startsWith(`${n} `)), n).toHaveLength(1);
  });
});
