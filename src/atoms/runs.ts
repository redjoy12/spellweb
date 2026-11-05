/**
 * Per-run statistics for the extraction-runs dashboard (sec. 11.3). Everything is computed
 * from rows the run wrote; nothing here is estimated. Two honest gaps are reported as gaps:
 * token counts (the subagent protocol has no provider usage to read - sec. 7.1 amendment, so
 * packet size is reported in exact characters) and the kernel size AT the time of the run
 * (only the current kernel is stored; the run's `packet_policy_sha` says whether it changed).
 */
import type { DatabaseSync } from 'node:sqlite';
import { kernelBlocks } from '../rules/packet.js';
import { packetPolicyShaWithKernel } from '../rules/kernel.js';
import { loadPacketPolicy, packetPolicySha } from '../rules/relevance.js';
import { scoreAgainstGolden, type GoldenScore } from './golden.js';
import { runPacketRules } from './extractBatch.js';
import { BARS, isAcceptable } from './packetCheck.js';

export interface RunStats {
  id: number;
  started_at: string;
  finished_at: string | null;
  wall_clock_ms: number | null;
  provider: string;
  model: string;
  schema_version: number;
  corpus_id: number;
  packet_policy_sha: string;
  /**
   * `current`: today's kernel + policy hash the same. `changed`: the run saw a different packet.
   * `policy_only`: recorded before Task 9 put the kernel into the hash - only the policy file is
   * comparable, and `current` there says nothing about the kernel.
   */
  policy_hash: 'current' | 'changed' | 'policy_only';
  splitter_version: number;
  batch_kind: string;
  status: string;
  cards_attempted: number;
  /** Cards with a verdict row; below `cards_attempted` for a run that predates Task 9 until `--finalise`. */
  finalised: number;
  outcomes: { passed: number; flagged: number; failed: number };
  /** Share of attempted cards passing unflagged; sec. 7.3's release bar is 0.95. */
  pass_rate: number | null;
  /** Buckets are [from, to) coverage ratios; `to: null` is the exact-1 bucket. Labels are the UI's. */
  coverage: { mean: number | null; buckets: Array<{ from: number; to: number | null; cards: number }> };
  /** sec. 3.6's leading indicator: is the relevance gate dropping rules in production? */
  missing_rule: { reports: number; cards: number; rate: number | null; open: number };
  unclassified: number;
  atoms: number;
  voted_cards: number;
  packet_chars: { cards: number; p50: number | null; p90: number | null; max: number | null };
  tokens: { input: number; output: number; measured: boolean };
  kernel: { rules: number; chars: number } | null;
  findings_pending: number;
  /** sec. 8.2 scores against the golden set, for golden runs. */
  golden: (GoldenScore & { acceptable: boolean; failed: string[] }) | null;
}

const quantile = (sorted: number[], q: number) =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

