/**
 * Atom prices and the card rate (card rate plan Task 4). A ridge fit of printed mana value on the
 * atoms and size fields of a spell gives each column a price in mana. A residual first loses the
 * median of its printed mana bin, and then the median of the best group of the card (plan sec. 2.4,
 * a change to the formula of the report). The fit has no model, no random draw and no `rarity`, so
 * one database gives one set of values. Speed has no column, because it is an order, not a price.
 * The rate is not a win rate. Only `writeRates` changes a table.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AtomFields } from './fields.js';
import { isCostAtom, kindKey, makeGroups, rewardTest, type AtomTest, type GroupInput, type RewardAtom, type RewardGroup } from './groups.js';
import type { CardClass, CardClassName, ProofCard, ProofFace } from './proof.js';

/** The ridge strengths to test. Each has a price scale in mana, because the columns keep their units. */
export const LAMBDAS: readonly number[] = [0.03, 0.1, 0.3, 1, 3, 10, 30, 100, 300];
export const FOLDS = 5;
/** Plan sec. 2.3: a group of fewer cards gives a noisy median. */
export const MIN_GROUP = 5;
/** Report: a gap under this size is noise. */
export const GAP_LINE = 1;
/**
 * The largest size that a column reads. One very large printed number, such as -0/-9999 or 1,000
 * life, otherwise sets the price of its whole column. A cap of 5 to 30 gives almost the same
 * held-out error, and with no cap the fit fails the result rule.
 */
export const SIZE_CAP = 10;
/** Plan sec. 2.3: the result rule. */
export const MAX_ERROR = 1.5;
/** Plan sec. 2.4: the largest absolute correlation of `role_gap` with printed mana. */
export const MAX_CORRELATION = 0.15;

export type NoValueReason = 'x_cost' | 'face_no_cost' | 'no_cost';
export type RateReason = NoValueReason | 'no_group' | 'under_line' | 'no_penalty' | 'gap';

const typeName = (a: Pick<RewardAtom, 'family' | 'type_key'>) => `${a.family}.${a.type_key}`;
const REMOVAL = 'INTERACTION.TARGETED_REMOVAL';

/** The mana value of one cost. Null: the cost has `{X}`, or it is empty. `{2/R}` counts its larger part, and `{B/R}` counts 1. */
export function manaValue(cost: string | null): number | null {
  if (!cost) return null;
  let total = 0;
  for (const [, symbol] of cost.matchAll(/\{([^}]+)\}/g)) {
    if (symbol === 'X') return null;
    total += Math.max(...symbol!.split('/').map((p) => (/^\d+$/.test(p) ? Number(p) : 1)));
  }
  return total;
}

/** The mana values of the faces with a cost, added. A split card has this value in `cards.cmc`. Other cards with two costs have the front value there. */
export const printedMana = (faces: readonly Pick<ProofFace, 'mana_cost'>[]): number =>
  faces.reduce((s, f) => s + (manaValue(f.mana_cost) ?? 0), 0);

/** One row of the fit: what one mana cost pays for. */
export interface FitRow { oracle_id: string; mana: number; card: Pick<ProofCard, 'atoms' | 'fields' | 'faces'> }

/** Plan sec. 2.1, Q5: each cost pays for the atoms of its own face, so a card with two costs has two rows. */
export function fitRows(card: ProofCard): FitRow[] {
  const costed = card.faces.filter((f) => f.mana_cost);
  if (costed.length < 2) return [{ oracle_id: card.oracle_id, mana: printedMana(costed), card }];
  return costed.map((f) => ({
    oracle_id: card.oracle_id, mana: printedMana([f]), card: { ...card, faces: [f], atoms: card.atoms.filter((a) => a.face_index === f.face_index) },
  }));
}

/** Why a card stays out of the fit (plan sec. 2.1 Q5, sec. 2.3), or null when it is in the fit. */
export function noValueReason(card: Pick<ProofCard, 'faces' | 'atoms'>, reward: AtomTest): NoValueReason | null {
  if (card.faces.some((f) => f.mana_cost?.includes('{X}'))) return 'x_cost';
  const cost = new Map(card.faces.map((f) => [f.face_index, f.mana_cost]));
  if (card.atoms.some((a) => reward(a) && !cost.get(a.face_index))) return 'face_no_cost';
  return card.faces.some((f) => f.mana_cost) ? null : 'no_cost';
}

