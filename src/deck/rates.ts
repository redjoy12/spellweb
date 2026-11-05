/**
 * The card rate of a deck (card rate plan Task 5). `card_rates` holds the rate of each spell for one
 * build. The rate comes from card text and the card record, so it is not a win rate. The search
 * reads it only when the goal has `use_rate`. It never changes a link or `weightOf`.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { RateReason } from '../rate/fit.js';
import type { DeckCard } from './assemble.js';
import { GoalError } from './goal.js';

/** What the owner must do when the table does not hold the build. */
export const RATE_FIX = 'Run npm run rate-fit';

export interface CardRate {
  /** Null is "no value": the search reads it as 0. */
  rate: number | null; role_gap: number | null;
  /** `no_row`: the table has no row for this card, or the text of the card changed after the fit. */
  reason: RateReason | 'no_row';
}

const NO_ROW: CardRate = { rate: null, role_gap: null, reason: 'no_row' };

/** True when `card_rates` holds the build. A write replaces the whole table, so it holds one build. */
export function rateReady(db: DatabaseSync, buildId: number): boolean {
  return db.prepare('SELECT 1 FROM card_rates WHERE build_id = ? LIMIT 1').get(buildId) !== undefined;
}

/** The rates of a build, or a `GoalError` that says what to run. A row of an older card text is left out. */
export function ratesOfBuild(db: DatabaseSync, buildId: number | undefined): Map<string, CardRate> {
  if (buildId === undefined || !rateReady(db, buildId)) throw new GoalError(`card_rates does not hold build ${buildId}. ${RATE_FIX}`);
  const rows = db.prepare(
    `SELECT r.oracle_id, r.rate, r.role_gap, r.reason FROM card_rates r
       JOIN cards c ON c.oracle_id = r.oracle_id AND c.oracle_hash = r.oracle_hash
      WHERE r.build_id = ?`,
  ).all(buildId) as unknown as Array<CardRate & { oracle_id: string }>;
  return new Map(rows.map(({ oracle_id, ...rate }) => [oracle_id, rate]));
}

/** `cards` with the rate of each card. */
export function withRates(cards: readonly DeckCard[], rates: ReadonlyMap<string, CardRate>): DeckCard[] {
  return cards.map((c) => ({ ...c, rate: rates.get(c.oracle_id) ?? NO_ROW }));
}
