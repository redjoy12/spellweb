PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------- card pool ----------

-- One row per successful (or attempted) Scryfall bulk ingest.
CREATE TABLE IF NOT EXISTS snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type       TEXT    NOT NULL,           -- 'default_cards'
  source_uri        TEXT    NOT NULL,
  source_updated_at TEXT    NOT NULL,           -- Scryfall bulk entry updated_at
  ingested_at       TEXT    NOT NULL,           -- ISO-8601 UTC
  printings_seen    INTEGER NOT NULL DEFAULT 0,
  cards_kept        INTEGER NOT NULL DEFAULT 0,
  status            TEXT    NOT NULL CHECK (status IN ('in_progress','complete','failed'))
);

-- The pool exactly as it was in one snapshot. Immutable once complete.
CREATE TABLE IF NOT EXISTS snapshot_cards (
  snapshot_id      INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  oracle_id        TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  layout           TEXT    NOT NULL,
  mana_cost        TEXT,
  cmc              REAL    NOT NULL,
  type_line        TEXT    NOT NULL,
  oracle_text      TEXT,
  colors           TEXT    NOT NULL,            -- JSON array
  color_identity   TEXT    NOT NULL,            -- JSON array
  keywords         TEXT    NOT NULL,            -- JSON array
  power            TEXT,
  toughness        TEXT,
  rarity           TEXT    NOT NULL,
  arena_id         INTEGER,
  set_code         TEXT    NOT NULL,
  collector_number TEXT    NOT NULL,
  image_normal     TEXT,
  image_art_crop   TEXT,
  faces_json       TEXT    NOT NULL,            -- JSON array of CardFace
  oracle_hash      TEXT    NOT NULL,            -- sha256 over canonical face text
  PRIMARY KEY (snapshot_id, oracle_id)
);

-- The living pool. Rows are never deleted (§5.2).
CREATE TABLE IF NOT EXISTS cards (
  oracle_id              TEXT PRIMARY KEY,
  name                   TEXT    NOT NULL,
  layout                 TEXT    NOT NULL,
  mana_cost              TEXT,
  cmc                    REAL    NOT NULL,
  type_line              TEXT    NOT NULL,
  oracle_text            TEXT,
  colors                 TEXT    NOT NULL,
  color_identity         TEXT    NOT NULL,
  keywords               TEXT    NOT NULL,
  power                  TEXT,
  toughness              TEXT,
  rarity                 TEXT    NOT NULL,
  arena_id               INTEGER,
  set_code               TEXT    NOT NULL,
  collector_number       TEXT    NOT NULL,
  image_normal           TEXT,
  image_art_crop         TEXT,
  oracle_hash            TEXT    NOT NULL,
  first_seen_snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  last_seen_snapshot_id  INTEGER NOT NULL REFERENCES snapshots(id),
  rotated                INTEGER NOT NULL DEFAULT 0,
  rotated_at             TEXT
);
CREATE INDEX IF NOT EXISTS idx_cards_rotated ON cards(rotated);
CREATE INDEX IF NOT EXISTS idx_cards_cmc     ON cards(cmc);

-- One row per face. Single-faced cards get exactly one row at face_index 0,
-- so every consumer (notably Phase 2 span extraction) sees a uniform shape.
CREATE TABLE IF NOT EXISTS card_faces (
  oracle_id    TEXT    NOT NULL REFERENCES cards(oracle_id) ON DELETE CASCADE,
  face_index   INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  mana_cost    TEXT,
  type_line    TEXT    NOT NULL,
  oracle_text  TEXT    NOT NULL DEFAULT '',
  power        TEXT,
  toughness    TEXT,
  colors       TEXT    NOT NULL,
  image_normal TEXT,
  PRIMARY KEY (oracle_id, face_index)
);

CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
  oracle_id UNINDEXED, name, type_line, oracle_text, tokenize = 'unicode61'
);

-- ---------- rotation ----------

CREATE TABLE IF NOT EXISTS pool_diffs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  from_snapshot_id  INTEGER REFERENCES snapshots(id),   -- NULL for the first ingest
  to_snapshot_id    INTEGER NOT NULL REFERENCES snapshots(id),
  created_at        TEXT    NOT NULL,
  added_count       INTEGER NOT NULL,
  changed_count     INTEGER NOT NULL,
  rotated_count     INTEGER NOT NULL,
  returned_count    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pool_diff_entries (
  diff_id         INTEGER NOT NULL REFERENCES pool_diffs(id) ON DELETE CASCADE,
  oracle_id       TEXT    NOT NULL,
  change          TEXT    NOT NULL CHECK (change IN ('added','oracle_changed','rotated','returned')),
  old_oracle_hash TEXT,
  new_oracle_hash TEXT,
  PRIMARY KEY (diff_id, oracle_id)
);

