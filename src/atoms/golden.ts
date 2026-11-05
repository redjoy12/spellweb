/**
 * The golden set: hand-verified ground truth that audits the extraction pipeline.
 *
 * This module is the OFFLINE TOOLING that supports the project owner's drafting
 * (plan Task 6, Steps 1-4). It does NOT draft, suggest, or synthesize any golden
 * card content — that is the owner's critical-path human work (Step 5, out of
 * scope for code). Everything here is mechanical: read, write, validate, score.
 *
 * Scoring implements sec. 8.2 of the Phase 2 design. Precision is computed over
 * `complete` cards only (sec. 8.2, table: "Matching atoms over all accepted
 * atoms, computed only over `complete` cards"). Restricting precision to complete
 * cards is required: scoring a partially-recorded card counts that card's
 * un-recorded-but-real atoms as false positives, and would drive the metric DOWN
 * as the reviewer does more work — the opposite of what a quality metric should
 * do. Recall is across all golden cards; matching uses `(family, type_key, span
 * overlap >= 50%)` (sec. 8.2, last line).
 *
 * No rule numbers are authored anywhere in this file (I2). Rule existence is
 * verified against the parsed `rules` corpus; the kernel is derived elsewhere
 * (Task 7) from the citations this module stores.
 */
import type { DatabaseSync } from 'node:sqlite';
import { currentSchemaVersion, validateAtomParams } from './schema.js';
import type { AtomFamily } from './schema.js';
import { splitOracleText, SPLITTER_VERSION } from './clauses.js';
import { computeCoverage } from './verify.js';

/** How a golden atom entered the set (sec. 10.2 `golden_atoms.source` CHECK). */
export type GoldenSource = 'authored' | 'review_correction';

/** One verified atom for one card, as stored in `golden_atoms` (sec. 10.2). */
export interface GoldenAtom {
  face_index: number;
  schema_version: number;
  family: AtomFamily;
  type_key: string;
  /** Free-form params object; validated against the type's params_schema. */
  params: Record<string, unknown>;
  span_start: number;
  span_end: number;
  /** Verbatim slice of `card_faces.oracle_text` at [span_start, span_end). */
  quote: string;
  /** Rules that justify the reading; each must exist in the corpus. */
  rule_numbers: string[];
  source: GoldenSource;
}

/** A card's golden record: its invariants plus the atoms its clauses yield. */
export interface GoldenCard {
  oracle_id: string;
  /** Exhaustive record? sec. 8.2 computes precision over `complete` cards only. */
  complete: boolean;
  oracle_hash: string;
  /** ISO-8601 UTC; `verified_at` on the card and on every atom. */
  verified_at: string;
  atoms: GoldenAtom[];
}

/**
 * The sec. 8.2 metric bundle, plus the raw counts the bake-off (sec. 9) reports.
 * Every fraction is in [0, 1]; rates are per-card averages (>= 0).
 *
 * `citation_in_corpus` here is "every cited rule exists in the run's corpus" —
 * a NECESSARY but not SUFFICIENT condition for "in-packet", and deliberately NOT
 * named `citation_validity`: sec. 9's decision rule sets a 1.00 bar on citation
 * validity meaning "the model never cites a rule it wasn't shown" (an I1
 * violation otherwise), which requires knowing the rule was in the ASSEMBLED
 * packet, not merely that it exists somewhere in the corpus. A hallucinated
 * citation of a real-but-unshown CR rule passes this corpus-existence check but
 * is exactly the failure sec. 9's bar exists to catch. `citation_validity` is
 * that bar, measured against the whitelist each card was actually sent (the batch
 * manifests' `packet_rules`, passed in by the caller) rather than a re-assembly,
 * which could differ once the kernel or policy has moved on.
 */
