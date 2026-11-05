import type { DatabaseSync } from 'node:sqlite';
import { assembleScopedPacket, type PacketSection, type ScopedPacket } from '../rules/packet.js';
import type { MatchedTerm, PacketPolicy } from '../rules/relevance.js';
import { currentSchemaVersion, validateAtomParams } from './schema.js';
import { V9_TWINS } from './schemaV15.js';
import { V16_TWINS } from './schemaV16.js';
import { isWouldDieRider } from './schemaV20.js';

// ---------- sec. 6.1: name redaction ----------

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One name occurrence replaced by `~`, as offsets into the ORIGINAL text. */
export interface Redaction {
  start: number;
  end: number;
  name: string;
}

export interface RedactedText {
  /** The text the model sees. */
  text: string;
  /** Every replacement made, in document order, as offsets into the original text. */
  redactions: Redaction[];
}

/** One alternation per distinct name list - building it is the expensive part. */
const patternCache = new WeakMap<readonly string[], RegExp | null>();

function namePattern(names: readonly string[]): RegExp | null {
  if (patternCache.has(names)) return patternCache.get(names)!;
  const distinct = [...new Set(names.filter((n) => n.length > 0))];
  // Longest first: at any position the alternation tries the longer name before a name it
  // contains, so "Ajani, Nacatl Pariah" is consumed whole rather than as "Ajani" + rest.
  distinct.sort((a, b) => b.length - a.length);
  const re = distinct.length === 0
    ? null
    // Anchored on letter/number boundaries, so "Sear" never eats the "Sear" in "Search".
    : new RegExp('(?<![\\p{L}\\p{N}])(?:' + distinct.map(esc).join('|') + ')(?![\\p{L}\\p{N}])', 'gu');
  patternCache.set(names, re);
  return re;
}

/**
 * sec. 6.1 redaction, keeping the offset map. The model only ever sees the redacted copy, so
 * the quotes it returns are substrings of THAT copy - "When ~ enters" never occurs verbatim
 * in the stored oracle text. Quote resolution searches the redacted copy and maps the hit
 * back through `redactions`, so stored spans stay offsets into the real text.
 *
 * `ownNames` is the card's own short names (ownShortNames). They get a pattern of their own
 * so the pool-wide one stays cached - rebuilding it per card costs ~40 ms.
 */
export function redactWithMap(
  text: string,
  names: readonly string[],
  ownNames: readonly string[] = [],
): RedactedText {
  const hits: Redaction[] = [];
  for (const re of [namePattern(names), namePattern(ownNames)]) {
    if (!re) continue;
    for (const m of text.matchAll(re)) hits.push({ start: m.index!, end: m.index! + m[0].length, name: m[0] });
  }
  // Across the two patterns, the same rule as inside one: the longest match at a position
  // wins, so "Katara, Water Tribe's Hope" is one `~`, not `~` + ", Water Tribe's Hope".
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const redactions: Redaction[] = [];
  let out = '';
  let last = 0;
  for (const h of hits) {
    if (h.start < last) continue;
    redactions.push(h);
    out += text.slice(last, h.start) + '~';
    last = h.end;
  }
  return { text: out + text.slice(last), redactions };
}

/**
 * sec. 6.1. Replaces every pool card name with Magic's own templating placeholder.
 * Longest first, so a name containing another is handled; anchored on word
 * boundaries, so "Sear" never eats the "Sear" in "Search".
 */
export function redactCardNames(text: string, names: readonly string[]): string {
  return redactWithMap(text, names).text;
}

/**
 * Maps a half-open span of the redacted text back to the original text. A `~` maps to the
 * whole name it replaced, so a span that starts or ends on one widens to cover the name.
 */
export function unredactSpan(
  redactions: readonly Redaction[],
  start: number,
  end: number,
): { start: number; end: number } {
  const toOriginal = (pos: number, edge: 'start' | 'end'): number => {
    let shift = 0; // original length minus redacted length, for replacements before pos
    for (const r of redactions) {
      const at = r.start - shift; // where this replacement's `~` sits in the redacted text
      if (pos < at || (edge === 'end' && pos === at)) break;
      if (pos === at && edge === 'start') return r.start;
      if (pos === at + 1 && edge === 'end') return r.end;
      shift += r.end - r.start - 1;
    }
    return pos + shift;
  };
  return { start: toOriginal(start, 'start'), end: toOriginal(end, 'end') };
}

/** Every distinct card and face name in the pool - 222 two-faced cards have face names. */
export function poolCardNames(db: DatabaseSync): string[] {
  return [...new Set([
    ...(db.prepare('SELECT name FROM cards').all() as Array<{ name: string }>).map((r) => r.name),
    ...(db.prepare('SELECT DISTINCT name FROM card_faces').all() as Array<{ name: string }>).map((r) => r.name),
  ])];
}

/**
 * The names to redact: every pool name except those the current corpus's term index defines
 * as rules vocabulary (Task 8 ruling R9). Word anchoring cannot help here - "Island" and
 * "Flashback" are whole words - and redacting them blanks basic-land searches and the
 * flashback keyword on ~45 faces. Measured on the 2026-09-25 pool: every harmful collision
 * is a term-index term, and no card's own name is one, so the exclusion costs no self-reference
 * (asserted pool-wide in tests/redact.test.ts).
 */
export function redactionNames(db: DatabaseSync): string[] {
  const vocabulary = rulesVocabulary(db);
  return poolCardNames(db).filter((n) => !vocabulary.has(n.toLowerCase()));
}

/** Every term the current corpus's term index defines, lower-cased. */
function rulesVocabulary(db: DatabaseSync): Set<string> {
  const corpus = db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as
    { id: number } | undefined;
  return new Set(
    corpus
      ? (db.prepare('SELECT term FROM rule_term_index WHERE corpus_id = ?').all(corpus.id) as
          Array<{ term: string }>).map((r) => r.term.toLowerCase())
      : [],
  );
}

/**
 * The short names a card calls itself by: the part before the comma of its name and of each
 * face name ("When Katara enters" on "Katara, Water Tribe's Hope"). On the 2026-09-25 pool,
 * 471 of the 745 cards with such a name use it in their own text. Only the card's OWN short
 * names are redacted: "Kellan" names five different cards, so on a pool-wide list it would
 * stand for whichever one. Rules vocabulary is spared as in redactionNames ("Storm, Windrider";
 * none of the three such cards refers to itself by it).
 */
