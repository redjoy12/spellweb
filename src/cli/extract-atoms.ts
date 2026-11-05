/**
 * `npm run extract` (plan Task 8, amended 2026-10-04). Extraction by file protocol: this CLI
 * writes batch packets and validates batch responses; a fresh Claude Code subagent per batch
 * (`.claude/agents/atom-extractor.md`) reads `packet.md` and writes `response.json`. The CLI
 * itself makes no model calls.
 *
 *   --prepare --batch golden|full     every golden card / every pending extraction_queue row
 *   --prepare --batch stratified      the Task 11 stratified batch (select-batch.ts)
 *       [--sample 400] [--seed 1]
 *   --prepare --batch slice --colours BR   the Task 12a colour slice: every live card whose
 *                                     colour identity is a subset of the colours (run kind 'colors')
 *   --prepare --card <oracle_id> ...  named cards (repeatable); recorded as batch 'requeue'
 *       [--size 25] [--limit N] [--model <id>]
 *   --submit <batch-dir> ...          validate + persist one or more batches
 *   --submit-run <run_id>             every batch of the run that has a response and is not submitted
 *   --status [--run <run_id>]         batch states for a run (default: the latest)
 *   --escalate <run_id> [--size 25]   write the sec. 7.2 voting-pass batches for the run's escalated cards
 *   --finalise <run_id>               write verdicts + review-queue findings for a run submitted before Task 9
 *
 * Golden and stratified batches never consume the production queue; `full`, a colour slice and named
 * cards mark each extracted card done.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb } from '../db/client.js';
import { loadPacketPolicy } from '../rules/relevance.js';
import { selectColourSlice, selectStratifiedBatch } from './select-batch.js';
import {
  DEFAULT_BATCH_SIZE, batchesDir, finaliseRun, prepareEscalation, prepareRun, runStatus, submitBatch,
  type BatchKind, type SubmitSummary,
} from '../atoms/extractBatch.js';

function fail(message: string): never {
  console.error(`extract: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const out = {
    mode: '' as '' | 'prepare' | 'submit' | 'submit-run' | 'status' | 'escalate' | 'finalise',
    batch: undefined as 'golden' | 'stratified' | 'slice' | 'full' | undefined, cards: [] as string[], dirs: [] as string[],
    size: DEFAULT_BATCH_SIZE, limit: Infinity, model: 'claude-sonnet-5-5', run: undefined as number | undefined,
    sample: 400, seed: 1, colours: '',
  };
  const setMode = (m: typeof out.mode) => {
    if (out.mode && out.mode !== m) throw new Error(`--${out.mode} and --${m} cannot be combined`);
    out.mode = m;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--prepare') setMode('prepare');
    else if (a === '--submit') { setMode('submit'); out.dirs.push(val()); }
    else if (a === '--submit-run') { setMode('submit-run'); out.run = Number(val()); }
    else if (a === '--status') setMode('status');
    else if (a === '--escalate') { setMode('escalate'); out.run = Number(val()); }
    else if (a === '--finalise') { setMode('finalise'); out.run = Number(val()); }
    else if (a === '--batch') {
      const b = val();
      if (b !== 'golden' && b !== 'stratified' && b !== 'slice' && b !== 'full') {
        throw new Error(`unknown batch ${b} (golden|stratified|slice|full)`);
      }
      out.batch = b;
    }
    else if (a === '--card') out.cards.push(val());
    else if (a === '--size') out.size = Number(val());
    else if (a === '--limit') out.limit = Number(val());
    else if (a === '--model') out.model = val();
    else if (a === '--sample') out.sample = Number(val());
    else if (a === '--seed') out.seed = Number(val());
    else if (a === '--colours' || a === '--colors') out.colours = val();
    else if (a === '--run') out.run = Number(val());
    else if (out.mode === 'submit' && !a.startsWith('--')) out.dirs.push(a);
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const args = (() => {
  try { return parseArgs(process.argv.slice(2)); } catch (err) { return fail((err as Error).message); }
})();
if (!args.mode) fail('give --prepare, --submit, --submit-run, --status, --escalate or --finalise');
if ((args.mode === 'escalate' || args.mode === 'finalise') && !Number.isInteger(args.run)) fail(`--${args.mode} needs a run id`);

/** The most recent run that has batches on disk. */
function latestRun(): number {
  const root = batchesDir();
  const ids = existsSync(root)
    ? readdirSync(root).map((d) => /^run-(\d+)$/.exec(d)?.[1]).filter((x): x is string => !!x).map(Number)
    : [];
  return ids.length ? Math.max(...ids) : fail(`no runs under ${root}`);
}

