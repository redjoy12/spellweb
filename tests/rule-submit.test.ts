import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, DB_PATH } from '../src/db/client.js';
import { listEdgeFindings } from '../src/graph/edgeQueue.js';
import {
  BATCH_PART_TITLE, PAIR_ANSWER_FORMAT, PAIR_INSTRUCTIONS, ROLE_INSTRUCTIONS, packetContext, planPairPackets,
} from '../src/graph/edgePackets.js';
import { agentsDir, twoPartSha } from '../src/graph/pairFixed.js';
import { PASSES, passDir, preparePairs, prepareRoles, submitStage, type RuleManifest, type Stage } from '../src/graph/ruleBatches.js';
import { ruleHash, type EdgeRuleItem, type RoleItem } from '../src/graph/ruleSchema.js';
import {
  abandonRuleSet, acceptRuleSet, createRuleSet, decideRole, demandTypes, keepVotedRole, setRules, setRoles,
} from '../src/graph/ruleSet.js';
import { fixtureWithClauses } from './helpers/fixture.js';
import { realDb } from './helpers/realDb.js';

// spec sec. 5.3-5.4 and plan Task 3 Step 4. The responses are synthetic: the test writes them,
// with quotes from the fixture rule rows ("text of <number>"), so no answer states a Magic fact.

const ev = (ref: string) => ({ source: 'rule' as const, ref, quote: `text of ${ref}` });
const T = { DRAW: 'PRODUCES.CARD_DRAW', LIFE: 'PRODUCES.LIFEGAIN', TOKENS: 'PRODUCES.TOKENS', DEATH: 'CARES_ABOUT.CREATURE_DEATH', FLY: 'COMBAT.FLYING' };
const split = (id: string) => ({ family: id.slice(0, id.indexOf('.')), type_key: id.slice(id.indexOf('.') + 1) });
const role = (id: string, r: RoleItem['role'], over: Partial<RoleItem> = {}): RoleItem =>
  ({ ...split(id), role: r, resources: [], evidence: [ev('700.1')], ...over });
const rule = (supply: EdgeRuleItem['supply'], over: Partial<EdgeRuleItem> = {}): EdgeRuleItem => ({
  polarity: '+', supply, demand: { ...split(T.DEATH), where: [] }, param_links: [], implications: [], evidence: [ev('118')], ...over,
});
const typeSide = (id: string) => ({ ...split(id), where: [] });

let dir: string;
const before = process.env['EDGE_RULE_BATCHES_DIR'];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rule-submit-'));
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

function batch(db: DatabaseSync, setId: number, stage: Stage, key: string, types: string[], demand: string | null = null): void {
  db.prepare(`INSERT INTO edge_rule_batches (set_id, stage, batch_key, demand, types_json, refs_json, packet_sha, packet_bytes, prepared_at)
              VALUES (?, ?, ?, ?, ?, ?, 'sha', 100, 't')`)
    .run(setId, stage, key, demand, JSON.stringify(types), JSON.stringify(['700', '700.1', '118', 'glossary:Creature']));
}

function respond(setId: number, stage: Stage, key: string, bodies: unknown[]): void {
  bodies.forEach((b, k) => {
    const d = passDir(setId, stage, key, k + 1);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'response.json'), typeof b === 'string' ? b : JSON.stringify(b));
  });
}

const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

