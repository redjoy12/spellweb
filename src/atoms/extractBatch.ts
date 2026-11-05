/**
 * Batch extraction by file protocol (plan Task 8, amended 2026-10-04; spec sec. 7.1 amendment).
 *
 * There is no provider layer. `prepareRun` writes one `packet.md` per batch of cards; a FRESH
 * Claude Code subagent per batch reads that file - its entire supplied context (spec sec. 2.1)
 * - and writes `response.json`; `submitBatch` runs sec. 6.3's gates on every card and persists
 * only what passes. Same shape as golden drafting (`goldenDraft.ts`): the code builds
 * materials and validates answers, and makes zero model calls itself.
 *
 * Why batches: cards share most of their rule text. Rendering the kernel once and each
 * card-specific section once per batch cuts a 25-card batch to ~26% of the per-card total
 * (measured on the 5,167-card pool). Gate 4 still checks each card against ITS OWN packet:
 * the batch union only decides whether a stray citation is `cross_card_citation` or `citation`.
 *
 * Layout: <batchesDir>/run-<id>/batch-<nnn>/{packet.md, manifest.json, response.json, submitted.json}
 *
 * Task 9 adds the verdict: a submitted first pass is finalised (verify.ts) and its findings
 * enqueued (queue.ts) in the same transaction, and `prepareEscalation` writes the extra
 * voting passes (sec. 7.2) as ordinary batches of the same run, one fresh subagent each.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PacketSection } from '../rules/packet.js';
import type { PacketPolicy } from '../rules/relevance.js';
import { packetPolicyShaWithKernel } from '../rules/kernel.js';
import { currentSchemaVersion } from './schema.js';
import { SPLITTER_VERSION, persistClauses } from './clauses.js';
import {
  finaliseCard, firstPassOf, loadEscalationConfig, reconcileErrata, reconcileSplitterVersion, shouldEscalate,
  type EscalationConfig,
} from './verify.js';
import { enqueueFindings } from './queue.js';
import {
  instructionsFor, buildCardRequest, recordFailedCard, redactionNames, renderAtomTypes, renderSection,
  parseResponseBody, persistValidated, validateResponse, type CardRequest,
} from './extract.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = resolve(here, '../../data/extract-batches');

/** Read on every call, so tests can point it at a temp directory and never touch `data/`. */
export function batchesDir(): string {
  return process.env['EXTRACT_BATCHES_DIR'] ?? DEFAULT_DIR;
}

export const DEFAULT_BATCH_SIZE = 25;
/** `extraction_runs.provider` for every run this module creates. */
export const EXTRACTOR_ID = 'claude-code-subagent';

/**
 * `colors` (a Task 12a colour slice) and `requeue` (named cards) are production extraction, like
 * `full`, so they drain the queue; golden and stratified batches are measurements and do not.
 */
export type BatchKind = 'golden' | 'stratified' | 'colors' | 'full' | 'requeue';

export interface ManifestCard {
  /** The only identifier the subagent sees. */
  key: string;
  oracle_id: string;
  oracle_hash: string;
  /** Gate 4's whitelist for this card (packetRuleNumbers of its own packet). */
  packet_rules: string[];
  packet_chars: number;
}

export interface BatchManifest {
  run_id: number;
  batch_index: number;
  schema_version: number;
  /** sha of the redaction list; validation must redact exactly as the packet did. */
  names_sha: string;
  /** Mark queue rows done on success - only batches that drain the production queue. */
  consume_queue: boolean;
  /** sec. 7.2: 0 is the card's first pass; 1.. are voting passes (absent = 0, pre-Task 9). */
  pass_index?: number;
  cards: ManifestCard[];
  /** Every rule number the packet showed for any card - the cross_card_citation test. */
  batch_rules: string[];
}

type Build = (db: DatabaseSync, oracleId: string, policy: PacketPolicy, names: readonly string[]) => CardRequest;