/** The sizes of one atom. A key that is absent does not apply. A null is a size that the rule cannot read. */
function atomSizes(a: RewardAtom, f: AtomFields | undefined): Record<string, number | null> {
  const sizes: Record<string, number | null> = {};
  const abs = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.abs(n));
  const amount = a.params['amount'];
  if (amount !== undefined && amount !== null && amount !== '') sizes['amount'] = typeof amount === 'number' ? amount : null;
  const type = typeName(a);
  if (type === 'COMBAT.STAT_CHANGE' || (type === REMOVAL && a.params['removal_type'] === 'minus')) {
    sizes['stat_power'] = abs(f?.stat_power);
    sizes['stat_toughness'] = abs(f?.stat_toughness);
  }
  if (type === 'PRODUCES.CREATE') {
    sizes['token_power'] = f?.token_power ?? null;
    sizes['token_toughness'] = f?.token_toughness ?? null;
  }
  if (type === 'PRODUCES.MANA_PRODUCTION') sizes['mana_amount'] = f?.mana_amount ?? null;
  if (type === REMOVAL && f?.target_limit) sizes['limited'] = f.target_limit.limit === null ? 0 : 1;
  return sizes;
}

/**
 * A cost is not the same thing as a reward of the same type. A -1/-1 counter is not a +1/+1 counter
 * (plan sec. 2.4), and a counter that a card "enters with" is not one that it puts on something else
 * (plan sec. 2.5). Each has its own price.
 */
function atomColumn(a: Pick<RewardAtom, 'family' | 'type_key' | 'params' | 'quote'>): string {
  const counter = a.params['counter_type'];
  const kind = typeof counter === 'string' ? `[${counter}]${/\benters with\b/i.test(a.quote) ? ':enters' : ''}` : '';
  return `${typeName(a)}${kind}${isCostAtom(a) ? ':cost' : ''}`;
}

/**
 * The columns of one fit row (plan sec. 2.3). Atoms of one type with one quote are one effect, so
 * `{B} or {R}` is one mana, not two. A read size adds to the column `type#size`, up to `SIZE_CAP`.
 * An unread size adds 1 to `type#size?`, which has its own price, so it gets no default number.
 */
export function features(card: Pick<ProofCard, 'atoms' | 'fields' | 'faces'>): Map<string, number> {
  const row = new Map<string, number>();
  const add = (k: string, v: number) => { if (v !== 0) row.set(k, (row.get(k) ?? 0) + v); };
  const effects = new Map<string, { column: string; atoms: RewardAtom[] }>();
  for (const a of card.atoms) {
    const column = atomColumn(a);
    const key = JSON.stringify([column, a.face_index, a.quote]);
    const e = effects.get(key);
    if (e) e.atoms.push(a); else effects.set(key, { column, atoms: [a] });
  }
  for (const { column, atoms } of effects.values()) {
    add(column, 1);
    const sizes = new Map<string, number | null>();
    for (const a of atoms) {
      for (const [k, v] of Object.entries(atomSizes(a, card.fields.get(a.id)))) {
        const old = sizes.get(k);
        sizes.set(k, old === undefined || old === null ? v : v === null ? old : Math.max(old, v));
      }
    }
    for (const [k, v] of sizes) add(`${column}#${k}${v === null ? '?' : ''}`, Math.min(v ?? 1, SIZE_CAP));
  }
  for (const f of card.faces) {
    if (!f.mana_cost || !/\bCreature\b/.test(f.type_line)) continue;
    add('body#creature', 1);
    const read = (k: string, s: string | null) => { if (s !== null && /^\d+$/.test(s)) add(`body#${k}`, Math.min(Number(s), SIZE_CAP)); else add(`body#${k}?`, 1); };
    read('power', f.power);
    read('toughness', f.toughness);
  }
  return row;
}