export function ownShortNames(db: DatabaseSync, oracleId: string): string[] {
  const rows = db.prepare(
    'SELECT name FROM cards WHERE oracle_id = ? UNION SELECT name FROM card_faces WHERE oracle_id = ?',
  ).all(oracleId, oracleId) as Array<{ name: string }>;
  const short = [...new Set(rows
    .flatMap((r) => r.name.split(' // '))
    .filter((n) => n.includes(', '))
    .map((n) => n.slice(0, n.indexOf(', '))))];
  if (short.length === 0) return short;            // most cards: skip the vocabulary read
  const vocabulary = rulesVocabulary(db);
  return short.filter((n) => !vocabulary.has(n.toLowerCase()));
}

// ---------- sec. 6.1: request assembly ----------

/**
 * One card's share of an extraction batch: what the batch packet shows for it, and what
 * validation checks its answer against. The kernel is identical for every card, so a batch
 * renders it once; the card's own sections are deduplicated across the batch (extractBatch.ts).
 */
export interface CardRequest {
  oracleId: string;
  schemaVersion: number;
  layout: string;
  /** The kernel blocks - the constant part, identical for every card. */
  kernelSections: PacketSection[];
  /** This card's term-reachable blocks that the kernel does not contain. */
  cardSections: PacketSection[];
  /** Glossary definitions the term matcher reached, as "Term: definition". */
  glossary: string[];
  /** The name-redacted card record, one rendered block per face. */
  faces: string[];
  /** Every rule number whose text the packet carried for THIS card - gate 4's whitelist. */
  packetRules: string[];
  /** The packet's selected characters (ScopedPacket.selectedChars), for extraction_results. */
  packetChars: number;
  /** The redaction list the card record was built with; validation redacts with the same. */
  names: readonly string[];
  /** Every replacement made, per face - the redaction diff. */
  redactions: Array<{ face_index: number; redactions: Redaction[] }>;
}

/**
 * The instructions of a packet on `schemaVersion`. Schema v16 (spec sec. 21, items M3 and M4): a keyword
 * that is an activated ability gets only its own type, with the ACTIVATE cost params, and a Cycling
 * text gets no Discard atom. Schema v17 (spec sec. 22, items S1-S3 and R1-R4): every sacrifice gets
 * PRODUCES SACRIFICE with its cost and decision, and the sacrifice trigger, Role, Food and descended
 * texts get their new atoms. Schema v18 (spec sec. 23, items B1-B3): the merged types replace their
 * old lines. Schema v19 (spec sec. 24, items E1-E6): the six event triggers get their new types, and
 * the forms of review 1 F6 get one line each. Schema v20 (spec sec. 25, items D1 and D2): each
 * PRODUCES DAMAGE atom gets recipient and targeted. Packets on earlier versions keep the old text.
 */
export function instructionsFor(schemaVersion: number): string {
  if (schemaVersion < 16) return INSTRUCTIONS;
  const swap = (s: string, from: string, to: string) => {
    if (!s.includes(from)) throw new Error(`instructionsFor: the text "${from}" is not in INSTRUCTIONS - fix the v16 swap`);
    return s.replace(from, to);
  };
  let s = swap(INSTRUCTIONS, 'loyalty abilities, level-up lines, and keywords that are activated abilities (Equip, Crew, Craft get ACTIVATE beside their own type).',
    'and loyalty abilities. It does not include a keyword that is an activated ability: Equip, Crew, Craft, Cycling, Level up and the other keyword types of that kind get only their own type, with the params cost_mana and cost_tap, and no ACTIVATE atom.');
  s = swap(s, 'gets CREW and ACTIVATE, not POWER;', 'gets CREW (with cost_mana and cost_tap), not ACTIVATE and not POWER;');
  s = swap(s, '- Reminder text (in parentheses)', '- A Cycling text (Cycling, or a landcycling or typecycling keyword) gets only CYCLING: no DISCARD, CARD_DRAW, SEARCH, SHUFFLE or REVEAL atom.\n- Reminder text (in parentheses)');
  if (schemaVersion < 17) return s;
  s = swap(s, 'rules text that says "create" gets PRODUCES CREATE only, with amount', 'rules text that says "create" gets PRODUCES CREATE (and only the atoms that the Role and Food lines below add), with amount');
  s = swap(s, '- Reminder text (in parentheses)', `${V17_LINES}\n- Reminder text (in parentheses)`);
  if (schemaVersion < 18) return s;
  s = swap(s, '- COMBAT STAT_CHANGE: a power/toughness change to one creature - "this creature", "target creature", "enchanted creature", "equipped creature" ("Target creature gets +2/+2 until end of turn."). COMBAT ANTHEM stays for a set of creatures ("Creatures you control get +1/+1."). A -N/-N on one creature also gets INTERACTION TARGETED_REMOVAL.',
    '- COMBAT STAT_CHANGE: a power/toughness change. scope one: one creature - "this creature", "target creature", "enchanted creature", "equipped creature" ("Target creature gets +2/+2 until end of turn."). scope set: a set of creatures ("Creatures you control get +1/+1."), with subject_type, subject_filter and controller. A -N/-N on one creature also gets INTERACTION TARGETED_REMOVAL, with removal_type minus.');
  s = swap(s, 'not STAT_CHANGE and not ANTHEM, which only modify.', 'not STAT_CHANGE, which only modifies.');
  s = swap(s, 'ANTHEM subject_filter has no subject param', 'The subject_filter of STAT_CHANGE has no subject param');
  s = swap(s, '- PRODUCES SELF_LIFE_LOSS: "you lose N life"; PRODUCES OPPONENT_LIFE_LOSS is for opponents. "Each player loses N life" gets both PRODUCES SELF_LIFE_LOSS and PRODUCES OPPONENT_LIFE_LOSS, because each player includes you.',
    '- PRODUCES LIFE_LOSS: one atom for each clause in which a player loses life, with player as its description says. "Each player loses N life" gets one atom, with player each.');
  s = swap(s, '- Reminder text (in parentheses)', `${V18_LINES}\n- Reminder text (in parentheses)`);
  if (schemaVersion < 19) return s;
  s = swap(s, '- Reminder text (in parentheses)', `${V19_LINES}\n- Reminder text (in parentheses)`);
  if (schemaVersion < 20) return s;
  s = swap(s, '- Reminder text (in parentheses)', `${V20_LINES}\n- Reminder text (in parentheses)`);
  return s;
}

