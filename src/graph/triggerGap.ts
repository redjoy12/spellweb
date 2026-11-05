/**
 * The event trigger gap of a build (plan 2026-10-31-schema-v17 Task 13, section 9.1). Read only.
 *
 * An event trigger is a "When ..." or "Whenever ..." phrase outside reminder text, up to the first
 * comma or colon. "When you do" follows from another clause, so it is not an event of its own. A
 * trigger has a gap when no CARES_ABOUT atom of the build overlaps it.
 *
 * The limit of a tag is an upper bound on its new link pairs: demand cards x supply cards, less the
 * pairs that have a `+` link now. A rule pass can add other supply tags, so a limit is not a promise.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  BECOMES_TAPPED_TAG, CARD_DRAW_TAG, COMMIT_CRIME_TAG, DEALT_DAMAGE_TAG, DISCARD_TAG, LEAVES_GRAVEYARD_TAG,
} from '../atoms/schemaV19.js';
import { BuildIndex } from './buildIndex.js';

/** The six tags of plan section 9.1, in their order, each with the trigger words that it answers. */
export const TRIGGER_TAGS: ReadonlyArray<{ tag: string; words: RegExp }> = [
  { tag: DISCARD_TAG, words: /\bdiscards?\b/i },
  { tag: LEAVES_GRAVEYARD_TAG, words: /\bleaves? your graveyard\b/i },
  { tag: BECOMES_TAPPED_TAG, words: /\bbecomes tapped\b/i },
  { tag: CARD_DRAW_TAG, words: /\bdraws?\b/i },
  { tag: COMMIT_CRIME_TAG, words: /\bcommit a crime\b/i },
  { tag: DEALT_DAMAGE_TAG, words: /\b(?:is|are) dealt\b/i },
];

/** The keywords with the word "discard" in their CR 702 text (plan section 9.1, "Keyword supply"). */
const DISCARD_KEYWORDS = ['CYCLING', 'JUMP_START', 'MADNESS', 'MAYHEM', 'REINFORCE', 'RETRACE', 'TRANSMUTE'];

export interface FaceText { oracle_id: string; name: string; face_index: number; text: string }
export interface SpanAtom { oracle_id: string; face_index: number; family: string; type_key: string; span_start: number; span_end: number; params_json: string }
export interface TriggerGap { oracle_id: string; name: string; face_index: number; span_start: number; span_end: number; quote: string; tag: string | null }
export interface LimitPart { part: string; demand_cards: number; supply_cards: number; pairs: number; new_pairs: number }
export interface TagLimit { tag: string; demand_cards: number; new_pairs: number; parts: LimitPart[] }
export interface TriggerGapReport {
  build: number; gaps: TriggerGap[]; limits: TagLimit[]; all_new_pairs: number;
  /** Plan section 9.1, "These facts can change a value": outside the sum. */
  keyword_discard_new_pairs: number; crime_wide_new_pairs: number;
}

/** Blanks reminder text. Spaces keep the spans of the stored text. */
export const withoutReminder = (text: string) => text.replace(/\([^)]*\)/g, (m) => ' '.repeat(m.length));

/** The event triggers of one face text. */
export function eventTriggers(text: string): Array<{ span_start: number; span_end: number; quote: string }> {
  const out: Array<{ span_start: number; span_end: number; quote: string }> = [];
  for (const m of withoutReminder(text).matchAll(/\b(?:Whenever|When)\b[^,:\n]*/g)) {
    if (/^when you do/i.test(m[0])) continue;
    out.push({ span_start: m.index, span_end: m.index + m[0].length, quote: m[0].trim() });
  }
  return out;
}

/** The tag of plan section 9.1 that answers a trigger, or null. */
export const tagOfTrigger = (quote: string): string | null => TRIGGER_TAGS.find((t) => t.words.test(quote))?.tag ?? null;

/** Each event trigger that no CARES_ABOUT atom overlaps. */
export function triggerGaps(faces: readonly FaceText[], atoms: readonly SpanAtom[]): TriggerGap[] {
  const byFace = new Map<string, SpanAtom[]>();
  for (const a of atoms) {
    if (a.family !== 'CARES_ABOUT') continue;
    const key = `${a.oracle_id}|${a.face_index}`;
    (byFace.get(key) ?? byFace.set(key, []).get(key)!).push(a);
  }
  return faces.flatMap((f) => {
    const on = byFace.get(`${f.oracle_id}|${f.face_index}`) ?? [];
    return eventTriggers(f.text)
      .filter((t) => !on.some((a) => a.span_start < t.span_end && a.span_end > t.span_start))
      .map((t) => ({ oracle_id: f.oracle_id, name: f.name, face_index: f.face_index, ...t, tag: tagOfTrigger(t.quote) }));
  });
}

export interface OpenReport { id: number; quote: string }

/** The open unclassified reports whose text has an event trigger that a tag answers (plan Task 14). */
export const answeredReports = (open: readonly OpenReport[]): Array<OpenReport & { tag: string }> => open.flatMap((r) => {
  const tag = eventTriggers(r.quote).map((t) => tagOfTrigger(t.quote)).find((x) => x);
  return tag ? [{ ...r, tag }] : [];
});

/** The card pairs of a part and the pairs of them with no link now. A card never pairs with itself. */
export function limitPairs(demand: readonly string[], supply: ReadonlySet<string>, linked: ReadonlySet<string>): { pairs: Set<string>; fresh: Set<string> } {
  const pairs = new Set<string>();
  const fresh = new Set<string>();
  for (const d of demand) {
    for (const s of supply) {
      if (s === d) continue;
      const key = `${s}>${d}`;
      pairs.add(key);
      if (!linked.has(key)) fresh.add(key);
    }
  }
  return { pairs, fresh };
}

