import type { DeckView } from '../deck/justify.js';
import type { ChatMessage } from '../server/chat/store.js';
import type { DeckGames } from '../games/counts.js';
import type { ApplyRequestView, LinkChangesPage, OwnerAnswer } from '../deck/linkChanges.js';

export type { DeckCardView, DeckView, LinkView } from '../deck/justify.js';
export type { ApplyRequestView, LinkChangesPage, OwnerAnswer, SuggestionView } from '../deck/linkChanges.js';
export type { DeckWarning } from '../deck/check.js';
export type { ChatMessage, SwapBox } from '../server/chat/store.js';
export type { CardCount, DeckGames, GameView, ScanStatus } from '../games/counts.js';

export interface CardSummary {
  oracle_id: string; name: string; mana_cost: string | null; cmc: number;
  type_line: string; colors: string[]; color_identity: string[]; keywords: string[];
  rarity: string; image_normal: string | null; image_art_crop: string | null;
  rotated: number; set_code: string; collector_number: string; arena_id: number | null;
}

/** The goal form of a deck (Phase 4 design sec. 4). */
export interface DeckGoal {
  colours: 'B' | 'R' | 'BR'; seeds: string[]; excluded: string[]; target_turn: number;
  interaction: 'none' | 'some' | 'heavy'; min_creatures: number; use_rate: boolean;
  /** Build chat design sec. 3. Optional in a request; a stored deck always has them. */
  pinned?: string[]; excluded_tags?: string[];
}

/** One talk about one deck (deck chat design sec. 5). */
export interface DeckChatView {
  model: string; fallback_model: string; running: boolean; flagged: boolean;
  /** The swap box that "Undo" takes back. */
  undo_message_id: number | null;
  /** The tokens of the session after the newest turn, and the limit of its model. */
  context: { used: number; limit: number } | null;
  messages: ChatMessage[];
}

/** A card of a build talk draft, with its name, so the form can show it. */
export interface DraftCard { oracle_id: string; name: string; color_identity: string[] }

/** The goal form of a build talk (build chat design sec. 4). */
export interface BuildDraft {
  colours: DeckGoal['colours']; target_turn: number; interaction: DeckGoal['interaction']; min_creatures: number; use_rate: boolean;
  seeds: DraftCard[]; pinned: DraftCard[]; excluded: DraftCard[]; excluded_tags: string[];
}

/** One talk before a deck exists (build chat design sec. 8). */
export interface BuildChatView {
  id: number; model: string; fallback_model: string; running: boolean; flagged: boolean;
  context: { used: number; limit: number } | null;
  messages: ChatMessage[]; draft: BuildDraft; brief: string;
  /** The deck that this talk built. A talk with a deck takes no new message. */
  deck_id: number | null; created_at: string;
}

export interface BuildTalkSummary { id: number; created_at: string; deck_id: number | null; first_message: string | null }

export interface DeckSummary {
  id: number; build_id: number; created_at: string; colours: string; target_turn: number;
  seeds: string[]; land_count: number; warnings: number; use_rate: boolean;
}

export interface CardFace {
  face_index: number; name: string; mana_cost: string | null; type_line: string;
  oracle_text: string; power: string | null; toughness: string | null;
  colors: string[]; image_normal: string | null;
}

export interface PacketSection {
  number: string; title: string; rules: Array<{ number: string; text: string }>; chars: number;
}

/** A matched term whose glossary definition the extraction packet carried. */
export interface PacketGlossaryTerm { term: string; surface: string; source: string; definition: string }

/** The scoped packet Phase 2 extraction sends (`GET /api/cards/:id/packet`). `core` is the kernel. */
export interface RulesPacket {
  corpusId: number; effectiveDate: string;
  core: PacketSection[]; cardSpecific: PacketSection[];
  glossary: PacketGlossaryTerm[];
  /** Gate 4's whitelist: every rule number the packet's text covers. */
  packetRules: string[];
  unresolvedKeywords: string[]; missingRules: string[];
  coreChars: number; cardChars: number; glossaryChars: number; packetChars: number;
}

export interface KeywordMapping {
  keyword: string; keyword_key: string; rule_number: string | null;
  resolution: 'subsection_title' | 'glossary_crossref' | 'ability_word_no_rule' | 'unresolved';
  evidence: string;
}

