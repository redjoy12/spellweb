/**
 * Schema v15 (spec sec. 20, plan docs/superpowers/plans/2026-10-18-schema-v15.md, owner decision C5).
 *
 * One overlay over the generated vocabulary. Each entry replaces the params_schema of one type and
 * names the source of every new param: a CR quote, or a `project_decision` with its reason (I1).
 * The overlay is applied to every input of mergePromoted (generated, database, committed config),
 * so a promoted type and its generated twin always carry the same v15 params, and a second run
 * of the generator is a no-op.
 *
 * `description` inside a property is for the extractor: renderAtomTypes prints the properties
 * as JSON, and validateAtomParams ignores keys it does not know.
 */
import type { AtomTypeDef } from './schema.js';

export interface V15Enums {
  /** CR 110.4a permanent types plus `any` (generate-atom-schema permanentTypeEnum). */
  permanentTypes: string[];
  /** CR 205.2a card types (generate-atom-schema cardTypeEnum). */
  cardTypes: string[];
  /** CR 400.1 zones (zoneEnum). */
  zones: string[];
}

export const V15_MARK = 'v15 (spec sec. 20):';

interface V15Item {
  item: string;
  params: (e: V15Enums) => Record<string, unknown>;
  source: string;
}

export const CONTROLLER = { enum: ['you', 'opponent', 'any'] } as const;

/** Splits "library, hand, battlefield, graveyard, stack, exile, and command" into zone words. */
export function zonesFrom400_1(text: string): string[] {
  const m = /zones:\s*([^.]+)\./.exec(text);
  if (!m) throw new Error('the CR zone rule no longer lists "zones: ..." - fix zonesFrom400_1');
  const zones = m[1]!.split(/,\s*|\s+and\s+/).map((w) => w.replace(/^and\s+/, '').trim().toLowerCase()).filter(Boolean);
  if (zones.length < 7) throw new Error(`the CR zone rule parsed to ${zones.length} zones - fix zonesFrom400_1`);
  return zones;
}

export const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: 'object', properties, required, additionalProperties: false });

const SUBJECT = {
  enum: ['self', 'other', 'any'],
  description:
    'self: the clause is only about the object this text is on ("this ...", or its own name). ' +
    'other: the clause leaves out that object ("another", "other"). ' +
    'any: the clause can match that object and other objects ("a ...", "each ...", "whenever one or more ...").',
};
const SUBTYPE_FILTER = {
  type: 'string',
  description: 'The subtype word that the clause names for the object (CR 205.3), as written. "" when the clause names no subtype.',
};
export const OBJECT = {
  enum: ['self', 'other', 'any'],
  description:
    'The object that the action is done to. self: the object this text is on ("this ...", or its own name). ' +
    'other: the clause leaves out that object ("another"). any: any object that matches the clause.',
};
const OBJECT_CONTROLLER = {
  ...CONTROLLER,
  description:
    'The player whose object the clause names: "you control" or "your": you; "an opponent controls" or "opponent\'s": opponent; ' +
    'the clause names no controller: any.',
};
const TARGETED = {
  type: 'boolean',
  description: 'true when the clause uses the word "target" for the object (CR 115.1). false when it does not ("each", "all", or a choice made when the effect resolves, CR 115.10).',
};
const COST_PART = {
  enum: ['yes', 'no', 'not_stated'],
};

/** The V1 cost params of ENABLES.ACTIVATE. From v16 the keyword kinds of ACTIVATE carry them too. */
export const ACTIVATE_COST_PARAMS = {
  cost_mana: { ...COST_PART, description: 'yes when the activation cost (the text before the colon, CR 602.1a) of the quoted ability contains a mana symbol (CR 107.4); no when it does not; not_stated when the clause states no cost.' },
  cost_tap: { ...COST_PART, description: 'yes when that activation cost contains the tap symbol {T} (CR 107.5); no when it does not; not_stated when the clause states no cost.' },
};

const pt = (e: V15Enums) => e.permanentTypes;
const cardOrAny = (e: V15Enums) => [...e.cardTypes, 'any'];
const permOnly = (e: V15Enums) => e.permanentTypes.filter((t) => t !== 'any');

