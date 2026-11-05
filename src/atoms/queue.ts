/**
 * The review queue (sec. 7.4, 11.2) and the three feedback loops that turn a reviewer's
 * decision into a systematic fix (sec. 3.4, 4.3, 5.2), plus the correction path (sec. 7.5).
 *
 * One queue row per FINDING, not per card: a bad split causing uncovered clauses is the
 * expected correlation, so one card routinely holds several. Ordering is `severity_rank`
 * then `rank_score` descending - never the text label, which sorts the lowest-severity
 * bucket second.
 */
import type { DatabaseSync } from 'node:sqlite';
import { cardMatchText, phraseTokens, type PacketPolicy } from '../rules/relevance.js';
import { packetPolicyShaWithKernel } from '../rules/kernel.js';
import { isCovered, renderRule, termSelection, type CorePacketConfig } from '../rules/packet.js';
import { currentSchemaVersion } from './schema.js';
import { currentCorpusId, validateGoldenAtom } from './golden.js';
import { tallyVotes } from './verify.js';

export const SEVERITY_RANK = {
  coverage_miss: 1,
  missing_rule: 2,
  vote_disagreement: 3,
  unclassified: 4,
  splitter_disagreement: 5,
} as const;

export type Severity = keyof typeof SEVERITY_RANK;

/** Where each severity's detail lives - the target of sec. 11.2's deep link. */
const DETAIL_TABLE: Record<Severity, string> = {
  coverage_miss: 'extraction_results',
  missing_rule: 'missing_rule_reports',
  vote_disagreement: 'extraction_results',
  unclassified: 'unclassified_clauses',
  splitter_disagreement: 'splitter_disagreements',
};

/**
 * Writes one queue row per finding the card's verdict for this run carries. Idempotent: the
 * unique index review_queue_finding absorbs a second call. Pending
 * findings from the card's OLDER runs are resolved here - they describe atoms this run has
 * just replaced, and a deep link into them would land on atoms the inspector no longer shows;
 * for the same reason a run that a newer verdict has superseded enqueues nothing. A failed
 * card has no verdict to review; it stays on the extraction queue instead.
 * Returns the number of rows inserted.
 */