// ---------- Phase 2 / Task 5: card inspector (`GET /api/cards/:id/atoms`) ----------
// Mirrors src/server/routes/atoms.ts so the web client does not import the splitter.

export type ClauseKind = 'ability' | 'reminder' | 'mode' | 'flavor_word' | 'chapter' | 'loyalty';
export type AtomFamily = 'PRODUCES' | 'CARES_ABOUT' | 'ENABLES' | 'COMBAT' | 'INTERACTION' | 'CONSTRAINTS';

export interface AtomClause {
  face_index: number; clause_index: number; span_start: number; span_end: number;
  text: string; kind: ClauseKind;
}

export interface AtomRow {
  id: number; face_index: number; schema_version: number;
  family: AtomFamily; type_key: string; params: Record<string, unknown>;
  span_start: number; span_end: number; quote: string; span_ambiguous: boolean;
  rule_numbers: string[]; confidence: number;
}

export interface UnclassifiedMark {
  id: number; span_start: number; span_end: number; quote: string;
  proposed_label: string; status: string;
}

export interface MissingRuleMark {
  id: number; quote: string; statement: string;
  resolved_rule: string | null; status: string;
}

export interface AtomFace {
  face_index: number; oracle_text: string;
  clauses: AtomClause[]; atoms: AtomRow[];
  unclassified: UnclassifiedMark[]; missingRules: MissingRuleMark[];
}

export interface AtomsResponse {
  faces: AtomFace[];
  coverage: { ratio: number; uncovered: number[] } | null;
}

// ---------- Phase 2 / Task 6: golden-set adjudication (`/api/golden/*`) ----------
// Mirrors src/server/routes/golden.ts. The review surface is read-only until the
// owner presses accept or reject; nothing here can bypass the server-side gates.

export type DraftStage = 'not-started' | 'packet' | 'drafted' | 'accepted' | 'rejected';

export interface ReviewRecord {
  oracle_id: string;
  decision: 'accepted' | 'rejected';
  complete: boolean;
  reviewed_at: string;
  note: string;
  excluded?: Array<{ kind: 'atom' | 'unclassified'; index: number; summary: string }>;
}

export interface QueueEntry {
  oracle_id: string; name: string; stage: DraftStage;
  atoms: number; unclassified: number; lookups: number;
  valid: boolean | null; errors: number; warnings: number; uncovered_clauses: number;
  claims_complete: boolean | null; has_notes: boolean;
  review: ReviewRecord | null;
}

export interface QueueResponse {
  counts: Record<DraftStage, number>;
  written: { total: number; complete: number };
  candidates: number;
  items: QueueEntry[];
}

export interface DraftRuleCitation { number: string; text: string; in_packet: boolean }

export interface DraftAtomView {
  index: number; face_index: number; family: string; type_key: string;
  label: string | null; params: Record<string, unknown>;
  span_start: number; span_end: number; quote: string; rationale: string;
  rules: DraftRuleCitation[];
}

export interface DraftUnclassifiedView {
  index: number; face_index: number; span_start: number; span_end: number;
  quote: string; proposed_label: string; rationale: string;
}

export interface DraftFaceView {
  face_index: number; name: string; oracle_text: string;
  clauses: Array<{ clause_index: number; kind: string; span_start: number; span_end: number; text: string }>;
}

export interface ProposalValidation {
  ok: boolean; errors: string[]; warnings: string[];
  atoms: number; unclassified: number;
  non_reminder_clauses: number; uncovered_clauses: number;
}

export interface LookupRecord { at: string; kind: 'rule' | 'search' | 'glossary'; query: string; returned: string[] }

export interface DraftDetail {
  oracle_id: string; name: string; type_line: string; layout: string; rarity: string;
  stage: DraftStage; drafted_by: string; drafted_at: string;
  claims_complete: boolean; notes: string;
  faces: DraftFaceView[];
  atoms: DraftAtomView[];
  unclassified: DraftUnclassifiedView[];
  validation: ProposalValidation;
  lookups: LookupRecord[];
  review: ReviewRecord | null;
  packet: { generated_at: string; rule_count: number; term_count: number } | null;
}

