import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/client.js';
import { persistAtomSchema, type AtomSchema } from '../src/atoms/schema.js';
import { buildServer } from '../src/server/app.js';
import {
  buildDraftingPacket,
  writePacket,
  writeProposal,
  recordLookup,
  readReview,
  type DraftProposal,
} from '../src/atoms/goldenDraft.js';

/**
 * The adjudication routes (`/api/golden/*`). Mechanics only, like the rest of the
 * golden-set suite: what is asserted is that the UI cannot reach past the gates,
 * never that any particular atom is a correct reading.
 *
 * The load-bearing cases are the refusals — accepting without an explicit
 * completeness claim, accepting a draft that does not validate, striking items
 * without saying why, rejecting without a note. Each of those is a way the review
 * surface could quietly become a rubber stamp, which is the one failure mode this
 * whole path exists to prevent.
 */

const EMPTY_PARAMS = { type: 'object', properties: {}, additionalProperties: false } as const;
const amountParams = {
  type: 'object', properties: { amount: { type: ['integer', 'string'] } },
  required: ['amount'], additionalProperties: false,
} as const;

function fixtureSchema(): AtomSchema {
  return {
    schema_version: 1,
    types: [
      { family: 'COMBAT', type_key: 'TRAMPLE', label: 'trample', params_schema: EMPTY_PARAMS, provenance: 'cr_702', evidence: 'fixture' },
      { family: 'PRODUCES', type_key: 'LIFEGAIN', label: 'life', params_schema: amountParams, provenance: 'spec_4_1', evidence: 'fixture' },
    ],
  };
}

