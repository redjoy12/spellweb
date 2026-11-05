import { describe, it, expect } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { BuildIndex, demandParamLists, type IndexAtom } from '../src/graph/buildIndex.js';
import type { GroupKind } from '../src/graph/groups.js';
import type { IntrinsicClass } from '../src/graph/intrinsic.js';
import { loadGraphPolicy } from '../src/graph/policy.js';
import { createRuleSet, setRules } from '../src/graph/ruleSet.js';
import { edgeTrace, scoreIndex, topWeightPairs } from '../src/graph/score.js';
import { fixtureWithClauses, insertAtom } from './helpers/fixture.js';

// Phase 3 plan Task 5 Step 1 and spec rev. 10 sec. 12.2, on fixture rows in :memory:. The rules
// are synthetic data: the tests check the score mechanics, not whether a rule is true in Magic.
// Card o: "Draw a card." (clause 0.0). Card p: "Whenever a creature dies, draw a card." (0.0).
// Card q: "Flying" (0.0) and "Draw a card." (0.1). Card t: "Create a token." Card l: "You gain 1 life."
// All cards have the type line "Creature".

const CREATURE = { intrinsic: 'card_type', value: 'Creature' } as const;

function setup() {
  const db = fixtureWithClauses('Draw a card.', { oracleId: 'o' });
  fixtureWithClauses('Whenever a creature dies, draw a card.', { db, oracleId: 'p' });
  fixtureWithClauses('Flying\nDraw a card.', { db, oracleId: 'q' });
  fixtureWithClauses('Create a token.', { db, oracleId: 't' });
  fixtureWithClauses('You gain 1 life.', { db, oracleId: 'l' });
  const qClause = db.prepare("SELECT span_start, span_end FROM clauses WHERE oracle_id = 'q' AND clause_index = 1").get() as
    { span_start: number; span_end: number };
  const atoms = {
    draw: insertAtom(db, { oracle_id: 'o', family: 'PRODUCES', type_key: 'CARD_DRAW' }),
    tokens: insertAtom(db, { oracle_id: 't', family: 'PRODUCES', type_key: 'TOKENS' }),
    life: insertAtom(db, { oracle_id: 'l', family: 'PRODUCES', type_key: 'LIFEGAIN' }),
    death: insertAtom(db, { oracle_id: 'p', family: 'CARES_ABOUT', type_key: 'CREATURE_DEATH' }),
    qdraw: insertAtom(db, { oracle_id: 'q', family: 'PRODUCES', type_key: 'CARD_DRAW', span_start: qClause.span_start, span_end: qClause.span_end }),
  };
  db.prepare("UPDATE atoms SET params_json = '{\"controller\":\"opponent\"}' WHERE id = ?").run(atoms.death);
  const { setId } = createRuleSet(db, 'test-model');
  const rule = db.prepare(`INSERT INTO edge_rules (set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status)
                           VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, 3, 'accepted')`);
  const demand = JSON.stringify({ family: 'CARES_ABOUT', type_key: 'CREATURE_DEATH', where: [] });
  const typed = (k: string) => JSON.stringify({ family: 'PRODUCES', type_key: k, where: [] });
  const imp = (v: string) => JSON.stringify([{ demand_param: 'controller', value: v, evidence: [] }]);
  const ev = JSON.stringify([{ source: 'rule', ref: '700.1', quote: 'text of 700.1' }]);
  rule.run(setId, 'h1', 'ER-0001', '+', typed('CARD_DRAW'), demand, imp('opponent'), ev);    // confirmed
  rule.run(setId, 'h2', 'ER-0002', '+', JSON.stringify(CREATURE), demand, '[]', ev);          // plausible class edge
  rule.run(setId, 'h3', 'ER-0003', '-', typed('TOKENS'), demand, '[]', ev);                   // plausible anti edge
  rule.run(setId, 'h4', 'ER-0004', '+', typed('LIFEGAIN'), demand, imp('you'), ev);           // rejected: controller disagrees
  const rules = setRules(db, setId, 'accepted');

  const kinds = new Map<number, GroupKind>();
  const index = (classes: IntrinsicClass[] = [{ id: 'INTRINSIC.card_type(Creature)', intrinsic: 'card_type', value: 'Creature', members: ['o', 'p', 'q', 't', 'l'] }]) => {
    const rows = db.prepare(
      `SELECT a.id, a.oracle_id, a.face_index, a.family, a.type_key, a.params_json, a.span_start, a.span_end, c.cmc
         FROM atoms a JOIN cards c ON c.oracle_id = a.oracle_id WHERE a.is_current = 1 ORDER BY a.id`,
    ).all() as Array<{ id: number; oracle_id: string; face_index: number; family: string; type_key: string; params_json: string;
      span_start: number; span_end: number; cmc: number }>;
    const atomMap = new Map<number, IndexAtom>(rows.map((r) => [r.id, {
      id: r.id, oracle_id: r.oracle_id, face_index: r.face_index, family: r.family, type_key: r.type_key,
      params: JSON.parse(r.params_json) as Record<string, unknown>, span_start: r.span_start, span_end: r.span_end,
      group: `${r.oracle_id}#${r.face_index}#${r.id}`, kind: kinds.get(r.id) ?? 'other', span: [r.span_start, r.span_end], mv: r.cmc,
    }]));
    return new BuildIndex({ atoms: atomMap, rules, classes, params: demandParamLists(db, 1), policy: loadGraphPolicy() });
  };

  const ins = db.prepare(`INSERT INTO edge_golden_pairs (supply_oracle, demand_oracle, stratum, round, label, supply_clause, demand_clause,
                            supply_atom_id, demand_atom_id, cr_chain_json, votes, status, oracle_hashes, created_at)
                          VALUES (:s, :d, 'random', 1, :label, :sc, :dc, :sa, :da, '[]', 2, :status, '["h","h"]', 't')`);
  const clause = (n: number) => JSON.stringify({ face_index: 0, clause_index: n });
  const pair = (o: Record<string, unknown>) => Number(ins.run({
    s: 'o', d: 'p', label: 'synergy', sc: clause(0), dc: clause(0), sa: null, da: null, status: 'accepted', ...o,
  } as Record<string, string | number | null>).lastInsertRowid);
  return { db, rules, atoms, kinds, index, pair, clause };
}