/** Schema v20: the lines that the packets on v20 add to the tagging conventions. */
const V20_LINES = [
  '- PRODUCES DAMAGE: set recipient and targeted as their descriptions say. When one clause has two amounts with two recipients ("deals 4 damage to any target and 3 damage to you"), each atom has the recipient of its own amount. When one amount goes to two recipients ("deals 1 damage to each opponent and each creature they control"), the atom has recipient any.',
  '- A clause that only changes an amount and names no recipient ("It deals 5 damage instead if you control a Spacecraft.") takes the recipient and targeted of the clause that it changes.',
  '- A text that ends "would die this turn, exile it instead." gets PRODUCES EXILE and no CARES_ABOUT PERMANENT_DIES atom.',
].join('\n');

/** Schema v19: the lines that the packets on v19 add to the tagging conventions. */
const V19_LINES = [
  '- CARES_ABOUT DISCARD: a trigger on a discard ("Whenever an opponent discards a card", "Whenever you discard one or more cards"). That trigger watches for an action and asks for none, so it gets no PRODUCES DISCARD. What the trigger does keeps its own atoms.',
  '- CARES_ABOUT LEAVES_GRAVEYARD: a trigger on cards that leave your graveyard ("Whenever one or more cards leave your graveyard"). What the trigger does keeps its own atoms.',
  '- CARES_ABOUT BECOMES_TAPPED: a trigger on a permanent that becomes tapped ("Whenever this creature becomes tapped", "Whenever equipped creature becomes tapped"). That trigger asks for no tap, so it gets no ENABLES TAP_AND_UNTAP. What the trigger does keeps its own atoms.',
  '- CARES_ABOUT CARD_DRAW: a trigger on a card draw ("Whenever you draw your second card each turn", "Whenever an opponent draws a card"). That trigger asks for no draw, so it gets no PRODUCES CARD_DRAW. What the trigger does keeps its own atoms.',
  '- CARES_ABOUT COMMIT_CRIME: a trigger on a crime ("Whenever you commit a crime"). What the trigger does keeps its own atoms.',
  '- CARES_ABOUT DEALT_DAMAGE: a trigger on damage to something ("Whenever this creature is dealt damage", "Whenever an opponent is dealt noncombat damage"). The words "is dealt damage" get no PRODUCES DAMAGE. What the trigger does keeps its own atoms.',
  '- These six types are for a "When" or "Whenever" trigger only. A clause that only checks such an event ("if you discarded a card this turn") does not get them.',
  '- The line for "Whenever you sacrifice a ..." also holds for "Whenever an opponent sacrifices ..." (controller opponent) and for a clause that checks or counts a sacrifice this turn ("if you sacrificed a permanent this turn", "the number of permanents you\'ve sacrificed this turn"). Each gets CARES_ABOUT PERMANENT_DIES with cause "sacrifice".',
  '- A clause with "X or Y" objects ("Sacrifice an artifact or creature.") gets one atom, not one atom for each object. A param that holds one object type is then "any", and a param that holds a list has both.',
  '- A damage text with "target" for an object ("deals 3 damage to target creature", "deals 2 damage to any target") gets PRODUCES DAMAGE and also INTERACTION TARGETED_REMOVAL, with removal_type damage. A damage text that can only hit a player ("target opponent", "target player") gets only PRODUCES DAMAGE.',
  '- "this token" in an ability that a token has ("a token with \'Sacrifice this token: ...\'") is self, as each "this ..." is.',
  '- An additional cost with an alternative ("As an additional cost to cast this spell, sacrifice a creature or discard a card.") has decision choice, not cost.',
  '- The object_type of "sacrifice it" or "sacrifice that ...": the type that the same ability names for that object. "any" when the ability names none.',
].join('\n');

/** Schema v18: the lines that the packets on v18 add to the tagging conventions. */
const V18_LINES = [
  '- INTERACTION TARGETED_REMOVAL: set removal_type as its description says. A Destroy text with a target gets this type, with removal_type destroy and the param object, and no PRODUCES DESTROY. PRODUCES DESTROY stays for a Destroy text with no target.',
  '- An Exile text that gets INTERACTION TARGETED_REMOVAL has removal_type exile and the params object and from_zone, and it gets no PRODUCES EXILE, although the PRODUCES EXILE line says "every exiling".',
].join('\n');

/** Schema v17: the lines that the packets on v17 add to the tagging conventions. */
const V17_LINES = [
  '- PRODUCES SACRIFICE: one atom for every sacrifice that the rules text asks for: in a cost, as a choice, or as an effect. Set cost_type and decision as their descriptions say. An activated ability with a sacrifice in its cost also gets ACTIVATE, as any activated ability does.',
  '- CARES_ABOUT PERMANENT_DIES: "Whenever you sacrifice a ..." gets this type, with cause "sacrifice" and controller "you". That trigger watches for an action and asks for none, so it gets no PRODUCES SACRIFICE. Every other atom of this type has cause "any".',
  '- A text that creates a Role token attached to a creature ("create a Monster Role token attached to target creature") gets ENABLES ATTACH beside PRODUCES CREATE, with the same quote.',
  '- A text that creates a Food token gets PRODUCES SACRIFICE_FODDER beside PRODUCES CREATE, with the same quote and token_type "Food".',
  '- CARES_ABOUT DESCENDED: a clause that checks or counts whether you descended this turn ("if you descended this turn", "the number of times you descended this turn"). It is not CARES_ABOUT POPULATED_GRAVEYARD.',
].join('\n');

