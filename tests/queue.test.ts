import { describe, it, expect } from 'vitest';
import {
  SEVERITY_RANK, enqueueFindings, listFindings, acceptAsCorrect, recordCorrection, promoteAtomType,
  acceptMissingRule, acceptSplitterDisagreement, cardsReachedByKernelRule, ReviewError,
  degreeRankScore, rerankAtomQueue,
} from '../src/atoms/queue.js';
import { finaliseCard, reconcileSplitterVersion } from '../src/atoms/verify.js';
import { packetPolicyShaWithKernel } from '../src/rules/kernel.js';
import type { PacketPolicy } from '../src/rules/relevance.js';
import { fixtureWithClauses, insertAtom, coverAbilities, addRun } from './helpers/fixture.js';

type Db = ReturnType<typeof fixtureWithClauses>;
const POLICY: PacketPolicy = { crossref_depth: 1, min_term_length: 3, strip_suffixes: [] };
const n = (db: Db, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...(args as never[])) as { n: number }).n;
const queueRows = (db: Db) => db.prepare('SELECT oracle_id, reason, status FROM extraction_queue ORDER BY id').all();

describe('review queue', () => {
  const enqueue = (db: any, over: Record<string, unknown> = {}) =>
    db.prepare(
      `INSERT INTO review_queue (oracle_id, run_id, severity, severity_rank, rank_score, detail_table, detail_id, enqueued_at)
       VALUES (@oracle_id, 1, @severity, @severity_rank, @rank_score, @detail_table, @detail_id, 't')`,
    ).run({ oracle_id: 'o', severity: 'coverage_miss', severity_rank: 1, rank_score: 0,
            detail_table: 'extraction_results', detail_id: 1, ...over });

  it('records several findings for one card without collision', () => {
    const db = fixtureWithClauses('Draw a card.');
    enqueue(db, { severity: 'coverage_miss', severity_rank: 1, detail_id: 1 });
    enqueue(db, { severity: 'splitter_disagreement', severity_rank: 5, detail_table: 'splitter_disagreements', detail_id: 1 });
    enqueue(db, { severity: 'missing_rule', severity_rank: 2, detail_table: 'missing_rule_reports', detail_id: 1 });
    expect((db.prepare('SELECT COUNT(*) n FROM review_queue').get() as any).n).toBe(3);
  });

  it('orders coverage_miss before missing_rule before splitter_disagreement', () => {
    const db = fixtureWithClauses('Draw a card.');
    enqueue(db, { severity: 'splitter_disagreement', severity_rank: 5, detail_id: 1 });
    enqueue(db, { severity: 'missing_rule', severity_rank: 2, detail_id: 2 });
    enqueue(db, { severity: 'coverage_miss', severity_rank: 1, detail_id: 3 });
    const order = (db.prepare(
      'SELECT severity FROM review_queue ORDER BY severity_rank, rank_score DESC',
    ).all() as Array<{ severity: string }>).map((r) => r.severity);
    expect(order).toEqual(['coverage_miss', 'missing_rule', 'splitter_disagreement']);
    expect(listFindings(db).map((f) => f.severity)).toEqual(['coverage_miss', 'missing_rule', 'splitter_disagreement']);
  });

  it('does NOT order by the severity label, which sorts wrong', () => {
    // Alphabetical gives coverage_miss -> missing_rule -> splitter_disagreement -> unclassified ->
    // vote_disagreement, demoting vote_disagreement (rank 3) below the rank-5 bucket.
    const labels = Object.keys(SEVERITY_RANK);
    expect([...labels].sort()).not.toEqual(labels);
    expect(Object.values(SEVERITY_RANK)).toEqual([1, 2, 3, 4, 5]);
  });

  it('orders by connective-atom count within a severity bucket', () => {
    const db = fixtureWithClauses('Draw a card.');
    enqueue(db, { rank_score: 2, detail_id: 1 });
    enqueue(db, { rank_score: 9, detail_id: 2 });
    const scores = (db.prepare(
      'SELECT rank_score FROM review_queue ORDER BY severity_rank, rank_score DESC',
    ).all() as Array<{ rank_score: number }>).map((r) => r.rank_score);
    expect(scores).toEqual([9, 2]);
    expect(listFindings(db).map((f) => f.rank_score)).toEqual([9, 2]);
  });

  it('deep-links each finding via detail_table and detail_id', () => {
    const db = fixtureWithClauses('Draw a card.');
    enqueue(db, { severity: 'missing_rule', severity_rank: 2, detail_table: 'missing_rule_reports', detail_id: 42 });
    const row = db.prepare('SELECT detail_table, detail_id FROM review_queue').get() as any;
    expect(row).toEqual({ detail_table: 'missing_rule_reports', detail_id: 42 });
  });
});

