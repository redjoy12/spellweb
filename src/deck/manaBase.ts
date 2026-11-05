/**
 * The mana base (Phase 4 design sec. 7). It is computed and is not searched. All probabilities
 * are hypergeometric, on the play: the top 6 + T cards on turn T.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { BuildIndex } from '../graph/buildIndex.js';
import { assembleSpells, type DeckCard, type SpellSlot } from './assemble.js';
import type { Goal } from './goal.js';
import type { PairTable } from './pairs.js';
import type { DeckPolicy } from './policy.js';

export const COLOURS = ['B', 'R'] as const;
export type Colour = (typeof COLOURS)[number];
export type ColourCounts = Record<Colour, number>;

export interface LandSlot { oracle_id: string; copies: number; kind: 'dual' | 'basic' }

export interface ManaBase {
  /** The land count, and the mana value `T` that set it. */
  land_count: number; turn: number;
  needs: ColourCounts; sources: ColourCounts;
  /** The land count cannot meet both needs: the deck keeps the proportion. */
  short: boolean;
  lands: LandSlot[];
}

/** The lands that a mana base can use. `duals` are in the order of design sec. 7 step 3. */
export interface LandOptions { duals: Array<{ oracle_id: string; tapped: boolean }>; basics: Record<Colour, string> }

const logFactorials = (() => {
  const t = [0];
  for (let i = 1; i <= 200; i++) t.push(t[i - 1]! + Math.log(i));
  return t;
})();
const logChoose = (n: number, k: number) => logFactorials[n]! - logFactorials[k]! - logFactorials[n - k]!;

/** P(at least `k` successes in `n` draws from `size` cards with `hits` successes). */
export function atLeast(size: number, hits: number, n: number, k: number): number {
  let p = 0;
  for (let i = Math.max(k, n - (size - hits)); i <= Math.min(n, hits); i++) {
    p += Math.exp(logChoose(hits, i) + logChoose(size - hits, n - i) - logChoose(size, n));
  }
  return Math.min(1, p);
}

/** The mana value at the percentile of the spell copies (nearest rank), between the policy limits. */
export function curveTurn(manaValues: readonly number[], p: DeckPolicy): number {
  const sorted = [...manaValues].sort((a, b) => a - b);
  const at = sorted[Math.max(0, Math.ceil(p.mana.turn_percentile * sorted.length) - 1)] ?? 0;
  return Math.min(p.mana.turn_max, Math.max(p.mana.turn_min, Math.ceil(at)));
}

/** Design sec. 7 step 1: the smallest land count that reaches the probability, or the highest count. */
export function landCount(turn: number, p: DeckPolicy): number {
  for (let l = p.mana.lands_min; l <= p.mana.lands_max; l++) {
    if (atLeast(p.deck_size, l, p.mana.cards_seen_on_turn_0 + turn, turn) >= p.mana.land_probability) return l;
  }
  return p.mana.lands_max;
}

/** The symbols of one colour in a mana cost. A hybrid symbol such as `{B/R}` names each of its colours. */
export function colourSymbols(cost: string, colour: Colour): number {
  return (cost.match(/\{[^}]+\}/g) ?? []).filter((s) => s.slice(1, -1).split('/').includes(colour)).length;
}

/** Design sec. 7 step 2: the sources that give P(at least `k` in the top `6 + m` cards) of the bar. */
export function sourcesFor(k: number, mv: number, p: DeckPolicy): number {
  const seen = p.mana.cards_seen_on_turn_0 + Math.max(1, Math.ceil(mv));
  for (let s = k; s <= p.deck_size; s++) if (atLeast(p.deck_size, s, seen, k) >= p.mana.colour_probability) return s;
  return p.deck_size;
}

/** The need of each colour: the highest result of its spells. A card uses the face with the most symbols. */
export function colourNeeds(spells: ReadonlyArray<Pick<DeckCard, 'costs' | 'cmc'>>, p: DeckPolicy): ColourCounts {
  const needs: ColourCounts = { B: 0, R: 0 };
  for (const c of COLOURS) {
    for (const s of spells) {
      const k = Math.max(0, ...s.costs.map((x) => colourSymbols(x, c)));
      if (k > 0) needs[c] = Math.max(needs[c], sourcesFor(k, s.cmc, p));
    }
  }
  return needs;
}

/**
 * Design sec. 7 steps 3 to 5. The untapped dual lands always enter a deck that needs both colours.
 * A dual land with "enters tapped" text enters only while the basic lands cannot meet the needs.
 * The basic lands then fill the rest, in proportion to the need that remains.
 */
