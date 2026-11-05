/**
 * The adjudication surface for assisted golden-set drafting (plan Task 6 Step 5,
 * amended; `docs/golden-set-procedure.md`, "Assisted drafting").
 *
 * WHAT THIS DOES AND DOES NOT CHANGE. The CLI's `--show` printed one card at a
 * time and made the owner the drafter's synchronous blocker: nothing could be
 * drafted ahead of what had been adjudicated. These routes move the SAME
 * decision into the inspector so drafting and reviewing decouple — the drafter
 * fills a queue, the owner drains it. The gates are untouched:
 *
 *  - `acceptProposal` is still the only path into `golden_cards` / `golden_atoms`,
 *    and it still re-validates and throws rather than writing a bad card.
 *  - `complete` is still the OWNER's claim, sent explicitly per card. There is
 *    deliberately no "accept all" route: a bulk endpoint would make one click
 *    stand for N completeness claims, which is the exact thing sec. 8.2's
 *    precision-over-complete-cards rule cannot survive.
 *  - The read gate still holds — `validateProposal` runs server-side, and the
 *    UI cannot pass a flag that skips it.
 *
 * The one addition is per-item exclusion (`exclude`), which lets the owner strike
 * a single doubtful atom and accept the rest as partial instead of bouncing the
 * whole card for a redraft.
 *
 * READ-ONLY BY DEFAULT: every GET here is pure disk/DB reading. The two POSTs are
 * the owner's act, and the server is bound to 127.0.0.1.
 */
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitOracleText } from '../../atoms/clauses.js';
import { currentCorpusId } from '../../atoms/golden.js';
import {
  acceptProposal,
  buildVocabulary,
  ledger,
  loadLookups,
  readPacket,
  readProposal,
  readReview,
  rejectProposal,
  validateProposal,
  type DraftStage,
  type LookupRecord,
  type ProposedUnclassified,
  type ReviewRecord,
} from '../../atoms/goldenDraft.js';

const here = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = resolve(here, '../../../docs/golden-set-candidates.json');

/** The committed candidate artifact, or an empty list if `--select` has never run. */
function candidates(): Array<{ oracle_id: string; name: string }> {
  if (!existsSync(CANDIDATES)) return [];
  const artifact = JSON.parse(readFileSync(CANDIDATES, 'utf8')) as {
    cards: Array<{ oracle_id: string; name: string }>;
  };
  return artifact.cards.map((c) => ({ oracle_id: c.oracle_id, name: c.name }));
}

export interface QueueEntry {
  oracle_id: string;
  name: string;
  stage: DraftStage;
  atoms: number;
  unclassified: number;
  lookups: number;
  /** Present for drafted cards only — validation is meaningless without a proposal. */
  valid: boolean | null;
  errors: number;
  warnings: number;
  uncovered_clauses: number;
  /** The drafter's own completeness claim: a hint for triage, never a decision. */
  claims_complete: boolean | null;
  /** True when the drafter left notes — usually a doubt they want looked at. */
  has_notes: boolean;
  review: ReviewRecord | null;
}

export interface QueueResponse {
  counts: Record<DraftStage, number>;
  /** Cards in `golden_cards`, split by the owner's completeness claim. */
  written: { total: number; complete: number };
  candidates: number;
  items: QueueEntry[];
}

export interface DraftRuleCitation {
  number: string;
  text: string;
  /** false = read via `--lookup`, i.e. beyond what term matching reached (sec. 3.4). */
  in_packet: boolean;
}

export interface DraftAtomView {
  index: number;
  face_index: number;
  family: string;
  type_key: string;
  /** The vocabulary's own label for this type — the thing the owner judges the fit against. */
  label: string | null;
  params: Record<string, unknown>;
  span_start: number;
  span_end: number;
  quote: string;
  rationale: string;
  rules: DraftRuleCitation[];
}

export interface DraftFaceView {
  face_index: number;
  name: string;
  oracle_text: string;
  clauses: Array<{ clause_index: number; kind: string; span_start: number; span_end: number; text: string }>;
}

export interface DraftDetail {
  oracle_id: string;
  name: string;
  type_line: string;
  layout: string;
  rarity: string;
  stage: DraftStage;
  drafted_by: string;
  drafted_at: string;
  claims_complete: boolean;
  notes: string;
  faces: DraftFaceView[];
  atoms: DraftAtomView[];
  unclassified: Array<ProposedUnclassified & { index: number }>;
  validation: ReturnType<typeof validateProposal>;
  lookups: LookupRecord[];
  review: ReviewRecord | null;
  packet: { generated_at: string; rule_count: number; term_count: number } | null;
}

/** Rule text for a citation, or a placeholder — a missing rule is already a validation error. */
function ruleText(db: DatabaseSync, corpusId: number, number: string): string {
  const row = db
    .prepare('SELECT text FROM rules WHERE corpus_id = ? AND number = ?')
    .get(corpusId, number) as { text: string } | undefined;
  return row?.text ?? '(no such rule in the corpus)';
}