describe('enqueueFindings', () => {
  /** Clause 0 covered, clause 1 unclassified (which counts as covered), clause 2 uncovered. */
  function flaggedCard(): Db {
    const db = fixtureWithClauses('Draw a card. You gain 2 life. Scry 1.');
    insertAtom(db, { span_start: 0, span_end: 12 });          // covers clause 0 only
    db.exec(`INSERT INTO missing_rule_reports (run_id, oracle_id, face_index, quote, statement, oracle_hash)
             VALUES (1,'o',0,'You gain 2 life','no rule for life gain supplied','h')`);
    db.exec(`INSERT INTO unclassified_clauses (run_id, oracle_id, face_index, span_start, span_end, quote, proposed_label, rationale, oracle_hash)
             VALUES (1,'o',0,13,28,'You gain 2 life','LIFE_THING','none fits','h')`);
    db.exec(`INSERT INTO splitter_disagreements (run_id, oracle_id, face_index, quote, note, splitter_version)
             VALUES (1,'o',0,'You gain 2 life. Scry 1.','one sentence',1)`);
    finaliseCard(db, 1, 'o');
    return db;
  }

  it('writes one row per finding, ranked by severity and carrying the connective count', () => {
    const db = flaggedCard();
    expect(enqueueFindings(db, 1, 'o')).toBe(4);
    expect(db.prepare('SELECT severity, severity_rank, rank_score, detail_table FROM review_queue ORDER BY severity_rank').all()).toEqual([
      { severity: 'coverage_miss', severity_rank: 1, rank_score: 1, detail_table: 'extraction_results' },
      { severity: 'missing_rule', severity_rank: 2, rank_score: 1, detail_table: 'missing_rule_reports' },
      { severity: 'unclassified', severity_rank: 4, rank_score: 1, detail_table: 'unclassified_clauses' },
      { severity: 'splitter_disagreement', severity_rank: 5, rank_score: 1, detail_table: 'splitter_disagreements' },
    ]);
  });

  it('is idempotent', () => {
    const db = flaggedCard();
    enqueueFindings(db, 1, 'o');
    expect(enqueueFindings(db, 1, 'o')).toBe(0);
  });

  it('enqueues nothing for a clean pass', () => {
    const db = fixtureWithClauses('Draw a card.');
    coverAbilities(db);
    finaliseCard(db, 1, 'o');
    expect(enqueueFindings(db, 1, 'o')).toBe(0);
  });

  it('enqueues a vote disagreement for a voted card some pass dissented from', () => {
    const db = fixtureWithClauses('Draw a card.');
    insertAtom(db, { pass_index: 0 });
    insertAtom(db, { pass_index: 1 });
    insertAtom(db, { pass_index: 2, family: 'PRODUCES', type_key: 'LIFEGAIN' });
    finaliseCard(db, 1, 'o');
    enqueueFindings(db, 1, 'o');
    expect(db.prepare('SELECT severity, severity_rank FROM review_queue').all())
      .toEqual([{ severity: 'vote_disagreement', severity_rank: 3 }]);
  });

  it('resolves the card\'s findings from older runs, and a superseded run enqueues nothing', () => {
    const db = flaggedCard();
    enqueueFindings(db, 1, 'o');
    const two = addRun(db);
    insertAtom(db, { run_id: two, span_start: 0, span_end: 12 });
    finaliseCard(db, two, 'o');
    expect(enqueueFindings(db, two, 'o')).toBe(1);             // its own coverage miss
    expect(n(db, "SELECT COUNT(*) n FROM review_queue WHERE run_id = 1 AND status = 'pending'")).toBe(0);
    db.exec('DELETE FROM review_queue WHERE run_id = 1');
    expect(enqueueFindings(db, 1, 'o')).toBe(0);
  });

  it('retires a pass-0 coverage miss once the same run\'s voted verdict covers the card (ruling R13-2)', () => {
    const db = fixtureWithClauses('Draw a card. You gain 2 life.');
    insertAtom(db, { span_start: 0, span_end: 12 });            // pass 0 misses clause 1
    finaliseCard(db, 1, 'o');
    expect(enqueueFindings(db, 1, 'o')).toBe(1);
    expect(listFindings(db).map((f) => f.severity)).toEqual(['coverage_miss']);
    // The vote: passes 1 and 2 cover both clauses, so the verdict reaches coverage 1.
    for (const pass_index of [1, 2]) {
      insertAtom(db, { pass_index, span_start: 0, span_end: 12 });
      insertAtom(db, { pass_index, family: 'PRODUCES', type_key: 'LIFEGAIN', span_start: 13, span_end: 29 });
    }
    insertAtom(db, { pass_index: 0, family: 'PRODUCES', type_key: 'LIFEGAIN', span_start: 13, span_end: 29 });
    finaliseCard(db, 1, 'o', { passesRun: 3 });
    expect(n(db, "SELECT COUNT(*) n FROM extraction_results WHERE coverage_ratio = 1")).toBe(1);
    enqueueFindings(db, 1, 'o');
    expect(listFindings(db)).toEqual([]);
    expect(n(db, "SELECT COUNT(*) n FROM review_queue WHERE severity = 'coverage_miss' AND status = 'resolved'")).toBe(1);
  });

  it('keeps a coverage miss the later verdict still carries, and never touches other severities', () => {
    const db = flaggedCard();
    enqueueFindings(db, 1, 'o');
    finaliseCard(db, 1, 'o');
    enqueueFindings(db, 1, 'o');
    expect(listFindings(db).map((f) => f.severity))
      .toEqual(['coverage_miss', 'missing_rule', 'unclassified', 'splitter_disagreement']);
  });

  it('describes each finding with a summary and the spans to outline', () => {
    const db = flaggedCard();
    enqueueFindings(db, 1, 'o');
    const [miss, , unclassified] = listFindings(db);
    expect(miss!.summary).toMatch(/1 clause with no atom/);
    expect(miss!.focus).toEqual([{ face_index: 0, span_start: 30, span_end: 37 }]);
    expect(unclassified!.focus).toEqual([{ face_index: 0, span_start: 13, span_end: 28 }]);
    expect(unclassified!.detail).toMatchObject({ proposed_label: 'LIFE_THING' });
  });
});

