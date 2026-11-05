/** The subset of the Scryfall card object this project reads (§5.1 plus faces and images). */
export interface ScryfallFace {
  name: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  colors?: string[];
  image_uris?: Record<string, string>;
}

export interface ScryfallCard {
  object: string;
  id: string;
  oracle_id?: string;          // absent on reversible_card layout — such rows are skipped
  name: string;
  lang: string;
  layout: string;
  released_at: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  colors?: string[];
  color_identity: string[];
  keywords: string[];
  power?: string;
  toughness?: string;
  rarity: string;
  arena_id?: number;
  set: string;
  set_type?: string;
  collector_number: string;
  games: string[];
  digital: boolean;
  promo?: boolean;
  promo_types?: string[];
  image_uris?: Record<string, string>;
  card_faces?: ScryfallFace[];
  legalities: Record<string, string>;
}