function seed(): { db: DatabaseSync; text: string } {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO rules_corpus (source_uri, effective_date, sha256, fetched_at, section_count, rule_count, glossary_count, is_current)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('test', 't', 'sha', 't', 1, 3, 1, 1);
  const corpusId = (db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as { id: number }).id;

  const insRule = db.prepare(
    `INSERT INTO rules (corpus_id, number, section_number, subsection_number, subsection_title, text, ordinal)
     VALUES (?,?,?,?,?,?,?)`,
  );
  const rules: Array<[string, string, string, string, string]> = [
    ['702.19', '702', '702.19', 'Trample', ''],
    ['702.19a', '702', '702.19', 'Trample', 'Trample is a static ability that modifies combat damage assignment.'],
    ['118.7', '118', '118.7', 'Cost reduction', 'Costs may be reduced by effects.'],
  ];
  rules.forEach((r, i) => insRule.run(corpusId, r[0], r[1], r[2], r[3], r[4], i));

  db.prepare('INSERT INTO glossary_entries (corpus_id, term, term_key, definition, cross_refs) VALUES (?,?,?,?,?)')
    .run(corpusId, 'Trample', 'trample', 'A keyword ability. See rule 702.19.', JSON.stringify(['702.19']));
  db.prepare('INSERT INTO rule_term_index (corpus_id, term, term_key, source, rule_numbers, definition, evidence) VALUES (?,?,?,?,?,?,?)')
    .run(corpusId, 'Trample', 'trample', 'glossary', JSON.stringify(['702.19']), 'A keyword ability. See rule 702.19.', 'fixture');

  persistAtomSchema(db, fixtureSchema());

  db.prepare(
    `INSERT INTO snapshots (id, source_type, source_uri, source_updated_at, ingested_at, printings_seen, cards_kept, status)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(1, 'test', 'test', 't', 't', 0, 0, 'complete');

  const text = 'Trample\nYou gain 2 life.';
  db.prepare(
    `INSERT INTO cards (oracle_id, name, layout, cmc, type_line, colors, color_identity, keywords,
                        rarity, set_code, collector_number, oracle_hash, first_seen_snapshot_id, last_seen_snapshot_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('CARD-1', 'Test Card', 'normal', 2, 'Creature', '[]', '[]', '["Trample"]', 'common', 'TST', '1', 'hash-1', 1, 1);
  db.prepare('INSERT INTO card_faces (oracle_id, face_index, name, type_line, oracle_text, colors) VALUES (?,?,?,?,?,?)')
    .run('CARD-1', 0, 'Test Card', 'Creature', text, '[]');

  return { db, text };
}

function proposal(over: Partial<DraftProposal> = {}): DraftProposal {
  return {
    oracle_id: 'CARD-1',
    oracle_hash: 'hash-1',
    schema_version: 1,
    drafted_by: 'test-drafter',
    drafted_at: '2026-09-06T00:00:00Z',
    claims_complete: true,
    atoms: [
      {
        face_index: 0, family: 'COMBAT', type_key: 'TRAMPLE', params: {},
        span_start: 0, span_end: 7, quote: 'Trample',
        rule_numbers: ['702.19a'], rationale: '702.19a defines the ability.',
      },
      {
        face_index: 0, family: 'PRODUCES', type_key: 'LIFEGAIN', params: { amount: 2 },
        span_start: 8, span_end: 24, quote: 'You gain 2 life.',
        rule_numbers: ['118.7'], rationale: 'placeholder citation, read from the fixture corpus.',
      },
    ],
    unclassified: [],
    notes: 'a doubt worth surfacing',
    ...over,
  };
}

/** Stages a proposal the way the CLI would: packet on disk, then the lookup that makes 118.7 citable. */
function stage(db: DatabaseSync, over: Partial<DraftProposal> = {}): DraftProposal {
  writePacket(buildDraftingPacket(db, 'CARD-1'));
  recordLookup('CARD-1', { kind: 'rule', query: '118.7', returned: ['118.7'] });
  const p = proposal(over);
  writeProposal(p);
  return p;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'golden-routes-'));
  process.env.GOLDEN_DRAFTS_DIR = tmp;
});
afterEach(() => {
  delete process.env.GOLDEN_DRAFTS_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

const atomCount = (db: DatabaseSync): number =>
  (db.prepare('SELECT COUNT(*) n FROM golden_atoms').get() as { n: number }).n;

describe('GET /api/golden/queue', () => {
  it('reports the drafted card with its validation summary', async () => {
    const { db } = seed();
    stage(db);
    const res = await buildServer(db).inject({ url: '/api/golden/queue' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const row = body.items.find((i: { oracle_id: string }) => i.oracle_id === 'CARD-1');
    expect(row.stage).toBe('drafted');
    expect(row.atoms).toBe(2);
    expect(row.valid).toBe(true);
    expect(row.errors).toBe(0);
    // The drafter's claim is surfaced for triage, never as a decision.
    expect(row.claims_complete).toBe(true);
    expect(row.has_notes).toBe(true);
    expect(body.counts.drafted).toBeGreaterThanOrEqual(1);
    expect(body.written).toEqual({ total: 0, complete: 0 });
  });

  it('flags a draft whose citation was never read (the I1 gate) rather than hiding it', async () => {
    const { db } = seed();
    const p = proposal();
    p.atoms[1]!.rule_numbers = ['702.19'];   // in the packet
    writePacket(buildDraftingPacket(db, 'CARD-1'));
    p.atoms[0]!.rule_numbers = ['999.9'];    // never read, and not in the corpus
    writeProposal(p);

    const res = await buildServer(db).inject({ url: '/api/golden/queue' });
    const row = res.json().items.find((i: { oracle_id: string }) => i.oracle_id === 'CARD-1');
    expect(row.valid).toBe(false);
    expect(row.errors).toBeGreaterThan(0);
  });
});

describe('GET /api/golden/drafts/:id', () => {
  it('returns each atom with its vocabulary label and the full text of every cited rule', async () => {
    const { db } = seed();
    stage(db);
    const res = await buildServer(db).inject({ url: '/api/golden/drafts/CARD-1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.name).toBe('Test Card');
    expect(body.faces[0].clauses.length).toBeGreaterThan(0);
    expect(body.atoms[0].label).toBe('trample');
    expect(body.atoms[0].rules[0].number).toBe('702.19a');
    expect(body.atoms[0].rules[0].text).toMatch(/static ability/);
    // 702.19a came from the packet; 118.7 only from the lookup log — the
    // distinction is what marks a kernel candidate (sec. 3.4) in the UI.
    expect(body.atoms[0].rules[0].in_packet).toBe(true);
    expect(body.atoms[1].rules[0].number).toBe('118.7');
    expect(body.atoms[1].rules[0].in_packet).toBe(false);
    expect(body.validation.ok).toBe(true);
    expect(body.review).toBeNull();
  });

  it('404s when nothing is staged', async () => {
    const { db } = seed();
    const res = await buildServer(db).inject({ url: '/api/golden/drafts/CARD-1' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/golden/drafts/:id/accept', () => {
  it('refuses when the completeness claim is not sent explicitly', async () => {
    const { db } = seed();
    stage(db);
    const res = await buildServer(db).inject({
      method: 'POST', url: '/api/golden/drafts/CARD-1/accept', payload: { note: 'looks fine' },
    });
    expect(res.statusCode).toBe(400);
    expect(atomCount(db)).toBe(0);
  });

  it('writes the card as partial, and records the review', async () => {
    const { db } = seed();
    stage(db);
    const res = await buildServer(db).inject({
      method: 'POST', url: '/api/golden/drafts/CARD-1/accept', payload: { complete: false, note: 'read both' },
    });
    expect(res.statusCode).toBe(200);
    expect(atomCount(db)).toBe(2);
    const row = db.prepare('SELECT complete FROM golden_cards WHERE oracle_id = ?').get('CARD-1') as { complete: number };
    expect(row.complete).toBe(0);
    expect(readReview('CARD-1')?.decision).toBe('accepted');
  });

  it('refuses `complete` while a non-reminder clause is uncovered, writing nothing', async () => {
    const { db } = seed();
    const p = stage(db, { claims_complete: false });
    p.atoms = [p.atoms[0]!];
    writeProposal(p);
    const res = await buildServer(db).inject({
      method: 'POST', url: '/api/golden/drafts/CARD-1/accept', payload: { complete: true },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/uncovered/);
    expect(atomCount(db)).toBe(0);
  });

  it('refuses a draft that does not validate, and says which gate refused', async () => {
    const { db } = seed();
    const p = stage(db);
    p.atoms[0]!.quote = 'Flying';       // no longer slices back from the face text
    writeProposal(p);
    const res = await buildServer(db).inject({
      method: 'POST', url: '/api/golden/drafts/CARD-1/accept', payload: { complete: false },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/does not validate/);
    expect(atomCount(db)).toBe(0);
  });

  it('writes only the included atoms when the owner strikes one, and names the exclusion', async () => {
    const { db } = seed();
    stage(db);
    const res = await buildServer(db).inject({
      method: 'POST',
      url: '/api/golden/drafts/CARD-1/accept',
      payload: { complete: false, note: 'LIFEGAIN reading is doubtful', exclude: { atoms: [1] } },
    });
    expect(res.statusCode).toBe(200);
    expect(atomCount(db)).toBe(1);
    const kept = db.prepare('SELECT type_key FROM golden_atoms').get() as { type_key: string };
    expect(kept.type_key).toBe('TRAMPLE');

    const review = readReview('CARD-1');
    expect(review?.excluded?.[0]?.summary).toMatch(/PRODUCES\.LIFEGAIN/);
    // The staged draft is left untouched, so the struck atom can be redrafted.
    expect(res.json().excluded).toHaveLength(1);
  });

  it('requires a note when anything is struck', async () => {
    const { db } = seed();
    stage(db);
    const res = await buildServer(db).inject({
      method: 'POST', url: '/api/golden/drafts/CARD-1/accept', payload: { complete: false, exclude: { atoms: [1] } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/requires a note/);
    expect(atomCount(db)).toBe(0);
  });

  it('refuses an exclusion index that is not in the proposal', async () => {
    const { db } = seed();
    stage(db);
    const res = await buildServer(db).inject({
      method: 'POST',
      url: '/api/golden/drafts/CARD-1/accept',
      payload: { complete: false, note: 'stale client', exclude: { atoms: [7] } },
    });
    expect(res.statusCode).toBe(422);
    expect(atomCount(db)).toBe(0);
  });

  it('refuses to write an empty card when everything is struck', async () => {
    const { db } = seed();
    stage(db);
    const res = await buildServer(db).inject({
      method: 'POST',
      url: '/api/golden/drafts/CARD-1/accept',
      payload: { complete: false, note: 'all wrong', exclude: { atoms: [0, 1] } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/reject the draft instead/);
    expect(atomCount(db)).toBe(0);
  });

  /**
   * The other emptiness. A vanilla creature has an empty `oracle_text`, so its
   * face yields zero clauses and there is no span for an atom to attach to — the
   * correct draft proposes nothing, and accepting it asserts "this card yields no
   * atoms". That assertion is the only thing that scores a provider for inventing
   * an atom (`scoreRun` counts run atoms on a complete card as the precision
   * denominator while the golden side contributes none), so the empty-card guard
   * must fire on exclusions rather than on emptiness.
   */
  it('accepts a draft that proposed nothing on a card with no oracle text', async () => {
    const { db } = seed();
    db.prepare(
      `INSERT INTO cards (oracle_id, name, layout, cmc, type_line, colors, color_identity, keywords,
                          rarity, set_code, collector_number, oracle_hash, first_seen_snapshot_id, last_seen_snapshot_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('CARD-2', 'Vanilla', 'normal', 4, 'Creature', '[]', '[]', '[]', 'common', 'TST', '2', 'hash-2', 1, 1);
    db.prepare('INSERT INTO card_faces (oracle_id, face_index, name, type_line, oracle_text, colors) VALUES (?,?,?,?,?,?)')
      .run('CARD-2', 0, 'Vanilla', 'Creature', '', '[]');

    writePacket(buildDraftingPacket(db, 'CARD-2'));
    writeProposal({
      oracle_id: 'CARD-2', oracle_hash: 'hash-2', schema_version: 1,
      drafted_by: 'test-drafter', drafted_at: '2026-09-06T00:00:00Z',
      claims_complete: true, atoms: [], unclassified: [],
      notes: 'vanilla: no oracle text, so no clauses and nothing to attach an atom to',
    });

    const res = await buildServer(db).inject({
      method: 'POST', url: '/api/golden/drafts/CARD-2/accept', payload: { complete: true },
    });
    expect(res.statusCode).toBe(200);
    const card = db.prepare('SELECT complete FROM golden_cards WHERE oracle_id = ?').get('CARD-2') as
      | { complete: number }
      | undefined;
    expect(card?.complete).toBe(1);
    expect(atomCount(db)).toBe(0);
  });

  it('still refuses an empty card when the emptiness came from striking, not from the draft', async () => {
    const { db } = seed();
    stage(db, { unclassified: [] });
    const res = await buildServer(db).inject({
      method: 'POST',
      url: '/api/golden/drafts/CARD-1/accept',
      payload: { complete: false, note: 'every atom misreads the card', exclude: { atoms: [0, 1] } },
    });
    expect(res.statusCode).toBe(422);
    expect(db.prepare('SELECT COUNT(*) n FROM golden_cards').get()).toEqual({ n: 0 });
  });
});

describe('POST /api/golden/drafts/:id/reject', () => {
  it('requires a note', async () => {
    const { db } = seed();
    stage(db);
    const res = await buildServer(db).inject({
      method: 'POST', url: '/api/golden/drafts/CARD-1/reject', payload: { note: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(readReview('CARD-1')).toBeUndefined();
  });

  it('records the rejection and writes nothing to the database', async () => {
    const { db } = seed();
    stage(db);
    const res = await buildServer(db).inject({
      method: 'POST', url: '/api/golden/drafts/CARD-1/reject', payload: { note: 'RECURSION is the wrong fit' },
    });
    expect(res.statusCode).toBe(200);
    const review = readReview('CARD-1');
    expect(review?.decision).toBe('rejected');
    expect(review?.note).toBe('RECURSION is the wrong fit');
    expect(atomCount(db)).toBe(0);
  });
});
