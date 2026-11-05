import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeTermKey } from './parse.js';
import {
  cardMatchText, loadPacketPolicy, reachableRules,
  type CardMatchInput, type MatchedTerm, type PacketPolicy,
} from './relevance.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = resolve(here, '../../config/core-packet.json');

export interface CorePacketConfig {
  layout_aliases: Record<string, string>;
}

export interface PacketSection {
  number: string;
  title: string;
  rules: Array<{ number: string; text: string }>;
  chars: number;
}

export interface RulesPacket {
  corpusId: number;
  effectiveDate: string;
  /** The packet kernel (sec. 3.4), rendered - constant for every card. Phase 1 called
   *  this the core packet and chose it by hand; it is now derived into `packet_kernel`. */
  core: PacketSection[];
  cardSpecific: PacketSection[];
  /** Keywords with no rule section, excluding ability words (which correctly have none). */
  unresolvedKeywords: string[];
  /** Scryfall layouts with no alias, or an alias naming no section. */
  unmappedLayouts: string[];
  /** Kernel rows or derived-map rule numbers that render nothing in this corpus - a stale
   *  kernel or a map bug, surfaced not swallowed. */
  missingRules: string[];
  /** Card-specific candidates dropped because the kernel already contains them. */
  suppressedAsCore: string[];
  /** Characters in `core`, i.e. the kernel. */
  coreChars: number;
  cardChars: number;
}

let configCache: CorePacketConfig | null = null;

export function loadCorePacketConfig(path: string = DEFAULT_CONFIG): CorePacketConfig {
  if (configCache && path === DEFAULT_CONFIG) return configCache;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const cfg: CorePacketConfig = {
    layout_aliases: raw['layout_aliases'] as Record<string, string>,
  };
  if (path === DEFAULT_CONFIG) configCache = cfg;
  return cfg;
}

/** Clears the cached config. Useful in watch mode and in tests that inject a config. */
export function resetConfigCache(): void {
  configCache = null;
}

interface CorpusRow { id: number; effective_date: string }

function currentCorpus(db: DatabaseSync): CorpusRow {
  const row = db
    .prepare('SELECT id, effective_date FROM rules_corpus WHERE is_current = 1 LIMIT 1')
    .get() as CorpusRow | undefined;
  if (!row) throw new Error('No current rules corpus - run `npm run sync:rules` first');
  return row;
}

function corpusById(db: DatabaseSync, corpusId: number): CorpusRow {
  const row = db
    .prepare('SELECT id, effective_date FROM rules_corpus WHERE id = ?')
    .get(corpusId) as CorpusRow | undefined;
  if (!row) throw new Error(`No rules corpus with id ${corpusId}`);
  return row;
}

/**
 * All rules under a top-level ("7") or three-digit ("701") section number. `unlettered` keeps
 * only the "NNN.N" rules - the section's numbered rules without their lettered subrules.
 */
function sectionBlock(db: DatabaseSync, corpusId: number, number: string, unlettered = false): PacketSection | null {
  const isTop = number.length === 1;

  const title = db
    .prepare('SELECT title FROM rule_sections WHERE corpus_id = ? AND number = ?')
    .get(corpusId, number) as { title: string } | undefined;
  if (!title) return null;

  const rows = (
    isTop
      ? db.prepare(
          `SELECT r.number, r.text FROM rules r
             JOIN rule_sections s ON s.corpus_id = r.corpus_id AND s.number = r.section_number
           WHERE r.corpus_id = ? AND s.parent_number = ?
           ORDER BY r.ordinal`,
        ).all(corpusId, number)
      : db.prepare(
          'SELECT number, text FROM rules WHERE corpus_id = ? AND section_number = ? ORDER BY ordinal',
        ).all(corpusId, number)
  ) as Array<{ number: string; text: string }>;

  const rules = rows.filter((r) => r.text !== '' && !(unlettered && /[a-z]$/.test(r.number)));
  return {
    number,
    title: title.title,
    rules,
    chars: rules.reduce((n, r) => n + r.number.length + r.text.length + 2, 0),
  };
}

