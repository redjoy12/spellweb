/**
 * `npm run edge-rules` (Phase 3).
 *
 *   --measure [--report <file.md>]       Task 0: plan the Stage A and Stage B packets (spec sec. 5.2)
 *                                        and write their sizes, chunk counts, coverage gaps and run
 *                                        count range. No model call; the database is opened
 *                                        read-only. The packets go to data/edge-rule-batches/measure/.
 *   --prepare --stage roles [--model m]  Task 3: a new set; three pass directories for each Stage A chunk
 *   --submit-set <set> --stage <stage>   validate (sec. 5.4), vote (sec. 5.3) and store the responses
 *   --status --set <set>                 the counts of a set
 *   --measure --set <set> [--report f]   checkpoint C3: the Stage B batches of the real demand types
 *   --carry-forward --from <set> [--model m]
 *                                        schema v15 plan Task 5: a new set on the current schema that
 *                                        copies the roles of the accepted set and the rules of each
 *                                        demand type whose params do not change (ruleCarry.ts)
 *   --prepare --stage pairs --set <set> [--demand A,B [--supply C,D]]
 *                                        three pass directories for each Stage B chunk; --demand
 *                                        limits the prepare to these demand types (a pilot);
 *                                        --supply shows these candidates again, although a batch
 *                                        showed them (spec sec. 25.5)
 *   --score --set <set>                  the deriver-only score (sec. 12.2, plan D7)
 *   --accept --set <set> [--force]       rule ids; the set becomes accepted, the old one superseded.
 *                                        --force accepts with pending role items (they stay none).
 *   --abandon --set <set>                remove an in-progress set (a failed model gate or prepare)
 *   --debate-prepare --set <set> --stage <stage>
 *                                        spec rev. 9 sec. 5.6: the next debate round of the pending
 *                                        items; three debater directories for each batch
 *   --debate-submit --set <set> --stage <stage>
 *                                        check and store the debate answers; apply each agreed verdict
 *
 * The CLI makes no model call. Fresh `edge-rule-deriver` subagents answer the pass directories,
 * and fresh `edge-rule-debater` subagents the debate directories.
 * The session that runs this CLI never writes a rule, a role or a resource.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, openDb } from '../db/client.js';
import { measurePackets, packetContext, type MeasureReport, type PacketChunk, type PacketContext } from '../graph/edgePackets.js';
import { deriverOnlyScore } from '../graph/deriverScore.js';
import {
  PASSES, planSetPairs, preparePairs, prepareRoles, ruleBatchesDir, setStatus, submitStage, type Stage,
} from '../graph/ruleBatches.js';
import { abandonRuleSet, acceptRuleSet, getRuleSet, setRoles } from '../graph/ruleSet.js';
import { carryForwardSet } from '../graph/ruleCarry.js';
import { stageBTypes } from '../graph/liveTypes.js';
import { DEBATERS, debateStatus, prepareDebate, submitDebate } from '../graph/ruleDebate.js';

const here = dirname(fileURLToPath(import.meta.url));
const MEASURE_DIR = resolve(here, '../../data/edge-rule-batches/measure');
/** The model id that the CLI records on a set (CLAUDE.md model policy; the agent file has the alias). */
const DEFAULT_MODEL = 'claude-sonnet-5-5';

function fail(message: string): never {
  console.error(`edge-rules: ${message}`);
  process.exit(1);
}