export const INSTRUCTIONS = `You extract typed "atoms" from the rules text of Magic: The Gathering cards.

Use ONLY the rules supplied in this packet. Do not rely on anything you remember about the game or about any card. Card names are replaced by "~".

For each atom return:
- face_index: the face the atom comes from.
- family and type_key: exactly one entry from the atom type list.
- params: the parameters that type's schema defines, and no others.
- source: "oracle_text" for an atom read from the card's rules text; "type_line" for an atom that comes only from the type line (its quote must then be "").
- quote: copied character-for-character from that face's rules text exactly as shown here, including any "~". Never paraphrase or change capitalisation.
- rule_numbers: the numbers of the supplied rules that justify the reading, written exactly as they appear in the supplied rules. Cite at least one. Cite the numbered rule that says it, with its letter when it has one - never a bare three-digit section number that only heads a group of rules. Cite only the rules supplied for every card and the sections listed for THIS card - never a rule supplied only for another card, and never one that was not supplied at all. When the rule you would cite is printed in this file only under another card's list, leave it out: cite the rules supplied for this card that justify the reading. If none of them does, give the clause no atom and put it in unjustified_clauses, and name the rule you lacked in the statement.
- confidence: from 0 to 1.

Every ability and mode on the card should be covered by at least one atom. One clause may yield several atoms; give each its own entry with the same quote.

Tagging conventions - apply them the same way on every card:
- ENABLES ACTIVATE: one for every activated ability (written "[Cost]: [Effect]"), in addition to the atoms for its effect. That includes mana abilities ("{T}: Add {G}." gets ACTIVATE and MANA_PRODUCTION), loyalty abilities, level-up lines, and keywords that are activated abilities (Equip, Crew, Craft get ACTIVATE beside their own type). Quote the ability's first sentence, cost included.
- CARES_ABOUT ENTERS_BATTLEFIELD: also for a trigger on the card's OWN entering ("When ~ enters", "When this creature enters"), not only on other permanents entering. Set subject "self", controller "you" and permanent_type to the type the trigger names ("this creature" -> creature, "this artifact" -> artifact); when it names the card by "~" or by a subtype ("this Case", "this Aura"), use the card's type from its type line, creature if it is a creature.
- Making tokens: rules text that says "create" gets PRODUCES CREATE only, with amount set to how many ("a"/"an" is 1; a variable amount such as "X" stays a string), and the token's card types, subtypes and controller as the clause states them. PRODUCES TOKENS is only for text that puts tokens onto the battlefield without the word "create". A token-making keyword action that has its own atom type (for example investigate) gets that type only, not CREATE or TOKENS. In the same way, "mill" gets PRODUCES MILL only, not CARDS_TO_GRAVEYARD.
- Params with a "description": set them as the description says, from the words of the clause and the supplied rules only. Who and which object come from the clause: "this ..." or "~" is self, "another" or "other" is other, "you control" or "your" is you, "an opponent controls" or "opponent's" is opponent.
- A player param (controller, actor, whose) for an action that names no player ("Mill two cards.", "Create a token.", "Exile this Saga."): use "you", because the controller of a spell or ability follows its instructions (the supplied rule on resolving spells and abilities). An object that is "this ..." or "~" has controller "you", and its type is the card's type from its type line (creature if it is a creature), as for ENTERS_BATTLEFIELD.
- A permanent_type for a clause that names only a subtype ("a Detective you control", "for each Elf you control"): use the card type that the supplied subtype rules give that subtype; "any" when they give none. A predefined token ("a Treasure token", "a Clue token"): take token_types and subtypes from its supplied definition rule.
- A subtype_filter: the subtype as the supplied subtype list writes it (singular); "" when the clause names none. "other" and "another" go in subject, not here. ANTHEM subject_filter has no subject param beside it, so it also takes "other": "Other Elf creatures you control" -> "other Elf"; "Creatures you control" -> "".
- When the clause and the rules do not state a value, use "any" (or "", [] or "not_stated" where the type allows it). Never guess a value from what is usual for such cards.
- COMBAT POWER and COMBAT TOUGHNESS: only when the rules text makes a power or toughness value a condition for something to happen ("Creatures you control have total power 8 or greater" -> POWER, value 8). Never for the card's own printed power/toughness, never for a change to power/toughness ("+1/+1", "-2/-0"), never for a limit on which objects are targeted, chosen or counted ("target creature with power 3 or less", "each creature with power greater than its base power"), and never from reminder text.
- CARES_ABOUT PERMANENT_COUNT: when how many permanents of a type are controlled decides an effect or a condition ("for each artifact you control", "You control three or more artifacts.", "X is the number of lands you control"). Not for an effect that merely applies to each of them ("creatures you control get +1/+0"), and not for a cost that taps or sacrifices them.
- CONSTRAINTS TIMING: for a sentence that limits when or how often something can happen ("Activate only as a sorcery.", "This ability triggers only once each turn.", "Do this only once each turn."), quoting that sentence; and on a Craft keyword, which is sorcery-speed. Not on level-up lines.
- PRODUCES EXILE: for every exiling, including a card exiling itself ("Exile this Saga", "Exile ~, then return it transformed"), exiling as part of a cost ("Exile X artifact cards from your graveyard"), a Craft keyword (its cost exiles), and a keyword action whose supplied rule says it exiles (for example airbend, beside its own type).
- ENABLES SOLVED: on each "To solve —" line and on each "Solved —" line of a Case, in addition to the atoms for what that line says.
- CONSTRAINTS TYPE_LINE: only when rules text changes or adds a card type or subtype ("It becomes a 0/0 Bird creature ... in addition to its other types."). Never for the card's own printed type line - not for "Legendary", its card types, or its subtypes.
- Reminder text (in parentheses) only explains the keyword or ability it follows. Give it no atoms of its own and do not read conditions out of it: "Crew 1 (Tap any number of creatures you control with total power 1 or more: ...)" gets CREW and ACTIVATE, not POWER; an Adventure's "(Then exile this card. You may cast the creature later from exile.)" gets nothing.
- "Prepared" ("This creature enters prepared.", "this creature becomes prepared") gets ENABLES PREPARED, not ENABLES CAST.
- COMBAT STAT_CHANGE: a power/toughness change to one creature - "this creature", "target creature", "enchanted creature", "equipped creature" ("Target creature gets +2/+2 until end of turn."). COMBAT ANTHEM stays for a set of creatures ("Creatures you control get +1/+1."). A -N/-N on one creature also gets INTERACTION TARGETED_REMOVAL.
- COMBAT BASE_PT_SET: an effect that sets base power and toughness ("has base power and toughness 4/4", "becomes a ... with base power and toughness 1/1"), for one creature or a set - not STAT_CHANGE and not ANTHEM, which only modify.
- CONSTRAINTS ENTERS_TAPPED: "This land enters tapped." and its conditional forms ("enters tapped unless ..."), with conditional true for those.
- PRODUCES SELF_LIFE_LOSS: "you lose N life"; PRODUCES OPPONENT_LIFE_LOSS is for opponents. "Each player loses N life" gets both PRODUCES SELF_LIFE_LOSS and PRODUCES OPPONENT_LIFE_LOSS, because each player includes you.
- A modal header ("Choose one —", "Choose one or both —") is not an ability of its own: give each mode its atoms, and put the header itself in unclassified with proposed_label MODAL_CHOICE.
- Every sentence of the rules text is checked for coverage on its own. When an ability runs over several sentences ("Look at the top four cards of your library. You may put a creature card from among them into your hand. Put the rest on the bottom of your library in a random order."), each sentence must lie inside some atom's quote or an unclassified entry: give each later sentence atoms of its own, or put it in unclassified.
- Quote one clause per atom, the same way every time: one sentence, one bulleted mode, or one keyword of a keyword line ("Flying, vigilance" gives FLYING the quote "Flying" and VIGILANCE the quote "vigilance"). Never include reminder text in parentheses, and never quote two sentences in one atom. Atoms read from the same sentence share that sentence as their quote.

Two escape hatches - use them instead of guessing:
- unjustified_clauses: a clause you cannot justify from the supplied rules. Give face_index, quote, and a statement of what rule or definition was missing.
- unclassified: a clause no atom type fits. Give face_index, quote, a proposed_label, and a rationale.`;

