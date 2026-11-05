/**
 * The packet-hole check (plan Task 10, amended 2026-10-04; spec sec. 9 amendment).
 *
 * The same reader drafted the golden set and extracts, so agreement with golden cannot show a
 * reading is right. What still differs between the two sides is the input: golden drafting saw
 * the ungated corpus and real names, extraction sees the gated packet and "~". So a golden
 * atom the run missed, whose cited rules were not in that card's packet, is a PACKET HOLE
 * (sec. 3.6) - fixed in config/packet-policy.json or the kernel. A miss whose rules were all
 * shown is a reading or convention disagreement, and the packet is not to blame.
 *
 * sec. 9's bars stay as the pass condition. There is one extractor, so no candidates and no
 * winner: `isAcceptable` is the whole decision rule.
 */
import type { DatabaseSync } from 'node:sqlite';
import { loadGoldenSet, matchAtoms, scoreAgainstGolden, type GoldenScore } from './golden.js';

/**
 * sec. 9. Values are provisional and may be retuned against real data; the SHAPE of the rule
 * is not optional. Recall is weighted above precision deliberately: a missed atom is the
 * silent failure the concept spec sec. 6 names, while a spurious atom surfaces as a
 * review-queue item a human will see.
 */
export const BARS = {
  citation_validity: 1.0,   // any breach is an I1 violation, not a quality shortfall
  span_validity:     0.99,
  atom_recall:       0.90,
  atom_precision:    0.85,
  coverage:          0.95,
} as const;

export type BarMetric = keyof typeof BARS;
export type ScoreRow = Pick<GoldenScore, BarMetric>;

/**
 * Every bar is inclusive, and every failed metric is named. An unmeasured citation validity
 * (null - no packet whitelists) fails: an I1 bar is never passed by assumption.
 */
export function isAcceptable(row: ScoreRow): { ok: boolean; failed: BarMetric[] } {
  const failed = (Object.keys(BARS) as BarMetric[]).filter((k) => {
    const v = row[k];
    return v === null || v < BARS[k];
  });
  return { ok: failed.length === 0, failed };
}

/** Why a golden atom has no match in the run. */
export type MissVerdict =
  | 'packet_hole'      // at least one cited rule was not in the card's packet
  | 'in_packet'        // every cited rule was shown - a reading/convention disagreement
  | 'not_extracted';   // the run has no answer: never prepared, or the answer failed validation

export interface MissedAtom {
  oracle_id: string;
  name: string;
  face_index: number;
  family: string;
  type_key: string;
  quote: string;
  rule_numbers: string[];
  verdict: MissVerdict;
  /** Cited rules the card's packet did not carry. Empty unless verdict is packet_hole. */
  not_shown: string[];
  /**
   * For a packet hole: does the packet as assembled TODAY carry every cited rule? A hole that
   * is already closed (kernel re-derived, policy changed) needs a new run, not a new fix.
   * Null when not checked.
   */
  closed_now: boolean | null;
  /** What the run put there instead: same-type atoms elsewhere, other types on the span. */
  run_same_type_elsewhere: number;
  run_types_on_span: string[];
}

export interface ExtraAtom {
  oracle_id: string;
  name: string;
  face_index: number;
  family: string;
  type_key: string;
  quote: string;
}

export interface PacketCheck {
  runId: number;
  score: GoldenScore;
  acceptable: { ok: boolean; failed: BarMetric[] };
  misses: MissedAtom[];
  /** Run atoms on COMPLETE golden cards with no golden match - precision's false positives. */
  extras: ExtraAtom[];
  /** The run's own unjustified-clause reports on golden cards: holes the extractor named itself. */
  missingRules: Array<{ oracle_id: string; name: string; quote: string; statement: string }>;
  /**
   * Schema v15 (spec sec. 20): agreement of each param on the matched atom pairs whose golden
   * atom is at v15 or later. The match itself ignores params, so this is the only param measure.
   */
  params: ParamAgreement[];
  /** The pairs that disagree on a v15 param, for the report. */
  paramDisagreements: Array<{ name: string; type: string; param: string; golden: unknown; run: unknown; quote: string }>;
}

export interface ParamAgreement { type: string; param: string; agree: number; total: number }

export interface CheckOptions {
  /** oracle_id -> rule numbers its packet carried in this run (`runPacketRules`). */
  packetRules: ReadonlyMap<string, ReadonlySet<string>>;
  /** The packet a card would get today; used only to mark holes already closed. */
  currentPacketRules?: (oracleId: string) => ReadonlySet<string>;
}

type RunAtom = { face_index: number; family: string; type_key: string; span_start: number; span_end: number; quote: string; params_json: string };