export function manaBase(spells: ReadonlyArray<Pick<DeckCard, 'costs' | 'cmc'>>, copies: readonly number[], lands: number, opts: LandOptions, p: DeckPolicy): ManaBase {
  const turn = curveTurn(spells.flatMap((s, i) => Array<number>(copies[i]!).fill(s.cmc)), p);
  const needs = colourNeeds(spells, p);
  const slots: LandSlot[] = [];
  let duals = 0;
  if (needs.B > 0 && needs.R > 0) {
    for (const d of opts.duals) {
      const room = lands - duals;
      const want = d.tapped ? Math.max(0, needs.B + needs.R - lands - duals) : p.mana.dual_land_copies;
      const n = Math.min(p.mana.dual_land_copies, want, room);
      if (n <= 0) continue;
      slots.push({ oracle_id: d.oracle_id, copies: n, kind: 'dual' });
      duals += n;
    }
  }
  const rest = { B: Math.max(0, needs.B - duals), R: Math.max(0, needs.R - duals) };
  // A deck with no coloured symbol still needs lands: each basic land of the form has the same share.
  const weight = rest.B + rest.R > 0 ? rest : needs.B + needs.R > 0 ? needs : { B: opts.basics.B ? 1 : 0, R: opts.basics.R ? 1 : 0 };
  const left = lands - duals;
  const swamps = Math.round(left * (weight.B / (weight.B + weight.R)));
  const basics: ColourCounts = { B: swamps, R: left - swamps };
  for (const c of COLOURS) if (basics[c] > 0) slots.push({ oracle_id: opts.basics[c], copies: basics[c], kind: 'basic' });
  const sources: ColourCounts = { B: duals + basics.B, R: duals + basics.R };
  return { land_count: lands, turn, needs, sources, short: COLOURS.some((c) => sources[c] < needs[c]), lands: slots };
}

/** The lands of a goal: dual lands by atoms, and the basic lands of the colours. Excluded cards stay out. */
export function landOptions(db: DatabaseSync, idx: BuildIndex, cards: readonly DeckCard[], goal: Goal, p: DeckPolicy): LandOptions {
  const text = db.prepare('SELECT COALESCE(group_concat(oracle_text, char(10)), \'\') AS t FROM card_faces WHERE oracle_id = ?');
  const excluded = new Set(goal.excluded);
  const hasColour = (id: string, c: string) => idx.atomsOfCard(id)
    .some((a) => a.family === 'PRODUCES' && a.type_key === 'MANA_PRODUCTION' && a.params['color'] === c);
  const duals = goal.colours !== 'BR' ? [] : cards
    .filter((c) => c.land && !excluded.has(c.oracle_id) && COLOURS.every((x) => hasColour(c.oracle_id, x)))
    .map((c) => ({ oracle_id: c.oracle_id, tapped: /enters tapped/i.test((text.get(c.oracle_id) as { t: string }).t) }))
    .sort((a, b) => Number(a.tapped) - Number(b.tapped) || (a.oracle_id < b.oracle_id ? -1 : 1));
  const basic = (c: Colour) => {
    const id = cards.find((x) => x.land && x.name === p.mana.basic_lands[c] && x.type_line.startsWith('Basic Land'))?.oracle_id;
    if (id) return id;
    if (goal.colours.includes(c)) throw new Error(`the pool has no basic land ${p.mana.basic_lands[c]}`);
    return '';
  };
  return { duals, basics: { B: basic('B'), R: basic('R') } };
}

export interface BuiltCards { spells: SpellSlot[]; mana: ManaBase; loops: number; stable: boolean }

/**
 * Design sec. 5 step 6: the land count sets the spell slots, so the search runs again, at most
 * `mana_loops` times, until the count is stable. The last deck keeps the count that it was made
 * for, so the deck has its exact size.
 */
export function buildCards(candidateList: readonly DeckCard[], goal: Goal, t: PairTable, opts: LandOptions, p: DeckPolicy): BuiltCards {
  const byId = new Map(candidateList.map((c) => [c.oracle_id, c]));
  let lands = p.mana.start_lands;
  for (let loop = 1; ; loop++) {
    const spells = assembleSpells(candidateList, goal, t, p.deck_size - lands, p);
    const cards = spells.map((s) => byId.get(s.oracle_id)!);
    const copies = spells.map((s) => s.copies);
    const next = landCount(curveTurn(cards.flatMap((c, i) => Array<number>(copies[i]!).fill(c.cmc)), p), p);
    const stable = next === lands;
    if (stable || loop === p.search.mana_loops) return { spells, mana: manaBase(cards, copies, lands, opts, p), loops: loop, stable };
    lands = next;
  }
}