type Mode = 'measure' | 'carry' | 'prepare' | 'submit' | 'status' | 'score' | 'accept' | 'abandon' | 'debate-prepare' | 'debate-submit';
let mode: Mode | undefined;
let report: string | undefined;
let stage: Stage | undefined;
let setArg: number | undefined;
let fromArg: number | undefined;
let model = DEFAULT_MODEL;
let force = false;
let demandOnly: Set<string> | undefined;
let supplyAgain: Set<string> | undefined;
const argv = process.argv.slice(2);
const num = (a: string, v: string | undefined) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) fail(`${a} needs a set id 1 or more`);
  return n;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  const val = () => argv[++i] ?? fail(`${a} needs a value`);
  if (a === '--measure') mode = 'measure';
  else if (a === '--report') report = val();
  else if (a === '--prepare') mode = 'prepare';
  else if (a === '--carry-forward') mode = 'carry';
  else if (a === '--from') fromArg = num(a, argv[++i]);
  else if (a === '--submit-set') { mode = 'submit'; setArg = num(a, argv[++i]); }
  else if (a === '--status') mode = 'status';
  else if (a === '--score') mode = 'score';
  else if (a === '--accept') mode = 'accept';
  else if (a === '--abandon') mode = 'abandon';
  else if (a === '--debate-prepare') mode = 'debate-prepare';
  else if (a === '--debate-submit') mode = 'debate-submit';
  else if (a === '--force') force = true;
  else if (a === '--demand') demandOnly = new Set(val().split(',').map((x) => x.trim()).filter(Boolean));
  else if (a === '--supply') supplyAgain = new Set(val().split(',').map((x) => x.trim()).filter(Boolean));
  else if (a === '--set') setArg = num(a, argv[++i]);
  else if (a === '--model') model = val();
  else if (a === '--stage') {
    const s = val();
    if (s !== 'roles' && s !== 'pairs') fail('--stage is roles or pairs');
    stage = s;
  } else fail(`unknown argument ${a}`);
}
if (!mode) fail('give --measure, --carry-forward, --prepare, --submit-set, --status, --score, --accept, --abandon, --debate-prepare or --debate-submit');
// The Task 0 measure state. Declared before the dispatch: measureAll assigns it.
let ctx: PacketContext;
let corpus: { effective_date: string };

if (mode === 'measure' && setArg === undefined) measureAll();
else runSetMode(mode);

function needSet(): number {
  if (setArg === undefined) fail(`--${mode} needs --set <set>`);
  return setArg;
}

