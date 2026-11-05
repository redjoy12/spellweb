/**
 * npm run graph -- --groups [--scope BR]
 * npm run graph -- --build [--scope BR]
 * npm run graph -- --score --build <id> [--report <md>]
 * npm run graph -- --cycles --build <id> --card <oracle_id> [--confirmed-only]
 * npm run graph -- --cycles --build <id> --measure <n> [--report <md>]
 * npm run graph -- --sweep --build <id> [--dry-run] [--size 25] [--model <id>] (--dry-run writes nothing)
 * npm run graph -- --sweep --build <id> --run <run_id> [--size 25]
 *
 * Phase 3 plan Task 1 Step 11: writes the ability groups (spec sec. 4) of every card in the
 * scope that has current atoms. It refuses to run until the owner has approved the current
 * tests_version of config/text-tests.json (plan D14), and it stops when a quote fails (sec. 4.2).
 * Plan Task 4 Step 7: --build makes a graph build (spec sec. 7) from the accepted edge-rule set,
 * or reuses the build with the same key. Plan Task 5 Step 4: --score --build <id> measures a build
 * against the edge golden set (spec sec. 12.2) and writes the report. Plan Task 6 Step 5: --cycles
 * gives the best cycles of one card with their tiers (spec sec. 9), or measures the cycle limits
 * on a sample of cards. Plan Task 8 Step 4: --sweep --build <id> gives the degree sweep (spec
 * sec. 14.1). It prints the four lists of `sweepCandidates`, then writes a `requeue` run for the
 * cards to requeue (the Phase 2 requeue protocol: one fresh atom-extractor subagent per batch,
 * then `npm run extract -- --submit-run <run_id>`). After that submit, --sweep --build <id>
 * --run <run_id> writes the voting passes of those cards with `forceCards`. Each --sweep ends
 * with `rerankAtomQueue` (sec. 14.2). --build also reranks the queue after a new build.
 */
import { writeFileSync } from 'node:fs';
import { openDb } from '../db/client.js';
import { currentCorpusId } from '../atoms/golden.js';
import { addEffects, emptyEffects, GroupConflictError, groupsForCard, persistGroups, type GroupKind } from '../graph/groups.js';
import { scopeCards, type Scope } from '../graph/intrinsic.js';
import { approvalProblem, loadTextTests, verifyTextTests } from '../graph/textTests.js';
import { buildGraph } from '../graph/build.js';
import { renderScoreReport, scoreData } from '../graph/scoreReport.js';
import { BuildIndex } from '../graph/buildIndex.js';
import { balanceContext } from '../graph/balance.js';
import { cardCycles, cycleGraphs, type Limits, type TieredCycle } from '../graph/cardCycles.js';
import { renderMeasure, runMeasure, sampleCards, typePairShares, wideTypePairs } from '../graph/cycleMeasure.js';
import { loadGraphPolicy } from '../graph/policy.js';
import { sweepCandidates } from '../graph/sweep.js';
import { rerankAtomQueue } from '../atoms/queue.js';
import { DEFAULT_BATCH_SIZE, prepareEscalation, prepareRun, runStatus } from '../atoms/extractBatch.js';
import { loadPacketPolicy } from '../rules/relevance.js';

function fail(message: string): never {
  console.error(`graph: ${message}`);
  process.exit(1);
}

