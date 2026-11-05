/**
 * The isolated reviewer of the edge golden set (owner decision 2026-10-11, spec rev. 8 sec. 11.4).
 *
 * It replaces the owner sample of checkpoint C2. A fresh `edge-golden-reviewer` subagent, on a
 * different model from the labelers, labels each pair of the latest owner sample BLIND: it gets
 * the same packet, instructions and answer format as the labelers, and never the labeler answer.
 * The CLI compares the two answers:
 * - same label and clauses: `agree`;
 * - same label, other clauses: `clause_differs` (round 1 showed the clause choice is noise);
 * - other label: `label_differs`, and the pair becomes `disputed`, out of the score, for the owner;
 * - an answer that fails the checks of sec. 11.3: `invalid`, no effect on the pair.
 * Reviewer verdicts are never written as owner verdicts. The session never reviews a pair itself.
 *
 * Layout: <goldenBatchesDir>/review-<sample>/batch-<nnn>/{manifest.json, packet.md, response.json}
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CrContent } from './crContent.js';
import {
  answerFault, buildLabelPacket, clauseKey, goldenBatchesDir, labelContext, latestSample, splitToBudget, voteKey,
  type Batch, type ClauseRef, type LabelContext, type LabelManifest,
} from './goldenLabel.js';
import type { GraphPolicy } from './policy.js';

export type ReviewOutcome = 'agree' | 'clause_differs' | 'label_differs' | 'invalid';

interface ReviewManifest {
  sample_no: number;
  batch_index: number;
  corpus_id: number;
  pairs: LabelManifest['pairs'];
  cards: LabelManifest['cards'];
  refs: string[];
  packet_sha: string;
  packet_bytes: number;
}

const pad3 = (n: number) => String(n).padStart(3, '0');
export const reviewDir = (sample: number) => join(goldenBatchesDir(), `review-${sample}`);

/**
 * Writes one directory for each review batch of the latest owner sample: the sample pairs that
 * are still `accepted`, in batches of `batch_size`, split to the packet budget. Returns the
 * directories. The packet is the labeler packet: it holds no labeler answer.
 */
export function prepareReview(db: DatabaseSync, policy: GraphPolicy, over: Partial<LabelContext> = {}): string[] {
  const sample = latestSample(db);
  if (sample === 0) throw new Error('there is no owner sample: run --owner-sample first');
  if (db.prepare('SELECT 1 FROM edge_golden_reviews WHERE sample_no = ? LIMIT 1').get(sample)) {
    throw new Error(`owner sample ${sample} is already reviewed`);
  }
  const pairs = db.prepare(
    `SELECT p.id, p.supply_oracle, p.demand_oracle FROM edge_golden_owner_sample o JOIN edge_golden_pairs p ON p.id = o.pair_id
      WHERE o.sample_no = ? AND p.status = 'accepted' ORDER BY p.id`,
  ).all(sample) as Batch;
  if (pairs.length === 0) throw new Error(`owner sample ${sample} has no accepted pair to review`);
  const ctx = labelContext(db, over);
  const cache = new Map<string, CrContent>();
  const chunks: Batch[] = [];
  for (let i = 0; i < pairs.length; i += policy.golden.batch_size) chunks.push(pairs.slice(i, i + policy.golden.batch_size));
  const dirs: string[] = [];
  chunks.flatMap((c) => splitToBudget(db, ctx, c, policy.packet_budget_bytes, cache)).forEach((batch, b) => {
    const head = `# Edge golden labels - review of owner sample ${sample}, batch ${pad3(b + 1)} - ${batch.length} pair(s)`;
    const packet = buildLabelPacket(db, ctx, head, batch, cache);
    const dir = join(reviewDir(sample), `batch-${pad3(b + 1)}`);
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, 'response.json'), { force: true });
    const manifest: ReviewManifest = {
      sample_no: sample, batch_index: b + 1, corpus_id: ctx.corpusId, pairs: packet.pairs, cards: packet.cards,
      refs: packet.refs, packet_sha: createHash('sha256').update(packet.markdown, 'utf8').digest('hex').slice(0, 16),
      packet_bytes: Buffer.byteLength(packet.markdown, 'utf8'),
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(join(dir, 'packet.md'), packet.markdown);
    dirs.push(dir);
  });
  return dirs;
}

/** The labeler vote key of a stored pair, in the form of `voteKey`. */
function storedKey(p: { label: string; supply_clause: string | null; demand_clause: string | null }): string {
  const ref = (s: string | null) => clauseKey(s ? JSON.parse(s) as ClauseRef : null);
  return `${p.label}|${ref(p.supply_clause)}|${ref(p.demand_clause)}`;
}

