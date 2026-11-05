import { describe, it, expect } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { sweepCandidates } from '../src/graph/sweep.js';
import { loadGraphPolicy, type GraphPolicy } from '../src/graph/policy.js';
import { fixtureWithClauses, addRun } from './helpers/fixture.js';

/**
 * Plan Task 8 Step 1 (spec sec. 14.1). Twenty in-memory cards c01..c20 in one build. The degree
 * of card i is chosen so that the rank order is known: out + in + class, never out + in alone.
 */
const IDS = Array.from({ length: 20 }, (_, i) => `c${String(i + 1).padStart(2, '0')}`);

function setup(): { db: DatabaseSync; buildId: number } {
  const db = fixtureWithClauses('Draw a card.', { oracleId: IDS[0] });
  for (const id of IDS.slice(1)) fixtureWithClauses('Draw a card.', { oracleId: id, db });
  const setId = Number(db.prepare(
    "INSERT INTO edge_rule_sets (version, schema_version, corpus_id, packet_sha, model, status, created_at) VALUES (1, 1, 1, 's', 'm', 'accepted', 't')",
  ).run().lastInsertRowid);
  const buildId = Number(db.prepare(
    `INSERT INTO graph_builds (build_key, rule_set_id, schema_version, corpus_id, pool_snapshot_id, tests_version, atom_set_sha, scope, built_at, counts_json)
     VALUES ('k', ?, 1, 1, 1, 1, 'a', 'BR', 't', '{}')`,
  ).run(setId).lastInsertRowid);
  const deg = db.prepare(
    `INSERT INTO card_degree (build_id, oracle_id, out_degree, in_degree, out_weight, in_weight, class_edges, anti_degree)
     VALUES (?, ?, ?, ?, 0, 0, ?, 0)`,
  );
  IDS.forEach((id, i) => deg.run(buildId, id, i, 0, 0));      // c20 has degree 19, c01 has 0
  // c03: out + in is 2, but 30 class edges put it first. c18 ties with c17 at 16.
  db.prepare('UPDATE card_degree SET class_edges = 30 WHERE oracle_id = ?').run('c03');
  db.prepare('UPDATE card_degree SET out_degree = 16 WHERE oracle_id = ?').run('c18');
  return { db, buildId };
}

const policy = (share: number): GraphPolicy => ({ ...loadGraphPolicy(), sweep: { top_share: share } });

/** One extraction result for the card in a new run of `passes` answered passes on `schema`. */
function result(db: DatabaseSync, oracleId: string, passes: number, opts: { schema?: number; outcome?: string } = {}): number {
  const runId = addRun(db, 'requeue');
  db.prepare('UPDATE extraction_runs SET schema_version = ? WHERE id = ?').run(opts.schema ?? 1, runId);
  db.prepare(
    `INSERT INTO extraction_results (run_id, oracle_id, coverage_ratio, uncovered_clauses_json, passes_run, vote_agreement,
       connective_atom_count, packet_chars, packet_tokens, outcome)
     VALUES (?, ?, 1, '[]', ?, NULL, 0, 0, 0, ?)`,
  ).run(runId, oracleId, passes, opts.outcome ?? 'passed');
  return runId;
}

describe('sweepCandidates (spec sec. 14.1)', () => {
  it('ranks the build cards by out_degree + in_degree + class_edges, ties by oracle_id', () => {
    const { db, buildId } = setup();
    const { ranked } = sweepCandidates(db, buildId, policy(0.1));
    expect(ranked).toHaveLength(20);
    expect(ranked.slice(0, 5)).toEqual(['c03', 'c20', 'c19', 'c17', 'c18']);
    expect(ranked.at(-1)).toBe('c01');
  });

  it('selects the top top_share of the build cards', () => {
    const { db, buildId } = setup();
    expect(sweepCandidates(db, buildId, policy(0.1)).selected).toEqual(['c03', 'c20']);
    expect(sweepCandidates(db, buildId, policy(0.25)).selected).toEqual(['c03', 'c20', 'c19', 'c17', 'c18']);
  });

  it('removes a card whose live extraction is voted (three passes) on the current schema', () => {
    const { db, buildId } = setup();
    result(db, 'c03', 3);
    const s = sweepCandidates(db, buildId, policy(0.1));
    expect(s.selected).toEqual(['c03', 'c20']);
    expect(s.alreadyVoted).toEqual(['c03']);
    expect(s.toRequeue).toEqual(['c20']);
  });

  it('keeps a card whose vote is on an older schema, is not the live answer, or failed', () => {
    const { db, buildId } = setup();
    db.exec(`INSERT INTO atom_types (schema_version, family, type_key, label, params_schema, provenance, evidence)
             SELECT 2, family, type_key, label, params_schema, provenance, evidence FROM atom_types WHERE schema_version = 1`);
    result(db, 'c03', 3, { schema: 1 });                       // voted, but on v1; the schema is now v2
    result(db, 'c20', 3, { schema: 2 });
    result(db, 'c20', 1, { schema: 2 });                       // a newer single pass owns the live atoms
    result(db, 'c19', 3, { schema: 2, outcome: 'failed' });
    const s = sweepCandidates(db, buildId, policy(0.25));
    expect(s.alreadyVoted).toEqual([]);
    expect(s.toRequeue).toEqual(['c03', 'c20', 'c19', 'c17', 'c18']);
  });

  it('gives the same lists two times for the same build', () => {
    const { db, buildId } = setup();
    result(db, 'c19', 3);
    expect(sweepCandidates(db, buildId, policy(0.25))).toEqual(sweepCandidates(db, buildId, policy(0.25)));
  });

  it('refuses a build that does not exist', () => {
    const { db } = setup();
    expect(() => sweepCandidates(db, 99, policy(0.1))).toThrow(/no build 99/);
  });
});
