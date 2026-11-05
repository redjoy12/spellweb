/**
 * The golden atoms of schema v19 (spec sec. 24.3, plan Task 15). Each value comes from the card text
 * and the v19 param descriptions, and docs/schema-v19-results.md sec. 3 lists it. Four cards are
 * complete golden cards, so they need these atoms. The other 13 cards join the golden set with
 * `complete` = 0: they have only these atoms, so they count for recall and not for precision.
 */
import type { DatabaseSync } from 'node:sqlite';
import { validateAtomParams } from './schema.js';
import {
  BECOMES_TAPPED_TAG, CARD_DRAW_TAG, COMMIT_CRIME_TAG, DEALT_DAMAGE_TAG, DISCARD_TAG, LEAVES_GRAVEYARD_TAG, V19_TAGS,
} from './schemaV19.js';

export interface GoldenTrigger {
  item: string; card: string; face_index: number; quote: string; type: string;
  params: Record<string, unknown>;
}

export const GOLDEN_V19: readonly GoldenTrigger[] = [
  { item: 'E1', card: 'Cool but Rude', face_index: 0, quote: 'Whenever you discard a card, this Class deals 2 damage to each opponent.', type: DISCARD_TAG, params: { player: 'you', card_types: [] } },
  { item: 'E1', card: 'Entropic Battlecruiser', face_index: 0, quote: 'Whenever an opponent discards a card, they lose 3 life.', type: DISCARD_TAG, params: { player: 'opponent', card_types: [] } },
  { item: 'E1', card: 'Aclazotz, Deepest Betrayal // Temple of the Dead', face_index: 0, quote: 'Whenever an opponent discards a land card, create a 1/1 black Bat creature token with flying.', type: DISCARD_TAG, params: { player: 'opponent', card_types: ['land'] } },
  { item: 'E1', card: 'Tinybones, Pocket Nuisance', face_index: 0, quote: 'Whenever a player discards one or more cards, Tinybones deals 1 damage to each opponent.', type: DISCARD_TAG, params: { player: 'any', card_types: [] } },
  { item: 'E2', card: 'Fang, Fearless l\'Cie', face_index: 0, quote: 'Whenever one or more cards leave your graveyard, you draw a card and you lose 1 life.', type: LEAVES_GRAVEYARD_TAG, params: { card_types: [] } },
  { item: 'E2', card: 'Rot Farm Mortipede', face_index: 0, quote: 'Whenever one or more creature cards leave your graveyard, this creature gets +1/+0 and gains menace and lifelink until end of turn.', type: LEAVES_GRAVEYARD_TAG, params: { card_types: ['creature'] } },
  { item: 'E3', card: 'Chrome Companion', face_index: 0, quote: 'Whenever this creature becomes tapped, you gain 1 life.', type: BECOMES_TAPPED_TAG, params: { subject: 'self' } },
  { item: 'E3', card: 'Hawkeye\'s Bow', face_index: 0, quote: 'Whenever equipped creature becomes tapped, it deals 1 damage to each opponent.', type: BECOMES_TAPPED_TAG, params: { subject: 'attached' } },
  { item: 'E4', card: 'Wolfbat', face_index: 0, quote: 'Whenever you draw your second card each turn, you may pay {B}.', type: CARD_DRAW_TAG, params: { player: 'you', which: 'second' } },
  { item: 'E4', card: 'Scrawling Crawler', face_index: 0, quote: 'Whenever an opponent draws a card, that player loses 1 life.', type: CARD_DRAW_TAG, params: { player: 'opponent', which: 'any' } },
  { item: 'E5', card: 'Rattleback Apothecary', face_index: 0, quote: 'Whenever you commit a crime, target creature you control gains your choice of menace or lifelink until end of turn.', type: COMMIT_CRIME_TAG, params: {} },
  { item: 'E5', card: 'Overzealous Muscle', face_index: 0, quote: 'Whenever you commit a crime during your turn, this creature gains indestructible until end of turn.', type: COMMIT_CRIME_TAG, params: {} },
  { item: 'E6', card: 'Bruce Banner // The Incredible Hulk', face_index: 1, quote: 'Enrage — Whenever The Incredible Hulk is dealt damage, put a +1/+1 counter on him.', type: DEALT_DAMAGE_TAG, params: { subject: 'self', damage_kind: 'any' } },
  { item: 'E6', card: 'Jennifer Walters // The Sensational She-Hulk', face_index: 1, quote: 'Whenever a creature you control is dealt damage, you may have The Sensational She-Hulk deal that much damage to any target.', type: DEALT_DAMAGE_TAG, params: { subject: 'creature', damage_kind: 'any' } },
  { item: 'E6', card: 'Cracked Skull', face_index: 0, quote: 'When enchanted creature is dealt damage, destroy it.', type: DEALT_DAMAGE_TAG, params: { subject: 'attached', damage_kind: 'any' } },
  { item: 'E6', card: 'Massacre Girl, Most Wanted', face_index: 0, quote: 'Whenever an opponent is dealt noncombat damage, put a +1/+1 counter on Massacre Girl.', type: DEALT_DAMAGE_TAG, params: { subject: 'player', damage_kind: 'noncombat' } },
  { item: 'E6', card: 'Grievous Wound', face_index: 0, quote: 'Whenever enchanted player is dealt damage, they lose half their life, rounded up.', type: DEALT_DAMAGE_TAG, params: { subject: 'player', damage_kind: 'any' } },
];