export interface PrepareOptions {
  batchKind: BatchKind;
  /** In batch order. Neighbouring cards that share rules make smaller packets. */
  oracleIds: string[];
  size: number;
  /** The subagent's model, recorded on the run. */
  model: string;
  policy: PacketPolicy;
  names?: readonly string[];
  /** Injectable for tests; the real builder needs a parsed corpus, kernel and term index. */
  build?: Build;
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const namesSha = (names: readonly string[]) => sha([...names].sort().join('\n'));
const cardKey = (i: number) => `C${String(i + 1).padStart(2, '0')}`;
export const runDir = (runId: number) => join(batchesDir(), `run-${runId}`);

const RESPONSE_FORMAT = `# How to answer

Write ONE file, response.json, containing only this JSON object - no commentary, no code fence:

{"cards": {"C01": {"atoms": [...], "unjustified_clauses": [...], "unclassified": [...]}, "C02": {...}, ...}}

- Include every card key listed under "Cards", even when all three arrays are empty.
- Each atom: {"face_index", "family", "type_key", "params", "source", "quote", "rule_numbers", "confidence"}.
- Each unjustified clause: {"face_index", "quote", "statement"}.
- Each unclassified clause: {"face_index", "quote", "proposed_label", "rationale"}.
- Quotes are copied from the card's own "Rules text", never from another card's.`;

/**
 * The batch packet: the subagent's whole world. Constant parts once, each distinct
 * card-specific section once (labelled with the cards it was supplied for), then the cards.
 */
export function renderBatchPacket(db: DatabaseSync, schemaVersion: number, reqs: readonly CardRequest[]): string {
  const keys = reqs.map((_, i) => cardKey(i));
  const kernel = reqs[0]?.kernelSections ?? [];
  const kernelIds = kernel.map((s) => s.number).join(',');
  for (const r of reqs) {
    if (r.kernelSections.map((s) => s.number).join(',') !== kernelIds) {
      throw new Error(`card ${r.oracleId} has a different kernel - one batch cannot mix corpora`);
    }
  }

  // Dedupe by rendered text, not number: two cards that share a number share the text.
  const shared = new Map<string, { section: PacketSection; keys: string[] }>();
  reqs.forEach((r, i) => {
    for (const s of r.cardSections) {
      const text = renderSection(s);
      const hit = shared.get(text) ?? { section: s, keys: [] };
      hit.keys.push(keys[i]!);
      shared.set(text, hit);
    }
  });
  const glossary = [...new Set(reqs.flatMap((r) => r.glossary))];

  const cards = reqs.map((r, i) => {
    const own = [...new Set(r.cardSections.map((s) => s.number))];
    return [
      `## ${keys[i]} (layout: ${r.layout})`,
      `This card may also cite: ${own.length ? own.join(', ') : '(nothing beyond the rules supplied for every card)'}`,
      ...r.faces,
    ].join('\n');
  });

  return [
    `# Extraction batch - ${reqs.length} card(s)`,
    instructionsFor(schemaVersion),
    RESPONSE_FORMAT,
    `# Atom types (schema version ${schemaVersion})\n` + renderAtomTypes(db, schemaVersion),
    '# Rules supplied for every card\n' + (kernel.map(renderSection).join('\n\n') || '(none)'),
    '# Rules supplied for specific cards\n' + ([...shared].map(([text, { keys: k }]) =>
      `${text}\n(supplied for: ${k.join(', ')})`).join('\n\n') || '(none)'),
    glossary.length ? '# Glossary\n' + glossary.join('\n') : null,
    '# Cards\n\n' + cards.join('\n\n'),
  ].filter((p) => p !== null).join('\n\n') + '\n';
}

/**
 * Creates the run and writes every batch's packet and manifest. Also writes each card's
 * clause split (sec. 7.3's coverage denominator) - the splitter is authoritative for coverage,
 * so it is fixed before any answer exists.
 */
export function prepareRun(db: DatabaseSync, opts: PrepareOptions): { runId: number; dir: string; batches: string[] } {
  if (opts.oracleIds.length === 0) throw new Error('no cards to prepare');
  if (!(opts.size >= 1)) throw new Error(`batch size must be at least 1, got ${opts.size}`);
  const corpus = db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as { id: number } | undefined;
  if (!corpus) throw new Error('no current rules corpus - run `npm run sync:rules` first');
  // sec. 10.3 and 5.2, "called at the start of every run": stale atoms leave the live set and
  // old splits are redone before this run reads either.
  reconcileErrata(db);
  reconcileSplitterVersion(db);
  const schemaVersion = currentSchemaVersion(db);

  const hashOf = db.prepare('SELECT oracle_hash FROM cards WHERE oracle_id = ?');
  const hashes = opts.oracleIds.map((id) => {
    const row = hashOf.get(id) as { oracle_hash: string } | undefined;
    if (!row) throw new Error(`no card with oracle_id ${id}`);
    return row.oracle_hash;
  });

  const runId = Number(db.prepare(
    `INSERT INTO extraction_runs (started_at, provider, model, schema_version, corpus_id, packet_policy_sha,
       splitter_version, batch_kind, status)
     VALUES (?,?,?,?,?,?,?,?,'in_progress')`,
  ).run(new Date().toISOString(), EXTRACTOR_ID, opts.model, schemaVersion, corpus.id,
    packetPolicyShaWithKernel(db, corpus.id, opts.policy), SPLITTER_VERSION, opts.batchKind).lastInsertRowid);

  opts.oracleIds.forEach((id, i) => persistClauses(db, id, hashes[i]!));

  const batches = writeBatches(db, {
    runId, schemaVersion, oracleIds: opts.oracleIds, hashes, size: opts.size, firstBatch: 0, passIndex: 0,
    consumeQueue: opts.batchKind === 'full' || opts.batchKind === 'colors' || opts.batchKind === 'requeue', policy: opts.policy, names: opts.names ?? redactionNames(db),
    build: opts.build ?? buildCardRequest,
  });
  return { runId, dir: runDir(runId), batches };
}

/** Writes `packet.md` + `manifest.json` for each slice of `oracleIds`, numbering from `firstBatch`. */
function writeBatches(db: DatabaseSync, o: {
  runId: number; schemaVersion: number; oracleIds: string[]; hashes: string[]; size: number;
  firstBatch: number; passIndex: number; consumeQueue: boolean; policy: PacketPolicy;
  names: readonly string[]; build: Build;
}): string[] {
  const batches: string[] = [];
  for (let start = 0, b = o.firstBatch; start < o.oracleIds.length; start += o.size, b++) {
    const ids = o.oracleIds.slice(start, start + o.size);
    const reqs = ids.map((id) => o.build(db, id, o.policy, o.names));
    const manifest: BatchManifest = {
      run_id: o.runId,
      batch_index: b,
      schema_version: o.schemaVersion,
      names_sha: namesSha(o.names),
      consume_queue: o.consumeQueue,
      pass_index: o.passIndex,
      cards: reqs.map((r, i) => ({
        key: cardKey(i), oracle_id: r.oracleId, oracle_hash: o.hashes[start + i]!,
        packet_rules: r.packetRules, packet_chars: r.packetChars,
      })),
      batch_rules: [...new Set(reqs.flatMap((r) => r.packetRules))].sort(),
    };
    const batchDir = join(runDir(o.runId), `batch-${String(b + 1).padStart(3, '0')}`);
    mkdirSync(batchDir, { recursive: true });
    writeFileSync(join(batchDir, 'packet.md'), renderBatchPacket(db, o.schemaVersion, reqs));
    writeFileSync(join(batchDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    batches.push(batchDir);
  }
  return batches;
}

function readManifest(batchDir: string): BatchManifest {
  return JSON.parse(readFileSync(join(batchDir, 'manifest.json'), 'utf8')) as BatchManifest;
}

/**
 * oracle_id -> the pass indexes this run has a SUBMITTED answer for (an answer with zero atoms
 * counts; a card its batch recorded as failed does not).
 */
function passesSubmitted(runId: number): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const b of runStatus(runId).batches) {
    if (b.state !== 'submitted') continue;
    const m = readManifest(b.dir);
    const done = JSON.parse(readFileSync(join(b.dir, 'submitted.json'), 'utf8')) as { failures?: Array<{ oracle_id: string }> };
    const failed = new Set((done.failures ?? []).map((f) => f.oracle_id));
    for (const c of m.cards) {
      if (failed.has(c.oracle_id)) continue;
      const set = out.get(c.oracle_id) ?? new Set<number>();
      set.add(m.pass_index ?? 0);
      out.set(c.oracle_id, set);
    }
  }
  return out;
}

/** oracle_id -> pass indexes an UNSUBMITTED batch of this run already asks for. */
function passesRequested(runId: number): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const b of runStatus(runId).batches) {
    if (b.state === 'submitted') continue;
    const m = readManifest(b.dir);
    for (const c of m.cards) {
      const set = out.get(c.oracle_id) ?? new Set<number>();
      set.add(m.pass_index ?? 0);
      out.set(c.oracle_id, set);
    }
  }
  return out;
}

