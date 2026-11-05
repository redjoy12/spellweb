import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseComprehensiveRules } from '../src/rules/parse.js';
import { buildKeywordMap, persistCorpus, poolKeywords } from '../src/rules/lookup.js';
import { openDb } from '../src/db/client.js';

const corpus = parseComprehensiveRules(readFileSync('tests/fixtures/cr.sample.txt', 'utf8'));
const byKey = (m: ReturnType<typeof buildKeywordMap>) =>
  Object.fromEntries(m.map((x) => [x.keyword_key, x]));

describe('buildKeywordMap', () => {
  it('resolves a keyword by exact subsection title', () => {
    const m = byKey(buildKeywordMap(corpus, ['Deathtouch'], new Set()));
    expect(m['deathtouch']!.rule_number).toBe('702.2');
    expect(m['deathtouch']!.resolution).toBe('subsection_title');
    expect(m['deathtouch']!.evidence).toContain('Deathtouch');
  });

  it('resolves a variant keyword via a glossary cross-reference', () => {
    const m = byKey(buildKeywordMap(corpus, ['Megamorph'], new Set()));
    expect(m['megamorph']!.rule_number).toBe('702.37');
    expect(m['megamorph']!.resolution).toBe('glossary_crossref');
    expect(m['megamorph']!.evidence).toMatch(/See rule 702\.37/i);
  });

  it('classifies an ability word as having no rule section rather than failing', () => {
    const m = byKey(buildKeywordMap(corpus, ['Delirium'], new Set(['delirium'])));
    expect(m['delirium']!.rule_number).toBeNull();
    expect(m['delirium']!.resolution).toBe('ability_word_no_rule');
  });

  it('marks a genuinely unknown term unresolved with empty evidence, never guessing', () => {
    const m = byKey(buildKeywordMap(corpus, ['Fakewalk'], new Set()));
    expect(m['fakewalk']!.rule_number).toBeNull();
    expect(m['fakewalk']!.resolution).toBe('unresolved');
  });

  it('prefers the title match over the glossary when both exist', () => {
    const m = byKey(buildKeywordMap(corpus, ['Sacrifice'], new Set()));
    expect(m['sacrifice']!.resolution).toBe('subsection_title');
    expect(m['sacrifice']!.rule_number).toBe('701.16');
  });

  it('is case- and whitespace-insensitive', () => {
    const m = byKey(buildKeywordMap(corpus, ['  deathTOUCH '], new Set()));
    expect(m['deathtouch']!.rule_number).toBe('702.2');
  });
});

describe('persistCorpus', () => {
  it('stores the corpus, marks it current, and demotes any previous corpus', () => {
    const db = openDb(':memory:');
    const map = buildKeywordMap(corpus, ['Deathtouch', 'Fakewalk'], new Set());
    const a = persistCorpus(db, { sourceUri: 'u1', sha256: 'a'.repeat(64), corpus, keywordMap: map, typeMap: [] });
    const b = persistCorpus(db, { sourceUri: 'u2', sha256: 'b'.repeat(64), corpus, keywordMap: map, typeMap: [] });
    const rows = db.prepare('SELECT id, is_current FROM rules_corpus ORDER BY id').all() as any[];
    expect(rows.find((r) => r.id === a)!.is_current).toBe(0);
    expect(rows.find((r) => r.id === b)!.is_current).toBe(1);
    const n = db.prepare('SELECT COUNT(*) AS n FROM keyword_rule_map WHERE corpus_id = ?').get(b) as any;
    expect(n.n).toBe(2);
  });

  it('inserts corpus content only once for the same sha256', () => {
    const db = openDb(':memory:');
    const map = buildKeywordMap(corpus, ['Deathtouch'], new Set());
    const a = persistCorpus(db, { sourceUri: 'u', sha256: 'c'.repeat(64), corpus, keywordMap: map, typeMap: [] });
    const b = persistCorpus(db, { sourceUri: 'u', sha256: 'c'.repeat(64), corpus, keywordMap: map, typeMap: [] });
    expect(a).toBe(b);
    expect((db.prepare('SELECT COUNT(*) AS n FROM rules_corpus').get() as any).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM rules').get() as any).n).toBe(corpus.rules.length);
  });

  it('REBUILDS the derived maps even when the corpus sha256 is unchanged', () => {
    // Regression: the pool gains keywords when a set releases, without the CR changing.
    // Short-circuiting on a matching sha256 leaves those keywords unmapped forever.
    const db = openDb(':memory:');
    const sha = 'f'.repeat(64);

    const first = buildKeywordMap(corpus, ['Deathtouch'], new Set());
    const id1 = persistCorpus(db, { sourceUri: 'u', sha256: sha, corpus, keywordMap: first, typeMap: [] });
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM keyword_rule_map WHERE corpus_id = ?').get(id1) as any).n,
    ).toBe(1);

    const second = buildKeywordMap(corpus, ['Deathtouch', 'Landwalk'], new Set());
    const id2 = persistCorpus(db, { sourceUri: 'u', sha256: sha, corpus, keywordMap: second, typeMap: [] });
    expect(id2).toBe(id1);

    const keys = (
      db.prepare('SELECT keyword_key FROM keyword_rule_map WHERE corpus_id = ? ORDER BY keyword_key')
        .all(id2) as any[]
    ).map((r) => r.keyword_key);
    expect(keys).toEqual(['deathtouch', 'landwalk']);
  });
});

describe('poolKeywords', () => {
  it('returns distinct keywords from non-rotated cards only', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO snapshots (source_type, source_uri, source_updated_at, ingested_at, status)
       VALUES ('t','u','t',datetime('now'),'complete')`,
    ).run();
    const ins = db.prepare(
      `INSERT INTO cards (oracle_id,name,layout,cmc,type_line,colors,color_identity,keywords,
         rarity,set_code,collector_number,oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id,rotated)
       VALUES (?,?,'normal',1,'Creature','[]','[]',?,'common','aaa','1','h',1,1,?)`,
    );
    ins.run('o1', 'A', JSON.stringify(['Flying', 'Trample']), 0);
    ins.run('o2', 'B', JSON.stringify(['Flying']), 0);
    ins.run('o3', 'C', JSON.stringify(['Banding']), 1);      // rotated
    expect(poolKeywords(db).sort()).toEqual(['Flying', 'Trample']);
  });
});