export function runStats(db: DatabaseSync): { runs: RunStats[]; release_bar: number; bars: typeof BARS } {
  const runs = db.prepare('SELECT * FROM extraction_runs ORDER BY id DESC').all() as Array<Record<string, unknown>>;
  const policy = loadPacketPolicy();
  const kernelOf = new Map<number, { rules: number; chars: number } | null>();
  const shaOf = new Map<number, string>();

  return {
    release_bar: 0.95,
    bars: BARS,
    runs: runs.map((r) => {
      const id = Number(r['id']);
      const corpusId = Number(r['corpus_id']);
      const one = (sql: string) => (db.prepare(sql).get(id) as { n: number | null }).n;

      const results = db.prepare(
        'SELECT coverage_ratio, outcome, packet_chars, passes_run FROM extraction_results WHERE run_id = ?',
      ).all(id) as Array<{ coverage_ratio: number; outcome: string; packet_chars: number; passes_run: number }>;
      const judged = results.filter((x) => x.outcome !== 'failed');
      const outcomes = { passed: 0, flagged: 0, failed: 0 };
      for (const x of results) outcomes[x.outcome as keyof typeof outcomes]++;
      const bucket = (lo: number, hi: number) => judged.filter((x) => x.coverage_ratio >= lo && x.coverage_ratio < hi).length;
      const chars = results.map((x) => x.packet_chars).filter((c) => c > 0).sort((a, b) => a - b);
      const attempted = Number(r['cards_attempted']);

      if (!kernelOf.has(corpusId)) {
        try {
          const k = kernelBlocks(db, corpusId);
          kernelOf.set(corpusId, { rules: k.blocks.length, chars: k.blocks.reduce((s, b) => s + b.chars, 0) });
        } catch {
          kernelOf.set(corpusId, null);
        }
        try { shaOf.set(corpusId, packetPolicyShaWithKernel(db, corpusId, policy)); } catch { /* corpus gone */ }
      }

      let golden: RunStats['golden'] = null;
      if (r['batch_kind'] === 'golden' && r['provider'] !== 'human' && results.length > 0) {
        let packetRules: ReturnType<typeof runPacketRules> | undefined;
        try { packetRules = runPacketRules(id); } catch { /* batch files gone: citation validity unmeasured */ }
        const score = scoreAgainstGolden(db, id, { packetRules });
        const verdict = isAcceptable(score);
        golden = { ...score, acceptable: verdict.ok, failed: verdict.failed };
      }

      const started = Date.parse(String(r['started_at']));
      const finished = r['finished_at'] ? Date.parse(String(r['finished_at'])) : NaN;
      const reports = one('SELECT COUNT(*) n FROM missing_rule_reports WHERE run_id = ?') ?? 0;
      const reportCards = one('SELECT COUNT(DISTINCT oracle_id) n FROM missing_rule_reports WHERE run_id = ?') ?? 0;

      return {
        id,
        started_at: String(r['started_at']),
        finished_at: (r['finished_at'] as string | null) ?? null,
        wall_clock_ms: Number.isFinite(finished) && Number.isFinite(started) ? finished - started : null,
        provider: String(r['provider']),
        model: String(r['model']),
        schema_version: Number(r['schema_version']),
        corpus_id: corpusId,
        packet_policy_sha: String(r['packet_policy_sha']),
        policy_hash: shaOf.get(corpusId) === r['packet_policy_sha'] ? 'current'
          : packetPolicySha(policy) === r['packet_policy_sha'] ? 'policy_only' : 'changed',
        splitter_version: Number(r['splitter_version']),
        batch_kind: String(r['batch_kind']),
        status: String(r['status']),
        cards_attempted: attempted,
        finalised: results.length,
        outcomes,
        pass_rate: attempted > 0 && results.length > 0 ? outcomes.passed / attempted : null,
        coverage: {
          mean: judged.length ? judged.reduce((s, x) => s + x.coverage_ratio, 0) / judged.length : null,
          buckets: [
            { from: 1, to: null, cards: judged.filter((x) => x.coverage_ratio >= 1).length },
            { from: 0.9, to: 1, cards: bucket(0.9, 1) },
            { from: 0.75, to: 0.9, cards: bucket(0.75, 0.9) },
            { from: 0, to: 0.75, cards: bucket(0, 0.75) },
          ],
        },
        missing_rule: {
          reports, cards: reportCards, rate: attempted > 0 ? reportCards / attempted : null,
          open: one("SELECT COUNT(*) n FROM missing_rule_reports WHERE run_id = ? AND status = 'open'") ?? 0,
        },
        unclassified: one('SELECT COUNT(*) n FROM unclassified_clauses WHERE run_id = ?') ?? 0,
        atoms: one('SELECT COUNT(*) n FROM atoms WHERE run_id = ? AND consensus = 1') ?? 0,
        voted_cards: results.filter((x) => x.passes_run > 1).length,
        packet_chars: { cards: chars.length, p50: quantile(chars, 0.5), p90: quantile(chars, 0.9), max: chars.at(-1) ?? null },
        tokens: { input: Number(r['input_tokens']), output: Number(r['output_tokens']),
          measured: Number(r['input_tokens']) + Number(r['output_tokens']) > 0 },
        kernel: kernelOf.get(corpusId) ?? null,
        findings_pending: one("SELECT COUNT(*) n FROM review_queue WHERE domain = 'atom' AND run_id = ? AND status = 'pending'") ?? 0,
        golden,
      };
    }),
  };
}
