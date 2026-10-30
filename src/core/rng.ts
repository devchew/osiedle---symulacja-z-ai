import type { Rng } from '../types.ts';

/**
 * mulberry32 — small, fast, deterministic PRNG. The whole state is one uint32, so a
 * snapshot stores `rng.state()` and restores it with `createRng(seed, state)` or `setState`.
 */
export function createRng(seed: number, state?: number): Rng {
  let s = (state ?? seed) >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    weightedIndex: (weights) => {
      const total = weights.reduce((a, w) => a + Math.max(0, w), 0);
      if (total <= 0) return Math.floor(next() * weights.length);
      let r = next() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= Math.max(0, weights[i]);
        if (r < 0) return i;
      }
      return weights.length - 1;
    },
    state: () => s,
    setState: (state: number) => {
      s = state >>> 0;
    },
  };
}