describe('acceptAsCorrect', () => {
  it('resolves the finding and closes the report behind it', () => {
    const db = fixtureWithClauses('Draw a card.');
    coverAbilities(db);
    db.exec(`INSERT INTO missing_rule_reports (run_id, oracle_id, face_index, quote, statement, oracle_hash)
             VALUES (1,'o',0,'Draw a card','?','h')`);
    finaliseCard(db, 1, 'o');
    enqueueFindings(db, 1, 'o');
    const [f] = listFindings(db);
    acceptAsCorrect(db, f!.id);
    expect(listFindings(db)).toEqual([]);
    expect(db.prepare('SELECT status FROM missing_rule_reports').get()).toEqual({ status: 'rejected' });
    expect(() => acceptAsCorrect(db, f!.id)).toThrow(/already resolved/);
  });
});

describe('recordCorrection (sec. 7.5)', () => {
  const fix = { face_index: 0, family: 'PRODUCES', type_key: 'LIFEGAIN', params: {}, quote: 'You gain 2 life', rule_numbers: ['119.1'] };

  it('writes a review_correction golden atom on a partial golden record', () => {
    const db = fixtureWithClauses('Draw a card. You gain 2 life.');
    recordCorrection(db, 'o', fix);
    expect(db.prepare('SELECT complete FROM golden_cards').get()).toEqual({ complete: 0 });
    expect(db.prepare('SELECT source, span_start, span_end, family, type_key FROM golden_atoms').get())
      .toEqual({ source: 'review_correction', span_start: 13, span_end: 28, family: 'PRODUCES', type_key: 'LIFEGAIN' });
  });

  it('refuses a quote that is not verbatim, an unknown type, or a rule the corpus lacks', () => {
    const db = fixtureWithClauses('Draw a card. You gain 2 life.');
    expect(() => recordCorrection(db, 'o', { ...fix, quote: 'you gain 2 life' })).toThrow(ReviewError);
    expect(() => recordCorrection(db, 'o', { ...fix, type_key: 'NOPE' })).toThrow(/not in atom_types/);
    expect(() => recordCorrection(db, 'o', { ...fix, rule_numbers: ['999.9'] })).toThrow(/not in corpus/);
    expect(n(db, 'SELECT COUNT(*) n FROM golden_atoms')).toBe(0);
  });

  it('asks for span_start when the quote occurs twice', () => {
    const db = fixtureWithClauses('Draw a card. Draw a card.');
    const draw = { ...fix, type_key: 'CARD_DRAW', quote: 'Draw a card', rule_numbers: ['121.1'] };
    expect(() => recordCorrection(db, 'o', draw)).toThrow(/occurs 2 times/);
    recordCorrection(db, 'o', { ...draw, span_start: 13 });
    expect(db.prepare('SELECT span_start FROM golden_atoms').get()).toEqual({ span_start: 13 });
  });
});

