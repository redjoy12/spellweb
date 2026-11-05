/**
 * One deck from one goal (Phase 4 design sec. 5): the steps in order, for the CLI and the API.
 * It reads the pool, the build and the pair table, and it writes nothing.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { BuildIndex } from '../graph/buildIndex.js';
import { candidates, deckCards, type DeckCard } from './assemble.js';
import { checkLegal, deckWarnings, type DeckWarning } from './check.js';
import { checkGoal, GoalError, type Goal } from './goal.js';
import { activeOwnerLinks, withOwnerLinks } from './linkChanges.js';
import { buildCards, landOptions, type BuiltCards } from './manaBase.js';
import { pairTable, withWeakPairs, type PairTable } from './pairs.js';
import type { DeckPolicy } from './policy.js';
import { ratesOfBuild, withRates } from './rates.js';

export interface MadeDeck extends BuiltCards {
  goal: Goal; warnings: DeckWarning[];
  /** The cards of the form colours, by ID, with the lands. */
  cards: Map<string, DeckCard>;
}

/** The newest build. Phase 4 runs on it (design sec. 11). */
export function newestBuild(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(id) AS id FROM graph_builds').get() as { id: number | null };
  if (row.id === null) throw new Error('there is no graph build');
  return row.id;
}

/**
 * The `supply>demand` pairs whose newest owner answer is "Yes, but weak". A pair can have answers
 * in two rounds, so the newest answer decides. A golden check answer has a golden pair ID as its
 * key, so those weak answers come from the note on the golden pair.
 */
export function weakPairKeys(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT item_key, choice FROM owner_decisions ORDER BY decided_at').all() as Array<{ item_key: string; choice: string }>;
  const newest = new Map<string, string>();
  for (const r of rows) {
    const pair = /[0-9a-f-]{36}>[0-9a-f-]{36}$/.exec(r.item_key)?.[0];
    if (pair) newest.set(pair, r.choice);
  }
  const golden = db.prepare("SELECT supply_oracle, demand_oracle FROM edge_golden_pairs WHERE owner_note LIKE '%weak_link%'").all() as Array<{ supply_oracle: string; demand_oracle: string }>;
  for (const g of golden) if (!newest.has(`${g.supply_oracle}>${g.demand_oracle}`)) newest.set(`${g.supply_oracle}>${g.demand_oracle}`, 'weak_link');
  return new Set([...newest].filter(([, choice]) => choice === 'weak_link').map(([pair]) => pair));
}

/** The pair table of every spell that a goal of the build scope can use, without the weak answers. */
export function scopePairTable(db: DatabaseSync, idx: BuildIndex): PairTable {
  const scope = idx.build?.scope;
  if (!scope) throw new Error('the pair table needs an index that BuildIndex.load made');
  return pairTable(idx, deckCards(db, idx, scope).filter((c) => !c.land).map((c) => c.oracle_id));
}

/**
 * `t` with the owner answers of this moment: the weak answers, then the owner links of the link
 * review (design 2026-11-03 sec. 8), so an owner link sets its own weight. It takes no build, so each
 * deck reads new answers.
 */
export function withWeakAnswers(db: DatabaseSync, t: PairTable, p: DeckPolicy): PairTable {
  const weak = withWeakPairs(t, { keys: weakPairKeys(db), factor: p.score.weak_factor });
  return withOwnerLinks(weak, activeOwnerLinks(db), p.score.owner_link_weight, p.score.weak_factor);
}

/** Design sec. 5 steps 1 to 7. A bad goal gives a `GoalError`, and a failed legality check gives a `LegalityError`. */
export function makeDeck(db: DatabaseSync, idx: BuildIndex, t: PairTable, input: unknown, p: DeckPolicy): MadeDeck {
  const goal = checkGoal(db, input, p);
  const scope = idx.build?.scope;
  if (scope && ![...goal.colours].every((c) => scope.includes(c))) throw new GoalError(`the colours ${goal.colours} are outside the build scope ${scope}`);
  const listed = deckCards(db, idx, goal.colours);
  const pool = goal.use_rate ? withRates(listed, ratesOfBuild(db, idx.build?.id)) : listed;
  const cards = new Map(pool.map((c) => [c.oracle_id, c]));
  const built = buildCards(candidates(pool, goal), goal, t, landOptions(db, idx, pool, goal, p), p);
  checkLegal(db, built, goal, p);
  return { ...built, goal, cards, warnings: deckWarnings(built, cards, goal, t, p) };
}
