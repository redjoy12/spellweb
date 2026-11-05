/**
 * The in-memory card the extraction and verification suites share (plan Task 9 Step 1): one
 * card `o` (oracle_hash `h`), its faces, a small v1 enum, a current corpus with a few real
 * rule rows, extraction run 1, and the card's clause split persisted - so `computeCoverage`
 * reads the same stored denominator a real run fixes in `prepareRun`.
 */
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/db/client.js';
import { persistAtomSchema } from '../../src/atoms/schema.js';
import { persistClauses, splitOracleText } from '../../src/atoms/clauses.js';

const EMPTY = { type: 'object', properties: {}, additionalProperties: false };

export const FIXTURE_RULES = ['700', '700.1', '118', '121.1', '119.1', '702.9a', '603.1', '704.5f'];

export function fixtureWithClauses(
  oracleText: string | string[] = 'Draw a card.',
  opts: { name?: string; layout?: string; oracleId?: string; db?: DatabaseSync } = {},
): DatabaseSync {
  const db = opts.db ?? openDb(':memory:');
  const id = opts.oracleId ?? 'o';
  const name = opts.name ?? 'N';
  const faces = Array.isArray(oracleText) ? oracleText : [oracleText];
  if (!opts.db) {
    persistAtomSchema(db, {
      schema_version: 1,
      types: [
        { family: 'CARES_ABOUT', type_key: 'CREATURE_DEATH', label: 'x',
          params_schema: { type: 'object', properties: { controller: { enum: ['you', 'opponent', 'any'] } },
                           required: ['controller'], additionalProperties: false },
          provenance: 'spec_4_1', evidence: 'test' },
        ...(['CARD_DRAW', 'LIFEGAIN', 'TOKENS'] as const).map((k) => ({
          family: 'PRODUCES' as const, type_key: k, label: k, params_schema: EMPTY,
          provenance: 'spec_4_1' as const, evidence: 'test' })),
        { family: 'COMBAT', type_key: 'FLYING', label: 'Flying', params_schema: EMPTY, provenance: 'cr_702', evidence: 'test' },
        { family: 'ENABLES', type_key: 'ACTIVATE', label: 'Activate', params_schema: EMPTY, provenance: 'spec_4_1', evidence: 'test' },
      ],
    });
    db.exec("INSERT INTO snapshots (source_type,source_uri,source_updated_at,ingested_at,status) VALUES ('t','u','t','t','complete')");
    db.exec("INSERT INTO rules_corpus (source_uri,effective_date,sha256,fetched_at,section_count,rule_count,glossary_count,is_current) VALUES ('u','d','s','t',1,1,1,1)");
    const rule = db.prepare('INSERT INTO rules (corpus_id, number, section_number, subsection_number, text, ordinal) VALUES (1,?,?,?,?,?)');
    FIXTURE_RULES.forEach((n, i) => {
      const section = n.split('.')[0]!;
      const sub = n.includes('.') ? n.replace(/[a-z]+$/, '') : null;
      rule.run(n, section, sub === n ? null : sub, `text of ${n}`, i);
    });
    db.exec(`INSERT INTO extraction_runs (started_at,provider,model,schema_version,corpus_id,packet_policy_sha,splitter_version,batch_kind,status)
             VALUES ('t','stub','stub',1,1,'sha',1,'golden','in_progress')`);
  }
  db.prepare(`INSERT INTO cards (oracle_id,name,layout,cmc,type_line,colors,color_identity,keywords,rarity,set_code,collector_number,oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id)
              VALUES (?,?,?,1,'Creature','[]','[]','[]','c','s','1','h',1,1)`).run(id, name, opts.layout ?? 'normal');
  const face = db.prepare('INSERT INTO card_faces (oracle_id,face_index,name,type_line,oracle_text,colors) VALUES (?,?,?,?,?,?)');
  faces.forEach((t, i) => face.run(id, i, name, 'Creature', t, '[]'));
  persistClauses(db, id, 'h');
  return db;
}

/** A second extraction run, for currency tests. Returns its id. */
export function addRun(db: DatabaseSync, batchKind = 'golden'): number {
  return Number(db.prepare(
    `INSERT INTO extraction_runs (started_at,provider,model,schema_version,corpus_id,packet_policy_sha,splitter_version,batch_kind,status)
     VALUES ('t','stub','stub',1,1,'sha',1,?,'in_progress')`,
  ).run(batchKind).lastInsertRowid);
}

export interface AtomSeed {
  run_id?: number; oracle_id?: string; face_index?: number; family?: string; type_key?: string;
  span_start?: number; span_end?: number; pass_index?: number; consensus?: number; is_current?: number;
  confidence?: number; rule_numbers?: string[];
}

/** One atom row, defaulting to PRODUCES CARD_DRAW over the whole of face 0, run 1, pass 0. */
export function insertAtom(db: DatabaseSync, over: AtomSeed = {}): number {
  const a = { run_id: 1, oracle_id: 'o', face_index: 0, family: 'PRODUCES', type_key: 'CARD_DRAW',
    pass_index: 0, consensus: 1, is_current: 1, confidence: 0.9, rule_numbers: ['121.1'], ...over };
  const text = (db.prepare('SELECT oracle_text FROM card_faces WHERE oracle_id = ? AND face_index = ?')
    .get(a.oracle_id, a.face_index) as { oracle_text: string } | undefined)?.oracle_text ?? '';
  const start = a.span_start ?? 0;
  const end = a.span_end ?? text.length;
  return Number(db.prepare(
    `INSERT INTO atoms (run_id, oracle_id, face_index, schema_version, family, type_key, params_json, span_start, span_end,
       quote, rule_numbers, confidence, confidence_source, oracle_hash, pass_index, consensus, is_current)
     VALUES (?,?,?,1,?,?,'{}',?,?,?,?,?,'model','h',?,?,?)`,
  ).run(a.run_id, a.oracle_id, a.face_index, a.family, a.type_key, start, end, text.slice(start, end),
    JSON.stringify(a.rule_numbers), a.confidence, a.pass_index, a.consensus, a.is_current).lastInsertRowid);
}

export function insertAtoms(db: DatabaseSync, list: AtomSeed[]): number[] {
  return list.map((a) => insertAtom(db, a));
}

/** One atom over every non-reminder clause of the card - full coverage. */
export function coverAbilities(db: DatabaseSync, runId = 1, oracleId = 'o'): void {
  const faces = db.prepare('SELECT face_index, oracle_text FROM card_faces WHERE oracle_id = ? ORDER BY face_index')
    .all(oracleId) as Array<{ face_index: number; oracle_text: string }>;
  for (const f of faces) {
    for (const c of splitOracleText(f.oracle_text, f.face_index)) {
      if (c.kind === 'reminder') continue;
      insertAtom(db, { run_id: runId, oracle_id: oracleId, face_index: f.face_index, span_start: c.span_start, span_end: c.span_end });
    }
  }
}
