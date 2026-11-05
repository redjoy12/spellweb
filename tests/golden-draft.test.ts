import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/client.js';
import { persistAtomSchema } from '../src/atoms/schema.js';
import type { AtomSchema } from '../src/atoms/schema.js';
import {
  buildDraftingPacket,
  writePacket,
  writeProposal,
  validateProposal,
  acceptProposal,
  rejectProposal,
  recordLookup,
  readReview,
  ledger,
  draftsDir,
} from '../src/atoms/goldenDraft.js';
import type { DraftProposal } from '../src/atoms/goldenDraft.js';

/**
 * Mechanics-only, like `tests/golden.test.ts`: the CONTENT of a draft is
 * adjudicated by the project owner, never asserted here. What these tests pin
 * down is the machinery that makes assisted drafting safe —
 *
 *  - the packet is built from the UNGATED corpus and carries readable rule text
 *  - the READ GATE rejects a citation that was never read (the I1 protection)
 *  - a proposal reaches `golden_atoms` only through `acceptProposal`
 *
 * Every test runs against an in-memory DB and a temp staging root, so neither
 * `data/app.db` nor `data/golden-drafts/` is touched.
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

/**
 * A synthetic corpus shaped like the real one in the two ways that matter here:
 * a subsection HEADER with empty text whose body lives in lettered children
 * (702.19 / 702.19a-b), and a decoy subsection sharing its numeric prefix
 * (702.190 / 702.190a) that a `LIKE '702.19%'` match would wrongly pull in.
 */
