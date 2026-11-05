import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeCoverage, shouldEscalate, reconcileVotes, reconcileErrata, reconcileSplitterVersion, finaliseCard,
  votesMatch, type EscalationConfig,
} from '../src/atoms/verify.js';
import { persistValidated, validateResponse, recordFailedCard } from '../src/atoms/extract.js';
import { fixtureWithClauses, insertAtom, insertAtoms, coverAbilities, addRun } from './helpers/fixture.js';

const count = (db: ReturnType<typeof fixtureWithClauses>, sql: string, ...args: unknown[]) =>
  (db.prepare(sql).get(...(args as never[])) as { n: number }).n;

describe('computeCoverage', () => {
  let db: ReturnType<typeof fixtureWithClauses>;
  beforeEach(() => { db = fixtureWithClauses('Flying (This creature can\'t be blocked.)\nDraw a card.'); });

  it('excludes reminder clauses from the denominator', () => {
    // 3 clauses: ability "Flying", reminder, ability "Draw a card." Cover both abilities.
    coverAbilities(db);
    expect(computeCoverage(db, 1, 'o').ratio).toBe(1);
  });

  it('returns ratio 1.0 for a face with no clauses — 20 such faces exist', () => {
    const empty = fixtureWithClauses('');
    expect(computeCoverage(empty, 1, 'o').ratio).toBe(1);
  });

  it('counts a clause covered when any atom span overlaps it, even partially', () => {
    insertAtom(db, { span_start: 0, span_end: 3 });          // "Fly" of "Flying"
    expect(computeCoverage(db, 1, 'o').uncovered).not.toContainEqual({ face_index: 0, clause_index: 0 });
    expect(computeCoverage(db, 1, 'o').ratio).toBe(0.5);
  });

  it('lists uncovered clause indexes so the inspector can highlight them', () => {
    const c = computeCoverage(db, 1, 'o');
    expect(c.ratio).toBeLessThan(1);
    expect(c.uncovered).toEqual([{ face_index: 0, clause_index: 0 }, { face_index: 0, clause_index: 2 }]);
  });

  it('reads the run\'s own verdict, so a later run demoting the card does not change this run\'s score', () => {
    coverAbilities(db);
    db.exec('UPDATE atoms SET is_current = 0');                // a newer run took over the live set
    expect(computeCoverage(db, 1, 'o').ratio).toBe(1);
  });

  it('does not count outvoted atoms', () => {
    coverAbilities(db);
    db.exec('UPDATE atoms SET consensus = 0');
    expect(computeCoverage(db, 1, 'o').ratio).toBe(0);
  });
});

describe('shouldEscalate', () => {
  const cfg: EscalationConfig = { passes: 3, max_counted_clauses: 5, max_oracle_chars: 350 };

  it('escalates when first-pass coverage is below 100%', () => {
    const db = fixtureWithClauses('Draw a card. You gain 3 life.');
    expect(shouldEscalate(db, 'o', { coverage: 0.5, faces: 1, layout: 'normal', clauses: 2 }, cfg)).toBe(true);
  });
  it('escalates on a non-normal layout', () => {
    const db = fixtureWithClauses('Draw a card.');
    expect(shouldEscalate(db, 'o', { coverage: 1, faces: 1, layout: 'transform', clauses: 1 }, cfg)).toBe(true);
  });
  it('escalates on a multi-face card', () => {
    const db = fixtureWithClauses('Draw a card.');
    expect(shouldEscalate(db, 'o', { coverage: 1, faces: 2, layout: 'normal', clauses: 1 }, cfg)).toBe(true);
  });
  it('escalates on many clauses or long text, per the provisional config', () => {
    const db = fixtureWithClauses('Draw a card.');
    expect(shouldEscalate(db, 'o', { coverage: 1, faces: 1, layout: 'normal', clauses: 6 }, cfg)).toBe(true);
    const long = fixtureWithClauses('Draw a card. '.repeat(30));
    expect(shouldEscalate(long, 'o', { coverage: 1, faces: 1, layout: 'normal', clauses: 1 }, cfg)).toBe(true);
  });
  it('does not escalate a simple single-clause card at full coverage', () => {
    const db = fixtureWithClauses('Draw a card.');
    expect(shouldEscalate(db, 'o', { coverage: 1, faces: 1, layout: 'normal', clauses: 1 }, cfg)).toBe(false);
  });
  it('reads its thresholds from config/escalation.json by default', () => {
    const db = fixtureWithClauses('Draw a card.');
    expect(shouldEscalate(db, 'o', { coverage: 1, faces: 1, layout: 'normal', clauses: 1 })).toBe(false);
  });
});