export interface AcceptRequest {
  /** Never defaulted client-side: the completeness claim is the owner's, sec. 8.2. */
  complete: boolean;
  note?: string;
  exclude?: { atoms?: number[]; unclassified?: number[] };
}

// ---------- Phase 2 / Task 9: review queue + extraction runs (`/api/review/*`, `/api/runs`) ----------
// Mirrors src/atoms/queue.ts and src/atoms/runs.ts.

export type Severity = 'coverage_miss' | 'missing_rule' | 'vote_disagreement' | 'unclassified' | 'splitter_disagreement';

export interface FocusSpan { face_index: number; span_start: number; span_end: number }

export interface QueueFinding {
  id: number; oracle_id: string; name: string; run_id: number;
  severity: Severity; severity_rank: number; rank_score: number; rank_key?: 'degree' | 'connective';
  detail_table: string | null; detail_id: number | null;
  status: 'pending' | 'resolved'; enqueued_at: string;
  summary: string; focus: FocusSpan[];
  detail: Record<string, unknown> | null;
}

export interface ReviewQueueResponse { counts: Record<Severity, number>; items: QueueFinding[] }

// Phase 3 sec. 10.1: the `edge` domain of the same queue. Mirrors src/graph/edgeQueue.ts.
export type EdgeSeverity = 'edge_role_disagreement' | 'edge_rule_disagreement' | 'edge_report';

export interface EdgeFinding {
  id: number; oracle_id: string | null; name: string | null;
  rule_set_id: number; build_id: number | null;
  severity: EdgeSeverity; severity_rank: number; rank_score: number;
  detail_table: string | null; detail_id: number | null;
  status: 'pending' | 'resolved'; enqueued_at: string;
  summary: string;
  /** For a role finding: FAMILY.TYPE_KEY. */
  role_type: string | null;
}

export interface EdgeQueueResponse { counts: Record<EdgeSeverity, number>; items: EdgeFinding[] }

// Phase 3 Task 3: the Stage A roles and the role decision (plan D13). Mirrors src/graph/ruleSchema.ts and ruleSet.ts.
export interface RuleEvidence { source: 'rule' | 'glossary'; ref: string; quote: string }
export interface ResourceEffect { resource: string; sign: '+' | '-'; kind: 'cost' | 'value'; note?: string; evidence: RuleEvidence[] }
export type EdgeRole = 'supply' | 'demand' | 'both' | 'none';
export interface RoleProposal {
  family: string; type_key: string; role: EdgeRole; demand_note?: string; resources: ResourceEffect[]; evidence: RuleEvidence[];
}
export interface StoredRole {
  family: string; type_key: string; role: EdgeRole; demand_note: string | null; resources: ResourceEffect[];
  evidence: RuleEvidence[]; votes: number; status: 'accepted' | 'disputed';
  decision: { decision: 'pass' | 'none' | 'keep'; pass_index: number | null; note: string; decided_at: string } | null;
}
export interface RoleProposals { role: StoredRole; proposals: Array<{ pass_index: number; item: RoleProposal }> }

export interface AtomTypeOption { family: AtomFamily; type_key: string; label: string; params_schema: string }

export interface CorrectionRequest {
  face_index: number; family: string; type_key: string; params: Record<string, unknown>;
  quote: string; span_start?: number; rule_numbers: string[];
}

export interface PromoteRequest { family: AtomFamily; type_key: string; label: string; evidence: string }

export interface GoldenRunScore {
  atom_precision: number; atom_recall: number; coverage: number; span_validity: number;
  citation_validity: number | null; missing_rule_rate: number; acceptable: boolean; failed: string[];
}

export interface RunStats {
  id: number; started_at: string; finished_at: string | null; wall_clock_ms: number | null;
  provider: string; model: string; schema_version: number; corpus_id: number;
  packet_policy_sha: string; policy_hash: 'current' | 'changed' | 'policy_only'; splitter_version: number;
  batch_kind: string; status: string; cards_attempted: number; finalised: number;
  outcomes: { passed: number; flagged: number; failed: number };
  pass_rate: number | null;
  coverage: { mean: number | null; buckets: Array<{ from: number; to: number | null; cards: number }> };
  missing_rule: { reports: number; cards: number; rate: number | null; open: number };
  unclassified: number; atoms: number; voted_cards: number;
  packet_chars: { cards: number; p50: number | null; p90: number | null; max: number | null };
  tokens: { input: number; output: number; measured: boolean };
  kernel: { rules: number; chars: number } | null;
  findings_pending: number;
  golden: GoldenRunScore | null;
}

