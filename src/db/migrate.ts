import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  id: number;
  name: string;
  up(db: DatabaseSync): void;
}

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/**
 * The new columns and CHECK of review_queue (Phase 3 spec sec. 10.1). `domain` tells the
 * Phase 2 atom findings from the Phase 3 edge findings; each domain has its own severities.
 * schema.sql holds the same shape for a fresh database.
 */
const REVIEW_QUEUE_V2 = `
  CREATE TABLE review_queue_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    domain        TEXT    NOT NULL DEFAULT 'atom',
    oracle_id     TEXT    REFERENCES cards(oracle_id),
    run_id        INTEGER REFERENCES extraction_runs(id) ON DELETE CASCADE,
    rule_set_id   INTEGER REFERENCES edge_rule_sets(id),
    build_id      INTEGER REFERENCES graph_builds(id),
    severity      TEXT    NOT NULL,
    severity_rank INTEGER NOT NULL,
    rank_score    INTEGER NOT NULL,
    detail_table  TEXT,
    detail_id     INTEGER,
    status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
    enqueued_at   TEXT    NOT NULL,
    CHECK (
      (domain = 'atom'
         AND oracle_id IS NOT NULL AND run_id IS NOT NULL
         AND severity IN ('coverage_miss','missing_rule','vote_disagreement',
                          'unclassified','splitter_disagreement'))
      OR
      (domain = 'edge'
         AND rule_set_id IS NOT NULL
         AND severity IN ('edge_role_disagreement','edge_rule_disagreement','edge_report')
         AND (severity <> 'edge_report' OR build_id IS NOT NULL))
    )
  );
`;

/**
 * The new tables of Phase 3 spec sec. 10.2. schema.sql holds the same DDL, so a fresh
 * database has them before this migration runs; IF NOT EXISTS makes that a no-op.
 */
