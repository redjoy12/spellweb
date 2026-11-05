/**
 * The object gate (Phase 3 spec rev. 16 sec. 7.9, owner instruction 2026-10-18 after
 * docs/phase-3-link-logic-review.md). Schema v14 does not record who or what a fact is about, so
 * three kinds of + edge connect facts that can never meet on the table:
 *
 * G1 self subject: a trigger on the card itself ("When this creature enters") gets no edge from a
 *    supply that is a new object (a type whose schema evidence creates a token, not a copy) or
 *    from an intrinsic class (another card). A new token or another card is never "this" object.
 * G2 fixed object: a sacrifice or discard whose object is fixed ("Sacrifice this land", "discard
 *    it") or whose actor is an opponent ("Each opponent sacrifices a creature") gets no + edge.
 *    Every + rule into these types supplies an object or a card to the act (the rules of set 2).
 * G3 opponent object: a supply that acts on an opponent's object ("target creature an opponent
 *    controls") gets no edge into a demand on your own objects (controller `you`, or "your
 *    graveyard"). CR 109.5: "you" on an object refers to its controller.
 *
 * G4 card types: a + edge needs a common card type when both sides name one. The supply types
 *    are the types of the object that the supply makes or moves (a token, a sacrificed or
 *    destroyed permanent, an intrinsic class); the demand types are the types that the demand
 *    names (`permanent_type`, the object of an open sacrifice, the cards that a graveyard demand
 *    counts or returns). The words come from the CR card types (glossary entries "A card type.")
 *    and the CR subtype lists (the "Subtype" lookup, spec sec. 11.2), never from memory.
 *
 * G6 card of an event: a + edge into a discard trigger that names card types needs a discard that
 *    can take one of them. The facts are the `card_types` and `excluded_card_types` params.
 *
 * G7 damage to a player: damage that can hit only a player gets no + edge into "dies" or "leaves
 *    the battlefield". CR 120.6, 120.3c and 306.9 make these events from damage to a creature or a
 *    planeswalker. The fact is the `recipient` param. "Target player or planeswalker" is `player`,
 *    so a quote that says "planeswalker" stays.
 *
 * G8 discard of an opponent: a discard that only an opponent makes gets no + edge into mayhem.
 *    CR 702.187b: "As long as you discarded this card this turn". The fact is the `actor` param.
 *    ER-2401 has this test, but ER-2382 has none and subsumes it (sec. 5.8), so the exclusion list
 *    cannot do this: it would also take the discards of `you` and `any`.
 *
 * G9 own cost: "This spell costs" or "This ability costs" acts only on its own card, so a typed
 *    supply gets no + edge into it. An Equip supply stays on a text that counts Equipment. A class
 *    edge stays: the classes test the condition ("if you control a Vehicle"), not the cast.
 *    Version 7 reads two more forms: "Affinity for" (CR 702.41a: "This spell costs {1} less") and
 *    "This cost is reduced". Version 9 reads two more: "this ability's activation cost" and a
 *    quote that starts with "Power-up" (CR 702.193a: "this ability's cost is reduced").
 *
 * G10 graveyard of an opponent: a discard or an act on an opponent's object gets no + edge into
 *    embalm or forage. CR 701.9a puts a discarded card in its owner's graveyard, and CR 702.128a
 *    and 701.61a read "your graveyard".
 *
 * G11 flashback: a sorcery card with flashback gets no + edge into a cast "during an opponent's
 *    turn" (CR 117.1a), and a coloured card with flashback gets none into a "colorless spell".
 *
 * G12 aimed at an opponent: G10 and G8 with more demands and more supplies. The demands add
 *    collect evidence, craft, harmonize and descended (CR 701.59a, 702.167a, 702.180a, 700.11).
 *    The supplies add a discard on one target player and a removal of any target: the owner aims
 *    these at an opponent (edge_reports 60, 61, 68, 73, 85, 86: "why would i target my self").
 *    `opponent_object` alone is not enough here, because "Sacrifice this artifact: Each opponent
 *    loses 3 life" has that fact, and the card goes to your graveyard. So the `actor` must not be
 *    `you`, and a stat change must not be `+` (the quote can name an opponent in a second act).
 *    A discard with "draws" stays, because that player gets a reward.
 *
 * G13 controller of the target: "Its controller amasses ..." gives the act to the controller of
 *    the target, so the card gives it to you only when it hits your own object.
 *
 * G14 duration: "until this creature leaves the battlefield" is the end of an effect, not a demand
 *    for the event. The atom stays for its - edges.
 *
 * G15 blight below toughness: "blight N" gets no + edge into a "dies" trigger on the card itself
 *    when N is less than the toughness of that card. CR 701.68a: N -1/-1 counters.
 *
 * G16 cast into enters: an ENABLES.CAST atom gets no + edge into an "enters" demand in two cases.
 *    The demand names a subtype and the cast gives none of them: you cannot plan on "target
 *    nonland permanent card from that player's graveyard" for a Villain trigger. Or the spell is an
 *    instant or a sorcery only, so nothing enters. The spell of "cast this card", Warp and Sneak is
 *    the card itself (CR 702.185a, 702.190a), so these use the subtypes and types of the card. A
 *    demand names a subtype only through `subtype_filter`, which the CR lists must have, and not
 *    when a card type word beside it accepts any object of that type ("Villain and/or artifact").
 *    The old fact `object_subtypes` is not read here: it finds "Dragons you control" in a quoted
 *    ability after the event (Goddric, Cloaked Reveler).
 *
 * G17 reward for the target: "target player draws" gets no + edge into a crime. The owner aims this
 *    text at themself, because the draw helps the target (edge_reports 97 to 100: "will never target
 *    my opponent with this"). This is the other side of G12: a target goes where the text helps you.
 *    "Target player loses 2 life" stays. Only the life loss has the fact: Together as One draws for
 *    you, and its "X damage to any target" in the same quote still goes at an opponent.
 *
 * The facts come from the atom quote, the card names and type lines, and CR text only: plain
 * text tests, no model, no rule numbers. A test that cannot decide leaves the edge (the gate never removes an edge that it
 * cannot prove wrong). Anti-synergy edges (polarity -) do not change.
 */