/** The rules under one titled subsection, e.g. 702.2 Deathtouch. */
function subsectionBlock(db: DatabaseSync, corpusId: number, number: string): PacketSection | null {
  const rows = db
    .prepare(
      `SELECT number, text, subsection_title FROM rules
       WHERE corpus_id = ? AND subsection_number = ? ORDER BY ordinal`,
    )
    .all(corpusId, number) as Array<{ number: string; text: string; subsection_title: string | null }>;
  if (rows.length === 0) return null;
  const rules = rows.filter((r) => r.text !== '').map((r) => ({ number: r.number, text: r.text }));
  return {
    number,
    title: rows[0]!.subsection_title ?? number,
    rules,
    chars: rules.reduce((n, r) => n + r.number.length + r.text.length + 2, 0),
  };
}

/**
 * One specific lettered rule, e.g. "805.4a" - used when a cross-reference (glossary
 * or "see rule NNN") names a single subrule rather than a whole subsection. About
 * 3.6% of rule_term_index's rule_numbers are this shape; `subsectionBlock`'s
 * `subsection_number` filter never matches a trailing letter (that column is always
 * the bare "NNN.M" form - see parse.ts's `numericSub`), so without this the cited
 * rule's text would silently never appear in a scoped packet despite the term match
 * being reported in `matchedTerms` (an I3 gap: a claim made but not backed by content).
 */
function exactRuleBlock(db: DatabaseSync, corpusId: number, number: string): PacketSection | null {
  const row = db
    .prepare('SELECT number, text, subsection_title FROM rules WHERE corpus_id = ? AND number = ?')
    .get(corpusId, number) as { number: string; text: string; subsection_title: string | null } | undefined;
  if (!row || row.text === '') return null;
  return {
    number: row.number,
    title: row.subsection_title ?? row.number,
    rules: [{ number: row.number, text: row.text }],
    chars: row.number.length + row.text.length + 2,
  };
}

/**
 * One selected rule number, rendered by its shape: a bare section ("106"), a titled
 * subsection ("702.2"), or one lettered rule ("805.4a") - see exactRuleBlock's note on
 * why the third case exists. Null when the corpus has nothing to render for it.
 *
 * `{ subrules: false }` (Phase 3 spec rev. 6 sec. 5.2 item 2): "NNN.N" gives the rule NNN.N
 * only, and a section "NNN" gives NNN.1, NNN.2, ... without their lettered subrules. A title row
 * ("702.2 Deathtouch") has no text of its own, so it gives its subrules (owner, 2026-10-10).
 */
export function renderRule(
  db: DatabaseSync, corpusId: number, n: string, opts: { subrules?: boolean } = {},
): PacketSection | null {
  if (opts.subrules === false) {
    if (!n.includes('.')) return sectionBlock(db, corpusId, n, true);
    return exactRuleBlock(db, corpusId, n) ?? (/[a-z]$/.test(n) ? null : subsectionBlock(db, corpusId, n));
  }
  return /[a-z]$/.test(n) ? exactRuleBlock(db, corpusId, n)
    : n.includes('.') ? subsectionBlock(db, corpusId, n)
    : sectionBlock(db, corpusId, n);
}

/**
 * The rendered blocks that would contain a rule, most specific first: the rule itself,
 * its subsection, its section, its top-level group - "704.5f" gives 704.5f, 704.5, 704, 7.
 *
 * This mirrors exactly what the renderers select on: `subsectionBlock` keys on
 * `subsection_number`, which is the rule number with its trailing letter dropped, and
 * `sectionBlock` on `section_number` (the part before the dot) or, for a top-level
 * digit, the sections whose parent it is. Measured against corpus 3: zero `rules` rows
 * where either column disagrees with that string derivation.
 *
 * Pure string work over whole components, so it is directional by construction - a
 * lettered rule never appears in its subsection's chain - and never a prefix test:
 * "702.2" is not in "702.20a"'s chain.
 */
export function containingBlocks(rule: string): string[] {
  const chain = [rule];
  const subsection = rule.replace(/[a-z]+$/, '');
  if (subsection !== rule) chain.push(subsection);          // lettered -> its subsection
  const section = rule.split('.')[0]!;
  if (section !== subsection) chain.push(section);          // dotted   -> its section
  if (section.length > 1) chain.push(section[0]!);          // section  -> its top-level group
  return chain;
}

