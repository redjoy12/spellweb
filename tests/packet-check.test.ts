import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/client.js';
import { persistAtomSchema } from '../src/atoms/schema.js';
import { splitOracleText } from '../src/atoms/clauses.js';
import { upsertGoldenCard, scoreAgainstGolden, type GoldenAtom } from '../src/atoms/golden.js';
import { computeCoverage } from '../src/atoms/verify.js';
import { runPacketRules } from '../src/atoms/extractBatch.js';
import { BARS, isAcceptable, checkRun, type ScoreRow } from '../src/atoms/packetCheck.js';

// ---------- the decision rule ----------

const row = (over: Partial<ScoreRow> = {}): ScoreRow => ({
  citation_validity: 1.0, span_validity: 0.995, atom_recall: 0.93, atom_precision: 0.88, coverage: 0.97, ...over,
});

describe('isAcceptable', () => {
  it('rejects a run with citation validity below 1.0, however good otherwise', () => {
    const r = isAcceptable(row({ citation_validity: 0.999, atom_recall: 1, atom_precision: 1 }));
    expect(r.ok).toBe(false);
    expect(r.failed).toContain('citation_validity');
  });

  it('rejects an unmeasured citation validity - an I1 bar is never passed by assumption', () => {
    expect(isAcceptable(row({ citation_validity: null })).failed).toEqual(['citation_validity']);
  });

  it('rejects a run below the recall bar even when precision is perfect', () => {
    const r = isAcceptable(row({ atom_recall: 0.80, atom_precision: 1.0 }));
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual(['atom_recall']);
  });

  it('accepts a run meeting every bar', () => {
    expect(isAcceptable(row())).toEqual({ ok: true, failed: [] });
  });

  it('names every failed metric, not just the first', () => {
    const r = isAcceptable(row({ atom_recall: 0.1, atom_precision: 0.1, coverage: 0.1 }));
    expect([...r.failed].sort()).toEqual(['atom_precision', 'atom_recall', 'coverage']);
  });

  it('treats each bar as inclusive - exactly at the bar passes', () => {
    for (const k of Object.keys(BARS) as Array<keyof typeof BARS>) {
      expect(isAcceptable(row({ [k]: BARS[k] })).ok).toBe(true);
    }
  });
});

// ---------- fixture ----------

const EMPTY = { type: 'object', properties: {}, additionalProperties: false } as const;
const TEXT_A = 'Flying (This creature can\'t be blocked except by creatures with flying.)\nDraw a card. You gain 2 life.';
const TEXT_B = 'Create a 1/1 token.';

