import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/client.js';
import { persistAtomSchema, currentSchemaVersion } from '../src/atoms/schema.js';
import type { AtomSchema } from '../src/atoms/schema.js';
import { splitOracleText } from '../src/atoms/clauses.js';
import {
  loadGoldenSet, upsertGoldenCard, scoreAgainstGolden, verifyGoldenCard, ruleNumbersExist,
  currentCorpusId, recordUnclassifiedCandidate, goldenDraftingRunId,
} from '../src/atoms/golden.js';
import type { GoldenCard, GoldenAtom } from '../src/atoms/golden.js';

/**
 * Mechanics-only tests (plan Task 6, Step 4). The golden set's CONTENT is
 * human-verified, never test-asserted; these tests assert the I/O and scoring
 * behave as sec. 8.2 / sec. 10.2 require, on synthetic cards in an isolated
 * in-memory DB. `npm test` never mutates data/app.db.
 *
 * Each test builds a fresh in-memory database with a tiny synthetic corpus + a
 * four-type atom fixture, so the suite is self-contained and order-independent.
 */

const EMPTY_PARAMS = { type: 'object', properties: {}, additionalProperties: false } as const;
const amountParams = { type: 'object', properties: { amount: { type: ['integer', 'string'] } }, required: ['amount'], additionalProperties: false } as const;

function fixtureSchema(): AtomSchema {
  return {
    schema_version: 1,
    types: [
      { family: 'INTERACTION', type_key: 'TARGETED_REMOVAL', label: 'removal', params_schema: EMPTY_PARAMS, provenance: 'spec_4_1', evidence: 'fixture' },
      { family: 'PRODUCES', type_key: 'LIFEGAIN', label: 'life', params_schema: amountParams, provenance: 'spec_4_1', evidence: 'fixture' },
      { family: 'PRODUCES', type_key: 'TOKENS', label: 'tokens', params_schema: amountParams, provenance: 'spec_4_1', evidence: 'fixture' },
      { family: 'PRODUCES', type_key: 'CARD_DRAW', label: 'draw', params_schema: amountParams, provenance: 'spec_4_1', evidence: 'fixture' },
      { family: 'COMBAT', type_key: 'POWER', label: 'power', params_schema: EMPTY_PARAMS, provenance: 'spec_4_1', evidence: 'fixture' },
    ],
  };
}

/** A synthetic corpus + two cards + one extraction run; returns the seeded db plus
 * the clause spans the test scenarios place atoms at, computed via splitOracleText. */