const union = (...sets: ReadonlyArray<ReadonlySet<string>>) => new Set(sets.flatMap((s) => [...s]));

/** The gap list and the limits of plan section 9.1 on one build. */
export function triggerGapReport(db: DatabaseSync, buildId: number): TriggerGapReport {
  const atoms = db.prepare(
    `SELECT a.oracle_id, a.face_index, a.family, a.type_key, a.span_start, a.span_end, a.params_json
       FROM graph_build_atoms g JOIN atoms a ON a.id = g.atom_id WHERE g.build_id = ?`,
  ).all(buildId) as unknown as SpanAtom[];
  const inBuild = new Set(atoms.map((a) => a.oracle_id));
  const faces = (db.prepare(
    `SELECT f.oracle_id, c.name, f.face_index, f.oracle_text text FROM card_faces f JOIN cards c USING (oracle_id) ORDER BY c.name, f.face_index`,
  ).all() as unknown as FaceText[]).filter((f) => inBuild.has(f.oracle_id));
  const gaps = triggerGaps(faces, atoms);

  const cardsWith = (id: string, param?: string, values?: readonly string[]) => new Set(atoms
    .filter((a) => `${a.family}.${a.type_key}` === id && (!param || values!.includes((JSON.parse(a.params_json) as Record<string, string>)[param]!)))
    .map((a) => a.oracle_id));
  const textOf = new Map<string, string>();
  for (const f of faces) textOf.set(f.oracle_id, `${textOf.get(f.oracle_id) ?? ''}\n${withoutReminder(f.text)}`);
  const cardsWhoseText = (re: RegExp) => new Set([...textOf].filter(([, t]) => re.test(t)).map(([o]) => o));

  const damage = cardsWith('PRODUCES.DAMAGE');
  const crimeText = cardsWhoseText(/target (?:opponent|player)|any target/i);
  const parts: ReadonlyArray<{ tag: string; part: string; words: RegExp; supply: ReadonlySet<string> }> = [
    { tag: DISCARD_TAG, part: 'an opponent discards', words: /an opponent discards/i, supply: cardsWith('PRODUCES.DISCARD', 'actor', ['opponent', 'any']) },
    { tag: DISCARD_TAG, part: 'a player discards', words: /players? discards?/i, supply: cardsWith('PRODUCES.DISCARD') },
    { tag: DISCARD_TAG, part: 'you discard', words: /you discard/i, supply: cardsWith('PRODUCES.DISCARD', 'actor', ['you', 'any']) },
    { tag: LEAVES_GRAVEYARD_TAG, part: 'your graveyard', words: /./, supply: union(cardsWith('ENABLES.RECURSION', 'whose', ['you', 'any']), cardsWith('ENABLES.FLASHBACK')) },
    { tag: BECOMES_TAPPED_TAG, part: 'tap costs', words: /./, supply: union(...['TAP_AND_UNTAP', 'CREW', 'STATION', 'SADDLE'].map((k) => cardsWith(`ENABLES.${k}`))) },
    { tag: CARD_DRAW_TAG, part: 'you draw', words: /you draw/i, supply: cardsWith('PRODUCES.CARD_DRAW') },
    { tag: CARD_DRAW_TAG, part: 'an opponent draws', words: /an opponent draws/i, supply: cardsWhoseText(/(?:each|target) (?:opponent|player) draws/i) },
    { tag: COMMIT_CRIME_TAG, part: 'target opponent, target player or any target', words: /./, supply: crimeText },
    { tag: DEALT_DAMAGE_TAG, part: 'damage', words: /./, supply: damage },
  ];

  const index = BuildIndex.load(db, buildId);
  const demandOf = (tag: string, words: RegExp) => [...new Set(gaps.filter((g) => g.tag === tag && words.test(g.quote)).map((g) => g.oracle_id))];
  const linked = new Set<string>();
  for (const d of new Set(gaps.filter((g) => g.tag).map((g) => g.oracle_id))) {
    for (const e of index.edgesForCard(d).in) if (e.supply_oracle) linked.add(`${e.supply_oracle}>${d}`);
  }

  const limits = TRIGGER_TAGS.map(({ tag }) => {
    const fresh = new Set<string>();
    const rows = parts.filter((p) => p.tag === tag).map((p) => {
      const demand = demandOf(tag, p.words);
      const r = limitPairs(demand, p.supply, linked);
      for (const k of r.fresh) fresh.add(k);
      return { part: p.part, demand_cards: demand.length, supply_cards: p.supply.size, pairs: r.pairs.size, new_pairs: r.fresh.size };
    });
    return { tag, demand_cards: demandOf(tag, /./).length, new_pairs: fresh.size, parts: rows };
  });
  return {
    build: buildId, gaps, limits, all_new_pairs: limits.reduce((n, l) => n + l.new_pairs, 0),
    keyword_discard_new_pairs: limitPairs(demandOf(DISCARD_TAG, /you discard/i), union(...DISCARD_KEYWORDS.map((k) => cardsWith(`ENABLES.${k}`))), linked).fresh.size,
    crime_wide_new_pairs: limitPairs(demandOf(COMMIT_CRIME_TAG, /./), cardsWhoseText(/\btarget\b/i), linked).fresh.size,
  };
}
