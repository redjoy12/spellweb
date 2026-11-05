/**
 * Per-card verification of an extraction run (plan Task 9): sec. 7.3 coverage, sec. 7.2
 * escalation and voting, sec. 10.3 currency, and the pass/flag/fail verdict that feeds the
 * review queue (queue.ts). No function here calls a model - every verdict is computed from
 * spans and rows the run already wrote.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { SPLITTER_VERSION, persistClauses, splitOracleText, type Clause } from './clauses.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ESCALATION = resolve(here, '../../config/escalation.json');

// ---------- sec. 7.3: coverage ----------

export interface Coverage {
  /** Covered non-reminder clauses over all non-reminder clauses; 1 when there are none. */
  ratio: number;
  uncovered: Array<{ face_index: number; clause_index: number }>;
}

type Span = { face_index: number; span_start: number; span_end: number };

const overlaps = (a: Span, c: Clause) =>
  a.face_index === c.face_index && Math.min(a.span_end, c.span_end) > Math.max(a.span_start, c.span_start);

/** The card's clauses as `prepareRun` fixed them, falling back to the splitter. */
export function cardClauses(db: DatabaseSync, oracleId: string): Clause[] {
  const stored = db.prepare(
    `SELECT face_index, clause_index, span_start, span_end, text, kind FROM clauses
      WHERE oracle_id = ? AND oracle_hash = (SELECT oracle_hash FROM cards WHERE oracle_id = ?)
      ORDER BY face_index, clause_index`,
  ).all(oracleId, oracleId) as unknown as Clause[];
  if (stored.length > 0) return stored;
  const faces = db.prepare('SELECT face_index, oracle_text FROM card_faces WHERE oracle_id = ? ORDER BY face_index')
    .all(oracleId) as Array<{ face_index: number; oracle_text: string }>;
  return faces.flatMap((f) => splitOracleText(f.oracle_text, f.face_index));
}

/**
 * sec. 7.3: every non-reminder clause must be overlapped by at least one accepted atom of this
 * run. A clause the run explicitly declared unclassified counts as covered - the same escape
 * hatch golden verification allows (`verifyGoldenCard`), so the two sides are scored alike.
 *
 * "Accepted" is the run's own verdict, `consensus = 1` (ruling R9-1), not `is_current`: a
 * later run demotes this run's atoms from the card's live set, and scoring this run must not
 * change when that happens.
 */
export function computeCoverage(db: DatabaseSync, runId: number, oracleId: string): Coverage {
  const clauses = cardClauses(db, oracleId);
  const spans = db.prepare(
    `SELECT face_index, span_start, span_end FROM atoms WHERE run_id = ? AND oracle_id = ? AND consensus = 1
     UNION ALL
     SELECT face_index, span_start, span_end FROM unclassified_clauses WHERE run_id = ? AND oracle_id = ?`,
  ).all(runId, oracleId, runId, oracleId) as Span[];

  const counted = clauses.filter((c) => c.kind !== 'reminder');
  const uncovered = counted.filter((c) => !spans.some((s) => overlaps(s, c)))
    .map((c) => ({ face_index: c.face_index, clause_index: c.clause_index }));
  return { ratio: counted.length === 0 ? 1 : (counted.length - uncovered.length) / counted.length, uncovered };
}

// ---------- sec. 7.2: escalation ----------

export interface EscalationConfig {
  /** Passes a voted card gets in total, the first included. */
  passes: number;
  max_counted_clauses: number;
  max_oracle_chars: number;
}

