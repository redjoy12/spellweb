/**
 * Schema v19 (spec sec. 24, plan 2026-10-31-schema-v17 Part C, the owner's yes of 2026-10-31).
 *
 * One overlay over the v18 vocabulary: six new demand types for event triggers that have no
 * CARES_ABOUT atom. No stored atom moves and no other type changes. A new reading of a card gives
 * the new atoms, and the subject of an event is a param, never a part of the type key.
 * - E1: CARES_ABOUT.DISCARD
 * - E2: CARES_ABOUT.LEAVES_GRAVEYARD
 * - E3: CARES_ABOUT.BECOMES_TAPPED
 * - E4: CARES_ABOUT.CARD_DRAW
 * - E5: CARES_ABOUT.COMMIT_CRIME
 * - E6: CARES_ABOUT.DEALT_DAMAGE
 */
import type { AtomTypeDef } from './schema.js';
import { obj } from './schemaV15.js';

export const V19_MARK = 'v19 (spec sec. 24):';

export const DISCARD_TAG = 'CARES_ABOUT.DISCARD';
export const LEAVES_GRAVEYARD_TAG = 'CARES_ABOUT.LEAVES_GRAVEYARD';
export const BECOMES_TAPPED_TAG = 'CARES_ABOUT.BECOMES_TAPPED';
export const CARD_DRAW_TAG = 'CARES_ABOUT.CARD_DRAW';
export const COMMIT_CRIME_TAG = 'CARES_ABOUT.COMMIT_CRIME';
export const DEALT_DAMAGE_TAG = 'CARES_ABOUT.DEALT_DAMAGE';

const DISCARDS_PLAYER = {
  enum: ['you', 'opponent', 'any'],
  description: 'The player who discards. you: "you discard". opponent: the clause names an opponent ("an opponent discards"). any: the clause names any player ("a player discards", "one or more players discard").',
};
const DRAWS_PLAYER = {
  enum: ['you', 'opponent', 'any'],
  description: 'The player who draws. you: "you draw". opponent: the clause names an opponent ("an opponent draws"). any: the clause names any player ("a player draws").',
};
const WHICH = {
  enum: ['any', 'second'],
  description: 'second: the clause names the second card of a turn ("your second card each turn"). any: every other clause.',
};
const TAPPED_SUBJECT = {
  enum: ['self', 'attached'],
  description: 'self: the object this text is on ("this creature", or its own name). attached: the object that this text is attached to ("enchanted creature", "equipped creature").',
};
const DAMAGE_SUBJECT = {
  enum: ['self', 'attached', 'creature', 'player'],
  description: 'What is dealt damage. self: the object this text is on ("this creature", or its own name). attached: the creature that this text is attached to ("enchanted creature", "equipped creature"). creature: any other clause that names a creature ("a creature", "a creature you control", "creatures your opponents control"). player: a clause that names a player ("an opponent", "one or more opponents", "enchanted player").',
};
const DAMAGE_KIND = {
  enum: ['any', 'noncombat'],
  description: 'noncombat: the clause says "noncombat damage". any: the clause says "damage".',
};
const cardTypes = (items: unknown, what: string) => ({
  type: 'array', items,
  description: `The card types that the clause names for ${what} ("a land card": land, "a creature card": creature). [] when it names none.`,
});

/** The six types of plan section 9.2. `ref` and `quote` are the CR evidence: the quote is the stored rule text. */
export interface V19Tag { item: string; type: string; label: string; ref: string; quote: string }
export const V19_TAGS: readonly V19Tag[] = [
  { item: 'E1', type: DISCARD_TAG, label: 'Cares about a player discarding a card', ref: '701.9a', quote: 'To discard a card, move it from its owner\'s hand to that player\'s graveyard.' }, // i2-ok: the rule of plan section 9.2
  { item: 'E2', type: LEAVES_GRAVEYARD_TAG, label: 'Cares about cards leaving a graveyard', ref: '603.10a', quote: 'abilities that trigger when a card leaves a graveyard' }, // i2-ok: the rule of plan section 9.2
  { item: 'E3', type: BECOMES_TAPPED_TAG, label: 'Cares about a permanent becoming tapped', ref: '701.26a', quote: 'To tap a permanent, turn it sideways from an upright position.' }, // i2-ok: the rule of plan section 9.2
  { item: 'E4', type: CARD_DRAW_TAG, label: 'Cares about a player drawing a card', ref: '121.1', quote: 'A player draws a card by putting the top card of their library into their hand.' }, // i2-ok: the rule of plan section 9.2
  { item: 'E5', type: COMMIT_CRIME_TAG, label: 'Cares about committing a crime', ref: '700.13', quote: 'Some cards refer to committing a crime.' }, // i2-ok: the rule of plan section 9.2
  { item: 'E6', type: DEALT_DAMAGE_TAG, label: 'Cares about a creature or a player being dealt damage', ref: '120.1', quote: 'Objects can deal damage to battles, creatures, planeswalkers, and players.' }, // i2-ok: the rule of plan section 9.2
];