describe('submitStage, Stage A (spec sec. 5.3)', () => {
  function stageA() {
    const { db, setId } = fixture();
    batch(db, setId, 'roles', 'roles-0', [T.DRAW, T.LIFE, T.TOKENS, T.DEATH]);
    const permanents = { resource: 'permanents', sign: '+' as const, kind: 'value' as const, evidence: [ev('700')] };
    respond(setId, 'roles', 'roles-0', [
      { roles: [role(T.DRAW, 'supply'), role(T.TOKENS, 'supply', { resources: [permanents] }), role(T.DEATH, 'demand', { demand_note: 'note one' }), role(T.LIFE, 'supply')],
        missing_rules: [{ needed: 'more text', rationale: 'why' }] },
      { roles: [role(T.DRAW, 'supply'), role(T.TOKENS, 'supply', { resources: [permanents] }), role(T.DEATH, 'both'), role(T.LIFE, 'demand'),
        role(T.DRAW, 'supply', { resources: [{ resource: 'no_such_resource', sign: '+', kind: 'value', evidence: [ev('700')] }] })],
        missing_rules: [] },
      { roles: [role(T.DRAW, 'demand'), role(T.DEATH, 'demand', { demand_note: 'note three' }), role(T.LIFE, 'both'),
        role(T.TOKENS, 'supply', { resources: [{ resource: 'other', sign: '-', kind: 'cost', note: 'a named resource', evidence: [ev('700')] }] })],
        missing_rules: [] },
    ]);
    return { db, setId, r: submitStage(db, setId, 'roles') };
  }

  it('writes one pass row for each pass, with the counts of valid and rejected items', () => {
    const { db, setId, r } = stageA();
    expect(r.batches).toBe(1);
    const passes = db.prepare('SELECT batch_key, pass_index, items_valid, items_rejected FROM edge_rule_passes WHERE set_id = ? ORDER BY pass_index').all(setId);
    expect(passes).toEqual([
      expect.objectContaining({ batch_key: 'roles-0', pass_index: 1, items_valid: 4, items_rejected: 0 }),
      expect.objectContaining({ pass_index: 2, items_valid: 4, items_rejected: 1 }),
      expect.objectContaining({ pass_index: 3, items_valid: 4, items_rejected: 0 }),
    ]);
  });

  it('writes each rejected item with its cause, and each valid item with item_key FAMILY.TYPE_KEY', () => {
    const { db } = stageA();
    expect(db.prepare('SELECT pass_index, cause FROM edge_rule_rejections').all()).toEqual([expect.objectContaining({ pass_index: 2, cause: 'unknown_resource' })]);
    const keys = (db.prepare("SELECT DISTINCT item_key FROM edge_rule_pass_items WHERE stage = 'roles' ORDER BY item_key").all() as Array<{ item_key: string }>).map((x) => x.item_key);
    expect(keys).toEqual([T.DEATH, T.DRAW, T.LIFE, T.TOKENS].sort());
    const item = JSON.parse((db.prepare("SELECT item_json FROM edge_rule_pass_items WHERE item_key = ? AND pass_index = 1").get(T.DEATH) as { item_json: string }).item_json);
    expect(item).toMatchObject({ role: 'demand', demand_note: 'note one', evidence: [ev('700.1')] });
  });

  it('writes each absent-CR report with status open', () => {
    const { db } = stageA();
    expect(db.prepare('SELECT pass_index, needed, status FROM edge_missing_rule_reports').all()).toEqual([expect.objectContaining({ pass_index: 1, needed: 'more text', status: 'open' })]);
  });

  it('votes the roles and the resource map; a disputed role and an other resource each make one queue item', () => {
    const { db, setId } = stageA();
    const roles = Object.fromEntries(setRoles(db, setId).map((x) => [`${x.family}.${x.type_key}`, x]));
    expect(roles[T.DRAW]).toMatchObject({ role: 'supply', votes: 2, status: 'accepted' });
    expect(roles[T.DEATH]).toMatchObject({ role: 'demand', votes: 2, status: 'accepted', demand_note: 'note one\nnote three' });
    expect(roles[T.TOKENS]).toMatchObject({ role: 'supply', votes: 3, resources: [expect.objectContaining({ resource: 'permanents', sign: '+', kind: 'value' })] });
    expect(roles[T.LIFE]).toMatchObject({ role: 'none', status: 'disputed', votes: 1 });
    const items = listEdgeFindings(db);
    expect(items.map((f) => [f.severity, f.role_type, f.rank_score]).sort()).toEqual([
      ['edge_role_disagreement', T.LIFE, 0], ['edge_role_disagreement', T.TOKENS, 0],
    ].sort());
  });

  it('gives a type of the batch that no pass gives the role none and a queue item', () => {
    const { db, setId } = fixture();
    batch(db, setId, 'roles', 'roles-0', [T.DRAW, T.FLY]);
    respond(setId, 'roles', 'roles-0', [1, 2, 3].map(() => ({ roles: [role(T.DRAW, 'supply')], missing_rules: [] })));
    submitStage(db, setId, 'roles');
    expect(setRoles(db, setId).find((x) => x.type_key === 'FLYING')).toMatchObject({ role: 'none', status: 'disputed', votes: 0 });
    expect(listEdgeFindings(db).map((f) => f.role_type)).toEqual([T.FLY]);
  });

  it('uses the batch keys roles-<chunk>, so two Stage A chunks do not repeat a primary key', () => {
    const { db, setId } = fixture();
    batch(db, setId, 'roles', 'roles-0', [T.DRAW]);
    batch(db, setId, 'roles', 'roles-1', [T.LIFE]);
    respond(setId, 'roles', 'roles-0', [1, 2, 3].map(() => ({ roles: [role(T.DRAW, 'supply')], missing_rules: [] })));
    respond(setId, 'roles', 'roles-1', [1, 2, 3].map(() => ({ roles: [role(T.LIFE, 'supply')], missing_rules: [] })));
    expect(submitStage(db, setId, 'roles').batches).toBe(2);
    expect(count(db, 'edge_rule_passes')).toBe(2 * PASSES);
  });

  it('adds no rows at a second submit of the same set', () => {
    const { db, setId } = stageA();
    const tables = ['edge_rule_passes', 'edge_rule_pass_items', 'edge_rule_rejections', 'edge_missing_rule_reports', 'edge_type_roles', 'review_queue'];
    const counts = tables.map((t) => count(db, t));
    expect(submitStage(db, setId, 'roles').batches).toBe(0);
    expect(tables.map((t) => count(db, t))).toEqual(counts);
  });

  it('a response that does not parse fails its batch and changes nothing; a missing response waits', () => {
    const { db, setId } = fixture();
    batch(db, setId, 'roles', 'roles-0', [T.DRAW]);
    batch(db, setId, 'roles', 'roles-1', [T.LIFE]);
    respond(setId, 'roles', 'roles-0', [{ roles: [], missing_rules: [] }, 'not json', { roles: [{ family: 'X' }], missing_rules: [] }]);
    respond(setId, 'roles', 'roles-1', [{ roles: [], missing_rules: [] }]);
    const r = submitStage(db, setId, 'roles');
    expect(r).toMatchObject({ batches: 0, waiting: ['roles-1'] });
    expect(r.unreadable).toHaveLength(2);
    for (const t of ['edge_rule_passes', 'edge_rule_pass_items', 'edge_type_roles', 'review_queue']) expect(count(db, t)).toBe(0);
  });
});