export function renderSection(s: PacketSection): string {
  return `## ${s.number} ${s.title}\n` + s.rules.map((r) => `${r.number} ${r.text}`).join('\n');
}

/**
 * Gate 4's whitelist: every rule number whose text the packet actually carried. A block
 * rendered whole also covers the numbers that name it - a whole subsection block its
 * subsection number, a whole section block its subsection numbers, a top-level block its
 * section numbers too - because header rows with empty text are dropped from rendering, yet
 * citing them still cites text that was sent. A lettered block covers only itself (Task 7
 * ruling R2's direction).
 */
export function packetRuleNumbers(sections: readonly PacketSection[]): string[] {
  const out = new Set<string>();
  for (const s of sections) {
    out.add(s.number);
    if (s.number.includes('.')) {                 // a subsection or one lettered rule
      for (const r of s.rules) out.add(r.number);
      continue;
    }
    const topLevel = !/^\d{3}$/.test(s.number);
    for (const r of s.rules) {
      out.add(r.number);
      const sub = /^\d+\.\d+/.exec(r.number)?.[0];
      if (sub) out.add(sub);
      const sec = /^\d{3}/.exec(r.number)?.[0];
      if (topLevel && sec) out.add(sec);
    }
  }
  return [...out];
}

export function renderAtomTypes(db: DatabaseSync, schemaVersion: number): string {
  const rows = db.prepare(
    'SELECT family, type_key, label, params_schema FROM atom_types WHERE schema_version = ? ORDER BY family, type_key',
  ).all(schemaVersion) as Array<{ family: string; type_key: string; label: string; params_schema: string }>;
  return rows.map((r) => {
    const spec = JSON.parse(r.params_schema) as { properties?: Record<string, unknown>; required?: string[] };
    const props = spec.properties ?? {};
    // From v15 the packet also lists the required params (v14 packets stay byte-identical).
    const req = schemaVersion >= 15 ? spec.required ?? [] : [];
    const params = Object.keys(props).length
      ? ` params: ${JSON.stringify(props)}${req.length ? ` required: ${JSON.stringify(req)}` : ''}`
      : '';
    return `${r.family} ${r.type_key} - ${r.label}${params}`;
  }).join('\n');
}

interface FaceRow {
  face_index: number;
  mana_cost: string | null;
  type_line: string;
  oracle_text: string;
  power: string | null;
  toughness: string | null;
}

function cardFaces(db: DatabaseSync, oracleId: string): FaceRow[] {
  return db.prepare(
    `SELECT face_index, mana_cost, type_line, oracle_text, power, toughness
       FROM card_faces WHERE oracle_id = ? ORDER BY face_index`,
  ).all(oracleId) as unknown as FaceRow[];
}

export interface PacketParts {
  /** The kernel blocks - the constant part, identical for every card. */
  kernelSections: PacketSection[];
  /** This card's term-reachable blocks that the kernel does not contain. */
  cardSections: PacketSection[];
  /** Matched terms that carry a glossary definition, deduplicated on term + definition. */
  glossaryTerms: MatchedTerm[];
  /** Gate 4's whitelist (packetRuleNumbers of every section sent). */
  packetRules: string[];
}

/**
 * The single split of a scoped packet into what the extraction request sends. The card
 * inspector shows the same parts, so what it displays is what extraction actually used.
 */
export function packetParts(packet: ScopedPacket): PacketParts {
  const kernel = new Set(packet.kernelRules);
  const seen = new Set<string>();
  const glossaryTerms = packet.matchedTerms.filter((m) => {
    if (!m.definition) return false;
    const key = `${m.term}: ${m.definition}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    kernelSections: packet.sections.filter((s) => kernel.has(s.number)),
    cardSections: packet.sections.filter((s) => !kernel.has(s.number)),
    glossaryTerms,
    packetRules: packetRuleNumbers(packet.sections),
  };
}

/**
 * sec. 6.1, for one card: kernel (constant), card-specific rules, glossary, and the
 * name-redacted card record. The batch packet renders the constant parts once.
 */
export function buildCardRequest(
  db: DatabaseSync,
  oracleId: string,
  policy: PacketPolicy,
  names: readonly string[] = redactionNames(db),
): CardRequest {
  const card = db.prepare('SELECT layout FROM cards WHERE oracle_id = ?').get(oracleId) as
    { layout: string } | undefined;
  if (!card) throw new Error(`no card with oracle_id ${oracleId}`);
  const packet = assembleScopedPacket(db, oracleId, policy);
  const parts = packetParts(packet);

  const redactions: CardRequest['redactions'] = [];
  const own = ownShortNames(db, oracleId);
  const faces = cardFaces(db, oracleId).map((f) => {
    const red = redactWithMap(f.oracle_text, names, own);
    redactions.push({ face_index: f.face_index, redactions: red.redactions });
    return [
      `### Face ${f.face_index}`,
      `Type line: ${f.type_line}`,
      f.mana_cost ? `Mana cost: ${f.mana_cost}` : null,
      f.power !== null || f.toughness !== null ? `Power/toughness: ${f.power ?? '-'}/${f.toughness ?? '-'}` : null,
      'Rules text:',
      red.text === '' ? '(none)' : red.text,
    ].filter((l) => l !== null).join('\n');
  });
  return {
    oracleId,
    schemaVersion: currentSchemaVersion(db),
    layout: card.layout,
    kernelSections: parts.kernelSections,
    cardSections: parts.cardSections,
    glossary: parts.glossaryTerms.map((m) => `${m.term}: ${m.definition}`),
    faces,
    packetRules: parts.packetRules,
    packetChars: packet.selectedChars,
    names,
    redactions,
  };
}