export interface RunsResponse { runs: RunStats[]; release_bar: number; bars: Record<string, number> }

// Phase 3 sec. 11 and 13.5: the edge golden set. Mirrors src/graph/goldenLabel.ts.
export type GoldenLabel = 'synergy' | 'anti' | 'none';
export type GoldenCharacteristic = 'type_line' | 'mana_value' | 'color_identity' | 'power_toughness';
export type GoldenClauseRef = { face_index: number; clause_index: number } | { characteristic: GoldenCharacteristic };
export interface GoldenEvidence { source: 'rule' | 'glossary'; ref: string; quote: string }
export interface GoldenCardView {
  oracle_id: string; mana_value: number; color_identity: string[]; unavailable?: string;
  faces: Array<{ face_index: number; type_line: string; power: string | null; toughness: string | null; clauses: Array<{ face_index: number; clause_index: number; kind: string; text: string }> }>;
  atoms: Array<{ id: number; face_index: number; family: string; type_key: string; params: Record<string, unknown>; clauses: string[]; quote: string }>;
}
export interface GoldenPair {
  id: number; round: number; stratum: string; status: string; label: GoldenLabel | null; votes: number;
  supply_clause: GoldenClauseRef | null; demand_clause: GoldenClauseRef | null;
  supply_atom_id: number | null; demand_atom_id: number | null;
  cr_chain: GoldenEvidence[]; owner_note: string | null; in_sample: boolean;
  supply: GoldenCardView; demand: GoldenCardView;
  passes: Array<{ pass_index: number; answer: unknown; fault: string | null }>;
  review: { outcome: string; answer: unknown; fault: string | null } | null;
}
export interface GoldenProgress {
  met: boolean; labelled: number; cap: number; owner_correction_limit: number;
  targets: Array<{ target: string; want: number; have: number }>;
  agreement: { sample: number; sampled: number; decided: number; corrected: number; resolved_disputed: number; rate: number | null };
  review: { sample: number; reviewed: number; agree: number; clause_differs: number; label_differs: number; invalid: number; rate: number | null };
}
export type GoldenVerdict =
  | { accept: true; note?: string }
  | { accept: false; label: GoldenLabel; note: string; supply_clause?: GoldenClauseRef | null; demand_clause?: GoldenClauseRef | null;
      supply_atom_id?: number | null; demand_atom_id?: number | null; cr_chain?: GoldenEvidence[] };

// ---------- Phase 3 Task 7: the graph routes (`/api/graph/*`, `GET /api/edge-rules`) ----------
// Mirrors src/server/routes/graph.ts and the edge-rules route.

