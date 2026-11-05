/**
 * Phase 3 plan Task 8 (spec sec. 14.1): the degree sweep. After a graph build, the cards with
 * the highest degree are extracted again with three passes and votes (parent spec sec. 6.1),
 * because an error in such a card has an effect on many decks.
 *
 * The rank is `out_degree + in_degree + class_edges` of the build (sec. 7.5), ties by oracle_id,
 * so the same build always gives the same lists. A card is already voted when its LIVE
 * extraction - the newest non-failed result, which owns the live atom set (Phase 2 sec. 10.3) -
 * answered every voting pass on the current schema. Only the other selected cards are requeued,
 * so later sweeps are small.
 */
import type { DatabaseSync } from 'node:sqlite';
import { currentSchemaVersion } from '../atoms/schema.js';
import { loadEscalationConfig } from '../atoms/verify.js';
import type { GraphPolicy } from './policy.js';

export interface SweepLists {
  /** Every card of the build, highest degree first. */
  ranked: string[];
  /** The top `sweep.top_share` of `ranked`. */
  selected: string[];
  /** Selected cards whose live extraction is voted on the current schema. */
  alreadyVoted: string[];
  /** Selected cards that need a requeue run and voting passes. */
  toRequeue: string[];
}

export function sweepCandidates(
  db: DatabaseSync,
  buildId: number,
  policy: GraphPolicy,
  opts: { passes?: number } = {},
): SweepLists {
  if (!db.prepare('SELECT 1 FROM graph_builds WHERE id = ?').get(buildId)) throw new Error(`no build ${buildId}`);
  const ranked = (db.prepare(
    `SELECT oracle_id FROM card_degree WHERE build_id = ?
      ORDER BY out_degree + in_degree + class_edges DESC, oracle_id`,
  ).all(buildId) as Array<{ oracle_id: string }>).map((r) => r.oracle_id);
  const share = policy.sweep.top_share;
  // Math.round, not ceil: 1,940 x 0.1 is 194.00000000000003 in floating point.
  const n = share > 0 && ranked.length > 0 ? Math.max(1, Math.round(ranked.length * share)) : 0;
  const selected = ranked.slice(0, n);

  const passes = opts.passes ?? loadEscalationConfig().passes;
  const schema = currentSchemaVersion(db);
  const live = db.prepare(
    `SELECT e.passes_run, r.schema_version FROM extraction_results e JOIN extraction_runs r ON r.id = e.run_id
      WHERE e.oracle_id = ? AND e.outcome <> 'failed' ORDER BY e.run_id DESC LIMIT 1`,
  );
  const voted = (id: string) => {
    const r = live.get(id) as { passes_run: number; schema_version: number } | undefined;
    return r !== undefined && r.passes_run >= passes && r.schema_version === schema;
  };
  const alreadyVoted = selected.filter(voted);
  const done = new Set(alreadyVoted);
  return { ranked, selected, alreadyVoted, toRequeue: selected.filter((id) => !done.has(id)) };
}
