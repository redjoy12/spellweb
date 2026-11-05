/**
 * Regenerates config/atom-schema.json from its two authored sources (concept spec sec. 4.1,
 * and the CR 701/702 keyword titles already parsed into the database - see sec. 4.2). Nothing
 * in the CR-derived section is hand-typed: type_key, label, provenance and the quoted half of
 * evidence all come straight out of `rules`, so re-running this after a `sync:rules` re-parse
 * reproduces the same file (modulo upstream CR text changes) instead of drifting from it.
 *
 * Run with: npm run generate:atom-schema
 *
 * Committed per Task 2 fix-pass review: a 261-entry config that can't be regenerated is a
 * weak link (see .superpowers/sdd/task-2-report.md, "Fix pass 1"). This file IS the audit
 * trail for every cr_701/cr_702 entry's family - the JSON is its checked-in output, not a
 * hand-maintained artifact.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../db/client.js';
import {
  chooseSchemaVersion, currentSchemaVersion, loadAtomSchema, mergePromoted, persistAtomSchema, promotedTypes,
} from '../atoms/schema.js';
import type { AtomFamily, AtomSchema, AtomTypeDef } from '../atoms/schema.js';
import { applyV15, zonesFrom400_1 } from '../atoms/schemaV15.js';
import type { V15Enums } from '../atoms/schemaV15.js';
import { applyV16 } from '../atoms/schemaV16.js';
import { applyV17 } from '../atoms/schemaV17.js';
import { applyV18 } from '../atoms/schemaV18.js';
import { applyV19 } from '../atoms/schemaV19.js';
import { applyV20 } from '../atoms/schemaV20.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(here, '../../config/atom-schema.json');
const SCHEMA_VERSION = 2; // sec. 4.3 promotion - see SUBJECT_IS_A_PARAM below. v1 is frozen: 420
                          // golden_atoms rows consume it, so v2 is a new version, not an edit.
                          // Since Task 9 this is a FLOOR: the published version is chosen by
                          // chooseSchemaVersion, because review promotions also publish versions.

const EMPTY_PARAMS = { type: 'object', properties: {}, additionalProperties: false } as const;

function amountParams(prop: string, extra?: Record<string, unknown>) {
  return {
    type: 'object',
    properties: { [prop]: { type: ['integer', 'string'] }, ...extra },
    required: [prop, ...(extra ? Object.keys(extra) : [])],
    additionalProperties: false,
  };
}

/**
 * SUBJECT_IS_A_PARAM (schema v2)
 * ------------------------------
 * The SUBJECT of an atom - which kind of object the atom is about - is a PARAMETER, never part
 * of the `type_key`. Controller was already a param on every CARES_ABOUT event type at v1; at v2
 * the object's type joins it.
 *
 * Why: sec. 4.1 requires a CLOSED enum precisely so that a Phase 3 edge matching a PRODUCES type
 * on one card against a CARES_ABOUT type on another cannot miss - "An open vocabulary would let
 * `TOKEN` and `CREATURE_TOKEN` fail to match silently, which is the invisible-defect failure the
 * parent spec's gates exist to prevent." Baking the subject into the name reintroduces exactly
 * that: v1's CARES_ABOUT.CREATURE_DEATH welded "creature" into the key, so an artifact-dies
 * trigger had no type at all and the golden set coined ARTIFACT_PUT_INTO_GRAVEYARD beside
 * LEAVES_THE_BATTLEFIELD - two names for one CR 603.6c mechanism, differing only in subject.
 * Naming the subject also does not close: permanent type x controller x zone is combinatorial,
 * and nothing tells a later drafter which combinations already have names.
 *
 * The enums below are read from the corpus at generation time, not typed here, so that this file
 * stays what its header claims - generated output, not hand-maintained data.
 */
const CONTROLLER = { enum: ['you', 'opponent', 'any'] } as const;

/**
 * Splits a CR type enumeration ("an artifact, battle, creature, ..., or planeswalker card") into
 * bare lowercase type words. Written once because 110.4a and 205.2a use the same prose form, and
 * because a silently mis-split token (an early draft of this produced "orplaneswalkercard") would
 * become an enum value no drafter could ever satisfy and no validator would ever reject.
 */
function splitTypeList(prose: string): string[] {
  return prose
    .split(/,\s*|\s+(?:or|and)\s+/)
    .map((w) =>
      w
        .trim()
        .replace(/^(?:an?|the|or|and)\s+/i, '')
        .replace(/\s+cards?\.?$/i, '')
        .replace(/[^a-z]/gi, '')
        .toLowerCase(),
    )
    .filter(Boolean);
}

/** Permanent card types, parsed from CR 110.4a. `any` is added for a subject-agnostic clause. */
function permanentTypeEnum(db: DatabaseSync, corpusId: number): string[] {
  const text = ruleText(db, corpusId, '110.4a');
  // "Specifically, it means an artifact, battle, creature, enchantment, land, or planeswalker card."
  const tail = text.split('Specifically, it means')[1];
  if (!tail) throw new Error('CR 110.4a no longer contains "Specifically, it means" - fix permanentTypeEnum');
  const types = splitTypeList(tail);
  if (types.length < 6) throw new Error(`CR 110.4a parsed to ${types.length} permanent types - fix permanentTypeEnum`);
  return [...types, 'any'];
}

/** All card types, parsed from CR 205.2a. Used for spell-cast subjects, which are not permanents. */
function cardTypeEnum(db: DatabaseSync, corpusId: number): string[] {
  const text = ruleText(db, corpusId, '205.2a');
  const tail = text.split('The card types are')[1];
  if (!tail) throw new Error('CR 205.2a no longer contains "The card types are" - fix cardTypeEnum');
  const types = splitTypeList(tail.split('.')[0] ?? '');
  if (types.length < 15) throw new Error(`CR 205.2a parsed to ${types.length} card types - fix cardTypeEnum`);
  return types;
}

function ruleText(db: DatabaseSync, corpusId: number, number: string): string {
  const row = db
    .prepare('SELECT text FROM rules WHERE corpus_id = ? AND number = ?')
    .get(corpusId, number) as { text: string } | undefined;
  if (!row) throw new Error(`CR ${number} not in the current corpus - cannot derive a subject enum from it`);
  return row.text.replace(/\s+/g, ' ').trim();
}