-- Consumed by Phase 2. Phase 1 only fills it.
CREATE TABLE IF NOT EXISTS extraction_queue (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  oracle_id      TEXT    NOT NULL REFERENCES cards(oracle_id),
  reason         TEXT    NOT NULL CHECK (reason IN
                   ('new_card','oracle_changed','schema_promoted',
                    'kernel_changed','splitter_changed','review_correction')),
  enqueued_at    TEXT    NOT NULL,
  source_diff_id INTEGER REFERENCES pool_diffs(id),
  status         TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done'))
);
CREATE INDEX IF NOT EXISTS idx_queue_card ON extraction_queue(oracle_id, status);
-- At most one open request per card; history of completed ones is retained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_open
  ON extraction_queue(oracle_id) WHERE status = 'pending';

-- ---------- comprehensive rules ----------

CREATE TABLE IF NOT EXISTS rules_corpus (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_uri     TEXT    NOT NULL,
  effective_date TEXT    NOT NULL,              -- parsed from the document itself
  sha256         TEXT    NOT NULL UNIQUE,
  fetched_at     TEXT    NOT NULL,
  section_count  INTEGER NOT NULL,
  rule_count     INTEGER NOT NULL,
  glossary_count INTEGER NOT NULL,
  is_current     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rule_sections (
  corpus_id     INTEGER NOT NULL REFERENCES rules_corpus(id) ON DELETE CASCADE,
  number        TEXT    NOT NULL,               -- '702'  or top-level '7'
  parent_number TEXT,                           -- '7'    or NULL
  title         TEXT    NOT NULL,
  ordinal       INTEGER NOT NULL,
  PRIMARY KEY (corpus_id, number)
);

CREATE TABLE IF NOT EXISTS rules (
  corpus_id          INTEGER NOT NULL REFERENCES rules_corpus(id) ON DELETE CASCADE,
  number             TEXT    NOT NULL,          -- '702.2a'
  section_number     TEXT    NOT NULL,          -- '702'
  subsection_number  TEXT,                      -- '702.2'
  subsection_title   TEXT,                      -- 'Deathtouch', when the subsection is titled
  text               TEXT    NOT NULL,
  ordinal            INTEGER NOT NULL,
  PRIMARY KEY (corpus_id, number)
);
CREATE INDEX IF NOT EXISTS idx_rules_section    ON rules(corpus_id, section_number);
CREATE INDEX IF NOT EXISTS idx_rules_subsection ON rules(corpus_id, subsection_number);

CREATE TABLE IF NOT EXISTS glossary_entries (
  corpus_id  INTEGER NOT NULL REFERENCES rules_corpus(id) ON DELETE CASCADE,
  term       TEXT    NOT NULL,
  term_key   TEXT    NOT NULL,                  -- normalised lowercase
  definition TEXT    NOT NULL,
  cross_refs TEXT    NOT NULL,                  -- JSON array of rule numbers
  PRIMARY KEY (corpus_id, term_key)
);

-- The I2 artefacts: both built by parsing, never hand-typed.
CREATE TABLE IF NOT EXISTS keyword_rule_map (
  corpus_id   INTEGER NOT NULL REFERENCES rules_corpus(id) ON DELETE CASCADE,
  keyword     TEXT    NOT NULL,
  keyword_key TEXT    NOT NULL,
  rule_number TEXT,                             -- NULL when unresolved / no rule exists
  resolution  TEXT    NOT NULL CHECK (resolution IN
                ('subsection_title','glossary_crossref','ability_word_no_rule','unresolved')),
  evidence    TEXT    NOT NULL,                 -- the exact parsed text that justified it
  PRIMARY KEY (corpus_id, keyword_key)
);

-- Subtype and card-form to rule section, derived from rule 205.3's parentheticals
-- and from section titles matching "<X> Cards". Replaces a hand-authored config map.
CREATE TABLE IF NOT EXISTS type_rule_map (
  corpus_id   INTEGER NOT NULL REFERENCES rules_corpus(id) ON DELETE CASCADE,
  term        TEXT    NOT NULL,                 -- 'Equipment', 'Double-Faced'
  term_key    TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('subtype','card_form')),
  rule_number TEXT    NOT NULL,
  resolution  TEXT    NOT NULL CHECK (resolution IN ('subtype_crossref','section_title')),
  evidence    TEXT    NOT NULL,
  PRIMARY KEY (corpus_id, term_key, kind)
);

