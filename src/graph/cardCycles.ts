/**
 * The cycle request of one card (Phase 3 spec sec. 9.2): the engine search, then the full
 * search, each with its tiers. The explorer (Task 7) shows the engine list first, then the
 * cycles of the full search that the engine list does not have. Each list is sorted by
 * sortCycles.
 */
import { cycleBalance, type BalanceContext } from './balance.js';
import type { BuildIndex } from './buildIndex.js';
import { cycleGraph, type CycleGraph } from './cycleGraph.js';
import { bestCycles, cycleKey, type Cycle, type SearchResult } from './cycles.js';
import { sortCycles, tierOf, type Tier, type UnresolvedCause } from './tiers.js';

export interface Limits { maxLength: number; topK: number; budget: number }

export type TieredCycle = Cycle & { tier: Tier; unresolved: UnresolvedCause[]; has_plausible: boolean; per_turn_limit: boolean };

export interface SearchOut extends Omit<SearchResult, 'cycles'> { cycles: TieredCycle[]; ms: number }

export interface CardCycles {
  engine: SearchOut;
  /** The full search; `cycles` has only the cycles that are not in the engine list. */
  full: SearchOut;
  /** The engine search kept K cycles: "more engine cycles can exist" (sec. 9.2). */
  more_engine: boolean;
}

/** The two graphs of one index; make them once and use them for many cards. */
export interface CycleGraphs { engine: CycleGraph; full: CycleGraph }

export function cycleGraphs(index: BuildIndex, confirmedOnly = false): CycleGraphs {
  return {
    engine: cycleGraph(index, { confirmedOnly, engineOnly: true }),
    full: cycleGraph(index, { confirmedOnly, engineOnly: false }),
  };
}

/** The groups of a card that hold atoms, sorted. */
export function cardGroups(index: BuildIndex, oracleId: string): string[] {
  return [...new Set(index.atomsOfCard(oracleId).map((a) => a.group))].sort();
}

function run(g: CycleGraph, start: string[], limits: Limits, balance: BalanceContext): SearchOut {
  const t0 = performance.now();
  const r = bestCycles(g, start, limits);
  const ms = performance.now() - t0;
  const cycles = r.cycles.map((c) => ({ ...c, ...tierOf(c, g.nodes, cycleBalance(c, balance)) }));
  return { ...r, cycles: sortCycles(cycles), ms };
}

export function cardCycles(index: BuildIndex, graphs: CycleGraphs, balance: BalanceContext, oracleId: string, limits: Limits): CardCycles {
  const start = cardGroups(index, oracleId);
  const engine = run(graphs.engine, start, limits, balance);
  const full = run(graphs.full, start, limits, balance);
  const inEngine = new Set(engine.cycles.map(cycleKey));
  return {
    engine, full: { ...full, cycles: full.cycles.filter((c) => !inEngine.has(cycleKey(c))) }, more_engine: engine.kept_k,
  };
}
