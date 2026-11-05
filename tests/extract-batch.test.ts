import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/client.js';
import { persistAtomSchema } from '../src/atoms/schema.js';
import { redactWithMap, type CardRequest } from '../src/atoms/extract.js';
import { prepareRun, submitBatch, runStatus, prepareEscalation, finaliseRun, type BatchManifest } from '../src/atoms/extractBatch.js';
import type { PacketSection } from '../src/rules/packet.js';
import type { PacketPolicy } from '../src/rules/relevance.js';

const POLICY: PacketPolicy = { crossref_depth: 1, min_term_length: 3, strip_suffixes: [] };

const CARDS = [
  { id: 'a', name: 'Grim Reaper', text: 'Whenever a creature you control dies, Grim Reaper deals 1 damage.' },
  { id: 'b', name: 'Bookworm', text: 'Draw a card.' },
  { id: 'c', name: 'Lone Wolf', text: 'Draw a card. Then draw a card.' },
];
const NAMES = CARDS.map((c) => c.name);

const KERNEL: PacketSection = { number: '700', title: 'General', rules: [{ number: '700.1', text: 'Kernel text.' }], chars: 20 };
const SHARED: PacketSection = { number: '121', title: 'Drawing a Card', rules: [{ number: '121.1', text: 'Draw text.' }], chars: 20 };
const DEATH: PacketSection = { number: '603', title: 'Triggers', rules: [{ number: '603.1', text: 'Trigger text.' }], chars: 20 };

/** Stand-in for buildCardRequest: the real one needs a parsed corpus, kernel and term index. */
function stubBuild(db: DatabaseSync, oracleId: string, _p: PacketPolicy, names: readonly string[]): CardRequest {
  const card = CARDS.find((c) => c.id === oracleId)!;
  const sections = oracleId === 'a' ? [DEATH] : [SHARED];
  const red = redactWithMap(card.text, names);
  return {
    oracleId, schemaVersion: 1, layout: 'normal',
    kernelSections: [KERNEL], cardSections: sections, glossary: ['Dies: put into a graveyard'],
    faces: [`### Face 0\nType line: Creature\nRules text:\n${red.text}`],
    packetRules: ['700', '700.1', ...sections.flatMap((s) => [s.number, ...s.rules.map((r) => r.number)])],
    packetChars: 40, names, redactions: [{ face_index: 0, redactions: red.redactions }],
  };
}

function fixture() {
  const db = openDb(':memory:');
  persistAtomSchema(db, {
    schema_version: 1,
    types: [
      { family: 'CARES_ABOUT', type_key: 'CREATURE_DEATH', label: 'x',
        params_schema: { type: 'object', properties: { controller: { enum: ['you', 'opponent', 'any'] } },
                         required: ['controller'], additionalProperties: false },
        provenance: 'spec_4_1', evidence: 'test' },
      { family: 'PRODUCES', type_key: 'CARD_DRAW', label: 'x',
        params_schema: { type: 'object', properties: {}, additionalProperties: false },
        provenance: 'spec_4_1', evidence: 'test' },
    ],
  });
  db.exec("INSERT INTO snapshots (source_type,source_uri,source_updated_at,ingested_at,status) VALUES ('t','u','t','t','complete')");
  db.exec("INSERT INTO rules_corpus (source_uri,effective_date,sha256,fetched_at,section_count,rule_count,glossary_count,is_current) VALUES ('u','d','s','t',1,1,1,1)");
  for (const c of CARDS) {
    db.prepare(`INSERT INTO cards (oracle_id,name,layout,cmc,type_line,colors,color_identity,keywords,rarity,set_code,collector_number,oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id)
             VALUES (?,?,'normal',1,'Creature','[]','[]','[]','c','s','1',?,1,1)`).run(c.id, c.name, `h-${c.id}`);
    db.prepare('INSERT INTO card_faces (oracle_id,face_index,name,type_line,oracle_text,colors) VALUES (?,?,?,?,?,?)')
      .run(c.id, 0, c.name, 'Creature', c.text, '[]');
    db.prepare("INSERT INTO extraction_queue (oracle_id, reason, enqueued_at) VALUES (?,'new_card','t')").run(c.id);
  }
  return db;
}