export function enqueueFindings(db: DatabaseSync, runId: number, oracleId: string): number {
  const result = db.prepare(
    `SELECT rowid AS id, coverage_ratio, passes_run, vote_agreement, connective_atom_count, outcome
       FROM extraction_results WHERE run_id = ? AND oracle_id = ?`,
  ).get(runId, oracleId) as {
    id: number; coverage_ratio: number; passes_run: number; vote_agreement: number | null;
    connective_atom_count: number; outcome: string;
  } | undefined;
  if (!result || result.outcome === 'failed') return 0;
  // A newer verdict exists: this run's findings describe atoms that are no longer the card's.
  if (db.prepare("SELECT 1 FROM extraction_results WHERE oracle_id = ? AND run_id > ? AND outcome <> 'failed' LIMIT 1")
    .get(oracleId, runId)) return 0;

  const findings: Array<{ severity: Severity; detailId: number }> = [];
  if (result.coverage_ratio < 1) findings.push({ severity: 'coverage_miss', detailId: result.id });
  if (result.passes_run > 1 && tallyVotes(db, runId, oracleId, result.passes_run).dissent > 0) {
    findings.push({ severity: 'vote_disagreement', detailId: result.id });
  }
  const ids = (sql: string) => (db.prepare(sql).all(runId, oracleId) as Array<{ id: number }>).map((r) => r.id);
  for (const id of ids('SELECT id FROM missing_rule_reports WHERE run_id = ? AND oracle_id = ? ORDER BY id')) {
    findings.push({ severity: 'missing_rule', detailId: id });
  }
  for (const id of ids("SELECT id FROM unclassified_clauses WHERE run_id = ? AND oracle_id = ? AND status = 'open' ORDER BY id")) {
    findings.push({ severity: 'unclassified', detailId: id });
  }
  for (const id of ids("SELECT id FROM splitter_disagreements WHERE run_id = ? AND oracle_id = ? AND status = 'open' ORDER BY id")) {
    findings.push({ severity: 'splitter_disagreement', detailId: id });
  }

  db.prepare("UPDATE review_queue SET status = 'resolved' WHERE domain = 'atom' AND oracle_id = ? AND run_id < ? AND status = 'pending'")
    .run(oracleId, runId);
  // Ruling R13-2: a voted card is enqueued twice in one run - at pass 0, then on its final
  // verdict. A verdict-level finding (coverage_miss, vote_disagreement) the final verdict no
  // longer carries described the pass-0 verdict, which the vote replaced; retire it.
  const carried = findings.filter((f) => DETAIL_TABLE[f.severity] === 'extraction_results').map((f) => f.severity);
  db.prepare(
    `UPDATE review_queue SET status = 'resolved'
      WHERE domain = 'atom' AND oracle_id = ? AND run_id = ? AND detail_table = 'extraction_results' AND status = 'pending'
        AND severity NOT IN (SELECT value FROM json_each(?))`,
  ).run(oracleId, runId, JSON.stringify(carried));
  const ins = db.prepare(
    `INSERT INTO review_queue (domain, oracle_id, run_id, severity, severity_rank, rank_score, detail_table, detail_id, enqueued_at)
     VALUES ('atom',?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
  );
  const now = new Date().toISOString();
  const rank = degreeRankScore(db, oracleId) ?? result.connective_atom_count;
  let n = 0;
  for (const f of findings) {
    n += Number(ins.run(oracleId, runId, f.severity, SEVERITY_RANK[f.severity], rank,
      DETAIL_TABLE[f.severity], f.detailId, now).changes);
  }
  return n;
}

// ---------- the rank key (Phase 3 spec sec. 14.2) ----------

/**
 * Phase 3 spec sec. 14.2: the rank key of an `atom` finding is `out_degree + in_degree +
 * class_edges` from the latest graph build that holds the card. Null when no build holds it;
 * the caller then uses the Phase 2 key, the connective-atom count.
 */
export function degreeRankScore(db: DatabaseSync, oracleId: string): number | null {
  const r = db.prepare(
    'SELECT out_degree + in_degree + class_edges AS n FROM card_degree WHERE oracle_id = ? ORDER BY build_id DESC LIMIT 1',
  ).get(oracleId) as { n: number } | undefined;
  return r?.n ?? null;
}

/**
 * Sets the rank key of every PENDING `atom` finding again, after a new build (sec. 14.2).
 * Resolved rows and `edge` rows keep their rank. Returns the number of rows changed.
 */
export function rerankAtomQueue(db: DatabaseSync): number {
  const rows = db.prepare(
    `SELECT q.id, q.oracle_id, q.rank_score, e.connective_atom_count
       FROM review_queue q LEFT JOIN extraction_results e ON e.run_id = q.run_id AND e.oracle_id = q.oracle_id
      WHERE q.domain = 'atom' AND q.status = 'pending' ORDER BY q.id`,
  ).all() as Array<{ id: number; oracle_id: string; rank_score: number; connective_atom_count: number | null }>;
  const set = db.prepare('UPDATE review_queue SET rank_score = ? WHERE id = ?');
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const rank = degreeRankScore(db, r.oracle_id) ?? r.connective_atom_count ?? r.rank_score;
      if (rank !== r.rank_score) n += Number(set.run(rank, r.id).changes);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return n;
}

// ---------- reading the queue ----------

export interface QueueFinding {
  id: number;
  oracle_id: string;
  name: string;
  run_id: number;
  severity: Severity;
  severity_rank: number;
  rank_score: number;
  /** What rank_score counts (Phase 3 sec. 14.2): the card's degree in a build, or the Phase 2 key. */
  rank_key: 'degree' | 'connective';
  detail_table: string | null;
  detail_id: number | null;
  status: 'pending' | 'resolved';
  enqueued_at: string;
  /** One line saying what the finding is, from its detail row. */
  summary: string;
  /** Face + span the inspector should outline, when the finding has one. */
  focus: Array<{ face_index: number; span_start: number; span_end: number }>;
  /** The detail row itself, for the action forms. */
  detail: Record<string, unknown> | null;
}

const RANK_KEY = `CASE WHEN EXISTS (SELECT 1 FROM card_degree d WHERE d.oracle_id = q.oracle_id) THEN 'degree' ELSE 'connective' END AS rank_key`;

/** The detail row a finding points at, with what the UI needs to show and act on it. */
function describe(db: DatabaseSync, f: { oracle_id: string; run_id: number; severity: Severity; detail_id: number | null }) {
  const one = (sql: string) => (f.detail_id === null ? undefined
    : db.prepare(sql).get(f.detail_id) as Record<string, unknown> | undefined) ?? null;
  const clauseSpans = (list: Array<{ face_index: number; clause_index: number }>) => {
    const q = db.prepare('SELECT span_start, span_end FROM clauses WHERE oracle_id = ? AND face_index = ? AND clause_index = ?');
    return list.flatMap((c) => {
      const s = q.get(f.oracle_id, c.face_index, c.clause_index) as { span_start: number; span_end: number } | undefined;
      return s ? [{ face_index: c.face_index, ...s }] : [];
    });
  };
  switch (f.severity) {
    case 'coverage_miss': {
      const d = one('SELECT coverage_ratio, uncovered_clauses_json FROM extraction_results WHERE rowid = ?');
      const list = d ? JSON.parse(String(d['uncovered_clauses_json'])) as Array<{ face_index: number; clause_index: number }> : [];
      const pct = Number(d?.['coverage_ratio'] ?? 0).toLocaleString('en', { style: 'percent', maximumFractionDigits: 0 });
      return { detail: d, focus: clauseSpans(list),
        summary: `${list.length} clause${list.length === 1 ? '' : 's'} with no atom (coverage ${pct})` };
    }
    case 'vote_disagreement': {
      const d = one('SELECT vote_agreement, passes_run FROM extraction_results WHERE rowid = ?');
      const t = tallyVotes(db, f.run_id, f.oracle_id, Number(d?.['passes_run'] ?? 0));
      // Every cluster some pass missed: outvoted ones and majority ones that were not unanimous.
      const split = t.clusters.filter((c) => t.support(c) < t.passes);
      return { detail: { ...d, outvoted: t.outvoted.map((a) => `${a.family} ${a.type_key} (pass ${a.pass_index})`) },
        focus: split.map((c) => ({ face_index: c[0]!.face_index, span_start: c[0]!.span_start, span_end: c[0]!.span_end })),
        summary: `passes disagreed on ${split.length} atom(s): agreement ${Number(d?.['vote_agreement'] ?? 0).toFixed(2)} ` +
          `over ${t.passes} passes, ${t.outvoted.length} outvoted` };
    }
    case 'missing_rule': {
      const d = one('SELECT id, face_index, quote, statement, resolved_rule, status FROM missing_rule_reports WHERE id = ?');
      return { detail: d, focus: [], summary: d ? String(d['statement']) : 'report missing' };
    }
    case 'unclassified': {
      const d = one('SELECT id, face_index, span_start, span_end, quote, proposed_label, rationale, status FROM unclassified_clauses WHERE id = ?');
      return { detail: d,
        focus: d ? [{ face_index: Number(d['face_index']), span_start: Number(d['span_start']), span_end: Number(d['span_end']) }] : [],
        summary: d ? `no type fits: proposed ${String(d['proposed_label'])}` : 'row missing' };
    }
    case 'splitter_disagreement': {
      const d = one('SELECT id, face_index, quote, note, splitter_version, status FROM splitter_disagreements WHERE id = ?');
      return { detail: d, focus: [], summary: d ? String(d['note']) : 'row missing' };
    }
  }
}

/**
 * The ranked queue (sec. 7.4): severity_rank, then rank_score, then age. Since Phase 3 the rank_score
 * is the card's degree in the latest build, or the connective-atom count without one (sec. 14.2).
 */
export function listFindings(db: DatabaseSync, status: 'pending' | 'resolved' | 'all' = 'pending'): QueueFinding[] {
  const rows = db.prepare(
    `SELECT q.id, q.oracle_id, c.name, q.run_id, q.severity, q.severity_rank, q.rank_score, ${RANK_KEY},
            q.detail_table, q.detail_id, q.status, q.enqueued_at
       FROM review_queue q JOIN cards c USING (oracle_id)
      WHERE q.domain = 'atom' AND (? = 'all' OR q.status = ?)
      ORDER BY q.severity_rank, q.rank_score DESC, q.id`,
  ).all(status, status) as unknown as Array<Omit<QueueFinding, 'summary' | 'focus' | 'detail'>>;
  return rows.map((r) => ({ ...r, ...describe(db, r) }));
}

export function getFinding(db: DatabaseSync, id: number): QueueFinding {
  const r = db.prepare(
    `SELECT q.id, q.oracle_id, c.name, q.run_id, q.severity, q.severity_rank, q.rank_score, ${RANK_KEY},
            q.detail_table, q.detail_id, q.status, q.enqueued_at
       FROM review_queue q JOIN cards c USING (oracle_id) WHERE q.id = ? AND q.domain = 'atom'`,
  ).get(id) as unknown as Omit<QueueFinding, 'summary' | 'focus' | 'detail'> | undefined;
  if (!r) throw new ReviewError(`no finding ${id}`, 'not_found');
  return { ...r, ...describe(db, r) };
}

/** A refusal, with this message; the route maps `kind` to an HTTP status. */
export class ReviewError extends Error {
  constructor(message: string, readonly kind: 'invalid' | 'not_found' = 'invalid') { super(message); }
}

function resolveFindingsFor(db: DatabaseSync, table: string, detailId: number): void {
  db.prepare("UPDATE review_queue SET status = 'resolved' WHERE domain = 'atom' AND detail_table = ? AND detail_id = ? AND status = 'pending'")
    .run(table, detailId);
}

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- action 1: accept as correct ----------

/**
 * sec. 11.2 "accept as correct": the extraction stands as it is. The finding is resolved, and
 * an escape-hatch row behind it is closed as `rejected` - the rule was not needed, no new type
 * is wanted, the split is fine - so it stops counting as an open report.
 */
export function acceptAsCorrect(db: DatabaseSync, findingId: number): void {
  const f = getFinding(db, findingId);
  if (f.status !== 'pending') throw new ReviewError(`finding ${findingId} is already resolved`);
  inTransaction(db, () => {
    db.prepare("UPDATE review_queue SET status = 'resolved' WHERE id = ? AND domain = 'atom'").run(findingId);
    if (f.detail_id !== null && (f.severity === 'missing_rule' || f.severity === 'unclassified' || f.severity === 'splitter_disagreement')) {
      db.prepare(`UPDATE ${DETAIL_TABLE[f.severity]} SET status = 'rejected' WHERE id = ? AND status = 'open'`).run(f.detail_id);
    }
  });
}

// ---------- action 2: correct an atom (sec. 7.5) ----------

export interface Correction {
  face_index: number;
  family: string;
  type_key: string;
  params: Record<string, unknown>;
  quote: string;
  /** Needed only when the quote occurs more than once in the face. */
  span_start?: number;
  rule_numbers: string[];
}

/**
 * sec. 7.5: a reviewer's correction becomes a permanent `golden_atoms` row with
 * `source = 'review_correction'`, so the next scoring run measures against it and the next
 * `kernel:derive` sees its citations. It is validated exactly like an authored golden atom
 * (quote slices back, rules exist, type and params are valid). A card with no golden record
 * gets a PARTIAL one (`complete = 0`): a correction says what one atom should be, never that
 * the card's atom list is exhaustive (sec. 8.2's precision rule).
 */
export function recordCorrection(db: DatabaseSync, oracleId: string, c: Correction): number {
  const card = db.prepare('SELECT oracle_hash FROM cards WHERE oracle_id = ?').get(oracleId) as { oracle_hash: string } | undefined;
  if (!card) throw new ReviewError(`no card ${oracleId}`, 'not_found');
  const face = db.prepare('SELECT oracle_text FROM card_faces WHERE oracle_id = ? AND face_index = ?')
    .get(oracleId, c.face_index) as { oracle_text: string } | undefined;
  if (!face) throw new ReviewError(`card has no face ${c.face_index}`);
  if (!c.quote) throw new ReviewError('the quote is empty');

  const hits: number[] = [];
  for (let i = face.oracle_text.indexOf(c.quote); i !== -1; i = face.oracle_text.indexOf(c.quote, i + 1)) hits.push(i);
  if (hits.length === 0) throw new ReviewError(`the quote is not verbatim in face ${c.face_index}'s text`);
  let start: number;
  if (c.span_start !== undefined) {
    if (!hits.includes(c.span_start)) throw new ReviewError(`the quote does not start at ${c.span_start}`);
    start = c.span_start;
  } else if (hits.length > 1) {
    throw new ReviewError(`the quote occurs ${hits.length} times; give span_start (one of ${hits.join(', ')})`);
  } else {
    start = hits[0]!;
  }

  const atom = { family: c.family, type_key: c.type_key, params: c.params, span_start: start,
    span_end: start + c.quote.length, quote: c.quote, rule_numbers: c.rule_numbers };
  const corpusId = currentCorpusId(db);
  const schemaVersion = currentSchemaVersion(db);
  if (c.rule_numbers.length === 0) throw new ReviewError('cite at least one rule');
  const errors = validateGoldenAtom(db, 'correction', face.oracle_text, atom, corpusId, schemaVersion);
  if (errors.length > 0) throw new ReviewError(errors.join('; '));

  return inTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO golden_cards (oracle_id, complete, oracle_hash, verified_at) VALUES (?, 0, ?, ?)
       ON CONFLICT(oracle_id) DO NOTHING`,
    ).run(oracleId, card.oracle_hash, now);
    try {
      return Number(db.prepare(
        `INSERT INTO golden_atoms (oracle_id, face_index, schema_version, family, type_key, params_json, span_start,
           span_end, quote, rule_numbers, oracle_hash, source, verified_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'review_correction', ?)`,
      ).run(oracleId, c.face_index, schemaVersion, c.family, c.type_key, JSON.stringify(c.params), atom.span_start,
        atom.span_end, c.quote, JSON.stringify(c.rule_numbers), card.oracle_hash, now).lastInsertRowid);
    } catch (err) {
      if (/UNIQUE/.test((err as Error).message)) {
        throw new ReviewError(`the golden set already holds a ${c.family} ${c.type_key} at this span`);
      }
      throw err;
    }
  });
}

// ---------- action 3: promote an unclassified type (sec. 4.3) ----------

export interface PromotedType {
  family: 'PRODUCES' | 'CARES_ABOUT' | 'ENABLES' | 'COMBAT' | 'INTERACTION' | 'CONSTRAINTS';
  type_key: string;
  label: string;
  /** Defaults to "no params". */
  params_schema?: Record<string, unknown>;
  /** The reviewer's reason; the clause's own quote and rationale are appended. */
  evidence: string;
}

const NO_PARAMS = { type: 'object', properties: {}, additionalProperties: false };

/**
 * sec. 4.3. Promotes a recurring unclassified clause into the enum: the whole vocabulary is
 * copied to `schema_version + 1` with the new type added (`provenance = 'review_promoted'`) -
 * a published version is never edited (schema.ts). The clause is marked `promoted`, and every
 * card holding an OPEN unclassified row with the same proposed label is requeued with reason
 * `schema_promoted`, so it is re-read against a vocabulary that now has a word for it.
 */
export function promoteAtomType(
  db: DatabaseSync,
  unclassifiedId: number,
  def: PromotedType,
): { schemaVersion: number; requeued: number } {
  const u = db.prepare('SELECT oracle_id, quote, proposed_label, rationale, status FROM unclassified_clauses WHERE id = ?')
    .get(unclassifiedId) as { oracle_id: string; quote: string; proposed_label: string; rationale: string; status: string } | undefined;
  if (!u) throw new ReviewError(`no unclassified clause ${unclassifiedId}`, 'not_found');
  if (u.status !== 'open') throw new ReviewError(`unclassified clause ${unclassifiedId} is already ${u.status}`);
  if (!/^[A-Z][A-Z0-9_]*$/.test(def.type_key)) throw new ReviewError('type_key must be UPPER_SNAKE_CASE');
  if (!def.label.trim() || !def.evidence.trim()) throw new ReviewError('label and evidence are required');

  const from = currentSchemaVersion(db);
  const to = from + 1;
  if (db.prepare('SELECT 1 FROM atom_types WHERE schema_version = ? AND family = ? AND type_key = ?').get(from, def.family, def.type_key)) {
    throw new ReviewError(`${def.family} ${def.type_key} already exists at v${from}`);
  }
  const label = u.proposed_label.trim().toLowerCase();
  const matching = (db.prepare(
    "SELECT DISTINCT oracle_id FROM unclassified_clauses WHERE status = 'open' AND lower(trim(proposed_label)) = ?",
  ).all(label) as Array<{ oracle_id: string }>).map((r) => r.oracle_id);

  return inTransaction(db, () => {
    db.prepare(
      `INSERT INTO atom_types (schema_version, family, type_key, label, params_schema, provenance, evidence)
       SELECT ?, family, type_key, label, params_schema, provenance, evidence FROM atom_types WHERE schema_version = ?`,
    ).run(to, from);
    db.prepare(
      `INSERT INTO atom_types (schema_version, family, type_key, label, params_schema, provenance, evidence)
       VALUES (?,?,?,?,?, 'review_promoted', ?)`,
    ).run(to, def.family, def.type_key, def.label.trim(), JSON.stringify(def.params_schema ?? NO_PARAMS),
      `${def.evidence.trim()} [sec. 4.3 promotion from unclassified #${unclassifiedId}: "${u.quote}" - ${u.rationale}]`);
    db.prepare("UPDATE unclassified_clauses SET status = 'promoted' WHERE id = ?").run(unclassifiedId);
    resolveFindingsFor(db, 'unclassified_clauses', unclassifiedId);

    const requeue = db.prepare(
      `INSERT INTO extraction_queue (oracle_id, reason, enqueued_at) VALUES (?, 'schema_promoted', ?) ON CONFLICT DO NOTHING`,
    );
    const now = new Date().toISOString();
    let requeued = 0;
    for (const id of new Set([u.oracle_id, ...matching])) requeued += Number(requeue.run(id, now).changes);
    return { schemaVersion: to, requeued };
  });
}