function printSummary(s: SubmitSummary): void {
  const rejected = Object.values(s.rejectedBy).reduce((a, b) => a + b, 0);
  console.log(`${s.batch}${s.passIndex ? ` (voting pass ${s.passIndex})` : ''}: ${s.extracted} extracted, ${s.failed} failed - ` +
    `${s.atoms} atoms (${s.ambiguous} span_ambiguous), ` +
    `${rejected} rejected${rejected ? ` [${Object.entries(s.rejectedBy).map(([k, n]) => `${k} ${n}`).join(', ')}]` : ''}, ` +
    `${s.missingRules} missing-rule, ${s.unclassified} unclassified`);
  console.log(`    verdicts: ${s.outcomes.passed} passed, ${s.outcomes.flagged} flagged` +
    `${s.passIndex ? `, ${s.voted} card(s) voted` : ''} - ${s.findings} review-queue finding(s)`);
  for (const f of s.failures) console.log(`    FAILED ${f.key} ${f.oracle_id}: ${f.reason}`);
  for (const r of s.rejections) console.log(`    rejected ${r.key} - ${r.reason}`);
}

const db = openDb();

if (args.mode === 'prepare') {
  if (args.cards.length === 0 && !args.batch) fail('give --batch golden|stratified|slice|full or --card <oracle_id>');
  if (args.batch === 'slice' && !args.colours) fail('--batch slice needs --colours, e.g. --colours BR');
  // Neighbouring cards share rules; colour then mana value keeps packets small (measured).
  const order = 'ORDER BY c.color_identity, c.cmc, c.oracle_id';
  const inOrder = (pick: string[]) =>
    (db.prepare(`SELECT c.oracle_id FROM cards c JOIN json_each(?) j ON j.value = c.oracle_id ${order}`)
      .all(JSON.stringify(pick)) as Array<{ oracle_id: string }>).map((r) => r.oracle_id);
  const ids = args.cards.length > 0 ? args.cards
    : args.batch === 'golden'
      ? (db.prepare(`SELECT g.oracle_id FROM golden_cards g JOIN cards c USING (oracle_id) ${order}`).all() as
          Array<{ oracle_id: string }>).map((r) => r.oracle_id)
    : args.batch === 'stratified'
      ? inOrder(selectStratifiedBatch(db, { size: args.sample, seed: args.seed }))
    : args.batch === 'slice'
      ? (() => {
          try { return inOrder(selectColourSlice(db, args.colours)); } catch (err) { return fail((err as Error).message); }
        })()
      : (db.prepare(`SELECT q.oracle_id FROM extraction_queue q JOIN cards c USING (oracle_id)
                      WHERE q.status = 'pending' ${order}`).all() as Array<{ oracle_id: string }>).map((r) => r.oracle_id);
  const selected = ids.slice(0, args.limit);
  if (selected.length === 0) fail('nothing to extract');
  const batchKind: BatchKind = args.cards.length > 0 ? 'requeue' : args.batch === 'slice' ? 'colors' : args.batch!;
  const { runId, batches } = prepareRun(db, {
    batchKind, oracleIds: selected, size: args.size, model: args.model, policy: loadPacketPolicy(),
  });
  console.log(`run ${runId}: ${batchKind}, ${selected.length} card(s) in ${batches.length} batch(es) of up to ${args.size}`);
  for (const b of batches) {
    console.log(`  ${b}  (${Math.round(statSync(join(b, 'packet.md')).size / 1000)}k chars)`);
  }
  console.log('Dispatch one fresh atom-extractor subagent per batch, then `npm run extract -- --submit-run ' + runId + '`.');
} else if (args.mode === 'submit' || args.mode === 'submit-run') {
  const dirs = args.mode === 'submit'
    ? args.dirs.map((d) => resolve(d))
    : runStatus(args.run ?? fail('--submit-run needs a run id')).batches
        .filter((b) => b.state === 'responded').map((b) => b.dir);
  if (dirs.length === 0) fail('no batch with a response waiting to be submitted');
  for (const d of dirs) {
    try {
      const s = submitBatch(db, d);
      printSummary(s);
      if (s.runComplete) console.log('run complete');
    } catch (err) {
      console.error(`extract: ${d}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
} else if (args.mode === 'escalate') {
  const plan = prepareEscalation(db, args.run!, { policy: loadPacketPolicy(), size: args.size });
  console.log(`run ${plan.runId}: ${plan.cards.length} card(s) escalate to voting, ${plan.batches.length} new batch(es)`);
  for (const b of plan.batches) {
    console.log(`  ${b}  (${Math.round(statSync(join(b, 'packet.md')).size / 1000)}k chars)`);
  }
  if (plan.batches.length > 0) {
    console.log('Dispatch one fresh atom-extractor subagent per batch, then `npm run extract -- --submit-run ' + plan.runId + '`.');
  }
} else if (args.mode === 'finalise') {
  const c = finaliseRun(db, args.run!);
  console.log(`run ${args.run}: ${c.passed} passed, ${c.flagged} flagged, ${c.failed} failed - ${c.findings} new review-queue finding(s)`);
} else {
  const st = runStatus(args.run ?? latestRun());
  const count = (state: string) => st.batches.filter((b) => b.state === state).length;
  console.log(`run ${st.runId} (${st.dir}): ${st.batches.length} batch(es) - ` +
    `${count('submitted')} submitted, ${count('responded')} responded, ${count('prepared')} awaiting a response`);
  for (const b of st.batches) console.log(`  ${b.state.padEnd(9)} ${b.cards} card(s)  ${b.dir}`);
}
db.close();