describe('reconcileVotes', () => {
  const three = (spans: Array<[number, number]>) => spans.map(([s, e], i) =>
    ({ pass_index: i, family: 'PRODUCES', type_key: 'CARD_DRAW', span_start: s, span_end: e }));

  it('matches atoms on family, type_key and span overlap >= 50%', () => {
    const db = fixtureWithClauses('Draw a card.');
    insertAtoms(db, three([[0, 12], [0, 11], [0, 12]]));
    expect(reconcileVotes(db, 1, 'o').consensus).toHaveLength(1);
  });

  it('measures overlap against the longer span, so a sliver never agrees with a clause', () => {
    const a = { id: 1, pass_index: 0, face_index: 0, family: 'P', type_key: 'T', span_start: 0, span_end: 12 };
    expect(votesMatch(a, { ...a, id: 2, span_end: 1 })).toBe(false);
    expect(votesMatch(a, { ...a, id: 2, span_end: 6 })).toBe(true);
    expect(votesMatch(a, { ...a, id: 2, type_key: 'U' })).toBe(false);
  });

  it('marks an atom present in 2 of 3 passes as consensus', () => {
    const db = fixtureWithClauses('Draw a card.');
    insertAtoms(db, three([[0, 12], [0, 12], [0, 1]]));      // third disagrees
    const r = reconcileVotes(db, 1, 'o');
    expect(r.consensus).toHaveLength(1);
    expect(r.agreement).toBeCloseTo(2 / 3, 5);
    expect(r.dissent).toBe(2);                               // the 2-of-3 cluster and the stray
    expect(r.majorityDissent).toBe(1);                       // only the 2-of-3 consensus cluster
  });

  it('drops an atom only one pass found', () => {
    const db = fixtureWithClauses('Draw a card.');
    insertAtoms(db, [
      { pass_index: 0 }, { pass_index: 1 }, { pass_index: 2 },
      { pass_index: 1, family: 'PRODUCES', type_key: 'LIFEGAIN' },
    ]);
    const r = reconcileVotes(db, 1, 'o');
    expect(r.consensus.map((a) => a.type_key)).toEqual(['CARD_DRAW']);
    expect(r.agreement).toBe(1);
    expect(r.dissent).toBe(1);
    expect(r.majorityDissent).toBe(0);                       // the vote already dropped it
  });

  it('sets is_current only on consensus atoms and keeps the rest for audit', () => {
    const db = fixtureWithClauses('Draw a card.');
    insertAtoms(db, three([[0, 12], [0, 12], [0, 1]]));
    reconcileVotes(db, 1, 'o');
    const rows = db.prepare('SELECT is_current, COUNT(*) n FROM atoms GROUP BY is_current').all();
    expect(rows).toContainEqual({ is_current: 1, n: 1 });
    expect(rows).toContainEqual({ is_current: 0, n: 2 });
    expect(db.prepare('SELECT pass_index FROM atoms WHERE is_current = 1').get()).toEqual({ pass_index: 0 });
  });

  it('stores the agreement ratio as confidence with confidence_source = vote', () => {
    const db = fixtureWithClauses('Draw a card.');
    insertAtoms(db, three([[0, 12], [0, 12], [0, 1]]));
    reconcileVotes(db, 1, 'o');
    const a = db.prepare('SELECT confidence, confidence_source, consensus FROM atoms WHERE is_current=1').get() as any;
    expect(a.confidence_source).toBe('vote');
    expect(a.confidence).toBeCloseTo(2 / 3, 5);
    expect(a.consensus).toBe(1);
  });

  it('stores the model-reported value with confidence_source = model on single-pass cards', () => {
    const db = fixtureWithClauses('Draw a card.');
    insertAtoms(db, [{ pass_index: 0, family: 'PRODUCES', type_key: 'CARD_DRAW', span_start: 0, span_end: 12, confidence: 0.7 }]);
    reconcileVotes(db, 1, 'o');
    const a = db.prepare('SELECT confidence, confidence_source FROM atoms WHERE is_current=1').get() as any;
    expect(a).toEqual({ confidence: 0.7, confidence_source: 'model' });
  });

  it('leaves a superseded run\'s consensus out of the live set', () => {
    const db = fixtureWithClauses('Draw a card.');
    insertAtoms(db, three([[0, 12], [0, 12], [0, 12]]));
    const later = addRun(db);
    insertAtom(db, { run_id: later });
    reconcileVotes(db, 1, 'o');
    expect(count(db, 'SELECT COUNT(*) n FROM atoms WHERE run_id = 1 AND consensus = 1')).toBe(1);
    expect(count(db, 'SELECT COUNT(*) n FROM atoms WHERE run_id = 1 AND is_current = 1')).toBe(0);
  });
});