export interface GoldenScore {
  atom_precision: number;       // complete cards only
  atom_recall: number;          // all golden cards
  coverage: number;             // golden cards reaching 100% clause coverage
  span_validity: number;        // returned atoms whose quote resolved
  citation_in_corpus: number;   // returned atoms whose rule_numbers exist in the corpus (NOT the sec. 9 in-packet bar - see above)
  /**
   * sec. 8.2/9 citation validity: returned atoms whose rule_numbers were ALL in that card's
   * packet. Null when the caller supplied no packet whitelists - unmeasured, never assumed.
   */
  citation_validity: number | null;
  missing_rule_rate: number;    // missing_rule_reports per golden card
  unclassified_rate: number;    // unclassified_clauses per golden card
  /** Supporting counts, exposed for the bake-off comparison table. */
  matched_atoms: number;        // run atoms that matched a golden atom (complete cards)
  accepted_atoms: number;       // run atoms for complete cards (precision denominator)
  golden_atoms_total: number;   // recall denominator
  golden_atoms_matched: number;  // recall numerator
  complete_cards: number;
  golden_cards_total: number;
}

/** The current (is_current = 1) corpus id; throws if the corpus is empty. */
export function currentCorpusId(db: DatabaseSync): number {
  const row = db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as
    | { id: number }
    | undefined;
  if (!row) throw new Error('no current rules corpus - run `npm run sync:rules` first');
  return row.id;
}

/** Loads every golden card with its atoms, deterministically ordered. */
export function loadGoldenSet(db: DatabaseSync): GoldenCard[] {
  const cards = db
    .prepare('SELECT oracle_id, complete, oracle_hash, verified_at FROM golden_cards ORDER BY oracle_id')
    .all() as Array<{ oracle_id: string; complete: number; oracle_hash: string; verified_at: string }>;
  const atomRows = db
    .prepare(
      `SELECT oracle_id, face_index, schema_version, family, type_key, params_json,
              span_start, span_end, quote, rule_numbers, source
         FROM golden_atoms
        ORDER BY oracle_id, face_index, span_start, family, type_key`,
    )
    .all() as Array<{
    oracle_id: string; face_index: number; schema_version: number; family: string;
    type_key: string; params_json: string; span_start: number; span_end: number;
    quote: string; rule_numbers: string; source: string;
  }>;

  const byCard = new Map<string, GoldenAtom[]>();
  for (const r of atomRows) {
    const list = byCard.get(r.oracle_id) ?? [];
    list.push({
      face_index: r.face_index,
      schema_version: r.schema_version,
      family: r.family as AtomFamily,
      type_key: r.type_key,
      params: JSON.parse(r.params_json) as Record<string, unknown>,
      span_start: r.span_start,
      span_end: r.span_end,
      quote: r.quote,
      rule_numbers: JSON.parse(r.rule_numbers) as string[],
      source: r.source as GoldenSource,
    });
    byCard.set(r.oracle_id, list);
  }

  return cards.map((c) => ({
    oracle_id: c.oracle_id,
    complete: c.complete === 1,
    oracle_hash: c.oracle_hash,
    verified_at: c.verified_at,
    atoms: byCard.get(c.oracle_id) ?? [],
  }));
}

/**
 * Per-atom I3 checks, shared by `upsertGoldenCard` (which THROWS - the point at
 * which unvalidated content could enter `golden_atoms`, Important finding 3 on
 * the first review pass), `verifyGoldenCard` (which COLLECTS these into its
 * report for content already in the table, e.g. written before this check
 * existed, or drifted since - schema-version promotion, corpus re-sync), and
 * `goldenDraft.validateProposal` (which runs them against a STAGED proposal, so
 * an assisted draft is rejected on disk before it is ever offered for
 * acceptance). Exported for that third caller: the checks a proposal must pass
 * are by definition the checks the table enforces, and a second implementation
 * of them would be free to drift.
 * Returns problem strings; an empty array means the atom is valid. Checks:
 *
 *  - `quote` slices back exactly from `faceText`
 *  - every `rule_numbers` entry exists in the corpus
 *  - `(family, type_key)` exists in `atom_types` at `schemaVersion`
 *  - `params` validate against that type's `params_schema`
 */