/**
 * Reads the reviewer answers of the latest owner sample, compares each with the labeler answer and
 * stores the outcome. A `label_differs` pair becomes `disputed`. All response files must be
 * readable: nothing is stored otherwise. A pair that is no longer `accepted` is skipped.
 */
export function submitReview(db: DatabaseSync): Record<ReviewOutcome | 'skipped', number> {
  const sample = latestSample(db);
  const root = reviewDir(sample);
  if (sample === 0 || !existsSync(root)) throw new Error('the review is not prepared: run --review-prepare first');
  if (db.prepare('SELECT 1 FROM edge_golden_reviews WHERE sample_no = ? LIMIT 1').get(sample)) {
    throw new Error(`owner sample ${sample} is already reviewed`);
  }
  const batches = readdirSync(root).filter((d) => d.startsWith('batch-')).sort().map((d) => join(root, d));
  const answers = new Map<string, Record<string, unknown>>();
  const problems: string[] = [];
  for (const dir of batches) {
    const file = join(dir, 'response.json');
    try {
      const body = JSON.parse(readFileSync(file, 'utf8')) as { pairs?: unknown };
      if (body.pairs === null || typeof body.pairs !== 'object' || Array.isArray(body.pairs)) throw new Error('no pairs object');
      answers.set(dir, body.pairs as Record<string, unknown>);
    } catch (err) {
      problems.push(`${file} (${existsSync(file) ? (err as Error).message : 'missing'})`);
    }
  }
  if (problems.length) throw new Error(`dispatch these review batches again:\n  ${problems.join('\n  ')}`);

  const pairRow = db.prepare('SELECT status, label, supply_clause, demand_clause FROM edge_golden_pairs WHERE id = ?');
  const ins = db.prepare('INSERT INTO edge_golden_reviews (sample_no, pair_id, answer_json, fault, outcome, reviewed_at) VALUES (?, ?, ?, ?, ?, ?)');
  const dispute = db.prepare("UPDATE edge_golden_pairs SET status = 'disputed' WHERE id = ? AND status = 'accepted'");
  const totals: Record<ReviewOutcome | 'skipped', number> = { agree: 0, clause_differs: 0, label_differs: 0, invalid: 0, skipped: 0 };
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const dir of batches) {
      const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ReviewManifest;
      const refs = new Set(m.refs);
      const cardOf = new Map(m.cards.map((c) => [c.key, c]));
      for (const p of m.pairs) {
        const row = pairRow.get(p.pair_id) as { status: string; label: string; supply_clause: string | null; demand_clause: string | null } | undefined;
        if (!row || row.status !== 'accepted') { totals.skipped++; continue; }
        const raw = answers.get(dir)![p.key];
        const { answer, fault } = answerFault(db, m.corpus_id, raw, { supply: cardOf.get(p.supply)!, demand: cardOf.get(p.demand)! }, refs);
        let outcome: ReviewOutcome;
        if (fault !== null || answer === null) outcome = 'invalid';
        else if (answer.label !== row.label) outcome = 'label_differs';
        else outcome = voteKey(answer) === storedKey(row) ? 'agree' : 'clause_differs';
        ins.run(sample, p.pair_id, raw === undefined ? null : JSON.stringify(raw), fault, outcome, now);
        if (outcome === 'label_differs') dispute.run(p.pair_id);
        totals[outcome]++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return totals;
}

/**
 * The agreement between the reviewer and the labelers on the latest owner sample. `rate` is the
 * share of valid reviews with the same label. `label_differs` is the number that the
 * correction limit (`owner_correction_limit`) tests.
 */
export function reviewAgreement(db: DatabaseSync): {
  sample: number; reviewed: number; agree: number; clause_differs: number; label_differs: number; invalid: number; rate: number | null;
} {
  const sample = latestSample(db);
  const rows = db.prepare('SELECT outcome, COUNT(*) n FROM edge_golden_reviews WHERE sample_no = ? GROUP BY outcome')
    .all(sample) as Array<{ outcome: ReviewOutcome; n: number }>;
  const n = (o: ReviewOutcome) => rows.find((r) => r.outcome === o)?.n ?? 0;
  const valid = n('agree') + n('clause_differs') + n('label_differs');
  return {
    sample,
    reviewed: valid + n('invalid'),
    agree: n('agree'), clause_differs: n('clause_differs'), label_differs: n('label_differs'), invalid: n('invalid'),
    rate: valid > 0 ? (n('agree') + n('clause_differs')) / valid : null,
  };
}
