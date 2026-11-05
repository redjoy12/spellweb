/**
 * The golden atoms of schema v20 (spec sec. 25.3, plan Task 2). Each value comes from the card text and
 * the v20 param descriptions, and docs/schema-v20-results.md sec. 2 lists it. The 13 stored golden
 * Damage atoms change in place: a row names its atom by id, and the `quote` guards against a golden
 * card that was written again. Seven cards join the golden set with `complete` = 0, as in schema v19,
 * so that each value of `recipient` has a golden atom, with `targeted` true and false.
 */
import type { DatabaseSync } from 'node:sqlite';
import { validateAtomParams } from './schema.js';
import { DAMAGE } from './schemaV18.js';

export interface GoldenDetail { id: number; quote: string; recipient: string; targeted: boolean }
export interface GoldenDamage { card: string; quote: string; rules: string[]; params: { amount: number | string; recipient: string; targeted: boolean } }

export const GOLDEN_V20_SET: readonly GoldenDetail[] = [
  { id: 72, quote: 'Each creature you control deals 1 damage to that creature.', recipient: 'creature', targeted: true }, // i2-ok: a golden atom id
  { id: 109, quote: 'Whenever you discard a card, this Class deals 2 damage to each opponent.', recipient: 'opponent', targeted: false }, // i2-ok: a golden atom id
  { id: 284, quote: 'Whenever a creature you control is dealt damage, you may have The Sensational She-Hulk deal that much damage to any target.', recipient: 'any', targeted: true }, // i2-ok: a golden atom id
  { id: 571, quote: 'This creature deals damage equal to the number of noncreature, nonland cards in your graveyard to target creature an opponent controls.', recipient: 'creature', targeted: true }, // i2-ok: a golden atom id
  { id: 653, quote: 'Whenever an opponent casts a spell with mana value 3 or less, this creature deals 1 damage to that player.', recipient: 'opponent', targeted: false }, // i2-ok: a golden atom id
  { id: 662, quote: 'Target creature you control deals damage equal to its power to any other target.', recipient: 'any', targeted: true }, // i2-ok: a golden atom id
  { id: 838, quote: 'This Saga deals X damage to target opponent', recipient: 'opponent', targeted: true }, // i2-ok: a golden atom id
  { id: 1266, quote: 'Phoenix deals 2 damage to each opponent.', recipient: 'opponent', targeted: false },
  { id: 1295, quote: 'Starfall — Whenever The Lord Master of Hell attacks, it deals X damage to each opponent, where X is the number of noncreature, nonland cards in your graveyard.', recipient: 'opponent', targeted: false },
  { id: 1318, quote: 'it deals 5 damage to target tapped creature an opponent controls.', recipient: 'creature', targeted: true },
  { id: 1550, quote: 'When this Case enters, it deals 3 damage to target creature an opponent controls.', recipient: 'creature', targeted: true },
  { id: 1811, quote: 'this Room deals 4 damage to target creature an opponent controls.', recipient: 'creature', targeted: true },
  { id: 1812, quote: 'this Room deals 1 damage to each opponent.', recipient: 'opponent', targeted: false },
];

const DAMAGE_RESULT = '120.3'; // i2-ok: the rule that a new golden atom cites
const DAMAGE_TO_PLAYER = '120.3a'; // i2-ok: the rule that a new golden atom cites
const TARGETS = '115.1'; // i2-ok: the rule that a new golden atom cites

export const GOLDEN_V20_ADD: readonly GoldenDamage[] = [
  { card: 'Ravenous Giant', quote: 'At the beginning of your upkeep, this creature deals 1 damage to you.', rules: [DAMAGE_RESULT, DAMAGE_TO_PLAYER], params: { amount: 1, recipient: 'you', targeted: false } },
  { card: 'Slagstorm', quote: 'Slagstorm deals 3 damage to each player.', rules: [DAMAGE_RESULT, DAMAGE_TO_PLAYER], params: { amount: 3, recipient: 'player', targeted: false } },
  { card: 'Ozai\'s Cruelty', quote: 'Ozai\'s Cruelty deals 2 damage to target player.', rules: [DAMAGE_RESULT, TARGETS], params: { amount: 2, recipient: 'player', targeted: true } },
  { card: 'Pyroclasm', quote: 'Pyroclasm deals 2 damage to each creature.', rules: [DAMAGE_RESULT], params: { amount: 2, recipient: 'creature', targeted: false } },
  { card: 'Tectonic Hazard', quote: 'Tectonic Hazard deals 1 damage to each opponent and each creature they control.', rules: [DAMAGE_RESULT], params: { amount: 1, recipient: 'any', targeted: false } },
  { card: 'Stinging Vitriol', quote: 'Stinging Vitriol deals 2 damage to target opponent.', rules: [DAMAGE_RESULT, TARGETS], params: { amount: 2, recipient: 'opponent', targeted: true } },
  { card: 'Invasive Maneuvers', quote: 'It deals 5 damage instead if you control a Spacecraft.', rules: [DAMAGE_RESULT, TARGETS], params: { amount: 5, recipient: 'creature', targeted: true } },
];

