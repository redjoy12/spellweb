import { describe, it, expect } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { applyReanchor, planReanchor } from '../src/graph/goldenReanchor.js';
import { addRun, fixtureWithClauses, insertAtom } from './helpers/fixture.js';

// Schema v15 plan Task 4: the edge golden pairs move to the atoms of the re-extraction.

const TEXT = 'Create a 1/1 token. Draw a card.';
const TOKEN = { span_start: 0, span_end: 19 };
const DRAW = { span_start: 20, span_end: 32 };

function setup(): { db: DatabaseSync; run2: number } {
  const db = fixtureWithClauses(TEXT);
  db.prepare(`INSERT INTO atom_types (schema_version, family, type_key, label, params_schema, provenance, evidence)
              VALUES (1, 'PRODUCES', 'CREATE', 'Create', '{"type":"object","properties":{}}', 'cr_701', 'test')`).run();
  return { db, run2: addRun(db, 'colors') };
}
const pair = (db: DatabaseSync, supply: number | null, demand: number | null) => Number(db.prepare(
  `INSERT INTO edge_golden_pairs (supply_oracle, demand_oracle, stratum, round, label, supply_atom_id, demand_atom_id, status, oracle_hashes, created_at)
   VALUES ('o', 'o', 'random', 1, 'synergy', ?, ?, 'accepted', '{}', 't')`,
).run(supply, demand).lastInsertRowid);

describe('planReanchor and applyReanchor', () => {
  it('moves a demoted atom to the current atom of the same type on the same span', () => {
    const { db, run2 } = setup();
    const old = insertAtom(db, { ...DRAW, is_current: 0 });
    const now = insertAtom(db, { ...DRAW, run_id: run2 });
    const id = pair(db, null, old);
    const items = planReanchor(db);
    expect(items).toMatchObject([{ pair_id: id, side: 'demand', outcome: 'moved', old_atom_id: old, new_atom_id: now, new_type: 'PRODUCES.CARD_DRAW' }]);
    expect(applyReanchor(db, items)).toBe(1);
    expect(db.prepare('SELECT demand_atom_id d FROM edge_golden_pairs WHERE id = ?').get(id)).toEqual({ d: now });
  });

  it('moves a dropped TOKENS twin to the CREATE atom (V9)', () => {
    const { db, run2 } = setup();
    const old = insertAtom(db, { ...TOKEN, type_key: 'TOKENS', is_current: 0 });
    const create = insertAtom(db, { ...TOKEN, type_key: 'CREATE', run_id: run2 });
    pair(db, old, null);
    expect(planReanchor(db)).toMatchObject([{ side: 'supply', outcome: 'twin', new_atom_id: create, new_type: 'PRODUCES.CREATE' }]);
  });

  it('keeps a current atom, and reports a lost atom with the types now on its span without writing it', () => {
    const { db, run2 } = setup();
    const kept = insertAtom(db, { ...DRAW });
    const lost = insertAtom(db, { ...TOKEN, type_key: 'LIFEGAIN', is_current: 0 });
    insertAtom(db, { ...TOKEN, type_key: 'CREATE', run_id: run2 });
    const id = pair(db, lost, kept);
    const items = planReanchor(db);
    expect(items.map((i) => [i.side, i.outcome])).toEqual([['supply', 'lost'], ['demand', 'same']]);
    expect(items[0]!.types_on_span).toEqual(['PRODUCES.CREATE']);
    expect(applyReanchor(db, items)).toBe(0);
    expect(db.prepare('SELECT supply_atom_id s, demand_atom_id d FROM edge_golden_pairs WHERE id = ?').get(id)).toEqual({ s: lost, d: kept });
  });

  it('does not move to a current atom of the same type on another clause', () => {
    const { db, run2 } = setup();
    const old = insertAtom(db, { ...DRAW, is_current: 0 });
    insertAtom(db, { ...TOKEN, run_id: run2 }); // CARD_DRAW type, but on the token clause
    pair(db, null, old);
    expect(planReanchor(db)[0]!.outcome).toBe('lost');
  });
});