const PHASE3_TABLES = `
CREATE TABLE IF NOT EXISTS edge_rule_sets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  version         INTEGER NOT NULL UNIQUE,
  schema_version  INTEGER NOT NULL,
  corpus_id       INTEGER NOT NULL REFERENCES rules_corpus(id),
  packet_sha      TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('in_progress','accepted','superseded')),
  created_at      TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS edge_type_roles (
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  family          TEXT    NOT NULL,
  type_key        TEXT    NOT NULL,
  role            TEXT    NOT NULL CHECK (role IN ('supply','demand','both','none')),
  demand_note     TEXT,
  resources_json  TEXT    NOT NULL,
  evidence_json   TEXT    NOT NULL,
  votes           INTEGER NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('accepted','disputed')),
  PRIMARY KEY (set_id, family, type_key)
);
CREATE TABLE IF NOT EXISTS edge_rules (
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  rule_hash       TEXT    NOT NULL,
  rule_id         TEXT    NOT NULL,
  polarity        TEXT    NOT NULL CHECK (polarity IN ('+','-')),
  supply_json     TEXT    NOT NULL,
  demand_json     TEXT    NOT NULL,
  param_links     TEXT    NOT NULL,
  implications    TEXT    NOT NULL,
  evidence_json   TEXT    NOT NULL,
  votes           INTEGER NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('accepted','disputed')),
  PRIMARY KEY (set_id, rule_hash),
  UNIQUE (set_id, rule_id)
);
CREATE TABLE IF NOT EXISTS edge_rule_passes (
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  stage           TEXT    NOT NULL CHECK (stage IN ('roles','pairs')),
  batch_key       TEXT    NOT NULL,
  pass_index      INTEGER NOT NULL,
  packet_bytes    INTEGER NOT NULL,
  response_sha    TEXT    NOT NULL,
  items_valid     INTEGER NOT NULL,
  items_rejected  INTEGER NOT NULL,
  PRIMARY KEY (set_id, stage, batch_key, pass_index)
);
CREATE TABLE IF NOT EXISTS edge_rule_pass_items (
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  stage           TEXT    NOT NULL CHECK (stage IN ('roles','pairs')),
  batch_key       TEXT    NOT NULL,
  pass_index      INTEGER NOT NULL,
  item_key        TEXT    NOT NULL,
  item_json       TEXT    NOT NULL,
  PRIMARY KEY (set_id, stage, batch_key, pass_index, item_key)
);
CREATE TABLE IF NOT EXISTS edge_rule_rejections (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  stage           TEXT    NOT NULL,
  batch_key       TEXT    NOT NULL,
  pass_index      INTEGER NOT NULL,
  item_json       TEXT    NOT NULL,
  cause           TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS edge_missing_rule_reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  stage           TEXT    NOT NULL,
  batch_key       TEXT    NOT NULL,
  pass_index      INTEGER NOT NULL,
  needed          TEXT    NOT NULL,
  rationale       TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('open','accepted','rejected'))
);
CREATE TABLE IF NOT EXISTS ability_groups (
  oracle_id       TEXT    NOT NULL,
  face_index      INTEGER NOT NULL,
  group_index     INTEGER NOT NULL,
  span_start      INTEGER NOT NULL,
  span_end        INTEGER NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('triggered','activated','other')),
  cost_json       TEXT,
  cost_unparsed   INTEGER NOT NULL DEFAULT 0,
  per_turn_limit  INTEGER NOT NULL DEFAULT 0,
  unknown_limit   INTEGER NOT NULL DEFAULT 0,
  oracle_hash     TEXT    NOT NULL,
  tests_version   INTEGER NOT NULL,
  PRIMARY KEY (oracle_id, face_index, oracle_hash, tests_version, group_index)
);
CREATE TABLE IF NOT EXISTS graph_builds (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  build_key        TEXT    NOT NULL UNIQUE,
  rule_set_id      INTEGER NOT NULL REFERENCES edge_rule_sets(id),
  schema_version   INTEGER NOT NULL,
  corpus_id        INTEGER NOT NULL REFERENCES rules_corpus(id),
  pool_snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  tests_version    INTEGER NOT NULL,
  atom_set_sha     TEXT    NOT NULL,
  scope            TEXT    NOT NULL CHECK (scope IN ('B','R','BR')),
  built_at         TEXT    NOT NULL,
  counts_json      TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_build_atoms (
  build_id        INTEGER NOT NULL REFERENCES graph_builds(id) ON DELETE CASCADE,
  atom_id         INTEGER NOT NULL REFERENCES atoms(id),
  PRIMARY KEY (build_id, atom_id)
);
CREATE TABLE IF NOT EXISTS card_degree (
  build_id        INTEGER NOT NULL REFERENCES graph_builds(id) ON DELETE CASCADE,
  oracle_id       TEXT    NOT NULL,
  out_degree      INTEGER NOT NULL,
  in_degree       INTEGER NOT NULL,
  out_weight      REAL    NOT NULL,
  in_weight       REAL    NOT NULL,
  class_edges     INTEGER NOT NULL,
  anti_degree     INTEGER NOT NULL,
  PRIMARY KEY (build_id, oracle_id)
);
CREATE TABLE IF NOT EXISTS graph_gaps (
  build_id        INTEGER NOT NULL REFERENCES graph_builds(id) ON DELETE CASCADE,
  gap_kind        TEXT    NOT NULL CHECK (gap_kind IN
                    ('unresolved_param','partial_param','trigger_without_demand',
                     'trigger_word_inside','no_param_type','test_decision')),
  type_key        TEXT    NOT NULL,
  param           TEXT    NOT NULL DEFAULT '',
  count           INTEGER NOT NULL,
  PRIMARY KEY (build_id, gap_kind, type_key, param)
);
CREATE TABLE IF NOT EXISTS edge_reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id        INTEGER NOT NULL REFERENCES graph_builds(id),
  edge_key        TEXT    NOT NULL,
  supply_oracle   TEXT    NOT NULL,
  demand_oracle   TEXT    NOT NULL,
  rule_hashes     TEXT    NOT NULL,
  note            TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('open','accepted','rejected','stale')),
  created_at      TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS edge_golden_pairs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  supply_oracle   TEXT    NOT NULL,
  demand_oracle   TEXT    NOT NULL,
  stratum         TEXT    NOT NULL CHECK (stratum IN
                    ('demand_type','shared_term','interaction','param_gap',
                     'unrecorded_restriction','random','top_weight','correction')),
  round           INTEGER NOT NULL,
  label           TEXT    CHECK (label IN ('synergy','anti','none')),
  supply_clause   TEXT,
  demand_clause   TEXT,
  supply_atom_id  INTEGER REFERENCES atoms(id),
  demand_atom_id  INTEGER REFERENCES atoms(id),
  cr_chain_json   TEXT,
  votes           INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL CHECK (status IN
                    ('sampled','accepted','disputed','owner_accepted','owner_corrected','stale')),
  owner_note      TEXT,
  oracle_hashes   TEXT    NOT NULL,
  created_at      TEXT    NOT NULL
);
`;

/** Phase 3 Task 2: golden votes and owner samples. schema.sql holds the same DDL. */
const GOLDEN_TABLES = `
-- Phase 3 Task 2 (migration 6): each labeler pass answer of a golden pair, so that the
-- /edge-golden page can show the votes (spec sec. 13.5); the label batches with their packet
-- references (the quote check of an owner correction); and the owner samples (sec. 11.4).
CREATE TABLE IF NOT EXISTS edge_golden_votes (
  pair_id         INTEGER NOT NULL REFERENCES edge_golden_pairs(id) ON DELETE CASCADE,
  pass_index      INTEGER NOT NULL,
  answer_json     TEXT,               -- the answer of the pass for the pair, null when it gave none
  fault           TEXT,               -- null when the answer votes; else why it does not
  PRIMARY KEY (pair_id, pass_index)
);
CREATE TABLE IF NOT EXISTS edge_golden_batches (
  round           INTEGER NOT NULL,
  batch_index     INTEGER NOT NULL,
  pair_ids        TEXT    NOT NULL,   -- JSON array, in packet order (P01, P02, ...)
  corpus_id       INTEGER NOT NULL REFERENCES rules_corpus(id),
  refs_json       TEXT    NOT NULL,   -- the packet references of plan D16
  packet_sha      TEXT    NOT NULL,
  packet_bytes    INTEGER NOT NULL,
  prepared_at     TEXT    NOT NULL,
  PRIMARY KEY (round, batch_index)
);
CREATE TABLE IF NOT EXISTS edge_golden_owner_sample (
  sample_no       INTEGER NOT NULL,
  pair_id         INTEGER NOT NULL REFERENCES edge_golden_pairs(id) ON DELETE CASCADE,
  prior_status    TEXT    NOT NULL,   -- 'accepted' or 'disputed' when sampled
  prior_label     TEXT,               -- the labeler label when sampled
  sampled_at      TEXT    NOT NULL,
  PRIMARY KEY (sample_no, pair_id)
);
`;

