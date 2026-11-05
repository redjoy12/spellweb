import type { FastifyInstance } from 'fastify';
import { splitOracleText } from '../../atoms/clauses.js';

/** The six vocabulary families from atom_types.family CHECK constraint. */
export type AtomFamily = 'PRODUCES' | 'CARES_ABOUT' | 'ENABLES' | 'COMBAT' | 'INTERACTION' | 'CONSTRAINTS';

/** Mirrors src/atoms/clauses.ts `Clause` — repeated here so the route's return type
 *  is self-contained and the web client can mirror it without importing the splitter. */
export interface AtomClause {
  face_index: number;
  clause_index: number;
  span_start: number;
  span_end: number;
  text: string;
  kind: 'ability' | 'reminder' | 'mode' | 'flavor_word' | 'chapter' | 'loyalty';
}

export interface AtomRow {
  id: number;
  face_index: number;
  schema_version: number;
  family: AtomFamily;
  type_key: string;
  params: Record<string, unknown>;
  span_start: number;
  span_end: number;
  quote: string;
  span_ambiguous: boolean;
  rule_numbers: string[];
  confidence: number;
}

export interface UnclassifiedMark {
  id: number;
  span_start: number;
  span_end: number;
  quote: string;
  proposed_label: string;
  status: string;
}

export interface MissingRuleMark {
  id: number;
  quote: string;
  statement: string;
  resolved_rule: string | null;
  status: string;
}

export interface AtomFace {
  face_index: number;
  oracle_text: string;
  clauses: AtomClause[];
  atoms: AtomRow[];
  unclassified: UnclassifiedMark[];
  missingRules: MissingRuleMark[];
}

export interface AtomsResponse {
  faces: AtomFace[];
  /** `null` until this card has current atoms; ratio over non-reminder clauses (§7.3). */
  coverage: { ratio: number; uncovered: number[] } | null;
}

const FAMILIES = new Set<string>(['PRODUCES', 'CARES_ABOUT', 'ENABLES', 'COMBAT', 'INTERACTION', 'CONSTRAINTS']);

function asFamily(s: string): AtomFamily {
  return (FAMILIES.has(s) ? s : 'CONSTRAINTS') as AtomFamily;
}

/**
 * Reads every face's clauses + current atoms for one card. The inspector must
 * work before any batch has run, so clauses are read from the `clauses` table
 * when present (Task 3) and otherwise split on the fly from `splitOracleText`.
 *
 * Atoms are filtered to `is_current = 1` **and** `oracle_hash = cards.oracle_hash`,
 * so a stale atom from before an errata never renders over text it does not
 * belong to (§10.3 read-time guard; the demote-and-requeue side is Task 9).
 */