function seed(): {
  db: DatabaseSync; corpusId: number; runId: number;
  textA: string; textB: string;
  cA: ReturnType<typeof splitOracleText>; cB: ReturnType<typeof splitOracleText>;
} {
  const db = openDb(':memory:');

  // corpus + a handful of rules the golden/run atoms cite. `rules_corpus` has no
  // `source_type` column (that's `snapshots`) - see schema.sql lines 133-143.
  db.prepare(`INSERT INTO rules_corpus (source_uri, effective_date, sha256, fetched_at, section_count, rule_count, glossary_count, is_current)
              VALUES (?,?,?,?,?,?,?,?)`).run('test', 't', 'sha', 't', 1, 5, 0, 1);
  const corpusId = (db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as { id: number }).id;
  const rules: Array<[string, string, string | null]> = [
    ['115.1', '115', null], ['118.2', '118', null], ['701.7', '701', '701.7'],
    ['702.2a', '702', '702.2'], ['613.1', '613', null], ['302.1', '302', null],
  ];
  const insRule = db.prepare(`INSERT INTO rules (corpus_id, number, section_number, subsection_number, text, ordinal) VALUES (?,?,?,?,?,?)`);
  rules.forEach((r, i) => insRule.run(corpusId, r[0], r[1], r[2], `text of ${r[0]}`, i));

  // atom vocabulary — a 5-type fixture at version 1.
  persistAtomSchema(db, fixtureSchema());
  expect(currentSchemaVersion(db)).toBe(1);

  // a snapshot to satisfy cards.first_seen_snapshot_id / last_seen_snapshot_id.
  db.prepare(`INSERT INTO snapshots (id, source_type, source_uri, source_updated_at, ingested_at, printings_seen, cards_kept, status) VALUES (?,?,?,?,?,?,?,?)`)
    .run(1, 'test', 'test', 't', 't', 0, 0, 'complete');

  // the run atoms will cite only existing rules.
  db.prepare(`INSERT INTO snapshots (id, source_type, source_uri, source_updated_at, ingested_at, printings_seen, cards_kept, status) VALUES (?,?,?,?,?,?,?,?)`)
    .run(2, 'x', 'x', 'x', 'x', 0, 0, 'complete');
  const textA = 'Target creature gets -2/-2 until end of turn. You gain 2 life.';
  const textB = 'Create a 1/1 token. You gain 1 life. Draw a card.';
  const mkCard = db.prepare(
    `INSERT INTO cards (oracle_id, name, layout, cmc, type_line, colors, color_identity, keywords,
                        rarity, set_code, collector_number, oracle_hash, first_seen_snapshot_id, last_seen_snapshot_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const mkFace = db.prepare(
    `INSERT INTO card_faces (oracle_id, face_index, name, type_line, oracle_text, colors) VALUES (?,?,?,?,?,?)`,
  );
  mkCard.run('A-complete', 'Card A', 'normal', 2, 'Instant', '[]', '[]', '[]', 'common', 'TST', '1', 'hA', 1, 2);
  mkFace.run('A-complete', 0, 'Card A', 'Instant', textA, '[]');
  mkCard.run('B-partial', 'Card B', 'normal', 2, 'Sorcery', '[]', '[]', '[]', 'common', 'TST', '2', 'hB', 1, 2);
  mkFace.run('B-partial', 0, 'Card B', 'Sorcery', textB, '[]');

  // one extraction run.
  db.prepare(`INSERT INTO extraction_runs (id, started_at, provider, model, schema_version, corpus_id, packet_policy_sha, splitter_version, batch_kind, status)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(1, 't', 'test', 'test', 1, corpusId, 'sha', 1, 'golden', 'complete');

  return { db, corpusId, runId: 1, textA, textB, cA: splitOracleText(textA, 0), cB: splitOracleText(textB, 0) };
}

function insertRunAtom(
  db: DatabaseSync, runId: number, oracleId: string, face: number,
  family: string, typeKey: string, params: Record<string, unknown>,
  spanStart: number, spanEnd: number, quote: string, ruleNumbers: string[],
): void {
  db.prepare(
    `INSERT INTO atoms (run_id, oracle_id, face_index, schema_version, family, type_key, params_json,
                        span_start, span_end, quote, rule_numbers, confidence, confidence_source, oracle_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(runId, oracleId, face, 1, family, typeKey, JSON.stringify(params), spanStart, spanEnd, quote,
    JSON.stringify(ruleNumbers), 1.0, 'model', `h_${oracleId}`);
}

function atom(face: number, family: GoldenAtom['family'], typeKey: string, params: Record<string, unknown>,
              spanStart: number, spanEnd: number, quote: string, ruleNumbers: string[]): GoldenAtom {
  return { face_index: face, schema_version: 1, family, type_key: typeKey, params, span_start: spanStart, span_end: spanEnd, quote, rule_numbers: ruleNumbers, source: 'authored' };
}

describe('golden set — upsertGoldenCard', () => {
  it('is idempotent: a second upsert with the same input leaves the same atom rows', () => {
    const { db, cA } = seed();
    const card: GoldenCard = {
      oracle_id: 'A-complete', complete: true, oracle_hash: 'hA', verified_at: '2026-07-26T00:00:00Z',
      atoms: [
        atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1']),
        atom(0, 'PRODUCES', 'LIFEGAIN', { amount: 2 }, cA[1]!.span_start, cA[1]!.span_end, cA[1]!.text, ['118.2']),
      ],
    };
    upsertGoldenCard(db, card);
    const n1 = (db.prepare('SELECT COUNT(*) n FROM golden_atoms WHERE oracle_id = ?').get('A-complete') as { n: number }).n;
    upsertGoldenCard(db, card);
    const n2 = (db.prepare('SELECT COUNT(*) n FROM golden_atoms WHERE oracle_id = ?').get('A-complete') as { n: number }).n;
    expect(n2).toBe(n1);
    expect(n1).toBe(2);
    const cardRow = db.prepare('SELECT complete, oracle_hash FROM golden_cards WHERE oracle_id = ?').get('A-complete') as { complete: number; oracle_hash: string };
    expect(cardRow.complete).toBe(1);
    expect(cardRow.oracle_hash).toBe('hA');
  });

  it('the unique dedupe index rejects a duplicate atom within one input list', () => {
    const { db, cA } = seed();
    const dup: GoldenAtom = atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1']);
    const card: GoldenCard = {
      oracle_id: 'A-complete', complete: false, oracle_hash: 'hA', verified_at: 't',
      atoms: [dup, dup],   // same (face_index, family, type_key, span_start) twice
    };
    expect(() => upsertGoldenCard(db, card)).toThrow();
    // and the whole upsert rolled back: no orphan golden_cards row, no atoms.
    const cardCount = (db.prepare('SELECT COUNT(*) n FROM golden_cards WHERE oracle_id = ?').get('A-complete') as { n: number }).n;
    const atomCount = (db.prepare('SELECT COUNT(*) n FROM golden_atoms WHERE oracle_id = ?').get('A-complete') as { n: number }).n;
    expect(cardCount).toBe(0);
    expect(atomCount).toBe(0);
  });

  it('rewrites when the atom set changes across upserts', () => {
    const { db, cA } = seed();
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: false, oracle_hash: 'hA', verified_at: 't',
      atoms: [atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1'])],
    });
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: true, oracle_hash: 'hA', verified_at: 't',
      atoms: [
        atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1']),
        atom(0, 'PRODUCES', 'LIFEGAIN', { amount: 2 }, cA[1]!.span_start, cA[1]!.span_end, cA[1]!.text, ['118.2']),
      ],
    });
    const n = (db.prepare('SELECT COUNT(*) n FROM golden_atoms WHERE oracle_id = ?').get('A-complete') as { n: number }).n;
    expect(n).toBe(2);
    const complete = (db.prepare('SELECT complete FROM golden_cards WHERE oracle_id = ?').get('A-complete') as { complete: number }).complete;
    expect(complete).toBe(1);
  });
});

describe('golden set — upsertGoldenCard validates before persistence (I3, Important finding 3, first review pass)', () => {
  // Nothing invalid may ever reach golden_atoms - verifyGoldenCard is defense
  // in depth for content that arrived some other way (see the "defense in
  // depth" tests further down), not the only gate. Each case here asserts BOTH
  // the throw AND that nothing was written (no orphan golden_cards row).

  it('rejects a quote that does not slice back from oracle_text', () => {
    const { db, cA } = seed();
    expect(() =>
      upsertGoldenCard(db, {
        oracle_id: 'A-complete', complete: false, oracle_hash: 'hA', verified_at: 't',
        atoms: [atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, 'NOT THE REAL TEXT', ['115.1'])],
      }),
    ).toThrow(/does not slice back/);
    expect((db.prepare('SELECT COUNT(*) n FROM golden_cards WHERE oracle_id = ?').get('A-complete') as { n: number }).n).toBe(0);
  });

  it('rejects a rule number that is not in the corpus', () => {
    const { db, cA } = seed();
    expect(() =>
      upsertGoldenCard(db, {
        oracle_id: 'A-complete', complete: false, oracle_hash: 'hA', verified_at: 't',
        atoms: [
          atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1']),
          atom(0, 'PRODUCES', 'LIFEGAIN', { amount: 2 }, cA[1]!.span_start, cA[1]!.span_end, cA[1]!.text, ['999.9']),
        ],
      }),
    ).toThrow(/not in corpus/);
    expect((db.prepare('SELECT COUNT(*) n FROM golden_cards WHERE oracle_id = ?').get('A-complete') as { n: number }).n).toBe(0);
  });

  it('rejects an atom type unknown at write-time', () => {
    // Both the new I3 pre-check (validateGoldenAtom, which runs BEFORE the
    // transaction) and the golden_atoms FK to atom_types(schema_version,
    // family, type_key) would reject this; the pre-check fires first, so the
    // transaction/rollback machinery is never even reached.
    const { db, cA } = seed();
    expect(() =>
      upsertGoldenCard(db, {
        oracle_id: 'A-complete', complete: false, oracle_hash: 'hA', verified_at: 't',
        atoms: [
          atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1']),
          atom(0, 'PRODUCES', 'NO_SUCH_TYPE', { amount: 2 }, cA[1]!.span_start, cA[1]!.span_end, cA[1]!.text, ['118.2']),
        ],
      }),
    ).toThrow(/not in atom_types/);
    expect((db.prepare('SELECT COUNT(*) n FROM golden_cards WHERE oracle_id = ?').get('A-complete') as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM golden_atoms WHERE oracle_id = ?').get('A-complete') as { n: number }).n).toBe(0);
  });

  it('rejects invalid params', () => {
    const { db, cA } = seed();
    expect(() =>
      upsertGoldenCard(db, {
        oracle_id: 'A-complete', complete: false, oracle_hash: 'hA', verified_at: 't',
        atoms: [atom(0, 'PRODUCES', 'LIFEGAIN', { amount: true }, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['118.2'])],
      }),
    ).toThrow(/params invalid/);
    expect((db.prepare('SELECT COUNT(*) n FROM golden_cards WHERE oracle_id = ?').get('A-complete') as { n: number }).n).toBe(0);
  });
});

describe('golden set — quote and rule traceability', () => {
  it('every loaded golden atom quotes back exactly from its face oracle_text', () => {
    const { db, cA } = seed();
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: true, oracle_hash: 'hA', verified_at: 't',
      atoms: [
        atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1']),
        atom(0, 'PRODUCES', 'LIFEGAIN', { amount: 2 }, cA[1]!.span_start, cA[1]!.span_end, cA[1]!.text, ['118.2']),
      ],
    });
    const text = (db.prepare('SELECT oracle_text FROM card_faces WHERE oracle_id = ? AND face_index = 0').get('A-complete') as { oracle_text: string }).oracle_text;
    for (const card of loadGoldenSet(db)) {
      for (const a of card.atoms) {
        expect(text.slice(a.span_start, a.span_end)).toBe(a.quote);
      }
    }
  });

  it('every loaded golden atom cites rule numbers that exist in the current corpus', () => {
    const { db, corpusId, cA } = seed();
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: true, oracle_hash: 'hA', verified_at: 't',
      atoms: [atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1', '302.1'])],
    });
    for (const card of loadGoldenSet(db)) {
      for (const a of card.atoms) {
        for (const r of a.rule_numbers) {
          expect(ruleNumbersExist(db, [r], corpusId)).toBe(true);
        }
      }
    }
  });

  it('ruleNumbersExist: false for unknown and false for an empty list', () => {
    const { db, corpusId } = seed();
    expect(ruleNumbersExist(db, ['115.1'], corpusId)).toBe(true);
    expect(ruleNumbersExist(db, ['999.9'], corpusId)).toBe(false);
    expect(ruleNumbersExist(db, [], corpusId)).toBe(false);
  });
});

describe('golden set — scoreAgainstGolden (sec. 8.2)', () => {
  it('precision is computed over complete cards ONLY — a partial card does not drag it down', () => {
    const { db, cA, cB } = seed();

    // Card A: complete, 2 golden atoms, run emits exactly those 2 (all match).
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: true, oracle_hash: 'hA', verified_at: 't',
      atoms: [
        atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1']),
        atom(0, 'PRODUCES', 'LIFEGAIN', { amount: 2 }, cA[1]!.span_start, cA[1]!.span_end, cA[1]!.text, ['118.2']),
      ],
    });
    // Card B: INCOMPLETE — only 1 of its 3 clauses is recorded as a golden atom.
    upsertGoldenCard(db, {
      oracle_id: 'B-partial', complete: false, oracle_hash: 'hB', verified_at: 't',
      atoms: [atom(0, 'PRODUCES', 'TOKENS', { amount: 1 }, cB[0]!.span_start, cB[0]!.span_end, cB[0]!.text, ['701.7'])],
    });

    // Run emits: A's 2 atoms (both match A's golden), B gets 1 matching + 2 SPURIOUS
    // (card draw + lifegain — real clauses the run read but the golden record omits).
    insertRunAtom(db, 1, 'A-complete', 0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1']);
    insertRunAtom(db, 1, 'A-complete', 0, 'PRODUCES', 'LIFEGAIN', { amount: 2 }, cA[1]!.span_start, cA[1]!.span_end, cA[1]!.text, ['118.2']);
    insertRunAtom(db, 1, 'B-partial', 0, 'PRODUCES', 'TOKENS', { amount: 1 }, cB[0]!.span_start, cB[0]!.span_end, cB[0]!.text, ['701.7']);
    insertRunAtom(db, 1, 'B-partial', 0, 'PRODUCES', 'CARD_DRAW', { amount: 1 }, cB[2]!.span_start, cB[2]!.span_end, cB[2]!.text, ['701.7']);
    insertRunAtom(db, 1, 'B-partial', 0, 'PRODUCES', 'LIFEGAIN', { amount: 1 }, cB[1]!.span_start, cB[1]!.span_end, cB[1]!.text, ['118.2']);

    // B is partial: its 2 spurious atoms are EXCLUDED from precision. Only A scores.
    // A: 2 accepted, 2 matched -> precision 1.0.
    let score = scoreAgainstGolden(db, 1);
    expect(score.atom_precision).toBe(1);
    expect(score.accepted_atoms).toBe(2);          // only A's run atoms
    expect(score.matched_atoms).toBe(2);
    expect(score.complete_cards).toBe(1);
    expect(score.golden_cards_total).toBe(2);
    // recall is across all golden cards: a0, a1, b0 all matched -> 3/3.
    expect(score.atom_recall).toBe(1);
    expect(score.golden_atoms_total).toBe(3);
    expect(score.golden_atoms_matched).toBe(3);

    // Now PROMOTE B to complete. The 2 spurious atoms become false positives.
    upsertGoldenCard(db, {
      oracle_id: 'B-partial', complete: true, oracle_hash: 'hB', verified_at: 't',
      atoms: [atom(0, 'PRODUCES', 'TOKENS', { amount: 1 }, cB[0]!.span_start, cB[0]!.span_end, cB[0]!.text, ['701.7'])],
    });
    score = scoreAgainstGolden(db, 1);
    // accepted = 2 (A) + 3 (B) = 5; matched = 2 (A) + 1 (B) = 3 -> 3/5 = 0.6.
    expect(score.atom_precision).toBeCloseTo(0.6, 5);
    expect(score.accepted_atoms).toBe(5);
    expect(score.matched_atoms).toBe(3);
    expect(score.complete_cards).toBe(2);
    // recall is unchanged (still 3/3 — a0, a1, b0 all matched).
    expect(score.atom_recall).toBe(1);
  });

  it('span and citation validity are 1.0 when run atoms quote back and cite existing rules', () => {
    const { db, cA } = seed();
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: true, oracle_hash: 'hA', verified_at: 't',
      atoms: [atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1'])],
    });
    insertRunAtom(db, 1, 'A-complete', 0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1']);
    const s = scoreAgainstGolden(db, 1);
    expect(s.span_validity).toBe(1);
    expect(s.citation_in_corpus).toBe(1);
  });

  it('citation_in_corpus drops when a run atom cites a rule not in the corpus', () => {
    const { db, cA } = seed();
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: true, oracle_hash: 'hA', verified_at: 't',
      atoms: [atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1'])],
    });
    insertRunAtom(db, 1, 'A-complete', 0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['999.9']); // not in corpus
    const s = scoreAgainstGolden(db, 1);
    expect(s.citation_in_corpus).toBe(0);
  });

  it('throws for an unknown run_id', () => {
    const { db } = seed();
    expect(() => scoreAgainstGolden(db, 999)).toThrow(/no extraction_runs row/);
  });

  it('precision is 1.0 (vacuous) when a complete card has zero run atoms', () => {
    const { db, cA } = seed();
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: true, oracle_hash: 'hA', verified_at: 't',
      atoms: [atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1'])],
    });
    // no run atoms at all
    const s = scoreAgainstGolden(db, 1);
    expect(s.accepted_atoms).toBe(0);
    expect(s.atom_precision).toBe(1);       // no false positives possible
    expect(s.atom_recall).toBe(0);          // 0 golden atoms matched / 1 total
  });
});

describe('golden set — verifyGoldenCard (REJECTS, never warns)', () => {
  it('accepts a well-formed complete card whose clauses are all covered', () => {
    const { db, cA } = seed();
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: true, oracle_hash: 'hA', verified_at: 't',
      atoms: [
        atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1']),
        atom(0, 'PRODUCES', 'LIFEGAIN', { amount: 2 }, cA[1]!.span_start, cA[1]!.span_end, cA[1]!.text, ['118.2']),
      ],
    });
    const r = verifyGoldenCard(db, 'A-complete');
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.atoms).toBe(2);
    expect(r.non_reminder_clauses).toBe(2);
  });

  it('rejects a card with no golden entry', () => {
    const { db } = seed();
    const r = verifyGoldenCard(db, 'A-complete');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/no golden_cards row/);
  });

  it('rejects an atom whose type existed at WRITE TIME but not at the CURRENT schema_version (Important finding 5, first review pass)', () => {
    // Distinct from upsertGoldenCard's own I3 pre-check: that check validates
    // against whatever schema_version is current AT WRITE TIME, which this
    // atom legitimately passed. The failure mode verify alone can catch is
    // DRIFT: the vocabulary is promoted to v2 sometime later, and v2 doesn't
    // carry this type forward. The atom's own `schema_version` column still
    // reads 1 (unchanged - it's a historical fact about when it was written);
    // `currentSchemaVersion(db)` is now 2, and `verifyGoldenCard` must recheck
    // against the LIVE version, not the one stamped on the row.
    const { db, cA } = seed();
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: true, oracle_hash: 'hA', verified_at: 't',
      atoms: [
        atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1']),
        atom(0, 'PRODUCES', 'LIFEGAIN', { amount: 2 }, cA[1]!.span_start, cA[1]!.span_end, cA[1]!.text, ['118.2']),
      ],
    });
    // Promote the vocabulary to v2, carrying LIFEGAIN forward but retiring
    // TARGETED_REMOVAL - simulates a real schema promotion (Task 2's process).
    persistAtomSchema(db, {
      schema_version: 2,
      types: [{ family: 'PRODUCES', type_key: 'LIFEGAIN', label: 'life', params_schema: amountParams, provenance: 'spec_4_1', evidence: 'fixture v2' }],
    });
    const r = verifyGoldenCard(db, 'A-complete');
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/INTERACTION\.TARGETED_REMOVAL not in atom_types at current schema_version 2/);
    expect(r.errors.join('\n')).not.toMatch(/PRODUCES\.LIFEGAIN not in atom_types/);
  });

  it('rejects invalid params on a row written by a path other than upsertGoldenCard (Important finding 5, first review pass)', () => {
    // upsertGoldenCard's own I3 pre-check (Important finding 3) means invalid
    // params can no longer reach golden_atoms through that function - so this
    // exercises verify's INDEPENDENT re-check by writing directly with raw SQL,
    // simulating content that entered by some other path (a migration, a
    // direct repair) and confirming verify still catches it as defense in depth.
    const { db, cA } = seed();
    db.prepare('INSERT INTO golden_cards (oracle_id, complete, oracle_hash, verified_at) VALUES (?,?,?,?)')
      .run('A-complete', 0, 'hA', 't');
    db.prepare(
      `INSERT INTO golden_atoms
         (oracle_id, face_index, schema_version, family, type_key, params_json,
          span_start, span_end, quote, rule_numbers, oracle_hash, source, verified_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'A-complete', 0, 1, 'PRODUCES', 'LIFEGAIN', JSON.stringify({ amount: true }),
      cA[1]!.span_start, cA[1]!.span_end, cA[1]!.text, JSON.stringify(['118.2']), 'hA', 'authored', 't',
    );
    // complete = 0, so the coverage check (clause 0 has no atom) doesn't fire -
    // isolates this test to the params check alone.
    const r = verifyGoldenCard(db, 'A-complete');
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/params invalid/);
  });

  it('rejects a STALE golden entry whose oracle_hash no longer matches the live card (Important finding 7, first review pass)', () => {
    const { db, cA } = seed();
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: true, oracle_hash: 'hA', verified_at: 't',
      atoms: [
        atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1']),
        atom(0, 'PRODUCES', 'LIFEGAIN', { amount: 2 }, cA[1]!.span_start, cA[1]!.span_end, cA[1]!.text, ['118.2']),
      ],
    });
    // Simulate errata: the live card's oracle_hash changes (card_faces text is
    // left as-is here to isolate this assertion from the quote slice-back check).
    db.prepare('UPDATE cards SET oracle_hash = ? WHERE oracle_id = ?').run('NEW-HASH-AFTER-ERRATA', 'A-complete');
    const r = verifyGoldenCard(db, 'A-complete');
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/STALE/);
  });

  it('rejects an uncovered non-reminder clause on a card marked complete', () => {
    const { db, cA } = seed();
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: true, oracle_hash: 'hA', verified_at: 't',
      atoms: [atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1'])],
      // clause 1 ("You gain 2 life.") is NOT covered -> reject, because complete = true
      // claims exhaustiveness it doesn't have.
    });
    const r = verifyGoldenCard(db, 'A-complete');
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/uncovered clause face 0 idx 1/);
  });

  it('a legitimately INCOMPLETE card is NOT rejected for uncovered clauses (Important finding 4, first review pass)', () => {
    // sec. 8.2 requires partial golden cards to exist (precision is restricted
    // to `complete` cards specifically because partials are in the set); the
    // coverage-exhaustiveness check must only apply once a card claims
    // complete = true. An honestly-partial card (complete = false) with a
    // valid-but-incomplete atom set must still validate.
    const { db, cA } = seed();
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: false, oracle_hash: 'hA', verified_at: 't',
      atoms: [atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1'])],
      // clause 1 is deliberately NOT covered - legitimate for an incomplete card.
    });
    const r = verifyGoldenCard(db, 'A-complete');
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.atoms).toBe(1);
    expect(r.non_reminder_clauses).toBe(2);   // still reported, just not enforced
  });

  it('accepts a card with zero non-reminder clauses (empty oracle_text, e.g. meld back face)', () => {
    const { db } = seed();
    db.prepare('INSERT INTO cards (oracle_id, name, layout, cmc, type_line, colors, color_identity, keywords, rarity, set_code, collector_number, oracle_hash, first_seen_snapshot_id, last_seen_snapshot_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('Z-empty', 'Empty Face', 'meld', 0, 'Artifact', '[]', '[]', '[]', 'common', 'T', '9', 'hZ', 1, 2);
    db.prepare('INSERT INTO card_faces (oracle_id, face_index, name, type_line, oracle_text, colors) VALUES (?,?,?,?,?,?)')
      .run('Z-empty', 0, 'Empty Face', 'Artifact', '', '[]');
    upsertGoldenCard(db, { oracle_id: 'Z-empty', complete: true, oracle_hash: 'hZ', verified_at: 't', atoms: [] });
    const r = verifyGoldenCard(db, 'Z-empty');
    expect(r.ok).toBe(true);
    expect(r.atoms).toBe(0);
    expect(r.non_reminder_clauses).toBe(0);
  });
});