export type Grade = 'confirmed' | 'plausible';
export type GroupKind = 'triggered' | 'activated' | 'other';
export interface WeightParts { grade: number; repeat: number; cost: number; size: number; total: number }
export interface GraphBuild {
  id: number; build_key: string; rule_set_id: number; rule_set_version: number; scope: string;
  schema_version: number; tests_version: number; atom_set_sha: string; built_at: string; stale: boolean;
  counts: Record<string, unknown> & { synergy_pairs?: number; scope_cards?: number; atoms?: number; anti_pairs?: number;
    merged_edges?: Record<'+' | '-', { confirmed: number; plausible: number }> };
}
export interface GraphCardView {
  name: string; type_line: string; mana_cost: string | null; image?: string | null;
  faces: Array<{ face_index: number; name: string; oracle_text: string; image?: string | null }>;
}
export interface EdgeSideView { oracle_id: string; face_index: number; span: [number, number]; quote: string; group: string; kind: GroupKind }
export interface EdgeView {
  key: string; polarity: '+' | '-'; grade: Grade; unresolved: string[]; weight: WeightParts;
  supply: (EdgeSideView & { atom_ids: number[]; types: string[] }) | null;
  class: { id: string; intrinsic: string; value: string | number; member_count: number } | null;
  demand: EdgeSideView & { atom_id: number; type: string };
  demand_without_params: boolean;
  rule_hashes: string[];
}
export interface Predicate { param: string; op: string; value: unknown }
export interface RuleTypeSide { family: string; type_key: string; where: Predicate[] }
export type RuleSupplySide = RuleTypeSide | { intrinsic: string; value: string | number };
export interface EdgeRuleView {
  rule_hash: string; rule_id: string; polarity: '+' | '-'; supply: RuleSupplySide; demand: RuleTypeSide;
  param_links: Array<Record<string, unknown>>; implications: Array<{ demand_param: string; value: unknown; evidence: RuleEvidence[] }>;
  evidence: RuleEvidence[]; votes: number; status: 'accepted' | 'disputed';
}
export interface AbilityGroupRow {
  face_index: number; group_index: number; span_start: number; span_end: number; kind: GroupKind;
  cost_unparsed: number; per_turn_limit: number; unknown_limit: number;
}
export interface CentreAtom {
  id: number; face_index: number; family: AtomFamily; type_key: string; params: Record<string, unknown>;
  span_start: number; span_end: number; quote: string; group: string; kind: GroupKind;
}
export interface GraphCardResponse {
  build: { id: number; scope: string; rule_set_id: number; stale: boolean };
  centre: { oracle_id: string; groups: AbilityGroupRow[]; atoms: CentreAtom[] };
  cards: Record<string, GraphCardView>;
  rules: Record<string, EdgeRuleView>;
  edges: { out: EdgeView[]; in: EdgeView[]; classes: EdgeView[]; anti: EdgeView[] };
}
export interface ClassMembers {
  class: { id: string; intrinsic: string; value: string | number }; total: number; offset: number; limit: number;
  members: Array<{ oracle_id: string; name: string; type_line: string }>;
}
export type UnresolvedCause = 'unknown_amount' | 'unknown_limit' | 'unparsed_cost' | 'plausible_edge' | 'no_value_increase';
export interface CycleView {
  tier: 1 | 2 | 3; unresolved: UnresolvedCause[]; has_plausible: boolean; per_turn_limit: boolean; score: number;
  groups: Array<{ key: string; oracle_id: string; name: string; kind: GroupKind; per_turn_limit: boolean; unknown_limit: boolean; cost_unparsed: boolean }>;
  steps: Array<{ from: string; to: string; merged_key: string; grade: Grade; weight: number; demand_atom_id: number;
    supply_types: string[]; demand_type: string; demand_without_params: boolean }>;
  balance: Array<{ resource: string; net: number | 'unknown'; kind: 'cost' | 'value'; value: boolean }>;
}
export interface CycleSearchView { exact: boolean; expansions: number; kept_k: boolean; cycles: CycleView[] }
export interface CyclesResponse {
  build: { id: number }; card: string; confirmed: boolean; limits: { maxLength: number; topK: number; budget: number };
  engine: CycleSearchView; full: CycleSearchView; more_engine: boolean;
}
export type GapKind = 'unresolved_param' | 'partial_param' | 'trigger_without_demand' | 'trigger_word_inside' | 'no_param_type' | 'test_decision';
export interface GapRow { gap_kind: GapKind; type_key: string; param: string; count: number }
export interface BuildScore {
  synergy_recall: number | null; anti_recall: number | null; confirmed_precision: number | null; all_precision: number | null;
  bar: number; counts: Record<string, number>;
  wrong_confirmed: { items: number; only_demand_without_params: number; type_pairs: Array<{ type_pair: string; items: number }> };
}
export interface QueueLink { id: number; status: 'pending' | 'resolved' }
export interface EdgeRulesResponse {
  set: { id: number; version: number; status: string; schema_version: number } | null;
  rules: Array<EdgeRuleView & { queue: QueueLink | null;
    debate: { outcome: 'agreed' | 'no_agreement' | 'not_applied'; choice: string | null; round: number } | null;
    decision: { decision: 'adopt' | 'reject'; decided_by: 'owner' | 'debate'; debate_round: number | null; note: string } | null }>;
  roles: Array<StoredRole & { queue: QueueLink | null }>;
}