import type { StoredRule } from './ruleSet.js';
import { isIntrinsic } from './ruleSchema.js';

/** The object facts of one atom; each field is absent when the test does not decide. */
export interface ObjectFacts {
  /** G1: the trigger event of this CARES_ABOUT atom happens to the card itself only. */
  self_subject?: true;
  /** G2: the object of this sacrifice or discard is fixed (`self`), or an opponent does it (`opponent`). */
  fixed_object?: 'self' | 'opponent';
  /** G3: this supply acts on an opponent's object. */
  opponent_object?: true;
  /** G3: this demand is about your own objects. */
  own_object?: true;
  /** G1: this supply makes a copy, so the new object can have the copied "this" trigger. */
  copy?: true;
  /** G4: the card types (lower case, sorted) of the object that the atom makes, moves or names. */
  object_types?: string[];
  /** G5: the subtypes of that object. An empty list is known only for a new token (it has no subtype). */
  object_subtypes?: string[];
  /** G6: the card types that this demand names for the card of its event. */
  event_types?: string[];
  /** G6: the card types that this supply names for its card, when it names some. */
  card_named?: string[];
  /** G6: the card types that this supply excludes for its card. */
  card_excluded?: string[];
  /** G7: this damage can hit only a player. */
  player_damage?: true;
  /** G7: the event of this demand is a permanent that leaves the battlefield. */
  permanent_event?: true;
  /** G8: only an opponent makes this discard. */
  opponent_discard?: true;
  /** G8: this demand needs a card that you discarded. */
  own_discard?: true;
  /** G9: this reduction acts only on its own spell or ability; `equipment` when it counts Equipment. */
  own_cost?: 'any' | 'equipment';
  /** G9, version 7: another form of a reduction of its own card. */
  own_cost_form?: true;
  /** G10: this demand needs a card in your graveyard. */
  own_graveyard?: true;
  /** G11: this flashback casts a sorcery card, so it has sorcery timing. */
  flashback_sorcery?: true;
  /** G11: this flashback casts a coloured card. */
  flashback_coloured?: true;
  /** G11: this cast trigger reads a spell cast on an opponent's turn. */
  opponent_turn_cast?: true;
  /** G11: this cast trigger reads a colorless spell. */
  colorless_cast?: true;
  /** G12: this demand needs a card in your graveyard (the list of version 8). */
  own_graveyard_wide?: true;
  /** G12: this supply acts on an opponent's object, and you are not the actor. */
  opponent_act?: true;
  /** G12: this discard falls on one target player and gives that player no reward. */
  aimed_discard?: true;
  /** G12: this removal can hit any object except its own card. */
  aimed_removal?: true;
  /** G12: this discard trigger reads your own discard. */
  own_discard_event?: true;
  /** G13: the controller of the target makes this act. */
  target_controller?: true;
  /** G14: this atom reads a duration, not an event. */
  duration_only?: true;
  /** G15: the N of this blight. */
  blight_amount?: number;
  /** G15: the toughness of the card of this "dies" trigger on itself. */
  self_toughness?: number;
  /** G9, version 9: two more forms of a reduction of its own ability. */
  own_cost_ability?: true;
  /** G16: the subtypes that this cast can give: those of the card itself, or those that the quote names. */
  cast_subtypes?: string[];
  /** G16: the spell of this cast is an instant or a sorcery only. */
  cast_no_permanent?: true;
  /** G16: this demand is an "enters" event; the list holds the subtypes that it names, and is empty when it names none. */
  enters_subtypes?: string[];
  /** G17: this text gives the target player a card, so the owner aims it at themself. */
  reward_to_target?: true;
  /** G17: this demand is a crime. */
  crime_event?: true;
}

/**
 * G4: the type words of a CR corpus. A card type word gives its own type; a subtype gives the
 * card type of its CR list. "permanent" and "card" give no type, so a phrase with only these
 * words is unknown.
 */
export interface TypeVocab { cardTypes: ReadonlySet<string>; subtypes: ReadonlyMap<string, string> }

/**
 * G4: the vocabulary from CR text. `cardTypes` are the glossary card types; `lists` are the CR
 * subtype list sentences. The card type of a list is the first card type word in its sentence
 * ("The artifact types are …", "All other creature types are …"). "spell" types are instant and
 * sorcery types. A list without a card type word (planar, dungeon) gives nothing.
 */
