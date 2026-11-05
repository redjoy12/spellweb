/**
 * Schema v16 (spec sec. 21, owner decisions of 2026-10-23 on the "Your decisions" page, kind
 * `tag_merge`, docs/tag-check-round-1.md sec. 4-5).
 *
 * One overlay over the v15 vocabulary:
 * - M1: ENABLES.TUTOR is removed. CR 701.23a: every search finds a card that matches a given
 *   description, so SEARCH holds the same fact. No edge rule uses either type.
 * - M2: INTERACTION.DISCARD is removed. Both it and PRODUCES.DISCARD are the CR 701.9a action;
 *   PRODUCES.DISCARD records who discards in `actor`. Owner note: Discard also records which cards
 *   (card types, excluded card types) and how the card is chosen.
 * - M3: a keyword ability that the CR text calls an activated ability is a kind of ENABLES.ACTIVATE.
 *   It carries the ACTIVATE cost params, and a text with the keyword atom has no ACTIVATE atom
 *   (owner: "only the specific one should be mentioned"). The link finder of a v16 build lets an
 *   ACTIVATE rule side match these keyword atoms (src/graph/match.ts).
 */
import type { AtomTypeDef } from './schema.js';
import { ACTIVATE_COST_PARAMS, CONTROLLER, OBJECT, obj, type V15Enums } from './schemaV15.js';

export const V16_MARK = 'v16 (spec sec. 21):';

/** M1, M2: the removed types, each with the type that keeps its fact. */
export const V16_REMOVED: ReadonlyArray<{ type: string; into: string; item: string; source: string; params?: Readonly<Record<string, string>> }> = [
  { type: 'ENABLES.TUTOR', into: 'ENABLES.SEARCH', item: 'M1', source: 'CR 701.23a "find a card that matches the given description". Owner decision 2026-10-23: merge.' },
  // `whose` (the player who discards) is `actor` on PRODUCES.DISCARD.
  { type: 'INTERACTION.DISCARD', into: 'PRODUCES.DISCARD', item: 'M2', source: 'CR 701.9a "To discard a card, move it from its owner\'s hand to that player\'s graveyard." Owner decision 2026-10-23: merge.', params: { whose: 'actor' } },
];

/**
 * M3: the keyword types whose CR 702 text calls them an activated ability, with that rule. The
 * schema-v16 test checks each against the stored CR text.
 */
export const ACTIVATE_KINDS: ReadonlyArray<{ type: string; evidence: string }> = [
  { type: 'ENABLES.AURA_SWAP', evidence: '702.65a' },
  { type: 'ENABLES.CRAFT', evidence: '702.167a' },
  { type: 'ENABLES.CREW', evidence: '702.122a' },
  { type: 'ENABLES.CYCLING', evidence: '702.29a' },
  { type: 'ENABLES.EMBALM', evidence: '702.128a' },
  { type: 'ENABLES.ENCORE', evidence: '702.141a' },
  { type: 'ENABLES.EQUIP', evidence: '702.6a' },
  { type: 'ENABLES.ETERNALIZE', evidence: '702.129a' },
  { type: 'ENABLES.EXHAUST', evidence: '702.177a' },
  { type: 'ENABLES.FORECAST', evidence: '702.57a' },
  { type: 'ENABLES.FORTIFY', evidence: '702.67a' },
  { type: 'ENABLES.LEVEL_UP', evidence: '702.87a' },
  { type: 'ENABLES.OUTLAST', evidence: '702.107a' },
  { type: 'ENABLES.POWER_UP', evidence: '702.193a' },
  { type: 'ENABLES.RECONFIGURE', evidence: '702.151a' },
  { type: 'ENABLES.REINFORCE', evidence: '702.77a' },
  { type: 'ENABLES.SADDLE', evidence: '702.171a' },
  { type: 'ENABLES.SCAVENGE', evidence: '702.97a' },
  { type: 'ENABLES.STATION', evidence: '702.184a' },
  { type: 'ENABLES.TRANSFIGURE', evidence: '702.71a' },
  { type: 'ENABLES.TRANSMUTE', evidence: '702.53a' },
  { type: 'ENABLES.UNEARTH', evidence: '702.84a' },
];

export const ACTIVATE = 'ENABLES.ACTIVATE';
const KIND_SET = new Set(ACTIVATE_KINDS.map((k) => k.type));