// Owner request 2026-10-18: the reports grouped by reason and the fix requests. Mirrors src/graph/fixRequests.ts.
export interface ReasonRuleView extends EdgeRuleView { rule_set_id: number; sentence: string; technical: string }
export interface ReportItem {
  id: number; build_id: number; edge_key: string; status: string; note: string; created_at: string;
  supply_oracle: string; demand_oracle: string; supply_name: string; demand_name: string;
}
export interface LinkExample {
  key: string; polarity: '+' | '-'; grade: Grade; strength: number;
  supply_oracle: string | null; supply_name: string; demand_oracle: string; demand_name: string;
  supply_quote: string; demand_quote: string;
}
export type FixStatus = 'queued' | 'sent' | 'done';
export interface FixRequest {
  id: number; session_name: string; rule_hashes: string[]; report_ids: number[]; build_id: number | null;
  edge_key: string | null; brief_path: string; status: FixStatus; note: string; created_at: string; sent_at: string | null;
  session_id: string | null; delivery_error: string | null; delivery_at: string | null;
  rule_ids: string[];
}
/** The fix-dispatch mod as the server saw it last: null before any Claude session polled. */
export interface FixDispatcher {
  seen_at: string; holder: string;
  sessions: Array<{ title: string; archived: boolean }> | null; sessions_at: string | null; error: string | null;
}
export interface ReasonGroup {
  key: string; rule_hashes: string[]; rules: ReasonRuleView[]; sentence: string;
  report_count: number; reports: ReportItem[];
  links: { build_id: number; count: number; strong: number; possible: number; card_pairs: number; examples: LinkExample[] } | null;
  fix_requests: FixRequest[];
}

/** The key of a reason: its rule hashes, sorted, comma-joined (as on the server). */
export const reasonKey = (hashes: readonly string[]) => [...new Set(hashes)].sort().join(',');

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * The server answers a refused write with 4xx and a human-readable `error` — the
 * message names which gate said no. Throwing that text (rather than the status)
 * is what lets the review UI show the refusal verbatim.
 */
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `${path} → HTTP ${res.status}`);
  return payload as T;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `${path} → HTTP ${res.status}`);
  return payload as T;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'DELETE' });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `${path} → HTTP ${res.status}`);
  return payload as T;
}

