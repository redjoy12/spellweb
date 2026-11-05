import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { listEdgeFindings } from '../src/graph/edgeQueue.js';
import { passDir, submitStage, type Stage } from '../src/graph/ruleBatches.js';
import {
  DEBATE_BATCH_PART_TITLE, DEBATE_INSTRUCTIONS, DEBATERS, MAX_ROUNDS, debateDir, debateItems, prepareDebate, splitSourcePacket, submitDebate,
} from '../src/graph/ruleDebate.js';
import { ruleHash, type EdgeRuleItem, type RoleItem } from '../src/graph/ruleSchema.js';
import { createRuleSet, setRoles, setRules } from '../src/graph/ruleSet.js';
import { fixtureWithClauses } from './helpers/fixture.js';
import { agentsDir, sha16, twoPartSha } from '../src/graph/pairFixed.js';

// The fixture corpus cannot build a real fixed part (it has no kernel lookups). A Stage B debate
// gets a synthetic debater agent whose refs are the fixture refs; the two-part path is real.
vi.mock('../src/graph/pairFixed.js', async (orig) => {
  const m = await orig<typeof import('../src/graph/pairFixed.js')>();
  const fileText = '---\nname: edge-rule-pair-debater\n---\n\nthe synthetic fixed part\n';
  return { ...m, debaterAgent: () => ({ name: m.DEBATER_AGENT, fileText, sha: m.sha16(fileText), refs: ['700', '700.1', '118'] }) };
});

// spec rev. 9 sec. 5.6. The deriver and debater answers are synthetic: the test writes them, with
// quotes from the fixture rule rows ("text of <number>"), so no answer states a Magic fact.

const ev = (ref: string) => ({ source: 'rule' as const, ref, quote: `text of ${ref}` });
const bad = { source: 'rule' as const, ref: '700', quote: 'not in the rule' };
const T = { DRAW: 'PRODUCES.CARD_DRAW', TOKENS: 'PRODUCES.TOKENS', DEATH: 'CARES_ABOUT.CREATURE_DEATH' };
const split = (id: string) => ({ family: id.slice(0, id.indexOf('.')), type_key: id.slice(id.indexOf('.') + 1) });
const role = (id: string, r: RoleItem['role'], over: Partial<RoleItem> = {}): RoleItem =>
  ({ ...split(id), role: r, resources: [], evidence: [ev('700.1')], ...over });
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

let dir: string;
const before = process.env['EDGE_RULE_BATCHES_DIR'];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rule-debate-'));
  process.env['EDGE_RULE_BATCHES_DIR'] = dir;
});
afterEach(() => {
  if (before === undefined) delete process.env['EDGE_RULE_BATCHES_DIR']; else process.env['EDGE_RULE_BATCHES_DIR'] = before;
  rmSync(dir, { recursive: true, force: true });
});

function fixture(): { db: DatabaseSync; setId: number } {
  const db = fixtureWithClauses('Flying');
  db.prepare('INSERT INTO glossary_entries (corpus_id, term, term_key, definition, cross_refs) VALUES (1, ?, ?, ?, ?)')
    .run('Creature', 'creature', 'A card type. text of the glossary entry.', '[]');
  // The subtype parser needs its term lookup (spec rev. 6 sec. 11.2); the fixture has no list rule.
  db.prepare("INSERT INTO rule_term_index (corpus_id, term, term_key, source, rule_numbers, definition, evidence) VALUES (1, 'Subtype', 'subtype', 'glossary', '[]', 'd', 'e')").run();
  const { setId } = createRuleSet(db, 'test-model');
  return { db, setId };
}