function seed(): { db: DatabaseSync; corpusId: number; text: string } {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO rules_corpus (source_uri, effective_date, sha256, fetched_at, section_count, rule_count, glossary_count, is_current)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('test', 't', 'sha', 't', 1, 6, 1, 1);
  const corpusId = (db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as { id: number }).id;

  const insRule = db.prepare(
    `INSERT INTO rules (corpus_id, number, section_number, subsection_number, subsection_title, text, ordinal)
     VALUES (?,?,?,?,?,?,?)`,
  );
  const rules: Array<[string, string, string, string, string]> = [
    ['702.19', '702', '702.19', 'Trample', ''],
    ['702.19a', '702', '702.19', 'Trample', 'Trample is a static ability that modifies combat damage assignment.'],
    ['702.19b', '702', '702.19', 'Trample', 'Excess damage may be assigned to the defending player.'],
    ['702.190', '702', '702.190', 'Decoy', ''],
    ['702.190a', '702', '702.190', 'Decoy', 'A decoy rule that shares a numeric prefix with 702.19.'],
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

  return { db, corpusId, text };
}

/** A valid two-atom proposal covering both clauses of the fixture card. */
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
    notes: '',
    ...over,
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'golden-draft-'));
  process.env.GOLDEN_DRAFTS_DIR = tmp;
});
afterEach(() => {
  delete process.env.GOLDEN_DRAFTS_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

describe('drafting packet', () => {
  it('carries readable rule text: an empty subsection header pulls in its body', () => {
    const { db } = seed();
    const packet = buildDraftingPacket(db, 'CARD-1');
    const numbers = packet.rules.map((r) => r.number);
    expect(numbers).toContain('702.19');
    expect(numbers).toContain('702.19a');
    expect(numbers).toContain('702.19b');
    // The header itself is empty; the body is what makes the citation readable.
    expect(packet.rules.find((r) => r.number === '702.19')!.text).toBe('');
    expect(packet.rules.find((r) => r.number === '702.19a')!.text).not.toBe('');
  });

  it('does not pull in a subsection that merely shares a numeric prefix', () => {
    const { db } = seed();
    const numbers = buildDraftingPacket(db, 'CARD-1').rules.map((r) => r.number);
    // `number LIKE '702.19%'` would match these; `subsection_number = '702.19'` does not.
    expect(numbers).not.toContain('702.190');
    expect(numbers).not.toContain('702.190a');
  });

  it('splits the clauses and points at the shared vocabulary rather than inlining it', () => {
    const { db } = seed();
    const packet = buildDraftingPacket(db, 'CARD-1');
    expect(packet.faces).toHaveLength(1);
    expect(packet.faces[0]!.clauses.length).toBeGreaterThanOrEqual(2);
    expect(packet.vocabulary_count).toBe(2);
    expect(existsSync(packet.vocabulary_path)).toBe(true);
    expect(JSON.parse(readFileSync(packet.vocabulary_path, 'utf8')).types).toHaveLength(2);
  });
});

describe('the read gate — a citation must have been read, not recalled', () => {
  it('rejects a cited rule that is in the corpus but in neither the packet nor the lookup log', () => {
    const { db } = seed();
    writePacket(buildDraftingPacket(db, 'CARD-1'));
    // 118.7 exists in the corpus, so `ruleNumbersExist` passes — but nothing in
    // this card's materials ever showed it. That is the memory-sourced case.
    const p = proposal();
    writeProposal(p);
    const v = validateProposal(db, p);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(/cited without reading \(I1\).*118\.7/s);
  });

  it('accepts the same citation once it has been looked up', () => {
    const { db } = seed();
    writePacket(buildDraftingPacket(db, 'CARD-1'));
    recordLookup('CARD-1', { kind: 'search', query: 'cost', returned: ['118.7'] });
    const p = proposal();
    writeProposal(p);
    const v = validateProposal(db, p);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('warns — but does not reject — when a read citation is beyond term matching (a kernel candidate)', () => {
    const { db } = seed();
    writePacket(buildDraftingPacket(db, 'CARD-1'));
    recordLookup('CARD-1', { kind: 'rule', query: '118.7', returned: ['118.7'] });
    const p = proposal();
    writeProposal(p);
    const v = validateProposal(db, p);
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/kernel candidates.*118\.7/);
  });
});

describe('proposal validation', () => {
  function stagedValid(db: DatabaseSync): DraftProposal {
    writePacket(buildDraftingPacket(db, 'CARD-1'));
    recordLookup('CARD-1', { kind: 'rule', query: '118.7', returned: ['118.7'] });
    return proposal();
  }

  it('rejects a quote that does not slice back from the oracle text', () => {
    const { db } = seed();
    const p = stagedValid(db);
    p.atoms[0]!.quote = 'Flying';
    writeProposal(p);
    expect(validateProposal(db, p).errors.join(' ')).toMatch(/quote does not slice back/);
  });

  it('rejects a type that is not in the vocabulary at the current schema_version', () => {
    const { db } = seed();
    const p = stagedValid(db);
    p.atoms[0]!.type_key = 'NOT_A_REAL_TYPE';
    writeProposal(p);
    expect(validateProposal(db, p).errors.join(' ')).toMatch(/not in atom_types/);
  });

  it('rejects params that do not validate against the type schema', () => {
    const { db } = seed();
    const p = stagedValid(db);
    p.atoms[1]!.params = {};                       // LIFEGAIN requires `amount`
    writeProposal(p);
    expect(validateProposal(db, p).errors.join(' ')).toMatch(/params invalid/);
  });

  /**
   * `golden_atoms` is uniquely indexed on
   * (oracle_id, face_index, family, type_key, span_start). Two atoms of the same
   * type at the same offset therefore cannot both be written, however different
   * their params — a real case: a dual land whose one clause adds {G} OR {U}, and
   * whose params enum offers no "one of these two" colour. Before this check the
   * proposal staged VALID and died on a raw SQLite constraint error part-way
   * through --accept, which is exactly the "validate before the write" contract
   * this module exists to keep. The drafting-time fix is a narrower span per atom.
   */
  it('rejects two atoms that share a storage key, whatever their params', () => {
    const { db } = seed();
    const p = stagedValid(db);
    p.atoms[1] = { ...p.atoms[0]!, params: {}, rationale: 'same type, same span, different params.' };
    writeProposal(p);
    const v = validateProposal(db, p);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/duplicate storage key/);
  });

  it('allows the same type twice on one face at different spans', () => {
    const { db } = seed();
    const p = stagedValid(db);
    // 'Trample' at 0-7 and the word 'life' at 17-21: same type, different offsets.
    p.atoms[1] = {
      face_index: 0, family: 'COMBAT', type_key: 'TRAMPLE', params: {},
      span_start: 17, span_end: 21, quote: 'life',
      rule_numbers: ['702.19a'], rationale: 'second instance at a distinct span.',
    };
    writeProposal(p);
    expect(validateProposal(db, p).errors.join(' ')).not.toMatch(/duplicate storage key/);
  });

  it('rejects an atom with no rationale — an unexplained atom cannot be adjudicated', () => {
    const { db } = seed();
    const p = stagedValid(db);
    p.atoms[0]!.rationale = '   ';
    writeProposal(p);
    expect(validateProposal(db, p).errors.join(' ')).toMatch(/empty rationale/);
  });

  it('rejects a stale draft whose oracle_hash no longer matches the card', () => {
    const { db } = seed();
    const p = stagedValid(db);
    p.oracle_hash = 'stale-hash';
    writeProposal(p);
    expect(validateProposal(db, p).errors.join(' ')).toMatch(/stale draft/);
  });

  it('rejects an uncovered clause when the draft claims completeness, and only warns when it does not', () => {
    const { db } = seed();
    const p = stagedValid(db);
    p.atoms = [p.atoms[0]!];                        // drop the lifegain atom

    writeProposal(p);
    const claimed = validateProposal(db, p);
    expect(claimed.ok).toBe(false);
    expect(claimed.errors.join(' ')).toMatch(/claims_complete but clause/);
    expect(claimed.uncovered_clauses).toBe(1);

    const honest = { ...p, claims_complete: false };
    writeProposal(honest);
    const partial = validateProposal(db, honest);
    expect(partial.ok).toBe(true);                  // a partial card is legitimate (sec. 8.2)
    expect(partial.warnings.join(' ')).toMatch(/uncovered clause/);
  });

  it('counts an unclassified candidate as covering its clause', () => {
    const { db } = seed();
    const p = stagedValid(db);
    p.atoms = [p.atoms[0]!];
    p.unclassified = [{
      face_index: 0, span_start: 8, span_end: 24, quote: 'You gain 2 life.',
      proposed_label: 'LIFE_TOTAL_CHANGE', rationale: 'no fit in the fixture vocabulary',
    }];
    writeProposal(p);
    const v = validateProposal(db, p);
    expect(v.ok).toBe(true);
    expect(v.uncovered_clauses).toBe(0);
  });
});

describe('acceptance — the only path into golden_atoms', () => {
  function staged(db: DatabaseSync, over: Partial<DraftProposal> = {}): DraftProposal {
    writePacket(buildDraftingPacket(db, 'CARD-1'));
    recordLookup('CARD-1', { kind: 'rule', query: '118.7', returned: ['118.7'] });
    const p = proposal(over);
    writeProposal(p);
    return p;
  }

  it('staging alone writes nothing to the database', () => {
    const { db } = seed();
    staged(db);
    const n = (db.prepare('SELECT COUNT(*) n FROM golden_atoms').get() as { n: number }).n;
    const c = (db.prepare('SELECT COUNT(*) n FROM golden_cards').get() as { n: number }).n;
    expect(n).toBe(0);
    expect(c).toBe(0);
  });

  it('writes the card and its atoms on acceptance, and records the review', () => {
    const { db } = seed();
    staged(db);
    const res = acceptProposal(db, 'CARD-1', { complete: true, note: 'checked both clauses' });
    expect(res.atoms).toBe(2);

    const row = db.prepare('SELECT complete, oracle_hash FROM golden_cards WHERE oracle_id = ?').get('CARD-1') as
      { complete: number; oracle_hash: string };
    expect(row.complete).toBe(1);
    expect(row.oracle_hash).toBe('hash-1');
    expect((db.prepare('SELECT COUNT(*) n FROM golden_atoms').get() as { n: number }).n).toBe(2);
    // The drafter is not recorded as the verifier: `source` stays 'authored',
    // because acceptance is the owner's act.
    const sources = (db.prepare('SELECT DISTINCT source FROM golden_atoms').all() as Array<{ source: string }>).map((r) => r.source);
    expect(sources).toEqual(['authored']);

    const review = readReview('CARD-1');
    expect(review?.decision).toBe('accepted');
    expect(review?.complete).toBe(true);
  });

  // Regression: acceptProposal used to APPEND unclassified candidates while upsertGoldenCard
  // replaced atoms, so re-accepting a card left a second copy of every candidate behind. 199 of
  // the 453 rows in the real table were exact duplicates. sec. 4.3 promotes "a recurring one" and
  // sec. 7.4 ranks the review queue by these rows, so duplicates inflate the very signal that
  // decides what enters the vocabulary.
  it('is idempotent for unclassified candidates when a card is re-accepted', () => {
    const { db } = seed();
    const withCandidate = () => {
      const p = staged(db);
      p.atoms = [p.atoms[0]!];
      p.unclassified = [{
        face_index: 0, span_start: 8, span_end: 24, quote: 'You gain 2 life.',
        proposed_label: 'LIFE_TOTAL_CHANGE', rationale: 'no fit in the fixture vocabulary',
      }];
      writeProposal(p);
    };
    const countUnclassified = () =>
      (db.prepare('SELECT COUNT(*) n FROM unclassified_clauses WHERE oracle_id = ?').get('CARD-1') as { n: number }).n;

    withCandidate();
    const first = acceptProposal(db, 'CARD-1', { complete: true });
    expect(first.unclassified).toBe(1);
    expect(countUnclassified()).toBe(1);

    // Re-accepting the same card must REPLACE its candidates, not append a second copy.
    withCandidate();
    acceptProposal(db, 'CARD-1', { complete: true });
    expect(countUnclassified()).toBe(1);
    expect((db.prepare('SELECT COUNT(*) n FROM golden_atoms WHERE oracle_id = ?').get('CARD-1') as { n: number }).n)
      .toBe(first.atoms);
  });

  it('accepts as partial regardless of the drafter\'s completeness claim', () => {
    const { db } = seed();
    staged(db);
    acceptProposal(db, 'CARD-1', { complete: false });
    const row = db.prepare('SELECT complete FROM golden_cards WHERE oracle_id = ?').get('CARD-1') as { complete: number };
    expect(row.complete).toBe(0);
  });

  it('refuses to accept an invalid proposal, writing nothing', () => {
    const { db } = seed();
    const p = staged(db);
    p.atoms[0]!.quote = 'Flying';
    writeProposal(p);
    expect(() => acceptProposal(db, 'CARD-1', { complete: true })).toThrow(/does not validate/);
    expect((db.prepare('SELECT COUNT(*) n FROM golden_atoms').get() as { n: number }).n).toBe(0);
  });

  it('refuses to accept as complete when a clause is uncovered', () => {
    const { db } = seed();
    const p = staged(db, { claims_complete: false });
    p.atoms = [p.atoms[0]!];
    writeProposal(p);
    expect(() => acceptProposal(db, 'CARD-1', { complete: true })).toThrow(/uncovered/);
    expect((db.prepare('SELECT COUNT(*) n FROM golden_atoms').get() as { n: number }).n).toBe(0);
  });

  it('writes unclassified candidates alongside the atoms', () => {
    const { db } = seed();
    const p = staged(db);
    p.atoms = [p.atoms[0]!];
    p.unclassified = [{
      face_index: 0, span_start: 8, span_end: 24, quote: 'You gain 2 life.',
      proposed_label: 'LIFE_TOTAL_CHANGE', rationale: 'no fit',
    }];
    writeProposal(p);
    acceptProposal(db, 'CARD-1', { complete: true });
    const rows = db.prepare('SELECT proposed_label, status FROM unclassified_clauses').all() as
      Array<{ proposed_label: string; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.proposed_label).toBe('LIFE_TOTAL_CHANGE');
    expect(rows[0]!.status).toBe('open');
  });

  it('rejection records the decision and leaves the database untouched', () => {
    const { db } = seed();
    staged(db);
    rejectProposal('CARD-1', 'the second atom is a forced fit');
    expect(readReview('CARD-1')?.decision).toBe('rejected');
    expect((db.prepare('SELECT COUNT(*) n FROM golden_atoms').get() as { n: number }).n).toBe(0);
  });
});

describe('ledger', () => {
  it('tracks a card through packet -> drafted -> accepted', () => {
    const { db } = seed();
    const candidates = [{ oracle_id: 'CARD-1', name: 'Test Card' }];
    expect(ledger(candidates)[0]!.stage).toBe('not-started');

    writePacket(buildDraftingPacket(db, 'CARD-1'));
    expect(ledger(candidates)[0]!.stage).toBe('packet');

    recordLookup('CARD-1', { kind: 'rule', query: '118.7', returned: ['118.7'] });
    writeProposal(proposal());
    const drafted = ledger(candidates)[0]!;
    expect(drafted.stage).toBe('drafted');
    expect(drafted.atoms).toBe(2);
    expect(drafted.lookups).toBe(1);

    acceptProposal(db, 'CARD-1', { complete: true });
    expect(ledger(candidates)[0]!.stage).toBe('accepted');
  });

  // A sec. 4.3 promotion can retire a type an accepted card's atoms used, which makes that card
  // fail --verify until it is redrafted. The redraft is a new proposal on top of an existing
  // review.json, and before this the ledger reported `review.decision` unconditionally - so nine
  // stale cards read as `accepted` and would never have surfaced for re-adjudication.
  it('reports a card as drafted again when its proposal is re-staged after acceptance', () => {
    const { db } = seed();
    const candidates = [{ oracle_id: 'CARD-1', name: 'Test Card' }];
    writePacket(buildDraftingPacket(db, 'CARD-1'));
    recordLookup('CARD-1', { kind: 'rule', query: '118.7', returned: ['118.7'] });
    writeProposal(proposal());
    acceptProposal(db, 'CARD-1', { complete: true });
    expect(ledger(candidates)[0]!.stage).toBe('accepted');

    const redraft = proposal();
    redraft.drafted_at = new Date(Date.now() + 60_000).toISOString();
    writeProposal(redraft);
    expect(ledger(candidates)[0]!.stage).toBe('drafted');
    // The earlier decision is not erased by the redraft.
    expect(readReview('CARD-1')?.decision).toBe('accepted');
  });

  it('ignores the shared vocabulary file sitting in the staging root', () => {
    const { db } = seed();
    writePacket(buildDraftingPacket(db, 'CARD-1'));       // also writes vocabulary.json
    expect(existsSync(join(draftsDir(), 'vocabulary.json'))).toBe(true);
    const rows = ledger([]);
    expect(rows.map((r) => r.oracle_id)).toEqual(['CARD-1']);
  });
});