// ---------- action 4: accept a missing-rule report (sec. 3.4, 6.4) ----------

export interface MissingRuleAcceptance {
  /** False when the rule was already in the kernel (then no card's packet changes). */
  kernelAdded: boolean;
  requeued: number;
  /** The construct phrases the requeue matched on (see `cardsReachedByKernelRule`). */
  phrases: string[];
  policySha: { before: string; after: string };
}

export interface KernelRuleReach {
  /** Stemmed word sequences shared by the rule's text and an accepted report's quote. */
  phrases: string[];
  /** Cards whose own report for this rule was accepted. */
  reporters: string[];
  /** Extracted cards (current atoms) the rule reaches and term selection does not cover, sorted. */
  oracleIds: string[];
}

const MIN_PHRASE_WORDS = 2;

/** The longest word sequences (at least MIN_PHRASE_WORDS) that `quote` shares with any of `ruleTexts`. */
function sharedPhrases(quote: string[], ruleTexts: string[][]): string[] {
  const grams = (ts: string[], n: number) => {
    const out = new Set<string>();
    for (let i = 0; i + n <= ts.length; i++) out.add(ts.slice(i, i + n).join(' '));
    return out;
  };
  for (let n = quote.length; n >= MIN_PHRASE_WORDS; n--) {
    const inRule = new Set(ruleTexts.flatMap((t) => [...grams(t, n)]));
    const shared = [...grams(quote, n)].filter((g) => inRule.has(g));
    if (shared.length > 0) return shared;
  }
  return [];
}

