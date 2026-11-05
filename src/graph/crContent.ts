import type { DatabaseSync } from 'node:sqlite';
import { normalizeTermKey, scanCrCitations } from '../rules/parse.js';
import { loadKernelRules, renderRule } from '../rules/packet.js';
import { matchTerms, type PacketPolicy } from '../rules/relevance.js';
import { glossaryRef } from './quotes.js';
import { crSubtypeLists } from './subtypes.js';

/** Why a rule is in a packet (spec sec. 5.2): sets 1, 2, 3, 4 and 5 in that order. */
export type CrSource = 'type_evidence' | 'term' | 'golden' | 'kernel' | 'intrinsic';

/**
 * The CR content of a packet part. `rules` is keyed by the exact number of each rule row that
 * the content shows (rows with text only), so the keys are the packet references of plan D16.
 */
export interface CrContent {
  rules: Map<string, Set<CrSource>>;
  glossary: Map<string, string>;                                 // term -> definition
}

export interface TypeEntry { family: string; type_key: string; label: string; params_schema: unknown; evidence_ref: string[] }

export function emptyContent(): CrContent {
  return { rules: new Map(), glossary: new Map() };
}

export function mergeContent(...parts: CrContent[]): CrContent {
  const out = emptyContent();
  for (const p of parts) {
    for (const [n, sources] of p.rules) out.rules.set(n, new Set([...(out.rules.get(n) ?? []), ...sources]));
    for (const [t, d] of p.glossary) out.glossary.set(t, d);
  }
  return out;
}

function addRule(
  db: DatabaseSync, corpusId: number, c: CrContent, ref: string, source: CrSource, opts?: { subrules?: boolean },
): void {
  const block = renderRule(db, corpusId, ref, opts);
  for (const r of block?.rules ?? []) {
    const set = c.rules.get(r.number) ?? new Set<CrSource>();
    set.add(source);
    c.rules.set(r.number, set);
  }
}

/** The compact type entries of a schema version, ordered by family and type key (spec sec. 5.2). */
export function typeEntries(db: DatabaseSync, schemaVersion: number): TypeEntry[] {
  const rows = db.prepare(
    'SELECT family, type_key, label, params_schema, evidence FROM atom_types WHERE schema_version = ? ORDER BY family, type_key',
  ).all(schemaVersion) as Array<{ family: string; type_key: string; label: string; params_schema: string; evidence: string }>;
  return rows.map((r) => ({
    family: r.family, type_key: r.type_key, label: r.label,
    params_schema: JSON.parse(r.params_schema) as unknown,
    evidence_ref: scanCrCitations(r.evidence),
  }));
}

/**
 * spec sec. 5.2, sets 1-3 for one type:
 * 1. the rules its evidence cites, with all their subrules;
 * 2. the glossary entries that the Phase 2 term matcher finds in its label, and the rules that
 *    each entry cross-references, without subrules;
 * 3. the rules that golden atoms of the type cite.
 */
export function typeCrContent(
  db: DatabaseSync, corpusId: number, schemaVersion: number,
  type: { family: string; type_key: string }, policy: PacketPolicy,
): CrContent {
  const row = db.prepare('SELECT label, evidence FROM atom_types WHERE schema_version = ? AND family = ? AND type_key = ?')
    .get(schemaVersion, type.family, type.type_key) as { label: string; evidence: string } | undefined;
  if (!row) throw new Error(`schema v${schemaVersion} has no type ${type.family}.${type.type_key}`);
  const c = emptyContent();

  for (const ref of scanCrCitations(row.evidence)) addRule(db, corpusId, c, ref, 'type_evidence');

  for (const m of matchTerms(db, corpusId, row.label, policy)) {
    if (m.source !== 'glossary') continue;
    if (m.definition) c.glossary.set(m.term, m.definition);
    for (const ref of m.rule_numbers) addRule(db, corpusId, c, ref, 'term', { subrules: false });
  }

  const golden = db.prepare('SELECT rule_numbers FROM golden_atoms WHERE family = ? AND type_key = ?')
    .all(type.family, type.type_key) as Array<{ rule_numbers: string }>;
  for (const ref of new Set(golden.flatMap((g) => JSON.parse(g.rule_numbers) as string[]))) {
    addRule(db, corpusId, c, ref, 'golden');
  }
  return c;
}

/** spec sec. 5.2 set 4: the Phase 2 kernel, added to `c`. */
export function withKernel(db: DatabaseSync, corpusId: number, c: CrContent): CrContent {
  const k = emptyContent();
  for (const ref of loadKernelRules(db, corpusId)) addRule(db, corpusId, k, ref, 'kernel');
  return mergeContent(c, k);
}