/** A subject-carrying params_schema: `permanent_type` plus the controller axis already in use. */
function subjectParams(permanentTypes: string[], extra: Record<string, unknown> = {}, required: string[] = []) {
  return {
    type: 'object',
    properties: { permanent_type: { enum: permanentTypes }, controller: CONTROLLER, ...extra },
    required: ['permanent_type', 'controller', ...required],
    additionalProperties: false,
  };
}

function typeKeyFromTitle(title: string): string {
  // .replace at the end trims stray leading/trailing underscores left by titles with a leading
  // symbol or trailing punctuation ("∞ (Infinity)", "For Mirrodin!", "Start Your Engines!" -
  // all three are real CR 702 titles, verified against the live corpus before writing this).
  return title.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * A short, reproducible quote of a rule's text for `evidence`. Several CR keyword-action
 * definitions are one sentence that itself contains an internal period (e.g. 701.39 Bolster:
 * `"Bolster N" means "Choose a creature ... control. Put N +1/+1 counters on that creature."`)
 * where the deciding clause is the SECOND clause - so this returns the whole text untruncated
 * whenever it fits the budget, rather than cutting at the first '.' and silently dropping the
 * clause that actually justified the family. Only text that doesn't fit gets cut, and then at
 * the latest sentence boundary within budget so as not to sever the deciding clause mid-word.
 */
function firstSentence(text: string, maxLen = 260): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxLen) return trimmed;
  const slice = trimmed.slice(0, maxLen);
  const lastStop = slice.lastIndexOf('. ');
  if (lastStop > maxLen * 0.4) return slice.slice(0, lastStop + 1);
  return slice.trimEnd() + '…';
}

/**
 * Like `firstSentence`, but for a row that was selected BECAUSE it matches `rx` (the 702
 * combat-text rule) somewhere in it: the matching clause is sometimes late in a long rule (e.g.
 * 702.124d Partner mentions "combat damage" only in its final sentence), and truncating from
 * the start at a fixed budget can silently print a quote that doesn't contain the word that
 * actually decided the classification. This finds the sentence that matches and quotes that one
 * instead, falling back to `firstSentence` only if no single sentence contains the match (e.g.
 * the match spans a sentence boundary).
 */
function sentenceContaining(text: string, rx: RegExp, maxLen = 260): string {
  const sentences = text.trim().replace(/\s+/g, ' ').split(/(?<=\.)\s+/);
  const hit = sentences.find((s) => rx.test(s));
  if (!hit) return firstSentence(text, maxLen);
  return hit.length > maxLen ? hit.slice(0, maxLen - 1).trimEnd() + '…' : hit;
}

function currentCorpusId(db: DatabaseSync): number {
  const row = db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as
    | { id: number }
    | undefined;
  if (!row) throw new Error('no current rules corpus - run `npm run sync:rules` first');
  return row.id;
}

function titledSubsections(
  db: DatabaseSync,
  corpusId: number,
  sectionNumber: string,
): Array<{ subsection_number: string; subsection_title: string }> {
  return db
    .prepare(
      `SELECT DISTINCT subsection_number, subsection_title FROM rules
        WHERE corpus_id = ? AND section_number = ? AND subsection_title IS NOT NULL
        ORDER BY CAST(SUBSTR(subsection_number, 5) AS INTEGER)`, // note: '701'/'702' are parameters, not literals in this file; src/cli is outside I2's scanned set (tests/invariants.test.ts only walks src/rules, src/atoms and config), so no i2-ok marker is needed or checked here
    )
    .all(corpusId, sectionNumber) as Array<{ subsection_number: string; subsection_title: string }>;
}