let dir: string;
let db: DatabaseSync;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'extract-batches-'));
  process.env['EXTRACT_BATCHES_DIR'] = dir;
  db = fixture();
});
afterEach(() => {
  delete process.env['EXTRACT_BATCHES_DIR'];
  rmSync(dir, { recursive: true, force: true });
});

const prepare = (over: Partial<Parameters<typeof prepareRun>[1]> = {}) =>
  prepareRun(db, {
    batchKind: 'full', oracleIds: ['a', 'b', 'c'], size: 25, model: 'test-model', policy: POLICY,
    names: NAMES, build: stubBuild, ...over,
  });

const manifestOf = (batchDir: string) =>
  JSON.parse(readFileSync(join(batchDir, 'manifest.json'), 'utf8')) as BatchManifest;
const packetOf = (batchDir: string) => readFileSync(join(batchDir, 'packet.md'), 'utf8');
const respond = (batchDir: string, body: unknown) =>
  writeFileSync(join(batchDir, 'response.json'), typeof body === 'string' ? body : JSON.stringify(body));

const deathAtom = (over = {}) => ({
  face_index: 0, family: 'CARES_ABOUT', type_key: 'CREATURE_DEATH', params: { controller: 'you' },
  source: 'oracle_text', quote: 'Whenever a creature you control dies', rule_numbers: ['603.1'], confidence: 0.9, ...over,
});
const drawAtom = (over = {}) => ({
  face_index: 0, family: 'PRODUCES', type_key: 'CARD_DRAW', params: {},
  source: 'oracle_text', quote: 'Draw a card', rule_numbers: ['121.1'], confidence: 0.9, ...over,
});

describe('prepareRun', () => {
  it('creates one in-progress run row recording the extractor and the pinned inputs', () => {
    const { runId } = prepare();
    expect(db.prepare('SELECT * FROM extraction_runs WHERE id = ?').get(runId)).toMatchObject({
      provider: 'claude-code-subagent', model: 'test-model', schema_version: 1, batch_kind: 'full',
      status: 'in_progress',
    });
  });

  it('splits the cards into batches of the requested size', () => {
    const { batches } = prepare({ size: 2 });
    expect(batches).toHaveLength(2);
    expect(manifestOf(batches[0]!).cards.map((c) => c.oracle_id)).toEqual(['a', 'b']);
    expect(manifestOf(batches[1]!).cards.map((c) => c.oracle_id)).toEqual(['c']);
  });

  it('shows the subagent no card name and no oracle_id - only opaque keys', () => {
    const { batches } = prepare();
    const packet = packetOf(batches[0]!);
    for (const c of CARDS) expect(packet).not.toContain(c.name);
    expect(packet).not.toMatch(/oracle_id|h-a|h-b/);
    expect(packet).toContain('## C01');
    expect(packet).toContain('## C03');
    expect(manifestOf(batches[0]!).cards.map((c) => c.key)).toEqual(['C01', 'C02', 'C03']);
  });

  it('renders the kernel once and each shared section once, however many cards use it', () => {
    const packet = packetOf(prepare().batches[0]!);
    expect(packet.split('121.1 Draw text.')).toHaveLength(2);    // b and c share it
    expect(packet.split('700.1 Kernel text.')).toHaveLength(2);
  });

  it('tells each card which sections it may cite beyond the kernel', () => {
    const packet = packetOf(prepare().batches[0]!);
    const c01 = packet.slice(packet.indexOf('## C01'), packet.indexOf('## C02'));
    expect(c01).toMatch(/may also cite[^\n]*603/i);
    expect(c01).not.toMatch(/may also cite[^\n]*121/i);
  });

  it('records each card\'s own whitelist and the batch union in the manifest', () => {
    const m = manifestOf(prepare().batches[0]!);
    expect(m.cards[0]!.packet_rules).toContain('603.1');
    expect(m.cards[0]!.packet_rules).not.toContain('121.1');
    expect(m.batch_rules).toEqual(expect.arrayContaining(['603.1', '121.1', '700.1']));
  });

  it('writes the clause split each card will be measured against', () => {
    prepare();
    expect((db.prepare('SELECT COUNT(*) n FROM clauses').get() as { n: number }).n).toBeGreaterThan(0);
  });
});

