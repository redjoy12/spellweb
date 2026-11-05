import { createHash } from 'node:crypto';

/** A stable [0, 1) draw per (seed, key). The same seed and key always give the same number. */
export function draw(seed: number, key: string): number {
  return createHash('sha256').update(`${seed}:${key}`).digest().readUInt32BE(0) / 2 ** 32;
}