function runSetMode(m: Mode): void {
  const db = openDb();
  switch (m) {
    case 'carry': {
      if (fromArg === undefined) fail('--carry-forward needs --from <set>');
      if (setArg !== undefined) fail('--carry-forward makes a new set: do not give --set');
      const r = carryForwardSet(db, fromArg, model);
      console.log(`set ${r.setId} (version ${r.version}, model ${model}, schema v${r.schemaVersion}): carried from set ${r.fromSetId}`);
      console.log(`  roles copied: ${r.roles}; rules copied: ${r.rules} for ${r.carried.length} unchanged demand type(s)`);
      console.log(`  demand types with changed params (Stage B runs again): ${r.changed.length}`);
      const set = getRuleSet(db, r.setId)!;
      const { deferred } = stageBTypes(db, r.setId, packetContext(db, { corpusId: set.corpus_id, schemaVersion: set.schema_version }));
      const live = r.changed.filter((d) => !deferred.includes(d));
      for (const d of r.changed) console.log(`    ${d}${deferred.includes(d) ? '  (deferred: no current atom has it)' : ''}`);
      console.log(`next: npm run edge-rules -- --prepare --stage pairs --set ${r.setId} --demand ${live.join(',')}`);
      break;
    }
    case 'prepare': {
      if (stage === 'roles') {
        if (setArg !== undefined) fail('--prepare --stage roles makes a new set: do not give --set');
        const r = prepareRoles(db, model);
        console.log(`set ${r.setId} (version ${r.version}, model ${model}): ${r.dirs.length / PASSES} Stage A batch(es), ${r.dirs.length} pass directories`);
        if (r.gaps.length) console.log(`coverage gaps, not in a packet (spec sec. 5.2): ${r.gaps.join(', ')}`);
        printDirs(r.dirs);
      } else if (stage === 'pairs') {
        const r = preparePairs(db, needSet(), {}, demandOnly, supplyAgain);
        console.log(`set ${setArg}: ${r.batches} new Stage B batch(es), ${r.dirs.length} pass directories (two-part packets, spec rev. 10 sec. 5.2)`);
        if (r.skipped.length) console.log(`demand types with a batch already: ${r.skipped.length}`);
        if (r.deferred.length) console.log(`deferred types (no current atom has them, spec rev. 10 sec. 5.3): ${r.deferred.length}`);
        if (r.pendingRoles.length) {
          console.log(`pending role items (they stay none; a later decision can add a demand type only): ${r.pendingRoles.join(', ')}`);
        }
        printAgentsWritten(r.agentsWritten);
        console.log(`dispatch one fresh subagent of the named type for each directory under ${ruleBatchesDir()}:`);
        for (const d of r.dirs) console.log(`  ${r.agentOf.get(d)}  ${d}`);
      } else fail('--prepare needs --stage roles or --stage pairs');
      break;
    }
    case 'submit': {
      if (!stage) fail('--submit-set needs --stage roles or --stage pairs');
      const r = submitStage(db, needSet(), stage);
      console.log(`set ${setArg}, ${stage}: ${r.batches} batch(es) stored; items valid ${r.items_valid}, rejected ${r.items_rejected}`);
      console.log(`  accepted ${r.accepted}, disputed ${r.disputed}, missing-rule reports ${r.missing_rules}, review items ${r.queued}`);
      if (r.waiting.length) console.log(`  waiting for responses: ${r.waiting.join(', ')}`);
      if (r.unreadable.length) {
        console.error(`  not stored - dispatch these passes again:\n    ${r.unreadable.join('\n    ')}`);
        process.exitCode = 1;
      }
      break;
    }
    case 'status':
      printStatus(db, needSet());
      break;
    case 'measure': {
      const text = renderStageB(db, needSet());
      if (report) { writeFileSync(report, text); console.log(`report written to ${report}`); } else console.log(text);
      break;
    }
    case 'score': {
      const s = deriverOnlyScore(db, needSet());
      const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
      console.log(`deriver-only score, set ${setArg}: recall ${pct(s.recall)} (${s.found}/${s.total}); bar 90% (spec sec. 12.2)`);
      console.log(`  atom pairs ${s.by_kind.atoms.found}/${s.by_kind.atoms.total}, characteristic pairs ${s.by_kind.characteristic.found}/${s.by_kind.characteristic.total}, excluded (an atom is null) ${s.excluded}`);
      console.log(`  none pairs with a rule: ${s.none_with_rule}/${s.none_total}${s.none_total ? ` (${pct(s.none_with_rule / s.none_total)})` : ''}`);
      console.log(`  Stage B on reachable pairs: ${pct(s.reachable.recall)} (${s.reachable.found}/${s.reachable.total}); pairs that Stage A blocks: ${s.reachable.blocked.length}`);
      for (const b of s.reachable.blocked) console.log(`  blocked: pair ${b.pair_id}: ${b.reason}`);
      for (const x of s.misses) console.log(`  miss: pair ${x.pair_id}: ${x.supply_type} -> ${x.demand_type}`);
      break;
    }
    case 'debate-prepare': {
      if (!stage) fail('--debate-prepare needs --stage roles or --stage pairs');
      const r = prepareDebate(db, needSet(), stage);
      console.log(`set ${setArg}, ${stage}: debate round for ${r.items} item(s) in ${r.batches} batch(es), ${r.dirs.length} debater directories`);
      printAgentsWritten(r.agentsWritten);
      if (r.dirs.length) {
        console.log(`dispatch one fresh ${r.agent ?? 'edge-rule-debater'} subagent for each directory (${DEBATERS} for each batch):`);
        for (const d of r.dirs) console.log(`  ${d}`);
      }
      break;
    }
    case 'debate-submit': {
      if (!stage) fail('--debate-submit needs --stage roles or --stage pairs');
      const r = submitDebate(db, needSet(), stage);
      console.log(`set ${setArg}, ${stage}: ${r.batches} debate batch(es) stored; agreed ${r.agreed}, no agreement ${r.no_agreement}, next round ${r.next_round}`);
      if (Object.keys(r.faults).length) console.log(`  answers that do not count: ${JSON.stringify(r.faults)}`);
      if (r.ignored) console.log(`  answers ignored (unknown item or second answer): ${r.ignored}`);
      if (r.reapplied) console.log(`  earlier not-applied verdicts that apply now: ${r.reapplied}`);
      for (const n of r.not_applied) console.log(`  not applied: ${n}`);
      if (r.waiting.length) console.log(`  waiting for responses: ${r.waiting.join(', ')}`);
      if (r.unreadable.length) {
        console.error(`  not stored - dispatch these debaters again:\n    ${r.unreadable.join('\n    ')}`);
        process.exitCode = 1;
      }
      break;
    }
    case 'abandon':
      abandonRuleSet(db, needSet());
      console.log(`set ${setArg} removed; its pass directories stay under ${ruleBatchesDir()}`);
      break;
    case 'accept':
      acceptRuleSet(db, needSet(), { force });
      console.log(`set ${setArg} accepted; the earlier accepted set is superseded`);
      printStatus(db, setArg!);
      break;
  }
}