describe('submitStage, Stage B (spec sec. 5.3)', () => {
  function stageB() {
    const { db, setId } = fixture();
    const key = `${T.DEATH}-0`;
    batch(db, setId, 'pairs', key, [T.DEATH, T.DRAW, T.TOKENS], T.DEATH);
    const a = rule(typeSide(T.DRAW));
    const disputed = rule(typeSide(T.TOKENS), { polarity: '-' });
    respond(setId, 'pairs', key, [
      { rules: [a, rule({ intrinsic: 'card_type', value: 'creature' })], missing_rules: [] },
      { rules: [{ ...a, evidence: [ev('700')] }, rule({ intrinsic: 'card_type', value: 'Creature' })], missing_rules: [] },
      { rules: [disputed, rule(typeSide(T.FLY))], missing_rules: [{ needed: 'n', rationale: 'r' }] },
    ]);
    return { db, setId, a, disputed, r: submitStage(db, setId, 'pairs') };
  }

  it('accepts a rule from two passes, with the union of the evidence, and assigns rule ids', () => {
    const { db, setId, a } = stageB();
    const acc = setRules(db, setId, 'accepted');
    expect(acc).toHaveLength(2);
    const ra = acc.find((x) => x.rule_hash === ruleHash(a))!;
    expect(ra).toMatchObject({ votes: 2, status: 'accepted', evidence: [ev('118'), ev('700')] });
    expect(acc.map((x) => x.rule_id).sort()).toEqual(['ER-0001', 'ER-0002']);
  });

  it('gives an intrinsic value its permitted spelling, so the two passes vote together', () => {
    const { db, setId } = stageB();
    expect(setRules(db, setId, 'accepted').find((x) => 'intrinsic' in x.supply)).toMatchObject({ supply: { intrinsic: 'card_type', value: 'Creature' }, votes: 2 });
  });

  it('keeps a disputed rule out of the accepted rules, with one queue item of rank 0', () => {
    const { db, setId, disputed } = stageB();
    expect(setRules(db, setId, 'accepted').map((x) => x.rule_hash)).not.toContain(ruleHash(disputed));
    expect(setRules(db, setId, 'disputed')).toEqual([expect.objectContaining({ rule_hash: ruleHash(disputed), votes: 1 })]);
    expect(listEdgeFindings(db).map((f) => [f.severity, f.rank_score])).toEqual([['edge_rule_disagreement', 0]]);
  });

  it('rejects a rule whose supply type is not in the packet', () => {
    const { db } = stageB();
    expect(db.prepare('SELECT pass_index, cause FROM edge_rule_rejections').all()).toEqual([expect.objectContaining({ pass_index: 3, cause: 'unknown_type' })]);
    expect(db.prepare("SELECT COUNT(*) n FROM edge_rule_pass_items WHERE stage = 'pairs'").get()).toEqual(expect.objectContaining({ n: 5 }));
  });

  it('merges the same rule from two chunks of one demand type', () => {
    const { db, setId } = stageB();
    const key = `${T.DEATH}-1`;
    batch(db, setId, 'pairs', key, [T.DEATH, T.LIFE], T.DEATH);
    const cls = rule({ intrinsic: 'card_type', value: 'Creature' }, { evidence: [ev('700')] });
    respond(setId, 'pairs', key, [1, 2, 3].map(() => ({ rules: [cls], missing_rules: [] })));
    submitStage(db, setId, 'pairs');
    const row = setRules(db, setId, 'accepted').find((x) => 'intrinsic' in x.supply)!;
    expect(row).toMatchObject({ votes: 3, evidence: [ev('118'), ev('700')] });
  });
});

