/**
 * A swap of the deck chat (design sec. 3 and 5): the deck with only the named cards changed. The
 * search does not run. The colour sources, the warnings and the links are computed again on the
 * given build. The lands stay the same unless the swap names a land.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { BuildIndex } from '../graph/buildIndex.js';
import { deckCards, type SpellSlot } from './assemble.js';
import { checkLegal, deckWarnings } from './check.js';
import { storedGoal } from './goal.js';
import { justifyDeck, type DeckView } from './justify.js';
import { COLOURS, colourNeeds, curveTurn, type ColourCounts, type LandSlot } from './manaBase.js';
import type { PairTable } from './pairs.js';
import type { DeckPolicy } from './policy.js';
import { rateReady, ratesOfBuild, withRates } from './rates.js';

export interface SwapCard { oracle_id: string; name: string; copies: number }
export interface Swap { out: SwapCard[]; in: SwapCard[] }

/** A swap that does not fit the deck. The tool gives this message to Claude, and the route to the owner. */
export class SwapError extends Error {}

/** The sources of each colour: a land counts for each colour of its mana atoms, and "any" is each colour. */
function landSources(idx: BuildIndex, lands: readonly LandSlot[]): ColourCounts {
  const out: ColourCounts = { B: 0, R: 0 };
  for (const l of lands) {
    const colours = idx.atomsOfCard(l.oracle_id).filter((a) => a.family === 'PRODUCES' && a.type_key === 'MANA_PRODUCTION').map((a) => a.params['color']);
    for (const c of COLOURS) if (colours.includes(c) || colours.includes('any')) out[c] += l.copies;
  }
  return out;
}

/** The deck after `swap`. A fault gives a `SwapError` or a `LegalityError`, and nothing changes. */
export function swappedDeck(db: DatabaseSync, idx: BuildIndex, t: PairTable, view: DeckView, swap: Swap, buildId: number, policySha: string, p: DeckPolicy): DeckView {
  const goal = storedGoal(view.goal);
  const named = new Set(swap.in.map((c) => c.oracle_id));
  const both = swap.out.find((c) => named.has(c.oracle_id));
  if (both) throw new SwapError(`${both.name} cannot both leave and enter the deck`);
  const copies = new Map(view.cards.map((c) => [c.oracle_id, c.copies]));
  for (const c of swap.out) {
    const have = copies.get(c.oracle_id) ?? 0;
    if (have < c.copies) throw new SwapError(`the deck has ${have} ${have === 1 ? 'copy' : 'copies'} of ${c.name}, not ${c.copies}`);
    copies.set(c.oracle_id, have - c.copies);
  }
  for (const c of swap.in) copies.set(c.oracle_id, (copies.get(c.oracle_id) ?? 0) + c.copies);

  const listed = deckCards(db, idx, goal.colours);
  const pool = goal.use_rate && rateReady(db, buildId) ? withRates(listed, ratesOfBuild(db, buildId)) : listed;
  const cards = new Map(pool.map((c) => [c.oracle_id, c]));
  const roles = new Map(view.cards.map((c) => [c.oracle_id, c.role]));
  const spells: SpellSlot[] = [];
  const lands: LandSlot[] = [];
  for (const [id, n] of copies) {
    if (n === 0) continue;
    const card = cards.get(id);
    if (card?.land) lands.push({ oracle_id: id, copies: n, kind: card.type_line.startsWith('Basic Land') ? 'basic' : 'dual' });
    else {
      const role = roles.get(id);
      spells.push({ oracle_id: id, copies: n, role: role === undefined || role === 'land' ? 'swap' : role, fit: 0 });
    }
  }
  const landCount = lands.reduce((s, l) => s + l.copies, 0);
  const sources = landSources(idx, lands);
  const shell = { spells, mana: { ...view.mana, land_count: landCount, sources, lands }, loops: view.loops, stable: view.stable };
  // A card that the pool does not have is not legal, so this check runs before the pool is read again.
  checkLegal(db, shell, goal, p);

  const spellCards = spells.map((s) => cards.get(s.oracle_id)!);
  const needs = colourNeeds(spellCards, p);
  const turn = curveTurn(spells.flatMap((s, i) => Array<number>(s.copies).fill(spellCards[i]!.cmc)), p);
  const mana = { ...shell.mana, needs, turn, short: COLOURS.some((c) => sources[c] < needs[c]) };
  const built = { ...shell, mana };
  return justifyDeck(db, idx, t, { ...built, goal, cards, warnings: deckWarnings(built, cards, goal, t, p) }, buildId, policySha, p);
}
