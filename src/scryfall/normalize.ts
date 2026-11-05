import { createHash } from 'node:crypto';
import type { ScryfallCard, ScryfallFace } from './types.js';

export interface CardFace {
  face_index: number;
  name: string;
  mana_cost: string | null;
  type_line: string;
  oracle_text: string;
  power: string | null;
  toughness: string | null;
  colors: string[];
  image_normal: string | null;
}

export interface CardRecord {
  oracle_id: string;
  name: string;
  layout: string;
  mana_cost: string | null;
  cmc: number;
  type_line: string;
  oracle_text: string | null;
  colors: string[];
  color_identity: string[];
  keywords: string[];
  power: string | null;
  toughness: string | null;
  rarity: string;
  arena_id: number | null;
  set_code: string;
  collector_number: string;
  image_normal: string | null;
  image_art_crop: string | null;
  faces: CardFace[];
  oracle_hash: string;
}

/**
 * Stable fingerprint of a card's rules text across all faces. Errata to any face
 * changes the hash, which is what triggers re-extraction in §5.2.
 */
export function oracleHash(faces: CardFace[]): string {
  const canonical = faces
    .map((f) => [f.face_index, f.name, f.mana_cost ?? '', f.type_line, f.oracle_text,
                 f.power ?? '', f.toughness ?? ''].join('\u001f'))
    .join('\u001e');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function faceFrom(src: ScryfallFace, i: number, card: ScryfallCard): CardFace {
  return {
    face_index: i,
    name: src.name,
    mana_cost: src.mana_cost ?? null,
    type_line: src.type_line ?? card.type_line ?? '',
    oracle_text: src.oracle_text ?? '',
    power: src.power ?? null,
    toughness: src.toughness ?? null,
    colors: src.colors ?? card.colors ?? [],
    image_normal: src.image_uris?.normal ?? null,
  };
}

export function toCardRecord(card: ScryfallCard): CardRecord {
  if (!card.oracle_id) throw new Error(`card ${card.id} has no oracle_id`);

  const faces: CardFace[] = card.card_faces?.length
    ? card.card_faces.map((f, i) => faceFrom(f, i, card))
    : [{
        face_index: 0,
        name: card.name,
        mana_cost: card.mana_cost ?? null,
        type_line: card.type_line ?? '',
        oracle_text: card.oracle_text ?? '',
        power: card.power ?? null,
        toughness: card.toughness ?? null,
        colors: card.colors ?? [],
        image_normal: card.image_uris?.normal ?? null,
      }];

  return {
    oracle_id: card.oracle_id,
    name: card.name,
    layout: card.layout,
    mana_cost: card.mana_cost ?? faces[0]!.mana_cost,
    cmc: card.cmc ?? 0, // Scryfall always sends cmc, so the 0 fallback is unreachable
    type_line: card.type_line ?? faces.map((f) => f.type_line).join(' // '),
    oracle_text: card.oracle_text ?? null,
    colors: card.colors ?? [],
    color_identity: card.color_identity ?? [],
    keywords: card.keywords ?? [],
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    rarity: card.rarity,
    arena_id: card.arena_id ?? null,
    set_code: card.set,
    collector_number: card.collector_number,
    image_normal: card.image_uris?.normal ?? faces[0]!.image_normal,
    // No face-0 fallback: CardFace doesn't capture art crops, so DFCs show no art crop in the UI — a decision, not an omission.
    image_art_crop: card.image_uris?.art_crop ?? null,
    faces,
    oracle_hash: oracleHash(faces),
  };
}
