import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeTermKey, scanCrossRefs } from './parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = resolve(here, '../../config/packet-policy.json');

export interface PacketPolicy {
  crossref_depth: number;
  min_term_length: number;
  strip_suffixes: string[];
}

export interface MatchedTerm {
  term: string;
  term_key: string;
  /** The exact form found in the card's text, e.g. "attacks" for the term "attack". */
  surface: string;
  source: string;
  rule_numbers: string[];
  definition: string | null;
}

let policyCache: PacketPolicy | null = null;

export function loadPacketPolicy(path: string = DEFAULT_POLICY): PacketPolicy {
  if (policyCache && path === DEFAULT_POLICY) return policyCache;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const p: PacketPolicy = {
    crossref_depth: raw['crossref_depth'] as number,
    min_term_length: raw['min_term_length'] as number,
    strip_suffixes: raw['strip_suffixes'] as string[],
  };
  if (path === DEFAULT_POLICY) policyCache = p;
  return p;
}

export function resetPolicyCache(): void {
  policyCache = null;
}

/** Stable fingerprint of the policy, recorded on every extraction run. */
export function packetPolicySha(policy: PacketPolicy): string {
  const canonical = JSON.stringify({
    crossref_depth: policy.crossref_depth,
    min_term_length: policy.min_term_length,
    strip_suffixes: [...policy.strip_suffixes].sort(),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

/** Word-ish tokens with their offsets. Anchoring here is what stops "player" matching "layer". */
function tokenize(text: string): Array<{ word: string; start: number; end: number }> {
  const out: Array<{ word: string; start: number; end: number }> = [];
  const re = /[\p{L}\p{N}'-]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Candidate keys for one surface form: the form itself, then conservative de-inflections. */
function candidateKeys(surface: string, policy: PacketPolicy): string[] {
  const base = normalizeTermKey(surface);
  const keys = [base];
  for (const suf of policy.strip_suffixes) {
    if (base.length > suf.length + policy.min_term_length && base.endsWith(suf)) {
      keys.push(base.slice(0, -suf.length));
    }
  }
  return keys;
}

/**
 * Text as a list of word stems, for phrase matching (ruling R13-1): `tokenize`'s anchoring,
 * lower-cased, each word losing the first `strip_suffixes` entry `candidateKeys` would strip.
 * One stem per word rather than candidates, so two texts compare by plain sequence equality.
 */
export function phraseTokens(text: string, policy: PacketPolicy): string[] {
  return tokenize(text).map(({ word }) => {
    const base = normalizeTermKey(word);
    const suf = policy.strip_suffixes.find((s) => base.length > s.length + policy.min_term_length && base.endsWith(s));
    return suf ? base.slice(0, -suf.length) : base;
  });
}

/**
 * sec. 3.3. Longest match first over whole-word spans, with conservative inflection
 * stripping as a fallback. Both rules are mandatory and pull in opposite directions:
 * without anchoring, the term "Layer" matches inside "player" on ~400 faces; without
 * inflection, "attacks" (378 faces) never finds its rule.
 */
export function matchTerms(
  db: DatabaseSync,
  corpusId: number,
  text: string,
  policy: PacketPolicy,
): MatchedTerm[] {
  const lookup = db.prepare(
    'SELECT term, term_key, source, rule_numbers, definition FROM rule_term_index WHERE corpus_id = ? AND term_key = ?',
  );
  const tokens = tokenize(text);
  const found = new Map<string, MatchedTerm>();

  // Longest window first. This decides which SURFACE form gets reported for a term,
  // and nothing else - see the note below on why it must not gate insertion.
  const MAX_WINDOW = 4;
  for (let win = MAX_WINDOW; win >= 1; win--) {
    for (let i = 0; i + win <= tokens.length; i++) {
      const surface = text.slice(tokens[i]!.start, tokens[i + win - 1]!.end);
      if (surface.length < policy.min_term_length) continue;

      for (const key of candidateKeys(surface, policy)) {
        const rows = lookup.all(corpusId, key) as Array<{
          term: string; term_key: string; source: string;
          rule_numbers: string; definition: string | null;
        }>;
        if (rows.length === 0) continue;
        for (const r of rows) {
          const id = `${r.term_key}::${r.source}`;
          // First writer wins, and the longest window runs first, so a term found
          // inside a longer phrase keeps the longer phrase's surface attribution.
          if (!found.has(id)) {
            found.set(id, {
              term: r.term, term_key: r.term_key, surface, source: r.source,
              rule_numbers: JSON.parse(r.rule_numbers) as string[],
              definition: r.definition,
            });
          }
        }
        break;                                 // first candidate key that resolves wins
      }
    }
  }

  return [...found.values()];
}

export interface CardMatchInput {
  card: { keywords: string; type_line: string; layout: string };
  /** Faces' oracle_text (in face order) plus the type_line, joined for term matching. */
  text: string;
}

/**
 * The one place that reads a card's own fields and builds the text `matchTerms` scans.
 * `reachableRules` and `assembleScopedPacket` (packet.ts) both need this exact
 * derivation - review finding 2: before this was pulled out, both files ran the same
 * `cards` query, the same `card_faces` query, and built `text` with the identical
 * join, so an edit to one copy could silently desync `matchedTerms` from `sections`
 * (an I3 traceability hazard) while also paying the DB round-trip twice per card
 * across the 4,702-card extraction run.
 */
export function cardMatchText(db: DatabaseSync, oracleId: string): CardMatchInput {
  const card = db.prepare('SELECT keywords, type_line, layout FROM cards WHERE oracle_id = ?')
    .get(oracleId) as { keywords: string; type_line: string; layout: string } | undefined;
  if (!card) throw new Error(`No card with oracle_id ${oracleId}`);
  const faces = db.prepare('SELECT oracle_text FROM card_faces WHERE oracle_id = ? ORDER BY face_index')
    .all(oracleId) as Array<{ oracle_text: string }>;
  const text = [...faces.map((f) => f.oracle_text), card.type_line].join('\n');
  return { card, text };
}

export interface BottomDecile {
  pool_size: number;
  bottom_decile_index: number;
  bottom_decile_threshold_rule_count: number;
  /** Every pool card at or below the threshold (ties included), thinnest first. */
  cards: Array<{ oracle_id: string; name: string; rule_count: number }>;
}

/**
 * The gate's blind spots (plan Task 1 Step 13): count the rules `matchTerms` alone
 * reaches for every non-rotated card - no crossref expansion - and keep every card at
 * or below the count at index floor(n * 0.1). Ties at the threshold are kept, so the
 * list is >= 10% of the pool. golden `--select` reads the committed result.
 */
export function measureBottomDecile(db: DatabaseSync, corpusId: number, policy: PacketPolicy): BottomDecile {
  const cards = db.prepare('SELECT oracle_id, name FROM cards WHERE rotated = 0')
    .all() as Array<{ oracle_id: string; name: string }>;
  if (cards.length === 0) throw new Error('measureBottomDecile: the pool is empty');
  const counts = cards.map(({ oracle_id, name }) => ({
    oracle_id,
    name,
    rule_count: new Set(
      matchTerms(db, corpusId, cardMatchText(db, oracle_id).text, policy).flatMap((h) => h.rule_numbers),
    ).size,
  }));
  counts.sort((a, b) => a.rule_count - b.rule_count || a.oracle_id.localeCompare(b.oracle_id));
  const index = Math.floor(counts.length * 0.1);
  const threshold = counts[index]!.rule_count;
  return {
    pool_size: counts.length,
    bottom_decile_index: index,
    bottom_decile_threshold_rule_count: threshold,
    cards: counts.filter((c) => c.rule_count <= threshold),
  };
}

export interface ReachableRules {
  rules: Set<string>;
  /** The same `matchTerms` result the rule set was derived from - callers that also
   *  need `matchedTerms` (e.g. `assembleScopedPacket`) reuse it instead of re-running
   *  `matchTerms` a second time over the same text (review finding 2). */
  matchedTerms: MatchedTerm[];
}

/**
 * Every rule reachable for one card WITHOUT the kernel: sec. 3.3 steps 1-6.
 *
 * `input`, when supplied, is a precomputed `cardMatchText` result - lets a caller that
 * already has it (e.g. `assembleScopedPacket`) skip a second `cards`/`card_faces`
 * round-trip. Computed internally when omitted, so existing direct callers/tests are
 * unaffected.
 */
export function reachableRules(
  db: DatabaseSync, corpusId: number, oracleId: string, policy: PacketPolicy,
  input?: CardMatchInput,
): ReachableRules {
  const { card, text } = input ?? cardMatchText(db, oracleId);

  const matchedTerms = matchTerms(db, corpusId, text, policy);
  const out = new Set<string>();
  for (const hit of matchedTerms) {
    for (const r of hit.rule_numbers) out.add(r);
  }
  // Phase 1's derived maps (sec. 3.3 step 6).
  for (const r of phase1Additions(db, corpusId, card)) out.add(r);

  // Step 5: follow "See rule NNN" from the text of rules already selected.
  //
  // "Already selected" means the specific rule or subsection in `frontier` - never a
  // whole top-level section. Two reasons a bare section number (e.g. "115", from a
  // coarse glossary cross-ref) does NOT cascade here:
  //
  //   1. Section 702 (Keyword Abilities) alone holds 767 rows. Scanning every row
  //      of a matched bare section for further refs risks discovering a *generic*
  //      "see rule 702" pointer buried in an unrelated subrule (measured: rule
  //      115.1e cites bare 702 this way) - which then renders as the ENTIRE
  //      keyword-abilities section later, ballooning one card's packet past
  //      100,000 characters. Measured before this restriction: mean selectedChars
  //      189,498 (only a 2.0x reduction over Phase 1's 385,012 - the task's whole
  //      point defeated). After: see the Step 13 measurement in the task report.
  //   2. A bare section match is already the coarsest unit this system selects;
  //      chasing refs from every one of its subrules is a different, broader
  //      operation than "follow this rule's own cross-references."
  //
  // The `if (!rule.includes('.')) continue;` below is a cheap early exit for this,
  // not the sole guard against it: the query's `(subsection_number = ? OR number = ?)`
  // keying independently returns zero rows for a bare section value (`subsection_number`
  // is always the dotted "NNN.M" form, and no `rules` row is literally numbered with a
  // bare 3-digit section number - only its subrules are), so the invariant would hold
  // even without the `continue`. Do not read the `continue`'s removal as safe just
  // because of that, though - it is real defence in depth, and the query keying is the
  // part that must never regress back to `section_number = ?` (see the 189,498-char
  // measurement above); tests/relevance.test.ts pins both.
  //
  // Review finding 1: a frontier entry can also be one specific LETTERED subrule
  // (e.g. "805.4a" - about 3.6% of rule_term_index's rule_numbers are this shape,
  // reached via a glossary cross-reference). `subsection_number` is always the bare
  // "NNN.M" form (schema.sql), so a query keyed only on that column silently matches
  // zero rows for a lettered frontier entry and no-ops - the citation renders via
  // `exactRuleBlock` in packet.ts, but the rules IT cites were never followed. Fixed
  // by also matching the frontier entry against `number` directly: for a bare
  // subsection like "702.2" that's a no-op (no rule is literally numbered "702.2"
  // with no letter beyond what subsection_number already caught), so the existing
  // "whole subsection" behaviour for dotted, unlettered frontier entries is unchanged;
  // for a lettered entry it scans exactly that one rule's own text, matching the
  // granularity of everything else this hop operates on.
  const frontierText = db.prepare(
    'SELECT text FROM rules WHERE corpus_id = ? AND (subsection_number = ? OR number = ?)',
  );
  let frontier = [...out];
  for (let hop = 0; hop < policy.crossref_depth; hop++) {
    const next: string[] = [];
    for (const rule of frontier) {
      if (!rule.includes('.')) continue;   // bare section - see above
      for (const row of frontierText.all(corpusId, rule, rule) as Array<{ text: string }>) {
        for (const ref of scanCrossRefs(row.text)) {
          if (!out.has(ref)) { out.add(ref); next.push(ref); }
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return { rules: out, matchedTerms };
}

/**
 * Phase 1's keyword_rule_map / type_rule_map additions for one card: keyword
 * abilities/actions from the card's own `keywords` array, and subtypes implied by
 * the type line. Mirrors tiers 1-2 of `assemblePacket`'s card-specific derivation
 * in packet.ts, but returns bare rule numbers instead of assembled sections.
 *
 * Card form (tier 3 of `assemblePacket`) is deliberately NOT here: it requires
 * `core-packet.json`'s `layout_aliases`, a packet-assembly config this module has
 * no reason to know about. `assembleScopedPacket` in packet.ts - which already
 * owns that config - unions the card-form rule in itself.
 */
function phase1Additions(
  db: DatabaseSync,
  corpusId: number,
  card: { keywords: string; type_line: string },
): Set<string> {
  const out = new Set<string>();

  const keywordLookup = db.prepare(
    'SELECT rule_number FROM keyword_rule_map WHERE corpus_id = ? AND keyword_key = ?',
  );
  for (const kw of JSON.parse(card.keywords) as string[]) {
    const hit = keywordLookup.get(corpusId, normalizeTermKey(kw)) as { rule_number: string | null } | undefined;
    if (hit?.rule_number) out.add(hit.rule_number);
  }

  const subtypeLookup = db.prepare(
    "SELECT rule_number FROM type_rule_map WHERE corpus_id = ? AND kind = 'subtype' AND term_key = ?",
  );
  const tokens = new Set(
    card.type_line.split(/[\s—–\-]+/).map((t) => normalizeTermKey(t)).filter(Boolean),
  );
  for (const token of tokens) {
    const hit = subtypeLookup.get(corpusId, token) as { rule_number: string } | undefined;
    if (hit) out.add(hit.rule_number);
  }

  return out;
}
