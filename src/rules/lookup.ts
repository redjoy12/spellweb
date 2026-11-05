import type { DatabaseSync } from 'node:sqlite';
import { normalizeTermKey, type ParsedCorpus } from './parse.js';
import type { TypeMapping } from './typemap.js';
import { buildTermIndex, persistTermIndex } from './terms.js';

export type Resolution =
  | 'subsection_title'
  | 'glossary_crossref'
  | 'ability_word_no_rule'
  | 'unresolved';

export interface KeywordMapping {
  keyword: string;
  keyword_key: string;
  rule_number: string | null;
  resolution: Resolution;
  evidence: string;
}

/**
 * Builds the keyword -> rule section table by parsing alone (I2, sec. 5.3).
 *
 * Three tiers, tried in order:
 *   1. subsection_title     - the term is the title of a rule subsection ("702.2. Deathtouch")
 *   2. glossary_crossref    - the glossary entry for the term contains "See rule NNN.M"
 *   3. ability_word_no_rule - the term is a known ability word; the CR states these have
 *                             no rules meaning, so "no section" is the correct answer
 * Anything left is `unresolved` with a null rule number. It is never guessed and never
 * silently dropped; sec. 6 surfaces it in the review UI.
 *
 * `abilityWords` must be supplied by the caller (Scryfall's ability-words catalog),
 * not inferred here.
 */
export function buildKeywordMap(
  corpus: ParsedCorpus,
  terms: string[],
  abilityWords: Set<string>,
): KeywordMapping[] {
  // Tier 1 index: every titled subsection, keyed by its normalised title.
  const titleIndex = new Map<string, { number: string; title: string }>();
  for (const r of corpus.rules) {
    if (r.subsection_number && r.subsection_title && r.number === r.subsection_number) {
      const key = normalizeTermKey(r.subsection_title);
      if (!titleIndex.has(key)) {
        titleIndex.set(key, { number: r.subsection_number, title: r.subsection_title });
      }
    }
  }

  // Tier 2 index: glossary entries with at least one rule cross-reference.
  const glossIndex = new Map<string, { refs: string[]; definition: string }>();
  for (const g of corpus.glossary) {
    glossIndex.set(g.term_key, { refs: g.cross_refs, definition: g.definition });
  }

  const seen = new Set<string>();
  const out: KeywordMapping[] = [];

  for (const raw of terms) {
    const key = normalizeTermKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // Display casing is preserved from the caller (Scryfall's canonical casing);
    // only the lookup *key* is normalised. The earlier ternary here was a no-op.
    const keyword = raw.trim();

    const title = titleIndex.get(key);
    if (title) {
      out.push({
        keyword, keyword_key: key, rule_number: title.number,
        resolution: 'subsection_title',
        evidence: `${title.number}. ${title.title}`,
      });
      continue;
    }

    const gloss = glossIndex.get(key);
    if (gloss && gloss.refs.length > 0) {
      out.push({
        keyword, keyword_key: key, rule_number: gloss.refs[0]!,
        resolution: 'glossary_crossref',
        evidence: gloss.definition,
      });
      continue;
    }

    if (abilityWords.has(key)) {
      out.push({
        keyword, keyword_key: key, rule_number: null,
        resolution: 'ability_word_no_rule',
        evidence: gloss?.definition
          ?? 'Listed in the ability-words catalog; the Comprehensive Rules glossary defines an ability word as having no rules meaning.',
      });
      continue;
    }

    out.push({
      keyword, keyword_key: key, rule_number: null,
      resolution: 'unresolved',
      evidence: gloss?.definition ?? '',
    });
  }

  out.sort((a, b) => (a.keyword_key < b.keyword_key ? -1 : a.keyword_key > b.keyword_key ? 1 : 0));
  return out;
}