/**
 * sec. 3.4 coverage, ruling R2: a cited rule is in a packet when the packet renders it,
 * or renders a block that contains it. Containment, not set membership - golden
 * citations are mostly lettered ("704.5f") while selection is mostly whole subsections,
 * so membership alone would call nearly every citation unreachable and bloat the kernel.
 *
 * `rendered` holds the numbers of blocks actually rendered (`PacketSection.number`), not
 * merely selected: a selected number that renders nothing covers nothing. This is the
 * one coverage test - kernel derivation, the packet-policy diff, and kernel
 * de-duplication in both assembly modes all use it.
 */
export function isCovered(rendered: ReadonlySet<string>, cited: string): boolean {
  return containingBlocks(cited).some((n) => rendered.has(n));
}

/** Card form via the Scryfall layout's authored English alias, through type_rule_map. */
function cardFormRule(db: DatabaseSync, corpusId: number, alias: string): string | null {
  const hit = db
    .prepare(
      "SELECT rule_number FROM type_rule_map WHERE corpus_id = ? AND kind = 'card_form' AND term_key = ?",
    )
    .get(corpusId, normalizeTermKey(alias)) as { rule_number: string } | undefined;
  return hit?.rule_number ?? null;
}

export interface TermSelection {
  /** The `matchTerms` result `sections` was derived from - same input, same call. */
  matchedTerms: MatchedTerm[];
  /** Rendered blocks, sorted by number. */
  sections: PacketSection[];
}

/**
 * Ruling R1: everything the scoped packet sends for one card WITHOUT the kernel -
 * `reachableRules` (sec. 3.3 steps 1-6) plus the card-form rule from the layout alias,
 * rendered. This is the single definition of "term-reachable": `assembleScopedPacket`
 * sends it and `deriveKernel` (kernel.ts) measures golden citations against it, so the
 * kernel is always exactly what this selection lacks and the two cannot drift.
 *
 * Card form is added here rather than in `reachableRules` because it needs
 * core-packet.json's `layout_aliases`, which relevance.ts has no reason to know about.
 */
export function termSelection(
  db: DatabaseSync,
  corpusId: number,
  oracleId: string,
  policy: PacketPolicy,
  config?: CorePacketConfig,
  input?: CardMatchInput,
): TermSelection {
  const cfg = config ?? loadCorePacketConfig();
  // `cardMatchText` is the single reader of the card's row and faces (review finding 2);
  // reusing a caller's result keeps `matchedTerms` and `sections` on the same input.
  const inp = input ?? cardMatchText(db, oracleId);
  const { rules, matchedTerms } = reachableRules(db, corpusId, oracleId, policy, inp);

  const alias = cfg.layout_aliases[inp.card.layout];
  const form = alias ? cardFormRule(db, corpusId, alias) : null;
  if (form) rules.add(form);

  const sections: PacketSection[] = [];
  for (const n of [...rules].sort()) {
    const block = renderRule(db, corpusId, n);
    if (block) sections.push(block);
  }
  return { matchedTerms, sections };
}

/**
 * The persisted kernel for a corpus, sorted by rule number.
 *
 * Ruling R6(b): an empty kernel is legitimate only while the golden set is empty
 * (fixture corpora, a fresh checkout). Once golden atoms exist, zero rows means a corpus
 * the kernel was never derived for - typically a CR refresh - and assembling anyway
 * would silently drop every rule only the kernel carries. So that is an error.
 */
export function loadKernelRules(db: DatabaseSync, corpusId: number): string[] {
  const rows = db
    .prepare('SELECT rule_number FROM packet_kernel WHERE corpus_id = ? ORDER BY rule_number')
    .all(corpusId) as Array<{ rule_number: string }>;
  if (rows.length === 0) {
    const golden = (db.prepare('SELECT COUNT(*) AS n FROM golden_atoms').get() as { n: number }).n;
    if (golden > 0) {
      throw new Error(`no packet kernel for corpus ${corpusId} — run npm run kernel:derive`);
    }
  }
  return rows.map((r) => r.rule_number);
}

/** The kernel rendered; `missing` lists kernel rows the corpus renders nothing for. */
export function kernelBlocks(
  db: DatabaseSync,
  corpusId: number,
): { blocks: PacketSection[]; missing: string[] } {
  const blocks: PacketSection[] = [];
  const missing: string[] = [];
  for (const n of loadKernelRules(db, corpusId)) {
    const block = renderRule(db, corpusId, n);
    if (block) blocks.push(block);
    else missing.push(n);
  }
  return { blocks, missing };
}