let mode: 'groups' | 'build' | 'score' | 'cycles' | 'sweep' | undefined;
let scope: Scope = 'BR';
let buildId: number | undefined;
let report: string | undefined;
let card: string | undefined;
let measure: number | undefined;
let confirmedOnly = false;
let runId: number | undefined;
let size = DEFAULT_BATCH_SIZE;
let model = 'claude-sonnet-5-5';
let dryRun = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  const val = () => argv[++i] ?? fail(`${a} needs a value`);
  if (a === '--groups') mode = 'groups';
  else if (a === '--build') {
    // `--score --build <id>` names a build; a bare `--build` makes one.
    const next = argv[i + 1];
    if (next !== undefined && /^\d+$/.test(next)) { buildId = Number(next); i++; } else if (mode !== 'score' && mode !== 'cycles' && mode !== 'sweep') mode = 'build';
  } else if (a === '--score') mode = 'score';
  else if (a === '--sweep') mode = 'sweep';
  else if (a === '--run') runId = Number(val());
  else if (a === '--size') size = Number(val());
  else if (a === '--model') model = val();
  else if (a === '--dry-run') dryRun = true;
  else if (a === '--cycles') mode = 'cycles';
  else if (a === '--card') card = val();
  else if (a === '--measure') measure = Number(val());
  else if (a === '--confirmed-only') confirmedOnly = true;
  else if (a === '--report') report = val();
  else if (a === '--scope') {
    const s = val().toUpperCase();
    if (s !== 'B' && s !== 'R' && s !== 'BR') fail(`unknown scope ${s} (B, R or BR)`);
    scope = s;
  } else fail(`unknown argument ${a}`);
}
if (!mode) fail('give --groups, --build, --score --build <id>, --cycles --build <id> or --sweep --build <id>');
if (mode === 'sweep') {
  if (buildId === undefined) fail('--sweep needs --build <id>');
  if (runId !== undefined && !Number.isInteger(runId)) fail('--run needs a run id');
  const db = openDb();
  let s: ReturnType<typeof sweepCandidates>;
  try {
    s = sweepCandidates(db, buildId, loadGraphPolicy());
  } catch (err) {
    fail((err as Error).message);
  }
  const nameOf = db.prepare('SELECT name FROM cards WHERE oracle_id = ?');
  const degreeOf = db.prepare('SELECT out_degree + in_degree + class_edges AS n FROM card_degree WHERE build_id = ? AND oracle_id = ?');
  const line = (id: string) => `    ${String((degreeOf.get(buildId, id) as { n: number }).n).padStart(6)}  ${id}  ${(nameOf.get(id) as { name: string } | undefined)?.name ?? '?'}`;
  console.log(`build ${buildId}: sweep (spec sec. 14.1)`);
  console.log(`  ranked ${s.ranked.length} cards; selected ${s.selected.length} (top share ${loadGraphPolicy().sweep.top_share})`);
  console.log(`  already voted on the current schema: ${s.alreadyVoted.length}`);
  for (const id of s.alreadyVoted) console.log(line(id));
  console.log(`  to requeue: ${s.toRequeue.length}`);
  for (const id of s.toRequeue) console.log(line(id));
  const policy = loadPacketPolicy();
  if (s.toRequeue.length > 0 && !dryRun) {
    if (runId === undefined) {
      const open = db.prepare("SELECT id FROM extraction_runs WHERE batch_kind = 'requeue' AND status = 'in_progress' ORDER BY id").all() as Array<{ id: number }>;
      if (open.length > 0) fail(`requeue run ${open.map((r) => r.id).join(', ')} is not complete; finish it with --sweep --build ${buildId} --run <run_id>`);
      // Neighbouring cards share rules; colour then mana value keeps packets small (as extract --prepare).
      const ordered = (db.prepare('SELECT c.oracle_id FROM cards c JOIN json_each(?) j ON j.value = c.oracle_id ORDER BY c.color_identity, c.cmc, c.oracle_id')
        .all(JSON.stringify(s.toRequeue)) as Array<{ oracle_id: string }>).map((r) => r.oracle_id);
      const r = prepareRun(db, { batchKind: 'requeue', oracleIds: ordered, size, model, policy });
      console.log(`run ${r.runId}: requeue, ${ordered.length} card(s) in ${r.batches.length} batch(es) of up to ${size}`);
      for (const b of r.batches) console.log(`  ${b}`);
      console.log(`Dispatch one fresh atom-extractor subagent per batch, then \`npm run extract -- --submit-run ${r.runId}\`,`);
      console.log(`then \`npm run graph -- --sweep --build ${buildId} --run ${r.runId}\` for the voting passes.`);
    } else {
      const waiting = runStatus(runId).batches.filter((b) => b.state !== 'submitted');
      if (waiting.length > 0) fail(`run ${runId} has ${waiting.length} batch(es) not submitted; submit them first`);
      const plan = prepareEscalation(db, runId, { policy, size, forceCards: s.toRequeue });
      const inRun = new Set(plan.cards);
      const missing = s.toRequeue.filter((id) => !inRun.has(id));
      console.log(`run ${runId}: ${plan.cards.length} card(s) escalate to voting, ${plan.batches.length} new batch(es)`);
      for (const b of plan.batches) console.log(`  ${b}`);
      if (plan.batches.length > 0) {
        console.log(`Dispatch one fresh atom-extractor subagent per batch, then \`npm run extract -- --submit-run ${runId}\`.`);
      }
      if (missing.length > 0) {
        console.log(`  ${missing.length} card(s) to requeue have no submitted first pass in run ${runId}; prepare them again:`);
        for (const id of missing) console.log(line(id));
      }
    }
  } else if (s.toRequeue.length === 0) console.log('  sweep complete: every selected card is voted on the current schema');
  if (!dryRun) console.log(`  review queue: ${rerankAtomQueue(db)} pending atom finding(s) reranked (spec sec. 14.2)`);
  process.exit(0);
}
if (mode === 'cycles') {
  if (buildId === undefined) fail('--cycles needs --build <id>');
  if ((card === undefined) === (measure === undefined)) fail('--cycles needs --card <oracle_id> or --measure <n>');
  const db = openDb();
  const t0 = performance.now();
  let index: BuildIndex;
  try {
    index = BuildIndex.load(db, buildId);
  } catch (err) {
    fail((err as Error).message);
  }
  const balance = balanceContext(db, index, loadTextTests());
  const c = loadGraphPolicy().cycles;
  const policyLimits: Limits = { maxLength: c.max_length, topK: c.top_k, budget: c.budget };
  console.log(`build ${buildId}: index ${Math.round(performance.now() - t0)} ms`);
  const nameOf = db.prepare('SELECT name FROM cards WHERE oracle_id = ?');
  const groupName = (g: string) => {
    const [id, face, gi] = g.split('#');
    return `${(nameOf.get(id!) as { name: string } | undefined)?.name ?? id}#${face}#${gi}`;
  };
  if (card !== undefined) {
    if (index.atomsOfCard(card).length === 0) fail(`card ${card} has no atoms in build ${buildId}`);
    const r = cardCycles(index, cycleGraphs(index, confirmedOnly), balance, card, policyLimits);
    const show = (title: string, s: typeof r.engine) => {
      console.log(`${title}: ${s.cycles.length} cycles, ${s.exact ? 'exact' : 'budget_reached'}, ${s.expansions} expansions, ${s.ms.toFixed(1)} ms`);
      for (const x of s.cycles as TieredCycle[]) {
        const flags = [x.unresolved.length ? `unresolved(${x.unresolved.join(',')})` : '', x.has_plausible ? 'has_plausible' : '',
          x.tier === 2 && x.per_turn_limit ? 'per_turn_limit' : ''].filter(Boolean).join(' ');
        console.log(`  tier ${x.tier}  ${x.score.toFixed(4)}  ${x.groups.map(groupName).join(' -> ')}${flags ? `  [${flags}]` : ''}`);
      }
    };
    console.log(`limits: length ${policyLimits.maxLength}, K ${policyLimits.topK}, budget ${policyLimits.budget}${confirmedOnly ? ', confirmed edges only' : ''}`);
    show('engine search', r.engine);
    if (r.more_engine) console.log('  more engine cycles can exist');
    show('full search (cycles not in the engine list)', r.full);
    process.exit(0);
  }
  const cards = sampleCards(db, index, measure!);
  const configs: Limits[] = [];
  for (const maxLength of [3, 4, 5]) for (const budget of [50_000, 200_000, 1_000_000]) configs.push({ maxLength, topK: policyLimits.topK, budget });
  // K: two more values at the policy length and budget.
  for (const topK of [20, 100]) configs.push({ maxLength: policyLimits.maxLength, topK, budget: policyLimits.budget });
  console.log(`measure: ${cards.length} cards, ${configs.length} configs`);
  let last = '';
  const rows = runMeasure(index, balance, cards, configs, (r) => {
    const k = `L${r.limits.maxLength} K${r.limits.topK} B${r.limits.budget}`;
    if (k !== last) { console.log(`  config ${k} (${Math.round((performance.now() - t0) / 1000)} s)`); last = k; }
  });
  const shares = typePairShares(db, index);
  const wide = wideTypePairs(shares);
  const selected = configs.find((x) => x.maxLength === policyLimits.maxLength && x.budget === policyLimits.budget && x.topK === policyLimits.topK) ?? configs[0]!;
  const md = renderMeasure({ buildId, date: new Date().toISOString().slice(0, 10), rows, configs, selected, index, wide, shares });
  if (report) {
    writeFileSync(report, md);
    console.log(`report written to ${report}`);
  } else console.log(md);
  console.log(`${Math.round((performance.now() - t0) / 1000)} s`);
  process.exit(0);
}
if (mode === 'score') {
  if (buildId === undefined) fail('--score needs --build <id>');
  const db = openDb();
  const started = performance.now();
  let d: ReturnType<typeof scoreData>;
  try {
    d = scoreData(db, buildId);
  } catch (err) {
    fail((err as Error).message);
  }
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
  const c = d.full.counts;
  console.log(`build ${buildId}: ${c['scored']} scored golden pairs (${c['synergy']} synergy, ${c['anti']} anti, ${c['none']} none)`);
  console.log(`  full score: synergy recall ${pct(d.full.synergy_recall)} (${c['synergy_found']}/${c['synergy']}), anti recall ${pct(d.full.anti_recall)}`);
  console.log(`  precision: confirmed ${pct(d.full.confirmed_precision)} (${c['confirmed_correct']}/${c['confirmed_items']}), all ${pct(d.full.all_precision)} (${c['all_correct']}/${c['all_items']})`);
  console.log(`  misses: extraction ${c['miss_extraction']}, rule ${c['miss_rule']}, param ${c['miss_param']}`);
  console.log(`  deriver-only: ${pct(d.deriver.recall)} (${d.deriver.found}/${d.deriver.total}); reachable ${pct(d.deriver.reachable.recall)} (${d.deriver.reachable.found}/${d.deriver.reachable.total})`);
  const q = d.quotes;
  console.log(`  quotes: rules ${q.rules.ok}/${q.rules.total}, roles ${q.roles.ok}/${q.roles.total}, golden ${q.golden.ok}/${q.golden.total}`);
  console.log(`  edges: explicit ${d.edges.explicit.ok}/${d.edges.explicit.total}, class ${d.edges.class.ok}/${d.edges.class.total}`);
  if (report) {
    writeFileSync(report, renderScoreReport(d, new Date().toISOString().slice(0, 10)));
    console.log(`  report written to ${report}`);
  }
  console.log(`  ${Math.round(performance.now() - started)} ms`);
  process.exit(0);
}