describe('more Stage B submits, and the set life cycle (spec sec. 5.1, 5.5)', () => {
  const key0 = `${T.DEATH}-0`;
  const key1 = `${T.DEATH}-1`;
  const tokens = rule(typeSide(T.TOKENS));
  function twoParts() {
    const { db, setId } = fixture();
    batch(db, setId, 'roles', 'roles-0', [T.DRAW, T.TOKENS, T.DEATH]);
    respond(setId, 'roles', 'roles-0', [1, 2, 3].map(() => ({
      roles: [role(T.DRAW, 'supply'), role(T.TOKENS, 'supply'), role(T.DEATH, 'demand')], missing_rules: [],
    })));
    submitStage(db, setId, 'roles');
    batch(db, setId, 'pairs', key0, [T.DEATH, T.DRAW, T.TOKENS], T.DEATH);
    batch(db, setId, 'pairs', key1, [T.DEATH, T.LIFE], T.DEATH);
    // The intrinsic rule is disputed in chunk 0 (one pass) and accepted in chunk 1 (three passes).
    const cls = rule({ intrinsic: 'card_type', value: 'Creature' });
    respond(setId, 'pairs', key0, [{ rules: [tokens, cls], missing_rules: [] }, { rules: [tokens], missing_rules: [] }, { rules: [], missing_rules: [] }]);
    submitStage(db, setId, 'pairs');
    return { db, setId, cls };
  }

  it('resolves the queue item of a rule that a later part accepts', () => {
    const { db, setId, cls } = twoParts();
    expect(listEdgeFindings(db).map((f) => f.severity)).toEqual(['edge_rule_disagreement']);
    respond(setId, 'pairs', key1, [1, 2, 3].map(() => ({ rules: [cls], missing_rules: [] })));
    submitStage(db, setId, 'pairs');
    expect(setRules(db, setId, 'accepted').map((r) => r.rule_hash)).toContain(ruleHash(cls));
    expect(listEdgeFindings(db)).toHaveLength(0);
  });

  it('adds no rows at a second Stage B submit', () => {
    const { db, setId, cls } = twoParts();
    respond(setId, 'pairs', key1, [1, 2, 3].map(() => ({ rules: [cls], missing_rules: [] })));
    submitStage(db, setId, 'pairs');
    const tables = ['edge_rule_passes', 'edge_rule_pass_items', 'edge_rule_rejections', 'edge_rules', 'review_queue'];
    const counts = tables.map((t) => count(db, t));
    expect(submitStage(db, setId, 'pairs').batches).toBe(0);
    expect(tables.map((t) => count(db, t))).toEqual(counts);
  });

  it('refuses to accept a set with a batch that has no stored passes, or with a pending role item without force', () => {
    const { db, setId, cls } = twoParts();
    expect(() => acceptRuleSet(db, setId)).toThrow(/no stored passes: pairs CARES_ABOUT.CREATURE_DEATH-1/);
    respond(setId, 'pairs', key1, [1, 2, 3].map(() => ({ rules: [cls], missing_rules: [] })));
    submitStage(db, setId, 'pairs');
    db.prepare("UPDATE edge_type_roles SET status = 'disputed' WHERE type_key = 'TOKENS'").run();
    db.prepare(`INSERT INTO review_queue (domain, rule_set_id, severity, severity_rank, rank_score, detail_table, detail_id, enqueued_at)
                SELECT 'edge', ?, 'edge_role_disagreement', 1, 0, 'edge_type_roles', rowid, 't' FROM edge_type_roles WHERE type_key = 'TOKENS'`).run(setId);
    expect(() => acceptRuleSet(db, setId)).toThrow(/pending role item/);
    acceptRuleSet(db, setId, { force: true });
    expect(db.prepare('SELECT status FROM edge_rule_sets WHERE id = ?').get(setId)).toEqual(expect.objectContaining({ status: 'accepted' }));
  });

  it('keeps the rule id of an earlier set by rule_hash, gives a new rule the next id, and supersedes the old set', () => {
    const first = twoParts();
    const { db } = first;
    respond(first.setId, 'pairs', key1, [1, 2, 3].map(() => ({ rules: [first.cls], missing_rules: [] })));
    submitStage(db, first.setId, 'pairs');
    acceptRuleSet(db, first.setId);
    const idOf = (setId: number, h: string) => setRules(db, setId, 'all').find((r) => r.rule_hash === h)!.rule_id;
    const oldTokens = idOf(first.setId, ruleHash(tokens));

    const { setId } = createRuleSet(db, 'test-model');
    batch(db, setId, 'pairs', key0, [T.DEATH, T.DRAW, T.TOKENS], T.DEATH);
    const draw = rule(typeSide(T.DRAW));
    respond(setId, 'pairs', key0, [1, 2, 3].map(() => ({ rules: [draw, tokens], missing_rules: [] })));
    submitStage(db, setId, 'pairs');
    expect(idOf(setId, ruleHash(tokens))).toBe(oldTokens);
    expect(idOf(setId, ruleHash(draw))).toBe('ER-0003');
    acceptRuleSet(db, setId, { force: true });
    expect(db.prepare('SELECT id, status FROM edge_rule_sets ORDER BY id').all().map((r) => (r as { status: string }).status)).toEqual(['superseded', 'accepted']);
  });

  it('abandons an in-progress set with its rows and edge items, so that a new set can start', () => {
    const { db, setId } = twoParts();
    expect(() => createRuleSet(db, 'other-model')).toThrow(/in progress/);
    abandonRuleSet(db, setId);
    for (const t of ['edge_rule_sets', 'edge_rule_batches', 'edge_rule_passes', 'edge_rules', 'edge_type_roles', 'review_queue']) expect(count(db, t)).toBe(0);
    expect(createRuleSet(db, 'other-model').version).toBe(1);
  });

  it('keeps the voted role of an other-resource item, and the summary names the other resource', () => {
    const { db, setId } = fixture();
    batch(db, setId, 'roles', 'roles-0', [T.TOKENS]);
    const other = { resource: 'other', sign: '+' as const, kind: 'value' as const, note: 'a named resource', evidence: [ev('700')] };
    respond(setId, 'roles', 'roles-0', [
      { roles: [role(T.TOKENS, 'supply', { resources: [other] })], missing_rules: [] },
      { roles: [role(T.TOKENS, 'supply')], missing_rules: [] },
      { roles: [role(T.TOKENS, 'supply', { evidence: [ev('118')] })], missing_rules: [] },
    ]);
    submitStage(db, setId, 'roles');
    expect(listEdgeFindings(db)[0]!.summary).toMatch(/other resource: a named resource/);
    keepVotedRole(db, setId, { ...split(T.TOKENS), note: 'the voted role is right' });
    expect(setRoles(db, setId)[0]).toMatchObject({ role: 'supply', votes: 3, evidence: [ev('700.1'), ev('118')], decision: { decision: 'keep' } });
    expect(listEdgeFindings(db)).toHaveLength(0);
  });
});