/**
 * sec. 5.3. Packet assembly is purely mechanical: a constant prefix plus additions
 * derived from this card's own `keywords` array, subtypes and layout. No selection is
 * made by judgement, and no rule number is authored anywhere - the prefix is the packet
 * kernel, derived from golden-set citations into `packet_kernel` (sec. 3.4, kernel.ts),
 * and every card-specific number comes from `keyword_rule_map` or `type_rule_map`, both
 * built by parsing.
 *
 * Phase 1 hand-picked this prefix as config's `core_sections` (385,012 characters, the
 * same for every card). That list is retired; the field names `core`/`coreChars` stay
 * because the UI reads them, and they now mean the kernel.
 */
export function assemblePacket(
  db: DatabaseSync,
  oracleId: string,
  config?: CorePacketConfig,
): RulesPacket {
  const corpus = currentCorpus(db);
  const cfg = config ?? loadCorePacketConfig();

  const card = db
    .prepare('SELECT keywords, type_line, layout FROM cards WHERE oracle_id = ?')
    .get(oracleId) as { keywords: string; type_line: string; layout: string } | undefined;
  if (!card) throw new Error(`No card with oracle_id ${oracleId}`);

  const unresolvedKeywords: string[] = [];
  const unmappedLayouts: string[] = [];
  const suppressedAsCore: string[] = [];

  const { blocks: core, missing } = kernelBlocks(db, corpus.id);
  const missingRules: string[] = [...missing];
  const kernelRendered = new Set(core.map((s) => s.number));

  const cardSpecific: PacketSection[] = [];
  const added = new Set<string>();

  /** Adds a derived section unless the kernel already contains it or it is already added. */
  const addDerived = (ruleNumber: string, onMissing: () => void): void => {
    if (added.has(ruleNumber)) return;
    // Containment, not membership: a kernel holding a whole section covers a derived
    // subsection of it (the Phase 1 ancestry bug isCoveredByCore existed to prevent).
    if (isCovered(kernelRendered, ruleNumber)) {
      suppressedAsCore.push(ruleNumber);
      added.add(ruleNumber);
      return;
    }
    const block = ruleNumber.includes('.')
      ? subsectionBlock(db, corpus.id, ruleNumber)
      : sectionBlock(db, corpus.id, ruleNumber);
    if (block) {
      cardSpecific.push(block);
      added.add(ruleNumber);
    } else {
      onMissing();
    }
  };

  // 1. Keyword abilities and keyword actions, from this card's own keywords array.
  const keywordLookup = db.prepare(
    'SELECT rule_number, resolution FROM keyword_rule_map WHERE corpus_id = ? AND keyword_key = ?',
  );
  for (const kw of JSON.parse(card.keywords) as string[]) {
    const hit = keywordLookup.get(corpus.id, normalizeTermKey(kw)) as
      | { rule_number: string | null; resolution: string }
      | undefined;

    if (!hit || hit.resolution === 'unresolved') {
      unresolvedKeywords.push(kw);
      continue;
    }
    if (hit.rule_number === null) continue;   // ability word: correctly has no section
    addDerived(hit.rule_number, () => unresolvedKeywords.push(kw));
  }

  // 2. Subtypes implied by the type line, via the parsed 205.3 cross-references.
  //    Matched against whitespace/dash tokens, so "Enchantment - Saga" yields "Saga".
  const subtypeLookup = db.prepare(
    "SELECT rule_number FROM type_rule_map WHERE corpus_id = ? AND kind = 'subtype' AND term_key = ?",
  );
  const tokens = new Set(
    card.type_line.split(/[\s—–\-]+/).map((t) => normalizeTermKey(t)).filter(Boolean),
  );
  for (const token of tokens) {
    const hit = subtypeLookup.get(corpus.id, token) as { rule_number: string } | undefined;
    // onMissing is effectively unreachable: type_rule_map is built from the same corpus
    // with an exists() gate, so a stored rule_number always resolves. Kept defensive.
    if (hit) addDerived(hit.rule_number, () => missingRules.push(hit.rule_number));
  }

  // 3. Card form, from the Scryfall layout via its authored English alias.
  const alias = cfg.layout_aliases[card.layout];
  if (alias) {
    const form = cardFormRule(db, corpus.id, alias);
    if (form) addDerived(form, () => unmappedLayouts.push(card.layout));
    else unmappedLayouts.push(card.layout);        // alias names no section - loud, by design
  } else if (card.layout !== 'normal') {
    unmappedLayouts.push(card.layout);             // a layout nobody has aliased yet
  }

  return {
    corpusId: corpus.id,
    effectiveDate: corpus.effective_date,
    core,
    cardSpecific,
    unresolvedKeywords: [...new Set(unresolvedKeywords)],
    unmappedLayouts: [...new Set(unmappedLayouts)],
    missingRules: [...new Set(missingRules)],
    suppressedAsCore: [...new Set(suppressedAsCore)],
    coreChars: core.reduce((n, s) => n + s.chars, 0),
    cardChars: cardSpecific.reduce((n, s) => n + s.chars, 0),
  };
}