export function loadEscalationConfig(path: string = DEFAULT_ESCALATION): EscalationConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const num = (k: string) => {
    const v = raw[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${path}: "${k}" must be a number`);
    return v;
  };
  const cfg = { passes: num('passes'), max_counted_clauses: num('max_counted_clauses'), max_oracle_chars: num('max_oracle_chars') };
  if (!Number.isInteger(cfg.passes) || cfg.passes < 3 || cfg.passes % 2 === 0) {
    throw new Error(`${path}: "passes" must be an odd integer >= 3 so a majority exists`);
  }
  return cfg;
}

export interface FirstPass {
  coverage: number;
  faces: number;
  layout: string;
  /** Non-reminder clauses - the coverage denominator. */
  clauses: number;
}

/** What `shouldEscalate` needs, read from a finished first pass. */
export function firstPassOf(db: DatabaseSync, runId: number, oracleId: string): FirstPass {
  const card = db.prepare('SELECT layout FROM cards WHERE oracle_id = ?').get(oracleId) as { layout: string } | undefined;
  if (!card) throw new Error(`no card with oracle_id ${oracleId}`);
  const faces = (db.prepare('SELECT COUNT(*) n FROM card_faces WHERE oracle_id = ?').get(oracleId) as { n: number }).n;
  return {
    coverage: computeCoverage(db, runId, oracleId).ratio,
    faces,
    layout: card.layout,
    clauses: cardClauses(db, oracleId).filter((c) => c.kind !== 'reminder').length,
  };
}

/**
 * sec. 7.2. One pass by default; three-pass voting when the first pass left a clause
 * uncovered or the card is structurally complex. The thresholds are config and provisional.
 */
export function shouldEscalate(
  db: DatabaseSync,
  oracleId: string,
  firstPass: FirstPass,
  cfg: EscalationConfig = loadEscalationConfig(),
): boolean {
  if (firstPass.coverage < 1) return true;
  if (firstPass.layout !== 'normal' || firstPass.faces > 1) return true;
  if (firstPass.clauses > cfg.max_counted_clauses) return true;
  const chars = (db.prepare('SELECT COALESCE(SUM(LENGTH(oracle_text)), 0) n FROM card_faces WHERE oracle_id = ?')
    .get(oracleId) as { n: number }).n;
  return chars > cfg.max_oracle_chars;
}

// ---------- sec. 7.2: voting ----------

export interface VoteAtom {
  id: number;
  pass_index: number;
  face_index: number;
  family: string;
  type_key: string;
  span_start: number;
  span_end: number;
}

export interface VoteResult {
  /** One row per consensus cluster: its lowest-pass instance, the one marked current. */
  consensus: Array<VoteAtom & { confidence: number }>;
  /** Mean support (passes holding it / passes run) over the consensus clusters. */
  agreement: number;
  /** Clusters not found by every pass - each one is a nondeterministic miss somewhere. */
  dissent: number;
  /**
   * Consensus clusters some pass missed - the dissent that flags a card (R9-5, amended in Task 11).
   * An atom only a minority found is already dropped by the vote, so it is queued, not flagged.
   */
  majorityDissent: number;
  passes: number;
}

/**
 * Vote matching: same face, family and type_key, and the overlap covers at least half of the
 * LONGER span (ruling R9-3). Half of the shorter span would let a one-character atom inside
 * a twelve-character one count as agreement, which is the opposite of what a vote is for.
 */
export function votesMatch(a: VoteAtom, b: VoteAtom): boolean {
  if (a.face_index !== b.face_index || a.family !== b.family || a.type_key !== b.type_key) return false;
  const inter = Math.min(a.span_end, b.span_end) - Math.max(a.span_start, b.span_start);
  const longer = Math.max(a.span_end - a.span_start, b.span_end - b.span_start);
  return longer > 0 && inter * 2 >= longer;
}

/**
 * sec. 10.3: only the card's newest ANSWER may hold its live set - even an answer that found
 * no atoms, so "the newest run with atoms" is the wrong test. An answer is a verdict row that
 * is not `failed`, or any atom.
 */
function hasNewerAnswer(db: DatabaseSync, oracleId: string, runId: number): boolean {
  return db.prepare(
    `SELECT 1 FROM extraction_results WHERE oracle_id = ? AND run_id > ? AND outcome <> 'failed'
     UNION ALL SELECT 1 FROM atoms WHERE oracle_id = ? AND run_id > ? LIMIT 1`,
  ).get(oracleId, runId, oracleId, runId) !== undefined;
}

/**
 * sec. 7.2 / 10.3. Clusters every pass's atoms for one card, marks the clusters a majority of
 * passes found as the consensus set, and records the verdict: the consensus instance gets
 * `consensus = 1`, the agreement ratio as `confidence`, `confidence_source = 'vote'`, and is
 * current when this run is the card's latest; everything else stays for audit at 0/0.
 * A single-pass card keeps the model's own confidence (`'model'`) and is its own consensus.
 * Idempotent - it recomputes from all of the run's rows every time.
 *
 * `passesRun` is how many passes ANSWERED, which the caller knows from the submitted batches.
 * Inferring it from the atoms undercounts: a pass that found nothing leaves no row, and a
 * 2-of-3 cluster would then look unanimous.
 */
export function reconcileVotes(db: DatabaseSync, runId: number, oracleId: string, passesRun?: number): VoteResult {
  const t = tallyVotes(db, runId, oracleId, passesRun);
  const { passes, winners, support } = t;
  const current = hasNewerAnswer(db, oracleId, runId) ? 0 : 1;

  if (passes <= 1) {
    db.prepare(
      `UPDATE atoms SET consensus = 1, is_current = ?, confidence_source = 'model' WHERE run_id = ? AND oracle_id = ?`,
    ).run(current, runId, oracleId);
    const rows = db.prepare('SELECT confidence FROM atoms WHERE run_id = ? AND oracle_id = ? ORDER BY pass_index, id')
      .all(runId, oracleId) as Array<{ confidence: number }>;
    return {
      consensus: t.atoms.map((a, i) => ({ ...a, confidence: rows[i]!.confidence })), agreement: 1, dissent: 0,
      majorityDissent: 0, passes,
    };
  }

  db.exec('SAVEPOINT reconcile_votes');
  try {
    db.prepare('UPDATE atoms SET consensus = 0, is_current = 0 WHERE run_id = ? AND oracle_id = ?').run(runId, oracleId);
    const mark = db.prepare(
      `UPDATE atoms SET consensus = 1, is_current = ?, confidence = ?, confidence_source = 'vote' WHERE id = ?`,
    );
    for (const c of winners) mark.run(current, support(c) / passes, c[0]!.id);
    db.exec('RELEASE reconcile_votes');
  } catch (err) {
    db.exec('ROLLBACK TO reconcile_votes');
    db.exec('RELEASE reconcile_votes');
    throw err;
  }

  return {
    consensus: winners.map((c) => ({ ...c[0]!, confidence: support(c) / passes })),
    agreement: t.agreement,
    dissent: t.dissent,
    majorityDissent: t.majorityDissent,
    passes,
  };
}

export interface VoteTally {
  atoms: VoteAtom[];
  passes: number;
  clusters: VoteAtom[][];
  winners: VoteAtom[][];
  support: (c: VoteAtom[]) => number;
  agreement: number;
  dissent: number;
  /** Winning clusters some pass missed; see VoteResult.majorityDissent. */
  majorityDissent: number;
  /** Atoms in clusters no majority found - what a vote_disagreement finding points at. */
  outvoted: VoteAtom[];
}

/**
 * The vote, computed without writing. `consensus = 0` on a row cannot tell an outvoted atom
 * from a later pass's agreeing duplicate (both are kept for audit), so anything that needs
 * the dissent - the queue, the inspector - recounts it here.
 */
export function tallyVotes(db: DatabaseSync, runId: number, oracleId: string, passesRun?: number): VoteTally {
  const atoms = db.prepare(
    `SELECT id, pass_index, face_index, family, type_key, span_start, span_end FROM atoms
      WHERE run_id = ? AND oracle_id = ? ORDER BY pass_index, id`,
  ).all(runId, oracleId) as unknown as VoteAtom[];
  const passes = Math.max(passesRun ?? 0, new Set(atoms.map((a) => a.pass_index)).size);

  // Greedy clustering in (pass, id) order: an atom joins the first cluster whose first member
  // it matches and that has no member from its own pass yet.
  const clusters: VoteAtom[][] = [];
  for (const a of atoms) {
    const home = clusters.find((c) => votesMatch(c[0]!, a) && !c.some((m) => m.pass_index === a.pass_index));
    if (home) home.push(a);
    else clusters.push([a]);
  }
  const support = (c: VoteAtom[]) => new Set(c.map((m) => m.pass_index)).size;
  const winners = passes <= 1 ? clusters : clusters.filter((c) => support(c) * 2 > passes);
  return {
    atoms, passes, clusters, winners, support,
    agreement: passes <= 1 ? 1 : winners.length === 0 ? (atoms.length === 0 ? 1 : 0)
      : winners.reduce((s, c) => s + support(c), 0) / (winners.length * passes),
    dissent: passes <= 1 ? 0 : clusters.filter((c) => support(c) < passes).length,
    majorityDissent: passes <= 1 ? 0 : winners.filter((c) => support(c) < passes).length,
    outvoted: passes <= 1 ? [] : clusters.filter((c) => !winners.includes(c)).flat(),
  };
}

// ---------- sec. 10.3: currency ----------

/**
 * sec. 10.3. An atom whose oracle_hash differs from its card's was read from text that no
 * longer exists: its spans point into the old string, so the inspector would highlight the
 * wrong substring. Demote and requeue. Called at the start of every run.
 */
export function reconcileErrata(db: DatabaseSync): { demoted: number; requeued: number } {
  const stale = db.prepare(
    `SELECT DISTINCT a.oracle_id FROM atoms a JOIN cards c USING (oracle_id)
      WHERE a.is_current = 1 AND a.oracle_hash <> c.oracle_hash`,
  ).all() as Array<{ oracle_id: string }>;

  db.exec('BEGIN');
  try {
    let demoted = 0;
    let requeued = 0;
    const now = new Date().toISOString();
    for (const { oracle_id } of stale) {
      demoted += Number(db.prepare(
        `UPDATE atoms SET is_current = 0 WHERE oracle_id = ? AND is_current = 1`,
      ).run(oracle_id).changes);
      // The partial unique index (one pending row per card) makes a second call a no-op.
      requeued += Number(db.prepare(
        `INSERT INTO extraction_queue (oracle_id, reason, enqueued_at) VALUES (?, 'oracle_changed', ?)
         ON CONFLICT DO NOTHING`,
      ).run(oracle_id, now).changes);
    }
    db.exec('COMMIT');
    return { demoted, requeued };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

/**
 * sec. 5.2. After a splitter fix bumps SPLITTER_VERSION, every stored split from an older
 * version is wrong by definition: re-split those cards, and requeue the ones that were
 * extracted against the old split (reason `splitter_changed`). Cards never extracted only
 * need the new split. Called at the start of every run, after reconcileErrata.
 */
export function reconcileSplitterVersion(
  db: DatabaseSync,
  version: number = SPLITTER_VERSION,
): { resplit: number; requeued: number } {
  const old = db.prepare(
    `SELECT DISTINCT cl.oracle_id, c.oracle_hash FROM clauses cl JOIN cards c USING (oracle_id)
      WHERE cl.splitter_version < ?`,
  ).all(version) as Array<{ oracle_id: string; oracle_hash: string }>;
  const extracted = db.prepare('SELECT 1 FROM atoms WHERE oracle_id = ? AND is_current = 1 LIMIT 1');
  const requeue = db.prepare(
    `INSERT INTO extraction_queue (oracle_id, reason, enqueued_at) VALUES (?, 'splitter_changed', ?)
     ON CONFLICT DO NOTHING`,
  );
  let requeued = 0;
  const now = new Date().toISOString();
  for (const { oracle_id, oracle_hash } of old) {
    persistClauses(db, oracle_id, oracle_hash, version);
    if (extracted.get(oracle_id)) requeued += Number(requeue.run(oracle_id, now).changes);
  }
  return { resplit: old.length, requeued };
}

// ---------- the verdict ----------

export type Outcome = 'passed' | 'flagged' | 'failed';

/** sec. 7.4's rank key: atoms that will become graph edges. */
const CONNECTIVE = "('PRODUCES','ENABLES','CARES_ABOUT')";

export function connectiveAtomCount(db: DatabaseSync, runId: number, oracleId: string): number {
  return (db.prepare(
    `SELECT COUNT(*) n FROM atoms WHERE run_id = ? AND oracle_id = ? AND consensus = 1 AND family IN ${CONNECTIVE}`,
  ).get(runId, oracleId) as { n: number }).n;
}

/**
 * The card's verdict for this run, written to `extraction_results`. `failed` is sticky: a card
 * `recordFailedCard` marked never had an answer to judge. Otherwise the card is `flagged` when
 * it carries a finding that says its atoms are known-incomplete or unstable - an uncovered
 * clause (sec. 7.3's 100% bar), a missing-rule report (sec. 6.4), or a consensus atom some pass
 * missed - and `passed` when it does not. An atom only a minority of passes found does not flag:
 * the vote already dropped it, and its vote_disagreement finding is still queued (R9-5, amended
 * in Task 11). Unclassified clauses and splitter disagreements still
 * go to the review queue but do not flag: the first counts as covered, the second loses no data.
 */
export function finaliseCard(
  db: DatabaseSync,
  runId: number,
  oracleId: string,
  opts: { packetChars?: number; passesRun?: number } = {},
): Outcome {
  const prior = db.prepare('SELECT outcome, packet_chars FROM extraction_results WHERE run_id = ? AND oracle_id = ?')
    .get(runId, oracleId) as { outcome: Outcome; packet_chars: number } | undefined;
  if (prior?.outcome === 'failed') return 'failed';

  const vote = reconcileVotes(db, runId, oracleId, opts.passesRun);
  const coverage = computeCoverage(db, runId, oracleId);
  const missing = (db.prepare('SELECT COUNT(*) n FROM missing_rule_reports WHERE run_id = ? AND oracle_id = ?')
    .get(runId, oracleId) as { n: number }).n;
  const outcome: Outcome = coverage.ratio < 1 || missing > 0 || vote.majorityDissent > 0 ? 'flagged' : 'passed';

  db.prepare(
    `INSERT INTO extraction_results (run_id, oracle_id, coverage_ratio, uncovered_clauses_json, passes_run,
       vote_agreement, connective_atom_count, packet_chars, packet_tokens, outcome, failure_detail)
     VALUES (?,?,?,?,?,?,?,?,0,?,NULL)
     ON CONFLICT(run_id, oracle_id) DO UPDATE SET
       coverage_ratio = excluded.coverage_ratio, uncovered_clauses_json = excluded.uncovered_clauses_json,
       passes_run = excluded.passes_run, vote_agreement = excluded.vote_agreement,
       connective_atom_count = excluded.connective_atom_count, packet_chars = excluded.packet_chars,
       outcome = excluded.outcome`,
  ).run(runId, oracleId, coverage.ratio, JSON.stringify(coverage.uncovered), Math.max(vote.passes, 1),
    vote.passes > 1 ? vote.agreement : null, connectiveAtomCount(db, runId, oracleId),
    opts.packetChars ?? prior?.packet_chars ?? 0, outcome);

  // sec. 10.3: the newest answer owns the live set even when it found nothing. persistValidated
  // demotes on insert; this covers a verdict written later (`finaliseRun` on an old run).
  if (!hasNewerAnswer(db, oracleId, runId)) {
    db.prepare('UPDATE atoms SET is_current = 0 WHERE oracle_id = ? AND run_id < ? AND is_current = 1').run(oracleId, runId);
  }

  db.prepare(
    `UPDATE extraction_runs SET cards_passed =
       (SELECT COUNT(*) FROM extraction_results WHERE run_id = ? AND outcome = 'passed') WHERE id = ?`,
  ).run(runId, runId);
  return outcome;
}
