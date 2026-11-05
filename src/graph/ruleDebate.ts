/**
 * The debate of disputed edge items (Phase 3 spec rev. 9 sec. 5.6, owner instruction 2026-10-11).
 *
 * Until the first demo the owner reviews nothing. Three fresh `edge-rule-debater` subagents
 * debate each pending role item (Stage A) or disputed rule (Stage B) of a set, over rounds:
 * - a debater SELECTS one option of an item: the proposal of one pass, the voted role, `none`,
 *   or `adopt` / `reject` for a rule. It never writes a role or a rule, so each verdict is
 *   content that a pass gave and that the submit verified (sec. 5.4);
 * - an item is agreed when all three debaters of one round select the same option, each with
 *   valid quotes from the packet; the CLI applies the verdict with the decision functions of
 *   `ruleSet.ts`, recorded as `decided_by = 'debate'`;
 * - from round 2 the packet shows the arguments of the round before; after MAX_ROUNDS an item
 *   that is not agreed keeps the default of sec. 5.3 and stays pending for the owner.
 *
 * The debate packet keeps the type entries and the CR text of the source batch packet without
 * change, so the packet references of sec. 5.4 check 5 are the batch references.
 * The code makes no model call and knows no Magic.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { checkEvidence, type Evidence } from './quotes.js';
import { DEBATE_ANSWER_FORMAT, DEBATE_INSTRUCTIONS, ROLE_OPTIONS, RULE_OPTIONS } from './debateText.js';
import { packetContext, renderBatchTypes } from './edgePackets.js';
import { stageBTypes } from './liveTypes.js';
import { checkTwoPart, debaterAgent, isTwoPart, twoPartSha, writeAgentFiles, type GeneratedAgent, type TwoPartManifest } from './pairFixed.js';
import { passDir, ruleBatchesDir, type Stage } from './ruleBatches.js';
import { EvidenceZ, type ResourceEffect, type Role, type RoleItem } from './ruleSchema.js';
import {
  decideRole, decideRule, getRuleSet, keepRoleNone, keepVotedRole, roleProposals, RuleSetError, type DecidedBy,
} from './ruleSet.js';

export const DEBATERS = 3;
/** A provisional limit (sec. 5.6). */
export const MAX_ROUNDS = 3;

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

export const debateDir = (setId: number, stage: Stage, batchKey: string, round: number, debater: number) =>
  join(ruleBatchesDir(), `set-${setId}`, 'debate', stage, batchKey, `round-${round}`, `debater-${debater}`);

export { DEBATE_ANSWER_FORMAT, DEBATE_INSTRUCTIONS, ROLE_OPTIONS, RULE_OPTIONS };

export const DebateResponse = z.object({
  answers: z.array(z.object({
    item: z.string().min(1),
    choice: z.string().min(1),
    argument: z.string().min(1),
    evidence: z.array(EvidenceZ),
  }).strict()),
}).strict();

/** One debate item and the options that a debater can select. */
export interface DebateItem {
  key: string;
  batch_key: string;
  options: string[];
  /** The text of each option in the packet. */
  shown: Record<string, string>;
  title: string;
}

interface DebateBatchRow { batch_key: string; round: number; items_json: string; packet_sha: string }
interface StoredItem { key: string; options: string[] }

// ---- items --------------------------------------------------------------------------------------

const effectKey = (e: Pick<ResourceEffect, 'resource' | 'sign' | 'kind'>) => `${e.resource}|${e.sign}|${e.kind}`;
const sameContent = (a: { role: Role; resources: ResourceEffect[] }, b: { role: Role; resources: ResourceEffect[] }) =>
  a.role === b.role && JSON.stringify(a.resources.map(effectKey).sort()) === JSON.stringify(b.resources.map(effectKey).sort());
const show = (v: unknown) => JSON.stringify(v);

/** The pending items of a stage that have no outcome yet, each with the batch whose packet it uses. */
export function debateItems(db: DatabaseSync, setId: number, stage: Stage): DebateItem[] {
  const decided = new Set((db.prepare('SELECT item_key FROM edge_debate_outcomes WHERE set_id = ? AND stage = ?').all(setId, stage) as
    Array<{ item_key: string }>).map((r) => r.item_key));
  return stage === 'roles' ? roleItems(db, setId).filter((i) => !decided.has(i.key)) : ruleItems(db, setId).filter((i) => !decided.has(i.key));
}