/** A source batch with a packet on disk whose SHA the batch row records, and three deriver answers. */
function batch(db: DatabaseSync, setId: number, stage: Stage, key: string, types: string[], bodies: unknown[], demand: string | null = null): string {
  const head = stage === 'roles' ? '# Atom types' : '# Demand type';
  const packet = `# Edge-rule packet - test\n\n# Instructions\nthe deriver instructions\n\n${head}\n${types.join('\n')}\n\n# Comprehensive Rules\ntext of 700\n\n# Answer format\nthe deriver format\n`;
  for (let k = 1; k <= 3; k++) {
    const d = passDir(setId, stage, key, k);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'packet.md'), packet);
    writeFileSync(join(d, 'response.json'), JSON.stringify(bodies[k - 1]));
  }
  db.prepare(`INSERT INTO edge_rule_batches (set_id, stage, batch_key, demand, types_json, refs_json, packet_sha, packet_bytes, prepared_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 100, 't')`)
    .run(setId, stage, key, demand, JSON.stringify(types), JSON.stringify(['700', '700.1', '118']), sha(packet));
  return packet;
}

type Answer = { item: string; choice: string; argument?: string; evidence?: unknown[] };
function debate(setId: number, stage: Stage, key: string, round: number, answers: Answer[][]): void {
  answers.forEach((list, k) => {
    const d = debateDir(setId, stage, key, round, k + 1);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'response.json'), JSON.stringify({
      answers: list.map((a) => ({ item: a.item, choice: a.choice, argument: a.argument ?? `argument ${k + 1}`, evidence: a.evidence ?? [ev('700')] })),
    }));
  });
}
const all = (choice: string, item = 'D01'): Answer[][] => Array.from({ length: DEBATERS }, () => [{ item, choice }]);

/** A type with no majority role: three passes give three roles. */
function disputedRole() {
  const { db, setId } = fixture();
  const packet = batch(db, setId, 'roles', 'roles-0', [T.DEATH], [
    { roles: [role(T.DEATH, 'supply')], missing_rules: [] },
    { roles: [role(T.DEATH, 'demand', { demand_note: 'note two' })], missing_rules: [] },
    { roles: [role(T.DEATH, 'both', { demand_note: 'note three' })], missing_rules: [] },
  ]);
  submitStage(db, setId, 'roles');
  return { db, setId, packet };
}

describe('debate items and packets (spec rev. 9 sec. 5.6)', () => {
  it('gives a disputed role the proposal of each pass and none as options', () => {
    const { db, setId } = disputedRole();
    expect(debateItems(db, setId, 'roles')).toEqual([expect.objectContaining({ key: T.DEATH, batch_key: 'roles-0', options: ['P1', 'P2', 'P3', 'none'] })]);
  });

  it('gives an other-resource item each pass that differs from the voted role, voted, and none', () => {
    const { db, setId } = fixture();
    const other = { resource: 'other', sign: '+' as const, kind: 'value' as const, note: 'a named resource', evidence: [ev('700')] };
    batch(db, setId, 'roles', 'roles-0', [T.TOKENS], [
      { roles: [role(T.TOKENS, 'supply', { resources: [other] })], missing_rules: [] },
      { roles: [role(T.TOKENS, 'supply')], missing_rules: [] },
      { roles: [role(T.TOKENS, 'supply', { evidence: [ev('118')] })], missing_rules: [] },
    ]);
    submitStage(db, setId, 'roles');
    expect(debateItems(db, setId, 'roles')[0]!.options).toEqual(['P1', 'voted', 'none']);
  });

  it('writes three debater directories with the source body, the debate instructions and the items', () => {
    const { db, setId, packet } = disputedRole();
    const r = prepareDebate(db, setId, 'roles');
    expect(r).toMatchObject({ batches: 1, items: 1 });
    expect(r.dirs).toHaveLength(DEBATERS);
    const md = readFileSync(join(r.dirs[0]!, 'packet.md'), 'utf8');
    expect(md).toContain(DEBATE_INSTRUCTIONS);
    expect(md).toContain('# Instructions of the earlier passes\nthe deriver instructions');
    expect(md).toContain(splitSourcePacket(packet).body);
    expect(md).toContain('## D01 - CARES_ABOUT CREATURE_DEATH');
    expect(md).toContain('- P2: {"role":"demand"');
    expect(md).not.toContain('the deriver format');
    expect(md).not.toContain('# Arguments of the previous round');
    expect(() => prepareDebate(db, setId, 'roles')).toThrow(/round is open/);
  });

  it('refuses a source packet that is not the packet of the batch', () => {
    const { db, setId } = disputedRole();
    writeFileSync(join(passDir(setId, 'roles', 'roles-0', 1), 'packet.md'), 'changed');
    expect(() => prepareDebate(db, setId, 'roles')).toThrow(/not the packet of batch/);
  });
});

