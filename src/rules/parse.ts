export interface ParsedSection {
  number: string;
  parent_number: string | null;
  title: string;
  ordinal: number;
}

export interface ParsedRule {
  number: string;
  section_number: string;
  subsection_number: string | null;
  subsection_title: string | null;
  text: string;
  ordinal: number;
}

export interface ParsedGlossary {
  term: string;
  term_key: string;
  definition: string;
  cross_refs: string[];
}

export interface ParsedCorpus {
  effective_date: string;
  sections: ParsedSection[];
  rules: ParsedRule[];
  glossary: ParsedGlossary[];
}

const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

/** Curly quotes and dashes appear throughout the CR; normalise so keys compare cleanly. */
export function normalizePunctuation(s: string): string {
  return s
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00a0/g, ' ');
}

export function normalizeTermKey(s: string): string {
  return normalizePunctuation(s).trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Every "see rule NNN[.M[a]]" reference in arbitrary text, deduplicated in order of first appearance. */
export function scanCrossRefs(text: string): string[] {
  return [...new Set([...text.matchAll(RE_CROSSREF)].map((m) => m[1]!))];
}

/**
 * Every "CR NNN[.N[a]]" citation in a text, deduplicated in order of first appearance - the
 * form `atom_types.evidence` uses (Phase 3 plan D3). `scanCrossRefs` reads only "see rule NNN".
 */
export function scanCrCitations(text: string): string[] {
  return [...new Set([...text.matchAll(RE_CR_CITATION)].map((m) => m[1]!))];
}

const RE_TOP        = /^(\d)\. ([A-Z].*)$/;
const RE_SECTION    = /^(\d{3})\. ([A-Z].*)$/;
const RE_RULE       = /^(\d{3}\.\d+[a-z]?)\.? (.+)$/;
const RE_SUBSECTION = /^(\d{3})\.(\d+)\.\s+(.+)$/;
const RE_CROSSREF   = /see rule (\d{3}(?:\.\d+[a-z]?)?)/gi;
const RE_CR_CITATION = /\bCR (\d{3}(?:\.\d+[a-z]?)?)/g;

/**
 * Finds the index where the body begins. The CR opens with a table of contents
 * that repeats every heading verbatim; the body starts at the *second* occurrence
 * of the "1. Game Concepts" line.
 */
function findBodyStart(lines: string[]): number {
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^1\. Game Concepts\s*$/.test(lines[i]!)) hits.push(i);
  }
  if (hits.length === 0) throw new Error('Comprehensive Rules: no "1. Game Concepts" heading found');
  return hits.length > 1 ? hits[1]! : hits[0]!;
}

/** Index of the body Glossary heading - the second bare "Glossary" line. */
function findMarker(lines: string[], marker: string): number {
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i]!.trim() === marker) hits.push(i);
  if (hits.length === 0) throw new Error(`Comprehensive Rules: no "${marker}" marker found`);
  return hits.length > 1 ? hits[1]! : hits[0]!;
}

