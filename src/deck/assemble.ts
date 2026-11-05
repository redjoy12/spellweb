/**
 * The deck search (Phase 4 design sec. 5 and 6): candidates, seeds, quota fill, beam search and
 * copies. The model is not in this search (invariant I4): the same goal and the same pair table
 * give the same cards. Ties go to the lower `oracle_id`. A goal with `use_rate` adds the card rate
 * to the fit, and each tie reads the rate first (card rate plan sec. 2.5).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { BuildIndex } from '../graph/buildIndex.js';
import { coloursFit, isLand, type Goal } from './goal.js';
import { linkCounts, type PairTable } from './pairs.js';
import type { DeckPolicy } from './policy.js';
import type { CardRate } from './rates.js';

/** One card of the search, with the facts that the search reads from the card row and the atoms. */
export interface DeckCard {
  oracle_id: string; name: string; type_line: string; cmc: number;
  /** The mana cost of each face that has one. */
  costs: string[];
  identity: string[]; arena_id: number | null;
  land: boolean; creature: boolean; legendary: boolean;
  /** The card has an `INTERACTION.*` atom. */
  interaction: boolean;
  /** The tags of the card's atoms, as `FAMILY.TYPE_KEY`, each one time. */
  tags: string[];
  /** Only when the goal has `use_rate` (`rates.ts`). */
  rate?: CardRate;
}

export type SpellRole = 'seed' | 'pin' | 'quota' | 'link' | 'swap';
export interface SpellSlot { oracle_id: string; copies: number; role: SpellRole; fit: number }

interface CardRow {
  oracle_id: string; name: string; type_line: string; cmc: number; color_identity: string; arena_id: number | null; costs: string;
}

/** The front face of a type line holds the word. */
const frontHas = (typeLine: string, word: string) => new RegExp(`\\b${word}\\b`).test(typeLine.split(' // ')[0]!);

/** The live cards of the form colours, with an `arena_id`, in `oracle_id` order. Lands are in the list. */
export function deckCards(db: DatabaseSync, idx: BuildIndex, colours: Goal['colours']): DeckCard[] {
  const rows = db.prepare(
    `SELECT c.oracle_id, c.name, c.type_line, c.cmc, c.color_identity, c.arena_id,
            (SELECT json_group_array(f.mana_cost) FROM card_faces f WHERE f.oracle_id = c.oracle_id AND COALESCE(f.mana_cost, '') <> '') AS costs
       FROM cards c WHERE c.rotated = 0 AND c.arena_id IS NOT NULL ORDER BY c.oracle_id`,
  ).all() as unknown as CardRow[];
  return rows.flatMap((r) => {
    const identity = JSON.parse(r.color_identity) as string[];
    if (!coloursFit(identity, colours)) return [];
    const atoms = idx.atomsOfCard(r.oracle_id);
    return [{
      oracle_id: r.oracle_id, name: r.name, type_line: r.type_line, cmc: r.cmc, identity, arena_id: r.arena_id,
      costs: JSON.parse(r.costs) as string[], land: isLand(r.type_line), creature: frontHas(r.type_line, 'Creature'),
      legendary: frontHas(r.type_line, 'Legendary'), interaction: atoms.some((a) => a.family === 'INTERACTION'),
      tags: [...new Set(atoms.map((a) => `${a.family}.${a.type_key}`))].sort(),
    }];
  });
}

/**
 * Design sec. 5 step 1: the candidates of a goal, in `oracle_id` order. The seeds and the pinned
 * cards are in the list. A card with a "never" tag is out, unless it is a seed or a pinned card
 * (build chat design sec. 3).
 */
export function candidates(cards: readonly DeckCard[], goal: Goal): DeckCard[] {
  const excluded = new Set(goal.excluded);
  const kept = new Set([...goal.seeds, ...goal.pinned]);
  const never = new Set(goal.excluded_tags);
  return cards.filter((c) => !c.land && !excluded.has(c.oracle_id) && (kept.has(c.oracle_id)
    || (c.cmc <= goal.target_turn && !c.tags.some((t) => never.has(t)))));
}

/** Plan sec. 2.5: the rate, then `role_gap`, then the lower `oracle_id`. A null reads as 0. */
function rateOrder(a: DeckCard, b: DeckCard): number {
  return (b.rate?.rate ?? 0) - (a.rate?.rate ?? 0) || (b.rate?.role_gap ?? 0) - (a.rate?.role_gap ?? 0) || (a.oracle_id < b.oracle_id ? -1 : 1);
}

/** The pairs of the candidates, by position in the list. The sum is `pos(c,d) + pos(d,c)`. `rate` is 0 with the switch off. */
interface Scorer { cards: readonly DeckCard[]; links: Array<Array<[number, number]>>; anti: Array<Array<[number, number]>>; hub: Float64Array; rate: Float64Array }