function roleItems(db: DatabaseSync, setId: number): DebateItem[] {
  const rows = db.prepare(
    `SELECT t.family, t.type_key, t.role, t.demand_note, t.resources_json, t.evidence_json, t.status
       FROM review_queue q JOIN edge_type_roles t ON t.rowid = q.detail_id
      WHERE q.domain = 'edge' AND q.rule_set_id = ? AND q.severity = 'edge_role_disagreement'
        AND q.detail_table = 'edge_type_roles' AND q.status = 'pending'
      ORDER BY t.family, t.type_key`,
  ).all(setId) as Array<{ family: string; type_key: string; role: Role; demand_note: string | null; resources_json: string; evidence_json: string; status: string }>;
  const batches = (db.prepare("SELECT batch_key, types_json FROM edge_rule_batches WHERE set_id = ? AND stage = 'roles' ORDER BY batch_key").all(setId) as
    Array<{ batch_key: string; types_json: string }>).map((b) => ({ key: b.batch_key, types: new Set(JSON.parse(b.types_json) as string[]) }));
  const out: DebateItem[] = [];
  for (const r of rows) {
    const key = `${r.family}.${r.type_key}`;
    const batch = batches.find((b) => b.types.has(key));
    if (!batch) continue;
    const voted = { role: r.role, resources: JSON.parse(r.resources_json) as ResourceEffect[] };
    const options: string[] = [];
    const shown: Record<string, string> = {};
    for (const p of roleProposals(db, setId, r.family, r.type_key)) {
      // A pass that agrees with the voted role and effects is the option `voted`.
      if (r.status === 'accepted' && sameContent(p.item, voted)) continue;
      const { family: _f, type_key: _k, ...rest } = p.item as RoleItem;
      options.push(`P${p.pass_index}`);
      shown[`P${p.pass_index}`] = show(rest);
    }
    if (r.status === 'accepted') {
      options.push('voted');
      shown['voted'] = show({ role: r.role, demand_note: r.demand_note ?? undefined, resources: voted.resources, evidence: JSON.parse(r.evidence_json) as Evidence[] });
    }
    const hasNone = options.some((o) => (o === 'voted' ? voted.role === 'none' && voted.resources.length === 0
      : JSON.parse(shown[o]!).role === 'none' && (JSON.parse(shown[o]!).resources as unknown[]).length === 0));
    if (!hasNone) { options.push('none'); shown['none'] = 'the role none, with no resource effects'; }
    if (options.length < 2) continue;                        // nothing to select between
    out.push({ key, batch_key: batch.key, options, shown, title: `${r.family} ${r.type_key}` });
  }
  return out;
}

function ruleItems(db: DatabaseSync, setId: number): DebateItem[] {
  const rows = db.prepare(
    `SELECT r.rule_hash, r.polarity, r.supply_json, r.demand_json, r.param_links, r.implications, r.evidence_json
       FROM review_queue q JOIN edge_rules r ON r.rowid = q.detail_id
      WHERE q.domain = 'edge' AND q.rule_set_id = ? AND q.severity = 'edge_rule_disagreement'
        AND q.detail_table = 'edge_rules' AND q.status = 'pending' AND r.status = 'disputed'
      ORDER BY r.rule_hash`,
  ).all(setId) as Array<Record<string, string>>;
  const batchOf = db.prepare("SELECT MIN(batch_key) b FROM edge_rule_pass_items WHERE set_id = ? AND stage = 'pairs' AND item_key = ?");
  // spec rev. 10 sec. 5.3: a rule with a deferred type waits; it joins a round when a card has the type.
  const set = getRuleSet(db, setId)!;
  const { deferred } = stageBTypes(db, setId, packetContext(db, { corpusId: set.corpus_id, schemaVersion: set.schema_version }));
  const late = new Set(deferred);
  const sideId = (s: { family?: string; type_key?: string }) => (s.family ? `${s.family}.${s.type_key}` : null);
  const out: DebateItem[] = [];
  for (const r of rows) {
    const sides = [sideId(JSON.parse(r['supply_json']!)), sideId(JSON.parse(r['demand_json']!))];
    if (sides.some((t) => t !== null && late.has(t))) continue;
    const b = (batchOf.get(setId, r['rule_hash']!) as { b: string | null }).b;
    if (!b) continue;
    const rule = {
      polarity: r['polarity'], supply: JSON.parse(r['supply_json']!), demand: JSON.parse(r['demand_json']!),
      param_links: JSON.parse(r['param_links']!), implications: JSON.parse(r['implications']!), evidence: JSON.parse(r['evidence_json']!),
    };
    out.push({
      key: r['rule_hash']!, batch_key: b, options: ['adopt', 'reject'],
      shown: { rule: show(rule) }, title: 'edge rule',
    });
  }
  return out;
}

