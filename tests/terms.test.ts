import { describe, it, expect, beforeAll } from 'vitest';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, DB_PATH } from '../src/db/client.js';
import { buildTermIndex, persistTermIndex, type TermIndexEntry } from '../src/rules/terms.js';

// A scratch copy: this suite calls persistTermIndex, and `npm test` must never
// mutate data/app.db. Task 2's test uses openDb(':memory:') for the same reason.
const scratch = join(mkdtempSync(join(tmpdir(), 'terms-')), 'app.db');
copyFileSync(DB_PATH, scratch);
const db = openDb(scratch);

const corpusId = (db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as
  { id: number } | undefined)?.id;
const maybe = corpusId ? describe : describe.skip;

maybe('buildTermIndex', () => {
  // NOT at describe scope: vitest RUNS the factory of a `describe.skip` block to
  // collect its children, so work here executes even when the guard is false.
  // tests/e2e-pool.test.ts:7 records this exact lesson from Phase 1.
  let entries: TermIndexEntry[];
  beforeAll(() => { entries = buildTermIndex(db, corpusId!); });

  it('draws from all three parsed sources', () => {
    const bySource = new Map<string, number>();
    for (const e of entries) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
    // Read from the corpus row rather than hardcoded: the count is a property of
    // whichever CR revision is current, and `sync:rules` moves it (20260619 had
    // 735 glossary entries, 20260819 has 739). The invariant worth asserting is
    // that EVERY parsed glossary entry reaches the index, not what today's total
    // happens to be.
    const { glossary_count } = db
      .prepare('SELECT glossary_count FROM rules_corpus WHERE id = ?')
      .get(corpusId!) as { glossary_count: number };
    expect(bySource.get('glossary')).toBe(glossary_count);
    // Corpus-specific, and there is no recorded count to derive it from: CR
    // 20260925 parses 264 subsection titles (20260819 had 263; 701.71 Empower Jace
    // is new). Expect this to move with the corpus.
    expect(bySource.get('subsection_title')).toBe(264);
    expect(bySource.get('type_map')).toBeGreaterThan(0);
  });

  it('carries definition text for glossary terms, because 82 have no cross-refs', () => {
    const glossary = entries.filter((e) => e.source === 'glossary');
    const noRefs = glossary.filter((e) => e.rule_numbers.length === 0);
    expect(noRefs.length).toBe(82);
    // Every one of those must still contribute something to a packet.
    for (const e of noRefs) expect(e.definition, `${e.term} has neither rules nor definition`).toBeTruthy();
  });

  it('records evidence for every entry (I3 discipline)', () => {
    for (const e of entries) expect(e.evidence.length).toBeGreaterThan(0);
  });

  it('persists idempotently', () => {
    persistTermIndex(db, corpusId!, entries);
    const first = db.prepare('SELECT COUNT(*) n FROM rule_term_index WHERE corpus_id = ?')
      .get(corpusId!) as { n: number };
    persistTermIndex(db, corpusId!, entries);
    const second = db.prepare('SELECT COUNT(*) n FROM rule_term_index WHERE corpus_id = ?')
      .get(corpusId!) as { n: number };
    expect(second.n).toBe(first.n);
  });
});