const describeCopy = existsSync(DB_PATH) && realDb ? describe : describe.skip;

describeCopy('prepare on a scratch copy of the real database (spec sec. 5.2, plan D5)', () => {
  let db: DatabaseSync;
  let scratchDir: string;
  let setId: number;
  let dirs: string[];
  let gaps: string[];
  const env = process.env['EDGE_RULE_BATCHES_DIR'];

  beforeAll(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'rule-prepare-'));
    process.env['EDGE_RULE_BATCHES_DIR'] = join(scratchDir, 'batches');
    const scratch = join(scratchDir, 'app.db');
    copyFileSync(DB_PATH, scratch);
    for (const ext of ['-wal', '-shm']) if (existsSync(DB_PATH + ext)) copyFileSync(DB_PATH + ext, scratch + ext);
    db = openDb(scratch);
    db.exec("DELETE FROM review_queue WHERE domain = 'edge'; DELETE FROM fix_requests; DELETE FROM edge_reports; DELETE FROM decks; DELETE FROM graph_builds; DELETE FROM edge_rule_sets;");
    ({ setId, dirs, gaps } = prepareRoles(db, 'test-model'));
  }, 120_000);
  afterAll(() => {
    db?.close();
    if (env === undefined) delete process.env['EDGE_RULE_BATCHES_DIR']; else process.env['EDGE_RULE_BATCHES_DIR'] = env;
    rmSync(scratchDir, { recursive: true, force: true });
  });
  // The outer beforeEach points the variable at a fresh empty directory; this suite uses its own.
  beforeEach(() => { process.env['EDGE_RULE_BATCHES_DIR'] = join(scratchDir, 'batches'); });

  it('writes three pass directories for each Stage A chunk, with keys roles-<chunk> and the final instructions', () => {
    const keys = (db.prepare("SELECT batch_key FROM edge_rule_batches WHERE set_id = ? AND stage = 'roles' ORDER BY batch_key").all(setId) as Array<{ batch_key: string }>).map((r) => r.batch_key);
    expect(keys.length).toBeGreaterThan(0);
    keys.forEach((k) => expect(k).toMatch(/^roles-\d+$/));
    expect(dirs).toHaveLength(keys.length * PASSES);
    const m = JSON.parse(readFileSync(join(dirs[0]!, 'manifest.json'), 'utf8')) as RuleManifest;
    expect(m).toMatchObject({ set_id: setId, stage: 'roles', pass_index: 1 });
    const packet = readFileSync(join(dirs[0]!, 'packet.md'), 'utf8');
    expect(packet).toContain(ROLE_INSTRUCTIONS);
    expect(packet).toContain('# Resources\n');
    expect(packet).not.toContain('PLACEHOLDER');
    expect(db.prepare('SELECT status, model FROM edge_rule_sets WHERE id = ?').get(setId)).toEqual(expect.objectContaining({ status: 'in_progress', model: 'test-model' }));
  });

  it('leaves each coverage gap out of the packets', () => {
    const types = (db.prepare("SELECT types_json FROM edge_rule_batches WHERE set_id = ? AND stage = 'roles'").all(setId) as Array<{ types_json: string }>)
      .flatMap((r) => JSON.parse(r.types_json) as string[]);
    for (const g of gaps) expect(types).not.toContain(g);
    expect(new Set(types).size).toBe(types.length);
  });

  it('a decided type with the role demand gets a Stage B batch at the next prepare', () => {
    // Synthetic Stage A answers: one demand type and one supply type by majority; a second
    // demand candidate and a supply candidate from one pass only, which a person then decides.
    // After the first Stage B prepare, a new demand type gets its batch; a new supply type gets a
    // supplementary batch of each old demand type; a type in a batch keeps its role.
    const batches = db.prepare("SELECT batch_key, types_json, refs_json FROM edge_rule_batches WHERE set_id = ? AND stage = 'roles' ORDER BY batch_key").all(setId) as
      Array<{ batch_key: string; types_json: string; refs_json: string }>;
    const all = batches.map((b) => ({ key: b.batch_key, types: JSON.parse(b.types_json) as string[], refs: JSON.parse(b.refs_json) as string[] }));
    const corpus = (db.prepare('SELECT corpus_id FROM edge_rule_sets WHERE id = ?').get(setId) as { corpus_id: number }).corpus_id;
    const quoteIn = (refs: string[]) => {
      const r = refs.find((x) => !x.startsWith('glossary:'))!;
      return { source: 'rule' as const, ref: r, quote: (db.prepare('SELECT text FROM rules WHERE corpus_id = ? AND number = ?').get(corpus, r) as { text: string }).text.slice(0, 12) };
    };
    const withTwo = all.find((b) => b.types.length >= 4)!;
    const [demand, later, supply, lateSupply] = withTwo.types;
    const e = quoteIn(withTwo.refs);
    for (const b of all) {
      const body = (k: number) => ({
        roles: b.key !== withTwo.key ? [] : [
          role(demand!, 'demand', { evidence: [e] }), role(supply!, 'supply', { evidence: [e] }),
          ...(k === 1 ? [role(later!, 'demand', { evidence: [e] })] : []),
          ...(k === 2 ? [role(lateSupply!, 'supply', { evidence: [e] })] : []),
        ],
        missing_rules: [],
      });
      respond(setId, 'roles', b.key, [1, 2, 3].map(body));
    }
    submitStage(db, setId, 'roles');
    expect(demandTypes(db, setId)).toEqual([demand]);

    expect(() => preparePairs(db, setId, {}, new Set([supply!]))).toThrow(/not a demand type/);
    const first = preparePairs(db, setId, {}, new Set([demand!]));
    expect(first.batches).toBe(1);
    expect(first.pendingRoles).toEqual(expect.arrayContaining([later, lateSupply]));
    const m = JSON.parse(readFileSync(join(first.dirs[0]!, 'manifest.json'), 'utf8')) as RuleManifest;
    expect(m).toMatchObject({ stage: 'pairs', demand, batch_key: `${demand}-0` });
    expect(m.types).toEqual([demand, supply]);
    // spec rev. 10 sec. 5.2: a two-part packet. The batch part has the types; the agent the rest.
    const packet = readFileSync(join(first.dirs[0]!, 'packet.md'), 'utf8');
    expect(packet.startsWith(BATCH_PART_TITLE)).toBe(true);
    expect(packet).not.toContain(PAIR_INSTRUCTIONS);
    // The class kinds follow the supply candidates, as in a single-part packet.
    expect(packet.indexOf('# Intrinsic class kinds and permitted values\n')).toBeGreaterThan(packet.indexOf('# Supply candidates\n'));
    expect(m.agent).toBe('edge-rule-pair-deriver-g1');
    expect(first.agentOf.get(first.dirs[0]!)).toBe(m.agent);
    const agentFile = join(agentsDir(), `${m.agent}.md`);
    const agentText = readFileSync(agentFile, 'utf8');
    expect(agentText).toContain(`name: ${m.agent}\n`);
    expect(agentText).toContain(PAIR_INSTRUCTIONS);
    expect(agentText).toContain(PAIR_ANSWER_FORMAT);
    expect(agentText).toContain('\n# Comprehensive Rules\n');
    expect(agentText).not.toContain('# Intrinsic class kinds and permitted values\n');
    expect(m.packet_sha).toBe(twoPartSha(m.agent_sha!, packet));
    expect(existsSync(join(agentsDir(), 'edge-rule-pair-debater.md'))).toBe(true);
    // The CR text that the deriver sees includes all CR text of the single-part packet.
    const row = db.prepare('SELECT refs_json FROM edge_rule_batches WHERE set_id = ? AND batch_key = ?').get(setId, `${demand}-0`) as { refs_json: string };
    const ctx = packetContext(db, { corpusId: corpus });
    const single = planPairPackets(db, ctx, split(demand!), [supply!]);
    expect(single).toHaveLength(1);
    expect(JSON.parse(row.refs_json)).toEqual(expect.arrayContaining(single[0]!.refs));
    // The submit refuses passes when the agent file changed after the prepare.
    respond(setId, 'pairs', `${demand}-0`, [1, 2, 3].map(() => ({ rules: [], missing_rules: [] })));
    writeFileSync(agentFile, agentText + 'changed\n');
    expect(() => submitStage(db, setId, 'pairs')).toThrow(/changed after the prepare/);
    writeFileSync(agentFile, agentText);
    expect(submitStage(db, setId, 'pairs').batches).toBe(1);

    decideRole(db, setId, { ...split(lateSupply!), pass_index: 2, note: 'a late supply type' });
    decideRole(db, setId, { ...split(later!), pass_index: 1, note: 'the owner adopts pass 1' });
    const second = preparePairs(db, setId);
    expect(second).toMatchObject({ batches: 2, skipped: [] });
    const manifests = second.dirs.filter((d) => d.endsWith('pass-1')).map((d) => JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8')) as RuleManifest);
    // The old demand type gets a supplementary batch with only the new supply candidate.
    expect(manifests.find((m) => m.demand === demand)).toMatchObject({ batch_key: `${demand}-1`, types: [demand, lateSupply] });
    expect(manifests.find((m) => m.demand === later)!.types).toEqual(expect.arrayContaining([supply, lateSupply]));
    expect(preparePairs(db, setId)).toMatchObject({ batches: 0, skipped: expect.arrayContaining([demand, later]) });

    // spec sec. 25.5: a new param on a supply type shows the candidate again, for the named demand only.
    expect(() => preparePairs(db, setId, {}, undefined, new Set([supply!]))).toThrow(/needs --demand/);
    expect(() => preparePairs(db, setId, {}, new Set([demand!]), new Set([demand!]))).toThrow(/not a supply candidate/);
    const again = preparePairs(db, setId, {}, new Set([demand!]), new Set([supply!]));
    expect(again).toMatchObject({ batches: 1, skipped: [] });
    const repeat = JSON.parse(readFileSync(join(again.dirs[0]!, 'manifest.json'), 'utf8')) as RuleManifest;
    expect(repeat).toMatchObject({ demand, batch_key: `${demand}-2`, types: [demand, supply] });
  }, 120_000);
});