// ---- packets ------------------------------------------------------------------------------------

/** The instructions and the body (types, resources or class kinds, CR text) of a source packet. */
export function splitSourcePacket(markdown: string): { instructions: string; body: string } {
  const start = ['\n\n# Atom types\n', '\n\n# Demand type\n'].map((h) => markdown.indexOf(h)).find((i) => i >= 0);
  const end = markdown.lastIndexOf('\n\n# Answer format\n');
  const instr = markdown.indexOf('# Instructions\n');
  if (start === undefined || end < 0 || instr < 0 || !(instr < start && start < end)) throw new Error('the source packet has not the parts of sec. 5.2');
  return { instructions: markdown.slice(instr + '# Instructions\n'.length, start).trim(), body: markdown.slice(start + 2, end) };
}

function renderItems(stage: Stage, items: DebateItem[]): string {
  return items.map((it, n) => {
    const label = `D${String(n + 1).padStart(2, '0')}`;
    const lines = [`## ${label} - ${it.title}`];
    if (stage === 'pairs') lines.push(`Rule: ${it.shown['rule']}`);
    lines.push(`Options: ${it.options.join(', ')}`);
    if (stage === 'roles') for (const o of it.options) lines.push(`- ${o}: ${it.shown[o]}`);
    return lines.join('\n');
  }).join('\n\n');
}

function renderArguments(db: DatabaseSync, setId: number, stage: Stage, round: number, items: DebateItem[]): string | null {
  if (round === 1) return null;
  const get = db.prepare(
    `SELECT debater, choice, argument, evidence_json FROM edge_debate_answers
      WHERE set_id = ? AND stage = ? AND round = ? AND item_key = ? AND fault IS NULL ORDER BY debater`,
  );
  const parts = items.map((it, n) => {
    const rows = get.all(setId, stage, round - 1, it.key) as Array<{ debater: number; choice: string; argument: string; evidence_json: string }>;
    const label = `D${String(n + 1).padStart(2, '0')}`;
    if (rows.length === 0) return `## ${label}\nNo valid argument.`;
    return [`## ${label}`, ...rows.map((r) =>
      `- Debater ${String.fromCharCode(64 + r.debater)}: choice ${r.choice}. Argument: ${r.argument} Evidence: ${r.evidence_json}`)].join('\n');
  });
  return `# Arguments of the previous round\n${parts.join('\n\n')}`;
}

/** The first line of each two-part debate batch part (spec rev. 10 sec. 5.2). */
export const DEBATE_BATCH_PART_TITLE = '# Edge-rule debate packet, batch part';

/**
 * Stage B, two parts: the instructions, the earlier-pass instructions and the CR text of all types
 * are the fixed part of the debater agent. The batch part has the type entries of the source
 * batch (single-part or two-part), the items and the arguments.
 */