// ============================================================================================
// sec. 4.1 hand-authored entries
// ============================================================================================
// Every entry names the exact concept-spec sec. 4.1 line it derives from
// (docs/superpowers/specs/2026-07-24-mtga-synergy-deck-builder-design.md sec. 4.1). Six sec. 4.1
// content phrases (flying, menace, trample, haste, proliferate, protection) are deliberately NOT
// authored here: a literal CR 701/702 keyword title already realizes that exact concept 1:1, and
// that generated entry's evidence cites both sources - see FOUR_ONE_TIES_702/FOUR_ONE_TIES_701
// below. Authoring a second type for the same concept would just be a same-meaning duplicate
// under a different type_key.
function specTypes(db: DatabaseSync, corpusId: number): AtomTypeDef[] {
  const PERMANENT_TYPES = permanentTypeEnum(db, corpusId);
  const CARD_TYPES = cardTypeEnum(db, corpusId);
  return [
  // ---- PRODUCES (9 of 9 sec. 4.1 contents; was 7 of 9 - see Task 2 fix pass, finding 6) ----
  {
    family: 'PRODUCES',
    type_key: 'COUNTER_PRODUCTION',
    label: 'Produces +1/+1 (or other) counters',
    params_schema: {
      type: 'object',
      properties: { counter_type: { enum: ['+1/+1', '-1/-1', 'other'] }, amount: { type: ['integer', 'string'] } },
      required: ['counter_type', 'amount'],
      additionalProperties: false,
    },
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, PRODUCES: '+1/+1 counters'",
  },
  {
    family: 'PRODUCES',
    type_key: 'TOKENS',
    label: 'Produces tokens (generic, not tied to a named keyword action)',
    params_schema: amountParams('amount'),
    provenance: 'spec_4_1',
    evidence:
      "concept spec sec. 4.1, PRODUCES: 'tokens'; authored as its own type separate from the " +
      'CR 701 keyword-action entries CREATE/POPULATE/AMASS/INCUBATE/INVESTIGATE (each of which ' +
      'also produces tokens, but only matches a card that uses that specific named keyword) ' +
      "because a card can read \"create a 1/1 token\" or similar plain rules text without using " +
      'any of those keyword names - Task 2 fix pass, finding 6',
  },
  {
    family: 'PRODUCES',
    type_key: 'LIFEGAIN',
    label: 'Gains life',
    params_schema: amountParams('amount'),
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, PRODUCES: 'lifegain events'",
  },
  {
    family: 'PRODUCES',
    type_key: 'MANA_PRODUCTION',
    label: 'Produces mana by colour',
    params_schema: { type: 'object', properties: { color: { enum: ['W', 'U', 'B', 'R', 'G', 'C', 'any'] } }, required: ['color'], additionalProperties: false },
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, PRODUCES: 'mana by colour'",
  },
  {
    family: 'PRODUCES',
    type_key: 'CARD_DRAW',
    label: 'Draws cards',
    params_schema: amountParams('amount'),
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, PRODUCES: 'card draw'",
  },
  {
    family: 'PRODUCES',
    type_key: 'DAMAGE',
    label: 'Deals damage',
    params_schema: amountParams('amount'),
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, PRODUCES: 'damage'",
  },
  {
    family: 'PRODUCES',
    type_key: 'CARDS_TO_GRAVEYARD',
    label: 'Puts cards into a graveyard (generic, not tied to a named keyword action)',
    params_schema: amountParams('amount'),
    provenance: 'spec_4_1',
    evidence:
      "concept spec sec. 4.1, PRODUCES: 'cards into graveyard'; authored as its own type separate " +
      'from the CR 701 keyword-action entries MILL/SURVEIL/MANIFEST_DREAD (each of which also ' +
      'puts cards into a graveyard, but only matches a card that uses that specific named ' +
      'keyword) because a card can read "put the top three cards of your library into your ' +
      'graveyard" or similar plain rules text without using any of those keyword names - Task 2 ' +
      'fix pass, finding 6',
  },
  {
    family: 'PRODUCES',
    type_key: 'SACRIFICE_FODDER',
    label: 'Creates a permanent intended to be sacrificed',
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, PRODUCES: 'sacrifice fodder'",
  },
  {
    family: 'PRODUCES',
    type_key: 'OPPONENT_LIFE_LOSS',
    label: 'Opponent loses life',
    params_schema: amountParams('amount'),
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, PRODUCES: 'opponent life loss'",
  },

  // ---- CARES_ABOUT ----
  {
    family: 'CARES_ABOUT',
    type_key: 'PERMANENT_DIES',
    label: 'Cares about a permanent dying',
    params_schema: subjectParams(PERMANENT_TYPES),
    provenance: 'spec_4_1',
    evidence:
      "concept spec sec. 4.1, CARES_ABOUT: 'on-creature-death'; v2 SUBJECT_IS_A_PARAM - v1 spelled " +
      'this CREATURE_DEATH, welding the subject into the type_key so that a clause about any other ' +
      'permanent dying had no type at all. CR 700.4 defines the term for every permanent: "The term ' +
      "dies means 'is put into a graveyard from the battlefield.'\" - the creature restriction was " +
      "the spec line's example, not the rule. The subject moves to `permanent_type`.",
  },
  {
    family: 'CARES_ABOUT',
    type_key: 'LIFEGAIN',
    label: 'Cares about gaining life',
    params_schema: { type: 'object', properties: { controller: { enum: ['you', 'opponent', 'any'] } }, required: ['controller'], additionalProperties: false },
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, CARES_ABOUT: 'on-lifegain'",
  },
  {
    family: 'CARES_ABOUT',
    type_key: 'PERMANENT_COUNT',
    label: 'Counts permanents of a type',
    params_schema: subjectParams(PERMANENT_TYPES),
    provenance: 'spec_4_1',
    evidence:
      "concept spec sec. 4.1, CARES_ABOUT: 'counts artifacts'; v2 SUBJECT_IS_A_PARAM - v1 spelled " +
      'this ARTIFACT_COUNT with the subject in the type_key and EMPTY_PARAMS, so it could record ' +
      'neither which permanent type was counted nor whose. Both axes are now params; the golden ' +
      'set already needed the same shape for CREATURE_TYPE_COUNT and LAND_COUNT.',
  },
  {
    family: 'CARES_ABOUT',
    type_key: 'ENTERS_BATTLEFIELD',
    label: 'Cares about a permanent entering the battlefield',
    params_schema: {
      type: 'object',
      properties: { controller: CONTROLLER, permanent_type: { enum: PERMANENT_TYPES } },
      required: ['controller'],
      additionalProperties: false,
    },
    provenance: 'spec_4_1',
    evidence:
      "concept spec sec. 4.1, CARES_ABOUT: 'on-ETB'; v2 SUBJECT_IS_A_PARAM - the label already said " +
      '"a permanent" but the v1 params could not say WHICH, so every ETB trigger produced an ' +
      'identical atom. `permanent_type` is OPTIONAL here and only for that reason: 27 already- ' +
      'adjudicated golden cards hold v1 ETB atoms with no subject recorded, and requiring it would ' +
      'retire their reading rather than extend it. Drafts from v2 onward must set it - see ' +
      'docs/golden-set-procedure.md, "Subject is a parameter". Flip it to required once the ' +
      'back-catalogue carries it.',
  },
  {
    family: 'CARES_ABOUT',
    type_key: 'LEAVES_BATTLEFIELD',
    label: 'Cares about a permanent leaving the battlefield',
    params_schema: subjectParams(PERMANENT_TYPES),
    provenance: 'review_promoted',
    evidence:
      'sec. 4.3 promotion from unclassified_clauses. CR 603.6c: "Leaves-the-battlefield abilities ' +
      'trigger when a permanent moves from the battlefield to another zone ... written as, but ' +
      "aren't limited to, 'When [this object] leaves the battlefield, . . .' or 'Whenever " +
      "[something] is put into a graveyard from the battlefield, . . . .'\" Strictly broader than " +
      'dying (700.4), so PERMANENT_DIES cannot stand in for it. The golden set recorded this gap ' +
      'six times under two names - LEAVES_THE_BATTLEFIELD (3x) and ARTIFACT_PUT_INTO_GRAVEYARD ' +
      '(1x), which cite the same rule and differ only in subject - which is what proved the ' +
      'subject belongs in a param.',
  },
  {
    family: 'CARES_ABOUT',
    type_key: 'ATTACKS',
    label: 'Cares about a creature attacking',
    params_schema: { type: 'object', properties: { controller: { enum: ['you', 'opponent', 'any'] } }, required: ['controller'], additionalProperties: false },
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, CARES_ABOUT: 'on-attack'",
  },
  {
    family: 'CARES_ABOUT',
    type_key: 'SPELL_CAST',
    label: 'Cares about a spell being cast',
    params_schema: {
      type: 'object',
      properties: {
        controller: CONTROLLER,
        card_types: { type: 'array', items: { enum: CARD_TYPES } },
        excluded_card_types: { type: 'array', items: { enum: CARD_TYPES } },
      },
      required: ['controller', 'card_types', 'excluded_card_types'],
      additionalProperties: false,
    },
    provenance: 'spec_4_1',
    evidence:
      "concept spec sec. 4.1, CARES_ABOUT: 'on-noncreature-spell-cast'; v2 SUBJECT_IS_A_PARAM - v1 " +
      'spelled this NONCREATURE_SPELL_CAST, welding a NEGATIVE subject filter into the type_key. ' +
      'The golden set then had to coin SPELL_CAST_ANY_TYPE, CREATURE_SPELL_CAST and ' +
      'SPELL_CAST_ANY_TYPE_WITH_MANA_VALUE_THRESHOLD beside it, all giving the same reason: the ' +
      'only cast type asserts a restriction the clause does not have. Both filters are now params ' +
      'and both are REQUIRED - an empty array is the explicit "no restriction" reading, so a ' +
      'drafter cannot leave the distinction unstated. Card types are CR 205.2a.',
  },
  {
    family: 'CARES_ABOUT',
    type_key: 'POPULATED_GRAVEYARD',
    label: 'Requires a populated graveyard',
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, CARES_ABOUT: 'requires-populated-graveyard'",
  },

  // ---- ENABLES ----
  {
    family: 'ENABLES',
    type_key: 'SACRIFICE_OUTLET',
    label: 'Sacrifice outlet (free or costed)',
    params_schema: { type: 'object', properties: { cost_type: { enum: ['free', 'costed'] } }, required: ['cost_type'], additionalProperties: false },
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, ENABLES: 'sacrifice outlet (free vs costed)'",
  },
  {
    family: 'ENABLES',
    type_key: 'UNTAPPER',
    label: 'Untaps a permanent',
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, ENABLES: 'untapper'",
  },
  {
    family: 'ENABLES',
    type_key: 'RECURSION',
    label: 'Returns a card from the graveyard',
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, ENABLES: 'recursion'",
  },
  {
    family: 'ENABLES',
    type_key: 'COST_REDUCTION',
    label: 'Reduces a cost',
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, ENABLES: 'cost reduction'",
  },
  {
    family: 'ENABLES',
    type_key: 'TUTOR',
    label: 'Searches for a specific card',
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, ENABLES: 'tutor'",
  },
  {
    family: 'ENABLES',
    type_key: 'HASTE_GRANT',
    label: 'Grants haste to another permanent',
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, ENABLES: 'haste grant'",
  },

  // ---- COMBAT ----
  {
    family: 'COMBAT',
    type_key: 'POWER',
    label: 'Has a power characteristic',
    params_schema: { type: 'object', properties: { value: { type: ['integer', 'string'] } }, required: ['value'], additionalProperties: false },
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, COMBAT: 'power'",
  },
  {
    family: 'COMBAT',
    type_key: 'TOUGHNESS',
    label: 'Has a toughness characteristic',
    params_schema: { type: 'object', properties: { value: { type: ['integer', 'string'] } }, required: ['value'], additionalProperties: false },
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, COMBAT: 'toughness'",
  },
  {
    family: 'COMBAT',
    type_key: 'UNBLOCKABLE',
    label: "Can't be blocked",
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence:
      "concept spec sec. 4.1, COMBAT: 'evasion class (flying / menace / trample / unblockable)'; " +
      'flying, menace and trample are realized by their own CR 702-derived types (see evidence ' +
      'there), unblockable has no titled CR keyword ability (verified: no 702 title matches ' +
      '/block/i) and is authored directly',
  },
  {
    family: 'COMBAT',
    type_key: 'ANTHEM',
    label: 'Anthem effect (stat boost over a set of creatures)',
    params_schema: {
      type: 'object',
      properties: {
        subject_type: { enum: PERMANENT_TYPES },
        subject_filter: { type: 'string' },
        controller: CONTROLLER,
        duration: { enum: ['static', 'end_of_turn', 'other'] },
      },
      required: [],
      additionalProperties: false,
    },
    provenance: 'spec_4_1',
    evidence:
      "concept spec sec. 4.1, COMBAT: 'anthem effects'; v2 SUBJECT_IS_A_PARAM - v1 carried " +
      'EMPTY_PARAMS with additionalProperties:false, so an ANTHEM atom could record nothing at ' +
      'all: a permanent "Creatures you control get +1/+1" and a one-shot "Wizards you control get ' +
      '+1/+0 until end of turn" produced byte-identical atoms. The golden set logged that hole ' +
      'three ways - ANTHEM_DURATION (4x), CREATURE_TYPE_FILTER (3x), ATTACKING_CREATURES_ONLY ' +
      '(1x) - which is the same defect as the CARES_ABOUT subject, one layer down. Params are ' +
      'OPTIONAL only because 12 already-adjudicated golden cards hold v1 ANTHEM atoms with {}; ' +
      'drafts from v2 onward must set subject_type and duration.',
  },

  // ---- INTERACTION ----
  {
    family: 'INTERACTION',
    type_key: 'TARGETED_REMOVAL',
    label: 'Targeted removal',
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, INTERACTION: 'targeted removal'",
  },
  {
    family: 'INTERACTION',
    type_key: 'SWEEPER',
    label: 'Mass removal',
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, INTERACTION: 'sweeper'",
  },
  {
    family: 'INTERACTION',
    type_key: 'COUNTERSPELL',
    label: 'Counters a spell',
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, INTERACTION: 'counterspell'",
  },
  {
    family: 'INTERACTION',
    type_key: 'DISCARD',
    label: 'Makes another player discard',
    params_schema: { type: 'object', properties: { whose: { enum: ['you', 'opponent', 'any'] } }, required: ['whose'], additionalProperties: false },
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, INTERACTION: 'discard'",
  },
  {
    family: 'INTERACTION',
    type_key: 'GRAVEYARD_HATE',
    label: "Interacts with an opponent's graveyard",
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, INTERACTION: 'graveyard hate'",
  },

  // ---- CONSTRAINTS ----
  {
    family: 'CONSTRAINTS',
    type_key: 'MANA_COST',
    label: 'Mana cost',
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, CONSTRAINTS: 'mana cost'",
  },
  {
    family: 'CONSTRAINTS',
    type_key: 'COLOR_IDENTITY',
    label: 'Colour identity',
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, CONSTRAINTS: 'colour identity'",
  },
  {
    family: 'CONSTRAINTS',
    type_key: 'TYPE_LINE',
    label: 'Type line',
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, CONSTRAINTS: 'type line'",
  },
  {
    family: 'CONSTRAINTS',
    type_key: 'TIMING',
    label: 'Timing restriction',
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, CONSTRAINTS: 'timing'",
  },
  {
    family: 'CONSTRAINTS',
    type_key: 'ZONE',
    label: 'Zone restriction',
    params_schema: EMPTY_PARAMS,
    provenance: 'spec_4_1',
    evidence: "concept spec sec. 4.1, CONSTRAINTS: 'zone'",
  },
  ];
}