/** A session loads agent definitions when it starts: a changed file needs a new session. */
function printAgentsWritten(names: string[]): void {
  if (!names.length) return;
  console.log(`agent files written: ${names.join(', ')}`);
  console.log('  start a NEW session before you dispatch: a session loads agent files only when it starts');
}

function printDirs(dirs: string[]): void {
  console.log(`dispatch one fresh edge-rule-deriver subagent for each directory under ${ruleBatchesDir()}:`);
  for (const d of dirs) console.log(`  ${d}`);
}

function printStatus(db: DatabaseSync, setId: number): void {
  const s = setStatus(db, setId);
  console.log(`set ${s.set.id}: version ${s.set.version}, ${s.set.status}, model ${s.set.model}, schema v${s.set.schema_version}, corpus ${s.set.corpus_id}`);
  for (const st of ['roles', 'pairs'] as const) {
    const x = s.stages[st];
    console.log(`  ${st}: ${x.submitted}/${x.batches} batches submitted, ${x.passes} passes, items valid ${x.items_valid}, rejected ${x.items_rejected}`);
  }
  console.log(`  roles accepted: ${JSON.stringify(s.roles)}; disputed ${s.roles_disputed}`);
  console.log(`  rules: accepted ${s.rules.accepted} (+ ${s.rules.plus}, - ${s.rules.minus}, intrinsic ${s.rules.intrinsic}), disputed ${s.rules.disputed}`);
  console.log(`  rejections: ${JSON.stringify(s.rejections)}`);
  console.log(`  open missing-rule reports: ${s.missing_rules_open}; pending review items: ${JSON.stringify(s.queue_pending)}`);
  if (s.carried) console.log(`  carried from set ${s.carried.from_set_id}: ${s.carried.rules} rules of ${s.carried.demands} demand types, and the roles`);
  const d = debateStatus(db, setId);
  for (const st of ['roles', 'pairs'] as const) {
    console.log(`  debate ${st}: outcomes ${JSON.stringify(d[st].outcomes)}, open rounds ${d[st].open_rounds}, items without outcome ${d[st].waiting_items}`);
  }
}