function buildPairBatchPart(db: DatabaseSync, setId: number, batchKey: string, round: number, items: DebateItem[]): string {
  const set = getRuleSet(db, setId)!;
  const row = db.prepare("SELECT demand, types_json FROM edge_rule_batches WHERE set_id = ? AND stage = 'pairs' AND batch_key = ?")
    .get(setId, batchKey) as { demand: string; types_json: string } | undefined;
  if (!row) throw new Error(`no Stage B batch ${batchKey} in set ${setId}`);
  return [
    `${DEBATE_BATCH_PART_TITLE} - Stage B (pairs) - ${batchKey}, round ${round}`,
    renderBatchTypes(db, set.schema_version, row.demand, (JSON.parse(row.types_json) as string[]).slice(1)),
    `# Disputed items\n${RULE_OPTIONS}\n\n${renderItems('pairs', items)}`,
    renderArguments(db, setId, 'pairs', round, items),
  ].filter((p) => p !== null).join('\n\n') + '\n';
}

function buildPacket(db: DatabaseSync, setId: number, stage: Stage, batchKey: string, round: number, items: DebateItem[]): string {
  const src = join(passDir(setId, stage, batchKey, 1), 'packet.md');
  if (!existsSync(src)) throw new Error(`the source packet ${src} is missing`);
  const markdown = readFileSync(src, 'utf8');
  const want = (db.prepare('SELECT packet_sha FROM edge_rule_batches WHERE set_id = ? AND stage = ? AND batch_key = ?')
    .get(setId, stage, batchKey) as { packet_sha: string } | undefined)?.packet_sha;
  if (sha(markdown) !== want) throw new Error(`the source packet ${src} is not the packet of batch ${batchKey}`);
  const { instructions, body } = splitSourcePacket(markdown);
  const args = renderArguments(db, setId, stage, round, items);
  return [
    `# Edge-rule debate packet - ${stage === 'roles' ? 'Stage A (roles and resources)' : 'Stage B (pairs)'} - ${batchKey}, round ${round}`,
    `# Instructions\n${DEBATE_INSTRUCTIONS}`,
    `# Instructions of the earlier passes\n${instructions}`,
    body,
    `# Disputed items\n${stage === 'roles' ? ROLE_OPTIONS : RULE_OPTIONS}\n\n${renderItems(stage, items)}`,
    args,
    `# Answer format\n${DEBATE_ANSWER_FORMAT}`,
  ].filter((p) => p !== null).join('\n\n') + '\n';
}

// ---- prepare ------------------------------------------------------------------------------------

/** The last round of each item of a stage that was submitted. */
function lastRounds(db: DatabaseSync, setId: number, stage: Stage): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of db.prepare('SELECT round, items_json FROM edge_debate_batches WHERE set_id = ? AND stage = ? AND submitted_at IS NOT NULL')
    .all(setId, stage) as Array<{ round: number; items_json: string }>) {
    for (const it of JSON.parse(b.items_json) as StoredItem[]) out.set(it.key, Math.max(out.get(it.key) ?? 0, b.round));
  }
  return out;
}

/**
 * The next round of each batch with items that are not agreed: DEBATERS directories, each with
 * the same packet. A round that is open (not submitted) blocks a new prepare.
 */