// ============================================================================================
// CR 701 (keyword actions) - generated, one judgement call per entry
// ============================================================================================
// The brief's rule: a keyword action that creates or moves a game resource -> PRODUCES; one
// that defines a procedure, status, or legal action without moving such a resource -> ENABLES.
// This table is the one real judgement Task 2 requires (sec. 4.2 step 4) - it is NOT derivable
// by a single query, so it's recorded here, keyed by subsection_number so a corpus re-sync can't
// silently reorder entries under it. `reason` is asserted by a human reading the CR text quoted
// alongside it at generation time (below); `ties` records an exact sec. 4.1 line when one
// independently names the same concept, per the brief's evidence discipline.
//
// Task 2 fix pass, finding 2: this table replaces one produced by a query that read
// `subsection_number LIKE ? || '%'` instead of `subsection_number = ?`, which for the five
// single-digit anchors 701.2-701.6 pulled in unrelated two-digit subsections' text
// (e.g. '701.6%' matched 701.60-701.69, the Suspect-through-Heal band). That misread COUNTER
// (701.6) as PRODUCES from Forage/Endure/Earthbend's token-and-counter text bleeding in; 701.6's
// own text ("cancel it ... doesn't resolve") supports ENABLES. All 68 were re-read here against
// the corpus with an exact `subsection_number = ?` scope; only COUNTER's family changed.
// `title` is the CR subsection title this judgement was recorded against (Task 2 fix pass 2,
// Important finding: the same silent-misattachment class as the Critical this task already had).
// CR subsections get renumbered as new keywords are inserted (this corpus already shows a
// freshly-extended tail, 701.64 Harness through 701.69 Heal, that didn't exist when earlier
// judgements in this table were written) - so a bare `subsection_number` key is fragile: after a
// `sync:rules` re-parse that shifts numbers, `CR_701_JUDGMENT['701.6']` could silently start
// answering for a different keyword's title while the `reason` text still describes the old one.
// generate701 asserts `judgment.title === r.subsection_title` and throws otherwise, so a
// renumbering is a loud failure instead of a mis-attached reason.
type Judgment = { title: string; family: AtomFamily; reason: string; ties?: string };

