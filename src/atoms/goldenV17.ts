/**
 * The golden atoms of schema v17 (spec sec. 22.3, plan Task 3). Each value comes from the card text
 * and the v17 param descriptions, and docs/schema-v17-results.md sec. 2 lists it. A golden card has
 * one answer, so these atoms change in place. A row names its atom by id, and the `quote` guards
 * against a golden card that was written again.
 */
import type { DatabaseSync } from 'node:sqlite';
import { validateAtomParams } from './schema.js';

export interface GoldenSet {
  id: number; item: string; quote: string;
  from: string;
  /** The type after the change, when the atom moves. */
  to?: string;
  /** Merged over the stored params. */
  params: Record<string, unknown>;
}
export interface GoldenAdd {
  item: string;
  /** The golden atom that gives the card, the span, the quote and the rule numbers. */
  like: number; quote: string;
  type: string;
  params: Record<string, unknown>;
}

const SACRIFICE = 'PRODUCES.SACRIFICE';
const OUTLET = 'ENABLES.SACRIFICE_OUTLET';
const DIES = 'CARES_ABOUT.PERMANENT_DIES';

export const GOLDEN_V17_SET: readonly GoldenSet[] = [
  { id: 664, item: 'S1, S2', from: SACRIFICE, quote: 'Then sacrifice it.', params: { cost_type: 'free', decision: 'forced' } }, // i2-ok: a golden atom id
  { id: 1554, item: 'S1, S2', from: SACRIFICE, quote: 'Solved — Sacrifice this Case: Exile the top three cards of your library.', params: { cost_type: 'free', decision: 'cost' } },
  { id: 1478, item: 'S1, S2', from: SACRIFICE, quote: 'Solved — {2}{U}, Sacrifice this Case: Put four +1/+1 counters on target noncreature artifact.', params: { cost_type: 'costed', decision: 'cost' } },
  { id: 1538, item: 'S1, S2', from: SACRIFICE, quote: 'Solved — {1}{B}, Sacrifice this Case: Search your library for a card, put it into your hand, then shuffle.', params: { cost_type: 'costed', decision: 'cost' } },
  { id: 1395, item: 'S1, S2', from: SACRIFICE, quote: 'Solved — Sacrifice this Case: Creature cards in your graveyard gain "You may cast this card from your graveyard" until end of turn.', params: { cost_type: 'free', decision: 'cost' } },
  { id: 1417, item: 'S1, S2', from: SACRIFICE, quote: 'At the beginning of the end step, sacrifice this token.', params: { cost_type: 'free', decision: 'forced' } },
  { id: 1694, item: 'S1, S2', from: SACRIFICE, quote: 'Kicker—Sacrifice an artifact or creature.', params: { cost_type: 'free', decision: 'cost' } },
  { id: 1684, item: 'S1, S2', from: SACRIFICE, quote: 'Each opponent sacrifices a creature of their choice', params: { cost_type: 'free', decision: 'forced' } },
  { id: 1509, item: 'S1, S2', from: SACRIFICE, quote: 'Sacrifice it at the beginning of your next end step.', params: { cost_type: 'free', decision: 'forced' } },
  // S3: `cost_type` stays as the outlet atom has it.
  { id: 1010, item: 'S3', from: OUTLET, to: SACRIFICE, quote: 'you may sacrifice another creature', params: { object: 'other', object_type: 'creature', actor: 'you', decision: 'choice' } },
  { id: 1021, item: 'S3', from: OUTLET, to: SACRIFICE, quote: 'you may sacrifice any number of other creatures', params: { object: 'other', object_type: 'creature', actor: 'you', decision: 'choice' } },
  { id: 1386, item: 'S3', from: OUTLET, to: SACRIFICE, quote: 'Sacrifice a Treasure', params: { object: 'any', object_type: 'artifact', actor: 'you', decision: 'cost' } },
  // R1: each of these clauses says "dies" or "died".
  { id: 661, item: 'R1', from: DIES, quote: 'This creature enters with a +1/+1 counter on it for each creature that died under your control this turn.', params: { cause: 'any' } }, // i2-ok: a golden atom id
  { id: 1012, item: 'R1', from: DIES, quote: 'Whenever another creature dies, target opponent loses 1 life and you gain 1 life.', params: { cause: 'any' } },
  { id: 1017, item: 'R1', from: DIES, quote: 'Whenever a creature dies', params: { cause: 'any' } },
  { id: 1355, item: 'R1', from: DIES, quote: 'When Ragnarok dies, destroy target permanent and return target nonlegendary permanent card from your graveyard to the battlefield.', params: { cause: 'any' } },
  // The v16 keyword kinds (M3): these three atoms still had no cost params.
  { id: 1426, item: 'M3', from: 'ENABLES.EXHAUST', quote: 'Exhaust', params: { cost_mana: 'yes', cost_tap: 'no' } },
  { id: 1658, item: 'M3', from: 'ENABLES.EQUIP', quote: 'Equip {2}', params: { cost_mana: 'yes', cost_tap: 'no' } },
  { id: 1727, item: 'M3', from: 'ENABLES.EQUIP', quote: 'Equip {5}', params: { cost_mana: 'yes', cost_tap: 'no' } },
];