describe('sec. 10.3 re-extraction', () => {
  const ctx = (runId: number) => ({ runId, passIndex: 0, packetRules: ['121.1'] });
  const answer = { atoms: [{ face_index: 0, family: 'PRODUCES', type_key: 'CARD_DRAW', params: {}, quote: 'Draw a card',
    rule_numbers: ['121.1'], confidence: 0.9 }] };

  it('a new run replaces the card\'s current atoms rather than adding a second full set', () => {
    const db = fixtureWithClauses('Draw a card.');
    persistValidated(db, validateResponse(db, 'o', ctx(1), answer));
    const two = addRun(db);
    persistValidated(db, validateResponse(db, 'o', ctx(two), answer));
    expect(db.prepare('SELECT run_id, is_current, consensus FROM atoms ORDER BY run_id').all()).toEqual([
      { run_id: 1, is_current: 0, consensus: 1 },
      { run_id: two, is_current: 1, consensus: 1 },
    ]);
  });

  it('demotes and inserts in one transaction - a failed insert leaves the old set current', () => {
    const db = fixtureWithClauses('Draw a card.');
    persistValidated(db, validateResponse(db, 'o', ctx(1), answer));
    const two = addRun(db);
    const r = validateResponse(db, 'o', ctx(two), answer);
    r.atoms[0]!.type_key = 'NOT_A_TYPE';                     // the FK to atom_types fails the insert
    expect(() => persistValidated(db, r)).toThrow();
    expect(db.prepare('SELECT run_id FROM atoms WHERE is_current = 1').all()).toEqual([{ run_id: 1 }]);
  });

  it('a voting pass lands outside the live set until the votes are reconciled', () => {
    const db = fixtureWithClauses('Draw a card.');
    persistValidated(db, validateResponse(db, 'o', ctx(1), answer));
    persistValidated(db, validateResponse(db, 'o', { ...ctx(1), passIndex: 1 }, answer));
    expect(db.prepare('SELECT pass_index, is_current, consensus FROM atoms ORDER BY pass_index').all()).toEqual([
      { pass_index: 0, is_current: 1, consensus: 1 },
      { pass_index: 1, is_current: 0, consensus: 0 },
    ]);
  });
});

describe('reconcileErrata', () => {
  it('demotes atoms read from old text and requeues the card exactly once', () => {
    const db = fixtureWithClauses('Draw a card.');
    insertAtom(db);
    db.exec("UPDATE cards SET oracle_hash = 'h2'");
    expect(reconcileErrata(db)).toEqual({ demoted: 1, requeued: 1 });
    expect(count(db, 'SELECT COUNT(*) n FROM atoms WHERE is_current = 1')).toBe(0);
    expect(reconcileErrata(db)).toEqual({ demoted: 0, requeued: 0 });
    expect(db.prepare("SELECT reason, status FROM extraction_queue").all())
      .toEqual([{ reason: 'oracle_changed', status: 'pending' }]);
  });

  it('leaves atoms of unchanged text alone', () => {
    const db = fixtureWithClauses('Draw a card.');
    insertAtom(db);
    expect(reconcileErrata(db)).toEqual({ demoted: 0, requeued: 0 });
  });
});

describe('reconcileSplitterVersion', () => {
  it('re-splits clauses from an older splitter and requeues extracted cards with splitter_changed', () => {
    const db = fixtureWithClauses('Draw a card.');
    insertAtom(db);
    expect(reconcileSplitterVersion(db, 2)).toEqual({ resplit: 1, requeued: 1 });
    expect(db.prepare('SELECT DISTINCT splitter_version v FROM clauses').all()).toEqual([{ v: 2 }]);
    expect(db.prepare('SELECT reason FROM extraction_queue').all()).toEqual([{ reason: 'splitter_changed' }]);
    expect(reconcileSplitterVersion(db, 2)).toEqual({ resplit: 0, requeued: 0 });
  });

  it('re-splits a never-extracted card without requeuing it', () => {
    const db = fixtureWithClauses('Draw a card.');
    expect(reconcileSplitterVersion(db, 2)).toEqual({ resplit: 1, requeued: 0 });
  });
});

