import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/client.js';
import { buildServer } from '../src/server/app.js';

describe('server', () => {
  it('reports health with the schema present', async () => {
    const app = buildServer(openDb(':memory:'));
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    // 28 tables counted by /api/health (excludes FTS5 shadow tables and sqlite_%
    // internals): 17 post-Task-2 base (16 Phase 1 incl. cards_fts, rule_term_index,
    // packet_kernel; + atom_types) + 10 sec. 10.2 tables (Task 4: clauses,
    // extraction_runs, atoms, unclassified_clauses, missing_rule_reports,
    // extraction_results, splitter_disagreements, review_queue, golden_cards,
    // golden_atoms) + 1 schema_migrations (Task 4) = 28, + 14 Phase 3 sec. 10.2 tables
    // (edge_rule_sets ... edge_golden_pairs, migration 5) = 42, + 3 golden tables
    // (edge_golden_votes, edge_golden_batches, edge_golden_owner_sample, migration 6) = 45,
    // + edge_golden_reviews (migration 7) = 46, + edge_rule_batches, edge_role_decisions
    // (migration 8) = 48, + edge_rule_decisions, edge_debate_batches, edge_debate_answers,
    // edge_debate_outcomes (migration 9) = 52, + fix_requests (migration 11) = 53,
    // + owner_decisions (migration 13) = 54, + edge_rule_carry (migration 15) = 55,
    // + decks (migration 21) = 56, + card_rates (migration 22) = 57,
    // + deck_chats, deck_chat_messages, deck_card_comments, deck_versions (migration 23) = 61,
    // + arena_cards, game_log_files, game_scan_state, games (migration 24) = 65,
    // + build_chats, build_chat_messages (migration 25) = 67,
    // + link_apply_requests, link_suggestions, owner_links (migration 26) = 70.
    expect(res.json()).toMatchObject({ ok: true, tables: 70 });
  });
});