export function typeVocab(cardTypes: Iterable<string>, lists: ReadonlyArray<{ sentence: string; items: readonly string[] }>): TypeVocab {
  const types = new Set([...cardTypes].map((t) => t.toLowerCase()));
  const subtypes = new Map<string, string>();
  for (const l of lists) {
    const head = l.sentence.toLowerCase().split(/\b(?:types? (?:are|is))\b/)[0]!;
    const words: string[] = head.match(/[a-z]+/g) ?? [];
    const t = words.find((w) => types.has(w)) ?? (words.includes('spell') ? 'spell' : undefined);
    if (!t) continue;
    for (const item of l.items) if (!subtypes.has(item)) subtypes.set(item, t);
  }
  return { cardTypes: types, subtypes };
}

/** G4: the card types that a noun phrase names; null when it names none (unknown or any). */
export function phraseTypes(phrase: string, v: TypeVocab): string[] | null {
  const out = new Set<string>();
  for (const m of phrase.matchAll(/\b(non-?)?([A-Za-z]+)\b/g)) {
    if (m[1]) continue; // "nonland": an exclusion, not a type of the object
    const w = m[2]!;
    const lower = w.toLowerCase();
    const plain = lower.replace(/s$/, '');
    if (v.cardTypes.has(lower)) out.add(lower);
    else if (v.cardTypes.has(plain) && w === lower) out.add(plain);
    else if (/^[A-Z]/.test(w)) {
      const t = v.subtypes.get(w) ?? v.subtypes.get(w.replace(/s$/, ''));
      if (t === 'spell') { out.add('instant'); out.add('sorcery'); } else if (t) out.add(t);
    }
  }
  return out.size ? [...out].sort() : null;
}

/** G4: the card types of a type line (each face), for "this card" and "this permanent". */
export function typeLineTypes(typeLines: readonly string[], v: TypeVocab): string[] {
  const out = new Set<string>();
  for (const line of typeLines) {
    for (const w of line.split('—')[0]!.toLowerCase().match(/[a-z]+/g) ?? []) if (v.cardTypes.has(w)) out.add(w);
  }
  return [...out].sort();
}

/** G16: the subtypes of a type line (each face), for "cast this card". */
export function typeLineSubtypes(typeLines: readonly string[], v: TypeVocab): string[] {
  const out = new Set<string>();
  for (const line of typeLines) {
    for (const face of line.split(' // ')) subtypesIn(face.split('—')[1] ?? '', v).forEach((x) => out.add(x));
  }
  return [...out].sort();
}

const typeId = (x: { family: string; type_key: string }) => `${x.family}.${x.type_key}`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The event verb of each G1 demand type. */
const SELF_EVENTS: Record<string, string> = {
  'CARES_ABOUT.ENTERS_BATTLEFIELD': 'enters',
  'CARES_ABOUT.LEAVES_BATTLEFIELD': 'leaves',
  'CARES_ABOUT.PERMANENT_DIES': 'dies|is put into a graveyard',
  'CARES_ABOUT.ATTACKS': 'attacks',
  'CARES_ABOUT.COMBAT_DAMAGE_TO_PLAYER': 'deals combat damage',
};
/** The act of each G2 demand type. */
const FIXED_ACTS: Record<string, string> = {
  'PRODUCES.SACRIFICE': 'sacrifices?',
  'PRODUCES.DISCARD': 'discards?',
};
/** G3 supply types: types whose act has an object (a permanent, a card or a player). */
const OBJECT_ACTS = new Set([
  'INTERACTION.TARGETED_REMOVAL', 'INTERACTION.SWEEPER', 'INTERACTION.DISCARD', 'PRODUCES.DESTROY', 'PRODUCES.EXILE',
  'PRODUCES.DAMAGE', 'PRODUCES.FIGHT', 'PRODUCES.SACRIFICE', 'PRODUCES.DISCARD', 'PRODUCES.MILL', 'COMBAT.STAT_CHANGE',
]);
/** G3 demand types whose own-object fact is "your graveyard" in the quote (they have no controller param). */
const GRAVEYARD_DEMANDS = new Set(['CARES_ABOUT.POPULATED_GRAVEYARD', 'ENABLES.RECURSION']);
/** G10 demand types whose CR text reads "your graveyard" (CR 702.128a and 701.61a). */
const OWN_GRAVEYARD_TYPES = new Set(['ENABLES.EMBALM', 'PRODUCES.FORAGE']);
/** G12 demand types: G10, then CR 701.59a, 702.167a, 702.180a and 700.11. */
const OWN_GRAVEYARD_WIDE = new Set([
  ...OWN_GRAVEYARD_TYPES, 'PRODUCES.COLLECT_EVIDENCE', 'ENABLES.CRAFT', 'ENABLES.HARMONIZE', 'CARES_ABOUT.DESCENDED',
]);

