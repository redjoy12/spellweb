import { describe, it, expect } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { deriverOnlyScore } from '../src/graph/deriverScore.js';
import { createRuleSet } from '../src/graph/ruleSet.js';
import { fixtureWithClauses, insertAtom } from './helpers/fixture.js';

// spec rev. 6 sec. 12.2 and plan Task 3 Step 10, on a fixture rule set and fixture golden rows.
// The fixture cards both have the type line "Creature" (tests/helpers/fixture.ts). The rules are
// synthetic data: the test checks the score mechanics, not whether a rule is true in Magic.

function setup(): { db: DatabaseSync; setId: number; pair: (o: Record<string, unknown>) => number; atoms: Record<string, number> } {
  const db = fixtureWithClauses('Draw a card.', { oracleId: 'o' });
  fixtureWithClauses('Whenever a creature dies, draw a card.', { db, oracleId: 'p' });
  const atoms = {
    draw: insertAtom(db, { oracle_id: 'o', family: 'PRODUCES', type_key: 'CARD_DRAW' }),
    tokens: insertAtom(db, { oracle_id: 'o', family: 'PRODUCES', type_key: 'TOKENS' }),
    death: insertAtom(db, { oracle_id: 'p', family: 'CARES_ABOUT', type_key: 'CREATURE_DEATH' }),
  };
  const { setId } = createRuleSet(db, 'test-model');
  const rule = db.prepare(`INSERT INTO edge_rules (set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status)
                           VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', ?, ?)`);
  const demand = JSON.stringify({ family: 'CARES_ABOUT', type_key: 'CREATURE_DEATH', where: [] });
  rule.run(setId, 'h1', 'ER-0001', '+', JSON.stringify({ family: 'PRODUCES', type_key: 'CARD_DRAW', where: [] }), demand, 2, 'accepted');
  rule.run(setId, 'h2', 'ER-0002', '+', JSON.stringify({ intrinsic: 'card_type', value: 'Creature' }), demand, 3, 'accepted');
  rule.run(setId, 'h3', 'ER-0003', '+', JSON.stringify({ family: 'PRODUCES', type_key: 'TOKENS', where: [] }), demand, 1, 'disputed');
  const ins = db.prepare(`INSERT INTO edge_golden_pairs (supply_oracle, demand_oracle, stratum, round, label, supply_clause, demand_clause,
                            supply_atom_id, demand_atom_id, cr_chain_json, votes, status, oracle_hashes, created_at)
                          VALUES (:s, :d, 'random', 1, :label, :sc, '{"face_index":0,"clause_index":0}', :sa, :da, '[]', 2, :status, '["h","h"]', 't')`);
  const pair = (o: Record<string, unknown>) => Number(ins.run({
    s: 'o', d: 'p', label: 'synergy', sc: '{"face_index":0,"clause_index":0}', sa: null, da: null, status: 'accepted', ...o,
  } as Record<string, string | number | null>).lastInsertRowid);
  return { db, setId, pair, atoms };
}

describe('deriverOnlyScore (spec sec. 12.2)', () => {
  it('finds an atom pair when an accepted rule of the same polarity connects the two types', () => {
    const { db, setId, pair, atoms } = setup();
    pair({ sa: atoms.draw, da: atoms.death });
    expect(deriverOnlyScore(db, setId)).toMatchObject({ found: 1, total: 1, recall: 1, misses: [] });
  });

  it('finds a characteristic pair through an intrinsic rule whose kind agrees and whose class has the supply card', () => {
    const { db, setId, pair, atoms } = setup();
    pair({ sc: '{"characteristic":"type_line"}', da: atoms.death });
    const s = deriverOnlyScore(db, setId);
    expect(s).toMatchObject({ found: 1, total: 1 });
    expect(s.by_kind.characteristic).toEqual({ found: 1, total: 1 });
  });

  it('misses a pair with no accepted rule, a wrong polarity or a kind that does not agree', () => {
    const { db, setId, pair, atoms } = setup();
    const noRule = pair({ sa: atoms.tokens, da: atoms.death });                       // only a disputed rule
    const anti = pair({ label: 'anti', sa: atoms.draw, da: atoms.death });            // only a '+' rule
    const kind = pair({ sc: '{"characteristic":"mana_value"}', da: atoms.death });    // card_type does not agree
    const pt = pair({ sc: '{"characteristic":"power_toughness"}', da: atoms.death }); // no kind agrees
    const s = deriverOnlyScore(db, setId);
    expect(s).toMatchObject({ found: 0, total: 4, recall: 0 });
    expect(s.misses).toEqual([
      { pair_id: noRule, supply_type: 'PRODUCES.TOKENS', demand_type: 'CARES_ABOUT.CREATURE_DEATH' },
      { pair_id: anti, supply_type: 'PRODUCES.CARD_DRAW', demand_type: 'CARES_ABOUT.CREATURE_DEATH' },
      { pair_id: kind, supply_type: 'characteristic:mana_value', demand_type: 'CARES_ABOUT.CREATURE_DEATH' },
      { pair_id: pt, supply_type: 'characteristic:power_toughness', demand_type: 'CARES_ABOUT.CREATURE_DEATH' },
    ]);
  });

  it('leaves out a pair with a null atom and a pair that is not accepted', () => {
    const { db, setId, pair, atoms } = setup();
    pair({ sa: null, da: atoms.death });
    pair({ sa: atoms.draw, da: atoms.death, status: 'disputed' });
    pair({ sa: atoms.draw, da: atoms.death, status: 'owner_corrected' });
    expect(deriverOnlyScore(db, setId)).toMatchObject({ found: 1, total: 1, excluded: 1 });
  });

  it('reports Stage B on the pairs that the Stage A roles let it reach, and lists the blocked pairs', () => {
    const { db, setId, pair, atoms } = setup();
    const role = db.prepare(`INSERT INTO edge_type_roles (set_id, family, type_key, role, demand_note, resources_json, evidence_json, votes, status)
                             VALUES (?, ?, ?, ?, NULL, '[]', '[]', 3, 'accepted')`);
    role.run(setId, 'PRODUCES', 'CARD_DRAW', 'supply');
    role.run(setId, 'PRODUCES', 'TOKENS', 'none');
    role.run(setId, 'CARES_ABOUT', 'CREATURE_DEATH', 'demand');
    pair({ sa: atoms.draw, da: atoms.death });                                  // reachable, found
    pair({ sc: '{"characteristic":"mana_value"}', da: atoms.death });           // reachable, missed
    const tokens = pair({ sa: atoms.tokens, da: atoms.death });                 // blocked: supply role none
    const pt = pair({ sc: '{"characteristic":"power_toughness"}', da: atoms.death }); // blocked: no class kind
    const s = deriverOnlyScore(db, setId);
    expect(s).toMatchObject({ found: 1, total: 4 });
    expect(s.reachable).toMatchObject({ found: 1, total: 2, recall: 0.5 });
    expect(s.reachable.blocked).toEqual([
      { pair_id: tokens, reason: 'supply PRODUCES.TOKENS has the role none' },
      { pair_id: pt, reason: 'no class kind agrees with power_toughness' },
    ]);
  });

  it('counts the none pairs whose card types a rule connects', () => {
    const { db, setId, pair } = setup();
    pair({ label: 'none', sc: null });                       // o -> p: CARD_DRAW -> CREATURE_DEATH has a rule
    pair({ label: 'none', sc: null, s: 'p', d: 'o' });       // p -> o: no rule; o has no demand atom of a class rule
    expect(deriverOnlyScore(db, setId)).toMatchObject({ none_with_rule: 1, none_total: 2, total: 0 });
  });
});