/** Phase 3 Task 2: the isolated reviewer of the owner sample. schema.sql holds the same DDL. */
const REVIEW_TABLE = `
-- Phase 3 Task 2 (migration 7, owner decision 2026-10-11): the isolated reviewer that replaces
-- the owner sample (spec rev. 8 sec. 11.4). One blind answer for each pair of an owner sample.
CREATE TABLE IF NOT EXISTS edge_golden_reviews (
  sample_no       INTEGER NOT NULL,
  pair_id         INTEGER NOT NULL REFERENCES edge_golden_pairs(id) ON DELETE CASCADE,
  answer_json     TEXT,               -- the reviewer answer, null when it gave none
  fault           TEXT,               -- null when the answer is valid; else why it is not
  outcome         TEXT    NOT NULL CHECK (outcome IN ('agree','clause_differs','label_differs','invalid')),
  reviewed_at     TEXT    NOT NULL,
  PRIMARY KEY (sample_no, pair_id)
);
`;

const RULE_TABLES = `
-- Phase 3 Task 3 (migration 8): the batches of an edge-rule set with their packet references
-- (sec. 5.4 check 5), and a person's decision on a disputed role (plan D13).
CREATE TABLE IF NOT EXISTS edge_rule_batches (
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  stage           TEXT    NOT NULL CHECK (stage IN ('roles','pairs')),
  batch_key       TEXT    NOT NULL,
  demand          TEXT,
  types_json      TEXT    NOT NULL,
  refs_json       TEXT    NOT NULL,
  packet_sha      TEXT    NOT NULL,
  packet_bytes    INTEGER NOT NULL,
  prepared_at     TEXT    NOT NULL,
  PRIMARY KEY (set_id, stage, batch_key)
);
CREATE TABLE IF NOT EXISTS edge_role_decisions (
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  family          TEXT    NOT NULL,
  type_key        TEXT    NOT NULL,
  decision        TEXT    NOT NULL CHECK (decision IN ('pass','none','keep')),
  pass_index      INTEGER,
  note            TEXT    NOT NULL,
  decided_at      TEXT    NOT NULL,
  PRIMARY KEY (set_id, family, type_key)
);
`;

/** Phase 3 Task 3: the debate of disputed items (spec rev. 9 sec. 5.6). schema.sql holds the same DDL. */
const DEBATE_TABLES = `
-- Phase 3 Task 3 (migration 9, spec rev. 9 sec. 5.6): the debate of disputed items. A debate
-- verdict is not an owner decision: the decision rows record decided_by = 'debate'.
CREATE TABLE IF NOT EXISTS edge_rule_decisions (
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  rule_hash       TEXT    NOT NULL,
  decision        TEXT    NOT NULL CHECK (decision IN ('adopt','reject')),
  decided_by      TEXT    NOT NULL CHECK (decided_by IN ('owner','debate')),
  debate_round    INTEGER,            -- the round that agreed; null for an owner decision
  note            TEXT    NOT NULL,
  decided_at      TEXT    NOT NULL,
  PRIMARY KEY (set_id, rule_hash)
);
CREATE TABLE IF NOT EXISTS edge_debate_batches (
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  stage           TEXT    NOT NULL CHECK (stage IN ('roles','pairs')),
  batch_key       TEXT    NOT NULL,   -- the source batch of edge_rule_batches
  round           INTEGER NOT NULL,
  items_json      TEXT    NOT NULL,   -- the item keys, in packet order (D01, D02, ...)
  packet_sha      TEXT    NOT NULL,
  packet_bytes    INTEGER NOT NULL,
  prepared_at     TEXT    NOT NULL,
  submitted_at    TEXT,               -- null while the round is open
  PRIMARY KEY (set_id, stage, batch_key, round)
);
CREATE TABLE IF NOT EXISTS edge_debate_answers (
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  stage           TEXT    NOT NULL,
  batch_key       TEXT    NOT NULL,
  round           INTEGER NOT NULL,
  debater         INTEGER NOT NULL,
  item_key        TEXT    NOT NULL,
  choice          TEXT    NOT NULL,
  argument        TEXT    NOT NULL,
  evidence_json   TEXT    NOT NULL,
  fault           TEXT,               -- null when the answer counts; else why it does not
  PRIMARY KEY (set_id, stage, batch_key, round, debater, item_key)
);
CREATE TABLE IF NOT EXISTS edge_debate_outcomes (
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  stage           TEXT    NOT NULL,
  item_key        TEXT    NOT NULL,   -- FAMILY.TYPE_KEY (roles) or rule_hash (pairs)
  outcome         TEXT    NOT NULL CHECK (outcome IN ('agreed','no_agreement','not_applied')),
  choice          TEXT,               -- the agreed option; null for no_agreement
  round           INTEGER NOT NULL,
  cause           TEXT,               -- not_applied: why the verdict did not apply
  decided_at      TEXT    NOT NULL,
  PRIMARY KEY (set_id, stage, item_key)
);
`;