/** Checkpoint C3 (plan D6, Task 3 Step 8): the Stage B batches of the real demand types. */
function renderStageB(db: DatabaseSync, setId: number): string {
  const set = getRuleSet(db, setId);
  if (!set) fail(`no edge-rule set ${setId}`);
  const plan = planSetPairs(db, setId);
  const status = setStatus(db, setId);
  const chunks = plan.batches.flatMap((b) => b.chunks);
  const kb = (n: number) => `${(n / 1000).toFixed(1)} KB`;
  const disputed = setRoles(db, setId).filter((r) => r.status === 'disputed');
  const supply = new Set(plan.batches.flatMap((b) => b.chunks.flatMap((c) => c.types.slice(1))));
  return [
    '# Phase 3 — Stage B measurement',
    '',
    `**Date:** ${new Date().toISOString().slice(0, 10)}`,
    '**Language:** ASD-STE100 (Simplified Technical English).',
    '**Plan:** `docs/superpowers/plans/2026-10-10-phase-3-synergy-graph.md`, Task 3 Step 8. Checkpoint C3.',
    `**Command:** \`npm run edge-rules -- --measure --set ${setId}${report ? ` --report ${report}` : ''}\``,
    `**Input:** set ${setId} (version ${set.version}, model ${set.model}), corpus ${set.corpus_id}, schema v${set.schema_version}, scope ${plan.ctx.scope}. Packet budget: ${plan.ctx.graph.packet_budget_bytes} bytes.`,
    '',
    'This report uses the real roles of Stage A (plan D6). A demand type is a type with the accepted role `demand` or `both`. A supply candidate is a type with the accepted role `supply` or `both`.',
    '',
    '## 1. Stage A result',
    '',
    '| Role | Types |',
    '|---|---|',
    ...Object.entries(status.roles).map(([r, n]) => `| ${r} (accepted) | ${n} |`),
    `| disputed | ${status.roles_disputed} |`,
    '',
    `A disputed type has the role \`none\` until a person decides it. It gets no Stage B batch now.${disputed.length ? ` The disputed types: ${disputed.map((r) => `\`${r.family}.${r.type_key}\``).join(', ')}.` : ''}`,
    '',
    '## 2. Stage B batches',
    '',
    `| Demand types | Supply candidates | Batches | Chunks | Largest chunk | Runs (${PASSES} × chunks) |`,
    '|---|---|---|---|---|---|',
    `| ${plan.batches.length} | ${supply.size} | ${plan.batches.length} | ${chunks.length} | ${chunks.length ? kb(Math.max(...chunks.map((c) => c.bytes))) : '—'} | ${PASSES * chunks.length} |`,
    '',
    ...(plan.skipped.length ? [`${plan.skipped.length} demand type(s) have a batch already. They are not in the count.`, ''] : []),
    'Two-part packets (spec rev. 10 sec. 5.2). A chunk size below is the batch part. Each generated deriver agent carries the fixed part of its group:',
    '',
    '| Agent | CR references | Agent file |',
    '|---|---|---|',
    ...plan.agents.map((a) => `| ${a.name} | ${a.refs.length} | ${kb(Buffer.byteLength(a.fileText, 'utf8'))} |`),
    '',
    '| Demand type | Chunks | Sizes |',
    '|---|---|---|',
    ...plan.batches.map((b) => `| ${b.demand} | ${b.chunks.length} | ${b.chunks.map((c) => kb(c.bytes)).join(', ')} |`),
    '',
    '## 3. Owner decision',
    '',
    'The owner examines the run count and the disputed Stage A items. Stage B starts only after the owner approves (checkpoint C3).',
    '',
  ].join('\n');
}

// ---- Task 0: the measure before Stage A ---------------------------------------------------------