interface Row { id: number; family: string; type_key: string; params_json: string; quote: string }

/**
 * Writes the golden values in one transaction, then checks every golden atom against v20. Any
 * failure rolls all of it back. A second run changes nothing. `dryRun` counts and writes nothing.
 */
export function applyGoldenV20(db: DatabaseSync, opts: { dryRun?: boolean } = {}): { changed: number; atoms_added: number; cards_added: number; unchanged: number; golden_cards: number; golden_atoms: number; failed_check: string[] } {
  const v20 = db.prepare('SELECT COUNT(*) n FROM atom_types WHERE schema_version = 20').get() as { n: number };
  if (v20.n === 0) throw new Error('schema v20 is not in atom_types: run `npm run generate:atom-schema -- --persist` first');
  const rowOf = db.prepare('SELECT id, family, type_key, params_json, quote FROM golden_atoms WHERE id = ?');
  const update = db.prepare('UPDATE golden_atoms SET schema_version = 20, params_json = ? WHERE id = ?');
  const cardOf = db.prepare('SELECT oracle_id, oracle_hash FROM cards WHERE name = ?');
  const facesOf = db.prepare('SELECT face_index, oracle_text FROM card_faces WHERE oracle_id = ? ORDER BY face_index');
  const isGolden = db.prepare('SELECT 1 FROM golden_cards WHERE oracle_id = ?');
  const addCard = db.prepare('INSERT INTO golden_cards (oracle_id, complete, oracle_hash, verified_at) VALUES (?, 0, ?, ?)');
  const has = db.prepare('SELECT 1 FROM golden_atoms WHERE oracle_id = ? AND face_index = ? AND family = ? AND type_key = ? AND span_start = ?');
  const addAtom = db.prepare(
    `INSERT INTO golden_atoms (oracle_id, face_index, schema_version, family, type_key, params_json, span_start, span_end, quote, rule_numbers, oracle_hash, source, verified_at)
     VALUES (?, ?, 20, ?, ?, ?, ?, ?, ?, ?, ?, 'authored', ?)`,
  );
  const [family, type_key] = DAMAGE.split('.') as [string, string];
  const now = new Date().toISOString();
  const res = { changed: 0, atoms_added: 0, cards_added: 0, unchanged: 0, golden_cards: 0, golden_atoms: 0, failed_check: [] as string[] };
  db.exec('BEGIN');
  try {
    for (const s of GOLDEN_V20_SET) {
      const r = rowOf.get(s.id) as Row | undefined;
      if (!r || r.quote !== s.quote || `${r.family}.${r.type_key}` !== DAMAGE) throw new Error(`golden atom ${s.id} is not the atom of the table: ${r ? `${r.family}.${r.type_key} "${r.quote}"` : 'no such id'}`);
      const params = { ...(JSON.parse(r.params_json) as Record<string, unknown>), recipient: s.recipient, targeted: s.targeted };
      if (JSON.stringify(params) === r.params_json) { res.unchanged++; continue; }
      update.run(JSON.stringify(params), s.id);
      res.changed++;
    }
    for (const g of GOLDEN_V20_ADD) {
      const card = cardOf.get(g.card) as { oracle_id: string; oracle_hash: string } | undefined;
      if (!card) throw new Error(`golden row: no card named ${g.card}`);
      const faces = facesOf.all(card.oracle_id) as Array<{ face_index: number; oracle_text: string }>;
      const face = faces.find((f) => f.oracle_text.includes(g.quote));
      const start = face ? face.oracle_text.indexOf(g.quote) : -1;
      if (!face || face.oracle_text.lastIndexOf(g.quote) !== start) throw new Error(`golden row: ${g.card} does not have the quote once: "${g.quote}"`);
      if (has.get(card.oracle_id, face.face_index, family, type_key, start)) { res.unchanged++; continue; }
      if (!isGolden.get(card.oracle_id)) { addCard.run(card.oracle_id, card.oracle_hash, now); res.cards_added++; }
      addAtom.run(card.oracle_id, face.face_index, family, type_key, JSON.stringify(g.params), start, start + g.quote.length, g.quote, JSON.stringify(g.rules), card.oracle_hash, now);
      res.atoms_added++;
    }
    const all = db.prepare('SELECT id, family, type_key, params_json, quote FROM golden_atoms').all() as unknown as Row[];
    res.golden_atoms = all.length;
    res.golden_cards = (db.prepare('SELECT COUNT(*) n FROM golden_cards').get() as { n: number }).n;
    for (const g of all) {
      const v = validateAtomParams(db, 20, g.family, g.type_key, JSON.parse(g.params_json));
      if (!v.ok) res.failed_check.push(`${g.id} ${g.family}.${g.type_key}: ${v.error}`);
    }
    if (res.failed_check.length) throw new Error(`golden atoms fail the v20 params check:\n${res.failed_check.join('\n')}`);
    db.exec(opts.dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return res;
}