function scorer(cards: readonly DeckCard[], t: PairTable, goal: Goal, p: DeckPolicy): Scorer {
  const seedIds = goal.seeds;
  const at = new Map(cards.map((c, i) => [c.oracle_id, i]));
  const seeded = new Set(seedIds.map((id) => at.get(id)));
  /** Design sec. 6: a pair with a seed counts `seed_weight` times, so the deck stays around the seeds. */
  const pair = (i: number, j: number, w: number): [number, number] => [j, seeded.has(i) || seeded.has(j) ? w * p.score.seed_weight : w];
  const sums = cards.map(() => new Map<number, number>());
  for (const [i, c] of cards.entries()) {
    for (const [d, l] of t.pos.get(c.oracle_id) ?? []) {
      const j = at.get(d);
      if (j === undefined) continue;
      sums[i]!.set(j, (sums[i]!.get(j) ?? 0) + l.weight);
      sums[j]!.set(i, (sums[j]!.get(i) ?? 0) + l.weight);
    }
  }
  const counts = linkCounts(t, new Set(at.keys()));
  return {
    cards, links: sums.map((m, i) => [...m].map(([j, w]) => pair(i, j, w))),
    anti: cards.map((c, i) => [...t.anti.get(c.oracle_id) ?? []].flatMap(([d, l]) => {
      const j = at.get(d);
      return j === undefined ? [] : [pair(i, j, l.weight)];
    })),
    hub: Float64Array.from(cards, (c) => (1 + (counts.get(c.oracle_id) ?? 0)) ** p.score.hub_power),
    rate: Float64Array.from(cards, (c) => (goal.use_rate ? p.score.rate_weight * (c.rate?.rate ?? 0) : 0)),
  };
}

/** One deck in the search: its cards, in the order that they entered, and the sums of each candidate. */
interface State { deck: number[]; inDeck: Set<number>; linkSum: Float64Array; antiSum: Float64Array; score: number }

const emptyState = (n: number): State => ({ deck: [], inDeck: new Set(), linkSum: new Float64Array(n), antiSum: new Float64Array(n), score: 0 });

/** Design sec. 6: `fit(c, deck)`, plus `rate_weight * rate[c]` with the switch on. */
const fitOf = (s: Scorer, st: State, c: number, p: DeckPolicy) => st.linkSum[c]! / s.hub[c]! - p.score.anti_penalty * st.antiSum[c]! + s.rate[c]!;

function withCard(s: Scorer, st: State, c: number, fit: number): State {
  const linkSum = st.linkSum.slice();
  const antiSum = st.antiSum.slice();
  for (const [j, w] of s.links[c]!) linkSum[j]! += w;
  for (const [j, w] of s.anti[c]!) antiSum[j]! += w;
  return { deck: [...st.deck, c], inDeck: new Set(st.inDeck).add(c), linkSum, antiSum, score: st.score + fit };
}

/** The cards of the deck by fit, highest first. The candidate list is in the order of the ties, so a tie goes to the lower position. */
function byFit(s: Scorer, st: State, p: DeckPolicy): number[] {
  return st.deck.map((c) => [c, fitOf(s, st, c, p)] as const)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([c]) => c);
}

/** The copies that the third of a card gives (design sec. 6), before the deck size cuts them. */
function tierCopies(s: Scorer, c: number, i: number, n: number, p: DeckPolicy): number {
  const third = p.copies.thirds[Math.min(2, Math.floor((3 * i) / n))]!;
  return s.cards[c]!.legendary ? Math.min(third, p.copies.legendary_max) : third;
}

function copyTotal(s: Scorer, st: State, p: DeckPolicy): number {
  const ranked = byFit(s, st, p);
  return ranked.reduce((sum, c, i) => sum + tierCopies(s, c, i, ranked.length, p), 0);
}

/**
 * Design sec. 6, copies: the thirds by fit, and each seed and pinned card keeps `seed_min` copies.
 * The last card takes the copies that remain, and a card after it gets none. A short list raises
 * the copies from the top down.
 */
function assignCopies(s: Scorer, st: State, seeds: ReadonlySet<number>, spellCopies: number, p: DeckPolicy): Map<number, number> {
  const out = new Map<number, number>();
  for (const c of seeds) out.set(c, p.copies.seed_min);
  let left = spellCopies - seeds.size * p.copies.seed_min;
  const ranked = byFit(s, st, p);
  for (const [i, c] of ranked.entries()) {
    const have = out.get(c) ?? 0;
    const give = Math.min(tierCopies(s, c, i, ranked.length, p) - have, left);
    if (give <= 0) continue;
    out.set(c, have + give);
    left -= give;
  }
  for (const c of ranked) {
    if (left <= 0 || !out.has(c)) break;
    const max = s.cards[c]!.legendary ? p.copies.legendary_max : p.max_copies;
    const more = Math.min(max - out.get(c)!, left);
    out.set(c, out.get(c)! + more);
    left -= more;
  }
  return out;
}