describe('submitBatch', () => {
  it('validates each card against its own packet and persists what passes', () => {
    const { batches, runId } = prepare();
    respond(batches[0]!, { cards: {
      C01: { atoms: [deathAtom()] },
      C02: { atoms: [drawAtom()] },
      C03: { atoms: [drawAtom(), drawAtom()] },
    } });
    const s = submitBatch(db, batches[0]!);
    expect(s).toMatchObject({ extracted: 3, failed: 0, atoms: 4 });
    expect((db.prepare('SELECT COUNT(*) n FROM atoms WHERE run_id = ?').get(runId) as { n: number }).n).toBe(4);
  });

  it('maps quotes back to the real text - the stored quote names the card, the response did not', () => {
    const { batches } = prepare();
    respond(batches[0]!, { cards: {
      C01: { atoms: [deathAtom({ quote: '~ deals 1 damage' })] }, C02: { atoms: [] }, C03: { atoms: [] },
    } });
    submitBatch(db, batches[0]!);
    expect(db.prepare("SELECT quote FROM atoms WHERE oracle_id = 'a'").get()).toMatchObject({ quote: 'Grim Reaper deals 1 damage' });
  });

  it('rejects a citation read off another card\'s sections as cross_card_citation', () => {
    const { batches } = prepare();
    respond(batches[0]!, { cards: {
      C01: { atoms: [deathAtom({ rule_numbers: ['121.1'] })] }, C02: { atoms: [] }, C03: { atoms: [] },
    } });
    const s = submitBatch(db, batches[0]!);
    expect(s.atoms).toBe(0);
    expect(s.rejectedBy).toEqual({ cross_card_citation: 1 });
  });

  it('still calls a citation that was never shown at all a plain citation failure', () => {
    const { batches } = prepare();
    respond(batches[0]!, { cards: {
      C01: { atoms: [deathAtom({ rule_numbers: ['999.9'] })] }, C02: { atoms: [] }, C03: { atoms: [] },
    } });
    expect(submitBatch(db, batches[0]!).rejectedBy).toEqual({ citation: 1 });
  });

  it('marks extracted cards done in the queue for a batch that consumes it', () => {
    const { batches } = prepare();
    respond(batches[0]!, { cards: { C01: { atoms: [] }, C02: { atoms: [] }, C03: { atoms: [] } } });
    submitBatch(db, batches[0]!);
    expect((db.prepare("SELECT COUNT(*) n FROM extraction_queue WHERE status = 'pending'").get() as { n: number }).n).toBe(0);
  });

  it('marks extracted cards done for a colour-slice batch, which is production extraction (Task 12a)', () => {
    const { batches, runId } = prepare({ batchKind: 'colors' });
    expect(manifestOf(batches[0]!).consume_queue).toBe(true);
    expect(db.prepare('SELECT batch_kind FROM extraction_runs WHERE id = ?').get(runId)).toMatchObject({ batch_kind: 'colors' });
    respond(batches[0]!, { cards: { C01: { atoms: [] }, C02: { atoms: [] }, C03: { atoms: [] } } });
    submitBatch(db, batches[0]!);
    expect((db.prepare("SELECT COUNT(*) n FROM extraction_queue WHERE status = 'pending'").get() as { n: number }).n).toBe(0);
  });

  it('marks extracted cards done for a requeue batch, which drains the rows review actions add (Task 12a)', () => {
    db.prepare("UPDATE extraction_queue SET reason = 'kernel_changed'").run();
    const { batches } = prepare({ batchKind: 'requeue' });
    expect(manifestOf(batches[0]!).consume_queue).toBe(true);
    respond(batches[0]!, { cards: { C01: { atoms: [] }, C02: { atoms: [] }, C03: { atoms: [] } } });
    submitBatch(db, batches[0]!);
    expect((db.prepare("SELECT COUNT(*) n FROM extraction_queue WHERE status = 'pending'").get() as { n: number }).n).toBe(0);
  });

  it('leaves the production queue alone for a golden batch', () => {
    const { batches } = prepare({ batchKind: 'golden' });
    respond(batches[0]!, { cards: { C01: { atoms: [] }, C02: { atoms: [] }, C03: { atoms: [] } } });
    submitBatch(db, batches[0]!);
    expect((db.prepare("SELECT COUNT(*) n FROM extraction_queue WHERE status = 'pending'").get() as { n: number }).n).toBe(3);
  });

  it('fails a card missing from the response and leaves it pending, without failing the others', () => {
    const { batches, runId } = prepare();
    respond(batches[0]!, { cards: { C01: { atoms: [] }, C03: { atoms: [] } } });
    const s = submitBatch(db, batches[0]!);
    expect(s).toMatchObject({ extracted: 2, failed: 1 });
    expect(db.prepare('SELECT outcome, failure_detail FROM extraction_results WHERE run_id = ? AND oracle_id = ?').get(runId, 'b'))
      .toMatchObject({ outcome: 'failed', failure_detail: expect.stringMatching(/C02/) });
    expect(db.prepare("SELECT status FROM extraction_queue WHERE oracle_id = 'b'").get()).toMatchObject({ status: 'pending' });
  });

  it('fails every card of an unparseable response, keeping the raw text for diagnosis', () => {
    const { batches } = prepare();
    respond(batches[0]!, '{"cards": { "C01": ');
    const s = submitBatch(db, batches[0]!);
    expect(s).toMatchObject({ extracted: 0, failed: 3 });
    expect(db.prepare("SELECT failure_detail FROM extraction_results WHERE oracle_id = 'a'").get())
      .toMatchObject({ failure_detail: expect.stringMatching(/not valid JSON[\s\S]*"C01"/) });
  });

  it('fails a card whose oracle text changed after its packet was written', () => {
    const { batches } = prepare();
    db.exec("UPDATE cards SET oracle_hash = 'changed' WHERE oracle_id = 'a'");
    respond(batches[0]!, { cards: { C01: { atoms: [deathAtom()] }, C02: { atoms: [] }, C03: { atoms: [] } } });
    const s = submitBatch(db, batches[0]!);
    expect(s.failures).toEqual([expect.objectContaining({ key: 'C01', reason: expect.stringMatching(/oracle text changed/) })]);
  });

  it('refuses to submit a batch twice, so atoms are never duplicated', () => {
    const { batches } = prepare();
    respond(batches[0]!, { cards: { C01: { atoms: [deathAtom()] }, C02: { atoms: [] }, C03: { atoms: [] } } });
    submitBatch(db, batches[0]!);
    expect(() => submitBatch(db, batches[0]!)).toThrow(/already submitted/);
    expect((db.prepare('SELECT COUNT(*) n FROM atoms').get() as { n: number }).n).toBe(1);
  });

  it('refuses a batch with no response yet', () => {
    const { batches } = prepare();
    expect(() => submitBatch(db, batches[0]!)).toThrow(/no response\.json/);
  });

  it('refuses when the redaction list changed since the packet was written', () => {
    const { batches } = prepare();
    respond(batches[0]!, { cards: { C01: { atoms: [] }, C02: { atoms: [] }, C03: { atoms: [] } } });
    expect(() => submitBatch(db, batches[0]!, { names: [...NAMES, 'Newcomer'] })).toThrow(/redaction list changed/);
  });

  it('completes the run once its last batch is submitted', () => {
    const { batches, runId } = prepare({ size: 2 });
    respond(batches[0]!, { cards: { C01: { atoms: [] }, C02: { atoms: [] } } });
    expect(submitBatch(db, batches[0]!).runComplete).toBe(false);
    respond(batches[1]!, { cards: { C01: { atoms: [] } } });
    expect(submitBatch(db, batches[1]!).runComplete).toBe(true);
    expect(db.prepare('SELECT status, cards_attempted FROM extraction_runs WHERE id = ?').get(runId))
      .toMatchObject({ status: 'complete', cards_attempted: 3 });
    expect(existsSync(join(batches[1]!, 'submitted.json'))).toBe(true);
  });
});