export function validateGoldenAtom(
  db: DatabaseSync,
  tag: string,
  faceText: string,
  a: {
    family: string; type_key: string; params: Record<string, unknown>;
    span_start: number; span_end: number; quote: string; rule_numbers: string[];
  },
  corpusId: number,
  schemaVersion: number,
): string[] {
  const errors: string[] = [];
  if (!quoteResolves(faceText, a)) {
    errors.push(`${tag}: quote does not slice back from card_faces.oracle_text`);
  }
  if (!ruleNumbersExist(db, a.rule_numbers, corpusId)) {
    const missing = a.rule_numbers.filter((n) =>
      !db.prepare('SELECT 1 FROM rules WHERE corpus_id = ? AND number = ? LIMIT 1').get(corpusId, n));
    errors.push(`${tag}: rule_numbers not in corpus: ${JSON.stringify(missing)}`);
  }
  const typeRow = db
    .prepare('SELECT 1 FROM atom_types WHERE schema_version = ? AND family = ? AND type_key = ? LIMIT 1')
    .get(schemaVersion, a.family, a.type_key);
  if (!typeRow) {
    errors.push(`${tag}: type ${a.family}.${a.type_key} not in atom_types at current schema_version ${schemaVersion}`);
    return errors;                       // params validation would just re-report the same absence
  }
  const v = validateAtomParams(db, schemaVersion, a.family, a.type_key, a.params);
  if (!v.ok) errors.push(`${tag}: params invalid - ${v.error}`);
  return errors;
}

/**
 * Idempotently writes (or rewrites) one golden card and its atoms. DELETEs the
 * card's prior atoms then re-INSERTs, so two calls with the same input leave the
 * same state (and the same call again with a different input atom set replaces
 * cleanly). The whole op is one transaction, matching terms.ts/schema.ts.
 *
 * I3 (Important finding 3, first review pass): every atom is validated with
 * `validateGoldenAtom` BEFORE anything is written - not merely by a separate,
 * optional `--verify` CLI invocation. The brief's "a golden entry that does not
 * validate is worse than none" is a claim about what's allowed to sit in the
 * table, not about what a CLI happened to print once; `scoreAgainstGolden`
 * trusts `golden_atoms` unconditionally, so this is the only real gate.
 * `verifyGoldenCard`'s per-atom checks stay in place too, as defense in depth
 * against content that reached the table by a path other than this function
 * (a direct write, a future migration) and against drift after the fact
 * (a schema-version promotion can retroactively invalidate an atom that was
 * fine when this function wrote it).
 *
 * The unique index `idx_golden_dedupe` on (oracle_id, face_index, family,
 * type_key, span_start) makes a duplicated atom within one input list a hard
 * error rather than a silent overwrite — a duplicate is a bug in the draft, and
 * the downtruth is too high to tolerate. The `golden_atoms` FK to `atom_types`
 * additionally rejects an unknown (schema_version, family, type_key); the FK to
 * `golden_cards` rejects an atom for a card that was never written.
 */