-- ---------- phase 2: packet gating ----------

CREATE TABLE IF NOT EXISTS rule_term_index (
  corpus_id    INTEGER NOT NULL REFERENCES rules_corpus(id) ON DELETE CASCADE,
  term         TEXT    NOT NULL,
  term_key     TEXT    NOT NULL,
  source       TEXT    NOT NULL CHECK (source IN ('glossary','subsection_title','type_map')),
  rule_numbers TEXT    NOT NULL,
  definition   TEXT,
  evidence     TEXT    NOT NULL,
  PRIMARY KEY (corpus_id, term_key, source)
);

CREATE TABLE IF NOT EXISTS packet_kernel (
  corpus_id   INTEGER NOT NULL REFERENCES rules_corpus(id) ON DELETE CASCADE,
  rule_number TEXT    NOT NULL,
  origin      TEXT    NOT NULL CHECK (origin IN ('golden_citation','review_promoted')),
  evidence    TEXT    NOT NULL,
  PRIMARY KEY (corpus_id, rule_number)
);

-- ---------- phase 2: atom vocabulary ----------

CREATE TABLE IF NOT EXISTS atom_types (
  schema_version INTEGER NOT NULL,
  family         TEXT NOT NULL CHECK (family IN
                   ('PRODUCES','CARES_ABOUT','ENABLES','COMBAT','INTERACTION','CONSTRAINTS')),
  type_key       TEXT NOT NULL,
  label          TEXT NOT NULL,
  params_schema  TEXT NOT NULL,
  provenance     TEXT NOT NULL CHECK (provenance IN
                   ('spec_4_1','cr_701','cr_702','review_promoted')),
  evidence       TEXT NOT NULL,
  PRIMARY KEY (schema_version, family, type_key)
);

-- ---------- clauses ----------

CREATE TABLE IF NOT EXISTS clauses (
  oracle_id       TEXT    NOT NULL,
  face_index      INTEGER NOT NULL,
  clause_index    INTEGER NOT NULL,
  span_start      INTEGER NOT NULL,
  span_end        INTEGER NOT NULL,
  text            TEXT    NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN
                     ('ability','reminder','mode','flavor_word','chapter','loyalty')),
  oracle_hash     TEXT    NOT NULL,
  splitter_version INTEGER NOT NULL,
  PRIMARY KEY (oracle_id, face_index, clause_index),
  FOREIGN KEY (oracle_id, face_index) REFERENCES card_faces(oracle_id, face_index) ON DELETE CASCADE
);

-- ---------- runs ----------

CREATE TABLE IF NOT EXISTS extraction_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at        TEXT    NOT NULL,
  finished_at       TEXT,
  provider          TEXT    NOT NULL,
  model             TEXT    NOT NULL,
  schema_version    INTEGER NOT NULL,
  corpus_id         INTEGER NOT NULL REFERENCES rules_corpus(id),
  packet_policy_sha TEXT    NOT NULL,
  splitter_version  INTEGER NOT NULL,
  batch_kind        TEXT    NOT NULL CHECK (batch_kind IN
                       ('golden','stratified','colors','full','requeue')),
  cards_attempted   INTEGER NOT NULL DEFAULT 0,
  cards_passed      INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  status            TEXT    NOT NULL CHECK (status IN ('in_progress','complete','failed'))
);

-- ---------- atoms ----------