export interface ScopedPacket {
  corpusId: number;
  effectiveDate: string;
  matchedTerms: MatchedTerm[];
  /** The kernel blocks this packet renders, in order - the constant prefix of `sections`. */
  kernelRules: string[];
  /** Kernel rows the corpus renders nothing for (a stale kernel), surfaced not swallowed. */
  missingKernelRules: string[];
  /** Kernel blocks first, then this card's term-reachable blocks the kernel doesn't contain. */
  sections: PacketSection[];
  unresolvedKeywords: string[];
  selectedChars: number;
}

/**
 * sec. 3.3-3.5's relevance-gated mode: the packet kernel (sec. 3.4) as a constant
 * prefix, then every rule `termSelection` reaches from the card's own text plus Phase 1's
 * derived maps, plus the glossary definitions matched alongside them. A term-reachable
 * block the kernel already contains is not sent twice.
 */
export function assembleScopedPacket(
  db: DatabaseSync,
  oracleId: string,
  policy?: PacketPolicy,
  config?: CorePacketConfig,
): ScopedPacket {
  return scopedPacket(db, currentCorpus(db), oracleId, policy, config);
}

/**
 * `assembleScopedPacket` against an explicit corpus rather than the current one - for a
 * caller handed a corpus id (`packetPolicyDiff`), so the packet it checks is assembled
 * from that same corpus's rules, term index and kernel (ruling R5).
 */
export function assembleScopedPacketForCorpus(
  db: DatabaseSync,
  corpusId: number,
  oracleId: string,
  policy?: PacketPolicy,
  config?: CorePacketConfig,
): ScopedPacket {
  return scopedPacket(db, corpusById(db, corpusId), oracleId, policy, config);
}

function scopedPacket(
  db: DatabaseSync,
  corpus: CorpusRow,
  oracleId: string,
  policy?: PacketPolicy,
  config?: CorePacketConfig,
): ScopedPacket {
  const pol = policy ?? loadPacketPolicy();
  const input = cardMatchText(db, oracleId);
  const { card } = input;

  const kernel = kernelBlocks(db, corpus.id);
  const kernelRendered = new Set(kernel.blocks.map((s) => s.number));
  const term = termSelection(db, corpus.id, oracleId, pol, config, input);
  const sections = [
    ...kernel.blocks,
    ...term.sections.filter((s) => !isCovered(kernelRendered, s.number)),
  ];

  const unresolvedKeywords: string[] = [];
  const keywordLookup = db.prepare(
    'SELECT rule_number, resolution FROM keyword_rule_map WHERE corpus_id = ? AND keyword_key = ?',
  );
  for (const kw of JSON.parse(card.keywords) as string[]) {
    const hit = keywordLookup.get(corpus.id, normalizeTermKey(kw)) as
      | { rule_number: string | null; resolution: string }
      | undefined;
    if (!hit || hit.resolution === 'unresolved') unresolvedKeywords.push(kw);
  }

  const selectedChars =
    sections.reduce((n, s) => n + s.chars, 0) +
    term.matchedTerms.reduce((n, m) => n + (m.definition?.length ?? 0), 0);

  return {
    corpusId: corpus.id,
    effectiveDate: corpus.effective_date,
    matchedTerms: term.matchedTerms,
    kernelRules: kernel.blocks.map((s) => s.number),
    missingKernelRules: kernel.missing,
    sections,
    unresolvedKeywords: [...new Set(unresolvedKeywords)],
    selectedChars,
  };
}