const CR_701_JUDGMENT: Record<string, Judgment> = {
  '701.2': { title: 'Activate', family: 'ENABLES', reason: 'putting an activated ability onto the stack and paying its cost is a procedural capability, not the creation or movement of a resource' },
  '701.3': { title: 'Attach', family: 'ENABLES', reason: 'attaching an Aura, Equipment, or Fortification already in play to another object is a mechanical relationship change, not a resource creation or movement' },
  '701.4': { title: 'Behold', family: 'ENABLES', reason: 'revealing a card or choosing a permanent is a procedural instruction shorthand, not a resource creation or movement' },
  '701.5': { title: 'Cast', family: 'ENABLES', reason: 'putting a spell on the stack and paying its costs is a procedural capability, not the creation or movement of a resource' },
  '701.6': { title: 'Counter', family: 'ENABLES', reason: "countering cancels a spell or ability; the countered spell going to its owner's graveyard is the same fate an uncountered spell eventually has, not a resource this action itself produces" },
  '701.7': { title: 'Create', family: 'PRODUCES', reason: 'puts the specified number of tokens onto the battlefield', ties: "PRODUCES: 'tokens'" },
  '701.8': { title: 'Destroy', family: 'PRODUCES', reason: "moves a permanent from the battlefield to its owner's graveyard" },
  '701.9': { title: 'Discard', family: 'PRODUCES', reason: "moves a card from its owner's hand to that player's graveyard", ties: "PRODUCES: 'cards into graveyard'" },
  '701.10': { title: 'Double', family: 'ENABLES', reason: 'creates a continuous effect that modifies a power/toughness value, not a new resource' },
  '701.11': { title: 'Triple', family: 'ENABLES', reason: 'creates a continuous effect that modifies a power/toughness value, not a new resource' },
  '701.12': { title: 'Exchange', family: 'PRODUCES', reason: 'moves or exchanges life totals, control of permanents, or cards between zones and players' },
  '701.13': { title: 'Exile', family: 'PRODUCES', reason: 'moves an object to the exile zone' },
  '701.14': { title: 'Fight', family: 'PRODUCES', reason: 'each creature deals damage equal to its power to the other', ties: "PRODUCES: 'damage'" },
  '701.15': { title: 'Goad', family: 'ENABLES', reason: 'assigns the goaded status (a combat requirement) to a creature, not a resource' },
  '701.16': { title: 'Investigate', family: 'PRODUCES', reason: '"Investigate" means "Create a Clue token"', ties: "PRODUCES: 'tokens'" },
  '701.17': { title: 'Mill', family: 'PRODUCES', reason: 'puts cards from the top of a library into the graveyard', ties: "PRODUCES: 'cards into graveyard'" },
  '701.18': { title: 'Play', family: 'ENABLES', reason: 'putting a land onto the battlefield as a special action is a procedural capability paralleling Cast, not a resource this action produces' },
  '701.19': { title: 'Regenerate', family: 'ENABLES', reason: 'creates a replacement effect that protects a permanent from destruction, not a resource' },
  '701.20': { title: 'Reveal', family: 'ENABLES', reason: 'shows a card to all players without moving it out of its zone' },
  '701.21': { title: 'Sacrifice', family: 'PRODUCES', reason: "moves a permanent from the battlefield directly to its owner's graveyard" },
  '701.22': { title: 'Scry', family: 'ENABLES', reason: 'reorders the top cards of a library without moving any of them out of it' },
  '701.23': { title: 'Search', family: 'ENABLES', reason: 'looks through a zone to find a card matching a description, a procedural lookup' },
  '701.24': { title: 'Shuffle', family: 'ENABLES', reason: "randomizes a library's order, a procedural action" },
  '701.25': { title: 'Surveil', family: 'PRODUCES', reason: 'puts cards from the top of a library into the graveyard', ties: "PRODUCES: 'cards into graveyard'" },
  '701.26': { title: 'Tap and Untap', family: 'ENABLES', reason: "changes a permanent's tapped/untapped state, not a resource" },
  '701.27': { title: 'Transform', family: 'ENABLES', reason: 'turns a double-faced permanent to its other face, a state change' },
  '701.28': { title: 'Convert', family: 'ENABLES', reason: 'turns a permanent to its other face, following the transform rules' },
  '701.29': { title: 'Fateseal', family: 'ENABLES', reason: "reorders the top cards of an opponent's library without moving any of them out of it" },
  '701.30': { title: 'Clash', family: 'ENABLES', reason: 'reveals the top card of a library and optionally rearranges it, a procedural action' },
  '701.31': { title: 'Planeswalk', family: 'PRODUCES', reason: 'moves plane and phenomenon cards within the planar deck and turns the new top card face up' },
  '701.32': { title: 'Set in Motion', family: 'PRODUCES', reason: 'moves a scheme card off the top of the scheme deck and turns it face up' },
  '701.33': { title: 'Abandon', family: 'PRODUCES', reason: 'turns a scheme card face down and moves it to the bottom of the scheme deck' },
  '701.34': { title: 'Proliferate', family: 'ENABLES', reason: 'sec. 4.1 explicitly names this ENABLES even though it adds counters, so the named line governs over the mechanical default', ties: "ENABLES: 'proliferate'" },
  '701.35': { title: 'Detain', family: 'ENABLES', reason: "prevents a permanent from attacking, blocking, or activating abilities, a status restriction" },
  '701.36': { title: 'Populate', family: 'PRODUCES', reason: 'creates a token that is a copy of a creature token you control', ties: "PRODUCES: 'tokens'" },
  '701.37': { title: 'Monstrosity', family: 'PRODUCES', reason: 'puts +1/+1 counters onto a permanent', ties: "PRODUCES: '+1/+1 counters'" },
  '701.38': { title: 'Vote', family: 'ENABLES', reason: 'has players choose among listed options, a procedural decision' },
  '701.39': { title: 'Bolster', family: 'PRODUCES', reason: 'puts +1/+1 counters onto a creature', ties: "PRODUCES: '+1/+1 counters'" },
  '701.40': { title: 'Manifest', family: 'PRODUCES', reason: 'puts a card face down onto the battlefield as a 2/2 creature' },
  '701.41': { title: 'Support', family: 'PRODUCES', reason: 'puts a +1/+1 counter onto each of several target creatures', ties: "PRODUCES: '+1/+1 counters'" },
  '701.42': { title: 'Meld', family: 'PRODUCES', reason: 'puts two cards onto the battlefield combined as a single permanent' },
  '701.43': { title: 'Exert', family: 'ENABLES', reason: "causes a permanent to not untap during its controller's next untap step, a status effect" },
  '701.44': { title: 'Explore', family: 'PRODUCES', reason: 'reveals the top library card and puts a +1/+1 counter on the permanent or the card into the graveyard', ties: "PRODUCES: '+1/+1 counters'" },
  '701.45': { title: 'Assemble', family: 'PRODUCES', reason: 'puts Contraptions onto the battlefield' },
  '701.46': { title: 'Adapt', family: 'PRODUCES', reason: 'puts +1/+1 counters onto a permanent that has none', ties: "PRODUCES: '+1/+1 counters'" },
  '701.47': { title: 'Amass', family: 'PRODUCES', reason: 'creates an Army creature token and puts +1/+1 counters on it', ties: "PRODUCES: '+1/+1 counters'" },
  '701.48': { title: 'Learn', family: 'PRODUCES', reason: 'draws a card (after an optional discard)', ties: "PRODUCES: 'card draw'" },
  '701.49': { title: 'Venture into the Dungeon', family: 'PRODUCES', reason: 'puts a dungeon card into the command zone and moves the venture marker between rooms' },
  '701.50': { title: 'Connive', family: 'PRODUCES', reason: 'draws then discards a card and puts a +1/+1 counter on the conniving permanent', ties: "PRODUCES: 'card draw'" },
  '701.51': { title: 'Open an Attraction', family: 'PRODUCES', reason: 'moves the top card of the Attraction deck onto the battlefield' },
  '701.52': { title: 'Roll to Visit Your Attractions', family: 'ENABLES', reason: 'rolls a die to determine which Attractions trigger their visit ability, a procedural check' },
  '701.53': { title: 'Incubate', family: 'PRODUCES', reason: 'creates an Incubator token with +1/+1 counters on it', ties: "PRODUCES: 'tokens'" },
  '701.54': { title: 'The Ring Tempts You', family: 'ENABLES', reason: 'assigns the Ring-bearer designation to a creature, a status effect' },
  '701.55': { title: 'Face a Villainous Choice', family: 'ENABLES', reason: 'has a player choose between two listed options, a procedural decision' },
  '701.56': { title: 'Time Travel', family: 'PRODUCES', reason: 'adds or removes a time counter on permanents or suspended cards' },
  '701.57': { title: 'Discover', family: 'PRODUCES', reason: 'exiles cards from the library and puts one into hand (or casts it)' },
  '701.58': { title: 'Cloak', family: 'PRODUCES', reason: 'puts a card face down onto the battlefield as a 2/2 creature' },
  '701.59': { title: 'Collect Evidence', family: 'PRODUCES', reason: 'exiles cards from the graveyard' },
  '701.60': { title: 'Suspect', family: 'ENABLES', reason: "assigns the suspected designation (menace and can't block) to a creature, a status effect" },
  '701.61': { title: 'Forage', family: 'PRODUCES', reason: 'exiles cards from the graveyard or sacrifices a Food' },
  '701.62': { title: 'Manifest Dread', family: 'PRODUCES', reason: 'manifests a card and puts the rest into the graveyard', ties: "PRODUCES: 'cards into graveyard'" },
  '701.63': { title: 'Endure', family: 'PRODUCES', reason: 'creates a Spirit token or puts +1/+1 counters on the permanent', ties: "PRODUCES: '+1/+1 counters'" },
  '701.64': { title: 'Harness', family: 'ENABLES', reason: 'assigns the harnessed designation to a permanent, a status marker' },
  '701.65': { title: 'Airbend', family: 'PRODUCES', reason: 'exiles permanents and/or spells' },
  '701.66': { title: 'Earthbend', family: 'PRODUCES', reason: 'turns a land into a creature and puts +1/+1 counters on it', ties: "PRODUCES: '+1/+1 counters'" },
  '701.67': { title: 'Waterbend', family: 'ENABLES', reason: 'lets a player tap permanents instead of paying generic mana, a cost-payment alternative' },
  '701.68': { title: 'Blight', family: 'PRODUCES', reason: 'puts -1/-1 counters on a creature' },
  '701.69': { title: 'Heal', family: 'ENABLES', reason: 'removes marked damage from a permanent - undoing a resource, not creating or moving one' },
  '701.70': { title: 'Recruit', family: 'PRODUCES', reason: 'draws a card and discards a card, moving cards from library to hand and from hand to graveyard, and creates a 1/1 Human Soldier token if a nonland card was discarded (701.70a)', ties: "PRODUCES: 'cards into graveyard'" },
  '701.71': { title: 'Empower Jace', family: 'PRODUCES', reason: 'creates a Jace planeswalker token if you control none, then puts N loyalty counters on a Jace planeswalker token you control (701.71a)', ties: "PRODUCES: 'tokens'" },
};