describe('scoreIndex: the full score (spec sec. 12.2, plan D9)', () => {
  it('finds a pair by span overlap and the same polarity', () => {
    const { db, rules, atoms, index, pair } = setup();
    pair({ sa: atoms.draw, da: atoms.death });
    const s = scoreIndex(db, index(), rules);
    expect(s.synergy_recall).toBe(1);
    expect(s.misses).toEqual([]);
    expect(s.counts).toMatchObject({ synergy: 1, synergy_found: 1 });
  });

  it('does not find a pair when the edge has the other polarity', () => {
    const { db, rules, atoms, index, pair } = setup();
    pair({ label: 'synergy', s: 't', sa: atoms.tokens, da: atoms.death });   // only a '-' rule connects TOKENS
    const id = pair({ label: 'anti', s: 't', sa: atoms.tokens, da: atoms.death });
    const s = scoreIndex(db, index(), rules);
    expect(s.synergy_recall).toBe(0);
    expect(s.anti_recall).toBe(1);
    expect(s.misses.map((m) => m.pair_id)).not.toContain(id);
  });

  it('does not find a pair when the supply span does not overlap the supply clause', () => {
    const { db, rules, atoms, index, pair, clause } = setup();
    // q has an edge from clause 0.1 ("Draw a card."); the label names clause 0.0 ("Flying").
    const off = pair({ s: 'q', sc: clause(0), sa: null, da: atoms.death });
    const on = pair({ s: 'q', sc: clause(1), sa: atoms.qdraw, da: atoms.death });
    const s = scoreIndex(db, index(), rules);
    expect(s.counts).toMatchObject({ synergy: 2, synergy_found: 1 });
    expect(s.misses).toEqual([expect.objectContaining({ pair_id: off, class: 'extraction' })]);
    expect(s.misses.map((m) => m.pair_id)).not.toContain(on);
  });

  it('finds a characteristic pair through a class edge whose kind agrees and whose class has the supply card', () => {
    const { db, rules, atoms, index, pair } = setup();
    pair({ sc: '{"characteristic":"type_line"}', da: atoms.death });
    const s = scoreIndex(db, index(), rules);
    expect(s.counts).toMatchObject({ synergy: 1, synergy_found: 1, characteristic: 1 });
  });

  it('a card_type class edge does not find a mana_value pair, and the miss is a rule miss', () => {
    const { db, rules, atoms, index, pair } = setup();
    const id = pair({ sc: '{"characteristic":"mana_value"}', da: atoms.death });
    const s = scoreIndex(db, index(), rules);
    expect(s.synergy_recall).toBe(0);
    expect(s.misses).toEqual([expect.objectContaining({ pair_id: id, class: 'rule' })]);
  });

  it('a class edge does not find a characteristic pair when the supply card is not a class member', () => {
    const { db, rules, atoms, index, pair } = setup();
    pair({ sc: '{"characteristic":"type_line"}', da: atoms.death });
    const s = scoreIndex(db, index([{ id: 'INTRINSIC.card_type(Creature)', intrinsic: 'card_type', value: 'Creature', members: ['p'] }]), rules);
    expect(s.synergy_recall).toBe(0);
  });

  it('a power_toughness pair is never found and is a rule miss, never an extraction miss', () => {
    const { db, rules, atoms, index, pair } = setup();
    const id = pair({ sc: '{"characteristic":"power_toughness"}', da: atoms.death });
    expect(scoreIndex(db, index(), rules).misses).toEqual([expect.objectContaining({ pair_id: id, class: 'rule' })]);
  });

  it('classes the misses: extraction (a null atom), rule (no rule connects the types), param (the grade is rejected)', () => {
    const { db, rules, atoms, index, pair } = setup();
    const ext = pair({ s: 'q', sa: null, da: atoms.death });
    const extDemand = pair({ sc: '{"characteristic":"mana_value"}', da: null });  // no class edge; the demand atom is null
    const rule = pair({ sa: atoms.qdraw, s: 'q', da: atoms.qdraw, d: 'q' }); // CARD_DRAW -> CARD_DRAW: no rule
    const param = pair({ s: 'l', sa: atoms.life, da: atoms.death });          // LIFEGAIN rule: controller disagrees
    const s = scoreIndex(db, index(), rules);
    const cls = new Map(s.misses.map((m) => [m.pair_id, m.class]));
    expect(cls.get(ext)).toBe('extraction');
    expect(cls.get(extDemand)).toBe('extraction');
    expect(cls.get(rule)).toBe('rule');
    expect(cls.get(param)).toBe('param');
    expect(s.counts).toMatchObject({ miss_extraction: 2, miss_rule: 1, miss_param: 1 });
  });

  it('confirmed precision: a labelled pair with a confirmed card pair is correct when the label agrees with its polarity', () => {
    const { db, rules, atoms, index, pair } = setup();
    pair({ sa: atoms.draw, da: atoms.death });                    // o -> p: confirmed '+'; label synergy
    pair({ label: 'none', sc: null, dc: null, s: 'q' });          // q -> p: confirmed '+'; label none
    pair({ s: 't', sa: atoms.tokens, da: atoms.death });          // t -> p: plausible '-'; label synergy
    const s = scoreIndex(db, index(), rules);
    expect(s.confirmed_precision).toBe(0.5);
    expect(s.counts).toMatchObject({ confirmed_items: 2, confirmed_correct: 1 });
    // all precision: o -> p '+' (correct), q -> p '+' (wrong: label none), t -> p '-' (wrong: label synergy).
    expect(s.counts).toMatchObject({ all_items: 3, all_correct: 1 });
    expect(s.all_precision).toBeCloseTo(1 / 3);
  });

  it('counts only pairs with status accepted, owner_accepted or owner_corrected', () => {
    const { db, rules, atoms, index, pair } = setup();
    pair({ sa: atoms.draw, da: atoms.death, status: 'owner_accepted' });
    pair({ sa: atoms.draw, da: atoms.death, status: 'owner_corrected' });
    pair({ sa: atoms.draw, da: atoms.death, status: 'disputed' });
    pair({ sa: atoms.draw, da: atoms.death, status: 'sampled' });
    pair({ sa: atoms.draw, da: atoms.death, status: 'stale' });
    expect(scoreIndex(db, index(), rules).counts).toMatchObject({ scored: 2, synergy: 2 });
  });

  it('matches a chain atom that a requeue replaced: same card, face, family, type_key, params and span', () => {
    const { db, rules, atoms, index, pair } = setup();
    // Old atoms (is_current 0) are not in the build. The build has an equal atom for each of them.
    const oldDeath = insertAtom(db, { oracle_id: 'p', family: 'CARES_ABOUT', type_key: 'CREATURE_DEATH', is_current: 0 });
    db.prepare("UPDATE atoms SET params_json = '{\"controller\":\"opponent\"}' WHERE id = ?").run(oldDeath);
    const oldLife = insertAtom(db, { oracle_id: 'l', family: 'PRODUCES', type_key: 'LIFEGAIN', is_current: 0 });
    const demandSide = pair({ s: 'l', sa: atoms.life, da: oldDeath });
    const supplySide = pair({ s: 'l', sa: oldLife, da: atoms.death });
    const s = scoreIndex(db, index(), rules);
    const byId = new Map(s.misses.map((m) => [m.pair_id, m]));
    expect(byId.get(demandSide)).toMatchObject({ class: 'param', requeue: [{ side: 'demand', golden_atom_id: oldDeath, build_atom_id: atoms.death }] });
    expect(byId.get(demandSide)!.detail).toContain(`matched after requeue: demand atom ${oldDeath} -> ${atoms.death}`);
    expect(byId.get(supplySide)).toMatchObject({ class: 'param', requeue: [{ side: 'supply', golden_atom_id: oldLife, build_atom_id: atoms.life }] });
    expect(s.counts).toMatchObject({ miss_extraction: 0, miss_param: 2, requeue_matched: 2 });
  });

  it('keeps an extraction miss when the build has no equal atom (other params, other span or other type)', () => {
    const { db, rules, atoms, index, pair } = setup();
    const otherParams = insertAtom(db, { oracle_id: 'p', family: 'CARES_ABOUT', type_key: 'CREATURE_DEATH', is_current: 0 });
    const otherSpan = insertAtom(db, { oracle_id: 'p', family: 'CARES_ABOUT', type_key: 'CREATURE_DEATH', is_current: 0, span_start: 0, span_end: 8 });
    db.prepare("UPDATE atoms SET params_json = '{\"controller\":\"opponent\"}' WHERE id = ?").run(otherSpan);
    const otherType = insertAtom(db, { oracle_id: 'p', family: 'PRODUCES', type_key: 'CARD_DRAW', is_current: 0 });
    const ids = [otherParams, otherSpan, otherType].map((da) => pair({ s: 'l', sa: atoms.life, da }));
    const s = scoreIndex(db, index(), rules);
    for (const id of ids) {
      const m = s.misses.find((x) => x.pair_id === id)!;
      expect(m.class).toBe('extraction');
      expect(m.requeue).toBeUndefined();
    }
    expect(s.counts['requeue_matched']).toBe(0);
  });

  it('gives a null recall when no pair has the label', () => {
    const { db, rules, atoms, index, pair } = setup();
    pair({ sa: atoms.draw, da: atoms.death });
    expect(scoreIndex(db, index(), rules).anti_recall).toBeNull();
  });
});