/** The candidates with the highest fit that `allowed` permits, highest first. */
function topCards(s: Scorer, st: State, width: number, p: DeckPolicy, allowed: (c: number) => boolean = () => true): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let c = 0; c < s.cards.length; c++) {
    if (st.inDeck.has(c) || !allowed(c)) continue;
    const fit = fitOf(s, st, c, p);
    if (out.length === width && fit <= out[width - 1]![1]) continue;
    let i = out.length;
    while (i > 0 && out[i - 1]![1] < fit) i--;
    out.splice(i, 0, [c, fit]);
    if (out.length > width) out.pop();
  }
  return out;
}

/** The copies that a quota counts: `quota_card_copies` for each card, because the copies come after the quota fill. */
function quotaCount(s: Scorer, st: State, holds: (c: DeckCard) => boolean, p: DeckPolicy): number {
  return st.deck.reduce((sum, c) => sum + (holds(s.cards[c]!) ? p.quotas.quota_card_copies : 0), 0);
}

/** A goal with no seed starts at the card with the highest fit against all candidates (design sec. 5 step 2). */
function startCard(s: Scorer, p: DeckPolicy): number[] {
  const sumOf = (pairs: ReadonlyArray<[number, number]>) => pairs.reduce((sum, [, w]) => sum + w, 0);
  const all = { ...emptyState(s.cards.length), linkSum: Float64Array.from(s.links, sumOf), antiSum: Float64Array.from(s.anti, sumOf) };
  return topCards(s, all, 1, p).map(([c]) => c);
}

const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sortedIds = (a: readonly number[]) => [...a].sort((x, y) => x - y);
function idsBefore(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** Design sec. 5 step 4: one step of the beam. A deck that two orders reach counts once. */
function beamStep(s: Scorer, beam: readonly State[], p: DeckPolicy): State[] {
  const width = p.search.beam_width;
  const children: Array<{ from: State; card: number; fit: number; score: number; ids: number[] }> = [];
  for (const st of beam) {
    for (const [card, fit] of topCards(s, st, width, p)) {
      children.push({ from: st, card, fit, score: st.score + fit, ids: sortedIds([...st.deck, card]) });
    }
  }
  children.sort((a, b) => b.score - a.score || idsBefore(a.ids, b.ids));
  const kept: typeof children = [];
  for (const c of children) {
    if (kept.length === width) break;
    if (!kept.some((k) => sameIds(k.ids, c.ids))) kept.push(c);
  }
  return kept.map((k) => withCard(s, k.from, k.card, k.fit));
}

/**
 * Design sec. 5 steps 2 to 5: the spells of a deck with `spellCopies` copies. `list` is the
 * candidate list of the goal. With the switch on, a position is a place in the rate order, so each
 * tie reads the rate. The result is in order of mana value, then name.
 */
export function assembleSpells(list: readonly DeckCard[], goal: Goal, t: PairTable, spellCopies: number, p: DeckPolicy): SpellSlot[] {
  const cards = goal.use_rate ? [...list].sort(rateOrder) : list;
  const s = scorer(cards, t, goal, p);
  const at = new Map(cards.map((c, i) => [c.oracle_id, i]));
  const seeds = new Set(goal.seeds.map((id) => at.get(id)!));
  const pins = new Set(goal.pinned.map((id) => at.get(id)!));
  const kept = new Set([...seeds, ...pins]);
  let st = emptyState(cards.length);
  for (const c of kept.size > 0 ? kept : startCard(s, p)) st = withCard(s, st, c, fitOf(s, st, c, p));
  // Quota fill: the highest fit first. A card can count for both quotas.
  const quotaCards = new Set<number>();
  const quotas: Array<[number, (c: DeckCard) => boolean]> = [
    [p.quotas.interaction[goal.interaction], (c) => c.interaction],
    [goal.min_creatures, (c) => c.creature],
  ];
  for (const [min, holds] of quotas) {
    while (quotaCount(s, st, holds, p) < min && copyTotal(s, st, p) < spellCopies) {
      const best = topCards(s, st, 1, p, (c) => holds(s.cards[c]!))[0];
      if (!best) break;
      quotaCards.add(best[0]);
      st = withCard(s, st, best[0], best[1]);
    }
  }
  // Expand: until a deck has its copies.
  let beam = [st];
  let done = copyTotal(s, st, p) >= spellCopies ? st : null;
  while (!done) {
    const next = beamStep(s, beam, p);
    if (next.length === 0) { done = beam[0]!; break; }
    done = next.find((x) => copyTotal(s, x, p) >= spellCopies) ?? null;
    beam = next;
  }
  const copies = assignCopies(s, done, kept, spellCopies, p);
  return [...copies].map(([c, n]) => {
    const role: SpellRole = seeds.has(c) ? 'seed' : pins.has(c) ? 'pin' : quotaCards.has(c) ? 'quota' : 'link';
    return { oracle_id: cards[c]!.oracle_id, copies: n, role, fit: fitOf(s, done, c, p) };
  }).sort((a, b) => {
    const x = cards[at.get(a.oracle_id)!]!;
    const y = cards[at.get(b.oracle_id)!]!;
    return x.cmc - y.cmc || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);
  });
}
