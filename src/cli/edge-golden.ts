/**
 * npm run edge-golden -- <mode>
 *
 *   --sample --round <n>       select the pairs of round n (spec sec. 11.2) as `sampled` rows
 *   --prepare-round <n>        write the pass directories of round n (plan D5)
 *   --submit-round <n>         read the three responses of each batch, check, vote and store
 *   --status                   the counts against the targets, the cap and the owner agreement
 *   --owner-sample             select the owner sample (spec sec. 11.4) for /edge-golden
 *   --reset-round <n>          label round n again after an instruction change (plan Step 9)
 *   --review-prepare           write the blind review batches of the latest owner sample
 *   --review-submit            compare the reviewer answers with the labels (spec rev. 8 sec. 11.4)
 *   --top-weight --build <id>  add the `top_weight` pairs of a build as the next round (sec. 11.2)
 *   --reanchor [--dry-run]     move the atom IDs of the pairs to the current atoms (v15 plan Task 4);
 *                              it changes no label, clause or status
 *
 * Phase 3 plan Task 2. The CLI selects; fresh `edge-golden-labeler` subagents label; the owner
 * adjudicates. The session that runs this CLI never selects, labels or changes a pair.
 */
import { openDb } from '../db/client.js';
import { loadSlice, nextRound, persistRound, sampleRound, targetProgress } from '../graph/goldenSelect.js';
import { samplePairsByWeight } from '../graph/score.js';
import {
  goldenBatchesDir, ownerAgreement, ownerSampleGaps, prepareLabelRound, resetLabelRound, retireStalePairs, selectOwnerSample,
  submitLabelRound,
} from '../graph/goldenLabel.js';
import { loadGraphPolicy } from '../graph/policy.js';
import { prepareReview, reviewAgreement, submitReview } from '../graph/goldenReview.js';
import { applyReanchor, planReanchor } from '../graph/goldenReanchor.js';

function fail(message: string): never {
  console.error(`edge-golden: ${message}`);
  process.exit(1);
}

type Mode = 'sample' | 'prepare' | 'submit' | 'status' | 'owner-sample' | 'reset' | 'review-prepare' | 'review-submit' | 'top-weight' | 'reanchor';
let dryRun = false;
let mode: Mode | undefined;
let round: number | undefined;
let buildId: number | undefined;
const argv = process.argv.slice(2);
const num = (a: string, v: string | undefined) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) fail(`${a} needs a whole number 1 or more`);
  return n;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === '--sample') mode = 'sample';
  else if (a === '--round') round = num(a, argv[++i]);
  else if (a === '--prepare-round') { mode = 'prepare'; round = num(a, argv[++i]); }
  else if (a === '--submit-round') { mode = 'submit'; round = num(a, argv[++i]); }
  else if (a === '--status') mode = 'status';
  else if (a === '--owner-sample') mode = 'owner-sample';
  else if (a === '--review-prepare') mode = 'review-prepare';
  else if (a === '--review-submit') mode = 'review-submit';
  else if (a === '--reset-round') { mode = 'reset'; round = num(a, argv[++i]); }
  else if (a === '--top-weight') mode = 'top-weight';
  else if (a === '--build') buildId = num(a, argv[++i]);
  else if (a === '--reanchor') mode = 'reanchor';
  else if (a === '--dry-run') dryRun = true;
  else fail(`unknown argument ${a}`);
}
if (!mode) fail('give --sample --round <n>, --prepare-round <n>, --submit-round <n>, --reset-round <n>, --status, --owner-sample, --review-prepare, --review-submit, --top-weight --build <id> or --reanchor [--dry-run]');
if (mode === 'sample' && round === undefined) fail('--sample needs --round <n>');
if (mode === 'top-weight' && buildId === undefined) fail('--top-weight needs --build <id>');

const policy = loadGraphPolicy();
const db = openDb();
const stale = retireStalePairs(db);
if (stale > 0) console.log(`${stale} pair(s) are now stale: one of their texts changed`);

function printStatus(): void {
  const p = targetProgress(db, policy);
  console.log(`labelled pairs: ${p.labelled} (cap ${policy.golden.cap})`);
  for (const t of p.targets) console.log(`  ${t.have >= t.want ? 'met ' : 'open'}  ${t.target.padEnd(48)} ${t.have}/${t.want}`);
  console.log(p.met ? 'all targets are met' : p.labelled >= policy.golden.cap ? 'the cap is reached: record the real counts (spec sec. 11.2)' : 'targets are open');
  const byStatus = db.prepare('SELECT status, COUNT(*) n FROM edge_golden_pairs GROUP BY status ORDER BY status').all() as Array<{ status: string; n: number }>;
  console.log(`pairs by status: ${byStatus.map((r) => `${r.status} ${r.n}`).join(', ') || '(none)'}`);
  const rv = reviewAgreement(db);
  if (rv.reviewed > 0) {
    console.log(`reviewer on owner sample ${rv.sample}: ${rv.reviewed} reviewed, ${rv.agree} agree, ${rv.clause_differs} same label with other clauses, `
      + `${rv.label_differs} other label, ${rv.invalid} invalid; label agreement ${rv.rate === null ? '-' : `${(rv.rate * 100).toFixed(0)}%`}`);
    if (rv.label_differs >= policy.golden.owner_correction_limit) {
      console.log(`  ${rv.label_differs} label differences reach the limit ${policy.golden.owner_correction_limit}: the label instructions must change (spec sec. 11.4)`);
    }
  }
  const a = ownerAgreement(db);
  if (a.sample > 0) {
    console.log(`owner sample ${a.sample}: ${a.decided}/${a.sampled} decided, ${a.corrected} corrected, `
      + `${a.resolved_disputed} disputed pairs resolved, agreement ${a.rate === null ? '-' : `${(a.rate * 100).toFixed(0)}%`}`);
    if (a.corrected >= policy.golden.owner_correction_limit) {
      console.log(`  ${a.corrected} corrections reach the limit ${policy.golden.owner_correction_limit}: change the label instructions with the owner (spec sec. 11.4)`);
    }
  }
}