/** One row of the design matrix, as pairs of column index and value. */
export type SparseRow = ReadonlyArray<readonly [number, number]>;
export interface Design { columns: string[]; rows: SparseRow[] }

/** The columns are in sorted order, so the fit does not depend on the order of a read. */
export function designMatrix(rows: ReadonlyArray<ReadonlyMap<string, number>>): Design {
  const columns = [...new Set(rows.flatMap((r) => [...r.keys()]))].sort();
  const at = new Map(columns.map((c, i) => [c, i]));
  return { columns, rows: rows.map((r) => [...r].map(([k, v]) => [at.get(k)!, v] as const).sort((a, b) => a[0] - b[0])) };
}

export interface RidgeFit { intercept: number; prices: Float64Array }

/** The centred normal equations of a set of rows. The centre leaves the intercept out of the penalty. */
interface Normal { xtx: Float64Array; xty: Float64Array; means: Float64Array; yMean: number; p: number }

function normalEquations(rows: readonly SparseRow[], y: readonly number[], p: number, use: readonly number[]): Normal {
  const xtx = new Float64Array(p * p);
  const xty = new Float64Array(p);
  const means = new Float64Array(p);
  let yMean = 0;
  for (const i of use) {
    yMean += y[i]!;
    for (const [c, v] of rows[i]!) {
      means[c]! += v;
      xty[c]! += v * y[i]!;
      for (const [d, w] of rows[i]!) xtx[c * p + d]! += v * w;
    }
  }
  const n = use.length;
  yMean /= n;
  for (let c = 0; c < p; c++) means[c]! /= n;
  for (let c = 0; c < p; c++) {
    xty[c]! -= n * means[c]! * yMean;
    for (let d = 0; d < p; d++) xtx[c * p + d]! -= n * means[c]! * means[d]!;
  }
  return { xtx, xty, means, yMean, p };
}

/** Solves (XtX + lambda I) b = Xty by a Cholesky split. The penalty makes the matrix positive. */
function solveRidge({ xtx, xty, means, yMean, p }: Normal, lambda: number): RidgeFit {
  const l = Float64Array.from(xtx);
  for (let c = 0; c < p; c++) l[c * p + c]! += lambda;
  for (let c = 0; c < p; c++) {
    for (let d = 0; d <= c; d++) {
      let s = l[c * p + d]!;
      for (let k = 0; k < d; k++) s -= l[c * p + k]! * l[d * p + k]!;
      l[c * p + d] = c === d ? Math.sqrt(s) : s / l[d * p + d]!;
    }
  }
  const b = Float64Array.from(xty);
  for (let c = 0; c < p; c++) {
    for (let k = 0; k < c; k++) b[c]! -= l[c * p + k]! * b[k]!;
    b[c]! /= l[c * p + c]!;
  }
  for (let c = p - 1; c >= 0; c--) {
    for (let k = c + 1; k < p; k++) b[c]! -= l[k * p + c]! * b[k]!;
    b[c]! /= l[c * p + c]!;
  }
  let intercept = yMean;
  for (let c = 0; c < p; c++) intercept -= b[c]! * means[c]!;
  return { intercept, prices: b };
}

const allIndexes = (n: number) => Array.from({ length: n }, (_, i) => i);

export function fitRidge(rows: readonly SparseRow[], y: readonly number[], p: number, lambda: number, use: readonly number[] = allIndexes(rows.length)): RidgeFit {
  return solveRidge(normalEquations(rows, y, p, use), lambda);
}

export const predict = (fit: RidgeFit, row: SparseRow): number => row.reduce((s, [c, v]) => s + v * fit.prices[c]!, fit.intercept);

/** A fixed split by a hash of `oracle_id` (plan sec. 2.3). */
export const foldOf = (oracleId: string): number => createHash('sha256').update(oracleId, 'utf8').digest().readUInt32BE(0) % FOLDS;

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const meanAbs = (errors: readonly number[]) => errors.reduce((s, e) => s + Math.abs(e), 0) / errors.length;