/** Migration 11 (owner request 2026-10-18): the fix requests of a reason. schema.sql holds the same DDL. */
const FIX_REQUESTS_TABLE = `
CREATE TABLE IF NOT EXISTS fix_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_name    TEXT    NOT NULL,
  rule_hashes     TEXT    NOT NULL,   -- JSON array of rule_hash, sorted: the reason (one merged edge can have more than one rule)
  report_ids      TEXT    NOT NULL,   -- JSON array of edge_reports.id on this reason when the request was saved
  build_id        INTEGER REFERENCES graph_builds(id),  -- the build of the link counts in the brief
  edge_key        TEXT,               -- the link the owner opened the form from; null from a grouped item
  brief_path      TEXT    NOT NULL,   -- absolute path of data/fix-requests/<id>-<session-name-slug>.md
  status          TEXT    NOT NULL CHECK (status IN ('queued','sent','done')),
  note            TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL,
  sent_at         TEXT
);
`;

/** Migration 15 (schema v15 plan, Task 5 Step 1): the carried demand types of a set. schema.sql holds the same DDL. */
const EDGE_RULE_CARRY_TABLE = `
CREATE TABLE IF NOT EXISTS edge_rule_carry (
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  from_set_id     INTEGER NOT NULL REFERENCES edge_rule_sets(id),
  demand          TEXT    NOT NULL,   -- FAMILY.TYPE_KEY: its rules are copies of the rules of from_set_id
  rules           INTEGER NOT NULL,   -- the rules copied (accepted and disputed)
  PRIMARY KEY (set_id, demand)
);
`;