describe('promoteAtomType (sec. 4.3)', () => {
  function withUnclassified(): Db {
    const db = fixtureWithClauses('Prepare it.');
    fixtureWithClauses('Prepare them.', { db, oracleId: 'p' });
    fixtureWithClauses('Something else.', { db, oracleId: 'q' });
    const ins = db.prepare(`INSERT INTO unclassified_clauses (run_id, oracle_id, face_index, span_start, span_end, quote, proposed_label, rationale, oracle_hash)
                            VALUES (1,?,0,0,7,'Prepare',?,'r','h')`);
    ins.run('o', 'PREPARE');
    ins.run('p', ' prepare ');
    ins.run('q', 'OTHER');
    return db;
  }
  const def = { family: 'ENABLES' as const, type_key: 'PREPARE', label: 'Prepare', evidence: 'recurs on 57 cards' };

  it('publishes a new schema version holding every old type plus the promoted one', () => {
    const db = withUnclassified();
    const before = n(db, 'SELECT COUNT(*) n FROM atom_types WHERE schema_version = 1');
    expect(promoteAtomType(db, 1, def).schemaVersion).toBe(2);
    expect(n(db, 'SELECT COUNT(*) n FROM atom_types WHERE schema_version = 2')).toBe(before + 1);
    expect(db.prepare("SELECT provenance, evidence FROM atom_types WHERE type_key = 'PREPARE'").get())
      .toMatchObject({ provenance: 'review_promoted', evidence: expect.stringContaining('recurs on 57 cards') });
    expect(n(db, 'SELECT COUNT(*) n FROM atom_types WHERE schema_version = 1')).toBe(before);   // v1 untouched
  });

  it('marks the clause promoted and requeues every card holding the same label, reason schema_promoted', () => {
    const db = withUnclassified();
    expect(promoteAtomType(db, 1, def).requeued).toBe(2);
    expect(queueRows(db)).toEqual([
      { oracle_id: 'o', reason: 'schema_promoted', status: 'pending' },
      { oracle_id: 'p', reason: 'schema_promoted', status: 'pending' },
    ]);
    expect(db.prepare('SELECT status FROM unclassified_clauses WHERE id = 1').get()).toEqual({ status: 'promoted' });
  });

  it('refuses a type that already exists, and a clause already decided', () => {
    const db = withUnclassified();
    expect(() => promoteAtomType(db, 1, { ...def, family: 'PRODUCES', type_key: 'CARD_DRAW' })).toThrow(/already exists/);
    promoteAtomType(db, 1, def);
    expect(() => promoteAtomType(db, 1, { ...def, type_key: 'OTHER' })).toThrow(/already promoted/);
  });
});