export function prepareDebate(
  db: DatabaseSync, setId: number, stage: Stage,
): { dirs: string[]; batches: number; items: number; agent: string | null; agentsWritten: string[] } {
  const set = getRuleSet(db, setId);
  if (!set) throw new Error(`no edge-rule set ${setId}`);
  if (set.status !== 'in_progress') throw new Error(`set ${setId} is ${set.status}, not in_progress`);
  const open = db.prepare('SELECT batch_key, round FROM edge_debate_batches WHERE set_id = ? AND stage = ? AND submitted_at IS NULL')
    .all(setId, stage) as Array<{ batch_key: string; round: number }>;
  if (open.length) throw new Error(`a debate round is open: ${open.map((o) => `${o.batch_key} round ${o.round}`).join(', ')}. Submit it first`);
  const last = lastRounds(db, setId, stage);
  const groups = new Map<string, { batch: string; round: number; items: DebateItem[] }>();
  for (const it of debateItems(db, setId, stage)) {
    const round = (last.get(it.key) ?? 0) + 1;
    if (round > MAX_ROUNDS) continue;
    const g = `${it.batch_key}|${round}`;
    if (!groups.has(g)) groups.set(g, { batch: it.batch_key, round, items: [] });
    groups.get(g)!.items.push(it);
  }
  const dirs: string[] = [];
  let count = 0;
  // Stage B debates use two-part packets: the debater agent carries the fixed part.
  const agent = stage === 'pairs' && groups.size ? debaterAgent(db, setId) : undefined;
  const agentsWritten = agent ? writeAgentFiles([agent]) : [];
  db.exec('BEGIN');
  try {
    for (const g of groups.values()) {
      const packet = agent ? buildPairBatchPart(db, setId, g.batch, g.round, g.items) : buildPacket(db, setId, stage, g.batch, g.round, g.items);
      const packetSha = agent ? twoPartSha(agent.sha, packet) : sha(packet);
      const two = agent ? { agent: agent.name, agent_sha: agent.sha } : {};
      const stored: StoredItem[] = g.items.map((i) => ({ key: i.key, options: i.options }));
      for (let k = 1; k <= DEBATERS; k++) {
        const dir = debateDir(setId, stage, g.batch, g.round, k);
        mkdirSync(dir, { recursive: true });
        rmSync(join(dir, 'response.json'), { force: true });
        writeFileSync(join(dir, 'packet.md'), packet);
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ set_id: setId, stage, batch_key: g.batch, round: g.round, debater: k, items: stored, packet_sha: packetSha, ...two }, null, 2) + '\n');
        dirs.push(dir);
      }
      db.prepare(
        `INSERT INTO edge_debate_batches (set_id, stage, batch_key, round, items_json, packet_sha, packet_bytes, prepared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(setId, stage, g.batch, g.round, JSON.stringify(stored), packetSha, Buffer.byteLength(packet, 'utf8'), new Date().toISOString());
      count += g.items.length;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { dirs, batches: groups.size, items: count, agent: agent?.name ?? null, agentsWritten };
}

// ---- submit -------------------------------------------------------------------------------------

export interface DebateSubmitResult {
  batches: number;
  waiting: string[];
  unreadable: string[];
  /** Answers for an unknown item label or a second answer for one item: not stored. */
  ignored: number;
  faults: Record<string, number>;
  agreed: number;
  not_applied: string[];
  /** Earlier `not_applied` verdicts that apply now (for example after a guard changed). */
  reapplied: number;
  no_agreement: number;
  /** Items that go to the next round. */
  next_round: number;
}

/**
 * Stores the answers of each open round whose DEBATERS responses are present, then gives each
 * item its outcome: agreed (the verdict applies), no_agreement after MAX_ROUNDS, or nothing
 * (the next prepare takes it to the next round).
 */
export function submitDebate(db: DatabaseSync, setId: number, stage: Stage): DebateSubmitResult {
  const set = getRuleSet(db, setId);
  if (!set) throw new Error(`no edge-rule set ${setId}`);
  if (set.status !== 'in_progress') throw new Error(`set ${setId} is ${set.status}, not in_progress`);
  const out: DebateSubmitResult = { batches: 0, waiting: [], unreadable: [], ignored: 0, faults: {}, agreed: 0, not_applied: [], reapplied: 0, no_agreement: 0, next_round: 0 };
  retryNotApplied(db, setId, stage, out);
  const open = db.prepare('SELECT batch_key, round, items_json, packet_sha FROM edge_debate_batches WHERE set_id = ? AND stage = ? AND submitted_at IS NULL ORDER BY batch_key, round')
    .all(setId, stage) as unknown as DebateBatchRow[];
  // A single-part debate packet shows the CR text of its source batch; a two-part one (spec
  // rev. 10 sec. 5.2) shows the fixed part of the debater agent, which the prepare recorded.
  let debater: GeneratedAgent | undefined;
  const debateRefs = (b: DebateBatchRow): string[] => {
    const dirs = Array.from({ length: DEBATERS }, (_, k) => debateDir(setId, stage, b.batch_key, b.round, k + 1));
    if (!isTwoPart(dirs[0]!, DEBATE_BATCH_PART_TITLE)) {
      return JSON.parse((db.prepare('SELECT refs_json FROM edge_rule_batches WHERE set_id = ? AND stage = ? AND batch_key = ?')
        .get(setId, stage, b.batch_key) as { refs_json: string }).refs_json) as string[];
    }
    for (const d of dirs) checkTwoPart(d, b.packet_sha);
    debater ??= debaterAgent(db, setId);
    const m = JSON.parse(readFileSync(join(dirs[0]!, 'manifest.json'), 'utf8')) as TwoPartManifest;
    if (m.agent_sha !== debater.sha) throw new Error(`debate ${b.batch_key} round ${b.round}: the debater agent of the prepare is not the agent of set ${setId} now`);
    return debater.refs;
  };
  const ins = db.prepare(
    `INSERT OR REPLACE INTO edge_debate_answers (set_id, stage, batch_key, round, debater, item_key, choice, argument, evidence_json, fault)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const done: DebateBatchRow[] = [];
  for (const b of open) {
    const files = Array.from({ length: DEBATERS }, (_, k) => join(debateDir(setId, stage, b.batch_key, b.round, k + 1), 'response.json'));
    if (files.some((f) => !existsSync(f))) { out.waiting.push(`${b.batch_key} round ${b.round}`); continue; }
    const parsed: Array<z.infer<typeof DebateResponse>> = [];
    let bad = false;
    for (const f of files) {
      try {
        const r = DebateResponse.safeParse(JSON.parse(readFileSync(f, 'utf8')));
        if (!r.success) throw new Error(r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; '));
        parsed.push(r.data);
      } catch (err) { out.unreadable.push(`${f} (${(err as Error).message})`); bad = true; }
    }
    if (bad) continue;
    const refs = new Set(debateRefs(b));
    const items = JSON.parse(b.items_json) as StoredItem[];
    db.exec('BEGIN');
    try {
      parsed.forEach((p, k) => {
        const seen = new Set<string>();
        for (const a of p.answers) {
          const n = /^D(\d+)$/.exec(a.item)?.[1];
          const item = n === undefined ? undefined : items[Number(n) - 1];
          if (!item || seen.has(item.key)) { out.ignored++; continue; }
          seen.add(item.key);
          const fault = !item.options.includes(a.choice) ? 'unknown_option'
            : a.evidence.length === 0 ? 'no_evidence'
              : a.evidence.map((e) => checkEvidence(db, set.corpus_id, e, refs)).find((f) => f !== null) ?? null;
          if (fault) out.faults[fault] = (out.faults[fault] ?? 0) + 1;
          ins.run(setId, stage, b.batch_key, b.round, k + 1, item.key, a.choice, a.argument.trim(), JSON.stringify(a.evidence), fault);
        }
      });
      db.prepare('UPDATE edge_debate_batches SET submitted_at = ? WHERE set_id = ? AND stage = ? AND batch_key = ? AND round = ?')
        .run(new Date().toISOString(), setId, stage, b.batch_key, b.round);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    out.batches++;
    done.push(b);
  }
  for (const b of done) {
    for (const it of JSON.parse(b.items_json) as StoredItem[]) settle(db, setId, stage, b, it, out);
  }
  return out;
}

/** Each earlier `not_applied` verdict is tried again; one that applies becomes `agreed`. */
function retryNotApplied(db: DatabaseSync, setId: number, stage: Stage, out: DebateSubmitResult): void {
  const rows = db.prepare("SELECT item_key, choice, round FROM edge_debate_outcomes WHERE set_id = ? AND stage = ? AND outcome = 'not_applied' ORDER BY item_key")
    .all(setId, stage) as Array<{ item_key: string; choice: string; round: number }>;
  const arg = db.prepare('SELECT argument FROM edge_debate_answers WHERE set_id = ? AND stage = ? AND round = ? AND item_key = ? AND fault IS NULL ORDER BY debater LIMIT 1');
  const upd = db.prepare("UPDATE edge_debate_outcomes SET outcome = ?, cause = ?, decided_at = ? WHERE set_id = ? AND stage = ? AND item_key = ?");
  for (const r of rows) {
    const a = (arg.get(setId, stage, r.round, r.item_key) as { argument: string } | undefined)?.argument ?? '';
    const note = `debate round ${r.round}: ${DEBATERS} of ${DEBATERS} debaters selected ${r.choice}. ${a}`.slice(0, 2000);
    try {
      applyVerdict(db, setId, stage, r.item_key, r.choice, note, { by: 'debate', round: r.round });
      upd.run('agreed', null, new Date().toISOString(), setId, stage, r.item_key);
      out.reapplied++;
    } catch (err) {
      if (!(err instanceof RuleSetError)) throw err;
      upd.run('not_applied', err.message, new Date().toISOString(), setId, stage, r.item_key);
    }
  }
}

/** The outcome of one item after its round is stored. */
function settle(db: DatabaseSync, setId: number, stage: Stage, b: DebateBatchRow, it: StoredItem, out: DebateSubmitResult): void {
  const rows = db.prepare(
    `SELECT debater, choice, argument FROM edge_debate_answers
      WHERE set_id = ? AND stage = ? AND batch_key = ? AND round = ? AND item_key = ? AND fault IS NULL ORDER BY debater`,
  ).all(setId, stage, b.batch_key, b.round, it.key) as Array<{ debater: number; choice: string; argument: string }>;
  const choices = new Set(rows.map((r) => r.choice));
  const agreed = rows.length === DEBATERS && choices.size === 1 ? rows[0]!.choice : null;
  const record = db.prepare(
    `INSERT OR REPLACE INTO edge_debate_outcomes (set_id, stage, item_key, outcome, choice, round, cause, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  if (agreed === null) {
    if (b.round >= MAX_ROUNDS) { record.run(setId, stage, it.key, 'no_agreement', null, b.round, null, now); out.no_agreement++; } else out.next_round++;
    return;
  }
  const note = `debate round ${b.round}: ${DEBATERS} of ${DEBATERS} debaters selected ${agreed}. ${rows[0]!.argument}`.slice(0, 2000);
  try {
    applyVerdict(db, setId, stage, it.key, agreed, note, { by: 'debate', round: b.round });
    record.run(setId, stage, it.key, 'agreed', agreed, b.round, null, now);
    out.agreed++;
  } catch (err) {
    if (!(err instanceof RuleSetError)) throw err;
    record.run(setId, stage, it.key, 'not_applied', agreed, b.round, err.message, now);
    out.not_applied.push(`${it.key} (${agreed}): ${err.message}`);
  }
}

function applyVerdict(db: DatabaseSync, setId: number, stage: Stage, key: string, choice: string, note: string, who: DecidedBy): void {
  if (stage === 'pairs') {
    decideRule(db, setId, { rule_hash: key, decision: choice === 'adopt' ? 'adopt' : 'reject', note }, who);
    return;
  }
  const pending = db.prepare(
    `SELECT 1 FROM review_queue q JOIN edge_type_roles t ON t.rowid = q.detail_id
      WHERE q.domain = 'edge' AND q.rule_set_id = ? AND q.severity = 'edge_role_disagreement' AND q.detail_table = 'edge_type_roles'
        AND q.status = 'pending' AND t.family || '.' || t.type_key = ?`,
  ).get(setId, key);
  if (!pending) throw new RuleSetError('invalid', `${key} was decided before the verdict`);
  const d = { family: key.slice(0, key.indexOf('.')), type_key: key.slice(key.indexOf('.') + 1), note };
  if (choice === 'voted') keepVotedRole(db, setId, d, who);
  else if (choice === 'none') keepRoleNone(db, setId, d, who);
  else decideRole(db, setId, { ...d, pass_index: Number(choice.slice(1)) }, who);
}

// ---- status -------------------------------------------------------------------------------------

export function debateStatus(db: DatabaseSync, setId: number): Record<Stage, { open_rounds: number; outcomes: Record<string, number>; waiting_items: number }> {
  const st = (stage: Stage) => ({
    open_rounds: (db.prepare('SELECT COUNT(*) n FROM edge_debate_batches WHERE set_id = ? AND stage = ? AND submitted_at IS NULL').get(setId, stage) as { n: number }).n,
    outcomes: Object.fromEntries((db.prepare('SELECT outcome k, COUNT(*) n FROM edge_debate_outcomes WHERE set_id = ? AND stage = ? GROUP BY outcome')
      .all(setId, stage) as Array<{ k: string; n: number }>).map((r) => [r.k, r.n])),
    waiting_items: debateItems(db, setId, stage).length,
  });
  return { roles: st('roles'), pairs: st('pairs') };
}