/**
 * The ridge strength with the lowest mean absolute error, by a test on each fold in turn. A held-out
 * fold plays no part: its rows are neither trained on nor tested. A tie takes the smaller strength.
 */
export function chooseLambda(rows: readonly SparseRow[], y: readonly number[], p: number, folds: readonly number[], heldOut: number | null): number {
  const test = [...new Set(folds)].filter((f) => f !== heldOut).sort((a, b) => a - b);
  const errors = LAMBDAS.map(() => [] as number[]);
  for (const f of test) {
    const use = allIndexes(rows.length).filter((i) => folds[i] !== f && folds[i] !== heldOut);
    const normal = normalEquations(rows, y, p, use);
    LAMBDAS.forEach((lambda, l) => {
      const fit = solveRidge(normal, lambda);
      for (let i = 0; i < rows.length; i++) if (folds[i] === f) errors[l]!.push(predict(fit, rows[i]!) - y[i]!);
    });
  }
  const scores = errors.map(meanAbs);
  return LAMBDAS[scores.indexOf(Math.min(...scores))]!;
}

export interface HeldOutTest {
  /** Each card once, from the fit that did not use it. */
  predictions: number[];
  /** The mean absolute error of `predictions`, the typical error of the result rule. */
  error: number;
  root_mean_square: number;
  /** The error of a constant: the median of the training folds. */
  baseline_error: number;
  baseline_root_mean_square: number;
  /** The strength of each fold. */
  lambdas: number[];
}

const rootMeanSquare = (errors: readonly number[]) => Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length);

/** The test of plan sec. 2.3. The strength of a fold comes from the other folds only. */
export function heldOutTest(rows: readonly SparseRow[], y: readonly number[], p: number, folds: readonly number[]): HeldOutTest {
  const predictions = new Array<number>(rows.length).fill(0);
  const baseline = new Array<number>(rows.length).fill(0);
  const lambdas: number[] = [];
  for (const f of [...new Set(folds)].sort((a, b) => a - b)) {
    const use = allIndexes(rows.length).filter((i) => folds[i] !== f);
    const lambda = chooseLambda(rows, y, p, folds, f);
    lambdas.push(lambda);
    const fit = fitRidge(rows, y, p, lambda, use);
    const constant = median(use.map((i) => y[i]!));
    for (let i = 0; i < rows.length; i++) {
      if (folds[i] !== f) continue;
      predictions[i] = predict(fit, rows[i]!);
      baseline[i] = constant;
    }
  }
  const errors = predictions.map((v, i) => v - y[i]!);
  const flat = baseline.map((v, i) => v - y[i]!);
  return {
    predictions, error: meanAbs(errors), root_mean_square: rootMeanSquare(errors),
    baseline_error: meanAbs(flat), baseline_root_mean_square: rootMeanSquare(flat), lambdas,
  };
}

/** Plan sec. 2.3 and 2.4. False: write no table. A correlation that is not a number also fails. */
export const passesResultRule = (t: Pick<HeldOutTest, 'error' | 'baseline_error'>, correlation: number): boolean =>
  t.error <= MAX_ERROR && t.error < t.baseline_error && Math.abs(correlation) <= MAX_CORRELATION;

