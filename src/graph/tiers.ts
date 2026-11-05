/**
 * The tier of a cycle (Phase 3 spec sec. 9.4-9.5). The first row that applies, from tier 3 to
 * tier 1, gives the tier:
 * - tier 3: all tier-2 conditions, and no per-turn limit, no unknown limit, a value increase, all
 *   amounts known, no unparsed cost, all edges `confirmed`;
 * - tier 2: all groups `triggered` or `activated`, and no consumed resource with a known
 *   negative balance;
 * - tier 1: all other cycles.
 *
 * An unknown balance counts as "not negative", so the tier is the highest tier that the known
 * values permit. The `unresolved` causes are the unknown values that have an effect on the tier:
 * - an unknown consumed balance, when the tier is 2 (it could be 1);
 * - each unknown tier-3 condition, when the tier is 2 and no known fact stops tier 3 (a per-turn
 *   limit, or no value dimension that increases or is unknown).
 * A tier-1 cycle has no causes: no unknown value can lower it. A tier-3 cycle has none, because
 * tier 3 needs all values known.
 *
 * Project decision: "no proved increase of a value dimension" is a cause only when a value
 * resource has an unknown balance. When all amounts are known and none increases, the cycle
 * fails the tier-3 test on known facts.
 */
import type { BalanceEntry } from './balance.js';
import type { CycleGraph } from './cycleGraph.js';
import { compareCycles, type Cycle } from './cycles.js';

export type Tier = 1 | 2 | 3;
export type UnresolvedCause = 'unknown_amount' | 'unknown_limit' | 'unparsed_cost' | 'plausible_edge' | 'no_value_increase';

export function tierOf(c: Cycle, nodes: CycleGraph['nodes'], balance: ReadonlyMap<string, BalanceEntry>):
  { tier: Tier; unresolved: UnresolvedCause[]; has_plausible: boolean; per_turn_limit: boolean } {
  const groups = c.groups.map((k) => {
    const n = nodes.get(k);
    if (!n) throw new Error(`cycle group ${k} is not a node of the graph`);
    return n;
  });
  const has_plausible = c.edges.some((e) => e.grade === 'plausible');
  const per_turn_limit = groups.some((g) => g.per_turn_limit);
  const entries = [...balance.values()];
  const engine = groups.every((g) => g.kind === 'triggered' || g.kind === 'activated');
  const knownNegative = entries.some((e) => e.kind === 'cost' && e.net !== 'unknown' && e.net < 0);
  if (!engine || knownNegative) return { tier: 1, unresolved: [], has_plausible, per_turn_limit };

  const unknownConsumed = entries.some((e) => e.kind === 'cost' && e.net === 'unknown');
  const anyUnknown = entries.some((e) => e.net === 'unknown');
  const unknownLimit = groups.some((g) => g.unknown_limit);
  const unparsed = groups.some((g) => g.cost_unparsed);
  const increase = entries.some((e) => e.value && e.net !== 'unknown' && e.net > 0);
  const maybeIncrease = entries.some((e) => e.value && e.net === 'unknown');

  if (!per_turn_limit && !unknownLimit && increase && !anyUnknown && !unparsed && !has_plausible) {
    return { tier: 3, unresolved: [], has_plausible, per_turn_limit };
  }
  const stopped = per_turn_limit || (!increase && !maybeIncrease);
  const causes = new Set<UnresolvedCause>();
  if (unknownConsumed) causes.add('unknown_amount');
  if (!stopped) {
    if (anyUnknown) causes.add('unknown_amount');
    if (unknownLimit) causes.add('unknown_limit');
    if (unparsed) causes.add('unparsed_cost');
    if (has_plausible) causes.add('plausible_edge');
    if (!increase) causes.add('no_value_increase');
  }
  const order: UnresolvedCause[] = ['unknown_amount', 'unknown_limit', 'unparsed_cost', 'plausible_edge', 'no_value_increase'];
  return { tier: 2, unresolved: order.filter((x) => causes.has(x)), has_plausible, per_turn_limit };
}

/** spec sec. 9.2: the tier from high to low, cycles without `unresolved` first, the score, the edge keys. */
export function sortCycles<T extends Cycle & { tier: Tier; unresolved: UnresolvedCause[] }>(list: T[]): T[] {
  return [...list].sort((a, b) => b.tier - a.tier
    || Number(a.unresolved.length > 0) - Number(b.unresolved.length > 0)
    || compareCycles(a, b));
}