function generate701(db: DatabaseSync, corpusId: number): AtomTypeDef[] {
  const rows = titledSubsections(db, corpusId, '701');
  return rows.map((r) => {
    const judgment = CR_701_JUDGMENT[r.subsection_number];
    if (!judgment) {
      throw new Error(
        `no CR_701_JUDGMENT entry for CR ${r.subsection_number} "${r.subsection_title}" - the ` +
        'corpus has a titled 701 subsection this generator does not know about. Add a judgement ' +
        '(PRODUCES if it creates/moves a resource, ENABLES if it grants a capability) before regenerating.',
      );
    }
    if (judgment.title !== r.subsection_title) {
      throw new Error(
        `CR_701_JUDGMENT['${r.subsection_number}'] was recorded against title "${judgment.title}" ` +
        `but the corpus now titles ${r.subsection_number} "${r.subsection_title}" - CR subsections ` +
        'get renumbered as keywords are inserted, so this number now names a different keyword than ' +
        "the one this judgement's `reason` was written about. Re-read the new subsection's text and " +
        "record a fresh judgement (do not just update `title` - the family and reason may no longer apply).",
      );
    }
    // 701 quote: prefer the 'a' subsection's text, but fall back to the first non-blank row under
    // this subsection_number if 'a' is absent or blank (Task 2 fix pass 2, Minor finding 1 - mirrors
    // the blank-text filter already applied on the 702 path below).
    const textRows = (
      db
        .prepare('SELECT number, text FROM rules WHERE corpus_id = ? AND subsection_number = ? ORDER BY ordinal')
        .all(corpusId, r.subsection_number) as Array<{ number: string; text: string }>
    ).filter((t) => t.text.trim() !== '');
    const primary = textRows.find((t) => t.number === `${r.subsection_number}a`) ?? textRows[0];
    const quote = primary ? firstSentence(primary.text) : '';
    const evidence =
      `CR ${r.subsection_number} titled "${r.subsection_title}"; text: "${quote}" -> ` +
      `${judgment.family} because ${judgment.reason}` +
      (judgment.ties ? `; matches concept spec sec. 4.1, ${judgment.ties}` : '; sec. 4.1 silent');
    return {
      family: judgment.family,
      type_key: typeKeyFromTitle(r.subsection_title),
      label: r.subsection_title,
      params_schema: EMPTY_PARAMS,
      provenance: 'cr_701',
      evidence,
    };
  });
}