/** The Pearson correlation of two lists. It is not a number when a list has no spread. */
export function pearson(a: readonly number[], b: readonly number[]): number {
  const mean = (v: readonly number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const [ma, mb] = [mean(a), mean(b)];
  let [ab, aa, bb] = [0, 0, 0];
  for (let i = 0; i < a.length; i++) {
    ab += (a[i]! - ma) * (b[i]! - mb);
    aa += (a[i]! - ma) ** 2;
    bb += (b[i]! - mb) ** 2;
  }
  return ab / Math.sqrt(aa * bb);
}

/** The printed mana bin of plan sec. 2.4, by its label: 1 is 0 to 1 mana, and 7 is 7 mana or more. */
export const manaBin = (mana: number): number => (mana <= 1 ? 1 : Math.min(mana, 7));

/** Plan sec. 2.4: each residual less the median residual of the rows in its printed mana bin. */
export function adjustByMana<K>(residuals: ReadonlyMap<K, number>, mana: ReadonlyMap<K, number>): { adjusted: Map<K, number>; bins: Map<number, number> } {
  const values = new Map<number, number[]>();
  for (const [id, r] of residuals) {
    const bin = manaBin(mana.get(id)!);
    values.set(bin, [...(values.get(bin) ?? []), r]);
  }
  const bins = new Map([...values].map(([b, v]) => [b, median(v)]));
  return { adjusted: new Map([...residuals].map(([id, r]) => [id, r - bins.get(manaBin(mana.get(id)!))!])), bins };
}

/** The smallest spread group of each card with at least `MIN_GROUP` cards. A tie takes the lower key. */
export function bestGroups(groups: readonly RewardGroup[]): Map<string, RewardGroup> {
  const usable = groups.filter((g) => g.spread && g.members.length >= MIN_GROUP)
    .sort((a, b) => a.members.length - b.members.length || (a.key < b.key ? -1 : 1));
  const best = new Map<string, RewardGroup>();
  for (const g of usable) for (const m of g.members) if (!best.has(m.oracle_id)) best.set(m.oracle_id, g);
  return best;
}

/** The formula of the report. A card with no value or no group does not reach this function. */
export function rateOf(gap: number, cls: CardClassName): { rate: number; reason: RateReason } {
  if (Math.abs(gap) < GAP_LINE) return { rate: 0, reason: 'under_line' };
  if (cls === 'conditional' && gap < 0) return { rate: 0, reason: 'no_penalty' };
  return { rate: gap, reason: 'gap' };
}

export interface RateRow {
  oracle_id: string;
  predicted_mana: number | null;
  /** `printedMana` for a card in the fit, or else `cards.cmc`. */
  printed_mana: number;
  role_gap: number | null;
  /** Null: the card has no value. */
  rate: number | null;
  class: CardClassName;
  reason: RateReason;
  class_reason: string | null;
  group_key: string | null;
}

export interface RateRun {
  rows: RateRow[];
  test: HeldOutTest;
  /** The strength and the prices of the fit on all cards. */
  lambda: number;
  prices: Array<{ column: string; price: number; cards: number }>;
  intercept: number;
  /** The rows of the fit, in the order of `test.predictions`. */
  fit_rows: FitRow[];
  /** The Pearson correlation of `role_gap` with printed mana, on the cards with a gap. */
  gap_correlation: number;
  /** The median residual of each bin, by the label of `manaBin`. */
  bin_medians: Map<number, number>;
  /** The residual of each card in the fit, after the bin step. */
  adjusted: Map<string, number>;
}

/** The fit, the test and one row for each spell. `classes` comes from `cardClasses`. */
export function rateSpells(input: GroupInput, cards: ReadonlyMap<string, ProofCard>, classes: readonly CardClass[]): RateRun {
  const reward = rewardTest(input.roles);
  const spells = [...input.spells].sort((a, b) => (a.oracle_id < b.oracle_id ? -1 : 1));
  const out = new Map(spells.map((s) => [s.oracle_id, noValueReason(cards.get(s.oracle_id)!, reward)]));
  // A group and its median can read only cards with a value, so `cmc` here is the mana of the fit.
  const fitted = spells.filter((s) => out.get(s.oracle_id) === null).map((s) => ({ ...s, cmc: printedMana(cards.get(s.oracle_id)!.faces) }));
  const fit_rows = fitted.flatMap((s) => fitRows(cards.get(s.oracle_id)!));
  const { columns, rows } = designMatrix(fit_rows.map((r) => features(r.card)));
  const y = fit_rows.map((r) => r.mana);
  const folds = fit_rows.map((r) => foldOf(r.oracle_id));
  const p = columns.length;
  const test = heldOutTest(rows, y, p, folds);
  const lambda = chooseLambda(rows, y, p, folds, null);
  const fit = fitRidge(rows, y, p, lambda);

  // A row is one cost, so a card with two costs has two bins. The bin of their sum would lift such a
  // card, because the median of a high bin comes from cards with one high cost.
  const fitted_mana = rows.map((r) => predict(fit, r));
  const byRow = adjustByMana(new Map(fitted_mana.map((v, i) => [i, v - y[i]!])), new Map(y.map((m, i) => [i, m])));
  const predicted = new Map<string, number>();
  const adjusted = new Map<string, number>();
  fit_rows.forEach((r, i) => {
    predicted.set(r.oracle_id, (predicted.get(r.oracle_id) ?? 0) + fitted_mana[i]!);
    adjusted.set(r.oracle_id, (adjusted.get(r.oracle_id) ?? 0) + byRow.adjusted.get(i)!);
  });
  const printed = new Map(fitted.map((s) => [s.oracle_id, s.cmc]));
  const best = bestGroups(makeGroups({ ...input, spells: fitted }, reward, kindKey));
  const medians = new Map([...new Set(best.values())].map((g) => [g.key, median(g.members.map((m) => adjusted.get(m.oracle_id)!))]));
  const classOf = new Map(classes.map((c) => [c.oracle_id, c]));

  const result = spells.map((s): RateRow => {
    const { class: cls, reason: class_reason } = classOf.get(s.oracle_id)!;
    const base = { oracle_id: s.oracle_id, class: cls, class_reason };
    const missing = out.get(s.oracle_id);
    if (missing) return { ...base, predicted_mana: null, printed_mana: s.cmc, role_gap: null, rate: null, reason: missing, group_key: null };
    const value = { predicted_mana: predicted.get(s.oracle_id)!, printed_mana: printed.get(s.oracle_id)! };
    const g = best.get(s.oracle_id);
    if (!g) return { ...base, ...value, role_gap: null, rate: 0, reason: 'no_group', group_key: null };
    const role_gap = adjusted.get(s.oracle_id)! - medians.get(g.key)!;
    return { ...base, ...value, role_gap, ...rateOf(role_gap, cls), group_key: g.key };
  });
  const uses = new Array<number>(p).fill(0);
  for (const r of rows) for (const [c] of r) uses[c]!++;
  const gapped = result.filter((r) => r.role_gap !== null);
  return {
    rows: result, test, lambda, intercept: fit.intercept, fit_rows, bin_medians: byRow.bins, adjusted,
    gap_correlation: pearson(gapped.map((r) => r.role_gap!), gapped.map((r) => r.printed_mana)),
    prices: columns.map((column, c) => ({ column, price: fit.prices[c]!, cards: uses[c]! })),
  };
}

const COST_WORDS: Readonly<Record<string, RegExp>> = {
  EXILE: /\bexile/i, BLIGHT: /\bblight/i, COUNTER_PRODUCTION: /\bcounter/i, RECURSION: /\breturn/i, DAMAGE: /\bdamage\b/i,
};

/**
 * The word check of Task 2, question 4, for a reward atom: the action word is only before the colon
 * of its quote, or the quote has "additional cost" and the word. It is a spot check, not a rule.
 */
export function wordCost(a: Pick<RewardAtom, 'type_key' | 'quote'>): boolean {
  const word = COST_WORDS[a.type_key];
  if (!word) return false;
  const quote = a.quote.replace(/\([^)]*\)/g, '');
  const colon = quote.indexOf(':');
  if (colon >= 0 && word.test(quote.slice(0, colon)) && !word.test(quote.slice(colon + 1))) return true;
  return /additional cost/i.test(quote) && word.test(quote);
}

/** Replaces the whole table in one transaction, so it holds one build. */
export function writeRates(db: DatabaseSync, buildId: number, rows: readonly RateRow[]): void {
  const hash = db.prepare('SELECT oracle_hash FROM cards WHERE oracle_id = ?');
  const insert = db.prepare(
    `INSERT INTO card_rates (oracle_id, oracle_hash, build_id, predicted_mana, printed_mana, role_gap, rate, class, reason, class_reason, group_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM card_rates');
    for (const r of rows) {
      const { oracle_hash } = hash.get(r.oracle_id) as { oracle_hash: string };
      insert.run(r.oracle_id, oracle_hash, buildId, r.predicted_mana, r.printed_mana, r.role_gap, r.rate, r.class, r.reason, r.class_reason, r.group_key);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