/** Migration 13 (owner request 2026-10-18): the owner's answers on the "Your decisions" page. schema.sql holds the same DDL. */
const OWNER_DECISIONS_TABLE = `
CREATE TABLE IF NOT EXISTS owner_decisions (
  kind        TEXT NOT NULL CHECK (kind IN ('cr_text','rule_conflict','supply_twin','link_check','reading','type_role','wrong_link','tag_check','tag_merge','golden_check','link_rule')),
  item_key    TEXT NOT NULL,
  choice      TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  decided_at  TEXT NOT NULL,
  PRIMARY KEY (kind, item_key)
);
`;

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'rebuild extraction_queue: widen reason, re-key on surrogate id',
    up(db) {
      // Already in the new shape (e.g. a fresh database built from schema.sql).
      // (a half-applied state is unreachable because up() runs in a per-migration BEGIN/COMMIT.)
      if (tableHasColumn(db, 'extraction_queue', 'id')) return;

      db.exec(`
        CREATE TABLE extraction_queue_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          oracle_id      TEXT    NOT NULL REFERENCES cards(oracle_id),
          reason         TEXT    NOT NULL CHECK (reason IN
                           ('new_card','oracle_changed','schema_promoted',
                            'kernel_changed','splitter_changed','review_correction')),
          enqueued_at    TEXT    NOT NULL,
          source_diff_id INTEGER REFERENCES pool_diffs(id),
          status         TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done'))
        );
        INSERT INTO extraction_queue_new (oracle_id, reason, enqueued_at, source_diff_id, status)
          SELECT oracle_id, reason, enqueued_at, source_diff_id, status
            FROM extraction_queue
           -- preserve chronological enqueue order so the new AUTOINCREMENT id is time-ordered
           ORDER BY enqueued_at, oracle_id;
        DROP TABLE extraction_queue;
        ALTER TABLE extraction_queue_new RENAME TO extraction_queue;
        CREATE INDEX IF NOT EXISTS idx_queue_card ON extraction_queue(oracle_id, status);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_open
          ON extraction_queue(oracle_id) WHERE status = 'pending';
      `);
    },
  },
  {
    id: 2,
    name: 'extraction_results.failure_detail: the diagnostic for a failed card',
    up(db) {
      // Task 8's failure-mode table stores the raw response of a card that never parsed; the
      // plan named a "sibling diagnostic field" that schema.sql never had. Fresh databases get
      // the column from schema.sql, so only an older file needs the ALTER. A pre-Phase-2 file
      // with no extraction_results at all gets the whole table, column included, from schema.sql.
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'extraction_results'").get();
      if (!exists || tableHasColumn(db, 'extraction_results', 'failure_detail')) return;
      db.exec('ALTER TABLE extraction_results ADD COLUMN failure_detail TEXT');
    },
  },
  {
    id: 3,
    name: 'atoms.consensus, and one current atom set per card (sec. 10.3)',
    up(db) {
      // Task 9 ruling R9-1: a run's own verdict on an atom (`consensus`) is not the card's
      // live set (`is_current`). Before this, every run wrote is_current = 1 and nothing
      // demoted, so each golden card carried one full current set per golden run (runs 4, 5
      // and 6 on the owner's database) and the inspector drew all of them on top of each
      // other. Every atom written so far was single-pass, so it was its run's consensus.
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'atoms'").get();
      if (!exists) return;
      if (!tableHasColumn(db, 'atoms', 'consensus')) {
        db.exec('ALTER TABLE atoms ADD COLUMN consensus INTEGER NOT NULL DEFAULT 1');
      }
      // The repair sec. 10.3's re-extraction rule would have made: only the card's latest
      // run that produced atoms stays current. The older runs keep their rows for scoring.
      db.exec(`
        UPDATE atoms SET is_current = 0
         WHERE is_current = 1
           AND run_id < (SELECT MAX(b.run_id) FROM atoms b WHERE b.oracle_id = atoms.oracle_id)
      `);
    },
  },
  {
    id: 4,
    name: 'review_queue: atom and edge domains, nullable keys, unique index on expressions (Phase 3 sec. 10.1)',
    up(db) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_queue'").get();
      if (!exists) return;
      // A fresh database already has the new shape from schema.sql: only the indexes are missing.
      if (!tableHasColumn(db, 'review_queue', 'domain')) {
        // SQLite cannot change a CHECK in place, so the table is rebuilt. Every row keeps its id,
        // and the AUTOINCREMENT high-water mark is carried over so that no deleted id comes back.
        const seq = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'review_queue'").get() as
          { seq: number } | undefined)?.seq ?? 0;
        db.exec(REVIEW_QUEUE_V2);
        db.exec(`
          INSERT INTO review_queue_new (id, domain, oracle_id, run_id, severity, severity_rank, rank_score,
                                        detail_table, detail_id, status, enqueued_at)
            SELECT id, 'atom', oracle_id, run_id, severity, severity_rank, rank_score,
                   detail_table, detail_id, status, enqueued_at
              FROM review_queue ORDER BY id;
          DROP TABLE review_queue;
          ALTER TABLE review_queue_new RENAME TO review_queue;
        `);
        // An empty table gets no sequence row from the copy, so the row may have to be made.
        if (db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'review_queue'").run(seq).changes === 0 && seq > 0) {
          db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('review_queue', ?)").run(seq);
        }
      }
      // SQLite treats each NULL as distinct in a UNIQUE constraint, so the key is an index on
      // expressions. ON CONFLICT DO NOTHING with no target obeys it.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS review_queue_finding ON review_queue (
          domain, COALESCE(oracle_id, ''), COALESCE(run_id, 0),
          COALESCE(rule_set_id, 0), COALESCE(build_id, 0), severity, COALESCE(detail_id, 0)
        );
        CREATE INDEX IF NOT EXISTS idx_review_open
          ON review_queue(status, severity_rank, rank_score DESC);
      `);
    },
  },
  {
    id: 5,
    name: 'Phase 3 tables: edge rules, ability groups, graph builds, edge golden set (Phase 3 sec. 10.2)',
    up(db) {
      db.exec(PHASE3_TABLES);
    },
  },
  {
    id: 6,
    name: 'edge golden votes and owner samples (Phase 3 Task 2, sec. 11.3-11.4, 13.5)',
    up(db) {
      db.exec(GOLDEN_TABLES);
    },
  },
  {
    id: 7,
    name: 'edge golden reviews: the isolated reviewer of the owner sample (owner decision 2026-10-11)',
    up(db) {
      db.exec(REVIEW_TABLE);
    },
  },
  {
    id: 8,
    name: 'edge-rule batches and role decisions (Phase 3 Task 3, sec. 5.3-5.4, plan D13)',
    up(db) {
      db.exec(RULE_TABLES);
    },
  },
  {
    id: 9,
    name: 'debate of disputed edge items (Phase 3 spec rev. 9 sec. 5.6)',
    up(db) {
      // A fresh database has the columns from schema.sql; only an older file needs the ALTER.
      const cols = new Set((db.prepare('PRAGMA table_info(edge_role_decisions)').all() as Array<{ name: string }>).map((c) => c.name));
      if (!cols.has('decided_by')) {
        db.exec("ALTER TABLE edge_role_decisions ADD COLUMN decided_by TEXT NOT NULL DEFAULT 'owner' CHECK (decided_by IN ('owner','debate'))");
      }
      if (!cols.has('debate_round')) db.exec('ALTER TABLE edge_role_decisions ADD COLUMN debate_round INTEGER');
      db.exec(DEBATE_TABLES);
    },
  },
  {
    id: 10,
    name: 'ability_groups: the atom set joins the key, so a requeue does not block the next build (Phase 3 plan Task 8)',
    up(db) {
      // A fresh database has the column from schema.sql. An older file keeps each row, with atom_sha ''.
      if (tableHasColumn(db, 'ability_groups', 'atom_sha')) return;
      db.exec(`
        CREATE TABLE ability_groups_new (
          oracle_id       TEXT    NOT NULL,
          face_index      INTEGER NOT NULL,
          group_index     INTEGER NOT NULL,
          span_start      INTEGER NOT NULL,
          span_end        INTEGER NOT NULL,
          kind            TEXT    NOT NULL CHECK (kind IN ('triggered','activated','other')),
          cost_json       TEXT,
          cost_unparsed   INTEGER NOT NULL DEFAULT 0,
          per_turn_limit  INTEGER NOT NULL DEFAULT 0,
          unknown_limit   INTEGER NOT NULL DEFAULT 0,
          oracle_hash     TEXT    NOT NULL,
          tests_version   INTEGER NOT NULL,
          atom_sha        TEXT    NOT NULL DEFAULT '',
          PRIMARY KEY (oracle_id, face_index, oracle_hash, tests_version, atom_sha, group_index)
        );
        INSERT INTO ability_groups_new (oracle_id, face_index, group_index, span_start, span_end, kind, cost_json,
                                        cost_unparsed, per_turn_limit, unknown_limit, oracle_hash, tests_version, atom_sha)
          SELECT oracle_id, face_index, group_index, span_start, span_end, kind, cost_json,
                 cost_unparsed, per_turn_limit, unknown_limit, oracle_hash, tests_version, '' FROM ability_groups;
        DROP TABLE ability_groups;
        ALTER TABLE ability_groups_new RENAME TO ability_groups;
      `);
    },
  },
  {
    id: 11,
    name: 'fix_requests: the owner hands a reported reason to a named Claude session (owner request 2026-10-18)',
    up(db) {
      db.exec(FIX_REQUESTS_TABLE);
    },
  },
  {
    id: 12,
    name: 'fix_requests: session_id, delivery_error and delivery_at, for the fix-dispatch mod (owner request 2026-10-18)',
    up(db) {
      for (const col of ['session_id', 'delivery_error', 'delivery_at']) {
        if (!tableHasColumn(db, 'fix_requests', col)) db.exec(`ALTER TABLE fix_requests ADD COLUMN ${col} TEXT`);
      }
    },
  },
  {
    id: 13,
    name: 'owner_decisions: the owner answers on the "Your decisions" page (owner request 2026-10-18)',
    up(db) {
      db.exec(OWNER_DECISIONS_TABLE);
    },
  },
  {
    id: 14,
    name: "owner_decisions: kind 'link_check' for the link check of spec rev. 17 sec. 5.9",
    up(db) {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'owner_decisions'").get() as { sql: string } | undefined;
      if (!row || row.sql.includes("'link_check'")) return;
      db.exec('ALTER TABLE owner_decisions RENAME TO owner_decisions_old');
      db.exec(OWNER_DECISIONS_TABLE);
      db.exec('INSERT INTO owner_decisions (kind, item_key, choice, note, decided_at) SELECT kind, item_key, choice, note, decided_at FROM owner_decisions_old');
      db.exec('DROP TABLE owner_decisions_old');
    },
  },
  {
    id: 15,
    name: 'edge_rule_carry: a set that carries the roles and the unchanged demand types of an earlier set (schema v15 plan, Task 5)',
    up(db) {
      db.exec(EDGE_RULE_CARRY_TABLE);
    },
  },
  {
    id: 16,
    name: "owner_decisions: kinds 'reading', 'type_role' and 'wrong_link' for the high-help questions (owner request 2026-10-19)",
    up(db) {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'owner_decisions'").get() as { sql: string } | undefined;
      if (!row || row.sql.includes("'wrong_link'")) return;
      db.exec('ALTER TABLE owner_decisions RENAME TO owner_decisions_old');
      db.exec(OWNER_DECISIONS_TABLE);
      db.exec('INSERT INTO owner_decisions (kind, item_key, choice, note, decided_at) SELECT kind, item_key, choice, note, decided_at FROM owner_decisions_old');
      db.exec('DROP TABLE owner_decisions_old');
    },
  },
  {
    id: 17,
    name: "owner_decisions: kind 'tag_check' for the meaning-tag sample (owner request 2026-10-21)",
    up(db) {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'owner_decisions'").get() as { sql: string } | undefined;
      if (!row || row.sql.includes("'tag_check'")) return;
      db.exec('ALTER TABLE owner_decisions RENAME TO owner_decisions_old');
      db.exec(OWNER_DECISIONS_TABLE);
      db.exec('INSERT INTO owner_decisions (kind, item_key, choice, note, decided_at) SELECT kind, item_key, choice, note, decided_at FROM owner_decisions_old');
      db.exec('DROP TABLE owner_decisions_old');
    },
  },
  {
    id: 18,
    name: "owner_decisions: kind 'tag_merge' for the atom-type merge proposals (owner request 2026-10-23)",
    up(db) {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'owner_decisions'").get() as { sql: string } | undefined;
      if (!row || row.sql.includes("'tag_merge'")) return;
      db.exec('ALTER TABLE owner_decisions RENAME TO owner_decisions_old');
      db.exec(OWNER_DECISIONS_TABLE);
      db.exec('INSERT INTO owner_decisions (kind, item_key, choice, note, decided_at) SELECT kind, item_key, choice, note, decided_at FROM owner_decisions_old');
      db.exec('DROP TABLE owner_decisions_old');
    },
  },
  {
    id: 19,
    name: "owner_decisions: kind 'golden_check' for the owner check of the golden synergy pairs (owner request 2026-10-24)",
    up(db) {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'owner_decisions'").get() as { sql: string } | undefined;
      if (!row || row.sql.includes("'golden_check'")) return;
      db.exec('ALTER TABLE owner_decisions RENAME TO owner_decisions_old');
      db.exec(OWNER_DECISIONS_TABLE);
      db.exec('INSERT INTO owner_decisions (kind, item_key, choice, note, decided_at) SELECT kind, item_key, choice, note, decided_at FROM owner_decisions_old');
      db.exec('DROP TABLE owner_decisions_old');
    },
  },
  {
    id: 20,
    name: "owner_decisions: kind 'link_rule' for the link rule version 2 questions (owner request 2026-10-25)",
    up(db) {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'owner_decisions'").get() as { sql: string } | undefined;
      if (!row || row.sql.includes("'link_rule'")) return;
      db.exec('ALTER TABLE owner_decisions RENAME TO owner_decisions_old');
      db.exec(OWNER_DECISIONS_TABLE);
      db.exec('INSERT INTO owner_decisions (kind, item_key, choice, note, decided_at) SELECT kind, item_key, choice, note, decided_at FROM owner_decisions_old');
      db.exec('DROP TABLE owner_decisions_old');
    },
  },
  {
    id: 21,
    name: 'decks: the decks of the goal form (Phase 4 design sec. 11)',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS decks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        build_id    INTEGER NOT NULL REFERENCES graph_builds(id),
        goal_json   TEXT    NOT NULL,
        policy_sha  TEXT    NOT NULL,
        deck_json   TEXT    NOT NULL,
        created_at  TEXT    NOT NULL
      )`);
    },
  },
  {
    id: 22,
    name: 'card_rates: the text rate of each spell, for one build (card rate plan Task 4)',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS card_rates (
        oracle_id       TEXT    PRIMARY KEY REFERENCES cards(oracle_id),
        oracle_hash     TEXT    NOT NULL,
        build_id        INTEGER NOT NULL REFERENCES graph_builds(id) ON DELETE CASCADE,
        predicted_mana  REAL,
        printed_mana    REAL    NOT NULL,
        role_gap        REAL,
        rate            REAL,
        class           TEXT    NOT NULL CHECK (class IN ('conditional','dominated_in_pool','plain')),
        reason          TEXT    NOT NULL CHECK (reason IN ('x_cost','face_no_cost','no_cost','no_group','under_line','no_penalty','gap')),
        class_reason    TEXT,
        group_key       TEXT
      )`);
    },
  },
  {
    id: 23,
    name: 'deck chat: talks, messages, card comments and deck versions (deck chat design sec. 5)',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS deck_chats (
        deck_id          INTEGER PRIMARY KEY REFERENCES decks(id) ON DELETE CASCADE,
        session_id       TEXT    NOT NULL,
        model            TEXT    NOT NULL,
        started          INTEGER NOT NULL DEFAULT 0,
        turn_state       TEXT    NOT NULL DEFAULT 'idle' CHECK (turn_state IN ('idle','running')),
        flagged          INTEGER NOT NULL DEFAULT 0,
        told_message_id  INTEGER NOT NULL DEFAULT 0
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS deck_chat_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        deck_id     INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        role        TEXT    NOT NULL CHECK (role IN ('owner','claude','step','error','swap','note')),
        text        TEXT    NOT NULL,
        data_json   TEXT,
        created_at  TEXT    NOT NULL
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_deck_chat_messages_deck ON deck_chat_messages(deck_id, id)');
      db.exec(`CREATE TABLE IF NOT EXISTS deck_card_comments (
        deck_id     INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        oracle_id   TEXT    NOT NULL REFERENCES cards(oracle_id),
        text        TEXT    NOT NULL,
        unread      INTEGER NOT NULL DEFAULT 1,
        updated_at  TEXT    NOT NULL,
        PRIMARY KEY (deck_id, oracle_id)
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS deck_versions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        deck_id     INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        message_id  INTEGER NOT NULL REFERENCES deck_chat_messages(id) ON DELETE CASCADE,
        build_id    INTEGER NOT NULL REFERENCES graph_builds(id),
        policy_sha  TEXT    NOT NULL,
        deck_json   TEXT    NOT NULL,
        created_at  TEXT    NOT NULL
      )`);
    },
  },
  {
    id: 24,
    name: 'game review: Arena card names, the logs that the scan has read, and the games (game review design sec. 5)',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS arena_cards (
        arena_id   INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL,
        oracle_id  TEXT    REFERENCES cards(oracle_id),
        is_token   INTEGER NOT NULL
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS game_log_files (
        log_id   TEXT    PRIMARY KEY,
        read_to  INTEGER NOT NULL,
        closed   INTEGER NOT NULL DEFAULT 0
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS game_scan_state (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        log_found   INTEGER NOT NULL DEFAULT 0,
        detailed    INTEGER,
        scanned_at  TEXT,
        error       TEXT,
        card_file   TEXT
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS games (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id        TEXT    NOT NULL,
        game_number     INTEGER NOT NULL,
        played_at       TEXT    NOT NULL,
        file            TEXT    NOT NULL,
        status          TEXT    NOT NULL CHECK (status IN ('ok','unreadable')),
        reason          TEXT,
        parser_version  INTEGER NOT NULL,
        game_json       TEXT,
        deck_id         INTEGER REFERENCES decks(id) ON DELETE SET NULL,
        link_kind       TEXT    CHECK (link_kind IN ('exact','close')),
        link_json       TEXT,
        UNIQUE (match_id, game_number)
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_games_deck ON games(deck_id, played_at)');
    },
  },
  {
    id: 25,
    name: 'build chat: talks before a deck, their messages, and the brief of a deck (build chat design sec. 8)',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS build_chats (
        chat_id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id       TEXT    NOT NULL,
        model            TEXT    NOT NULL,
        started          INTEGER NOT NULL DEFAULT 0,
        turn_state       TEXT    NOT NULL DEFAULT 'idle' CHECK (turn_state IN ('idle','running')),
        flagged          INTEGER NOT NULL DEFAULT 0,
        told_message_id  INTEGER NOT NULL DEFAULT 0,
        draft_json       TEXT    NOT NULL DEFAULT '{}',
        brief            TEXT    NOT NULL DEFAULT '',
        deck_id          INTEGER REFERENCES decks(id) ON DELETE SET NULL,
        created_at       TEXT    NOT NULL DEFAULT ''
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS build_chat_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id     INTEGER NOT NULL REFERENCES build_chats(chat_id) ON DELETE CASCADE,
        role        TEXT    NOT NULL CHECK (role IN ('owner','claude','step','error','swap','note')),
        text        TEXT    NOT NULL,
        data_json   TEXT,
        created_at  TEXT    NOT NULL
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_build_chat_messages_chat ON build_chat_messages(chat_id, id)');
      const cols = (db.prepare('PRAGMA table_info(decks)').all() as Array<{ name: string }>).map((c) => c.name);
      if (!cols.includes('brief')) db.exec('ALTER TABLE decks ADD COLUMN brief TEXT');
    },
  },
  {
    id: 26,
    name: 'link review: suggestions of a link check, apply requests and owner links (link review design sec. 8)',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS link_apply_requests (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        state           TEXT    NOT NULL CHECK (state IN ('open','done','cancelled')),
        suggestion_ids  TEXT    NOT NULL,
        report_ids      TEXT    NOT NULL,
        prompt          TEXT    NOT NULL,
        results         TEXT,
        created_at      TEXT    NOT NULL,
        done_at         TEXT
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS link_suggestions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        deck_id        INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        build_id       INTEGER NOT NULL,
        kind           TEXT    NOT NULL CHECK (kind IN ('delete','add','correct')),
        change         TEXT    CHECK (change IS NULL OR change IN ('weak','not_weak','wrong_reason')),
        sign           TEXT    NOT NULL CHECK (sign IN ('+','-')),
        supply_oracle  TEXT    NOT NULL,
        demand_oracle  TEXT    NOT NULL,
        edge_key       TEXT,
        rule_hashes    TEXT    NOT NULL DEFAULT '[]',
        reason         TEXT    NOT NULL,
        state          TEXT    NOT NULL CHECK (state IN ('open','answered','in_request','applied','question','rejected','stale')),
        answer         TEXT    CHECK (answer IS NULL OR answer IN ('yes','weak','no')),
        owner_note     TEXT    NOT NULL DEFAULT '',
        answered_at    TEXT,
        apply_id       INTEGER REFERENCES link_apply_requests(id),
        question       TEXT,
        fix            TEXT,
        applied_build  INTEGER,
        created_at     TEXT    NOT NULL,
        updated_at     TEXT    NOT NULL
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_link_suggestions_state ON link_suggestions(state, deck_id)');
      db.exec(`CREATE TABLE IF NOT EXISTS owner_links (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        supply_oracle  TEXT    NOT NULL,
        demand_oracle  TEXT    NOT NULL,
        effect         TEXT    NOT NULL CHECK (effect IN ('add','block')),
        sign           TEXT    NOT NULL CHECK (sign IN ('+','-')),
        weak           INTEGER NOT NULL DEFAULT 0,
        suggestion_id  INTEGER REFERENCES link_suggestions(id),
        note           TEXT    NOT NULL DEFAULT '',
        created_at     TEXT    NOT NULL,
        removed_at     TEXT
      )`);
    },
  },
];

export function appliedMigrations(db: DatabaseSync): number[] {
  // Idempotent write: cheap, and the table exists after the first call so this is a no-op thereafter.
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  return (db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: number }>)
    .map((r) => r.id);
}

/**
 * Applies pending migrations. Idempotent; safe to call on every openDb().
 *
 * PRAGMA foreign_keys is deliberately toggled OUTSIDE the transaction - inside one it
 * is silently a no-op, and a table rebuild that drops and renames needs it off.
 */
export function runMigrations(db: DatabaseSync): number[] {
  const done = new Set(appliedMigrations(db));
  const pending = MIGRATIONS.filter((m) => !done.has(m.id));
  if (pending.length === 0) return [];

  db.exec('PRAGMA foreign_keys = OFF');
  const applied: number[] = [];
  try {
    for (const m of pending) {
      // IMMEDIATE takes the write lock up front, so a second process opening the same file
      // waits on busy_timeout instead of failing a deferred lock upgrade with "database is
      // locked" (vitest's parallel files all openDb() the real database). Once it holds the
      // lock it re-checks, because the process it waited on may have applied this migration.
      db.exec('BEGIN IMMEDIATE');
      try {
        if (db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(m.id)) {
          db.exec('COMMIT');
          continue;
        }
        m.up(db);
        db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)')
          .run(m.id, m.name, new Date().toISOString());
        db.exec('COMMIT');
        applied.push(m.id);
      } catch (err) {
        db.exec('ROLLBACK');
        throw new Error(`migration ${m.id} (${m.name}) failed: ${(err as Error).message}`);
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    throw new Error(`migrations left ${violations.length} foreign key violations`);
  }
  return applied;
}