/**
 * Writes the golden values in one transaction, then checks every golden atom against v19. Any
 * failure rolls all of it back. A second run changes nothing. `dryRun` counts and writes nothing.
 */
export function applyGoldenV19(db: DatabaseSync, opts: { dryRun?: boolean } = {}): { atoms_added: number; cards_added: number; unchanged: number; golden_cards: number; golden_atoms: number; failed_check: string[] } {
  const v19 = db.prepare('SELECT COUNT(*) n FROM atom_types WHERE schema_version = 19').get() as { n: number };
  if (v19.n === 0) throw new Error('schema v19 is not in atom_types: run `npm run generate:atom-schema -- --persist` first');
  const cardOf = db.prepare('SELECT oracle_id, oracle_hash FROM cards WHERE name = ?');
  const faceOf = db.prepare('SELECT oracle_text FROM card_faces WHERE oracle_id = ? AND face_index = ?');
  const isGolden = db.prepare('SELECT 1 FROM golden_cards WHERE oracle_id = ?');
  const addCard = db.prepare('INSERT INTO golden_cards (oracle_id, complete, oracle_hash, verified_at) VALUES (?, 0, ?, ?)');
  const has = db.prepare('SELECT 1 FROM golden_atoms WHERE oracle_id = ? AND face_index = ? AND family = ? AND type_key = ? AND span_start = ?');
  const addAtom = db.prepare(
    `INSERT INTO golden_atoms (oracle_id, face_index, schema_version, family, type_key, params_json, span_start, span_end, quote, rule_numbers, oracle_hash, source, verified_at)
     VALUES (?, ?, 19, ?, ?, ?, ?, ?, ?, ?, ?, 'authored', ?)`,
  );
  const now = new Date().toISOString();
  const res = { atoms_added: 0, cards_added: 0, unchanged: 0, golden_cards: 0, golden_atoms: 0, failed_check: [] as string[] };
  db.exec('BEGIN');
  try {
    for (const g of GOLDEN_V19) {
      const card = cardOf.get(g.card) as { oracle_id: string; oracle_hash: string } | undefined;
      if (!card) throw new Error(`golden row: no card named ${g.card}`);
      const text = (faceOf.get(card.oracle_id, g.face_index) as { oracle_text: string } | undefined)?.oracle_text ?? '';
      const start = text.indexOf(g.quote);
      if (start < 0 || text.lastIndexOf(g.quote) !== start) throw new Error(`golden row: ${g.card} face ${g.face_index} does not have the quote once: "${g.quote}"`);
      const [family, type_key] = g.type.split('.') as [string, string];
      if (has.get(card.oracle_id, g.face_index, family, type_key, start)) { res.unchanged++; continue; }
      if (!isGolden.get(card.oracle_id)) { addCard.run(card.oracle_id, card.oracle_hash, now); res.cards_added++; }
      const ref = V19_TAGS.find((t) => t.type === g.type)!.ref;
      addAtom.run(card.oracle_id, g.face_index, family, type_key, JSON.stringify(g.params), start, start + g.quote.length, g.quote, JSON.stringify([ref]), card.oracle_hash, now);
      res.atoms_added++;
    }
    const all = db.prepare('SELECT id, family, type_key, params_json FROM golden_atoms').all() as Array<{ id: number; family: string; type_key: string; params_json: string }>;
    res.golden_atoms = all.length;
    res.golden_cards = (db.prepare('SELECT COUNT(*) n FROM golden_cards').get() as { n: number }).n;
    for (const g of all) {
      const v = validateAtomParams(db, 19, g.family, g.type_key, JSON.parse(g.params_json));
      if (!v.ok) res.failed_check.push(`${g.id} ${g.family}.${g.type_key}: ${v.error}`);
    }
    if (res.failed_check.length) throw new Error(`golden atoms fail the v19 params check:\n${res.failed_check.join('\n')}`);
    db.exec(opts.dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return res;
}