/** R3: the two golden Food token texts. Each has one PRODUCES.CREATE atom. */
export const GOLDEN_V17_ADD: readonly GoldenAdd[] = [
  { item: 'R3', like: 1709, quote: 'Whenever this creature attacks alone, create a Food token.', type: 'PRODUCES.SACRIFICE_FODDER', params: { token_type: 'Food' } },
  { item: 'R3', like: 1832, quote: 'When this Class enters, each player creates a Food token.', type: 'PRODUCES.SACRIFICE_FODDER', params: { token_type: 'Food' } },
];

interface Row {
  id: number; oracle_id: string; face_index: number; family: string; type_key: string; params_json: string;
  span_start: number; span_end: number; quote: string; rule_numbers: string; oracle_hash: string; source: string; verified_at: string | null;
}

/**
 * Writes the golden values in one transaction, then checks every golden atom against v17. Any
 * failure rolls all of it back. A second run changes nothing. `dryRun` counts and writes nothing.
 */
export function applyGoldenV17(db: DatabaseSync, opts: { dryRun?: boolean } = {}): { changed: number; added: number; unchanged: number; golden_atoms: number; failed_check: string[] } {
  const v17 = db.prepare('SELECT COUNT(*) n FROM atom_types WHERE schema_version = 17').get() as { n: number };
  if (v17.n === 0) throw new Error('schema v17 is not in atom_types: run `npm run generate:atom-schema -- --persist` first');
  const rowOf = db.prepare('SELECT * FROM golden_atoms WHERE id = ?');
  const update = db.prepare('UPDATE golden_atoms SET schema_version = 17, family = ?, type_key = ?, params_json = ? WHERE id = ?');
  const has = db.prepare('SELECT 1 FROM golden_atoms WHERE oracle_id = ? AND face_index = ? AND family = ? AND type_key = ? AND span_start = ?');
  const insert = db.prepare(
    `INSERT INTO golden_atoms (oracle_id, face_index, schema_version, family, type_key, params_json, span_start, span_end, quote, rule_numbers, oracle_hash, source, verified_at)
     VALUES (?, ?, 17, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const res = { changed: 0, added: 0, unchanged: 0, golden_atoms: 0, failed_check: [] as string[] };
  db.exec('BEGIN');
  try {
    for (const s of GOLDEN_V17_SET) {
      const r = rowOf.get(s.id) as Row | undefined;
      const type = r && `${r.family}.${r.type_key}`;
      if (!r || r.quote !== s.quote || (type !== s.from && type !== s.to)) throw new Error(`golden atom ${s.id} is not the atom of the table: ${r ? `${type} "${r.quote}"` : 'no such id'}`);
      const params = { ...(JSON.parse(r.params_json) as Record<string, unknown>), ...s.params };
      const [family, type_key] = (s.to ?? s.from).split('.') as [string, string];
      if (JSON.stringify(params) === r.params_json && type === (s.to ?? s.from)) { res.unchanged++; continue; }
      update.run(family, type_key, JSON.stringify(params), s.id);
      res.changed++;
    }
    for (const a of GOLDEN_V17_ADD) {
      const r = rowOf.get(a.like) as Row | undefined;
      if (!r || r.quote !== a.quote) throw new Error(`golden atom ${a.like} is not the atom of the table: ${r ? `"${r.quote}"` : 'no such id'}`);
      const [family, type_key] = a.type.split('.') as [string, string];
      if (has.get(r.oracle_id, r.face_index, family, type_key, r.span_start)) { res.unchanged++; continue; }
      insert.run(r.oracle_id, r.face_index, family, type_key, JSON.stringify(a.params), r.span_start, r.span_end, r.quote, r.rule_numbers, r.oracle_hash, r.source, r.verified_at);
      res.added++;
    }
    const all = db.prepare('SELECT id, family, type_key, params_json FROM golden_atoms').all() as unknown as Row[];
    res.golden_atoms = all.length;
    for (const g of all) {
      const v = validateAtomParams(db, 17, g.family, g.type_key, JSON.parse(g.params_json));
      if (!v.ok) res.failed_check.push(`${g.id} ${g.family}.${g.type_key}: ${v.error}`);
    }
    if (res.failed_check.length) throw new Error(`golden atoms fail the v17 params check:\n${res.failed_check.join('\n')}`);
    db.exec(opts.dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return res;
}