export interface EscalationPlan { runId: number; cards: string[]; batches: string[] }

/**
 * sec. 7.2 for the subagent protocol. Every card of the run whose first pass `shouldEscalate`
 * picks gets the voting passes it lacks, written as new batches of the SAME run - one batch set
 * per missing pass index, so each pass is read by a fresh subagent that never sees another
 * pass's answer. Re-running it after a failed voting batch writes only what is still missing.
 * When a card's last pass is submitted, `submitBatch` reconciles its votes.
 *
 * `forceCards` (Phase 3 plan Task 8, the degree sweep): these cards get the voting passes also
 * when `shouldEscalate` does not pick them. A named card with no submitted first pass in this
 * run is skipped; `cards` in the plan shows which ones escalate.
 */
export function prepareEscalation(db: DatabaseSync, runId: number, opts: {
  policy: PacketPolicy; size?: number; names?: readonly string[]; build?: Build; config?: EscalationConfig;
  forceCards?: readonly string[];
}): EscalationPlan {
  const run = db.prepare('SELECT schema_version, provider FROM extraction_runs WHERE id = ?').get(runId) as
    { schema_version: number; provider: string } | undefined;
  if (!run) throw new Error(`no run ${runId}`);
  if (run.provider !== EXTRACTOR_ID) throw new Error(`run ${runId} was not made by batch extraction (${run.provider})`);
  if (run.schema_version !== currentSchemaVersion(db)) {
    throw new Error(`run ${runId} used schema v${run.schema_version}, the vocabulary is now newer - extract these cards in a new run`);
  }
  const cfg = opts.config ?? loadEscalationConfig();
  const submitted = passesSubmitted(runId);
  const requested = passesRequested(runId);
  const firstPassed = (db.prepare(
    "SELECT oracle_id FROM extraction_results WHERE run_id = ? AND outcome <> 'failed' ORDER BY rowid",
  ).all(runId) as Array<{ oracle_id: string }>).map((r) => r.oracle_id).filter((id) => submitted.get(id)?.has(0));
  const forced = new Set(opts.forceCards ?? []);
  const escalate = firstPassed.filter((id) => submitted.get(id)!.size < cfg.passes
    && (forced.has(id) || shouldEscalate(db, id, firstPassOf(db, runId, id), cfg)));

  const hashOf = db.prepare('SELECT oracle_hash FROM cards WHERE oracle_id = ?');
  const names = opts.names ?? redactionNames(db);
  let next = runStatus(runId).batches.length;
  const batches: string[] = [];
  for (let p = 1; p < cfg.passes; p++) {
    const ids = escalate.filter((id) => !submitted.get(id)!.has(p) && !requested.get(id)?.has(p));
    if (ids.length === 0) continue;
    const written = writeBatches(db, {
      runId, schemaVersion: run.schema_version, oracleIds: ids,
      hashes: ids.map((id) => (hashOf.get(id) as { oracle_hash: string }).oracle_hash),
      size: opts.size ?? DEFAULT_BATCH_SIZE, firstBatch: next, passIndex: p, consumeQueue: false,
      policy: opts.policy, names, build: opts.build ?? buildCardRequest,
    });
    next += written.length;
    batches.push(...written);
  }
  if (batches.length > 0) {
    db.prepare("UPDATE extraction_runs SET status = 'in_progress', finished_at = NULL WHERE id = ?").run(runId);
  }
  return { runId, cards: escalate, batches };
}