describe('golden set — unclassified-candidate escape hatch (Step 2, item 4)', () => {
  it('a recorded unclassified candidate satisfies coverage without an atom', () => {
    const { db, cA } = seed();
    // Only clause 0 gets a real atom; clause 1 ("You gain 2 life.") is recorded as
    // an honest unclassified candidate instead of a forced-fit atom.
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: true, oracle_hash: 'hA', verified_at: 't',
      atoms: [atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1'])],
    });
    recordUnclassifiedCandidate(db, {
      oracle_id: 'A-complete', face_index: 0,
      span_start: cA[1]!.span_start, span_end: cA[1]!.span_end, quote: cA[1]!.text,
      proposed_label: 'life-gain-side-clause', rationale: 'no enum type fits this clause exactly',
      oracle_hash: 'hA',
    });
    const r = verifyGoldenCard(db, 'A-complete');
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('goldenDraftingRunId is idempotent - reuses the same placeholder run', () => {
    // seed() already inserts its own batch_kind='golden' run (provider='test', for
    // the scoring tests' extraction_runs FK) - goldenDraftingRunId's own filter
    // additionally requires provider='human', so it must not reuse that row.
    const { db } = seed();
    const id1 = goldenDraftingRunId(db);
    const id2 = goldenDraftingRunId(db);
    expect(id2).toBe(id1);
    const count = (
      db.prepare("SELECT COUNT(*) n FROM extraction_runs WHERE batch_kind = 'golden' AND provider = 'human'").get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it('an unclassified candidate recorded against a DIFFERENT oracle_hash does not satisfy coverage', () => {
    // complete: true so the coverage check actually runs (Important finding 4
    // gates it on complete = 1) - this test is specifically about the hash
    // scoping, not about whether coverage is enforced at all.
    const { db, cA } = seed();
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: true, oracle_hash: 'hA', verified_at: 't',
      atoms: [atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1'])],
    });
    recordUnclassifiedCandidate(db, {
      oracle_id: 'A-complete', face_index: 0,
      span_start: cA[1]!.span_start, span_end: cA[1]!.span_end, quote: cA[1]!.text,
      proposed_label: 'stale', rationale: 'recorded against a since-changed printing',
      oracle_hash: 'STALE-HASH',
    });
    const r = verifyGoldenCard(db, 'A-complete');
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/uncovered clause face 0 idx 1/);
  });

  it('CRITICAL (first review pass, finding 1): an unclassified_clauses row under a DIFFERENT run_id - even one that happens to share batch_kind = \'golden\' - does NOT satisfy coverage', () => {
    // This is the exact failure mode the finding describes: Task 9's model
    // runs will write to unclassified_clauses with the same oracle_id and the
    // same oracle_hash a golden card carries. Without a run_id filter scoped
    // to the EXACT goldenDraftingRunId placeholder, a model run's "can't
    // classify this" would silently validate the golden card it's meant to be
    // audited against. seed()'s own extraction_runs row (id = runId) is
    // batch_kind = 'golden' too (provider = 'test', for the scoring tests'
    // FK) - proving the run_id check is exact, not just a label match, is the
    // whole point of using it here rather than a run with some other batch_kind.
    const { db, cA, runId } = seed();
    upsertGoldenCard(db, {
      oracle_id: 'A-complete', complete: true, oracle_hash: 'hA', verified_at: 't',
      atoms: [atom(0, 'INTERACTION', 'TARGETED_REMOVAL', {}, cA[0]!.span_start, cA[0]!.span_end, cA[0]!.text, ['115.1'])],
    });
    db.prepare(
      `INSERT INTO unclassified_clauses
         (run_id, oracle_id, face_index, span_start, span_end, quote, proposed_label, rationale, oracle_hash, status)
       VALUES (?,?,?,?,?,?,?,?,?,'open')`,
    ).run(runId, 'A-complete', 0, cA[1]!.span_start, cA[1]!.span_end, cA[1]!.text, 'model-guess', 'a model run rationale', 'hA');
    // No recordUnclassifiedCandidate call was made, so goldenDraftingRunId's
    // placeholder run doesn't exist yet - the model run's row above must not
    // be mistaken for it.
    const r = verifyGoldenCard(db, 'A-complete');
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/uncovered clause face 0 idx 1/);
  });
});