CREATE TABLE IF NOT EXISTS atoms (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  oracle_id         TEXT    NOT NULL,
  face_index        INTEGER NOT NULL,
  schema_version    INTEGER NOT NULL,
  family            TEXT    NOT NULL,
  type_key          TEXT    NOT NULL,
  params_json       TEXT    NOT NULL,
  span_start        INTEGER NOT NULL,
  span_end          INTEGER NOT NULL,
  quote             TEXT    NOT NULL,
  span_ambiguous    INTEGER NOT NULL DEFAULT 0,
  rule_numbers      TEXT    NOT NULL,       -- JSON array, verified subset of the packet
  confidence        REAL    NOT NULL,
  confidence_source TEXT    NOT NULL CHECK (confidence_source IN ('model','vote')),
  oracle_hash       TEXT    NOT NULL,       -- text this atom was read from
  pass_index        INTEGER NOT NULL DEFAULT 0,
  -- Two verdicts, deliberately separate (Task 9 ruling R9-1). `consensus` is this run's own
  -- verdict on the atom (sec. 7.2 voting; 1 on single-pass cards) and never changes once the
  -- run has decided. `is_current` is the card's live atom set across runs (sec. 10.3): a later
  -- run or an errata demotes it. Scoring a run reads `consensus`; every product read path
  -- reads `is_current`. One flag doing both jobs makes a re-extraction erase the evidence
  -- the earlier run is scored on.
  consensus         INTEGER NOT NULL DEFAULT 1,
  is_current        INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (oracle_id, face_index) REFERENCES card_faces(oracle_id, face_index) ON DELETE CASCADE,
  FOREIGN KEY (schema_version, family, type_key)
    REFERENCES atom_types(schema_version, family, type_key)
);
CREATE INDEX IF NOT EXISTS idx_atoms_card ON atoms(oracle_id, is_current);
CREATE INDEX IF NOT EXISTS idx_atoms_type ON atoms(family, type_key, is_current);
CREATE INDEX IF NOT EXISTS idx_atoms_run  ON atoms(run_id);