// ============================================================================================
// CR 702 (keyword abilities) - generated, mechanical rule + one named override
// ============================================================================================
// The 702 combat-text rule (reproducible, unlike 701's per-entry judgement): a subsection whose
// rule text mentions blocking, attacking, damage or combat -> COMBAT; otherwise -> ENABLES.
// Task 2 fix pass, finding 1: the original generation used `subsection_number LIKE sn || '%'`,
// which for 702.5-702.18 pulled in unrelated later two/three-digit subsections' text (e.g.
// '702.5%' matches 702.5 AND 702.50-702.59; '702.11%' matches 702.11 AND 702.110-702.119). That
// gave Enchant/Equip/Flash/Hexproof/Shroud a false COMBAT read. This version scans every rule
// row under the EXACT subsection_number - confirmed against the live corpus: exact scope gives
// 55 COMBAT / 138 ENABLES, prefix scope reproduces the old (wrong) 60 / 133 with those five
// disagreeing.
const COMBAT_TEXT_RX = /\b(block|blocked|blocking|blockers?|attack|attacked|attacking|attackers?|damage|combat)\b/i;

// The one named override sec. 4.1 settles directly: Protection reads as COMBAT under the
// mechanical rule (its text discusses blocking and damage), but sec. 4.1 explicitly lists
// 'protection' under INTERACTION. Per the brief, an explicit sec. 4.1 line governs over the
// mechanical fallback used where sec. 4.1 is silent.
const FAMILY_OVERRIDE_702: Record<string, { family: AtomFamily; note: string }> = {
  Protection: {
    family: 'INTERACTION',
    note:
      "family per concept spec sec. 4.1 INTERACTION: 'protection' (overrides the 702 " +
      'combat-text rule, which would say COMBAT because the rule text mentions blocking and damage)',
  },
};

// sec. 4.1's COMBAT line names these four concepts explicitly; three have literal 702 titles.
const FOUR_ONE_TIES_702: Record<string, string> = {
  FLYING: "COMBAT: 'evasion class (flying / menace / trample / unblockable)'",
  MENACE: "COMBAT: 'evasion class (flying / menace / trample / unblockable)'",
  TRAMPLE: "COMBAT: 'evasion class (flying / menace / trample / unblockable)'",
  HASTE: "COMBAT: 'haste'",
};

function generate702(db: DatabaseSync, corpusId: number): AtomTypeDef[] {
  const rows = titledSubsections(db, corpusId, '702');
  return rows.map((r) => {
    const textRows = (
      db
        .prepare('SELECT text FROM rules WHERE corpus_id = ? AND subsection_number = ? ORDER BY ordinal')
        .all(corpusId, r.subsection_number) as Array<{ text: string }>
    ).filter((t) => t.text.trim() !== ''); // the bare subsection header row (e.g. "702.5") has no text
    const matched = textRows.find((t) => COMBAT_TEXT_RX.test(t.text));
    const quote = matched
      ? sentenceContaining(matched.text, COMBAT_TEXT_RX)
      : textRows[0]
        ? firstSentence(textRows[0].text)
        : '';
    const mechanicalFamily: AtomFamily = matched ? 'COMBAT' : 'ENABLES';
    const override = FAMILY_OVERRIDE_702[r.subsection_title];
    const family = override ? override.family : mechanicalFamily;
    const key = typeKeyFromTitle(r.subsection_title);
    const tie = FOUR_ONE_TIES_702[key];

    const evidence = override
      ? `CR ${r.subsection_number} titled "${r.subsection_title}"; ${override.note}`
      : `CR ${r.subsection_number} titled "${r.subsection_title}"; text: "${quote}" -> ${family} ` +
        `because ${matched ? 'it mentions blocking, attacking, damage or combat' : 'it has no mention of blocking, attacking, damage or combat'} ` +
        '(the 702 combat-text rule)' +
        (tie ? `; matches concept spec sec. 4.1, ${tie}` : '; sec. 4.1 silent');

    return {
      family,
      type_key: key,
      label: r.subsection_title,
      params_schema: EMPTY_PARAMS,
      provenance: 'cr_702',
      evidence,
    };
  });
}