describe('topWeightPairs (spec sec. 11.2)', () => {
  it('takes the card pairs with the highest weight, without self pairs and pairs that the golden set has', () => {
    const { db, atoms, kinds, index } = setup();
    const pdraw = insertAtom(db, { oracle_id: 'p', family: 'PRODUCES', type_key: 'CARD_DRAW' });
    kinds.set(pdraw, 'triggered');          // p -> p: the highest weight, but a self pair
    kinds.set(atoms.qdraw, 'triggered');    // q -> p: weight 1.0 x 1.0 / 1.1
    const idx = index();
    expect(topWeightPairs(idx, 1, 1, new Set())).toEqual([{ supply_oracle: 'q', demand_oracle: 'p', stratum: 'top_weight' }]);
    const two = topWeightPairs(idx, 2, 1, new Set(['p|q']));   // the golden set has the pair in either direction
    expect(two.map((p) => `${p.supply_oracle}|${p.demand_oracle}`)).toEqual(['o|p', 't|p']);   // '+' 0.45, then '-' 0.23
    expect(topWeightPairs(idx, 2, 1, new Set())).toEqual(topWeightPairs(idx, 2, 1, new Set()));
  });
});

describe('edgeTrace (spec sec. 12.2 trace bars)', () => {
  it('counts explicit edges with two atoms and rule evidence, and class edges with one atom, one class and rule evidence', () => {
    const { rules, index } = setup();
    const t = edgeTrace(index(), rules);
    expect(t.explicit.total).toBeGreaterThan(0);
    expect(t.explicit.ok).toBe(t.explicit.total);
    expect(t.class.total).toBe(1);
    expect(t.class.ok).toBe(1);
  });

  it('an edge whose rule has no evidence fails the bar', () => {
    const { db, rules, index } = setup();
    db.exec("UPDATE edge_rules SET evidence_json = '[]' WHERE rule_hash = 'h2'");
    const bare = rules.map((r) => (r.rule_hash === 'h2' ? { ...r, evidence: [] } : r));
    expect(edgeTrace(index(), bare).class).toEqual({ ok: 0, total: 1 });
  });
});