-- The vocabulary escape hatch. Never atoms, never edges.
CREATE TABLE IF NOT EXISTS unclassified_clauses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  oracle_id      TEXT    NOT NULL,
  face_index     INTEGER NOT NULL,
  span_start     INTEGER NOT NULL,
  span_end       INTEGER NOT NULL,
  quote          TEXT    NOT NULL,
  proposed_label TEXT    NOT NULL,
  rationale      TEXT    NOT NULL,
  oracle_hash    TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','promoted','rejected')),
  FOREIGN KEY (oracle_id, face_index) REFERENCES card_faces(oracle_id, face_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_unclassified_card ON unclassified_clauses(oracle_id);

-- The packet-policy escape hatch (sec. 6.4). The mechanism that makes gate holes visible.
CREATE TABLE IF NOT EXISTS missing_rule_reports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  oracle_id      TEXT    NOT NULL,
  face_index     INTEGER NOT NULL,
  quote          TEXT    NOT NULL,
  statement      TEXT    NOT NULL,          -- what could not be justified
  resolved_rule  TEXT,                      -- rule promoted to the kernel on acceptance
  oracle_hash    TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','accepted','rejected')),
  FOREIGN KEY (oracle_id, face_index) REFERENCES card_faces(oracle_id, face_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_missing_rule_card ON missing_rule_reports(oracle_id);

-- ---------- gate outcomes ----------

CREATE TABLE IF NOT EXISTS extraction_results (
  run_id                 INTEGER NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  oracle_id              TEXT    NOT NULL REFERENCES cards(oracle_id),
  coverage_ratio         REAL    NOT NULL,   -- 1.0 when the clause denominator is zero
  uncovered_clauses_json TEXT    NOT NULL,
  passes_run             INTEGER NOT NULL,
  vote_agreement         REAL,               -- NULL for single-pass cards
  connective_atom_count  INTEGER NOT NULL,
  packet_chars           INTEGER NOT NULL,
  packet_tokens          INTEGER NOT NULL,
  outcome                TEXT    NOT NULL CHECK (outcome IN ('passed','flagged','failed')),
  failure_detail         TEXT,               -- why a 'failed' card failed + the raw response, truncated
  PRIMARY KEY (run_id, oracle_id)
);
CREATE INDEX IF NOT EXISTS idx_results_card ON extraction_results(oracle_id);

CREATE TABLE IF NOT EXISTS splitter_disagreements (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id           INTEGER NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  oracle_id        TEXT    NOT NULL,
  face_index       INTEGER NOT NULL,
  quote            TEXT    NOT NULL,
  note             TEXT    NOT NULL,
  splitter_version INTEGER NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','accepted','rejected')),
  FOREIGN KEY (oracle_id, face_index) REFERENCES card_faces(oracle_id, face_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_splitter_card ON splitter_disagreements(oracle_id);

-- One row per FINDING, not per card: a card may hold several at once (sec. 7.4).
CREATE TABLE IF NOT EXISTS review_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  domain        TEXT    NOT NULL DEFAULT 'atom',   -- Phase 3 sec. 10.1: 'atom' or 'edge'
  oracle_id     TEXT    REFERENCES cards(oracle_id),
  run_id        INTEGER REFERENCES extraction_runs(id) ON DELETE CASCADE,
  rule_set_id   INTEGER REFERENCES edge_rule_sets(id),
  build_id      INTEGER REFERENCES graph_builds(id),
  severity      TEXT    NOT NULL,
  severity_rank INTEGER NOT NULL,            -- per domain: 1..5 atom (sec. 7.4), 1..3 edge (Phase 3 sec. 10.1)
  rank_score    INTEGER NOT NULL,            -- connective_atom_count (atom); per-severity score (edge)
  detail_table  TEXT,                        -- which table the finding lives in
  detail_id     INTEGER,                     -- its row id, for sec. 11.2's deep link
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
-- The unique key is the index review_queue_finding. Migration 4 creates it: on a database
-- older than migration 4 the column `domain` does not exist when this file runs.
CREATE INDEX IF NOT EXISTS idx_review_open
  ON review_queue(status, severity_rank, rank_score DESC);

-- ---------- golden set ----------

CREATE TABLE IF NOT EXISTS golden_cards (
  oracle_id   TEXT PRIMARY KEY REFERENCES cards(oracle_id),
  complete    INTEGER NOT NULL DEFAULT 0,   -- exhaustive record; gates sec. 8.2 precision
  oracle_hash TEXT    NOT NULL,
  verified_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS golden_atoms (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  oracle_id      TEXT    NOT NULL REFERENCES golden_cards(oracle_id) ON DELETE CASCADE,
  face_index     INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  family         TEXT    NOT NULL,
  type_key       TEXT    NOT NULL,
  params_json    TEXT    NOT NULL,
  span_start     INTEGER NOT NULL,
  span_end       INTEGER NOT NULL,
  quote          TEXT    NOT NULL,
  rule_numbers   TEXT    NOT NULL,          -- drives kernel derivation (sec. 3.4)
  oracle_hash    TEXT    NOT NULL,
  source         TEXT    NOT NULL CHECK (source IN ('authored','review_correction')),
  verified_at    TEXT    NOT NULL,
  FOREIGN KEY (schema_version, family, type_key)
    REFERENCES atom_types(schema_version, family, type_key)
);
CREATE INDEX IF NOT EXISTS idx_golden_card ON golden_atoms(oracle_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_golden_dedupe
  ON golden_atoms(oracle_id, face_index, family, type_key, span_start);

-- ---------- Phase 3: synergy graph (Phase 3 spec sec. 10.2) ----------
-- Migration 5 (src/db/migrate.ts) holds the same DDL for a database older than Phase 3.

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
  atom_sha        TEXT    NOT NULL DEFAULT '',   -- groupAtomSha of the card's atoms; '' = before migration 10
  PRIMARY KEY (oracle_id, face_index, oracle_hash, tests_version, atom_sha, group_index)
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

-- Phase 3 Task 3 (migration 8): two tables that spec sec. 10.2 does not have.
-- The batches of an edge-rule set: the packet references of each batch, so that the submit
-- checks each quote against the packet that the deriver read (sec. 5.4 check 5, plan D16).
CREATE TABLE IF NOT EXISTS edge_rule_batches (
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  stage           TEXT    NOT NULL CHECK (stage IN ('roles','pairs')),
  batch_key       TEXT    NOT NULL,   -- 'roles-<chunk>', or 'FAMILY.TYPE_KEY-<chunk>' for pairs
  demand          TEXT,               -- Stage B: the demand type, FAMILY.TYPE_KEY
  types_json      TEXT    NOT NULL,   -- the types that the packet shows
  refs_json       TEXT    NOT NULL,   -- the exact rule numbers and 'glossary:<term>' keys shown
  packet_sha      TEXT    NOT NULL,
  packet_bytes    INTEGER NOT NULL,
  prepared_at     TEXT    NOT NULL,
  PRIMARY KEY (set_id, stage, batch_key)
);
-- A person's decision on a role item (plan D13): adopt one pass, keep 'none', or keep the voted role.
CREATE TABLE IF NOT EXISTS edge_role_decisions (
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  family          TEXT    NOT NULL,
  type_key        TEXT    NOT NULL,
  decision        TEXT    NOT NULL CHECK (decision IN ('pass','none','keep')),
  pass_index      INTEGER,            -- the adopted pass; null for 'none'
  note            TEXT    NOT NULL,
  decided_at      TEXT    NOT NULL,
  decided_by      TEXT    NOT NULL DEFAULT 'owner' CHECK (decided_by IN ('owner','debate')),  -- migration 9
  debate_round    INTEGER,            -- migration 9: the round that agreed; null for an owner decision
  PRIMARY KEY (set_id, family, type_key)
);
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
-- Migration 11 (owner request 2026-10-18): "Fix this reason". The UI saves one row; the fix-dispatch mod
-- reads the queued rows, sends the brief file to the Claude session with the title session_name, then marks it sent.
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
  sent_at         TEXT,
  -- Migration 12: the delivery by the fix-dispatch mod (.claude/skills/fix-dispatch).
  session_id      TEXT,               -- the Claude session that got the brief
  delivery_error  TEXT,               -- why the last delivery failed (no session with the name, archived); null after a delivery
  delivery_at     TEXT                -- the time of the last failed delivery; the mod tries again after one minute
);

-- Migration 15 (schema v15 plan, Task 5 Step 1): a carry-forward set copies the roles and the rules of the
-- unchanged demand types of an earlier set. One row for each carried demand type (src/graph/ruleCarry.ts).
CREATE TABLE IF NOT EXISTS edge_rule_carry (
  set_id          INTEGER NOT NULL REFERENCES edge_rule_sets(id) ON DELETE CASCADE,
  from_set_id     INTEGER NOT NULL REFERENCES edge_rule_sets(id),
  demand          TEXT    NOT NULL,   -- FAMILY.TYPE_KEY: its rules are copies of the rules of from_set_id
  rules           INTEGER NOT NULL,   -- the rules copied (accepted and disputed)
  PRIMARY KEY (set_id, demand)
);

-- Migration 13 (owner request 2026-10-18): the owner's answers on the "Your decisions" page.
-- An answer changes nothing else; a later step applies it (src/graph/ownerDecisions.ts).
CREATE TABLE IF NOT EXISTS owner_decisions (
  kind        TEXT NOT NULL CHECK (kind IN ('cr_text','rule_conflict','supply_twin','link_check','reading','type_role','wrong_link','tag_check','tag_merge','golden_check','link_rule')),
  item_key    TEXT NOT NULL,
  choice      TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  decided_at  TEXT NOT NULL,
  PRIMARY KEY (kind, item_key)
);

-- Migration 21 (Phase 4 design sec. 11): the decks of the goal form. deck_json holds the cards, the
-- mana base, the reasons and the warnings; policy_sha is the SHA of config/deck-policy.json.
CREATE TABLE IF NOT EXISTS decks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id    INTEGER NOT NULL REFERENCES graph_builds(id),
  goal_json   TEXT    NOT NULL,
  policy_sha  TEXT    NOT NULL,
  deck_json   TEXT    NOT NULL,
  created_at  TEXT    NOT NULL
);

-- Migration 22 (card rate plan Task 4): the text rate of each spell. It is not a win rate. The table
-- holds one build. A null rate is a card with no value; `reason` says why. `rate` 0 with `no_group`
-- is not a low rate. A build reads no row here.
CREATE TABLE IF NOT EXISTS card_rates (
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
);

-- Migration 24 (game review design sec. 5). `arena_cards`: the name of each Arena card ID, from the
-- card file of the install. A token or a card outside this app has no oracle_id. `game_log_files`:
-- how far the scan has read each log. `game_scan_state`: one row, the result of the newest scan.
-- `games`: one row for each game. `file` is the name of its kept messages in data/game-logs/, so a
-- parser fix can read the game again. `game_json` holds Arena IDs. No screen name and no account ID
-- are in these tables. The deck search reads none of them.
CREATE TABLE IF NOT EXISTS arena_cards (
  arena_id   INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  oracle_id  TEXT    REFERENCES cards(oracle_id),
  is_token   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_log_files (
  log_id   TEXT    PRIMARY KEY,
  read_to  INTEGER NOT NULL,
  closed   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS game_scan_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  log_found   INTEGER NOT NULL DEFAULT 0,
  detailed    INTEGER,
  scanned_at  TEXT,
  error       TEXT,
  card_file   TEXT
);

CREATE TABLE IF NOT EXISTS games (
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
);

CREATE INDEX IF NOT EXISTS idx_games_deck ON games(deck_id, played_at);