/** The names by which a card refers to itself: each face name and its part before the first comma. */
export function selfNames(names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    for (const part of n.split(' // ')) {
      if (part.trim().length >= 3) out.add(part.trim());
      const short = part.split(',')[0]!.trim();
      if (short.length >= 3) out.add(short);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** The words that name the card itself: "this <noun>" or one of its names. */
function selfPattern(names: readonly string[]): string {
  return ['this [a-z]+', ...names.map(esc)].join('|');
}

/** The text before the first comma, without an ability-word prefix ("Raid — "). */
function triggerPart(quote: string): string {
  const q = quote.replace(/^[^—"]{1,40} — /, '');
  return q.split(',')[0]!;
}

/** G1: true when the trigger of the atom happens to the card itself only. */
export function selfSubject(type: string, quote: string, names: readonly string[]): boolean {
  const verb = SELF_EVENTS[type];
  if (!verb) return false;
  const t = triggerPart(quote);
  if (!/^(when|whenever|at)\b/i.test(t.trim())) return false;
  if (/\b(another|other)\b|\bor (a|an|one|each)\b/i.test(t)) return false;
  return new RegExp(`\\b(?:${selfPattern(names)})\\s+(?:[a-z]+ (?:or|and) )?(?:${verb})\\b`, 'i').test(t);
}

/**
 * G2: `self` when each act of the quote has a fixed object, `opponent` when each act has an
 * opponent as its actor, and null when one act is open (a choice of an object, or "each player").
 */
export function fixedObject(type: string, quote: string, names: readonly string[]): 'self' | 'opponent' | null {
  const act = FIXED_ACTS[type];
  if (!act) return null;
  const fixed = new RegExp(`^(?:this|it|that|those|them|enchanted|equipped|the|${names.map(esc).join('|') || '\\b\\B'})\\b`, 'i');
  const re = new RegExp(`(\\b[\\w']+\\s+[\\w']+\\s+)?\\b(?:${act})\\s+([^.,;:]{1,60})`, 'gi');
  let kind: 'self' | 'opponent' | null = null;
  let any = false;
  for (const m of quote.matchAll(re)) {
    any = true;
    const actor = (m[1] ?? '').toLowerCase();
    if (/\b(each|target|an|that) opponent\s+$|defending player\s+$/.test(actor)) { kind ??= 'opponent'; continue; }
    if (fixed.test(m[2]!.trim())) { kind = 'self'; continue; }
    return null;
  }
  return any ? kind : null;
}

/** G3: true when a supply of an object act acts on an opponent's object, and on none of yours. */
export function opponentObject(type: string, quote: string): boolean {
  if (!OBJECT_ACTS.has(type)) return false;
  if (/\b(you control|each player|target player|any target|your graveyard|your hand|your library|you own)\b/i.test(quote)) return false;
  return /\b(an opponent controls|opponents control|target opponent|each opponent|that opponent|defending player)\b/i.test(quote);
}

/** G3: true when a demand is about your own objects. */
export function ownObject(type: string, quote: string, params: Record<string, unknown>): boolean {
  if (params['controller'] === 'you') return true;
  if (!GRAVEYARD_DEMANDS.has(type)) return false;
  return /\byour graveyard\b/i.test(quote)
    && !/\b(a|any|each|all|target player's|an opponent's|that player's|its owner's) graveyards?\b/i.test(quote);
}

/** G12: a discard on one target player. "draws" gives that player a reward, so the test does not decide. */
export function aimedDiscard(quote: string): boolean {
  return /^(?:• )?(?:[^—]{1,40} — )?(?:Target|That) player discards\b/.test(quote) && !/\bdraws?\b/i.test(quote);
}

/** G13: the act of the quote belongs to the controller of a target. A trigger on any creature does not count. */
export function targetController(quote: string): boolean {
  return /^(?:For each [^,]{1,40} this way, )?its controller (?:may )?(?:amass(?:es)?|creates?|search(?:es)?)\b/i.test(quote);
}

/** G14: the quote ends an effect when its card leaves the battlefield. */
export function untilLeaves(quote: string, names: readonly string[]): boolean {
  return new RegExp(`\\buntil (?:${selfPattern(names)}) leaves the battlefield\\b`, 'i').test(quote);
}

/** G15: the N of a blight quote, the highest when it has two; null for "blight X". */
export function blightAmount(quote: string): number | null {
  const all = [...quote.matchAll(/\bblights? (\d+)\b/gi)].map((m) => Number(m[1]));
  return all.length ? Math.max(...all) : null;
}

/** G4 demand types with a `permanent_type` param. */
const PERMANENT_TYPE_DEMANDS = new Set([
  'CARES_ABOUT.ENTERS_BATTLEFIELD', 'CARES_ABOUT.LEAVES_BATTLEFIELD', 'CARES_ABOUT.PERMANENT_DIES', 'CARES_ABOUT.PERMANENT_COUNT',
]);
/** G4 types whose act moves a named object: the words after the act verb name the object. */
const MOVE_ACTS: Record<string, RegExp> = {
  'PRODUCES.SACRIFICE': /\bsacrifices?\s+([^.,;:]{1,60})/gi,
  'PRODUCES.DESTROY': /\bdestroy\s+([^.,;:]{1,60})/gi,
  'INTERACTION.TARGETED_REMOVAL': /\b(?:destroy|exile)\s+([^.,;:]{1,60})/gi,
  'PRODUCES.EXILE': /\bexile\s+([^.,;:]{1,60})/gi,
  'ENABLES.SACRIFICE_OUTLET': /\bsacrifices?\s+([^.,;:]{1,60})/gi,
};

/** The words of an object phrase up to its end ("you control", "with", "from", "until" and so on). */
function objectPhrase(p: string): string {
  return p.split(/\b(?:you control|an opponent controls|they control|with|from|until|this turn|at random|of their choice|then)\b/)[0]!;
}

/**
 * G4 and G5: the words that name the object of a demand without an act verb: "Affinity for X",
 * and the subject of a haste grant ("Other Goblins you control have haste"). Null for other types.
 */
function subjectSegment(type: string, quote: string): string | null {
  if (type === 'ENABLES.AFFINITY') return /\baffinity for ([^.,;:(]+)/i.exec(quote)?.[1] ?? null;
  if (type === 'ENABLES.HASTE_GRANT') return /^(?:[^—.]{1,40} — )?([^.,;:]*?)\b(?:has|have|gains?)\b[^.]*\bhaste\b/i.exec(quote)?.[1] ?? null;
  return null;
}

/** G5: the CR subtypes named in a segment (any list: creature, artifact and so on), without the card's own names. */
export function subtypesIn(segment: string, v: TypeVocab, names: readonly string[] = []): string[] {
  let s = segment;
  for (const n of names) s = s.split(n).join(' ');
  const out = new Set<string>();
  for (const m of s.matchAll(/\b(non-?)?([A-Z][a-z]+)\b/g)) {
    if (m[1]) continue;
    const w = m[2]!;
    const sub = v.subtypes.has(w) ? w : v.subtypes.has(w.replace(/s$/, '')) ? w.replace(/s$/, '') : null;
    if (sub && !v.cardTypes.has(sub.toLowerCase()) && v.subtypes.get(sub) !== 'spell') out.add(sub);
  }
  return [...out].sort();
}

/** G5 demand types whose trigger part, or the words before "you control", name the object. */
const SUBTYPE_DEMANDS = new Set([
  'CARES_ABOUT.ENTERS_BATTLEFIELD', 'CARES_ABOUT.LEAVES_BATTLEFIELD', 'CARES_ABOUT.PERMANENT_DIES', 'CARES_ABOUT.ATTACKS',
  'CARES_ABOUT.PERMANENT_COUNT',
]);

/**
 * G5: the subtypes of the object of one atom. A new token has exactly the subtypes that its
 * create phrase names, so its list can be empty and still be known. For other atoms the list is
 * known only when it names one or more subtypes. Null when the test does not decide.
 */
export function objectSubtypes(type: string, quote: string, v: TypeVocab, names: readonly string[]): string[] | null {
  if (type === 'PRODUCES.CREATE' || type === 'PRODUCES.TOKENS') {
    if (/\bcop(y|ies)\b|\bchangeling\b|\ball creature types\b/i.test(quote)) return null;
    const all = new Set<string>();
    let found = false;
    for (const m of quote.matchAll(/\bcreates?\s+([^.;:"]*?)\btokens?\b/gi)) {
      found = true;
      subtypesIn(m[1]!, v, names).forEach((x) => all.add(x));
    }
    return found ? [...all].sort() : null;
  }
  let segment: string | null = subjectSegment(type, quote);
  if (segment === null && SUBTYPE_DEMANDS.has(type)) {
    const t = triggerPart(quote);
    segment = /^(when|whenever|at)\b/i.test(t.trim()) ? t : /\b((?:\S+\s+){1,5})you control\b/.exec(quote)?.[1] ?? null;
  }
  if (segment === null) {
    const act = MOVE_ACTS[type] ?? (FIXED_ACTS[type] ? new RegExp(`\\b(?:${FIXED_ACTS[type]})\\s+([^.,;:]{1,60})`, 'gi') : undefined);
    if (!act) return null;
    const all = new Set<string>();
    for (const m of quote.matchAll(act)) {
      const sub = restricting(objectPhrase(m[1]!), v, names);
      if (!sub) return null;
      sub.forEach((x) => all.add(x));
    }
    return all.size ? [...all].sort() : null;
  }
  return restricting(segment, v, names);
}

/**
 * G5: the subtypes that a demand segment requires, or null when it requires none. A card type
 * word without a subtype word before it ("another creature or Vehicle") accepts any object of
 * that type, so the subtypes of the segment do not restrict it.
 */
function restricting(segment: string, v: TypeVocab, names: readonly string[]): string[] | null {
  const sub = subtypesIn(segment, v, names);
  if (!sub.length) return null;
  const words = segment.match(/[A-Za-z]+/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.toLowerCase().replace(/s$/, '');
    if (!v.cardTypes.has(w) && !v.cardTypes.has(words[i]!.toLowerCase())) continue;
    const prev = words[i - 1] ?? '';
    if (!(v.subtypes.has(prev) || v.subtypes.has(prev.replace(/s$/, '')))) return null;
  }
  return sub;
}

/** G16: the spell of a cast is the card itself. CR 702.185a and 702.190a: Warp and Sneak cast it too. */
export function castsItself(quote: string): boolean {
  return /\bcast this card\b/i.test(quote) || /^(?:Warp|Sneak)\b/.test(quote);
}

/** G16: the spell of a cast is an instant or a sorcery only. "this creature" names the source, not the spell. */
export function castsNoPermanent(quote: string, own: readonly string[], v: TypeVocab): boolean {
  const named = quote.replace(/\bthis [a-z]+\b/gi, ' ');
  const types = castsItself(quote) ? own : /\bpermanents?\b/i.test(named) ? [] : phraseTypes(named, v) ?? [];
  return types.length > 0 && types.every((t) => t === 'instant' || t === 'sorcery');
}

/**
 * G16: the subtypes that an "enters" demand names. `subtype_filter` is a reading of the model, so a
 * CR subtype list must have the word. A card type word in the trigger accepts any object of that
 * type, so the subtype does not restrict the demand. "this creature" is not that card type word.
 */
export function entersSubtypes(quote: string, params: Record<string, unknown>, v: TypeVocab, names: readonly string[]): string[] {
  const f = params['subtype_filter'];
  if (typeof f !== 'string' || !v.subtypes.has(f)) return [];
  return restricting(triggerPart(quote).replace(/\bthis [a-z]+\b/gi, ' '), v, names) ? [f] : [];
}

/** G4: the card types of the object of one atom; null when the test does not decide. */
export function objectTypes(type: string, quote: string, params: Record<string, unknown>, own: readonly string[],
  v: TypeVocab): string[] | null {
  if (PERMANENT_TYPE_DEMANDS.has(type)) {
    const p = params['permanent_type'];
    return typeof p === 'string' && v.cardTypes.has(p) ? [p] : null;
  }
  // A new token: the words between "create" and "token". A copy has the types of what it copies.
  if (type === 'PRODUCES.CREATE' || type === 'PRODUCES.TOKENS') {
    if (/\bcop(y|ies)\b/i.test(quote)) return null;
    const all = new Set<string>();
    let found = false;
    for (const m of quote.matchAll(/\bcreates?\s+([^.;:"]*?)\btokens?\b/gi)) {
      found = true;
      const t = phraseTypes(m[1]!, v);
      if (!t) return null;
      t.forEach((x) => all.add(x));
    }
    return found && all.size ? [...all].sort() : null;
  }
  // A graveyard demand: the card types before "card(s)" in "… card(s) in/from your graveyard".
  if (GRAVEYARD_DEMANDS.has(type)) {
    if (/\bcard types\b/i.test(quote)) return null;
    if (/\breturn this card\b/i.test(quote)) return own.length ? [...own] : null;
    const all = new Set<string>();
    for (const m of quote.matchAll(/\b((?:[A-Za-z]+(?:,| and\/or| or| and)? ){1,4})cards?\b[^.]{0,40}\b(?:in|from) your graveyard\b/gi)) {
      const t = phraseTypes(m[1]!, v);
      if (!t) return null;
      t.forEach((x) => all.add(x));
    }
    return all.size ? [...all].sort() : null;
  }
  const segment = subjectSegment(type, quote);
  if (segment !== null) return phraseTypes(segment, v);
  const act = MOVE_ACTS[type];
  if (act) {
    const all = new Set<string>();
    for (const m of quote.matchAll(act)) {
      const phrase = objectPhrase(m[1]!).trim();
      // "this land", "this creature": the noun; "this card", "it": the card's own types.
      const t = /^(?:this|it)\b/i.test(phrase)
        ? phraseTypes(phrase.split(/\s+/).slice(0, 2).join(' '), v) ?? (own.length ? [...own] : null)
        : phraseTypes(phrase, v);
      if (!t) return null;
      t.forEach((x) => all.add(x));
    }
    return all.size ? [...all].sort() : null;
  }
  return null;
}

/**
 * The type that the gate tests read. spec sec. 23 item B2: a STAT_CHANGE atom of `scope` set is the
 * old ANTHEM atom, which is not in OBJECT_ACTS, so the merge changes no fact of the gate.
 */
const gateType = (a: { family: string; type_key: string; params: Record<string, unknown> }) =>
  (typeId(a) === 'COMBAT.STAT_CHANGE' && a.params['scope'] === 'set' ? 'COMBAT.ANTHEM' : typeId(a));

/** The object facts of one atom (sec. 7.9). `own` are the card types of the atom's card; `v` the G4 vocabulary; `colours` the colours of the card; `toughness` the printed toughness of its face; `ownSubtypes` the subtypes of the card. */
export function objectFactsOf(a: { family: string; type_key: string; params: Record<string, unknown> }, quote: string,
  names: readonly string[], own: readonly string[] = [], v?: TypeVocab, colours: readonly string[] = [],
  toughness: string | null = null, ownSubtypes: readonly string[] = []): ObjectFacts {
  const t = gateType(a);
  const f: ObjectFacts = {};
  const types = v ? objectTypes(t, quote, a.params, own, v) : null;
  if (types?.length) f.object_types = types;
  const subtypes = v ? objectSubtypes(t, quote, v, names) : null;
  if (subtypes) f.object_subtypes = subtypes;
  if (selfSubject(t, quote, names)) f.self_subject = true;
  const fixed = fixedObject(t, quote, names);
  if (fixed) f.fixed_object = fixed;
  if (opponentObject(t, quote)) f.opponent_object = true;
  if (ownObject(t, quote, a.params)) f.own_object = true;
  if (/\bcop(y|ies)\b/i.test(quote)) f.copy = true;
  const list = (k: string) => (a.params[k] as string[] | undefined) ?? [];
  if (t === 'CARES_ABOUT.DISCARD' && list('card_types').length) f.event_types = list('card_types');
  if (t === 'PRODUCES.DISCARD') {
    if (list('card_types').length) f.card_named = list('card_types');
    if (list('excluded_card_types').length) f.card_excluded = list('excluded_card_types');
  }
  const recipient = a.params['recipient'];
  if (t === 'PRODUCES.DAMAGE' && (recipient === 'opponent' || recipient === 'you' || (recipient === 'player' && !/\bplaneswalker\b/i.test(quote)))) f.player_damage = true;
  if (t === 'CARES_ABOUT.PERMANENT_DIES' || t === 'CARES_ABOUT.LEAVES_BATTLEFIELD') f.permanent_event = true;
  if (t === 'PRODUCES.DISCARD' && a.params['actor'] === 'opponent') f.opponent_discard = true;
  if (t === 'ENABLES.MAYHEM') f.own_discard = true;
  if (t === 'ENABLES.COST_REDUCTION' && /\bthis (?:spell|ability) costs\b/i.test(quote)) f.own_cost = /\bfor each Equipment\b/.test(quote) ? 'equipment' : 'any';
  if (t === 'ENABLES.COST_REDUCTION' && /^(?:[^—]{1,40} — )?Affinity for\b|\bthis cost is reduced\b/i.test(quote)) f.own_cost_form = true;
  if (OWN_GRAVEYARD_TYPES.has(t)) f.own_graveyard = true;
  // G11 reads the keyword on the card itself. A card can also give flashback to another card.
  if (t === 'ENABLES.FLASHBACK' && /^Flashback\b/.test(quote)) {
    if (own.includes('sorcery') && !own.includes('instant')) f.flashback_sorcery = true;
    if (colours.length) f.flashback_coloured = true;
  }
  if (t === 'CARES_ABOUT.SPELL_CAST') {
    if (/\bduring (?:an|each) opponent's turn\b/i.test(quote)) f.opponent_turn_cast = true;
    if (/\bcolorless spell/i.test(quote)) f.colorless_cast = true;
  }
  if (OWN_GRAVEYARD_WIDE.has(t)) f.own_graveyard_wide = true;
  if (f.opponent_object && a.params['actor'] !== 'you' && a.params['sign'] !== '+') f.opponent_act = true;
  if (t === 'PRODUCES.DISCARD' && a.params['actor'] === 'any' && aimedDiscard(quote)) f.aimed_discard = true;
  if (t === 'INTERACTION.TARGETED_REMOVAL' && a.params['object_controller'] !== 'you' && a.params['object'] !== 'self') f.aimed_removal = true;
  if (t === 'CARES_ABOUT.DISCARD' && a.params['player'] === 'you') f.own_discard_event = true;
  if (targetController(quote)) f.target_controller = true;
  if (t === 'CARES_ABOUT.LEAVES_BATTLEFIELD' && untilLeaves(quote, names)) f.duration_only = true;
  if (t === 'PRODUCES.BLIGHT') {
    const n = blightAmount(quote);
    if (n !== null) f.blight_amount = n;
  }
  if (t === 'CARES_ABOUT.PERMANENT_DIES' && f.self_subject && toughness !== null && /^\d+$/.test(toughness)) f.self_toughness = Number(toughness);
  if (t === 'ENABLES.COST_REDUCTION' && (/\bthis ability's activation cost\b/i.test(quote) || /^Power-up\b/.test(quote))) f.own_cost_ability = true;
  if (t === 'ENABLES.CAST' && v) {
    f.cast_subtypes = castsItself(quote) ? [...ownSubtypes] : subtypesIn(quote, v, names);
    if (castsNoPermanent(quote, own, v)) f.cast_no_permanent = true;
  }
  if (t === 'CARES_ABOUT.ENTERS_BATTLEFIELD' && v) f.enters_subtypes = entersSubtypes(quote, a.params, v, names);
  if (t === 'PRODUCES.LIFE_LOSS' && /\btarget player draws\b/i.test(quote)) f.reward_to_target = true;
  if (t === 'CARES_ABOUT.COMMIT_CRIME') f.crime_event = true;
  return f;
}

/**
 * The new-object supply types of a schema: each type whose label or evidence says that it
 * creates a token or a permanent, and does not say "copy" (sec. 7.9 G1, `project_decision`: the
 * evidence of these types quotes the CR keyword actions that create tokens).
 */
export function newObjectTypes(types: ReadonlyArray<{ family: string; type_key: string; label: string; evidence: string | null }>): Set<string> {
  const out = new Set<string>();
  for (const t of types) {
    const e = `${t.label} ${t.evidence ?? ''}`;
    if (/\bcreat(e|es)\b/i.test(e) && /\b(tokens?|permanent)\b/i.test(e) && !/\bcop(y|ies)\b/i.test(e)) out.add(typeId(t));
  }
  return out;
}

type GateAtom = { family: string; type_key: string; object_facts?: ObjectFacts };

/** G4: the card types of a class supply; null for another kind, or a subtype without a card type. */
export function classTypes(r: StoredRule, v: TypeVocab | null): string[] | null {
  if (!v || !isIntrinsic(r.supply)) return null;
  const value = String(r.supply.value);
  if (r.supply.intrinsic === 'card_type') return v.cardTypes.has(value.toLowerCase()) ? [value.toLowerCase()] : null;
  if (r.supply.intrinsic === 'subtype') {
    const t = v.subtypes.get(value);
    return t && t !== 'spell' ? [t] : null;
  }
  return null;
}

/**
 * True when the object gate removes the + edge of rule `r` from supply `s` (null for a class)
 * into demand `d` (sec. 7.9).
 */
/**
 * The version of the object gate that a build applies: 1 has G1-G3 (build 8), 2 adds G4 and G5,
 * 3 adds G6, 4 adds G7, 5 adds G8, 6 adds G9 to G11, 7 adds two forms to G9, 8 adds G12 to G15,
 * 9 adds two more forms to G9, and G16, 10 adds G17. A stored build keeps its version, so it loads
 * with its own edges. The facts have no version, so a new test reads a new fact and comes after its
 * version check.
 */
export const OBJECT_GATE_VERSION = 10;

export function objectGateBlocks(r: StoredRule, s: GateAtom | null, d: GateAtom, newObject: ReadonlySet<string>,
  vocab: TypeVocab | null = null, version: number = OBJECT_GATE_VERSION): boolean {
  if (r.polarity !== '+') return false;
  const df = d.object_facts ?? {};
  const sf = s?.object_facts ?? {};
  // G1: a new object or another card is never "this" object. A copy can carry the copied trigger.
  if (df.self_subject && (isIntrinsic(r.supply) || newObject.has(typeId(r.supply))) && !sf.copy) return true;
  // G2: a fixed object or an opponent's act takes nothing from another card.
  if (df.fixed_object) return true;
  // G3: an act on an opponent's object does not touch your own objects.
  if (sf.opponent_object && df.own_object) return true;
  if (version < 2) return false;
  // G4: the object of the supply and the object of the demand share no card type.
  const st = s ? sf.object_types : classTypes(r, vocab);
  const dt = df.object_types;
  if (st?.length && dt?.length && !st.some((x) => dt.includes(x))) return true;
  // G5: the demand names subtypes, and the supply object has none of them.
  const ss = s ? sf.object_subtypes : isIntrinsic(r.supply) && r.supply.intrinsic === 'subtype' ? [String(r.supply.value)] : undefined;
  const ds = df.object_subtypes;
  if (ds?.length && ss && !ss.some((x) => ds.includes(x))) return true;
  if (version < 3) return false;
  // G6: the demand names card types for its event, and the supply can give none of them.
  const named = sf.card_named ?? [];
  if (df.event_types?.every((x) => sf.card_excluded?.includes(x) || (named.length > 0 && !named.includes(x)))) return true;
  if (version < 4) return false;
  // G7: damage that can hit only a player moves no permanent from the battlefield.
  if (sf.player_damage && df.permanent_event) return true;
  if (version < 5) return false;
  // G8: a card that an opponent discards is not a card that you discarded.
  if (sf.opponent_discard && df.own_discard) return true;
  if (version < 6) return false;
  // G9: a reduction of its own spell or ability helps no other card. Equip stays on a count of Equipment.
  if (s && df.own_cost && !(df.own_cost === 'equipment' && typeId(s) === 'ENABLES.EQUIP')) return true;
  // G10: the card of an opponent goes to the graveyard of that opponent.
  if ((sf.opponent_discard || sf.opponent_object) && df.own_graveyard) return true;
  // G11: the card type and the colour of a flashback card do not change when it is cast.
  if ((sf.flashback_sorcery && df.opponent_turn_cast) || (sf.flashback_coloured && df.colorless_cast)) return true;
  if (version < 7) return false;
  // G9, two more forms of a reduction of its own card.
  if (s && df.own_cost_form) return true;
  if (version < 8) return false;
  // G12: an act aimed at an opponent puts no card in your graveyard and is not your discard.
  if ((sf.opponent_discard || sf.aimed_discard || sf.aimed_removal || sf.opponent_act) && df.own_graveyard_wide) return true;
  if (sf.aimed_discard && (df.own_discard || df.own_discard_event)) return true;
  // G13: the act goes to the controller of the target.
  if (sf.target_controller) return true;
  // G14: a duration needs no event.
  if (df.duration_only) return true;
  // G15: the counters do not kill the card.
  if (sf.blight_amount !== undefined && df.self_toughness !== undefined && sf.blight_amount < df.self_toughness) return true;
  if (version < 9) return false;
  // G9, two more forms of a reduction of its own ability.
  if (s && df.own_cost_ability) return true;
  // G16: a cast that gives no permanent, or none of the subtypes that the demand names, is not this event.
  const es = df.enters_subtypes;
  if (es && sf.cast_subtypes && (sf.cast_no_permanent === true || (es.length > 0 && !sf.cast_subtypes.some((x) => es.includes(x))))) return true;
  if (version < 10) return false;
  // G17: a text that helps its target does not go at an opponent.
  return sf.reward_to_target === true && df.crime_event === true;
}