/** M4: the types that a Cycling text does not get beside CYCLING. */
export const CYCLING_PARTS = ['PRODUCES.DISCARD', 'PRODUCES.CARD_DRAW', 'ENABLES.SEARCH', 'ENABLES.SHUFFLE', 'ENABLES.REVEAL'] as const;

/** True for a keyword kind of ACTIVATE (M3). */
export const isActivateKind = (type: string) => KIND_SET.has(type);

/** The types that an atom of `type` counts as in a v16 build: itself, and ACTIVATE for a keyword kind. */
export function typesOf(type: string): string[] {
  return KIND_SET.has(type) ? [type, ACTIVATE] : [type];
}

/**
 * At submit and in the v16 move, a `keep` atom and a `drop` atom on the same text are one fact; the
 * `drop` atom goes and the `keep` atom takes the `move` params that it does not have.
 * - M3: a keyword kind and ACTIVATE.
 * - M4 (owner decisions 2026-10-23): a Cycling text has only the CYCLING atom: no Discard, Card draw,
 *   Search, Shuffle or Reveal atom.
 */
export const V16_TWINS: ReadonlyArray<{ keep: string; drop: string; move: readonly string[]; item: 'M3' | 'M4' }> = [
  ...ACTIVATE_KINDS.map((k) => ({ keep: k.type, drop: ACTIVATE, move: Object.keys(ACTIVATE_COST_PARAMS), item: 'M3' as const })),
  ...CYCLING_PARTS.map((drop) => ({ keep: 'ENABLES.CYCLING', drop, move: [] as string[], item: 'M4' as const })),
];

/** M2: the v16 params of PRODUCES.DISCARD. */
const discardParams = (e: V15Enums) => obj({
  object: OBJECT,
  card_types: {
    type: 'array', items: { enum: e.cardTypes },
    description: 'The card types that the clause names for the discarded card ("discard an artifact or creature card": artifact, creature). [] when it names none.',
  },
  excluded_card_types: {
    type: 'array', items: { enum: e.cardTypes },
    description: 'The card types that the clause leaves out ("a nonland card": land). [] when it leaves out none.',
  },
  actor: { ...CONTROLLER, description: 'The player who discards. The card goes to that player\'s graveyard.' },
  card_choice: {
    enum: ['specific', 'any', 'random'],
    description: 'specific: the text decides which card is discarded ("discard this card", or a player chooses the card from a hand that was revealed). ' +
      'any: the player who discards chooses any card that matches. random: the text says "at random".',
  },
});

/** Applies the v16 overlay to a v15 vocabulary. A second run is a no-op. */
export function applyV16(types: readonly AtomTypeDef[], e: V15Enums, opts: { requireAll?: boolean } = {}): AtomTypeDef[] {
  const removed = new Set(V16_REMOVED.map((r) => r.type));
  const note = (t: AtomTypeDef, text: string) => (t.evidence.includes(V16_MARK) ? t.evidence : `${t.evidence} | ${V16_MARK} ${text}`);
  const seen = new Set<string>();
  const out = types.filter((t) => !removed.has(`${t.family}.${t.type_key}`)).map((t) => {
    const id = `${t.family}.${t.type_key}`;
    if (id === 'PRODUCES.DISCARD') {
      seen.add(id);
      return { ...t, params_schema: discardParams(e), evidence: note(t, 'M2. Merged with INTERACTION.DISCARD; card types, excluded card types and card choice added (owner decision 2026-10-23).') };
    }
    const kind = ACTIVATE_KINDS.find((k) => k.type === id);
    if (kind) {
      seen.add(id);
      return { ...t, params_schema: obj(ACTIVATE_COST_PARAMS), evidence: note(t, `M3. CR ${kind.evidence}: an activated ability, so a kind of ${ACTIVATE}. It carries the ACTIVATE cost params; a text with this atom has no ACTIVATE atom (owner decision 2026-10-23).`) };
    }
    if (id === ACTIVATE) {
      seen.add(id);
      return { ...t, evidence: note(t, 'M3. A keyword activated ability takes its own type (ACTIVATE_KINDS), not ACTIVATE.') };
    }
    return t;
  });
  if (opts.requireAll) {
    const missing = ['PRODUCES.DISCARD', ACTIVATE, ...ACTIVATE_KINDS.map((k) => k.type)].filter((k) => !seen.has(k));
    if (missing.length) throw new Error(`v16 items name types that are not in the vocabulary: ${missing.join(', ')}`);
  }
  return out;
}