/**
 * spec rev. 6 sec. 5.2 item 5: the card types are the glossary entries whose definition starts
 * with "A card type." (basis `project_decision`). Term -> the rules that the entry cross-references.
 */
export function crCardTypes(db: DatabaseSync, corpusId: number): Map<string, string[]> {
  const rows = db.prepare(
    "SELECT term, cross_refs FROM glossary_entries WHERE corpus_id = ? AND substr(definition, 1, 12) = 'A card type.' ORDER BY term",
  ).all(corpusId) as Array<{ term: string; cross_refs: string }>;
  return new Map(rows.map((r) => [r.term, JSON.parse(r.cross_refs) as string[]]));
}

function glossaryDefinition(db: DatabaseSync, corpusId: number, term: string): { term: string; definition: string } {
  const row = db.prepare('SELECT term, definition FROM glossary_entries WHERE corpus_id = ? AND term_key = ?')
    .get(corpusId, normalizeTermKey(term)) as { term: string; definition: string } | undefined;
  if (!row) throw new Error(`corpus ${corpusId} has no glossary entry "${term}"`);
  return row;
}

/** A term lookup in `rule_term_index` (glossary source): the entry and the rules it gives. */
function lookupTerm(db: DatabaseSync, corpusId: number, term: string): { term: string; definition: string; rules: string[] } {
  const row = db.prepare(
    "SELECT term, definition, rule_numbers FROM rule_term_index WHERE corpus_id = ? AND term_key = ? AND source = 'glossary'",
  ).get(corpusId, normalizeTermKey(term)) as { term: string; definition: string; rule_numbers: string } | undefined;
  if (!row) throw new Error(`corpus ${corpusId}: the term lookup "${term}" gives nothing`);
  return { term: row.term, definition: row.definition, rules: JSON.parse(row.rule_numbers) as string[] };
}

/** The glossary terms of the two characteristic kinds (spec rev. 6 sec. 5.2 item 5). */
const CHARACTERISTIC_TERMS = { mana_value: 'Mana Value', color_identity: 'Color Identity' } as const;

/**
 * spec rev. 6 sec. 5.2 item 5 (set 5) for one intrinsic class:
 * - `card_type`: the glossary entry of the card type and its rules (`crCardTypes`);
 * - `subtype`: each list rule that names the subtype (`crSubtypeLists`) and its `subtype` row
 *   of `type_rule_map`;
 * - `mana_value`, `color_identity`: the glossary entry and its rules, by term lookup.
 */
export function classCrContent(
  db: DatabaseSync, corpusId: number, cls: { intrinsic: string; value: string | number },
): CrContent {
  const c = emptyContent();
  const value = String(cls.value);
  switch (cls.intrinsic) {
    case 'card_type': {
      const hit = [...crCardTypes(db, corpusId)].find(([term]) => term.toLowerCase() === value.toLowerCase());
      if (!hit) throw new Error(`"${value}" is not a glossary card type`);
      const entry = glossaryDefinition(db, corpusId, hit[0]);
      c.glossary.set(entry.term, entry.definition);
      for (const ref of hit[1]) addRule(db, corpusId, c, ref, 'intrinsic');
      break;
    }
    case 'subtype': {
      // Without case, as `isClassMember` and the type_rule_map lookup below compare.
      for (const [rule, items] of crSubtypeLists(db, corpusId)) {
        if (items.some((i) => i.toLowerCase() === value.toLowerCase())) addRule(db, corpusId, c, rule, 'intrinsic');
      }
      const map = db.prepare(
        "SELECT rule_number FROM type_rule_map WHERE corpus_id = ? AND kind = 'subtype' AND term_key = ?",
      ).get(corpusId, normalizeTermKey(value)) as { rule_number: string } | undefined;
      if (map) addRule(db, corpusId, c, map.rule_number, 'intrinsic');
      break;
    }
    case 'mana_value':
    case 'color_identity': {
      const t = lookupTerm(db, corpusId, CHARACTERISTIC_TERMS[cls.intrinsic]);
      c.glossary.set(t.term, t.definition);
      for (const ref of t.rules) addRule(db, corpusId, c, ref, 'intrinsic');
      break;
    }
    default:
      throw new Error(`unknown intrinsic kind "${cls.intrinsic}"`);
  }
  return c;
}

/**
 * Set 5 as one Stage B packet carries it (spec rev. 6 sec. 5.3): all card types, all subtype
 * list rules and `subtype` rows of `type_rule_map`, and the two characteristic entries.
 */