/**
 * Finalises every first-pass card of a run, and enqueues its findings. For runs submitted
 * before Task 9 existed - nothing wrote a verdict for a card that passed - and safe to repeat:
 * both steps recompute from the run's rows. New runs are finalised batch by batch on submit.
 */
export function finaliseRun(db: DatabaseSync, runId: number): Record<'passed' | 'flagged' | 'failed' | 'findings', number> {
  const counts = { passed: 0, flagged: 0, failed: 0, findings: 0 };
  const passes = passesSubmitted(runId);
  const chars = new Map<string, number>();
  for (const b of runStatus(runId).batches) {
    if (b.state !== 'submitted') continue;
    const m = readManifest(b.dir);
    if ((m.pass_index ?? 0) === 0) for (const c of m.cards) chars.set(c.oracle_id, c.packet_chars);
  }
  db.exec('BEGIN');
  try {
    for (const [id, packetChars] of chars) {
      counts[finaliseCard(db, runId, id, { packetChars, passesRun: passes.get(id)?.size ?? 1 })]++;
      counts.findings += enqueueFindings(db, runId, id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return counts;
}

export interface SubmitSummary {
  batch: string;
  extracted: number;
  failed: number;
  atoms: number;
  ambiguous: number;
  missingRules: number;
  unclassified: number;
  /** Rejection count per reason prefix (`citation`, `cross_card_citation`, `quote`, ...). */
  rejectedBy: Record<string, number>;
  rejections: Array<{ key: string; reason: string }>;
  failures: Array<{ key: string; oracle_id: string; reason: string }>;
  /** 0 for a first pass, 1.. for a voting pass. */
  passIndex: number;
  /** Verdicts written by this submission; a voted card counts once its last pass lands. */
  outcomes: { passed: number; flagged: number };
  /** Review-queue rows added. */
  findings: number;
  /** Cards whose votes this submission reconciled. */
  voted: number;
  runComplete: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validates and persists one batch's response, in one transaction. A card that cannot be
 * validated at all is recorded `failed` and left pending; the rest of the batch still lands.
 * Refuses a second submission, so atoms are never duplicated.
 */
export function submitBatch(
  db: DatabaseSync,
  batchDir: string,
  opts: { names?: readonly string[] } = {},
): SubmitSummary {
  const done = join(batchDir, 'submitted.json');
  if (existsSync(done)) throw new Error(`${basename(batchDir)} is already submitted`);
  const manifestPath = join(batchDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`${batchDir} has no manifest.json - not a prepared batch`);
  const responsePath = join(batchDir, 'response.json');
  if (!existsSync(responsePath)) throw new Error(`${basename(batchDir)} has no response.json yet`);

  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as BatchManifest;
  const names = opts.names ?? redactionNames(db);
  if (namesSha(names) !== m.names_sha) {
    throw new Error('the redaction list changed since this packet was written - quotes would not resolve; prepare it again');
  }

  const raw = readFileSync(responsePath, 'utf8');
  let cards: Record<string, unknown> | null = null;
  let fatal = '';
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isObj(parsed) && isObj(parsed['cards'])) cards = parsed['cards'];
    else fatal = 'response has no "cards" object';
  } catch (err) {
    fatal = `response is not valid JSON: ${(err as Error).message}`;
  }

  const pass = m.pass_index ?? 0;
  const s: SubmitSummary = {
    batch: basename(batchDir), extracted: 0, failed: 0, atoms: 0, ambiguous: 0, missingRules: 0,
    unclassified: 0, rejectedBy: {}, rejections: [], failures: [], passIndex: pass,
    outcomes: { passed: 0, flagged: 0 }, findings: 0, voted: 0, runComplete: false,
  };
  const currentHash = db.prepare('SELECT oracle_hash FROM cards WHERE oracle_id = ?');
  const queueDone = db.prepare("UPDATE extraction_queue SET status = 'done' WHERE oracle_id = ? AND status = 'pending'");
  const votePasses = pass > 0 ? loadEscalationConfig().passes : 0;
  const submittedBefore = pass > 0 ? passesSubmitted(m.run_id) : new Map<string, Set<number>>();

  db.exec('BEGIN');
  try {
    for (const c of m.cards) {
      const fail = (reason: string, detail = reason) => {
        // A failed VOTING pass leaves the first pass's verdict alone: the card just lacks that
        // pass, and the next `--escalate` writes it again.
        if (pass === 0) recordFailedCard(db, m.run_id, c.oracle_id, c.packet_chars, `${c.key}: ${detail}`);
        s.failed++;
        s.failures.push({ key: c.key, oracle_id: c.oracle_id, reason });
      };
      if (!cards) { fail(fatal, `${fatal}\n--- raw response (first 3000 chars) ---\n${raw.slice(0, 3000)}`); continue; }
      const now = currentHash.get(c.oracle_id) as { oracle_hash: string } | undefined;
      if (now?.oracle_hash !== c.oracle_hash) { fail('oracle text changed since the packet was written'); continue; }
      if (!(c.key in cards)) { fail(`${c.key} is missing from the response`); continue; }
      const body = parseResponseBody(cards[c.key]);
      if (!body.ok) { fail(body.error, `${body.error}\n--- answer ---\n${JSON.stringify(cards[c.key]).slice(0, 3000)}`); continue; }

      const r = validateResponse(db, c.oracle_id, {
        runId: m.run_id, passIndex: pass, packetRules: c.packet_rules, batchRules: m.batch_rules, names,
      }, body.value);
      persistValidated(db, r);
      if (m.consume_queue) queueDone.run(c.oracle_id);
      // The verdict: now for a first pass; for a voted card once its last pass is in.
      const have = pass === 0 ? 1 : new Set([...(submittedBefore.get(c.oracle_id) ?? []), pass]).size;
      if (pass === 0 || have >= votePasses) {
        const outcome = finaliseCard(db, m.run_id, c.oracle_id,
          pass === 0 ? { packetChars: c.packet_chars } : { passesRun: have });
        if (outcome !== 'failed') s.outcomes[outcome]++;
        s.findings += enqueueFindings(db, m.run_id, c.oracle_id);
        if (pass > 0) s.voted++;
      }
      s.extracted++;
      s.atoms += r.atoms.length;
      s.ambiguous += r.atoms.filter((a) => a.span_ambiguous).length;
      s.missingRules += r.missingRules.length;
      s.unclassified += r.unclassified.length;
      for (const x of r.rejected) {
        const k = x.reason.split(':')[0]!;
        s.rejectedBy[k] = (s.rejectedBy[k] ?? 0) + 1;
        s.rejections.push({ key: c.key, reason: x.reason });
      }
    }
    if (pass === 0) {
      db.prepare('UPDATE extraction_runs SET cards_attempted = cards_attempted + ? WHERE id = ?')
        .run(m.cards.length, m.run_id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  writeFileSync(done, JSON.stringify({ submitted_at: new Date().toISOString(), ...s }, null, 2) + '\n');
  s.runComplete = runStatus(m.run_id).batches.every((b) => b.state === 'submitted');
  if (s.runComplete) {
    db.prepare("UPDATE extraction_runs SET status = 'complete', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), m.run_id);
  }
  return s;
}

export interface BatchState {
  dir: string;
  cards: number;
  state: 'prepared' | 'responded' | 'submitted';
}

/** Every batch of a run and how far it got, in batch order. */
export function runStatus(runId: number): { runId: number; dir: string; batches: BatchState[] } {
  const dir = runDir(runId);
  if (!existsSync(dir)) throw new Error(`no batches for run ${runId} under ${batchesDir()}`);
  const batches = readdirSync(dir).filter((d) => d.startsWith('batch-')).sort().map((d) => {
    const b = join(dir, d);
    const m = JSON.parse(readFileSync(join(b, 'manifest.json'), 'utf8')) as BatchManifest;
    const state: BatchState['state'] = existsSync(join(b, 'submitted.json')) ? 'submitted'
      : existsSync(join(b, 'response.json')) ? 'responded' : 'prepared';
    return { dir: b, cards: m.cards.length, state };
  });
  return { runId, dir, batches };
}

/**
 * What every card of a run was actually shown: oracle_id -> its manifest's `packet_rules`
 * (gate 4's whitelist when the packet was written). Scoring checks citations against this,
 * not a fresh assembly - the kernel or policy may have changed since. A card prepared twice
 * in one run keeps its last batch's whitelist.
 */
export function runPacketRules(runId: number): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const b of runStatus(runId).batches) {
    const m = JSON.parse(readFileSync(join(b.dir, 'manifest.json'), 'utf8')) as BatchManifest;
    for (const c of m.cards) out.set(c.oracle_id, new Set(c.packet_rules));
  }
  return out;
}