export async function atomRoutes(app: FastifyInstance) {
  app.get<{ Params: { oracleId: string } }>('/api/cards/:oracleId/atoms', async (req, reply) => {
    const card = app.db
      .prepare('SELECT oracle_id, oracle_hash FROM cards WHERE oracle_id = ?')
      .get(req.params.oracleId) as { oracle_id: string; oracle_hash: string } | undefined;
    if (!card) return reply.code(404).send({ error: 'card not found' });

    const faceRows = app.db
      .prepare('SELECT face_index, oracle_text FROM card_faces WHERE oracle_id = ? ORDER BY face_index')
      .all(req.params.oracleId) as Array<{ face_index: number; oracle_text: string }>;

    const clauseStmt = app.db.prepare(
      `SELECT clause_index, span_start, span_end, text, kind
         FROM clauses WHERE oracle_id = ? AND face_index = ? ORDER BY clause_index`,
    );

    const faces: AtomFace[] = faceRows.map((f) => {
      const stored = clauseStmt.all(req.params.oracleId, f.face_index) as Array<{
        clause_index: number; span_start: number; span_end: number; text: string; kind: string;
      }>;
      // Fall back to on-the-fly splitting when no clause rows exist yet (current
      // state: no batch has run). Either way the spans are offsets into oracle_text.
      const clauses: AtomClause[] = stored.length > 0
        ? stored.map((c) => ({
            face_index: f.face_index, clause_index: c.clause_index,
            span_start: c.span_start, span_end: c.span_end, text: c.text,
            kind: c.kind as AtomClause['kind'],
          }))
        : splitOracleText(f.oracle_text, f.face_index);

      return {
        face_index: f.face_index,
        oracle_text: f.oracle_text,
        clauses,
        atoms: [],
        unclassified: [],
        missingRules: [],
      };
    });

    // Current atoms whose oracle_hash still matches the card's text (§10.3 guard).
    const atomRows = app.db
      .prepare(
        `SELECT id, face_index, schema_version, family, type_key, params_json,
                span_start, span_end, quote, span_ambiguous, rule_numbers, confidence
           FROM atoms WHERE oracle_id = ? AND is_current = 1 AND oracle_hash = ?
         ORDER BY face_index, span_start, id`,
      )
      .all(req.params.oracleId, card.oracle_hash) as Array<{
        id: number; face_index: number; schema_version: number; family: string; type_key: string;
        params_json: string; span_start: number; span_end: number; quote: string;
        span_ambiguous: number; rule_numbers: string; confidence: number;
      }>;

    // The §10.3 read-time guard applies to the escape hatches too: both tables
    // carry their own oracle_hash + span offsets into oracle_text, so a card-level
    // errata that bumps cards.oracle_hash would otherwise leave stale escape-hatch
    // rows rendering old spans over new text.
    //
    // And they belong to a run, exactly as atoms do (Task 9): only the run that owns the
    // card's live set - its newest answer - speaks for the card. Rows from superseded runs,
    // and the golden-drafting placeholder run's candidates (provider 'human'), are not
    // findings about the atoms on screen. No run has answered yet -> none shown.
    const liveRun = (app.db
      .prepare(
        `SELECT MAX(run_id) AS r FROM (
           SELECT run_id FROM extraction_results WHERE oracle_id = ? AND outcome <> 'failed'
           UNION ALL SELECT run_id FROM atoms WHERE oracle_id = ? AND is_current = 1)`,
      )
      .get(req.params.oracleId, req.params.oracleId) as { r: number | null }).r ?? -1;

    const unclassifiedRows = app.db
      .prepare(
        `SELECT id, face_index, span_start, span_end, quote, proposed_label, status
           FROM unclassified_clauses WHERE oracle_id = ? AND oracle_hash = ? AND run_id = ? ORDER BY id`,
      )
      .all(req.params.oracleId, card.oracle_hash, liveRun) as Array<{
        id: number; face_index: number; span_start: number; span_end: number;
        quote: string; proposed_label: string; status: string;
      }>;

    const missingRows = app.db
      .prepare(
        `SELECT id, face_index, quote, statement, resolved_rule, status
           FROM missing_rule_reports WHERE oracle_id = ? AND oracle_hash = ? AND run_id = ? ORDER BY id`,
      )
      .all(req.params.oracleId, card.oracle_hash, liveRun) as Array<{
        id: number; face_index: number; quote: string; statement: string;
        resolved_rule: string | null; status: string;
      }>;

    for (const f of faces) {
      f.atoms = atomRows
        .filter((a) => a.face_index === f.face_index)
        .map((a) => ({
          id: a.id, face_index: a.face_index, schema_version: a.schema_version,
          family: asFamily(a.family), type_key: a.type_key,
          params: JSON.parse(a.params_json) as Record<string, unknown>,
          span_start: a.span_start, span_end: a.span_end, quote: a.quote,
          span_ambiguous: a.span_ambiguous === 1,
          rule_numbers: JSON.parse(a.rule_numbers) as string[],
          confidence: a.confidence,
        }));
      f.unclassified = unclassifiedRows
        .filter((u) => u.face_index === f.face_index)
        .map((u) => ({
          id: u.id, span_start: u.span_start, span_end: u.span_end, quote: u.quote,
          proposed_label: u.proposed_label, status: u.status,
        }));
      f.missingRules = missingRows
        .filter((m) => m.face_index === f.face_index)
        .map((m) => ({
          id: m.id, quote: m.quote, statement: m.statement,
          resolved_rule: m.resolved_rule, status: m.status,
        }));
    }

    // Coverage is null until this card has been extracted (Task 9 owns the full
    // version). Computed here only when current atoms exist, over non-reminder
    // clauses (§7.3); an atom "covers" a clause if their spans overlap.
    let coverage: AtomsResponse['coverage'] = null;
    if (atomRows.length > 0) {
      let covered = 0;
      let total = 0;
      const uncovered: number[] = [];
      for (const f of faces) {
        for (const c of f.clauses) {
          if (c.kind === 'reminder') continue;
          total++;
          // An unclassified clause counts as covered - the same escape hatch computeCoverage allows.
          const hit = [...f.atoms, ...f.unclassified].some((a) => a.span_start < c.span_end && a.span_end > c.span_start);
          if (hit) covered++;
          else uncovered.push(c.clause_index);
        }
      }
      coverage = { ratio: total > 0 ? covered / total : 1, uncovered };
    }

    return { faces, coverage };
  });
}