describe('runStatus', () => {
  it('reports each batch as prepared, responded or submitted', () => {
    const { batches, runId } = prepare({ size: 1 });
    respond(batches[1]!, { cards: { C01: { atoms: [] } } });
    respond(batches[2]!, { cards: { C01: { atoms: [] } } });
    submitBatch(db, batches[2]!);
    const st = runStatus(runId);
    expect(st.batches.map((b) => b.state)).toEqual(['prepared', 'responded', 'submitted']);
  });
});

// ---------- Task 9: verdicts, findings, currency and voting through the batch protocol ----------

const full = () => ({ cards: {
  C01: { atoms: [deathAtom(), deathAtom({ quote: '~ deals 1 damage' })] },
  C02: { atoms: [drawAtom()] },
  C03: { atoms: [drawAtom(), drawAtom({ quote: 'Then draw a card' })] },
} as Record<string, { atoms: unknown[] }> });
const ESCALATE_ALL = { passes: 3, max_counted_clauses: 0, max_oracle_chars: 1000 };

describe('submitBatch - verdicts and the review queue', () => {
  it('finalises every card it extracts and enqueues the findings', () => {
    const { batches, runId } = prepare();
    respond(batches[0]!, { cards: { C01: { atoms: [] }, C02: { atoms: [drawAtom()] }, C03: { atoms: [drawAtom()] } } });
    const s = submitBatch(db, batches[0]!);
    expect(s.outcomes).toEqual({ passed: 1, flagged: 2 });
    expect(db.prepare('SELECT oracle_id, outcome, packet_chars FROM extraction_results WHERE run_id = ? ORDER BY oracle_id').all(runId))
      .toEqual([
        { oracle_id: 'a', outcome: 'flagged', packet_chars: 40 },
        { oracle_id: 'b', outcome: 'passed', packet_chars: 40 },
        { oracle_id: 'c', outcome: 'flagged', packet_chars: 40 },
      ]);
    expect(db.prepare('SELECT oracle_id, severity FROM review_queue ORDER BY oracle_id').all())
      .toEqual([{ oracle_id: 'a', severity: 'coverage_miss' }, { oracle_id: 'c', severity: 'coverage_miss' }]);
    expect(db.prepare('SELECT cards_passed FROM extraction_runs WHERE id = ?').get(runId)).toEqual({ cards_passed: 1 });
  });

  it("a second run replaces the first run's live atoms instead of stacking a second set", () => {
    const one = prepare();
    respond(one.batches[0]!, full());
    submitBatch(db, one.batches[0]!);
    const two = prepare({ batchKind: 'golden' });
    respond(two.batches[0]!, full());
    submitBatch(db, two.batches[0]!);
    expect(db.prepare('SELECT run_id, COUNT(*) n FROM atoms WHERE is_current = 1 GROUP BY run_id').all())
      .toEqual([{ run_id: two.runId, n: 5 }]);
  });

  it("records the kernel in the run's policy hash, so promoting a rule changes it", () => {
    const before = db.prepare('SELECT packet_policy_sha s FROM extraction_runs WHERE id = ?').get(prepare().runId) as { s: string };
    db.exec("INSERT INTO rules (corpus_id, number, section_number, subsection_number, text, ordinal) VALUES (1,'704.5f','704','704.5','t',0)");
    db.exec("INSERT INTO packet_kernel (corpus_id, rule_number, origin, evidence) VALUES (1,'704.5f','review_promoted','e')");
    const after = db.prepare('SELECT packet_policy_sha s FROM extraction_runs WHERE id = ?').get(prepare().runId) as { s: string };
    expect(after.s).not.toBe(before.s);
  });
});