/** Canonical JSON with sorted keys, so {a,b} and {b,a} compare equal. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x);

const overlap = (a: { span_start: number; span_end: number }, b: { span_start: number; span_end: number }) =>
  Math.min(a.span_end, b.span_end) > Math.max(a.span_start, b.span_start);

export function checkRun(db: DatabaseSync, runId: number, opts: CheckOptions): PacketCheck {
  const score = scoreAgainstGolden(db, runId, { packetRules: opts.packetRules });
  const nameOf = db.prepare('SELECT name FROM cards WHERE oracle_id = ?');
  const name = (id: string) => (nameOf.get(id) as { name: string } | undefined)?.name ?? id;
  const runAtomsOf = db.prepare(
    `SELECT face_index, family, type_key, span_start, span_end, quote, params_json FROM atoms
      WHERE run_id = ? AND oracle_id = ? AND consensus = 1 ORDER BY face_index, span_start`,
  );

  const failed = new Set((db.prepare(
    "SELECT oracle_id FROM extraction_results WHERE run_id = ? AND outcome = 'failed'",
  ).all(runId) as Array<{ oracle_id: string }>).map((r) => r.oracle_id));

  const misses: MissedAtom[] = [];
  const extras: ExtraAtom[] = [];
  const agreement = new Map<string, ParamAgreement>();
  const paramDisagreements: PacketCheck['paramDisagreements'] = [];
  for (const gc of loadGoldenSet(db)) {
    const run = runAtomsOf.all(runId, gc.oracle_id) as RunAtom[];
    const { runIdx, goldenIdx, pairs } = matchAtoms(run, gc.atoms);

    for (const [i, j] of pairs) {
      const g = gc.atoms[j]!;
      if (g.schema_version < 15) continue;
      const got = JSON.parse(run[i]!.params_json) as Record<string, unknown>;
      const type = `${g.family}.${g.type_key}`;
      for (const [param, want] of Object.entries(g.params)) {
        const key = `${type}|${param}`;
        const a = agreement.get(key) ?? { type, param, agree: 0, total: 0 };
        a.total++;
        if (canon(want) === canon(got[param])) a.agree++;
        else paramDisagreements.push({ name: name(gc.oracle_id), type, param, golden: want, run: got[param], quote: g.quote });
        agreement.set(key, a);
      }
    }
    const shown = failed.has(gc.oracle_id) ? undefined : opts.packetRules.get(gc.oracle_id);
    let today: ReadonlySet<string> | undefined;

    gc.atoms.forEach((g, j) => {
      if (goldenIdx.has(j)) return;
      const notShown = shown ? g.rule_numbers.filter((n) => !shown.has(n)) : [];
      const verdict: MissVerdict = !shown ? 'not_extracted' : notShown.length > 0 ? 'packet_hole' : 'in_packet';
      let closedNow: boolean | null = null;
      if (verdict === 'packet_hole' && opts.currentPacketRules) {
        today ??= opts.currentPacketRules(gc.oracle_id);
        closedNow = g.rule_numbers.every((n) => today!.has(n));
      }
      const sameFace = run.filter((r) => r.face_index === g.face_index);
      misses.push({
        oracle_id: gc.oracle_id, name: name(gc.oracle_id), face_index: g.face_index,
        family: g.family, type_key: g.type_key, quote: g.quote, rule_numbers: g.rule_numbers,
        verdict, not_shown: notShown, closed_now: closedNow,
        run_same_type_elsewhere: sameFace.filter((r) => r.family === g.family && r.type_key === g.type_key).length,
        run_types_on_span: [...new Set(sameFace
          .filter((r) => (r.family !== g.family || r.type_key !== g.type_key) && overlap(r, g))
          .map((r) => `${r.family} ${r.type_key}`))],
      });
    });

    if (gc.complete) {
      run.forEach((r, i) => {
        if (runIdx.has(i)) return;
        extras.push({ oracle_id: gc.oracle_id, name: name(gc.oracle_id), face_index: r.face_index,
          family: r.family, type_key: r.type_key, quote: r.quote });
      });
    }
  }

  const missingRules = (db.prepare(
    `SELECT m.oracle_id, c.name, m.quote, m.statement FROM missing_rule_reports m
       JOIN golden_cards g USING (oracle_id) JOIN cards c USING (oracle_id)
      WHERE m.run_id = ? ORDER BY c.name, m.id`,
  ).all(runId) as PacketCheck['missingRules']);

  const params = [...agreement.values()].sort((a, b) => a.type.localeCompare(b.type) || a.param.localeCompare(b.param));
  return { runId, score, acceptable: isAcceptable(score), misses, extras, missingRules, params, paramDisagreements };
}
