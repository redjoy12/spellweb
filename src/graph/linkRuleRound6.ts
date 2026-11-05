/**
 * Round 6 of the owner pairs (docs/schema-v20-results.md sec. 16): a test of the golden labels, not of
 * a kind of link. The owner set the line "no means no link at all" on 2026-10-31, after the golden
 * check of 2026-10-24, and five of six "no" answers that were asked again became real links
 * (docs/schema-v17-results.md sec. 15.4).
 *
 * The pairs are the golden pairs with no `correction` stratum, the label `none` and a confirmed `+`
 * edge: the score counts each one as an error of the app. `owner_no`: the owner gave the label.
 * `labeler_none`: an isolated labeler gave it, and the owner never saw the pair. The page never gets
 * a kind.
 *
 * An answer changes nothing at once. `--tally` shows the labels and the score that the answers give.
 * A real answer is "yes" or "weak", as in `tallyRound2`. "Not sure" and "other" do not count.
 *
 * The result rule, set before the answers: when at least 25% of the counted `owner_no` answers are
 * real, a test with only "no" answers can fall under the 75% bar of the link gate, so the 27 `no_link`
 * answers of round 1 are asked again. With fewer, the earlier "no" answers stand. Each answer of
 * `labeler_none` sets the label of its pair, and no rule reads this kind.
 */
import type { DatabaseSync } from 'node:sqlite';
import { REMOVE_SHARE, type Round2Answer } from './linkRuleRound2.js';
import { shuffle, type LinkPair } from './linkRuleV2.js';
import type { PairResult } from './score.js';

export type Round6Kind = 'owner_no' | 'labeler_none';
export const ROUND_6_ORDER: readonly Round6Kind[] = ['owner_no', 'labeler_none'];
/** The share of real answers that can move a test with only "no" answers under the bar. */
export const CHANGED_SHARE = 1 - REMOVE_SHARE;
/** At least 80% of the `owner_no` pairs must have a counted answer, as in the 8 of 10 of the earlier rounds. */
export const ROUND_6_MIN_COUNTED = 0.8;

type GoldenLabel = PairResult['label'];
export interface Round6Pair extends LinkPair<Round6Kind> { golden_pair: number }

const toKind = (status: string): Round6Kind => (status === 'accepted' ? 'labeler_none' : 'owner_no');

/** The pairs of the round, in random order, so the kinds mix on the page. */
export function round6Pairs(results: readonly PairResult[], rows: ReadonlyArray<{ id: number; supply_oracle: string; demand_oracle: string; status: string }>, rand: () => number): Round6Pair[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pairs = results.filter((p) => p.stratum !== 'correction' && p.label === 'none' && p.confirmed.includes('+')).map((p) => {
    const r = byId.get(p.pair_id)!;
    return { kind: toKind(r.status), supply: r.supply_oracle, demand: r.demand_oracle, golden_pair: p.pair_id };
  });
  return shuffle(pairs, rand);
}

export function loadRound6Rows(db: DatabaseSync) {
  return db.prepare('SELECT id, supply_oracle, demand_oracle, status FROM edge_golden_pairs').all() as Array<{ id: number; supply_oracle: string; demand_oracle: string; status: string }>;
}

export interface Round6Row {
  kind: Round6Kind; asked: number; yes: number; weak: number; no: number; anti: number; unsure: number; other: number; open: number;
  /** "Yes", "weak", "no" and "works against". */
  counted: number; real_share: number; result: string;
}

export function tallyRound6(pairs: ReadonlyArray<{ key: string; kind: string }>, answers: ReadonlyMap<string, Round2Answer>): Round6Row[] {
  return ROUND_6_ORDER.map((kind) => {
    const got = pairs.filter((p) => p.kind === kind).map((p) => answers.get(p.key)?.choice);
    const count = (c: string) => got.filter((x) => x === c).length;
    const [yes, weak, no, anti] = [count('link'), count('weak_link'), count('no_link'), count('anti')];
    const open = got.filter((x) => x === undefined).length;
    const counted = yes + weak + no + anti;
    const realShare = counted ? (yes + weak) / counted : 0;
    const result = kind === 'labeler_none' ? '-'
      : open > 0 ? 'wait'
        : counted < ROUND_6_MIN_COUNTED * got.length ? 'ask again'
          : realShare >= CHANGED_SHARE ? 'ask round 1 again' : 'the answers stand';
    return { kind, asked: got.length, yes, weak, no, anti, unsure: count('unsure'), other: count('other'), open, counted, real_share: realShare, result };
  });
}

const NEW_LABELS: Readonly<Record<string, GoldenLabel>> = { link: 'synergy', weak_link: 'synergy', no_link: 'none', anti: 'anti' };

/** The label that each answer gives. "Not sure", "other" and an open pair keep the old label. */
export function round6Labels(pairs: ReadonlyArray<{ key: string; golden_pair?: number }>, answers: ReadonlyMap<string, Round2Answer>): Map<number, GoldenLabel> {
  const out = new Map<number, GoldenLabel>();
  for (const p of pairs) {
    const label = NEW_LABELS[answers.get(p.key)?.choice ?? ''];
    if (label && p.golden_pair !== undefined) out.set(p.golden_pair, label);
  }
  return out;
}

/** Confirmed precision on the pairs with no `correction` stratum, with each new label in place of the old one. */
export function oldPairPrecision(results: readonly PairResult[], labels: ReadonlyMap<number, GoldenLabel> = new Map()): { correct: number; total: number } {
  let correct = 0; let total = 0;
  for (const p of results) {
    if (p.stratum === 'correction') continue;
    const label = labels.get(p.pair_id) ?? p.label;
    for (const pol of p.confirmed) {
      total++;
      if (label === (pol === '+' ? 'synergy' : 'anti')) correct++;
    }
  }
  return { correct, total };
}