function measureAll(): void {
  // Read-only, and without openDb: the measure must never run schema DDL or migrations.
  if (!existsSync(DB_PATH)) fail(`no database at ${DB_PATH}`);
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  ctx = packetContext(db);
  corpus = db.prepare('SELECT effective_date FROM rules_corpus WHERE id = ?').get(ctx.corpusId) as { effective_date: string };
  const m = measurePackets(db, ctx, (done, total) => {
    if (done % 50 === 0 || done === total) console.log(`  Stage B batches planned: ${done}/${total}`);
  });
  db.close();

  rmSync(MEASURE_DIR, { recursive: true, force: true });
  const write = (sub: string, c: PacketChunk) => {
    const dir = join(MEASURE_DIR, sub, c.batch_key, `chunk-${c.chunk}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'packet.md'), c.markdown);
  };
  for (const c of m.roles) write('roles', c);
  for (const c of m.pairsLower) write('pairs-lower', c);

  console.log(`Stage A: ${m.roles.length} chunk(s), largest ${kb(largest(m.roles))}`);
  for (const [name, cs] of [['lower', m.pairsLower], ['spec', m.pairsSpec], ['full', m.pairsFull]] as const) {
    console.log(`Stage B ${name}: ${batches(cs)} batches, ${cs.length} chunks, largest ${kb(largest(cs))}`);
  }
  console.log(`coverage gaps: ${m.gaps.length}; runs: lower ${m.runs.lower}, spec ${m.runs.spec}, full ${m.runs.full}`);
  console.log(`packets written to ${MEASURE_DIR}`);

  if (report) {
    writeFileSync(report, renderReport(m));
    console.log(`report written to ${report}`);
  }
}

function kb(n: number): string { return `${(n / 1000).toFixed(1)} KB`; }
function batches(cs: PacketChunk[]): number { return new Set(cs.map((c) => c.batch_key)).size; }
function perBatch(cs: PacketChunk[]): number[] {
  const n = new Map<string, number>();
  for (const c of cs) n.set(c.batch_key, (n.get(c.batch_key) ?? 0) + 1);
  return [Math.min(...n.values()), Math.max(...n.values())];
}
function largest(cs: PacketChunk[]): number { return Math.max(...cs.map((c) => c.bytes)); }

function renderReport(r: MeasureReport): string {
  const budget = ctx.graph.packet_budget_bytes;
  const roleOf = new Map(r.roles.flatMap((c) => c.types.map((t) => [t, `${c.batch_key}, chunk ${c.chunk}`] as const)));
  const bound = (name: string, demands: string, cs: PacketChunk[], runs: number) => {
    const [lo, hi] = perBatch(cs);
    return `| ${name} | ${demands} | ${batches(cs)} | ${cs.length} | ${lo}–${hi} | ${kb(largest(cs))} | ${runs} |`;
  };
  return [
    '# Phase 3 — Edge-rule packet measurement',
    '',
    `**Date:** ${new Date().toISOString().slice(0, 10)}`,
    '**Language:** ASD-STE100 (Simplified Technical English).',
    '**Plan:** `docs/superpowers/plans/2026-10-10-phase-3-synergy-graph.md`, Task 0. Checkpoint C1.',
    `**Command:** \`npm run edge-rules -- --measure --report ${report}\``,
    `**Input:** corpus ${ctx.corpusId} (CR ${corpus.effective_date}), schema v${ctx.schemaVersion}, scope ${ctx.scope}. Packet budget: ${budget} bytes (\`config/graph-policy.json\`).`,
    '',
    'This report gives the size of the edge-rule packets before a subagent runs (spec §5.2). The instructions and answer formats are placeholders in Task 0. Task 3 writes the final texts, so each packet becomes larger by their size.',
    '',
    `The packets are in \`data/edge-rule-batches/measure/\`. The directory has the Stage A packets and the Stage B packets of the lower bound. The other Stage B packets were measured but not written.`,
    '',
    '## 1. Stage A — roles and resources',
    '',
    r.roles.length === 1
      ? 'All types fit in one packet.'
      : `All types together are larger than the budget. Thus the CLI split Stage A by family (spec §5.2). This gives ${r.roles.length} chunks.`,
    '',
    '| Batch | Chunk | Types | Size |',
    '|---|---|---|---|',
    ...r.roles.map((c) => `| ${c.batch_key} | ${c.chunk} | ${c.types.length} | ${kb(c.bytes)} |`),
    '',
    '## 2. Stage B — pairs',
    '',
    'Stage A has not run, so the demand types are not known (plan D6). Each Stage B batch here has all types as supply candidates. The table gives three bounds:',
    '',
    '- **lower:** one batch for each `CARES_ABOUT` type,',
    '- **spec:** the `CARES_ABOUT` types and the `ENABLES` types (spec §16),',
    '- **full:** one batch for each type.',
    '',
    '| Bound | Demand types | Batches | Chunks | Chunks per batch | Largest chunk | Runs (3 × (Stage A + Stage B chunks)) |',
    '|---|---|---|---|---|---|---|',
    bound('lower', '`CARES_ABOUT`', r.pairsLower, r.runs.lower),
    bound('spec', '`CARES_ABOUT` + `ENABLES`', r.pairsSpec, r.runs.spec),
    bound('full', 'all types', r.pairsFull, r.runs.full),
    '',
    'The full bound is larger than the spec range of §16. Stage A marks only some types as `demand` or `both`. Task 3 measures Stage B again with the real demand types, and the owner examines that number before Stage B starts (checkpoint C3).',
    '',
    '### Lower-bound batches',
    '',
    '| Demand type | Chunk | Supply types | Size |',
    '|---|---|---|---|',
    ...r.pairsLower.map((c) => `| ${c.batch_key} | ${c.chunk} | ${c.types.length - 1} | ${kb(c.bytes)} |`),
    '',
    '## 3. Set 5 and the class values',
    '',
    `Each Stage B chunk carries set 5 and the class-value list one time. Together they are ${kb(r.set5Bytes)}.`,
    '',
    '| Kind | Count | Values |',
    '|---|---|---|',
    `| \`card_type\` | ${r.values.card_type.length} | ${r.values.card_type.join(', ')} |`,
    `| \`subtype\` | ${r.values.subtype.length} | See below. |`,
    `| \`mana_value\` | ${r.values.mana_value.length} | ${r.values.mana_value.join(', ')} |`,
    `| \`color_identity\` | ${r.values.color_identity.length} | ${r.values.color_identity.join(', ')} |`,
    '',
    `The subtype values come from the CR subtype parser (spec §11.2): ${r.values.subtype.join(', ')}.`,
    '',
    '## 4. Coverage gaps',
    '',
    r.gaps.length === 0
      ? 'No type is a coverage gap.'
      : `${r.gaps.length === 1 ? '1 type has' : `${r.gaps.length} types have`} no CR content from sets 1 to 3 (spec §5.2). Spec §3 counts 31 types with no CR citation in their evidence. For the other types of the 31, the term matcher (set 2) or the golden citations (set 3) give content. Each gap blocks the Stage A chunk that contains the type. A gap type also blocks its own Stage B batch if Stage A gives it the role \`demand\` or \`both\`. A \`CARES_ABOUT\` gap blocks a batch of the lower bound. The fix is golden cards that contain the type (Phase 2 golden-set procedure), not CR text by hand.`,
    '',
    ...(r.gaps.length ? [
      '| Family | Type key | Stage A chunk | Stage B |',
      '|---|---|---|---|',
      ...r.gaps.map((g) => `| ${g.family} | ${g.type_key} | ${roleOf.get(`${g.family}.${g.type_key}`) ?? '—'} | ${g.family === 'CARES_ABOUT' ? 'blocks its batch (lower bound)' : 'blocks its batch if it is a demand type'} |`),
      '',
    ] : []),
    '## 5. Run count',
    '',
    '| Bound | Stage A chunks | Stage B chunks | Runs |',
    '|---|---|---|---|',
    `| lower | ${r.roles.length} | ${r.pairsLower.length} | ${r.runs.lower} |`,
    `| spec | ${r.roles.length} | ${r.pairsSpec.length} | ${r.runs.spec} |`,
    `| full | ${r.roles.length} | ${r.pairsFull.length} | ${r.runs.full} |`,
    '',
    '## 6. Notes for the owner',
    '',
    '- The Stage B chunks fill the budget almost fully. The final instructions of Task 3 make each packet larger, so a batch can need one more chunk. Task 3 measures again with the final texts.',
    '- Each Stage B chunk has a fixed part: the kernel, the demand type and its CR content, set 5 and the class values. If the fixed part and one supply type are larger than the budget, the CLI stops with an error.',
    '- The packets contain pool card names only in the CR text and in the atom-type labels. Three labels are also pool card names: the keyword labels Flashback, Jump-Start and Manifest Dread. The Phase 2 packets show the same labels. The owner accepted these labels on 2026-10-10. The test for card names thus checks the instructions and the answer formats. A second test checks that each type entry has only text from `atom_types`.',
    '- A glossary reference to a title row (a rule with no text of its own, for example a keyword heading) shows the subrules of that title row. The owner decided this on 2026-10-10 (spec rev. 6 §5.2 item 2, amended).',
    '',
  ].join('\n');
}
