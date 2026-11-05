/**
 * Round 5 of the owner pairs (docs/schema-v20-results.md sec. 10 and 12): the two largest open items
 * of build 26. No owner answer tests them. The page never gets a kind.
 *
 * `would_die`: pairs into the 7 cards that lost `CARES_ABOUT.PERMANENT_DIES` on "would die this turn,
 * exile it instead" (run 28). The pair has a confirmed `+` edge into that atom on build 25 and no `+`
 * edge on build 26, so it is not a link now. The answers test this loss.
 *
 * `removal_new`, `removal_old`: pairs of the `-` rule ER-2647 on build 26. Each `-` edge of the pair
 * has only this rule, and the pair has no `+` edge, so that an answer speaks for the rule only.
 * `removal_new`: the rule did not reach the pair on build 25. A change to the rule acts on all its
 * pairs, so the two groups are one kind of the result rule.
 *
 * On a `-` link the real answer is "works against": `minus` in ROUND_5_KINDS reverses the count of
 * `tallyRound2`. Nothing here reads a grade: a `-` edge goes in `confirmed` at each grade, because the
 * open item counts both.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { BuildIndex } from './buildIndex.js';
import { pairKey, pairRecords, type PairRecord } from './linkRuleRound2.js';
import { requireDraw, tagEdgeGroup } from './linkRuleRound3.js';
import { mergeEdges } from './merge.js';

/** The build before run 28. */
export const ROUND_5_BASE = 25;
export const WOULD_DIE_TAG = 'CARES_ABOUT.PERMANENT_DIES';
/** The demand atoms of build 25 that run 28 removed. Each is the only atom of the tag on its card. */
export const WOULD_DIE_ATOMS: ReadonlySet<number> = new Set([47683, 47923, 49017, 50022, 52193, 52303, 55965]);
export const MINUS_RULE = 'ER-2647';

/** The groups of the sample, in the draw order. */
export const ROUND_5_COUNTS = { would_die: 10, removal_new: 5, removal_old: 5 } as const;
export type Round5Group = keyof typeof ROUND_5_COUNTS;
export const ROUND_5_ORDER = Object.keys(ROUND_5_COUNTS) as Round5Group[];
/** The result rule of plan schema v17 Task 7 step 5: at least 8 counted new answers of 10. */
export const ROUND_5_KINDS = {
  would_die: { groups: ['would_die'], min_counted: 8 },
  removal_count: { groups: ['removal_new', 'removal_old'], min_counted: 8, minus: true },
};
export const requireRound5Draw = (pairs: ReadonlyArray<{ kind: string }>) => requireDraw(pairs, ROUND_5_COUNTS);

/** The `+` edges of build 25, on pairs into the 7 cards with no `+` edge on `after`. */
export function wouldDieRecords(base: BuildIndex, after: BuildIndex): Map<string, PairRecord> {
  const cards = new Set([...WOULD_DIE_ATOMS].map((id) => base.atoms.get(id)!.oracle_id));
  const linked = pairRecords(after);
  return new Map([...pairRecords(base, tagEdgeGroup(WOULD_DIE_TAG))].filter(([k]) => cards.has(k.split('>')[1]!) && !linked.has(k)));
}

/** One merged edge, with each supply card of a class edge. */
export interface PairEdge { polarity: '+' | '-'; rule_hashes: readonly string[]; supplies: readonly string[]; demand: string }

/** `reached`: the pairs with a `-` edge of the rule. `records`: `tag` for a `-` edge of this rule alone, and `other` for each other edge. */
export interface MinusRulePairs { records: Map<string, PairRecord>; reached: Set<string> }

export function minusRuleRecords(edges: Iterable<PairEdge>, rule: string): MinusRulePairs {
  const records = new Map<string, PairRecord>();
  const reached = new Set<string>();
  for (const e of edges) {
    const own = e.polarity === '-' && e.rule_hashes.includes(rule);
    const group = own && e.rule_hashes.length === 1 ? 'tag' : 'other';
    for (const s of e.supplies) {
      if (s === e.demand) continue;
      const k = pairKey(s, e.demand);
      (records.get(k) ?? records.set(k, { confirmed: new Set(), plausible: new Set(), open: false, wide: false }).get(k)!).confirmed.add(group);
      if (own) reached.add(k);
    }
  }
  return { records, reached };
}

function* pairEdges(index: BuildIndex): Iterable<PairEdge> {
  for (const c of index.cards()) {
    const ae = index.cardAtomEdges(c);
    for (const e of [...mergeEdges(ae.supply, index.ctx), ...mergeEdges(ae.classes, index.ctx)]) {
      yield { polarity: e.polarity, rule_hashes: e.rule_hashes, demand: e.demand_oracle, supplies: e.class_id === null ? [e.supply_oracle!] : [...index.classes.get(e.class_id)!.members] };
    }
  }
}

/** The two parts of the `-` pairs of a rule: `isTagPair` then gives the pool of each part. */
export function splitByReach(now: MinusRulePairs, before: MinusRulePairs): { fresh: Map<string, PairRecord>; old: Map<string, PairRecord> } {
  return {
    fresh: new Map([...now.records].filter(([k]) => !before.reached.has(k))),
    old: new Map([...now.records].filter(([k]) => before.reached.has(k))),
  };
}

/** The record map of each group. Read `tagPool` or `isTagPair` on it. */
export function round5Records(db: DatabaseSync, base: BuildIndex, after: BuildIndex, afterId: number): Map<Round5Group, Map<string, PairRecord>> {
  const row = db.prepare('SELECT r.rule_hash FROM edge_rules r JOIN graph_builds b ON b.rule_set_id = r.set_id WHERE b.id = ? AND r.rule_id = ?').get(afterId, MINUS_RULE) as { rule_hash: string } | undefined;
  if (!row) throw new Error(`build ${afterId} has no rule ${MINUS_RULE}`);
  const { fresh, old } = splitByReach(minusRuleRecords(pairEdges(after), row.rule_hash), minusRuleRecords(pairEdges(base), row.rule_hash));
  return new Map<Round5Group, Map<string, PairRecord>>([['would_die', wouldDieRecords(base, after)], ['removal_new', fresh], ['removal_old', old]]);
}
