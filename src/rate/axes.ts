/**
 * The parts of a card that the owner names (card rate results Task 6, "What the rate must be"), and
 * the weights of round 2. Printed mana gives these parts no price: a repeat has -0.015 mana and a
 * condition has -0.096 mana. So the weights come from the owner's choices on pairs, and not from a
 * fit on printed mana. Each value comes from a fixed text rule, with no model.
 *
 * The rate of a card is the sum of each part, over its spread in the pool, times its weight. A fit
 * has a ridge penalty, because a round gives few answers for ten weights.
 */
import { isCostAtom, type AtomTest, type RewardAtom } from './groups.js';
import { features } from './fit.js';
import { abilityLine, activationMana, hasConditionWords, optionCount, usesOf } from './fields.js';
import type { ProofCard, ProofFace } from './proof.js';

export const AXES = [
  'reward_once', 'reward_repeat', 'reward_static', 'reward_conditioned', 'reward_size',
  'activation_mana', 'other_cost', 'speed', 'options', 'body',
] as const;
export type Axis = typeof AXES[number];
export type Axes = Record<Axis, number>;

/** The ridge strength of the weights. It is fixed before the first answer, so no answer can tune it. */
export const WEIGHT_RIDGE = 1;

const isPermanent = (f: Pick<ProofFace, 'type_line'>) => !/\b(?:Instant|Sorcery)\b/.test(f.type_line);

/** Power plus toughness of the first creature face with a cost. A `*` reads as 0. */
function bodySize(faces: readonly ProofFace[]): number {
  const f = faces.find((x) => x.mana_cost && /\bCreature\b/.test(x.type_line));
  const read = (s: string | null | undefined) => (s && /^\d+$/.test(s) ? Number(s) : 0);
  return read(f?.power) + read(f?.toughness);
}

export function cardAxes(card: Pick<ProofCard, 'name' | 'atoms' | 'fields' | 'faces' | 'speed'>, reward: AtomTest, condition: AtomTest): Axes {
  const axes = Object.fromEntries(AXES.map((a) => [a, 0])) as Axes;
  const names = card.name.split(' // ');
  const lineOf = (a: RewardAtom) => {
    const face = card.faces.find((f) => f.face_index === a.face_index);
    return face ? abilityLine(face.oracle_text, a.span_start ?? 0) : '';
  };
  const conditioned = new Set(card.atoms.filter(condition).map((a) => `${a.face_index}|${lineOf(a)}`));
  const rewards = card.atoms.filter(reward);
  const effects = new Map(rewards.map((a) => [`${a.family}.${a.type_key}|${a.face_index}|${a.quote}`, a]));
  const paid = new Set<string>();
  for (const a of effects.values()) {
    const face = card.faces.find((f) => f.face_index === a.face_index);
    const line = lineOf(a);
    if (hasConditionWords(line) || conditioned.has(`${a.face_index}|${line}`)) axes.reward_conditioned++;
    else axes[`reward_${usesOf(line, face ? isPermanent(face) : true, names)}`]++;
    if (!paid.has(line)) {
      paid.add(line);
      axes.activation_mana += activationMana(line) ?? 0;
    }
  }
  for (const [k, v] of features({ atoms: rewards, fields: card.fields, faces: [] })) if (k.includes('#') && !k.endsWith('?')) axes.reward_size += v;
  axes.other_cost = new Set(card.atoms.filter(isCostAtom).map((a) => a.quote)).size;
  const speed = card.speed[0];
  const creature = card.faces.some((f) => /\bCreature\b/.test(f.type_line));
  if (speed?.cast === 'instant') axes.speed++;
  if (creature && speed?.wait === 'now') axes.speed++;
  if (speed?.tapped === true) axes.speed--;
  if (speed?.ability_limit) axes.speed--;
  if (card.faces.some((f) => /\bin your opening hand\b/i.test(f.oracle_text))) axes.speed++;
  axes.options = card.faces.reduce((s, f) => s + optionCount(f.oracle_text), 0);
  axes.body = bodySize(card.faces);
  return axes;
}

/** The spread of each part in the pool. A part with no spread has scale 1, so it stays 0 after the difference. */
export function axisScales(all: readonly Axes[]): Axes {
  const out = {} as Axes;
  for (const a of AXES) {
    const v = all.map((x) => x[a]);
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    out[a] = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length) || 1;
  }
  return out;
}

/** One row of the weight fit: card A less card B, in units of the spread. */
export const axisDifference = (a: Axes, b: Axes, scales: Axes): number[] => AXES.map((k) => (a[k] - b[k]) / scales[k]);

/** Solves a x = b by elimination. The penalty makes the matrix positive, so each pivot is above 0. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((r, i) => r[n]! / r[i]!);
}

/**
 * The weights of a ridge logistic fit on pairs, by Newton steps. It has no constant: side A is not
 * better than side B. `chose_a` is the owner's side. One data set gives one result.
 */
export function fitWeights(rows: ReadonlyArray<{ x: readonly number[]; chose_a: boolean }>, ridge: number = WEIGHT_RIDGE): number[] {
  const p = AXES.length;
  let w: number[] = new Array<number>(p).fill(0);
  for (let step = 0; step < 50; step++) {
    const grad = w.map((v) => ridge * v);
    const hess = w.map((_, i) => w.map((__, j) => (i === j ? ridge : 0)));
    for (const { x, chose_a } of rows) {
      const q = 1 / (1 + Math.exp(-x.reduce((s, v, i) => s + v * w[i]!, 0)));
      for (let i = 0; i < p; i++) {
        grad[i]! -= ((chose_a ? 1 : 0) - q) * x[i]!;
        for (let j = 0; j < p; j++) hess[i]![j]! += q * (1 - q) * x[i]! * x[j]!;
      }
    }
    const move = solve(hess, grad);
    w = w.map((v, i) => v - move[i]!);
    if (Math.max(...move.map(Math.abs)) < 1e-9) break;
  }
  return w;
}

/** The value of a card under the weights. It is not a win rate. */
export const axisScore = (a: Axes, scales: Axes, weights: readonly number[]): number => AXES.reduce((s, k, i) => s + (a[k] / scales[k]) * weights[i]!, 0);