const tests = loadTextTests();
const unapproved = approvalProblem(tests);
if (unapproved) fail(`config/text-tests.json: ${unapproved}. The owner approves each quote first (plan D14).`);

const db = openDb();
const corpusId = currentCorpusId(db);
let resolved: Array<{ test: string; rule: string }>;
try {
  resolved = verifyTextTests(db, corpusId, tests);
} catch (err) {
  fail((err as Error).message);
}
console.log(`text tests v${tests.tests_version}: ${resolved.length} quotes verified`);
for (const r of resolved) console.log(`  ${r.test.padEnd(16)} ${r.rule}`);

if (mode === 'build') {
  const started = performance.now();
  let result: ReturnType<typeof buildGraph>;
  try {
    result = buildGraph(db, scope, { tests });
  } catch (err) {
    if (err instanceof GroupConflictError) fail(err.message);
    throw err;
  }
  const { buildId, reused, counts: c } = result;
  const grades = (t: { confirmed: number; plausible: number }) => `confirmed ${t.confirmed}, plausible ${t.plausible}`;
  console.log(`build ${buildId} (scope ${scope}, rule set ${c.rule_set.id} v${c.rule_set.version})${reused ? ': reused, the same key exists' : ''}`);
  console.log(`  cards ${c.scope_cards} (${c.cards_with_atoms} with atoms), atoms ${c.atoms}, classes ${c.classes}`);
  console.log(`  atom edges      + ${grades(c.atom_edges['+'])}; - ${grades(c.atom_edges['-'])}`);
  console.log(`  merged edges    + ${grades(c.merged_edges['+'])}; - ${grades(c.merged_edges['-'])}`);
  console.log(`  merges ${c.merges} (edges with 2+ rules: ${c.multi_rule_edges})`);
  console.log(`  class edges     + ${grades(c.class_edges['+'])}; - ${grades(c.class_edges['-'])}`);
  console.log(`  card pairs ${c.synergy_pairs} (self ${c.self_pairs}), anti pairs ${c.anti_pairs} (both directions)`);
  console.log(`  rules with edges ${c.rules_with_edges}, without ${c.rules_without_edges}; ranks refreshed ${c.ranks_refreshed}`);
  console.log('  top 10 gap rows:');
  for (const g of db.prepare('SELECT gap_kind, type_key, param, count FROM graph_gaps WHERE build_id = ? ORDER BY count DESC, gap_kind, type_key, param LIMIT 10')
    .all(buildId) as Array<{ gap_kind: string; type_key: string; param: string; count: number }>) {
    console.log(`    ${String(g.count).padStart(8)}  ${g.gap_kind.padEnd(22)} ${g.type_key}${g.param ? ` ${g.param}` : ''}`);
  }
  console.log(`  build time ${JSON.stringify(c.timings_ms)}; this run ${Math.round(performance.now() - started)} ms`);
  console.log(`  review queue: ${rerankAtomQueue(db)} pending atom finding(s) reranked (spec sec. 14.2)`);
  process.exit(0);
}