export function set5CrContent(db: DatabaseSync, corpusId: number): CrContent {
  const c = emptyContent();
  for (const [term, refs] of crCardTypes(db, corpusId)) {
    c.glossary.set(term, glossaryDefinition(db, corpusId, term).definition);
    for (const ref of refs) addRule(db, corpusId, c, ref, 'intrinsic');
  }
  for (const rule of crSubtypeLists(db, corpusId).keys()) addRule(db, corpusId, c, rule, 'intrinsic');
  const maps = db.prepare("SELECT rule_number FROM type_rule_map WHERE corpus_id = ? AND kind = 'subtype' ORDER BY term_key")
    .all(corpusId) as Array<{ rule_number: string }>;
  for (const m of maps) addRule(db, corpusId, c, m.rule_number, 'intrinsic');
  for (const term of Object.values(CHARACTERISTIC_TERMS)) {
    const t = lookupTerm(db, corpusId, term);
    c.glossary.set(t.term, t.definition);
    for (const ref of t.rules) addRule(db, corpusId, c, ref, 'intrinsic');
  }
  return c;
}

/**
 * spec sec. 5.2: a type with no CR content from sets 1 to 3 is a coverage gap. It blocks the
 * stage that needs the type. The fix is golden cards, never CR text by hand.
 */
export function coverageGaps(
  db: DatabaseSync, corpusId: number, schemaVersion: number, policy: PacketPolicy,
): Array<{ family: string; type_key: string }> {
  return typeEntries(db, schemaVersion)
    .filter((t) => isCoverageGap(typeCrContent(db, corpusId, schemaVersion, t, policy)))
    .map((t) => ({ family: t.family, type_key: t.type_key }));
}

/** True when the sets 1-3 content of a type is empty: no rule row and no glossary entry. */
export function isCoverageGap(c: CrContent): boolean {
  return c.rules.size === 0 && c.glossary.size === 0;
}

// ---- rendering -------------------------------------------------------------------------------

/** Every rule row with text of a corpus, and the section titles - read once, rendered many times. */
export interface RowStore {
  rows: Map<string, { text: string; section: string; ordinal: number }>;
  titles: Map<string, string>;
}

export function loadRowStore(db: DatabaseSync, corpusId: number): RowStore {
  const rows = db.prepare("SELECT number, text, section_number, ordinal FROM rules WHERE corpus_id = ? AND text <> ''")
    .all(corpusId) as Array<{ number: string; text: string; section_number: string; ordinal: number }>;
  const titles = db.prepare('SELECT number, title FROM rule_sections WHERE corpus_id = ?')
    .all(corpusId) as Array<{ number: string; title: string }>;
  return {
    rows: new Map(rows.map((r) => [r.number, { text: r.text, section: r.section_number, ordinal: r.ordinal }])),
    titles: new Map(titles.map((t) => [t.number, t.title])),
  };
}

/**
 * The CR content as packet text: the glossary entries, then the rules in CR order under their
 * section headings. Each run of rules with the same label gets one "[for: ...]" line, so each
 * rule shows what needs it. `labelOf` returns '' for no label.
 */
export function renderContent(
  store: RowStore, c: CrContent,
  labelOf: (rule: string) => string, glossaryLabelOf: (term: string) => string,
): string {
  const out: string[] = [];
  if (c.glossary.size > 0) {
    out.push('## Glossary');
    for (const term of [...c.glossary.keys()].sort()) {
      const label = glossaryLabelOf(term);
      out.push(`${term}: ${c.glossary.get(term)!}${label ? ` [for: ${label}]` : ''}`);
    }
  }
  const rules = [...c.rules.keys()]
    .map((n) => ({ n, row: store.rows.get(n) }))
    .filter((r): r is { n: string; row: NonNullable<typeof r.row> } => r.row !== undefined)
    .sort((a, b) => a.row.ordinal - b.row.ordinal);
  let section: string | null = null;
  let label: string | null = null;
  for (const { n, row } of rules) {
    if (row.section !== section) {
      section = row.section;
      label = null;
      out.push(`## ${section} ${store.titles.get(section) ?? ''}`.trimEnd());
    }
    const l = labelOf(n);
    if (l !== label) {
      label = l;
      if (l) out.push(`[for: ${l}]`);
    }
    out.push(`${n} ${row.text}`);
  }
  return out.join('\n');
}

/** The rules and glossary terms a rendering shows, as plan D16 packet references. */
export function contentRefs(store: RowStore, c: CrContent): string[] {
  return [
    ...[...c.rules.keys()].filter((n) => store.rows.has(n)).sort(),
    ...[...c.glossary.keys()].sort().map(glossaryRef),
  ];
}

/** `renderContent` labelled by CR source (sets 1-5). */
export function renderCrContent(db: DatabaseSync, corpusId: number, c: CrContent): string {
  return renderContent(loadRowStore(db, corpusId), c, (n) => [...(c.rules.get(n) ?? [])].sort().join(', '), () => '');
}