export function goldenRoutes(app: FastifyInstance): void {
  const db = app.db;

  // ------------------------------------------------------------------ queue
  app.get('/api/golden/queue', async () => {
    const entries = ledger(candidates());
    const counts: Record<DraftStage, number> = {
      'not-started': 0, packet: 0, drafted: 0, accepted: 0, rejected: 0,
    };
    const items: QueueEntry[] = entries.map((e) => {
      counts[e.stage]++;
      const proposal = readProposal(e.oracle_id);
      // Validate only what is actually awaiting a decision. Re-validating an
      // already-accepted card here would re-run the corpus checks on every page
      // load for no decision the owner can still make.
      const v = proposal && e.stage === 'drafted' ? validateProposal(db, proposal) : null;
      return {
        oracle_id: e.oracle_id,
        name: e.name,
        stage: e.stage,
        atoms: e.atoms,
        unclassified: e.unclassified,
        lookups: e.lookups,
        valid: v ? v.ok : null,
        errors: v?.errors.length ?? 0,
        warnings: v?.warnings.length ?? 0,
        uncovered_clauses: v?.uncovered_clauses ?? 0,
        claims_complete: proposal?.claims_complete ?? null,
        has_notes: Boolean(proposal?.notes?.trim()),
        review: readReview(e.oracle_id) ?? null,
      };
    });

    const written = db
      .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(complete), 0) AS complete FROM golden_cards')
      .get() as { total: number; complete: number };

    return { counts, written, candidates: entries.length, items } satisfies QueueResponse;
  });

  // ------------------------------------------------------------------ one draft
  app.get<{ Params: { oracleId: string } }>('/api/golden/drafts/:oracleId', async (req, reply) => {
    const { oracleId } = req.params;
    const proposal = readProposal(oracleId);
    if (!proposal) return reply.code(404).send({ error: `no staged proposal for ${oracleId}` });

    const card = db
      .prepare('SELECT name, type_line, layout, rarity FROM cards WHERE oracle_id = ?')
      .get(oracleId) as { name: string; type_line: string; layout: string; rarity: string } | undefined;
    if (!card) return reply.code(404).send({ error: `no card with oracle_id ${oracleId}` });

    const corpusId = currentCorpusId(db);
    const packet = readPacket(oracleId);
    const inPacket = new Set((packet?.rules ?? []).map((r) => r.number));
    const labels = new Map(buildVocabulary(db).map((v) => [`${v.family}.${v.type_key}`, v.label]));

    const faces = (
      db
        .prepare('SELECT face_index, name, oracle_text FROM card_faces WHERE oracle_id = ? ORDER BY face_index')
        .all(oracleId) as Array<{ face_index: number; name: string; oracle_text: string }>
    ).map((f) => ({
      face_index: f.face_index,
      name: f.name,
      oracle_text: f.oracle_text,
      clauses: splitOracleText(f.oracle_text, f.face_index).map((c) => ({
        clause_index: c.clause_index,
        kind: c.kind as string,
        span_start: c.span_start,
        span_end: c.span_end,
        text: c.text,
      })),
    }));

    const review = readReview(oracleId) ?? null;
    const detail: DraftDetail = {
      oracle_id: oracleId,
      name: card.name,
      type_line: card.type_line,
      layout: card.layout,
      rarity: card.rarity,
      stage: review ? review.decision : 'drafted',
      drafted_by: proposal.drafted_by,
      drafted_at: proposal.drafted_at,
      claims_complete: proposal.claims_complete,
      notes: proposal.notes,
      faces,
      atoms: proposal.atoms.map((a, index) => ({
        index,
        face_index: a.face_index,
        family: a.family,
        type_key: a.type_key,
        label: labels.get(`${a.family}.${a.type_key}`) ?? null,
        params: a.params,
        span_start: a.span_start,
        span_end: a.span_end,
        quote: a.quote,
        rationale: a.rationale,
        rules: a.rule_numbers.map((n) => ({
          number: n,
          text: ruleText(db, corpusId, n),
          in_packet: inPacket.has(n),
        })),
      })),
      unclassified: proposal.unclassified.map((u, index) => ({ ...u, index })),
      validation: validateProposal(db, proposal),
      lookups: loadLookups(oracleId),
      review,
      packet: packet
        ? {
            generated_at: packet.generated_at,
            rule_count: packet.rules.length,
            term_count: packet.term_matches.length,
          }
        : null,
    };
    return detail;
  });

  // ------------------------------------------------------------------ accept
  app.post<{
    Params: { oracleId: string };
    Body: { complete?: unknown; note?: unknown; exclude?: { atoms?: number[]; unclassified?: number[] } };
  }>('/api/golden/drafts/:oracleId/accept', async (req, reply) => {
    const { oracleId } = req.params;
    const body = req.body ?? {};
    // `complete` must be sent explicitly. Defaulting it either way would put a
    // completeness claim in the owner's mouth (sec. 8.2), so an absent flag is a
    // client bug, not a partial acceptance.
    if (typeof body.complete !== 'boolean') {
      return reply.code(400).send({ error: 'complete must be sent explicitly as a boolean' });
    }
    const note = typeof body.note === 'string' ? body.note : '';
    try {
      const res = acceptProposal(db, oracleId, { complete: body.complete, note, exclude: body.exclude });
      return { ok: true, ...res };
    } catch (err) {
      // Every throw out of acceptProposal is a refusal to write, and the message
      // is the reason. Surfacing it verbatim is the point: the owner needs to see
      // which gate said no, not a generic failure.
      return reply.code(422).send({ error: (err as Error).message });
    }
  });

  // ------------------------------------------------------------------ reject
  app.post<{ Params: { oracleId: string }; Body: { note?: unknown } }>(
    '/api/golden/drafts/:oracleId/reject',
    async (req, reply) => {
      const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
      if (!note) {
        return reply.code(400).send({ error: 'a rejection note is required — the drafter corrects rather than guesses' });
      }
      try {
        rejectProposal(req.params.oracleId, note);
        return { ok: true };
      } catch (err) {
        return reply.code(422).send({ error: (err as Error).message });
      }
    },
  );
}