describe('debate rounds and verdicts (spec rev. 9 sec. 5.6)', () => {
  it('applies an agreed verdict as a debate decision and resolves the review item', () => {
    const { db, setId } = disputedRole();
    prepareDebate(db, setId, 'roles');
    debate(setId, 'roles', 'roles-0', 1, all('P2'));
    const r = submitDebate(db, setId, 'roles');
    expect(r).toMatchObject({ batches: 1, agreed: 1, no_agreement: 0, next_round: 0 });
    expect(setRoles(db, setId)[0]).toMatchObject({ role: 'demand', status: 'accepted' });
    expect(db.prepare('SELECT decision, pass_index, decided_by, debate_round, note FROM edge_role_decisions').get())
      .toMatchObject({ decision: 'pass', pass_index: 2, decided_by: 'debate', debate_round: 1, note: expect.stringMatching(/^debate round 1: 3 of 3 debaters selected P2/) });
    expect(listEdgeFindings(db)).toHaveLength(0);
    expect(prepareDebate(db, setId, 'roles').items).toBe(0);
  });

  it('does not count an answer with a bad quote or an unknown option, and shows the valid arguments in the next round', () => {
    const { db, setId } = disputedRole();
    prepareDebate(db, setId, 'roles');
    debate(setId, 'roles', 'roles-0', 1, [
      [{ item: 'D01', choice: 'P2', argument: 'the first argument' }],
      [{ item: 'D01', choice: 'P2', evidence: [bad] }],
      [{ item: 'D01', choice: 'P9' }, { item: 'D07', choice: 'P1' }],
    ]);
    const r = submitDebate(db, setId, 'roles');
    expect(r).toMatchObject({ agreed: 0, next_round: 1, ignored: 1, faults: { not_verbatim: 1, unknown_option: 1 } });
    expect(setRoles(db, setId)[0]).toMatchObject({ role: 'none', status: 'disputed' });
    const next = prepareDebate(db, setId, 'roles');
    expect(next.dirs[0]).toBe(debateDir(setId, 'roles', 'roles-0', 2, 1));
    const md = readFileSync(join(next.dirs[0]!, 'packet.md'), 'utf8');
    expect(md).toContain('# Arguments of the previous round\n## D01\n- Debater A: choice P2. Argument: the first argument');
    expect(md).not.toContain('Debater B');
  });

  it('gives no_agreement after the last round and keeps the default and the review item', () => {
    const { db, setId } = disputedRole();
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      prepareDebate(db, setId, 'roles');
      debate(setId, 'roles', 'roles-0', round, [[{ item: 'D01', choice: 'P1' }], [{ item: 'D01', choice: 'P2' }], [{ item: 'D01', choice: 'P2' }]]);
      submitDebate(db, setId, 'roles');
    }
    expect(db.prepare('SELECT outcome, round FROM edge_debate_outcomes').get()).toMatchObject({ outcome: 'no_agreement', round: MAX_ROUNDS });
    expect(setRoles(db, setId)[0]).toMatchObject({ role: 'none', status: 'disputed' });
    expect(listEdgeFindings(db)).toHaveLength(1);
    expect(prepareDebate(db, setId, 'roles').items).toBe(0);
  });

  it('waits for missing responses and keeps the round open', () => {
    const { db, setId } = disputedRole();
    prepareDebate(db, setId, 'roles');
    const r = submitDebate(db, setId, 'roles');
    expect(r.waiting).toEqual(['roles-0 round 1']);
    expect(existsSync(join(debateDir(setId, 'roles', 'roles-0', 1, 1), 'packet.md'))).toBe(true);
  });

  it('records not_applied when the verdict cannot apply, and applies it at a later submit', () => {
    const { db, setId } = disputedRole();
    // A type that a Stage B batch shows keeps its role (ruleSet.ts, guardStageB).
    db.prepare(`INSERT INTO edge_rule_batches (set_id, stage, batch_key, demand, types_json, refs_json, packet_sha, packet_bytes, prepared_at)
                VALUES (?, 'pairs', 'X-0', 'PRODUCES.X', ?, '[]', 's', 1, 't')`).run(setId, JSON.stringify(['PRODUCES.X', T.DEATH]));
    prepareDebate(db, setId, 'roles');
    debate(setId, 'roles', 'roles-0', 1, all('P1'));
    const r = submitDebate(db, setId, 'roles');
    expect(r.not_applied).toEqual([expect.stringMatching(/^CARES_ABOUT.CREATURE_DEATH \(P1\): .* is in a Stage B batch already/)]);
    expect(db.prepare('SELECT outcome, choice FROM edge_debate_outcomes').get()).toMatchObject({ outcome: 'not_applied', choice: 'P1' });
    expect(listEdgeFindings(db)).toHaveLength(1);
    db.prepare("DELETE FROM edge_rule_batches WHERE stage = 'pairs'").run();
    expect(submitDebate(db, setId, 'roles').reapplied).toBe(1);
    expect(db.prepare('SELECT outcome FROM edge_debate_outcomes').get()).toMatchObject({ outcome: 'agreed' });
    expect(setRoles(db, setId)[0]).toMatchObject({ role: 'supply', status: 'accepted' });
    expect(listEdgeFindings(db)).toHaveLength(0);
  });

  it('adopts a disputed rule as a debate decision', () => {
    const { db, setId } = fixture();
    const key = `${T.DEATH}-0`;
    const disputed: EdgeRuleItem = {
      polarity: '-', supply: { ...split(T.TOKENS), where: [] }, demand: { ...split(T.DEATH), where: [] }, param_links: [], implications: [], evidence: [ev('118')],
    };
    batch(db, setId, 'pairs', key, [T.DEATH, T.TOKENS], [
      { rules: [disputed], missing_rules: [] }, { rules: [], missing_rules: [] }, { rules: [], missing_rules: [] },
    ], T.DEATH);
    submitStage(db, setId, 'pairs');
    expect(debateItems(db, setId, 'pairs')).toEqual([expect.objectContaining({ key: ruleHash(disputed), options: ['adopt', 'reject'] })]);
    const r = prepareDebate(db, setId, 'pairs');
    // spec rev. 10 sec. 5.2: a two-part debate packet; the debater agent carries the fixed part.
    const packet = readFileSync(join(r.dirs[0]!, 'packet.md'), 'utf8');
    expect(packet.startsWith(DEBATE_BATCH_PART_TITLE)).toBe(true);
    expect(packet).toContain('Rule: {"polarity":"-"');
    expect(packet).toContain('# Supply candidates\n');
    expect(packet).not.toContain('# Comprehensive Rules');
    expect(r.agent).toBe('edge-rule-pair-debater');
    const agentFile = join(agentsDir(), 'edge-rule-pair-debater.md');
    const agentText = readFileSync(agentFile, 'utf8');
    const m = JSON.parse(readFileSync(join(r.dirs[0]!, 'manifest.json'), 'utf8')) as { agent_sha: string; packet_sha: string };
    expect(m.agent_sha).toBe(sha16(agentText));
    expect(m.packet_sha).toBe(twoPartSha(m.agent_sha, packet));
    debate(setId, 'pairs', key, 1, all('adopt'));
    writeFileSync(agentFile, 'changed');
    expect(() => submitDebate(db, setId, 'pairs')).toThrow(/changed after the prepare/);
    writeFileSync(agentFile, agentText);
    expect(submitDebate(db, setId, 'pairs').agreed).toBe(1);
    expect(setRules(db, setId, 'accepted').map((x) => x.rule_hash)).toEqual([ruleHash(disputed)]);
    expect(db.prepare('SELECT decision, decided_by, debate_round FROM edge_rule_decisions').get()).toMatchObject({ decision: 'adopt', decided_by: 'debate', debate_round: 1 });
    expect(listEdgeFindings(db)).toHaveLength(0);
  });
});