// ---------- sec. 6.2-6.4: response validation ----------

export interface ValidationContext {
  runId: number;
  passIndex: number;
  /** The rule numbers the packet actually carried (packetRuleNumbers). */
  packetRules: readonly string[];
  /**
   * Every rule number the whole batch packet showed. A citation outside `packetRules` but
   * inside this set was read off ANOTHER card's sections - still rejected, but under its own
   * reason, because it usually means this card's packet lacks a rule it needs.
   */
  batchRules?: readonly string[];
  /** The redaction list the request was built with. Defaults to redactionNames(db). */
  names?: readonly string[];
}

export interface AtomRow {
  run_id: number;
  oracle_id: string;
  face_index: number;
  schema_version: number;
  family: string;
  type_key: string;
  params_json: string;
  span_start: number;
  span_end: number;
  quote: string;
  span_ambiguous: 0 | 1;
  rule_numbers: string[];
  confidence: number;
  confidence_source: 'model';
  oracle_hash: string;
  pass_index: number;
}

export interface MissingRuleRow {
  run_id: number; oracle_id: string; face_index: number; quote: string; statement: string; oracle_hash: string;
}

export interface UnclassifiedRow {
  run_id: number; oracle_id: string; face_index: number; span_start: number; span_end: number;
  quote: string; proposed_label: string; rationale: string; oracle_hash: string;
}

export interface ValidationResult {
  /** Whose answer this is - persistValidated needs it even when no atom survived. */
  run_id: number;
  oracle_id: string;
  pass_index: number;
  atoms: AtomRow[];
  unclassified: UnclassifiedRow[];
  missingRules: MissingRuleRow[];
  rejected: Array<{ reason: string; atom: unknown }>;
}

export interface ResponseBody {
  atoms: unknown[];
  unjustified_clauses: unknown[];
  unclassified: unknown[];
}

type Parsed = { ok: true; value: ResponseBody } | { ok: false; error: string };

/** Top-level shape only; individual items are judged one by one in validateResponse. */
export function parseExtractionResponse(content: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    return { ok: false, error: `response is not valid JSON: ${(err as Error).message}` };
  }
  return coerceBody(raw);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Schema v16 item M3: the params of a keyword atom with the `move` params of its twin added (an
 * ACTIVATE atom on the same face whose quote contains this quote, or the other way). A param that
 * the keyword atom states stays. Other atoms keep their params.
 */
function withTwinParams(type: string, face: number, quote: unknown, params: Record<string, unknown>, raw: readonly unknown[]): Record<string, unknown> {
  const twins = V16_TWINS.filter((t) => t.keep === type && t.move.length > 0);
  if (!twins.length || typeof quote !== 'string') return params;
  const out = { ...params };
  for (const t of twins) {
    const b = raw.find((x) => isObj(x) && `${x['family']}.${x['type_key']}` === t.drop && x['face_index'] === face
      && typeof x['quote'] === 'string' && (x['quote'].includes(quote) || quote.includes(x['quote'])) && isObj(x['params']));
    if (!b) continue;
    const from = (b as Record<string, unknown>)['params'] as Record<string, unknown>;
    for (const p of t.move) if (!(p in out) && p in from) out[p] = from[p];
  }
  return out;
}

/** The top-level shape of one card's answer, already parsed from JSON. */
export function parseResponseBody(raw: unknown): Parsed {
  return coerceBody(raw);
}

function coerceBody(raw: unknown): Parsed {
  if (!isObj(raw)) return { ok: false, error: 'response is not a JSON object' };
  if (!Array.isArray(raw['atoms'])) return { ok: false, error: 'response has no "atoms" array' };
  for (const k of ['unjustified_clauses', 'unclassified']) {
    if (raw[k] !== undefined && !Array.isArray(raw[k])) return { ok: false, error: `response "${k}" is not an array` };
  }
  return {
    ok: true,
    value: {
      atoms: raw['atoms'],
      unjustified_clauses: (raw['unjustified_clauses'] as unknown[] | undefined) ?? [],
      unclassified: (raw['unclassified'] as unknown[] | undefined) ?? [],
    },
  };
}

/** Every start offset of `quote` in `text`, overlapping hits included. */
function occurrences(text: string, quote: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) out.push(i);
  return out;
}

/**
 * Checks every claim in a model response against data the system already holds (sec. 6.3)
 * and returns the rows that may be persisted. Reads the database, never writes it -
 * persistValidated does that. Gates run cheapest and most decisive first: shape, enum,
 * params, quote, citation. Nothing is dropped silently: every rejection carries its reason,
 * because the rejection rate per run is a quality signal in its own right.
 */