describe('finaliseCard', () => {
  it('passes a fully covered card and writes its verdict', () => {
    const db = fixtureWithClauses('Draw a card.');
    coverAbilities(db);
    expect(finaliseCard(db, 1, 'o', { packetChars: 1234 })).toBe('passed');
    expect(db.prepare('SELECT * FROM extraction_results').get()).toMatchObject({
      coverage_ratio: 1, uncovered_clauses_json: '[]', passes_run: 1, vote_agreement: null,
      connective_atom_count: 1, packet_chars: 1234, outcome: 'passed',
    });
    expect(count(db, 'SELECT cards_passed n FROM extraction_runs WHERE id = 1')).toBe(1);
  });

  it('flags an uncovered clause', () => {
    const db = fixtureWithClauses('Draw a card. You gain 2 life.');
    insertAtom(db, { span_start: 0, span_end: 12 });
    expect(finaliseCard(db, 1, 'o')).toBe('flagged');
  });

  it('flags a card with a missing-rule report even at full coverage', () => {
    const db = fixtureWithClauses('Draw a card.');
    coverAbilities(db);
    db.exec("INSERT INTO missing_rule_reports (run_id, oracle_id, face_index, quote, statement, oracle_hash) VALUES (1,'o',0,'Draw','?','h')");
    expect(finaliseCard(db, 1, 'o')).toBe('flagged');
  });

  it('flags a voted card some pass dissented from, and records the agreement', () => {
    const db = fixtureWithClauses('Draw a card.');
    insertAtoms(db, [{ pass_index: 0 }, { pass_index: 1 }, { pass_index: 2, span_end: 1 }]);
    expect(finaliseCard(db, 1, 'o')).toBe('flagged');
    expect(db.prepare('SELECT passes_run, vote_agreement FROM extraction_results').get())
      .toEqual({ passes_run: 3, vote_agreement: 2 / 3 });
  });

  it('does not flag a voted card whose only dissent is an atom one pass found (R9-5 amended, Task 11)', () => {
    // The majority vote already drops a 1-of-3 atom from the consensus set; it is a queued finding, not a flag.
    const db = fixtureWithClauses('Draw a card.');
    insertAtoms(db, [
      { pass_index: 0 }, { pass_index: 1 }, { pass_index: 2 },
      { pass_index: 1, family: 'PRODUCES', type_key: 'LIFEGAIN' },
    ]);
    expect(finaliseCard(db, 1, 'o')).toBe('passed');
  });

  it('keeps a failed card failed - there was no answer to judge', () => {
    const db = fixtureWithClauses('Draw a card.');
    recordFailedCard(db, 1, 'o', 10, 'not JSON');
    expect(finaliseCard(db, 1, 'o')).toBe('failed');
    expect(db.prepare('SELECT outcome, failure_detail FROM extraction_results').get())
      .toEqual({ outcome: 'failed', failure_detail: 'not JSON' });
  });

  it('gives the live set to the newest answer even when that answer found no atoms', () => {
    const db = fixtureWithClauses('Draw a card.');
    insertAtom(db);                                            // run 1 read a draw
    const two = addRun(db);                                    // run 2 answered with nothing
    finaliseCard(db, two, 'o');
    expect(count(db, 'SELECT COUNT(*) n FROM atoms WHERE is_current = 1')).toBe(0);
    finaliseCard(db, 1, 'o');                                  // finalising the OLDER run later changes nothing
    expect(count(db, 'SELECT COUNT(*) n FROM atoms WHERE is_current = 1')).toBe(0);
  });

  it('counts only connective families toward the rank score', () => {
    const db = fixtureWithClauses('Flying\nDraw a card.');
    insertAtom(db, { family: 'COMBAT', type_key: 'FLYING', span_start: 0, span_end: 6 });
    insertAtom(db, { span_start: 7, span_end: 19 });
    finaliseCard(db, 1, 'o');
    expect(count(db, 'SELECT connective_atom_count n FROM extraction_results')).toBe(1);
  });
});