/** Spec sec. 24.6: no pass voted the role of a new tag. The evidence is the CR text of its row in V19_TAGS. */
export function v19Role(type: string, demand_note: string) {
  const t = V19_TAGS.find((x) => x.type === type);
  if (!t) throw new Error(`${type} is not a v19 tag`);
  return { type, demand_note, evidence: [{ source: 'rule' as const, ref: t.ref, quote: t.quote }] };
}

/** Plan Task 17: the first tag. */
export const DISCARD_ROLE = v19Role(DISCARD_TAG, 'Watches the event in which a card moves from its owner\'s hand to that player\'s graveyard: a discard.');

/** Plan Task 18: the role of each tag. Each note uses the words of the CR rule of its row in V19_TAGS. */
export const V19_ROLES: Readonly<Record<string, ReturnType<typeof v19Role>>> = Object.fromEntries([
  DISCARD_ROLE,
  v19Role(LEAVES_GRAVEYARD_TAG, 'Watches the event in which a card leaves a graveyard.'),
  v19Role(BECOMES_TAPPED_TAG, 'Watches the event in which a permanent is tapped: it turns sideways from an upright position.'),
  v19Role(CARD_DRAW_TAG, 'Watches the event in which a player puts the top card of their library into their hand: a draw.'),
  v19Role(COMMIT_CRIME_TAG, 'Watches the event in which a player commits a crime.'),
  v19Role(DEALT_DAMAGE_TAG, 'Watches the event in which an object deals damage to a creature or a player.'),
].map((r) => [r.type, r]));

/** `review_promoted`: an owner yes gave the type, and neither the concept spec nor CR 701 and 702 list it. */
function v19Type(t: V19Tag, params: Record<string, unknown>): AtomTypeDef {
  const [family, type_key] = t.type.split('.') as ['CARES_ABOUT', string];
  return {
    family, type_key, label: t.label, params_schema: obj(params), provenance: 'review_promoted',
    evidence: `${V19_MARK} ${t.item}. Promoted under sec. 4.3 by the owner yes of 2026-10-31 (plan 2026-10-31-schema-v17 section 9): a real deck has no link for this event. CR ${t.ref} "${t.quote}"`,
  };
}

/** Applies the v19 overlay to a v18 vocabulary. A second run is a no-op. */
export function applyV19(types: readonly AtomTypeDef[]): AtomTypeDef[] {
  const items = (types.find((t) => `${t.family}.${t.type_key}` === 'PRODUCES.DISCARD')?.params_schema as
    { properties?: { card_types?: { items?: unknown } } } | undefined)?.properties?.card_types?.items;
  if (!items) throw new Error('v19 E1: PRODUCES.DISCARD has no card_types');
  const params: Record<string, Record<string, unknown>> = {
    [DISCARD_TAG]: { player: DISCARDS_PLAYER, card_types: cardTypes(items, 'the discarded card') },
    [LEAVES_GRAVEYARD_TAG]: { card_types: cardTypes(items, 'the card that leaves') },
    [BECOMES_TAPPED_TAG]: { subject: TAPPED_SUBJECT },
    [CARD_DRAW_TAG]: { player: DRAWS_PLAYER, which: WHICH },
    [COMMIT_CRIME_TAG]: {},
    [DEALT_DAMAGE_TAG]: { subject: DAMAGE_SUBJECT, damage_kind: DAMAGE_KIND },
  };
  // A promoted type comes back from the database: the type stays the same on a second run.
  const kept = types.filter((t) => !(`${t.family}.${t.type_key}` in params));
  return [...kept, ...V19_TAGS.map((t) => v19Type(t, params[t.type]!))];
}