describe('acceptMissingRule (sec. 3.4, 6.4)', () => {
  function reported(): Db {
    const db = fixtureWithClauses('Draw a card.');
    insertAtom(db);                                             // extracted: its packet will change
    db.exec(`INSERT INTO missing_rule_reports (run_id, oracle_id, face_index, quote, statement, oracle_hash)
             VALUES (1,'o',0,'Draw a card','what drawing means was not supplied','h')`);
    return db;
  }

  it('promotes the rule into the kernel, records it on the report, and requeues with kernel_changed', () => {
    const db = reported();
    const sha = packetPolicyShaWithKernel(db, 1, POLICY);
    const r = acceptMissingRule(db, 1, '704.5f', POLICY);
    expect(r).toMatchObject({ kernelAdded: true, requeued: 1, policySha: { before: sha } });
    expect(r.policySha.after).not.toBe(sha);
    expect(db.prepare('SELECT rule_number, origin FROM packet_kernel').all())
      .toEqual([{ rule_number: '704.5f', origin: 'review_promoted' }]);
    expect(db.prepare('SELECT status, resolved_rule FROM missing_rule_reports').get())
      .toEqual({ status: 'accepted', resolved_rule: '704.5f' });
    expect(queueRows(db)).toEqual([{ oracle_id: 'o', reason: 'kernel_changed', status: 'pending' }]);
  });

  it('requeues nothing when the kernel already carried the rule', () => {
    const db = reported();
    db.exec("INSERT INTO packet_kernel (corpus_id, rule_number, origin, evidence) VALUES (1,'704.5f','golden_citation','e')");
    expect(acceptMissingRule(db, 1, '704.5f', POLICY)).toMatchObject({ kernelAdded: false, requeued: 0 });
  });

  it('refuses a rule the current corpus does not have', () => {
    const db = reported();
    expect(() => acceptMissingRule(db, 1, '999.1', POLICY)).toThrow(/not in the current/);
    expect(n(db, 'SELECT COUNT(*) n FROM packet_kernel')).toBe(0);
  });

  it('resolves the finding that pointed at the report', () => {
    const db = reported();
    finaliseCard(db, 1, 'o');
    enqueueFindings(db, 1, 'o');
    acceptMissingRule(db, 1, '704.5f', POLICY);
    expect(listFindings(db)).toEqual([]);
  });
});