const hasAtoms = db.prepare('SELECT 1 FROM atoms WHERE oracle_id = ? AND is_current = 1 LIMIT 1');
const cards = scopeCards(db, scope).filter((id) => hasAtoms.get(id));

const kinds: Record<GroupKind, number> = { triggered: 0, activated: 0, other: 0 };
const effects = emptyEffects();
let groups = 0;
let inserted = 0;
let ambiguous = 0;
let noGroup = 0;
db.exec('BEGIN');
try {
  for (const id of cards) {
    const r = groupsForCard(db, id, tests);
    if (r.groups.length === 0) noGroup++;
    groups += r.groups.length;
    ambiguous += r.ambiguous;
    for (const g of r.groups) kinds[g.kind]++;
    addEffects(effects, r.effects);
    inserted += persistGroups(db, r.groups);
  }
  if (noGroup > 0) {
    db.exec('ROLLBACK');
    fail(`${noGroup} cards with atoms have no group; nothing is written`);
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  if (err instanceof GroupConflictError) fail(err.message);
  throw err;
}

console.log(`scope ${scope}: ${cards.length} cards with atoms, ${groups} groups (${inserted} new rows)`);
console.log(`  kinds: triggered ${kinds.triggered}, activated ${kinds.activated}, other ${kinds.other}`);
console.log(`  ambiguous atoms: ${ambiguous}`);
console.log('  project-decision effects:');
for (const [k, v] of Object.entries(effects)) console.log(`    ${k.padEnd(20)} ${v}`);
