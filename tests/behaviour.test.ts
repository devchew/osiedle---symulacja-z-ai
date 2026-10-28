import { describe, expect, it } from 'vitest';
import { createWorld, tickWorld } from '../src/world/world';
import { traceOf } from '../src/world/trace';

// Regression checks for "chaotic" behaviour found by analysing the activity trace
// (tests/tools/trace.test.ts): chats cut off mid-way, sit-down/stand-up flicker.

const SEEDS = [1, 7, 42, 99];
const TICKS = 4500; // ≈ 15 minutes of real time at 1×

const runs = SEEDS.map((seed) => {
  const w = createWorld(seed);
  for (let i = 0; i < TICKS; i++) tickWorld(w);
  return { seed, entries: traceOf(w) };
});

describe('behaviour (activity trace)', () => {
  it('conversations run to their end instead of being cut off', () => {
    for (const { seed, entries } of runs) {
      const ends = entries.filter((e) => e.kind === 'conv-end');
      const cut = ends.filter((e) => !e.text.includes('koniec tematu') && !e.text.includes('krytyczna potrzeba'));
      expect(ends.length, `seed ${seed}`).toBeGreaterThan(10);
      expect(cut.length / ends.length, `seed ${seed}: ${cut.map((e) => e.text).join(' | ')}`).toBeLessThan(0.1);
    }
  });

  it('nobody flip-flops between decisions', () => {
    for (const { seed, entries } of runs) {
      const byAgent = new Map<number, number[]>();
      for (const e of entries.filter((x) => x.kind === 'decide')) byAgent.set(e.agentId, [...(byAgent.get(e.agentId) ?? []), e.tick]);
      for (const [id, ticks] of byAgent) {
        let flips = 0;
        for (let i = 0; i + 3 < ticks.length; i++) if (ticks[i + 3] - ticks[i] <= 15) flips++;
        expect(flips, `seed ${seed} agent ${id}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('activities are not abandoned seconds after sitting down', () => {
    for (const { seed, entries } of runs) {
      const quick = entries.filter((e) => e.kind === 'end' && /używa:/.test(e.text) && /potrzeby zaspokojone/.test(e.text)).filter((e) => {
        const arrive = [...entries].reverse().find((x) => x.agentId === e.agentId && x.kind === 'arrive' && x.tick <= e.tick);
        return arrive && e.tick - arrive.tick < 10;
      });
      expect(quick.length, `seed ${seed}`).toBe(0);
    }
  });
});