describe('acceptMissingRule: targeted requeue (ruling R13-1)', () => {
  /** Reporter `o` quotes "Draw a card"; `p` shares the phrase, `q` does not, `r` has no atoms. */
  function pool(ruleText: string): Db {
    const db = fixtureWithClauses('Draw a card.');
    insertAtom(db);
    fixtureWithClauses('Whenever an opponent draws a card, you gain 1 life.', { db, oracleId: 'p' });
    insertAtom(db, { oracle_id: 'p' });
    fixtureWithClauses('Flying', { db, oracleId: 'q' });
    insertAtom(db, { oracle_id: 'q' });
    fixtureWithClauses('Draw a card.', { db, oracleId: 'r' });   // not extracted yet
    db.prepare("UPDATE rules SET text = ? WHERE number = '704.5f'").run(ruleText);
    db.exec(`INSERT INTO missing_rule_reports (run_id, oracle_id, face_index, quote, statement, oracle_hash)
             VALUES (1,'o',0,'Draw a card','what drawing from an empty library means was not supplied','h')`);
    return db;
  }
  const requeued = (db: Db) => (db.prepare("SELECT oracle_id FROM extraction_queue WHERE reason = 'kernel_changed' ORDER BY oracle_id")
    .all() as Array<{ oracle_id: string }>).map((r) => r.oracle_id);

  it('requeues the reporter and every extracted card containing a phrase the rule text and the quote share', () => {
    const db = pool('If a player would draw a card from a library with no cards in it, that player loses.');
    const r = acceptMissingRule(db, 1, '704.5f', { ...POLICY, strip_suffixes: ['s'] });
    expect(r).toMatchObject({ kernelAdded: true, requeued: 2, phrases: ['draw a card'] });
    expect(requeued(db)).toEqual(['o', 'p']);                  // "draws a card" matches by inflection
  });

  it('requeues only the reporting card when the rule text and the quote share no phrase of two words', () => {
    const db = pool('A player with an empty library loses the game.');
    const r = acceptMissingRule(db, 1, '704.5f', POLICY);
    expect(r).toMatchObject({ requeued: 1, phrases: [] });
    expect(requeued(db)).toEqual(['o']);
  });
});

describe('cardsReachedByKernelRule (ruling R13-1)', () => {
  it('unions the phrases of every accepted report for the rule', () => {
    const db = fixtureWithClauses('Draw a card.');
    insertAtom(db);
    fixtureWithClauses('You gain life.', { db, oracleId: 'p' });
    insertAtom(db, { oracle_id: 'p' });
    fixtureWithClauses('Target player gains 3 life.', { db, oracleId: 's' });
    insertAtom(db, { oracle_id: 's' });
    db.prepare("UPDATE rules SET text = 'A player who would draw a card or gain life does so.' WHERE number = '704.5f'").run();
    db.exec(`INSERT INTO missing_rule_reports (run_id, oracle_id, face_index, quote, statement, oracle_hash, status, resolved_rule)
             VALUES (1,'p',0,'You gain life','x','h','accepted','704.5f')`);
    const reach = cardsReachedByKernelRule(db, 1, '704.5f', [{ oracle_id: 'o', quote: 'Draw a card' }], POLICY);
    expect(reach.phrases).toEqual(['draw a card', 'gain life']);
    expect(reach.reporters).toEqual(['o', 'p']);
    expect(reach.oracleIds).toEqual(['o', 'p']);               // "gains 3 life" is not "gain life"
  });
});

describe('acceptSplitterDisagreement (sec. 5.2)', () => {
  it('marks the bug; the splitter fix that follows requeues the card with splitter_changed', () => {
    const db = fixtureWithClauses('Draw a card.');
    insertAtom(db);
    db.exec(`INSERT INTO splitter_disagreements (run_id, oracle_id, face_index, quote, note, splitter_version)
             VALUES (1,'o',0,'Draw a card.','split wrong',1)`);
    acceptSplitterDisagreement(db, 1);
    expect(db.prepare('SELECT status FROM splitter_disagreements').get()).toEqual({ status: 'accepted' });
    expect(queueRows(db)).toEqual([]);                          // never applied automatically
    reconcileSplitterVersion(db, 2);                            // the fix ships as SPLITTER_VERSION 2
    expect(queueRows(db)).toEqual([{ oracle_id: 'o', reason: 'splitter_changed', status: 'pending' }]);
  });
});