export function upsertGoldenCard(db: DatabaseSync, card: GoldenCard): void {
  const corpusId = currentCorpusId(db);
  const schemaVersion = currentSchemaVersion(db);
  const faces = db
    .prepare('SELECT face_index, oracle_text FROM card_faces WHERE oracle_id = ? ORDER BY face_index')
    .all(card.oracle_id) as Array<{ face_index: number; oracle_text: string }>;
  const textByFace = new Map(faces.map((f) => [f.face_index, f.oracle_text]));

  const problems: string[] = [];
  card.atoms.forEach((a, i) => {
    const tag = `atom #${i} (face ${a.face_index} ${a.family}.${a.type_key})`;
    const faceText = textByFace.get(a.face_index) ?? '';
    problems.push(...validateGoldenAtom(db, tag, faceText, a, corpusId, schemaVersion));
  });
  if (problems.length > 0) {
    throw new Error(`upsertGoldenCard(${card.oracle_id}): invalid atom(s), nothing written:\n${problems.join('\n')}`);
  }

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO golden_cards (oracle_id, complete, oracle_hash, verified_at)
       VALUES (?,?,?,?)
       ON CONFLICT(oracle_id) DO UPDATE SET
         complete = excluded.complete, oracle_hash = excluded.oracle_hash,
         verified_at = excluded.verified_at`,
    ).run(card.oracle_id, card.complete ? 1 : 0, card.oracle_hash, card.verified_at);

    db.prepare('DELETE FROM golden_atoms WHERE oracle_id = ?').run(card.oracle_id);

    const ins = db.prepare(
      `INSERT INTO golden_atoms
         (oracle_id, face_index, schema_version, family, type_key, params_json,
          span_start, span_end, quote, rule_numbers, oracle_hash, source, verified_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const a of card.atoms) {
      ins.run(
        card.oracle_id, a.face_index, a.schema_version, a.family, a.type_key,
        JSON.stringify(a.params), a.span_start, a.span_end, a.quote,
        JSON.stringify(a.rule_numbers), card.oracle_hash, a.source, card.verified_at,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Length of the intersection of [s1,e1) and [s2,e2); 0 when disjoint or empty. */
function overlapLen(s1: number, e1: number, s2: number, e2: number): number {
  return Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
}

/** sec. 8.2 match predicate: same (family, type_key) AND span overlap >= 50%. */
function overlapsAtLeastHalf(
  a: { span_start: number; span_end: number },
  b: { span_start: number; span_end: number },
): boolean {
  const lenA = a.span_end - a.span_start;
  const lenB = b.span_end - b.span_start;
  const minLen = Math.min(lenA, lenB);
  if (minLen <= 0) return false;
  return (overlapLen(a.span_start, a.span_end, b.span_start, b.span_end) / minLen) >= 0.5;
}

/**
 * Greedy bipartite matching of run atoms to golden atoms for one card, keyed by
 * (family, type_key) + the sec. 8.2 span test. Deterministic: candidate pairs are
 * sorted by overlap (desc) then by span_start (asc) before each atom is used once.
 * Returns the set of matched run-atom indices and golden-atom indices.
 */
export function matchAtoms<R extends { span_start: number; span_end: number }, G extends { span_start: number; span_end: number }>(
  runAtoms: Array<R & { family: string; type_key: string }>,
  goldenAtoms: Array<G & { family: string; type_key: string }>,
): { runIdx: Set<number>; goldenIdx: Set<number>; pairs: Array<[number, number]> } {
  const pairs: Array<{ run: number; gold: number; ov: number; start: number }> = [];
  for (let i = 0; i < runAtoms.length; i++) {
    const ra = runAtoms[i]!;
    for (let j = 0; j < goldenAtoms.length; j++) {
      const ga = goldenAtoms[j]!;
      if (ra.family !== ga.family || ra.type_key !== ga.type_key) continue;
      if (!overlapsAtLeastHalf(ra, ga)) continue;
      pairs.push({
        run: i, gold: j,
        ov: overlapLen(ra.span_start, ra.span_end, ga.span_start, ga.span_end),
        start: ra.span_start,
      });
    }
  }
  pairs.sort((p, q) => q.ov - p.ov || p.start - q.start);
  const runIdx = new Set<number>();
  const goldenIdx = new Set<number>();
  const matched: Array<[number, number]> = [];
  for (const p of pairs) {
    if (runIdx.has(p.run) || goldenIdx.has(p.gold)) continue;
    runIdx.add(p.run);
    goldenIdx.add(p.gold);
    matched.push([p.run, p.gold]);
  }
  return { runIdx, goldenIdx, pairs: matched };
}

/**
 * sec. 8.2 scoring of one extraction run against the golden set. Loads the run's
 * consensus atoms from `atoms` (its own verdict, not `is_current`, which a later run
 * clears - Task 9 ruling R9-1), the run's corpus from `extraction_runs`, coverage from
 * `computeCoverage` (atoms + the run's `unclassified_clauses`), the rates from
 * `missing_rule_reports`/`unclassified_clauses`, and the golden set from
 * `golden_cards`/`golden_atoms`. `opts.packetRules` (oracle_id -> the rule numbers that
 * card's packet carried) turns on the in-packet `citation_validity`.
 *
 * If the run has no atoms on any complete golden card, precision is 1.0 (no false
 * positives are possible); if there are no golden atoms, recall is 1.0. These
 * vacuous truths keep the bake-off bar meaningful for an empty/initial run.
 */
export function scoreAgainstGolden(
  db: DatabaseSync,
  runId: number,
  opts: { packetRules?: ReadonlyMap<string, ReadonlySet<string>> } = {},
): GoldenScore {
  const golden = loadGoldenSet(db);
  const goldenById = new Map(golden.map((c) => [c.oracle_id, c]));

  const run = db
    .prepare('SELECT corpus_id, schema_version FROM extraction_runs WHERE id = ?')
    .get(runId) as { corpus_id: number; schema_version: number } | undefined;
  if (!run) throw new Error(`no extraction_runs row for run_id ${runId}`);
  const corpusId = run.corpus_id;

  const runAtomRows = db
    .prepare(
      `SELECT oracle_id, face_index, family, type_key, span_start, span_end, quote, rule_numbers
         FROM atoms WHERE run_id = ? AND consensus = 1`,
    )
    .all(runId) as Array<{
    oracle_id: string; face_index: number; family: string; type_key: string;
    span_start: number; span_end: number; quote: string; rule_numbers: string;
  }>;

  const runByCard = new Map<string, typeof runAtomRows>();
  for (const r of runAtomRows) {
    const list = runByCard.get(r.oracle_id) ?? [];
    list.push(r);
    runByCard.set(r.oracle_id, list);
  }

  let matched = 0;
  let accepted = 0;          // precision denominator: run atoms on COMPLETE cards
  let goldenMatched = 0;
  let goldenTotal = 0;
  let coveredCards = 0;
  let spanOk = 0;
  let spanChecked = 0;
  let citeOk = 0;
  let inPacketOk = 0;

  // corpus rule-number set for citation validity (one query, cached).
  const corpusRules = new Set(
    (db.prepare('SELECT number FROM rules WHERE corpus_id = ?').all(corpusId) as Array<{ number: string }>)
      .map((r) => r.number),
  );

  for (const gc of golden) {
    goldenTotal += gc.atoms.length;
    const runForCard = runByCard.get(gc.oracle_id) ?? [];
    const { runIdx, goldenIdx } = matchAtoms(
      runForCard.map((r) => ({ family: r.family, type_key: r.type_key, span_start: r.span_start, span_end: r.span_end })),
      gc.atoms.map((a) => ({ family: a.family, type_key: a.type_key, span_start: a.span_start, span_end: a.span_end })),
    );
    goldenMatched += goldenIdx.size;
    if (gc.complete) {
      accepted += runForCard.length;
      matched += runIdx.size;
    }

    // coverage: did this golden card reach 100% clause coverage on this run? A card the run
    // never answered has no atoms, so it is uncovered unless it has no clauses at all.
    if (computeCoverage(db, runId, gc.oracle_id).ratio === 1) coveredCards++;
  }

  // Span validity (quote slice-back) and citation validity, over the run atoms
  // that land on golden cards. Single pass: face_index is selected per atom, and
  // the face's oracle_text is read with a cached prepared statement.
  const faceStmt = db.prepare(
    'SELECT oracle_text FROM card_faces WHERE oracle_id = ? AND face_index = ?',
  );
  for (const r of runAtomRows) {
    if (!goldenById.has(r.oracle_id)) continue;                 // only golden cards feed these metrics
    spanChecked++;
    const faceRow = faceStmt.get(r.oracle_id, r.face_index) as { oracle_text: string } | undefined;
    const faceText = faceRow?.oracle_text ?? '';
    if (faceText.slice(r.span_start, r.span_end) === r.quote) spanOk++;
    const cited = JSON.parse(r.rule_numbers) as string[];
    if (cited.every((n) => corpusRules.has(n))) citeOk++;
    const shown = opts.packetRules?.get(r.oracle_id);
    if (shown && cited.length > 0 && cited.every((n) => shown.has(n))) inPacketOk++;
  }

  const missingRuleCount = (
    db.prepare('SELECT COUNT(*) n FROM missing_rule_reports WHERE run_id = ?').get(runId) as { n: number }
  ).n;
  const unclassifiedCount = (
    db.prepare('SELECT COUNT(*) n FROM unclassified_clauses WHERE run_id = ?').get(runId) as { n: number }
  ).n;
  const goldenCardsTotal = golden.length;
  const completeCards = golden.filter((c) => c.complete).length;

  return {
    atom_precision: accepted === 0 ? 1 : matched / accepted,
    atom_recall: goldenTotal === 0 ? 1 : goldenMatched / goldenTotal,
    coverage: goldenCardsTotal === 0 ? 0 : coveredCards / goldenCardsTotal,
    span_validity: spanChecked === 0 ? 1 : spanOk / spanChecked,
    citation_in_corpus: spanChecked === 0 ? 1 : citeOk / spanChecked,
    citation_validity: !opts.packetRules ? null : spanChecked === 0 ? 1 : inPacketOk / spanChecked,
    missing_rule_rate: goldenCardsTotal === 0 ? 0 : missingRuleCount / goldenCardsTotal,
    unclassified_rate: goldenCardsTotal === 0 ? 0 : unclassifiedCount / goldenCardsTotal,
    matched_atoms: matched,
    accepted_atoms: accepted,
    golden_atoms_total: goldenTotal,
    golden_atoms_matched: goldenMatched,
    complete_cards: completeCards,
    golden_cards_total: goldenCardsTotal,
  };
}

/** Seconds into a face's oracle_text; whether [start,end) slices exactly to `quote`. */
function quoteResolves(faceText: string, atom: { span_start: number; span_end: number; quote: string }): boolean {
  return faceText.slice(atom.span_start, atom.span_end) === atom.quote;
}

/** Does every cited rule number exist in the current corpus's `rules` table? */
export function ruleNumbersExist(
  db: DatabaseSync,
  ruleNumbers: string[],
  corpusId: number,
): boolean {
  if (ruleNumbers.length === 0) return false;
  const stmt = db.prepare('SELECT 1 FROM rules WHERE corpus_id = ? AND number = ? LIMIT 1');
  for (const n of ruleNumbers) {
    if (!stmt.get(corpusId, n)) return false;
  }
  return true;
}

/**
 * Lookup-only: the placeholder `extraction_runs` row for hand-drafted
 * unclassified candidates, if one has ever been created. Never creates it -
 * `verifyGoldenCard` (read-only by contract) uses this instead of
 * `goldenDraftingRunId` so that calling `--verify` can never have the side
 * effect of creating an `extraction_runs` row (Critical finding 1, first
 * review pass, is exactly about this run needing to be looked up precisely,
 * not synthesized or assumed).
 */
function goldenDraftingRunIdIfExists(db: DatabaseSync): number | undefined {
  const existing = db
    .prepare("SELECT id FROM extraction_runs WHERE batch_kind = 'golden' AND provider = 'human'")
    .get() as { id: number } | undefined;
  return existing?.id;
}

/**
 * The single placeholder `extraction_runs` row hand-drafted unclassified
 * candidates attach to (plan Task 6 Step 2, item 4: "if no enum type fits,
 * record it as an unclassified candidate rather than forcing a fit").
 * `unclassified_clauses.run_id` is NOT NULL, and the model-driven extraction
 * pipeline that will eventually populate it (Task 9) doesn't exist yet -
 * `extraction_runs.batch_kind`'s CHECK constraint already lists `'golden'`
 * among its values (schema.sql, sec. "runs"), which is exactly this case: a
 * run that represents hand-drafting rather than a model pass. Idempotent - a
 * second call finds and reuses the same row instead of creating a duplicate.
 *
 * CRITICAL (first review pass, finding 1): `verifyGoldenCard`'s coverage check
 * must filter `unclassified_clauses` down to EXACTLY this run's id, not just
 * `(oracle_id, oracle_hash)`. Task 9's model runs will write to the same
 * table with the same `oracle_id`/`oracle_hash` a golden card carries; without
 * a `run_id` filter, a model run reporting "I can't classify this clause" on a
 * golden card would silently satisfy that golden card's OWN coverage
 * requirement - the very audit target validating itself. `golden_atoms` is
 * deliberately not tied to any `run_id` (sec. 8.1); this placeholder row is the
 * one exception, needed only because `unclassified_clauses.run_id` is NOT NULL.
 */
export function goldenDraftingRunId(db: DatabaseSync): number {
  const existing = goldenDraftingRunIdIfExists(db);
  if (existing !== undefined) return existing;

  const corpusId = currentCorpusId(db);
  const schemaVersion = currentSchemaVersion(db);
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO extraction_runs
         (started_at, finished_at, provider, model, schema_version, corpus_id,
          packet_policy_sha, splitter_version, batch_kind, status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(now, now, 'human', 'hand-drafted', schemaVersion, corpusId, 'n/a', SPLITTER_VERSION, 'golden', 'complete');
  return Number(result.lastInsertRowid);
}

/**
 * Records one hand-drafted unclassified candidate (plan Task 6 Step 2, item 4):
 * a clause where no enum type in `atom_types` fits, kept honest instead of being
 * forced into a wrong `type_key` - "a forced fit corrupts the ground truth"
 * (task-6-brief.md Step 2). Writes to `unclassified_clauses` under the
 * `goldenDraftingRunId` placeholder run, NOT to `golden_atoms` - the whole point
 * is that this clause is explicitly NOT being classified as an atom.
 * `verifyGoldenCard`'s coverage check (below) treats a clause overlapped by one
 * of these the same as one overlapped by a golden atom, so a card that uses this
 * escape hatch can still reach `complete`.
 */
export function recordUnclassifiedCandidate(
  db: DatabaseSync,
  input: {
    oracle_id: string;
    face_index: number;
    span_start: number;
    span_end: number;
    quote: string;
    proposed_label: string;
    rationale: string;
    oracle_hash: string;
  },
): void {
  const runId = goldenDraftingRunId(db);
  db.prepare(
    `INSERT INTO unclassified_clauses
       (run_id, oracle_id, face_index, span_start, span_end, quote, proposed_label, rationale, oracle_hash, status)
     VALUES (?,?,?,?,?,?,?,?,?,'open')`,
  ).run(
    runId, input.oracle_id, input.face_index, input.span_start, input.span_end,
    input.quote, input.proposed_label, input.rationale, input.oracle_hash,
  );
}

/** The per-card verification result. `errors` is empty iff `ok`. */
export interface VerifyResult {
  ok: boolean;
  oracle_id: string;
  errors: string[];
  atoms: number;
  non_reminder_clauses: number;
}

/**
 * Validates one drafted golden entry. REJECTS (never warns): a golden entry that
 * does not validate is worse than none, because everything downstream treats it
 * as truth (plan Task 6 Step 3). Checks, always:
 *
 *  - the card has a golden entry
 *  - the golden entry is not STALE: `golden_cards.oracle_hash` matches the
 *    live `cards.oracle_hash` (Important finding 7, first review pass - the
 *    errata protocol `golden-set-procedure.md` documents but that nothing
 *    previously enforced)
 *  - every atom's quote slices back exactly from its face's oracle_text
 *  - every atom's rule_number exists in the current corpus's `rules`
 *  - every (family, type_key) exists in `atom_types` at the current schema_version
 *  - every atom's params validate against that type's params_schema
 *
 * ...and, ONLY when `golden_cards.complete = 1` (Important finding 4, first
 * review pass):
 *
 *  - every non-`reminder` clause is overlapped by >= 1 golden atom OR one
 *    recorded unclassified candidate (`recordUnclassifiedCandidate`)
 *
 * A card recorded `complete = false` is a legitimate, INTENTIONALLY partial
 * golden entry (sec. 8.2 requires partial cards to exist so precision can be
 * restricted to complete ones; sec. 7.5 review corrections are "partial by
 * construction"). Requiring full clause coverage regardless of `complete` would
 * make it impossible to ever commit a partial card, which both contradicts
 * sec. 8.2 and leaves review corrections nowhere to go. `non_reminder_clauses`
 * is still reported for every card (complete or not); only the REJECTION on an
 * uncovered clause is gated.
 *
 * `rule_numbers` and `(family,type_key)` existence are the I2/I3 guarantees:
 * traceable claims anchored to rules the parsed corpus actually contains, and to
 * a type the current vocabulary actually defines.
 */
export function verifyGoldenCard(db: DatabaseSync, oracleId: string): VerifyResult {
  const errors: string[] = [];
  const card = db
    .prepare('SELECT complete, oracle_hash, verified_at FROM golden_cards WHERE oracle_id = ?')
    .get(oracleId) as { complete: number; oracle_hash: string; verified_at: string } | undefined;
  if (!card) {
    return { ok: false, oracle_id: oracleId, errors: ['no golden_cards row for this oracle_id'], atoms: 0, non_reminder_clauses: 0 };
  }

  // Errata check (Important finding 7): a golden entry drafted against text
  // that has since changed (Scryfall errata, a re-parse) is stale ground
  // truth - its spans may point at text that no longer exists. Quote
  // slice-back below catches most drift, but not a card with zero atoms, or a
  // change past every recorded span; comparing hashes directly makes the
  // documented errata invariant (golden-set-procedure.md, "Errata") real.
  const liveCard = db.prepare('SELECT oracle_hash FROM cards WHERE oracle_id = ?').get(oracleId) as
    | { oracle_hash: string }
    | undefined;
  if (liveCard && liveCard.oracle_hash !== card.oracle_hash) {
    errors.push(
      `golden entry is STALE: golden_cards.oracle_hash (${card.oracle_hash}) does not match the ` +
      `live cards.oracle_hash (${liveCard.oracle_hash}) - re-draft against the current oracle_text ` +
      '(see docs/golden-set-procedure.md, "Errata")',
    );
  }

  const corpusId = currentCorpusId(db);
  const schemaVersion = currentSchemaVersion(db);

  const atomRows = db
    .prepare(
      `SELECT face_index, schema_version, family, type_key, params_json,
              span_start, span_end, quote, rule_numbers
         FROM golden_atoms WHERE oracle_id = ?
        ORDER BY face_index, span_start, family, type_key`,
    )
    .all(oracleId) as Array<{
    face_index: number; schema_version: number; family: string; type_key: string;
    params_json: string; span_start: number; span_end: number; quote: string; rule_numbers: string;
  }>;

  const faces = db
    .prepare('SELECT face_index, oracle_text FROM card_faces WHERE oracle_id = ? ORDER BY face_index')
    .all(oracleId) as Array<{ face_index: number; oracle_text: string }>;
  const textByFace = new Map(faces.map((f) => [f.face_index, f.oracle_text]));

  for (const [i, a] of atomRows.entries()) {
    const tag = `atom #${i} (face ${a.face_index} ${a.family}.${a.type_key})`;
    const faceText = textByFace.get(a.face_index) ?? '';
    errors.push(
      ...validateGoldenAtom(
        db, tag, faceText,
        {
          family: a.family, type_key: a.type_key, params: JSON.parse(a.params_json) as Record<string, unknown>,
          span_start: a.span_start, span_end: a.span_end, quote: a.quote,
          rule_numbers: JSON.parse(a.rule_numbers) as string[],
        },
        corpusId, schemaVersion,
      ),
    );
  }

  // Coverage of non-reminder clauses: each must be overlapped by >= 1 golden atom,
  // OR by a recorded unclassified candidate (Step 2 item 4's escape hatch - see
  // recordUnclassifiedCandidate above). CRITICAL (first review pass, finding 1):
  // the unclassified lookup is scoped to the EXACT `goldenDraftingRunId`
  // placeholder run, via the lookup-only `goldenDraftingRunIdIfExists` (verify
  // must not create that row as a side effect). Filtering by `(oracle_id,
  // oracle_hash)` alone is not enough - Task 9's model runs will write to this
  // same table with the same oracle_id/oracle_hash, and without a run_id filter
  // a model run's "I can't classify this" on a golden card would silently
  // satisfy that golden card's own coverage requirement.
  const atomSpans = atomRows.map((a) => ({ face_index: a.face_index, span_start: a.span_start, span_end: a.span_end }));
  const draftingRunId = goldenDraftingRunIdIfExists(db);
  const unclassifiedSpans = draftingRunId === undefined
    ? []
    : (db
        .prepare(
          'SELECT face_index, span_start, span_end FROM unclassified_clauses WHERE oracle_id = ? AND oracle_hash = ? AND run_id = ?',
        )
        .all(oracleId, card.oracle_hash, draftingRunId) as Array<{ face_index: number; span_start: number; span_end: number }>);
  let nonReminder = 0;
  for (const f of faces) {
    for (const c of splitOracleText(f.oracle_text, f.face_index)) {
      if (c.kind === 'reminder') continue;
      nonReminder++;
      if (card.complete !== 1) continue;   // Important finding 4: coverage is only required of COMPLETE cards
      const coveredByAtom = atomSpans.some(
        (a) => a.face_index === c.face_index &&
          overlapLen(a.span_start, a.span_end, c.span_start, c.span_end) > 0,
      );
      const coveredByUnclassified = unclassifiedSpans.some(
        (u) => u.face_index === c.face_index &&
          overlapLen(u.span_start, u.span_end, c.span_start, c.span_end) > 0,
      );
      if (!coveredByAtom && !coveredByUnclassified) {
        const preview = c.text.length > 40 ? c.text.slice(0, 40) + '…' : c.text;
        errors.push(`uncovered clause face ${c.face_index} idx ${c.clause_index}: "${preview}"`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    oracle_id: oracleId,
    errors,
    atoms: atomRows.length,
    non_reminder_clauses: nonReminder,
  };
}