const ITEMS: Record<string, V15Item> = {
  // ---- V1 ----
  'ENABLES.ACTIVATE': {
    item: 'V1',
    params: () => obj(ACTIVATE_COST_PARAMS),
    source: 'CR 602.1a "The activation cost is everything before the colon (:)."; CR 107.4 (the mana symbols); CR 107.5 "The tap symbol in an activation cost means \'Tap this permanent.\'" Replaces the mana cost gate (spec sec. 7.6) and lets a tap-cost rule (fix request 6 sec. 8) link only to tap costs.',
  },
  // ---- V2 ----
  'ENABLES.DOUBLE': {
    item: 'V2',
    params: () => obj({
      object: { enum: ['power', 'toughness', 'power_toughness', 'life', 'counters', 'mana', 'damage'], description: 'The thing that the clause doubles.' },
    }),
    source: 'CR 701.10b (power, toughness, "power and toughness"), 701.10d (life total), 701.10e (counters), 701.10f (mana), 701.10g (damage). Replaces the "Double" object gate (spec sec. 7.8).',
  },
  'ENABLES.TRIPLE': {
    item: 'V2',
    params: () => obj({
      object: { enum: ['power', 'toughness', 'power_toughness'], description: 'The thing that the clause triples.' },
    }),
    source: 'CR 701.11b: "To triple a creature\'s power ... toughness ... Tripling a creature\'s power and toughness". 701.11 names no other object.',
  },
  // ---- V3 ----
  'COMBAT.ANTHEM': {
    item: 'V3',
    params: (e) => obj({
      subject_type: { enum: pt(e) },
      subject_filter: { type: 'string', description: 'The subtype or other words that limit the set, as written. "" when there are none.' },
      controller: CONTROLLER,
      duration: { enum: ['static', 'end_of_turn', 'other'] },
      sign: { enum: ['+', '-', 'mixed'], description: 'The sign of the change: + when every number is 0 or more, - when every number is 0 or less, mixed otherwise.' },
    }),
    source: 'sign: the same param as COMBAT.STAT_CHANGE (review-promoted, v14; CR 613.4c). The v2 params become required, because the v15 golden set and the full re-extraction set them on every atom.',
  },
  // ---- V4 and V8: CARES_ABOUT subject, subtype, origin zone ----
  'CARES_ABOUT.PERMANENT_DIES': {
    item: 'V4, V8',
    params: (e) => obj({ permanent_type: { enum: pt(e) }, controller: CONTROLLER, subject: SUBJECT, subtype_filter: SUBTYPE_FILTER }),
    source: 'subject: CR 603.6a writes triggers as "When [this object] ..." or "Whenever a [type] ..."; CR 201.5: a reference to the object by name means just that object. The value `other` ("another") is a project_decision: the card text word is read as written (review L3). subtype_filter: CR 205.3a. CR 700.4 fixes the origin (the battlefield), so the type has no zone param.',
  },
  'CARES_ABOUT.PERMANENT_COUNT': {
    item: 'V4, V8',
    params: (e) => obj({ permanent_type: { enum: pt(e) }, controller: CONTROLLER, subject: SUBJECT, subtype_filter: SUBTYPE_FILTER }),
    source: 'subject: as PERMANENT_DIES ("for each other ..." is `other`, project_decision). subtype_filter: CR 205.3a.',
  },
  'CARES_ABOUT.ENTERS_BATTLEFIELD': {
    item: 'V4, V8',
    params: (e) => obj({
      controller: CONTROLLER,
      permanent_type: { enum: pt(e) },
      subject: SUBJECT,
      subtype_filter: SUBTYPE_FILTER,
      origin_zone: {
        enum: [...e.zones.filter((z) => z !== 'battlefield'), 'any'],
        description: 'The zone that the clause says the permanent comes from ("from your graveyard": graveyard). any when the clause names no zone.',
      },
    }),
    source: 'subject: CR 603.6a "When [this object] enters, . . . " or "Whenever a [type] enters, . . ."; `other` is a project_decision (review L3). origin_zone: the zones of CR 400.1 without the battlefield. permanent_type becomes required: the v2 note said to flip it when the back-catalogue carries it, and v15 re-extracts the whole slice.',
  },
  'CARES_ABOUT.LEAVES_BATTLEFIELD': {
    item: 'V4, V8',
    params: (e) => obj({ permanent_type: { enum: pt(e) }, controller: CONTROLLER, subject: SUBJECT, subtype_filter: SUBTYPE_FILTER }),
    source: 'subject: CR 603.6c "When [this object] leaves the battlefield, . . ." or "Whenever [something] is put into a graveyard from the battlefield"; `other` is a project_decision. subtype_filter: CR 205.3a.',
  },
  'CARES_ABOUT.ATTACKS': {
    item: 'V4',
    params: () => obj({ controller: CONTROLLER, subject: SUBJECT }),
    source: 'subject: CR 603.6a form "[this object]" against "a [type]"; `other` is a project_decision.',
  },
  'CARES_ABOUT.SPELL_CAST': {
    item: 'V4',
    params: (e) => obj({
      controller: CONTROLLER,
      card_types: { type: 'array', items: { enum: e.cardTypes } },
      excluded_card_types: { type: 'array', items: { enum: e.cardTypes } },
      subject: { ...SUBJECT, description: 'self: "when you cast this spell". other: the clause leaves out this card ("another spell"). any: any spell that matches.' },
    }),
    source: 'subject: CR 201.5 (a reference to the object itself); `other` is a project_decision.',
  },
  'CARES_ABOUT.COMBAT_DAMAGE_TO_PLAYER': {
    item: 'V4',
    params: () => obj({ controller: CONTROLLER, subject: SUBJECT }),
    source: 'subject: CR 201.5 and the CR 603.6a form "[this object]"; `other` is a project_decision.',
  },
  // ---- V6 ----
  'CARES_ABOUT.POPULATED_GRAVEYARD': {
    item: 'V6',
    params: () => obj({ whose: { ...CONTROLLER, description: 'The player whose graveyard the clause counts or needs ("your graveyard": you). any for "a graveyard" or "all graveyards".' } }),
    source: 'CR 400.1 "Each player has their own library, hand, and graveyard."; CR 404.1. Same enum as INTERACTION.DISCARD.whose.',
  },
  // ---- V5 ----
  'PRODUCES.SACRIFICE': {
    item: 'V5',
    params: (e) => obj({
      object: OBJECT,
      object_type: { enum: pt(e) },
      actor: { ...CONTROLLER, description: 'The player who sacrifices ("each opponent sacrifices": opponent; "sacrifice ...": you; "each player": any).' },
    }),
    source: 'CR 701.21a "To sacrifice a permanent, its controller moves it ... A player can\'t sacrifice something that\'s a permanent they don\'t control." Thus the actor is also the controller of the object, and the type has no object_controller param.',
  },
  'PRODUCES.DESTROY': {
    item: 'V5',
    params: (e) => obj({ object: OBJECT, object_type: { enum: pt(e) }, object_controller: OBJECT_CONTROLLER, targeted: TARGETED }),
    source: 'CR 701.8a "To destroy a permanent, move it from the battlefield to its owner\'s graveyard." targeted: CR 115.1 and 115.10; the owner link test of spec sec. 5.9 (a chosen target is for the opponent; an effect on all objects of a kind is not).',
  },
  'PRODUCES.EXILE': {
    item: 'V5',
    params: (e) => obj({
      object: OBJECT,
      object_type: { enum: cardOrAny(e) },
      object_controller: OBJECT_CONTROLLER,
      targeted: TARGETED,
      from_zone: { enum: [...e.zones, 'any'], description: 'The zone that the object is exiled from, as the clause states it. any when the clause states no zone.' },
    }),
    source: 'CR 701.13a "To exile an object, move it to the exile zone from wherever it is." (thus the zone param); card types: CR 205.2a; targeted: CR 115.1 and 115.10.',
  },
  'PRODUCES.DISCARD': {
    item: 'V5',
    params: (e) => obj({
      object: OBJECT,
      object_type: { enum: cardOrAny(e) },
      actor: { ...CONTROLLER, description: 'The player who discards. The card goes to that player\'s graveyard.' },
    }),
    source: 'CR 701.9a "To discard a card, move it from its owner\'s hand to that player\'s graveyard."',
  },
  'INTERACTION.TARGETED_REMOVAL': {
    item: 'V5',
    params: (e) => obj({ object_type: { enum: pt(e) }, object_controller: OBJECT_CONTROLLER }),
    source: 'Review L5: removal of an opponent object does not supply "your creature dies". The type is targeted by its label (CR 115.1).',
  },
  // ---- V7 ----
  'PRODUCES.CREATE': {
    item: 'V7, V9',
    params: (e) => obj({
      amount: { type: ['integer', 'string'] },
      token_types: { type: 'array', items: { enum: permOnly(e) }, description: 'The card types of the token, as the clause states them (CR 111.3). [] when the clause states none.' },
      subtypes: { type: 'array', items: { type: 'string' }, description: 'The subtypes of the token, as written (CR 111.4).' },
      controller: { ...CONTROLLER, description: 'The player who creates the token and gets it (CR 111.2).' },
    }),
    source: 'CR 111.2 "The player who creates a token is its owner. The token enters the battlefield under that player\'s control."; CR 111.3 (the creating effect defines the characteristics); CR 111.4 (it sets the subtypes). amount: V9 keeps the keyword type and drops its generic twin (TOKENS), so the keyword type carries the amount.',
  },
  'PRODUCES.TOKENS': {
    item: 'V7',
    params: (e) => obj({
      amount: { type: ['integer', 'string'] },
      token_types: { type: 'array', items: { enum: permOnly(e) }, description: 'The card types of the token, as the clause states them (CR 111.3). [] when the clause states none.' },
      subtypes: { type: 'array', items: { type: 'string' }, description: 'The subtypes of the token, as written (CR 111.4).' },
      controller: { ...CONTROLLER, description: 'The player who gets the token (CR 111.2).' },
    }),
    source: 'As PRODUCES.CREATE.',
  },
  // ---- V9 supply twins, with V6 whose ----
  'PRODUCES.MILL': {
    item: 'V9, V6',
    params: () => obj({
      amount: { type: ['integer', 'string'] },
      whose: { ...CONTROLLER, description: 'The player who mills. The cards go to that player\'s graveyard.' },
    }),
    source: 'CR 701.17a "that player puts that many cards from the top of their library into their graveyard." amount: V9 keeps the keyword type and drops its generic twin (CARDS_TO_GRAVEYARD).',
  },
  'PRODUCES.CARDS_TO_GRAVEYARD': {
    item: 'V6',
    params: () => obj({
      amount: { type: ['integer', 'string'] },
      whose: { ...CONTROLLER, description: 'The player whose graveyard gets the cards.' },
    }),
    source: 'CR 400.1 (each player has their own graveyard); CR 404.1. Needed so that a supply can meet CARES_ABOUT.POPULATED_GRAVEYARD.whose (V6).',
  },
  // ---- V10 ----
  'ENABLES.RECURSION': {
    item: 'V10',
    params: () => obj({ whose: { ...CONTROLLER, description: 'The player whose graveyard the card comes from ("your graveyard": you).' } }),
    source: 'CR 400.1 "Each player has their own library, hand, and graveyard." Review L5 (ER-2151).',
  },
  'INTERACTION.GRAVEYARD_HATE': {
    item: 'V10',
    params: () => obj({ whose: { ...CONTROLLER, description: 'The player whose graveyard the clause acts on. any for "a graveyard" or "all graveyards".' } }),
    source: 'CR 400.1. Review L5 (ER-2376).',
  },
  'ENABLES.COST_REDUCTION': {
    item: 'V10',
    params: () => obj({ object: { enum: ['spell', 'ability'], description: 'spell: the clause reduces the cost of spells. ability: it reduces an activation cost.' } }),
    source: 'CR 601.2f (cost reductions of a spell); CR 602.2b (an activated ability\'s analog to a spell\'s mana cost is its activation cost). Same enum as PRODUCES.COPY_SPELL.object. Review L7 (ER-1954).',
  },
  'ENABLES.HASTE_GRANT': {
    item: 'V10',
    params: () => obj({
      subject: { enum: ['other', 'any'], description: 'other: the clause gives haste to another object or a target. any: to a set that can include this object ("creatures you control").' },
      controller: CONTROLLER,
    }),
    source: 'project_decision: the label says "another permanent"; a self grant is the CR 702.10 keyword HASTE. Same subject words as V4.',
  },
};

