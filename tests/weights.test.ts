import { describe, it, expect } from 'vitest';
import { loadGraphPolicy, type GraphPolicy } from '../src/graph/policy.js';
import { classWeight, weightOf } from '../src/graph/weights.js';

const policy = loadGraphPolicy();
const w = policy.weights;

describe('weightOf (spec sec. 7.4)', () => {
  it('is the product of the parts, with the values of graph-policy.json', () => {
    const p = weightOf('plausible', 'triggered', 3, policy);
    expect(p.grade).toBe(w.grade.plausible);
    expect(p.repeat).toBe(w.repeat.engine);
    expect(p.cost).toBeCloseTo(1 / (1 + w.cost_per_mv * 3), 12);
    expect(p.total).toBeCloseTo(p.grade * p.repeat * p.cost, 12);
  });
  it('repeat is the engine value for triggered and activated, and the other value for other', () => {
    expect(weightOf('confirmed', 'triggered', 0, policy).repeat).toBe(w.repeat.engine);
    expect(weightOf('confirmed', 'activated', 0, policy).repeat).toBe(w.repeat.engine);
    expect(weightOf('confirmed', 'other', 0, policy).repeat).toBe(w.repeat.other);
    expect(weightOf('confirmed', 'other', 0, policy).grade).toBe(w.grade.confirmed);
  });
  it('a weight above 1.0 throws', () => {
    const bad = { ...policy, weights: { ...w, grade: { confirmed: 1.5, plausible: 0.5 } } } as GraphPolicy;
    expect(() => weightOf('confirmed', 'triggered', 0, bad)).toThrow(/above 1/);
    expect(() => weightOf('confirmed', 'triggered', -5, policy)).toThrow(/above 1/);
  });
  it('a rejected grade has no weight', () => {
    expect(() => weightOf('rejected', 'other', 0, policy)).toThrow();
  });
});

describe('classWeight (spec sec. 6.2)', () => {
  it('is grade x 1 / log2(1 + n)', () => {
    for (const n of [1, 3, 1005]) {
      const p = classWeight('plausible', n, policy);
      expect(p.total).toBeCloseTo(w.grade.plausible / Math.log2(1 + n), 12);
      expect(p.size).toBeCloseTo(1 / Math.log2(1 + n), 12);
    }
    expect(classWeight('confirmed', 1, policy).total).toBe(w.grade.confirmed);
  });
  it('a class with no member has no weight', () => {
    expect(() => classWeight('confirmed', 0, policy)).toThrow();
  });
});