/**
 * Stores the corpus and both derived maps.
 *
 * The corpus *content* is keyed on sha256 and inserted once - re-parsing the same
 * rules file is a no-op. The *derived maps* are rebuilt on every call, because they
 * depend on the card pool, which changes independently of the Comprehensive Rules.
 * A new set release adds keywords without touching the CR; short-circuiting on a
 * matching sha256 would leave those keywords permanently unmapped and silently
 * missing from every affected card's packet.
 */
export function persistCorpus(
  db: DatabaseSync,
  opts: {
    sourceUri: string;
    sha256: string;
    corpus: ParsedCorpus;
    keywordMap: KeywordMapping[];
    typeMap: TypeMapping[];
  },
): number {
  const { corpus } = opts;

  let id: number;
  db.exec('BEGIN');
  try {
    const existing = db
      .prepare('SELECT id FROM rules_corpus WHERE sha256 = ?')
      .get(opts.sha256) as { id: number } | undefined;

    if (existing) {
      id = existing.id;
    } else {
      db.prepare(
        `INSERT INTO rules_corpus (source_uri, effective_date, sha256, fetched_at,
           section_count, rule_count, glossary_count, is_current)
         VALUES (?,?,?,?,?,?,?,0)`,
      ).run(opts.sourceUri, corpus.effective_date, opts.sha256, new Date().toISOString(),
            corpus.sections.length, corpus.rules.length, corpus.glossary.length);
      id = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;

      const sec = db.prepare(
        'INSERT INTO rule_sections (corpus_id, number, parent_number, title, ordinal) VALUES (?,?,?,?,?)',
      );
      for (const s of corpus.sections) sec.run(id, s.number, s.parent_number, s.title, s.ordinal);

      const rule = db.prepare(
        `INSERT INTO rules (corpus_id, number, section_number, subsection_number,
           subsection_title, text, ordinal) VALUES (?,?,?,?,?,?,?)`,
      );
      for (const r of corpus.rules) {
        rule.run(id, r.number, r.section_number, r.subsection_number, r.subsection_title, r.text, r.ordinal);
      }

      const gl = db.prepare(
        'INSERT INTO glossary_entries (corpus_id, term, term_key, definition, cross_refs) VALUES (?,?,?,?,?)',
      );
      for (const g of corpus.glossary) {
        gl.run(id, g.term, g.term_key, g.definition, JSON.stringify(g.cross_refs));
      }
    }

    // Always rebuilt, new corpus or not.
    db.prepare('DELETE FROM keyword_rule_map WHERE corpus_id = ?').run(id);
    db.prepare('DELETE FROM type_rule_map WHERE corpus_id = ?').run(id);

    const km = db.prepare(
      `INSERT INTO keyword_rule_map (corpus_id, keyword, keyword_key, rule_number, resolution, evidence)
       VALUES (?,?,?,?,?,?)`,
    );
    for (const m of opts.keywordMap) {
      km.run(id, m.keyword, m.keyword_key, m.rule_number, m.resolution, m.evidence);
    }

    const tm = db.prepare(
      `INSERT INTO type_rule_map (corpus_id, term, term_key, kind, rule_number, resolution, evidence)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (const m of opts.typeMap) {
      tm.run(id, m.term, m.term_key, m.kind, m.rule_number, m.resolution, m.evidence);
    }

    db.prepare('UPDATE rules_corpus SET is_current = 0').run();
    db.prepare('UPDATE rules_corpus SET is_current = 1 WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // persistTermIndex manages its own transaction (Step 4), so it must run after the
  // outer BEGIN/COMMIT above has closed - node:sqlite rejects a nested BEGIN.
  persistTermIndex(db, id!, buildTermIndex(db, id!));
  return id!;
}

/** Distinct keywords appearing on cards currently in the pool. Rotated cards excluded. */
export function poolKeywords(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT keywords FROM cards WHERE rotated = 0').all() as Array<{ keywords: string }>;
  const set = new Set<string>();
  for (const r of rows) {
    for (const k of JSON.parse(r.keywords) as string[]) set.add(k);
  }
  return [...set];
}