/**
 * Ruling R13-1: which extracted cards a newly kernelled rule actually concerns. Every packet
 * carries the kernel, so "the packet changes" is true of nearly every card and cannot narrow
 * a requeue; and the term index cannot either, because a rule is reported missing exactly
 * when no term in the card reaches it. What does tie a rule to card text, mechanically, is
 * the report itself: its quote is card text the extractor could not handle without the rule.
 *
 * So a card is reached when it filed an accepted report for the rule, or its text (faces and
 * type line, `cardMatchText`) contains a CONSTRUCT PHRASE: a longest word sequence of at
 * least two words that an accepted report's quote shares with the rule's own rendered text,
 * compared stem by stem (`phraseTokens`). A quote sharing no such sequence with the rule
 * contributes no phrase, and then only its reporter is reached. Cards whose term selection
 * already covers the rule are dropped - their packet does not change.
 *
 * `extra` holds reports being accepted right now (not yet marked accepted in the table).
 */
export function cardsReachedByKernelRule(
  db: DatabaseSync,
  corpusId: number,
  rule: string,
  extra: Array<{ oracle_id: string; quote: string }>,
  policy: PacketPolicy,
  config?: CorePacketConfig,
): KernelRuleReach {
  const reports = [
    ...(db.prepare("SELECT oracle_id, quote FROM missing_rule_reports WHERE status = 'accepted' AND resolved_rule = ?")
      .all(rule) as Array<{ oracle_id: string; quote: string }>),
    ...extra,
  ];
  const ruleTexts = (renderRule(db, corpusId, rule)?.rules ?? []).map((r) => phraseTokens(r.text, policy));
  const phrases = [...new Set(reports.flatMap((r) => sharedPhrases(phraseTokens(r.quote, policy), ruleTexts)))].sort();
  const reporters = [...new Set(reports.map((r) => r.oracle_id))].sort();

  const extracted = (db.prepare('SELECT DISTINCT oracle_id FROM atoms WHERE is_current = 1 ORDER BY oracle_id').all() as
    Array<{ oracle_id: string }>).map((r) => r.oracle_id);
  const oracleIds = extracted.filter((id) => {
    if (!reporters.includes(id)) {
      const text = ` ${phraseTokens(cardMatchText(db, id).text, policy).join(' ')} `;
      if (!phrases.some((p) => text.includes(` ${p} `))) return false;
    }
    const rendered = new Set(termSelection(db, corpusId, id, policy, config).sections.map((s) => s.number));
    return !isCovered(rendered, rule);
  });
  return { phrases, reporters, oracleIds };
}

