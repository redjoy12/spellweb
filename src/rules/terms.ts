import type { DatabaseSync } from 'node:sqlite';
import { normalizeTermKey } from './parse.js';

export interface TermIndexEntry {
  term: string;
  term_key: string;
  source: 'glossary' | 'subsection_title' | 'type_map';
  rule_numbers: string[];
  /** Glossary definition text. Packet payload, not just provenance - 82 terms have no cross-refs. */
  definition: string | null;
  evidence: string;
}

/**
 * Builds the term -> rules index from data Phase 1 already parsed. Nothing here is
 * authored: every entry names the parsed row it came from (I2, and the `evidence`
 * discipline Phase 1 established for keyword_rule_map).
 */
export function buildTermIndex(db: DatabaseSync, corpusId: number): TermIndexEntry[] {
  const out: TermIndexEntry[] = [];

  const glossary = db
    .prepare('SELECT term, term_key, definition, cross_refs FROM glossary_entries WHERE corpus_id = ?')
    .all(corpusId) as Array<{ term: string; term_key: string; definition: string; cross_refs: string }>;
  for (const g of glossary) {
    out.push({
      term: g.term,
      term_key: g.term_key,
      source: 'glossary',
      rule_numbers: JSON.parse(g.cross_refs) as string[],
      definition: g.definition,
      evidence: `glossary entry "${g.term}"`,
    });
  }

  const subsections = db
    .prepare(
      `SELECT DISTINCT subsection_number, subsection_title
         FROM rules
        WHERE corpus_id = ? AND subsection_title IS NOT NULL
          AND section_number IN ('701','702')`,                 // i2-ok: the CR sections that structurally hold keyword definitions
    )
    .all(corpusId) as Array<{ subsection_number: string; subsection_title: string }>;
  for (const s of subsections) {
    out.push({
      term: s.subsection_title,
      term_key: normalizeTermKey(s.subsection_title),
      source: 'subsection_title',
      rule_numbers: [s.subsection_number],
      definition: null,
      evidence: `rule ${s.subsection_number} titled "${s.subsection_title}"`,
    });
  }

  const types = db
    .prepare('SELECT term, term_key, rule_number, evidence FROM type_rule_map WHERE corpus_id = ?')
    .all(corpusId) as Array<{ term: string; term_key: string; rule_number: string; evidence: string }>;
  for (const t of types) {
    out.push({
      term: t.term,
      term_key: t.term_key,
      source: 'type_map',
      rule_numbers: [t.rule_number],
      definition: null,
      evidence: t.evidence,
    });
  }

  return out;
}

export function persistTermIndex(db: DatabaseSync, corpusId: number, entries: TermIndexEntry[]): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM rule_term_index WHERE corpus_id = ?').run(corpusId);
    const ins = db.prepare(
      `INSERT INTO rule_term_index (corpus_id, term, term_key, source, rule_numbers, definition, evidence)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(corpus_id, term_key, source) DO UPDATE SET
         term = excluded.term, rule_numbers = excluded.rule_numbers,
         definition = excluded.definition, evidence = excluded.evidence`,
    );
    for (const e of entries) {
      ins.run(corpusId, e.term, e.term_key, e.source, JSON.stringify(e.rule_numbers),
              e.definition, e.evidence);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
