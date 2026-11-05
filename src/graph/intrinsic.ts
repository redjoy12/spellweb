import type { DatabaseSync } from 'node:sqlite';
import { selectColourSlice } from '../pool/slice.js';
import { crCardTypes } from './crContent.js';
import { crSubtypeLists } from './subtypes.js';
import { isIntrinsic, sideId, type IntrinsicSide, type SupplySide } from './ruleSchema.js';

/** spec sec. 7.1: a card is in a scope when its colour identity is in the scope colours. */
export type Scope = 'B' | 'R' | 'BR';
export type IntrinsicKind = 'card_type' | 'subtype' | 'mana_value' | 'color_identity';
export type Characteristic = 'type_line' | 'mana_value' | 'color_identity' | 'power_toughness';
export const INTRINSIC_KINDS: readonly IntrinsicKind[] = ['card_type', 'subtype', 'mana_value', 'color_identity'];

/** spec sec. 6.2: a class node. `id` is the `sideId` of the rule supply side; `members` are oracle IDs. */
export interface IntrinsicClass { id: string; intrinsic: IntrinsicKind; value: string | number; members: string[] }

/** spec rev. 6 sec. 12.2: the class kinds that agree with a golden characteristic supply. */
export const KINDS_FOR: Record<Characteristic, IntrinsicKind[]> = {
  type_line: ['card_type', 'subtype'],
  mana_value: ['mana_value'],
  color_identity: ['color_identity'],
  // Owner decision 2026-10-11: power and toughness is a golden characteristic, but sec. 6.1 has no
  // class kind for it. No class edge can find such a pair: the score counts it as a rule miss.
  power_toughness: [],
};

/** The cards of a scope: the live pool, colour identity a subset of the scope colours. */
export function scopeCards(db: DatabaseSync, scope: Scope): string[] {
  return selectColourSlice(db, scope);
}

/**
 * spec rev. 6 sec. 6.1: the closed value set of each kind. Card types and subtypes come from CR
 * text (`crCardTypes`, `crSubtypeLists`); mana values and colour letters from the scope cards.
 * No value comes from memory.
 */
export function permittedIntrinsicValues(
  db: DatabaseSync, corpusId: number, scope: Scope,
): Record<IntrinsicKind, Array<string | number>> {
  const ids = JSON.stringify(scopeCards(db, scope));
  const cmc = (db.prepare('SELECT DISTINCT c.cmc FROM cards c JOIN json_each(?) j ON j.value = c.oracle_id ORDER BY c.cmc')
    .all(ids) as Array<{ cmc: number }>).map((r) => r.cmc);
  const letters = (db.prepare(
    `SELECT DISTINCT ci.value AS letter FROM cards c JOIN json_each(?) j ON j.value = c.oracle_id,
       json_each(c.color_identity) ci ORDER BY letter`,
  ).all(ids) as Array<{ letter: string }>).map((r) => r.letter);
  return {
    card_type: [...crCardTypes(db, corpusId).keys()],
    subtype: [...new Set([...crSubtypeLists(db, corpusId).values()].flat())].sort(),
    mana_value: cmc,
    color_identity: letters,
  };
}

/** The part of a type line after the long dash. Scryfall writes it as U+2014. */
function subtypePart(typeLine: string): string {
  const i = typeLine.indexOf('—');
  return i < 0 ? '' : typeLine.slice(i + 1);
}

/**
 * spec rev. 6 sec. 6.1, membership of a class:
 * - `card_type`: a word of a face type line is equal to the term, without case;
 * - `subtype`: the subtype is in the part of a face type line after the long dash (whole words);
 * - `mana_value`: `cmc` is equal to the value;
 * - `color_identity`: the colour identity contains the letter.
 */
export function isClassMember(
  db: DatabaseSync, oracleId: string, cls: { intrinsic: IntrinsicKind; value: string | number },
): boolean {
  const card = db.prepare('SELECT cmc, color_identity FROM cards WHERE oracle_id = ?')
    .get(oracleId) as { cmc: number; color_identity: string } | undefined;
  if (!card) throw new Error(`no card with oracle_id ${oracleId}`);
  const faces = () => (db.prepare('SELECT type_line FROM card_faces WHERE oracle_id = ? ORDER BY face_index')
    .all(oracleId) as Array<{ type_line: string }>).map((f) => f.type_line);
  const value = String(cls.value);
  switch (cls.intrinsic) {
    case 'card_type':
      return faces().some((t) => t.split(/\s+/).some((w) => w.toLowerCase() === value.toLowerCase()));
    case 'subtype': {
      const want = value.toLowerCase().split(/\s+/).join(' ');
      return faces().some((t) => ` ${subtypePart(t).toLowerCase().split(/\s+/).filter(Boolean).join(' ')} `.includes(` ${want} `));
    }
    case 'mana_value':
      return card.cmc === Number(cls.value);
    case 'color_identity':
      return (JSON.parse(card.color_identity) as string[]).includes(value);
  }
}

/**
 * spec sec. 6.2, plan Task 4 Step 4: one class node for each intrinsic supply side of the rules,
 * sorted by ID. The members are the scope cards that `isClassMember` accepts, so the build and
 * the deriver-only score use one membership rule. No model.
 */
export function intrinsicClasses(db: DatabaseSync, scope: Scope, rules: ReadonlyArray<{ supply: SupplySide }>): IntrinsicClass[] {
  const sides = new Map<string, IntrinsicSide>();
  for (const r of rules) if (isIntrinsic(r.supply)) sides.set(sideId(r.supply), r.supply);
  const cards = scopeCards(db, scope);
  return [...sides].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, s]) => ({
    id, intrinsic: s.intrinsic, value: s.value,
    members: cards.filter((c) => isClassMember(db, c, s)),
  }));
}

/** spec rev. 21 sec. 7.10: the ID of the members of card-type class `parent` with a subtype. */
export const namedSubtypeId = (parent: string, subtype: string) => `${parent}.subtype(${subtype})`;

/**
 * spec rev. 21 sec. 7.10: for each card-type class and each subtype, a class of the members with
 * that subtype. A class with no members is left out.
 */
export function namedSubtypeClasses(db: DatabaseSync, scope: Scope, classes: readonly IntrinsicClass[], subtypes: Iterable<string>): IntrinsicClass[] {
  const cards = scopeCards(db, scope);
  const parents = classes.filter((c) => c.intrinsic === 'card_type');
  return [...subtypes].sort().flatMap((value) => {
    const named = new Set(cards.filter((c) => isClassMember(db, c, { intrinsic: 'subtype', value })));
    return parents.map((p): IntrinsicClass => ({ id: namedSubtypeId(p.id, value), intrinsic: 'subtype', value, members: p.members.filter((m) => named.has(m)) }))
      .filter((c) => c.members.length > 0);
  });
}