/**
 * sec. 3.4 / 6.4, the highest-leverage action in the queue: the reported rule joins the
 * kernel (`origin = 'review_promoted'`), so every card's packet carries it from now on - a
 * systematic fix for every card sharing the text shape, not just this one. The kernel-aware
 * policy hash changes accordingly. Only the extracted cards the rule actually concerns
 * (`cardsReachedByKernelRule`, ruling R13-1) are requeued with `kernel_changed`; the rest keep
 * their current atoms, which the rule's text would not have changed. Cards not yet extracted
 * need nothing: they will be assembled with the new kernel anyway.
 */
export function acceptMissingRule(
  db: DatabaseSync,
  reportId: number,
  ruleNumber: string,
  policy: PacketPolicy,
  config?: CorePacketConfig,
): MissingRuleAcceptance {
  const report = db.prepare(
    `SELECT m.id, m.run_id, m.oracle_id, m.quote, m.statement, m.status, c.name
       FROM missing_rule_reports m JOIN cards c USING (oracle_id) WHERE m.id = ?`,
  ).get(reportId) as { id: number; run_id: number; oracle_id: string; quote: string; statement: string; status: string; name: string } | undefined;
  if (!report) throw new ReviewError(`no missing-rule report ${reportId}`, 'not_found');
  if (report.status !== 'open') throw new ReviewError(`missing-rule report ${reportId} is already ${report.status}`);
  const rule = ruleNumber.trim();
  const corpusId = currentCorpusId(db);
  const exists = db.prepare('SELECT 1 FROM rules WHERE corpus_id = ? AND number = ?').get(corpusId, rule)
    ?? db.prepare('SELECT 1 FROM rule_sections WHERE corpus_id = ? AND number = ?').get(corpusId, rule);
  if (!exists) throw new ReviewError(`rule ${rule} is not in the current Comprehensive Rules`);

  const kernel = (db.prepare('SELECT rule_number FROM packet_kernel WHERE corpus_id = ?').all(corpusId) as
    Array<{ rule_number: string }>).map((r) => r.rule_number);
  const kernelAdded = !kernel.includes(rule);
  const kernelCovered = isCovered(new Set(kernel), rule);
  const before = packetPolicyShaWithKernel(db, corpusId, policy);

  // Read-only and slow-ish (a text scan per extracted card), so outside the write lock.
  const reach = kernelCovered ? { phrases: [], oracleIds: [] }
    : cardsReachedByKernelRule(db, corpusId, rule, [{ oracle_id: report.oracle_id, quote: report.quote }], policy, config);
  const changed = reach.oracleIds;

  const requeued = inTransaction(db, () => {
    db.prepare("UPDATE missing_rule_reports SET status = 'accepted', resolved_rule = ? WHERE id = ?").run(rule, reportId);
    db.prepare(
      `INSERT INTO packet_kernel (corpus_id, rule_number, origin, evidence) VALUES (?, ?, 'review_promoted', ?)
       ON CONFLICT (corpus_id, rule_number) DO NOTHING`,
    ).run(corpusId, rule,
      `accepted missing-rule report #${reportId} (run ${report.run_id}, ${report.name}): "${report.statement}" on "${report.quote}"`);
    resolveFindingsFor(db, 'missing_rule_reports', reportId);
    const requeue = db.prepare(
      `INSERT INTO extraction_queue (oracle_id, reason, enqueued_at) VALUES (?, 'kernel_changed', ?) ON CONFLICT DO NOTHING`,
    );
    const now = new Date().toISOString();
    return changed.reduce((n, id) => n + Number(requeue.run(id, now).changes), 0);
  });
  return { kernelAdded, requeued, phrases: reach.phrases, policySha: { before, after: packetPolicyShaWithKernel(db, corpusId, policy) } };
}

// ---------- action 5: adjudicate a splitter disagreement (sec. 5.2) ----------

/**
 * sec. 5.2. Accepting marks a splitter bug - and nothing else, by design: a disagreement is
 * never applied automatically. The fix is code; it bumps SPLITTER_VERSION, and
 * `reconcileSplitterVersion` (verify.ts) then re-splits and requeues with `splitter_changed`.
 */
export function acceptSplitterDisagreement(db: DatabaseSync, id: number): void {
  const row = db.prepare('SELECT status FROM splitter_disagreements WHERE id = ?').get(id) as { status: string } | undefined;
  if (!row) throw new ReviewError(`no splitter disagreement ${id}`, 'not_found');
  if (row.status !== 'open') throw new ReviewError(`splitter disagreement ${id} is already ${row.status}`);
  inTransaction(db, () => {
    db.prepare("UPDATE splitter_disagreements SET status = 'accepted' WHERE id = ?").run(id);
    resolveFindingsFor(db, 'splitter_disagreements', id);
  });
}