function parseEffectiveDate(text: string): string {
  const m = /effective as of ([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(text);
  if (!m) throw new Error('Comprehensive Rules: effective date not found');
  const month = MONTHS[m[1]!.toLowerCase()];
  if (!month) throw new Error(`Comprehensive Rules: unrecognised month "${m[1]}"`);
  return `${m[3]}-${month}-${String(m[2]).padStart(2, '0')}`;
}

export function parseComprehensiveRules(raw: string): ParsedCorpus {
  // Stored rule.text and glossary strings are punctuation-normalized (em dashes
  // -> hyphens, curly quotes -> straight), NOT verbatim CR text. Task 7/8 consumers
  // match against the normalized form.
  const text = normalizePunctuation(raw.replace(/^\uFEFF/, ''));
  // U+2028/U+2029 are line breaks too: CR 20260925 uses U+2028 where earlier
  // revisions had a newline, and RE_RULE's `.` does not match it.
  const lines = text.split(/\r?\n|[\u2028\u2029]/);

  const bodyStart = findBodyStart(lines);
  const glossaryStart = findMarker(lines, 'Glossary');
  const glossaryEnd = findMarker(lines, 'Credits');

  const sections: ParsedSection[] = [];
  const rules: ParsedRule[] = [];
  const seenSections = new Set<string>();

  let currentTop: string | null = null;
  let currentSection: string | null = null;
  let currentSubsection: string | null = null;
  let currentSubsectionTitle: string | null = null;
  let ordinal = 0;

  for (let i = bodyStart; i < glossaryStart; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    const top = RE_TOP.exec(line);
    if (top && !RE_RULE.test(line)) {
      currentTop = top[1]!;
      currentSection = null;
      currentSubsection = null;
      currentSubsectionTitle = null;
      if (!seenSections.has(currentTop)) {
        seenSections.add(currentTop);
        sections.push({ number: currentTop, parent_number: null, title: top[2]!.trim(), ordinal: ordinal++ });
      }
      continue;
    }

    const sec = RE_SECTION.exec(line);
    if (sec) {
      currentSection = sec[1]!;
      currentSubsection = null;
      currentSubsectionTitle = null;
      if (!seenSections.has(currentSection)) {
        seenSections.add(currentSection);
        sections.push({
          number: currentSection,
          parent_number: currentTop ?? currentSection[0]!,
          title: sec[2]!.trim(),
          ordinal: ordinal++,
        });
      }
      continue;
    }

    const rule = RE_RULE.exec(line);
    if (!rule) continue;

    const number = rule[1]!;
    const body = rule[2]!.trim();
    const section = number.slice(0, 3);

    // A titled subsection heading is "702.2. Deathtouch" - a short title with no
    // sentence punctuation. It names the following rules rather than being one.
    const sub = RE_SUBSECTION.exec(line);
    // The opener test must not be "starts with a capital letter": rule 702.186 is
    // titled "\u221e (Infinity)" and would be silently demoted to an ordinary rule,
    // losing the subsection from the title index. Accept any non-lowercase opener.
    // Invariant this heuristic relies on: every titled NNN.N. subsection in the CR
    // is immediately followed by an NNN.Na subrule (empirically 261/261), so the
    // short-title/no-sentence-punctuation structural test is safe today.
    const isTitleHeading =
      sub !== null &&
      !/[.:;]$/.test(body) &&
      body.split(/\s+/).length <= 6 &&
      /^[\p{Lu}\p{S}\p{N}]/u.test(body);

    if (isTitleHeading) {
      currentSubsection = `${sub![1]}.${sub![2]}`;
      currentSubsectionTitle = body;
      rules.push({
        number,
        section_number: section,
        subsection_number: currentSubsection,
        subsection_title: currentSubsectionTitle,
        text: '',
        ordinal: ordinal++,
      });
      continue;
    }

    const numericSub = /^(\d{3}\.\d+)/.exec(number)?.[1] ?? null;

    // Title attachment is the push's strict-equality guard below: a rule carries
    // the current title only while its numericSub === currentSubsection. A
    // non-titled numeric sub (e.g. 702.3 after titled 702.2) simply fails that
    // equality and gets subsection_title: null. No separate scope-end reset is
    // needed; an earlier startsWith-based reset here was dead code (the push guard
    // always had the final say) and would have been wrong on prefix collisions
    // like 702.2 -> 702.20, so it was removed rather than fixed.
    rules.push({
      number,
      section_number: section,
      subsection_number: numericSub,
      subsection_title: numericSub === currentSubsection ? currentSubsectionTitle : null,
      text: body,
      ordinal: ordinal++,
    });
  }

  // Glossary: blank-line-delimited blocks of "Term" followed by definition lines.
  const glossary: ParsedGlossary[] = [];
  let block: string[] = [];
  const flush = () => {
    if (block.length >= 2) {
      const term = block[0]!.trim();
      const definition = block.slice(1).join(' ').trim();
      const refs = [...definition.matchAll(RE_CROSSREF)].map((m) => m[1]!);
      glossary.push({
        term,
        term_key: normalizeTermKey(term),
        definition,
        cross_refs: [...new Set(refs)],
      });
    }
    block = [];
  };
  for (let i = glossaryStart + 1; i < glossaryEnd; i++) {
    const line = lines[i]!;
    if (line.trim() === '') flush();
    else block.push(line.trim());
  }
  flush();

  return {
    effective_date: parseEffectiveDate(text),
    sections,
    rules,
    glossary,
  };
}