export function validateResponse(
  db: DatabaseSync,
  oracleId: string,
  ctx: ValidationContext,
  raw: unknown,
): ValidationResult {
  const body = coerceBody(raw);
  if (!body.ok) throw new Error(`cannot validate: ${body.error}`);

  const run = db.prepare('SELECT schema_version FROM extraction_runs WHERE id = ?').get(ctx.runId) as
    { schema_version: number } | undefined;
  if (!run) throw new Error(`no extraction_runs row for run_id ${ctx.runId}`);
  const card = db.prepare('SELECT oracle_hash FROM cards WHERE oracle_id = ?').get(oracleId) as
    { oracle_hash: string } | undefined;
  if (!card) throw new Error(`no card with oracle_id ${oracleId}`);

  const names = ctx.names ?? redactionNames(db);
  const original = new Map(cardFaces(db, oracleId).map((f) => [f.face_index, f.oracle_text]));
  const own = ownShortNames(db, oracleId);
  const redacted = new Map([...original].map(([i, t]) => [i, redactWithMap(t, names, own)]));
  const packet = new Set(ctx.packetRules);
  const batch = new Set(ctx.batchRules ?? []);
  const typeExists = db.prepare(
    'SELECT 1 FROM atom_types WHERE schema_version = ? AND family = ? AND type_key = ?',
  );

  const result: ValidationResult = {
    run_id: ctx.runId, oracle_id: oracleId, pass_index: ctx.passIndex,
    atoms: [], unclassified: [], missingRules: [], rejected: [],
  };
  const reject = (reason: string, item: unknown) => result.rejected.push({ reason, atom: item });

  // sec. 6.2 claiming. One map per call = one map per (run_id, pass_index): a pass is one
  // response, so voting passes can never consume each other's occurrences.
  const claims = new Map<string, number>();
  /** Resolves a quote seen in the REDACTED face text to a span of the original text. */
  const resolve = (faceIndex: number, quote: string, claim: boolean):
    { start: number; end: number; ambiguous: 0 | 1 } | null => {
    const red = redacted.get(faceIndex)!;
    const hits = occurrences(red.text, quote);
    if (hits.length === 0) return null;
    let at = hits[0]!;
    let ambiguous: 0 | 1 = 0;
    if (hits.length > 1 && claim) {
      const key = `${faceIndex}:${quote}`;
      const next = claims.get(key) ?? 0;
      claims.set(key, next + 1);
      if (next < hits.length) at = hits[next]!;
      else { at = hits[hits.length - 1]!; ambiguous = 1; }
    }
    return { ...unredactSpan(red.redactions, at, at + quote.length), ambiguous };
  };

  for (const a of body.value.atoms) {
    // shape
    if (!isObj(a)) { reject('shape: atom is not an object', a); continue; }
    const { face_index, family, type_key, params, quote, rule_numbers, confidence } = a;
    if (!Number.isInteger(face_index) || typeof family !== 'string' || typeof type_key !== 'string' ||
        typeof quote !== 'string' || !Array.isArray(rule_numbers) ||
        !rule_numbers.every((n) => typeof n === 'string') ||
        typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
      reject('shape: an atom needs face_index, family, type_key, params, quote, rule_numbers[] and confidence in 0..1', a);
      continue;
    }
    const typeLine = a['source'] === 'type_line';

    // gate 1 - enum
    if (!typeExists.get(run.schema_version, family, type_key)) {
      reject(`type: ${family}.${type_key} is not in the enum at schema v${run.schema_version}`, a);
      continue;
    }
    // Schema v16 item M3: a keyword atom takes the cost params that it does not state from its
    // ACTIVATE twin on the same face (one quote contains the other), before the params check.
    const own = run.schema_version >= 16 && isObj(params) ? withTwinParams(`${family}.${type_key}`, face_index as number, quote, params, body.value.atoms) : params;
    // gate 2 - params. The type_line marker is added after this check, so it is never
    // mistaken for one of the type's own parameters.
    const checked = validateAtomParams(db, run.schema_version, family, type_key, own);
    if (!checked.ok) { reject(`params: ${checked.error}`, a); continue; }

    // gate 3 - span
    const face = face_index as number;
    if (!original.has(face)) { reject(`quote: the card has no face ${face}`, a); continue; }
    let span: { start: number; end: number; ambiguous: 0 | 1 };
    if (typeLine) {
      // sec. 7.3: type-line atoms have nothing to quote. The exemption is narrow - empty
      // quote, span 0..0, params.source marker - and never covers a quote that fails to resolve.
      if (quote !== '') { reject('quote: a type_line atom must carry an empty quote', a); continue; }
      span = { start: 0, end: 0, ambiguous: 0 };
    } else {
      const hit = quote === '' ? null : resolve(face, quote, true);
      if (!hit) { reject(`quote: not found verbatim in face ${face}'s text`, a); continue; }
      span = hit;
    }

    // gate 4 - citation, the I1 signature
    if (rule_numbers.length === 0) { reject('citation: the atom cites no rule', a); continue; }
    const outside = (rule_numbers as string[]).filter((n) => !packet.has(n));
    if (outside.length) {
      reject(outside.every((n) => batch.has(n))
        ? `cross_card_citation: ${outside.join(', ')} was supplied only for another card in the batch`
        : `citation: ${outside.join(', ')} not in the packet that was sent`, a);
      continue;
    }

    result.atoms.push({
      run_id: ctx.runId,
      oracle_id: oracleId,
      face_index: face,
      schema_version: run.schema_version,
      family,
      type_key,
      params_json: JSON.stringify(typeLine ? { ...(own as object), source: 'type_line' } : own),
      span_start: span.start,
      span_end: span.end,
      quote: original.get(face)!.slice(span.start, span.end),
      span_ambiguous: span.ambiguous,
      rule_numbers: [...new Set(rule_numbers as string[])],
      confidence,
      confidence_source: 'model',
      oracle_hash: card.oracle_hash,
      pass_index: ctx.passIndex,
    });
  }

  // Schema v15 item V9: a generic twin (TOKENS, CARDS_TO_GRAVEYARD) whose span overlaps the keyword
  // atom (CREATE, MILL) on the same face is the same fact. Keep the keyword atom.
  if (run.schema_version >= 15) {
    const id = (a: AtomRow) => `${a.family}.${a.type_key}`;
    const overlaps = (a: AtomRow, b: AtomRow) =>
      a.face_index === b.face_index && a.span_start < b.span_end && b.span_start < a.span_end;
    result.atoms = result.atoms.filter((a) => {
      const twin = V9_TWINS.find((t) => t.drop === id(a));
      if (!twin) return true;
      const keeper = result.atoms.find((b) => id(b) === twin.keep && overlaps(a, b));
      if (!keeper) return true;
      reject(`twin: ${twin.drop} has the same span as ${twin.keep} (schema v15 item V9); the keyword atom is kept`, a);
      return false;
    });
  }
  // Schema v16 items M3 and M4: a keyword activated ability and an ACTIVATE atom, or a Cycling and a
  // Discard atom, on the same text are one fact. Keep the keyword atom; it takes the params of the
  // twin (M3: the cost params) that it does not state itself.
  if (run.schema_version >= 16) {
    const id = (a: AtomRow) => `${a.family}.${a.type_key}`;
    const overlaps = (a: AtomRow, b: AtomRow) =>
      a.face_index === b.face_index && a.span_start < b.span_end && b.span_start < a.span_end;
    result.atoms = result.atoms.filter((a) => {
      const keeper = result.atoms.find((b) => overlaps(a, b) && V16_TWINS.some((t) => t.drop === id(a) && t.keep === id(b)));
      if (!keeper) return true;
      const twin = V16_TWINS.find((t) => t.drop === id(a) && t.keep === id(keeper))!;
      const from = JSON.parse(a.params_json) as Record<string, unknown>;
      const to = JSON.parse(keeper.params_json) as Record<string, unknown>;
      for (const p of twin.move) if (!(p in to) && p in from) to[p] = from[p];
      keeper.params_json = JSON.stringify(to);
      reject(`twin: ${twin.drop} has the same span as ${twin.keep} (schema v16 item ${twin.item}); the keyword atom is kept`, a);
      return false;
    });
  }
  // Spec sec. 25.8: "would die this turn, exile it instead" is PRODUCES.EXILE alone. A run gave both
  // readings of this text, so the words decide here, and not the model.
  if (run.schema_version >= 20) {
    result.atoms = result.atoms.filter((a) => {
      if (!isWouldDieRider(a)) return true;
      reject('would die: CARES_ABOUT.PERMANENT_DIES on "would die this turn, exile it instead" (spec sec. 25.8)', a);
      return false;
    });
  }

  for (const u of body.value.unjustified_clauses) {
    if (!isObj(u) || !Number.isInteger(u['face_index']) || typeof u['quote'] !== 'string' ||
        typeof u['statement'] !== 'string' || u['statement'].trim() === '') {
      reject('shape: an unjustified clause needs face_index, quote and a statement', u);
      continue;
    }
    const face = u['face_index'] as number;
    if (!original.has(face)) { reject(`missing-rule report: the card has no face ${face}`, u); continue; }
    // Kept even when the quote does not resolve: the statement is the payload, and dropping
    // it would silence the only channel that exposes a packet-policy hole (sec. 6.4).
    const hit = u['quote'] === '' ? null : resolve(face, u['quote'], false);
    result.missingRules.push({
      run_id: ctx.runId, oracle_id: oracleId, face_index: face,
      quote: hit ? original.get(face)!.slice(hit.start, hit.end) : u['quote'],
      statement: u['statement'], oracle_hash: card.oracle_hash,
    });
  }

  for (const u of body.value.unclassified) {
    if (!isObj(u) || !Number.isInteger(u['face_index']) || typeof u['quote'] !== 'string' ||
        typeof u['proposed_label'] !== 'string' || typeof u['rationale'] !== 'string') {
      reject('shape: an unclassified clause needs face_index, quote, proposed_label and rationale', u);
      continue;
    }
    const face = u['face_index'] as number;
    const hit = original.has(face) && u['quote'] !== '' ? resolve(face, u['quote'], false) : null;
    if (!hit) { reject(`unclassified: quote not found verbatim in face ${face}'s text`, u); continue; }
    result.unclassified.push({
      run_id: ctx.runId, oracle_id: oracleId, face_index: face, span_start: hit.start, span_end: hit.end,
      quote: original.get(face)!.slice(hit.start, hit.end),
      proposed_label: u['proposed_label'], rationale: u['rationale'], oracle_hash: card.oracle_hash,
    });
  }
  return result;
}