/** The v15 items, keyed by `FAMILY.TYPE_KEY`, for the spec and the tests. */
export const V15_TYPE_KEYS = Object.keys(ITEMS);

/** Applies the v15 overlay. Throws when an item names a type that the vocabulary does not have. */
export function applyV15(types: readonly AtomTypeDef[], e: V15Enums, opts: { requireAll?: boolean } = {}): AtomTypeDef[] {
  const seen = new Set<string>();
  const out = types.map((t) => {
    const id = `${t.family}.${t.type_key}`;
    const item = ITEMS[id];
    if (!item) return t;
    seen.add(id);
    const note = ` | ${V15_MARK} ${item.item}. ${item.source}`;
    return {
      ...t,
      params_schema: item.params(e),
      evidence: t.evidence.includes(V15_MARK) ? t.evidence : t.evidence + note,
    };
  });
  if (opts.requireAll) {
    const missing = V15_TYPE_KEYS.filter((k) => !seen.has(k));
    if (missing.length) throw new Error(`v15 items name types that are not in the vocabulary: ${missing.join(', ')}`);
  }
  return out;
}

/**
 * V9: a keyword-action atom and its generic twin on the same text are one fact. Keep the keyword
 * type (the precedence note of config/atom-schema.json) and drop the twin.
 */
export const V9_TWINS: ReadonlyArray<{ keep: string; drop: string }> = [
  { keep: 'PRODUCES.CREATE', drop: 'PRODUCES.TOKENS' },
  { keep: 'PRODUCES.MILL', drop: 'PRODUCES.CARDS_TO_GRAVEYARD' },
];