describe('prepareEscalation and voting passes', () => {
  function firstPass() {
    const r = prepare();
    respond(r.batches[0]!, full());
    submitBatch(db, r.batches[0]!);
    return r;
  }
  const escalate = (runId: number, config = ESCALATE_ALL) =>
    prepareEscalation(db, runId, { policy: POLICY, names: NAMES, build: stubBuild, config });

  it('writes one batch set per voting pass, as new batches of the same run', () => {
    const { runId } = firstPass();
    const plan = escalate(runId);
    expect([...plan.cards].sort()).toEqual(['a', 'b', 'c']);
    expect(plan.batches.map((b) => manifestOf(b).pass_index)).toEqual([1, 2]);
    expect(plan.batches.map((b) => b.slice(-9))).toEqual(['batch-002', 'batch-003']);
    expect(manifestOf(plan.batches[0]!).consume_queue).toBe(false);
    expect(db.prepare('SELECT status FROM extraction_runs WHERE id = ?').get(runId)).toEqual({ status: 'in_progress' });
  });

  it('escalates nothing a single clean pass already settles', () => {
    const { runId } = firstPass();
    expect(prepareEscalation(db, runId, { policy: POLICY, names: NAMES, build: stubBuild }).batches).toEqual([]);
  });

  it('forceCards writes the voting passes for the named cards that shouldEscalate does not pick (plan Task 8)', () => {
    const { runId } = firstPass();
    const force = () => prepareEscalation(db, runId, { policy: POLICY, names: NAMES, build: stubBuild, forceCards: ['b', 'zz'] });
    const plan = force();
    expect(plan.cards).toEqual(['b']);                          // 'zz' has no first pass in this run
    expect(plan.batches.map((b) => manifestOf(b).pass_index)).toEqual([1, 2]);
    expect(plan.batches.map((b) => manifestOf(b).cards.map((c) => c.oracle_id))).toEqual([['b'], ['b']]);
    expect(force().batches).toEqual([]);                        // the passes are already requested
  });

  it("reconciles the votes when a card's last pass lands, and flags a dissent", () => {
    const { runId } = firstPass();
    const [p1, p2] = escalate(runId).batches;
    respond(p1!, full());
    expect(submitBatch(db, p1!)).toMatchObject({ passIndex: 1, voted: 0, findings: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM atoms WHERE pass_index = 1 AND is_current = 1').get()).toEqual({ n: 0 });

    const dissent = full();
    dissent.cards['C02'] = { atoms: [] };                      // pass 2 misses b's draw
    respond(p2!, dissent);
    expect(submitBatch(db, p2!)).toMatchObject({ passIndex: 2, voted: 3, outcomes: { passed: 2, flagged: 1 } });
    expect(db.prepare('SELECT oracle_id, passes_run, vote_agreement, outcome FROM extraction_results WHERE run_id = ? ORDER BY oracle_id').all(runId))
      .toEqual([
        { oracle_id: 'a', passes_run: 3, vote_agreement: 1, outcome: 'passed' },
        { oracle_id: 'b', passes_run: 3, vote_agreement: 2 / 3, outcome: 'flagged' },
        { oracle_id: 'c', passes_run: 3, vote_agreement: 1, outcome: 'passed' },
      ]);
    expect(db.prepare("SELECT oracle_id FROM review_queue WHERE severity = 'vote_disagreement'").all()).toEqual([{ oracle_id: 'b' }]);
    // one current instance per consensus cluster, from the first pass
    expect(db.prepare("SELECT pass_index, COUNT(*) n FROM atoms WHERE run_id = ? AND is_current = 1 AND confidence_source = 'vote' GROUP BY pass_index").all(runId))
      .toEqual([{ pass_index: 0, n: 5 }]);
    expect(db.prepare('SELECT status, cards_attempted FROM extraction_runs WHERE id = ?').get(runId))
      .toEqual({ status: 'complete', cards_attempted: 3 });
    expect(escalate(runId).batches).toEqual([]);
  });

  it('a failed voting pass keeps the first-pass verdict and is written again on the next escalate', () => {
    const { runId } = firstPass();
    const [p1] = escalate(runId).batches;
    respond(p1!, '{ not json');
    expect(submitBatch(db, p1!).failed).toBe(3);
    expect(db.prepare("SELECT COUNT(*) n FROM extraction_results WHERE outcome = 'failed'").get()).toEqual({ n: 0 });
    expect(escalate(runId).batches.map((b) => manifestOf(b).pass_index)).toEqual([1]);   // pass 2 is still waiting
  });
});

describe('finaliseRun', () => {
  it('backfills verdicts and findings for a run submitted before Task 9, and is safe to repeat', () => {
    const { batches, runId } = prepare();
    respond(batches[0]!, { cards: { C01: { atoms: [] }, C02: { atoms: [drawAtom()] }, C03: { atoms: [drawAtom()] } } });
    submitBatch(db, batches[0]!);
    db.exec('DELETE FROM extraction_results; DELETE FROM review_queue');
    expect(finaliseRun(db, runId)).toEqual({ passed: 1, flagged: 2, failed: 0, findings: 2 });
    expect(finaliseRun(db, runId)).toEqual({ passed: 1, flagged: 2, failed: 0, findings: 0 });
  });
});