describe('degree rank (Phase 3 spec sec. 14.2)', () => {
  /** Card `o` (atom finding, 1 connective atom) and card `p` (no degree), plus one rule set. */
  function setup() {
    const db = fixtureWithClauses('Draw a card. You gain 2 life.');
    fixtureWithClauses('Draw a card. You gain 2 life.', { oracleId: 'p', db });
    db.prepare(
      "INSERT INTO edge_rule_sets (version, schema_version, corpus_id, packet_sha, model, status, created_at) VALUES (1, 1, 1, 's', 'm', 'accepted', 't')",
    ).run();
    return db;
  }
  function build(db: Db, degrees: Record<string, [number, number, number]>): number {
    const id = Number(db.prepare(
      `INSERT INTO graph_builds (build_key, rule_set_id, schema_version, corpus_id, pool_snapshot_id, tests_version, atom_set_sha, scope, built_at, counts_json)
       VALUES (?, 1, 1, 1, 1, 1, 'a', 'BR', 't', '{}')`,
    ).run(`k${Math.random()}`).lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO card_degree (build_id, oracle_id, out_degree, in_degree, out_weight, in_weight, class_edges, anti_degree)
       VALUES (?, ?, ?, ?, 0, 0, ?, 0)`,
    );
    for (const [card, [o, i, c]] of Object.entries(degrees)) ins.run(id, card, o, i, c);
    return id;
  }
  /** One coverage_miss finding for the card: one atom over the first clause only. */
  function finding(db: Db, oracleId: string) {
    insertAtom(db, { oracle_id: oracleId, span_start: 0, span_end: 12 });
    finaliseCard(db, 1, oracleId);
    enqueueFindings(db, 1, oracleId);
  }
  const score = (db: Db, oracleId: string) =>
    (db.prepare("SELECT rank_score FROM review_queue WHERE domain = 'atom' AND oracle_id = ?").get(oracleId) as { rank_score: number }).rank_score;
  const connective = (db: Db, oracleId: string) =>
    (db.prepare('SELECT connective_atom_count n FROM extraction_results WHERE run_id = 1 AND oracle_id = ?').get(oracleId) as { n: number }).n;

  it('degreeRankScore is out + in + class of the latest build that holds the card, and null without one', () => {
    const db = setup();
    expect(degreeRankScore(db, 'o')).toBeNull();
    build(db, { o: [1, 1, 1] });
    build(db, { o: [4, 5, 6] });
    expect(degreeRankScore(db, 'o')).toBe(15);
    expect(degreeRankScore(db, 'p')).toBeNull();
  });

  it('enqueueFindings uses the degree when the card has one, and the connective-atom count when not', () => {
    const db = setup();
    build(db, { o: [10, 20, 3] });
    finding(db, 'o');
    finding(db, 'p');
    expect(score(db, 'o')).toBe(33);
    expect(score(db, 'p')).toBe(connective(db, 'p'));
  });

  it('rerankAtomQueue changes pending atom rows only - not resolved rows, not edge rows', () => {
    const db = setup();
    finding(db, 'o');
    finding(db, 'p');
    const before = score(db, 'p');
    db.prepare("UPDATE review_queue SET status = 'resolved' WHERE domain = 'atom' AND oracle_id = 'p'").run();
    db.prepare(
      `INSERT INTO review_queue (domain, oracle_id, rule_set_id, severity, severity_rank, rank_score, detail_table, detail_id, enqueued_at)
       VALUES ('edge', 'o', 1, 'edge_rule_disagreement', 2, 7, 'edge_rules', 1, 't')`,
    ).run();
    build(db, { o: [2, 2, 2], p: [50, 50, 50] });
    expect(rerankAtomQueue(db)).toBe(1);
    expect(score(db, 'o')).toBe(6);
    expect(score(db, 'p')).toBe(before);
    expect(db.prepare("SELECT rank_score FROM review_queue WHERE domain = 'edge'").get()).toEqual({ rank_score: 7 });
    expect(rerankAtomQueue(db)).toBe(0);                        // nothing changes a second time
  });

  it('keeps the atom sort order severity_rank, rank_score DESC, id', () => {
    const db = setup();
    finding(db, 'o');
    finding(db, 'p');
    build(db, { p: [9, 9, 9] });
    rerankAtomQueue(db);
    expect(listFindings(db).map((f) => [f.oracle_id, f.rank_score, f.rank_key])).toEqual([['p', 27, 'degree'], ['o', connective(db, 'o'), 'connective']]);
  });
});