/**
 * Writes one validated response - atoms, missing-rule reports, unclassified - atomically.
 * A savepoint, not BEGIN, so a batch submission can wrap many cards in one transaction.
 *
 * sec. 10.3: a first pass REPLACES the card's live atom set - every other run's current atoms
 * are demoted in the same savepoint the new ones are inserted in, so a crash leaves either
 * the old set or the new one, never zero and never two. A voting pass (pass_index > 0) is
 * audit material until reconcileVotes decides: it lands at consensus 0, is_current 0.
 */
export function persistValidated(db: DatabaseSync, r: ValidationResult): void {
  db.exec('SAVEPOINT persist_validated');
  try {
    const first = r.pass_index === 0 ? 1 : 0;
    if (first) {
      db.prepare('UPDATE atoms SET is_current = 0 WHERE oracle_id = ? AND run_id <> ? AND is_current = 1')
        .run(r.oracle_id, r.run_id);
    }
    const atom = db.prepare(
      `INSERT INTO atoms (run_id, oracle_id, face_index, schema_version, family, type_key, params_json,
         span_start, span_end, quote, span_ambiguous, rule_numbers, confidence, confidence_source,
         oracle_hash, pass_index, consensus, is_current)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const a of r.atoms) {
      atom.run(a.run_id, a.oracle_id, a.face_index, a.schema_version, a.family, a.type_key, a.params_json,
        a.span_start, a.span_end, a.quote, a.span_ambiguous, JSON.stringify(a.rule_numbers), a.confidence,
        a.confidence_source, a.oracle_hash, a.pass_index, first, first);
    }
    const missing = db.prepare(
      `INSERT INTO missing_rule_reports (run_id, oracle_id, face_index, quote, statement, oracle_hash)
       VALUES (?,?,?,?,?,?)`,
    );
    for (const m of r.missingRules) {
      missing.run(m.run_id, m.oracle_id, m.face_index, m.quote, m.statement, m.oracle_hash);
    }
    const unclassified = db.prepare(
      `INSERT INTO unclassified_clauses (run_id, oracle_id, face_index, span_start, span_end, quote,
         proposed_label, rationale, oracle_hash)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    for (const u of r.unclassified) {
      unclassified.run(u.run_id, u.oracle_id, u.face_index, u.span_start, u.span_end, u.quote,
        u.proposed_label, u.rationale, u.oracle_hash);
    }
    db.exec('RELEASE persist_validated');
  } catch (err) {
    db.exec('ROLLBACK TO persist_validated');
    db.exec('RELEASE persist_validated');
    throw err;
  }
}

// ---------- the failure-mode table ----------

/**
 * A card whose answer could not be validated at all (unparseable response, card missing from
 * it, text changed since the packet was written). Recorded `failed` with the reason and the
 * raw material for diagnosis; its queue row is left alone, so it stays pending and a later
 * batch picks it up. No provider-measured tokens exist (sec. 7.1 amendment), so 0.
 */
export function recordFailedCard(
  db: DatabaseSync,
  runId: number,
  oracleId: string,
  packetChars: number,
  detail: string,
): void {
  db.prepare(
    `INSERT INTO extraction_results (run_id, oracle_id, coverage_ratio, uncovered_clauses_json, passes_run,
       vote_agreement, connective_atom_count, packet_chars, packet_tokens, outcome, failure_detail)
     VALUES (?,?,0,'[]',1,NULL,0,?,0,'failed',?)
     ON CONFLICT(run_id, oracle_id) DO UPDATE SET outcome = 'failed', failure_detail = excluded.failure_detail`,
  ).run(runId, oracleId, packetChars, detail.slice(0, 4000));
}