try {
  switch (mode) {
    case 'sample': {
      const r = round!;
      if (r > 1 && !db.prepare('SELECT 1 FROM edge_golden_pairs WHERE round = ? LIMIT 1').get(r - 1)) fail(`round ${r - 1} is not sampled yet`);
      const progress = targetProgress(db, policy);
      if (progress.met) fail('all targets are met: no new round is necessary');
      if (progress.labelled >= policy.golden.cap) fail(`the cap of ${policy.golden.cap} labelled pairs is reached`);
      const pairs = sampleRound(db, r, policy, { slice: loadSlice(db) });
      const ids = persistRound(db, r, pairs);
      const by = new Map<string, number>();
      for (const p of pairs) by.set(p.stratum, (by.get(p.stratum) ?? 0) + 1);
      console.log(`round ${r}: ${ids.length} pairs sampled (ids ${ids[0]}-${ids[ids.length - 1]})`);
      for (const [s, n] of by) console.log(`  ${s.padEnd(24)} ${n}`);
      break;
    }
    case 'prepare': {
      const dirs = prepareLabelRound(db, round!, policy);
      const sizes = db.prepare('SELECT batch_index, packet_bytes FROM edge_golden_batches WHERE round = ? ORDER BY batch_index')
        .all(round!) as Array<{ batch_index: number; packet_bytes: number }>;
      console.log(`round ${round}: ${sizes.length} batches, ${dirs.length} pass directories under ${goldenBatchesDir()}`);
      for (const s of sizes) {
        const over = s.packet_bytes > policy.packet_budget_bytes ? `  OVER the budget of ${policy.packet_budget_bytes} bytes` : '';
        console.log(`  batch ${String(s.batch_index).padStart(3, '0')}: ${(s.packet_bytes / 1000).toFixed(1)} KB${over}`);
      }
      console.log('Dispatch one fresh edge-golden-labeler subagent for each pass directory, with the path only:');
      for (const d of dirs) console.log(`  ${d}`);
      break;
    }
    case 'submit': {
      const t = submitLabelRound(db, round!);
      console.log(`round ${round}: ${t.accepted} accepted, ${t.disputed} disputed; ${t.rejected} pass answers gave no vote`);
      if (t.stale > 0) console.log(`  ${t.stale} pair(s) skipped: they went stale after the prepare`);
      printStatus();
      break;
    }
    case 'status':
      printStatus();
      break;
    case 'review-prepare': {
      const dirs = prepareReview(db, policy);
      console.log(`review: ${dirs.length} batch directories. Dispatch one fresh edge-golden-reviewer subagent for each, with the path only:`);
      for (const d of dirs) console.log(`  ${d}`);
      break;
    }
    case 'review-submit': {
      const t = submitReview(db);
      console.log(`review: ${t.agree} agree, ${t.clause_differs} same label with other clauses, ${t.label_differs} other label (now disputed), `
        + `${t.invalid} invalid, ${t.skipped} skipped`);
      printStatus();
      break;
    }
    case 'reset': {
      const r = resetLabelRound(db, round!);
      console.log(`round ${round}: ${r.pairs} pairs are sampled again; votes and batches removed`);
      if (r.archived) console.log(`  the old pass directories are now ${r.archived}`);
      console.log(`  next: npm run edge-golden -- --prepare-round ${round}`);
      break;
    }
    case 'top-weight': {
      if (db.prepare("SELECT 1 FROM edge_golden_pairs WHERE stratum = 'top_weight' LIMIT 1").get()) fail('the top_weight pairs are already added');
      const r = nextRound(db);
      const pairs = samplePairsByWeight(db, buildId!, policy.golden.top_weight);
      const ids = persistRound(db, r, pairs);
      console.log(`round ${r}: ${ids.length} top_weight pairs of build ${buildId} sampled (ids ${ids[0]}-${ids[ids.length - 1]})`);
      console.log(`  next: npm run edge-golden -- --prepare-round ${r}`);
      break;
    }
    case 'reanchor': {
      const items = planReanchor(db);
      const by = (o: string) => items.filter((it) => it.outcome === o).length;
      console.log(`atom references: ${items.length} - same ${by('same')}, moved ${by('moved')}, twin ${by('twin')}, lost ${by('lost')}`);
      for (const it of items.filter((x) => x.outcome !== 'same')) {
        console.log(`  pair ${it.pair_id} ${it.side}: ${it.old_type} #${it.old_atom_id} -> ${it.outcome === 'lost' ? `lost (on the span now: ${it.types_on_span.join(', ') || 'nothing'})` : `${it.new_type} #${it.new_atom_id}`} | ${it.old_quote}`);
      }
      if (dryRun) { console.log('dry run - nothing written'); break; }
      console.log(`written: ${applyReanchor(db, items)} atom reference(s) changed`);
      break;
    }
    case 'owner-sample': {
      const ids = selectOwnerSample(db, policy);
      console.log(`owner sample: ${ids.length} pairs. The owner decides each pair on /edge-golden.`);
      console.log(`  pair ids: ${ids.join(', ')}`);
      const gaps = ownerSampleGaps(db);
      if (gaps.length) console.log(`  strata not in the sample (disputed pairs only, beyond the maximum of 8): ${gaps.join(', ')}. The owner decides (spec sec. 11.4).`);
      break;
    }
  }
} catch (err) {
  fail((err as Error).message);
}