// ============================================================================================
function main(): void {
  const db = openDb();
  const corpusId = currentCorpusId(db);

  // Schema v15 (spec sec. 20): one overlay of params, applied to every input of the merge so that
  // a promoted type and its generated twin agree, and a rerun is a no-op.
  const enums: V15Enums = {
    permanentTypes: permanentTypeEnum(db, corpusId),
    cardTypes: cardTypeEnum(db, corpusId),
    zones: zonesFrom400_1(ruleText(db, corpusId, '400.1')),
  };
  const v15 = (ts: readonly AtomTypeDef[]) => applyV15(ts, enums);
  const generated: AtomTypeDef[] = v15([...specTypes(db, corpusId), ...generate701(db, corpusId), ...generate702(db, corpusId)]);
  // Types promoted in the review queue live in atom_types first (promoteAtomType). Fold them back
  // in - from the database and from the committed file, so a fresh checkout keeps them too - so
  // this file stays a faithful snapshot and the next version cannot collide with a promotion.
  const committed = existsSync(OUT_PATH) ? loadAtomSchema(OUT_PATH).types : [];
  // Schema v16 (spec sec. 21): the owner's merge decisions of 2026-10-23, over v15.
  // Schema v17 (spec sec. 22): the owner's tag and reading answers of 2026-10-31, over v16.
  // Schema v18 (spec sec. 23): the owner's tag answers of 2026-10-31 that need no model, over v17.
  // Schema v19 (spec sec. 24): the owner's yes of 2026-10-31 to six event trigger tags, over v18.
  // Schema v20 (spec sec. 25): the details of PRODUCES.DAMAGE, over v19.
  const types = applyV20(applyV19(applyV18(applyV17(applyV16(applyV15(mergePromoted(generated, v15(promotedTypes(db)), v15(committed)), enums, { requireAll: true }), enums, { requireAll: true }), { requireAll: true }), { requireAll: true })));
  const version = chooseSchemaVersion(db, types, SCHEMA_VERSION);

  const seen = new Set<string>();
  for (const t of types) {
    const id = `${t.family}::${t.type_key}`;
    if (seen.has(id)) throw new Error(`duplicate family::type_key ${id} - fix the generator before writing`);
    seen.add(id);
  }

  const schema: AtomSchema & { _comment: string } = {
    _comment:
      'The atom-type enum. Seeded from two sources only: the family contents listed in the ' +
      'concept spec sec. 4.1, and the keyword-action / keyword-ability titles parsed from CR 701 ' +
      'and 702 into the database. No entry is authored from recalled Magic knowledge; every one ' +
      'carries its source in `evidence`. Generated by src/cli/generate-atom-schema.ts - do not ' +
      'hand-edit this file; change the generator and rerun `npm run generate:atom-schema` instead. ' +
      'PRECEDENCE NOTE for an implementer matching atoms against this enum (Task 2 fix pass 2, ' +
      'Minor finding 2): PRODUCES::TOKENS and PRODUCES::CARDS_TO_GRAVEYARD overlap in shape with ' +
      'several cr_701 keyword-action entries (CREATE, POPULATE, AMASS, INCUBATE, INVESTIGATE all ' +
      'produce tokens; MILL, SURVEIL, MANIFEST_DREAD all put cards into a graveyard) - the generic ' +
      'PRODUCES type only matches a card whose text does NOT use one of those specific named ' +
      "keywords; a card using the keyword matches the keyword-action entry instead. From schema v15 " +
      '(spec sec. 20, item V9) CREATE and MILL carry the same params as their generic twins TOKENS ' +
      'and CARDS_TO_GRAVEYARD, amount included, and submit validation drops a generic twin whose ' +
      'span overlaps the keyword atom on the same face: one fact, one atom, the keyword type kept.',
    schema_version: version,
    types,
  };

  const cr701 = types.filter((t) => t.provenance === 'cr_701');
  const cr702 = types.filter((t) => t.provenance === 'cr_702');
  const dist702 = cr702.reduce<Record<string, number>>((acc, t) => {
    acc[t.family] = (acc[t.family] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`spec_4_1: ${types.length - cr701.length - cr702.length}`);
  console.log(`cr_701: ${cr701.length}`);
  console.log(`cr_702: ${cr702.length} (${JSON.stringify(dist702)})`);
  console.log(`review_promoted: ${types.length - generated.length}`);
  console.log(`total: ${types.length} -> schema v${version}` +
    `${version === SCHEMA_VERSION ? '' : ` (current database version${version > currentSchemaVersion(db) ? ' + 1: the vocabulary changed' : ', unchanged'})`}`);

  writeFileSync(OUT_PATH, JSON.stringify(schema, null, 2) + '\n', 'utf8');
  console.log(`wrote ${OUT_PATH}`);

  // Writing the JSON is only half of a vocabulary change: `atom_types` is what every consumer
  // actually reads (goldenDraft's type list for a drafter, validateAtomParams, the golden_atoms
  // FK), and until v2 is in that table a v2 draft cannot be staged. No code path in this repo
  // did that - v1 reached the database by a route the repo does not record - so `--persist` is
  // it. Opt-in rather than automatic because persisting is the irreversible half:
  // persistAtomSchema refuses to rewrite an already-published version, by design (sec. 4.3).
  if (process.argv.includes('--persist')) {
    persistAtomSchema(db, schema);
    console.log(`persisted v${version}; current schema_version is now ${currentSchemaVersion(db)}`);
  } else {
    console.log('not persisted - rerun with --persist to load this version into atom_types');
  }
}

main();