export const api = {
  searchCards: (qs: URLSearchParams) =>
    get<{ total: number; items: CardSummary[] }>(`/api/cards?${qs}`),
  card: (id: string) => get<{ card: CardSummary & { oracle_text: string | null }; faces: CardFace[] }>(`/api/cards/${id}`),
  cardImages: (query: string) => get<{ images: string[] }>(`/api/card-images?${query}`),
  packet: (id: string) => get<RulesPacket>(`/api/cards/${id}/packet`),
  atoms: (id: string) => get<AtomsResponse>(`/api/cards/${id}/atoms`),
  poolStatus: () => get<any>('/api/pool/status'),
  diffs: () => get<{ items: any[] }>('/api/pool/diffs'),
  diff: (id: number) => get<{ summary: any; entries: any[] }>(`/api/pool/diffs/${id}`),
  keywords: () => get<{ counts: Record<string, number>; items: KeywordMapping[] }>('/api/rules/keywords'),
  goldenQueue: () => get<QueueResponse>('/api/golden/queue'),
  goldenDraft: (id: string) => get<DraftDetail>(`/api/golden/drafts/${id}`),
  goldenAccept: (id: string, req: AcceptRequest) =>
    post<{ ok: true; atoms: number; unclassified: number; excluded: Array<{ summary: string }> }>(
      `/api/golden/drafts/${id}/accept`,
      req,
    ),
  goldenReject: (id: string, note: string) =>
    post<{ ok: true }>(`/api/golden/drafts/${id}/reject`, { note }),
  reviewQueue: (status: 'pending' | 'resolved' | 'all' = 'pending') =>
    get<ReviewQueueResponse>(`/api/review/queue?status=${status}`),
  edgeQueue: (status: 'pending' | 'resolved' | 'all' = 'pending') =>
    get<EdgeQueueResponse>(`/api/review/queue?domain=edge&status=${status}`),
  finding: (id: number) => get<QueueFinding>(`/api/review/findings/${id}`),
  atomTypes: () => get<{ schema_version: number; types: AtomTypeOption[] }>('/api/review/atom-types'),
  acceptFinding: (id: number) => post<{ ok: true }>(`/api/review/findings/${id}/accept`, {}),
  correctFinding: (id: number, req: CorrectionRequest) =>
    post<{ ok: true; golden_atom_id: number }>(`/api/review/findings/${id}/correct`, req),
  promoteFinding: (id: number, req: PromoteRequest) =>
    post<{ ok: true; schemaVersion: number; requeued: number }>(`/api/review/findings/${id}/promote`, req),
  acceptMissingRule: (id: number, ruleNumber: string) =>
    post<{ ok: true; kernelAdded: boolean; requeued: number; phrases: string[]; policySha: { before: string; after: string } }>(
      `/api/review/findings/${id}/accept-missing-rule`, { rule_number: ruleNumber }),
  acceptSplitter: (id: number) => post<{ ok: true }>(`/api/review/findings/${id}/accept-splitter`, {}),
  runs: () => get<RunsResponse>('/api/runs'),
  goldenPairs: (status: string) => get<{ pairs: GoldenPair[] }>(`/api/edge-golden/pairs?status=${encodeURIComponent(status)}`),
  goldenProgress: () => get<GoldenProgress>('/api/edge-golden/progress'),
  goldenVerdict: (id: number, v: GoldenVerdict) => post<{ ok: true }>(`/api/edge-golden/pairs/${id}/verdict`, v),
  roleProposals: (setId: number, typeId: string) => {
    const [family, typeKey] = [typeId.slice(0, typeId.indexOf('.')), typeId.slice(typeId.indexOf('.') + 1)];
    return get<RoleProposals>(`/api/edge-rules/${setId}/roles/${encodeURIComponent(family)}/${encodeURIComponent(typeKey)}/proposals`);
  },
  decideRole: (setId: number, d: { family: string; type_key: string; pass_index: number; note: string }) =>
    post<{ ok: true }>(`/api/edge-rules/${setId}/roles/decide`, d),
  keepRoleNone: (setId: number, d: { family: string; type_key: string; note: string }) =>
    post<{ ok: true }>(`/api/edge-rules/${setId}/roles/none`, d),
  keepVotedRole: (setId: number, d: { family: string; type_key: string; note: string }) =>
    post<{ ok: true }>(`/api/edge-rules/${setId}/roles/keep`, d),
  graphBuilds: () => get<{ builds: GraphBuild[] }>('/api/graph/builds'),
  graphLabels: () => get<{ labels: Record<string, string> }>('/api/graph/labels'),
  graphCard: (buildId: number, oracleId: string) => get<GraphCardResponse>(`/api/graph/${buildId}/card/${encodeURIComponent(oracleId)}`),
  graphClass: (buildId: number, classId: string, offset = 0, limit = 50) =>
    get<ClassMembers>(`/api/graph/${buildId}/class/${encodeURIComponent(classId)}?offset=${offset}&limit=${limit}`),
  graphCycles: (buildId: number, oracleId: string, confirmed: boolean) =>
    get<CyclesResponse>(`/api/graph/${buildId}/cycles?card=${encodeURIComponent(oracleId)}&confirmed=${confirmed ? 1 : 0}`),
  graphGaps: (buildId: number) => get<{ gaps: GapRow[] }>(`/api/graph/${buildId}/gaps`),
  graphTop: (buildId: number, limit: number) =>
    get<{ cards: Array<{ oracle_id: string; name: string; type_line?: string; image?: string | null; out_degree: number; in_degree: number; class_edges: number; anti_degree: number }> }>(
      `/api/graph/${buildId}/top?limit=${limit}`),
  graphScore: (buildId: number) => get<BuildScore>(`/api/graph/${buildId}/score`),
  reportEdge: (buildId: number, edgeKey: string, note: string) =>
    post<{ ok: true; report_id: number }>(`/api/graph/${buildId}/reports`, { edge_key: edgeKey, note }),
  edgeRules: () => get<EdgeRulesResponse>('/api/edge-rules'),
  reportGroups: (status: 'open' | 'closed' | 'all' = 'open') =>
    get<{ build_id: number | null; groups: ReasonGroup[]; dispatcher: FixDispatcher | null }>(`/api/edge-reports/groups?status=${status}`),
  reportCounts: () => get<{ counts: Record<string, number> }>('/api/edge-reports/counts'),
  makeDeck: (goal: DeckGoal & { build_chat_id?: number }) => post<{ id: number; deck: DeckView }>('/api/decks', goal),
  buildChats: () => get<{ talks: BuildTalkSummary[] }>('/api/build-chats'),
  buildChat: (id: number) => get<BuildChatView>(`/api/build-chats/${id}`),
  newBuildChat: (draft: DeckGoal) => post<BuildChatView>('/api/build-chats', { draft }),
  sendBuildChat: (id: number, text: string) => post<BuildChatView>(`/api/build-chats/${id}/messages`, { text }),
  continueBuildChat: (id: number) => post<BuildChatView>(`/api/build-chats/${id}/messages`, { continue_on_fallback: true }),
  stopBuildChat: (id: number) => del<{ stopped: boolean }>(`/api/build-chats/${id}/turn`),
  saveBuildDraft: (id: number, draft: DeckGoal, brief: string) => put<BuildChatView>(`/api/build-chats/${id}/draft`, { draft, brief }),
  buildTags: () => get<{ tags: Array<{ tag: string; label: string }> }>('/api/build-chat-tags'),
  decks: () => get<{ decks: DeckSummary[] }>('/api/decks'),
  rateStatus: () => get<{ build_id: number | null; ready: boolean }>('/api/decks/rate'),
  deck: (id: number) => get<{ id: number; created_at: string; deck: DeckView; comments: Record<string, string> }>(`/api/decks/${id}`),
  deckGames: (id: number) => get<DeckGames>(`/api/decks/${id}/games`),
  deckChat: (id: number) => get<DeckChatView>(`/api/decks/${id}/chat`),
  sendDeckChat: (id: number, text: string) => post<DeckChatView>(`/api/decks/${id}/chat`, { text }),
  continueDeckChat: (id: number) => post<DeckChatView>(`/api/decks/${id}/chat`, { continue_on_fallback: true }),
  stopDeckChat: (id: number) => del<{ stopped: boolean }>(`/api/decks/${id}/chat/turn`),
  saveDeckComment: (id: number, oracleId: string, text: string) => put<{ ok: true }>(`/api/decks/${id}/comments/${encodeURIComponent(oracleId)}`, { text }),
  deckSwap: (id: number, messageId: number, choice: 'swap' | 'refuse') => post<{ ok: true; deck: DeckView }>(`/api/decks/${id}/swap/${messageId}`, { choice }),
  deckUndo: (id: number) => post<{ ok: true; deck: DeckView }>(`/api/decks/${id}/undo`, {}),
  markWeak: (supply: string, demand: string, note: string) => post<{ ok: true }>('/api/decks/weak', { supply, demand, note }),
  // Link review design sec. 8.
  linkCheck: (id: number) => post<DeckChatView>(`/api/decks/${id}/link-check`, {}),
  removeOwnerLink: (id: number) => del<{ removed: boolean }>(`/api/owner-links/${id}`),
  linkChanges: () => get<LinkChangesPage>('/api/link-changes'),
  answerLinkChange: (id: number, answer: OwnerAnswer, note: string) => post<{ ok: true }>(`/api/link-changes/${id}/answer`, { answer, note }),
  linkApply: () => post<ApplyRequestView>('/api/link-apply', {}),
  cancelLinkApply: (id: number) => post<{ ok: true }>(`/api/link-apply/${id}/cancel`, {}),
  clearWeak: (supply: string, demand: string) =>
    del<{ removed: boolean; weak: boolean }>(`/api/decks/weak?supply=${encodeURIComponent(supply)}&demand=${encodeURIComponent(demand)}`),
  fixRequests: (status?: FixStatus) =>
    get<{ items: FixRequest[]; session_names: string[]; dispatcher: FixDispatcher | null }>(`/api/fix-requests${status ? `?status=${status}` : ''}`),
  saveFixRequest: (req: { session_name: string; rule_hashes: string[]; build_id?: number; edge_key?: string; note?: string }) =>
    post<FixRequest>('/api/fix-requests', req),
};