function seed(): { db: DatabaseSync; a: ReturnType<typeof splitOracleText>; b: ReturnType<typeof splitOracleText> } {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO rules_corpus (source_uri, effective_date, sha256, fetched_at, section_count, rule_count, glossary_count, is_current)
              VALUES ('t','t','s','t',1,4,0,1)`).run();
  const ins = db.prepare('INSERT INTO rules (corpus_id, number, section_number, subsection_number, text, ordinal) VALUES (1,?,?,?,?,?)');
  ([['702.9a', '702', '702.9'], ['121.1', '121', null], ['119.1', '119', null], ['111.1', '111', null]] as const)
    .forEach(([n, s, sub], i) => ins.run(n, s, sub, `text of ${n}`, i));
  persistAtomSchema(db, {
    schema_version: 1,
    types: ['FLYING', 'CARD_DRAW', 'LIFEGAIN', 'TOKENS'].map((k) => ({
      family: k === 'FLYING' ? 'COMBAT' : 'PRODUCES', type_key: k, label: k, params_schema: EMPTY,
      provenance: 'spec_4_1', evidence: 'fixture',
    })),
  });
  db.prepare(`INSERT INTO snapshots (id, source_type, source_uri, source_updated_at, ingested_at, printings_seen, cards_kept, status)
              VALUES (1,'t','t','t','t',0,0,'complete')`).run();
  for (const [id, name, text] of [['A', 'Card A', TEXT_A], ['B', 'Card B', TEXT_B]] as const) {
    db.prepare(`INSERT INTO cards (oracle_id, name, layout, cmc, type_line, colors, color_identity, keywords, rarity,
                  set_code, collector_number, oracle_hash, first_seen_snapshot_id, last_seen_snapshot_id)
                VALUES (?,?,'normal',2,'Creature','[]','[]','[]','common','TST','1',?,1,1)`).run(id, name, `h${id}`);
    db.prepare(`INSERT INTO card_faces (oracle_id, face_index, name, type_line, oracle_text, colors) VALUES (?,0,?,'Creature',?,'[]')`)
      .run(id, name, text);
  }
  for (const id of [1, 2]) {
    db.prepare(`INSERT INTO extraction_runs (id, started_at, provider, model, schema_version, corpus_id, packet_policy_sha,
                  splitter_version, batch_kind, status) VALUES (?,'t','test','m',1,1,'sha',1,'golden','complete')`).run(id);
  }
  return { db, a: splitOracleText(TEXT_A, 0), b: splitOracleText(TEXT_B, 0) };
}

type C = ReturnType<typeof splitOracleText>[number];

const golden = (family: GoldenAtom['family'], typeKey: string, c: C, rules: string[]): GoldenAtom => ({
  face_index: 0, schema_version: 1, family, type_key: typeKey, params: {},
  span_start: c.span_start, span_end: c.span_end, quote: c.text, rule_numbers: rules, source: 'authored',
});

function runAtom(db: DatabaseSync, runId: number, oracleId: string, family: string, typeKey: string,
                 span: { span_start: number; span_end: number }, quote: string, rules: string[]): void {
  db.prepare(`INSERT INTO atoms (run_id, oracle_id, face_index, schema_version, family, type_key, params_json, span_start,
                span_end, quote, rule_numbers, confidence, confidence_source, oracle_hash)
              VALUES (?,?,0,1,?,?,'{}',?,?,?,?,1,'model',?)`)
    .run(runId, oracleId, family, typeKey, span.span_start, span.span_end, quote, JSON.stringify(rules), `h${oracleId}`);
}

/** Card A clauses: [0] Flying, [1] reminder, [2] Draw a card., [3] You gain 2 life. */
function goldenA(db: DatabaseSync, a: C[]) {
  upsertGoldenCard(db, {
    oracle_id: 'A', complete: true, oracle_hash: 'hA', verified_at: 't',
    atoms: [
      golden('COMBAT', 'FLYING', a[0]!, ['702.9a']),
      golden('PRODUCES', 'CARD_DRAW', a[2]!, ['121.1']),
      golden('PRODUCES', 'LIFEGAIN', a[3]!, ['119.1']),
    ],
  });
}

// ---------- coverage ----------

describe('computeCoverage', () => {
  it('excludes reminder clauses from the denominator', () => {
    const { db, a } = seed();
    expect(a.map((c) => c.kind)).toEqual(['ability', 'reminder', 'ability', 'ability']);
    for (const i of [0, 2, 3]) runAtom(db, 1, 'A', 'PRODUCES', 'CARD_DRAW', a[i]!, a[i]!.text, ['121.1']);
    expect(computeCoverage(db, 1, 'A')).toEqual({ ratio: 1, uncovered: [] });
  });

  it('counts a partial overlap as covering, and lists what is left uncovered', () => {
    const { db, a } = seed();
    runAtom(db, 1, 'A', 'COMBAT', 'FLYING', { span_start: 0, span_end: 3 }, 'Fly', ['702.9a']);
    const c = computeCoverage(db, 1, 'A');
    expect(c.ratio).toBeCloseTo(1 / 3, 5);
    expect(c.uncovered).toEqual([{ face_index: 0, clause_index: a[2]!.clause_index }, { face_index: 0, clause_index: a[3]!.clause_index }]);
  });

  it('counts a clause the run declared unclassified as covered, like golden verification does', () => {
    const { db, b } = seed();
    db.prepare(`INSERT INTO unclassified_clauses (run_id, oracle_id, face_index, span_start, span_end, quote, proposed_label, rationale, oracle_hash)
                VALUES (1,'B',0,?,?,?,'X','r','hB')`).run(b[0]!.span_start, b[0]!.span_end, b[0]!.text);
    expect(computeCoverage(db, 1, 'B').ratio).toBe(1);
  });

  it('ignores another run\'s atoms', () => {
    const { db, b } = seed();
    runAtom(db, 2, 'B', 'PRODUCES', 'TOKENS', b[0]!, b[0]!.text, ['111.1']);
    expect(computeCoverage(db, 1, 'B').ratio).toBe(0);
  });

  it('is 1.0 for a card with no clauses', () => {
    const { db } = seed();
    db.prepare("UPDATE card_faces SET oracle_text = '' WHERE oracle_id = 'B'").run();
    expect(computeCoverage(db, 1, 'B').ratio).toBe(1);
  });
});

// ---------- scoring ----------

describe('scoreAgainstGolden - coverage and in-packet citation validity', () => {
  it('scores coverage from the run\'s atoms, not from extraction_results', () => {
    const { db, a } = seed();
    goldenA(db, a);
    for (const i of [0, 2, 3]) runAtom(db, 1, 'A', 'PRODUCES', 'CARD_DRAW', a[i]!, a[i]!.text, ['121.1']);
    expect(scoreAgainstGolden(db, 1).coverage).toBe(1);
    expect(scoreAgainstGolden(db, 2).coverage).toBe(0);
  });

  it('leaves citation_validity null when no packet whitelists are given', () => {
    const { db, a } = seed();
    goldenA(db, a);
    expect(scoreAgainstGolden(db, 1).citation_validity).toBeNull();
  });

  it('drops citation_validity for a real corpus rule the card was not shown - the case citation_in_corpus cannot see', () => {
    const { db, a } = seed();
    goldenA(db, a);
    runAtom(db, 1, 'A', 'COMBAT', 'FLYING', a[0]!, a[0]!.text, ['702.9a']);
    runAtom(db, 1, 'A', 'PRODUCES', 'CARD_DRAW', a[2]!, a[2]!.text, ['121.1']);
    const s = scoreAgainstGolden(db, 1, { packetRules: new Map([['A', new Set(['702.9a'])]]) });
    expect(s.citation_in_corpus).toBe(1);
    expect(s.citation_validity).toBe(0.5);
  });
});

// ---------- the packet-hole check ----------

describe('checkRun', () => {
  it('calls a miss whose cited rule the packet lacked a packet hole, and names the rule', () => {
    const { db, a } = seed();
    goldenA(db, a);
    runAtom(db, 1, 'A', 'COMBAT', 'FLYING', a[0]!, a[0]!.text, ['702.9a']);
    runAtom(db, 1, 'A', 'PRODUCES', 'CARD_DRAW', a[2]!, a[2]!.text, ['121.1']);
    const r = checkRun(db, 1, { packetRules: new Map([['A', new Set(['702.9a', '121.1'])]]) });
    expect(r.misses).toHaveLength(1);
    expect(r.misses[0]).toMatchObject({ type_key: 'LIFEGAIN', verdict: 'packet_hole', not_shown: ['119.1'], closed_now: null, name: 'Card A' });
  });

  it('marks a hole the packet assembled today would close', () => {
    const { db, a } = seed();
    goldenA(db, a);
    const r = checkRun(db, 1, {
      packetRules: new Map([['A', new Set(['702.9a', '121.1'])]]),
      currentPacketRules: () => new Set(['702.9a', '121.1', '119.1']),
    });
    expect(r.misses.find((m) => m.type_key === 'LIFEGAIN')).toMatchObject({ verdict: 'packet_hole', closed_now: true });
    expect(r.misses.find((m) => m.type_key === 'CARD_DRAW')).toMatchObject({ verdict: 'in_packet', closed_now: null });
  });

  it('calls a miss whose rules were all shown in_packet, and reports what the run put on that span instead', () => {
    const { db, a } = seed();
    goldenA(db, a);
    runAtom(db, 1, 'A', 'COMBAT', 'FLYING', a[0]!, a[0]!.text, ['702.9a']);
    runAtom(db, 1, 'A', 'PRODUCES', 'CARD_DRAW', a[2]!, a[2]!.text, ['121.1']);
    runAtom(db, 1, 'A', 'PRODUCES', 'TOKENS', a[3]!, a[3]!.text, ['119.1']);
    const r = checkRun(db, 1, { packetRules: new Map([['A', new Set(['702.9a', '121.1', '119.1'])]]) });
    expect(r.misses).toEqual([expect.objectContaining({
      type_key: 'LIFEGAIN', verdict: 'in_packet', not_shown: [], run_types_on_span: ['PRODUCES TOKENS'], run_same_type_elsewhere: 0,
    })]);
    expect(r.extras).toEqual([expect.objectContaining({ type_key: 'TOKENS', quote: a[3]!.text })]);
  });

  it('calls a card the run never answered not_extracted rather than blaming the packet', () => {
    const { db, a } = seed();
    goldenA(db, a);
    const r = checkRun(db, 1, { packetRules: new Map() });
    expect(r.misses.map((m) => m.verdict)).toEqual(['not_extracted', 'not_extracted', 'not_extracted']);
  });

  it('treats a card whose answer failed validation as not extracted', () => {
    const { db, a } = seed();
    goldenA(db, a);
    db.prepare(`INSERT INTO extraction_results (run_id, oracle_id, coverage_ratio, uncovered_clauses_json, passes_run,
                  connective_atom_count, packet_chars, packet_tokens, outcome) VALUES (1,'A',0,'[]',1,0,0,0,'failed')`).run();
    const r = checkRun(db, 1, { packetRules: new Map([['A', new Set<string>()]]) });
    expect(new Set(r.misses.map((m) => m.verdict))).toEqual(new Set(['not_extracted']));
  });

  it('counts extras only on complete golden cards', () => {
    const { db, a, b } = seed();
    upsertGoldenCard(db, { oracle_id: 'B', complete: false, oracle_hash: 'hB', verified_at: 't', atoms: [] });
    goldenA(db, a);
    runAtom(db, 1, 'B', 'PRODUCES', 'TOKENS', b[0]!, b[0]!.text, ['111.1']);
    expect(checkRun(db, 1, { packetRules: new Map() }).extras).toEqual([]);
  });

  it('applies the decision rule to the run\'s score', () => {
    const { db, a } = seed();
    goldenA(db, a);
    const r = checkRun(db, 1, { packetRules: new Map([['A', new Set(['702.9a', '121.1', '119.1'])]]) });
    expect(r.acceptable.ok).toBe(false);
    expect(r.acceptable.failed).toEqual(expect.arrayContaining(['atom_recall', 'coverage']));
  });
});

describe('runPacketRules', () => {
  let dir: string | undefined;
  afterEach(() => {
    delete process.env['EXTRACT_BATCHES_DIR'];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads each card\'s whitelist from the run\'s batch manifests', () => {
    dir = mkdtempSync(join(tmpdir(), 'packet-check-'));
    process.env['EXTRACT_BATCHES_DIR'] = dir;
    const card = (key: string, id: string, rules: string[]) =>
      ({ key, oracle_id: id, oracle_hash: 'h', packet_rules: rules, packet_chars: 1 });
    [[card('C01', 'A', ['121.1'])], [card('C01', 'B', ['111.1', '702.9a'])]].forEach((cards, i) => {
      const b = join(dir!, 'run-7', `batch-00${i + 1}`);
      mkdirSync(b, { recursive: true });
      writeFileSync(join(b, 'manifest.json'), JSON.stringify({ run_id: 7, batch_index: i, cards }));
    });
    const m = runPacketRules(7);
    expect([...m.keys()].sort()).toEqual(['A', 'B']);
    expect(m.get('B')).toEqual(new Set(['111.1', '702.9a']));
  });
});

describe('checkRun - schema v15 param agreement (spec sec. 20)', () => {
  it('counts each param of the matched pairs whose golden atom is at v15, and lists the disagreements', () => {
    const { db, b } = seed();
    persistAtomSchema(db, {
      schema_version: 15,
      types: [{ family: 'PRODUCES', type_key: 'TOKENS', label: 'TOKENS', provenance: 'spec_4_1', evidence: 'fixture',
        params_schema: { type: 'object', properties: { amount: { type: ['integer', 'string'] }, controller: { enum: ['you', 'any'] } },
          required: ['amount', 'controller'], additionalProperties: false } }],
    });
    upsertGoldenCard(db, {
      oracle_id: 'B', complete: true, oracle_hash: 'hB', verified_at: 't',
      atoms: [{ ...golden('PRODUCES', 'TOKENS', b[0]!, ['111.1']), schema_version: 15, params: { amount: 1, controller: 'you' } }],
    });
    db.prepare(`INSERT INTO atoms (run_id, oracle_id, face_index, schema_version, family, type_key, params_json, span_start,
                  span_end, quote, rule_numbers, confidence, confidence_source, oracle_hash)
                VALUES (1,'B',0,15,'PRODUCES','TOKENS',?,?,?,?,'["111.1"]',1,'model','hB')`)
      .run(JSON.stringify({ controller: 'any', amount: 1 }), b[0]!.span_start, b[0]!.span_end, b[0]!.text);
    const r = checkRun(db, 1, { packetRules: new Map([['B', new Set(['111.1'])]]) });
    expect(r.params).toEqual([
      { type: 'PRODUCES.TOKENS', param: 'amount', agree: 1, total: 1 },
      { type: 'PRODUCES.TOKENS', param: 'controller', agree: 0, total: 1 },
    ]);
    expect(r.paramDisagreements).toEqual([
      { name: 'Card B', type: 'PRODUCES.TOKENS', param: 'controller', golden: 'you', run: 'any', quote: b[0]!.text },
    ]);
  });
});
