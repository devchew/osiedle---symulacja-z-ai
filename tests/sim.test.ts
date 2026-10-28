import { describe, expect, it } from 'vitest';
import { createWorld, tickWorld } from '../src/world/world';
import { NEED_KEYS } from '../src/types';

const DAY = 24 * 60;

function run(seed: number, ticks: number) {
  const world = createWorld(seed);
  for (let i = 0; i < ticks; i++) tickWorld(world);
  return world;
}

describe('simulation', () => {
  it('is deterministic for a seed', () => {
    const a = run(11, 2000);
    const b = run(11, 2000);
    expect(a.agents.map((x) => [x.pos, x.needs])).toEqual(b.agents.map((x) => [x.pos, x.needs]));
    expect(a.rng.state()).toBe(b.rng.state());
  });

  it('never double-books an object slot', () => {
    const world = createWorld(5);
    for (let i = 0; i < 3000; i++) {
      tickWorld(world);
      const holders = world.objects.flatMap((o) => o.reservedBy.filter((r) => r !== null));
      expect(new Set(holders).size).toBe(holders.length);
    }
  });

  it('keeps everyone alive and social over two days', () => {
    const world = run(3, 2 * DAY);
    for (const a of world.agents) {
      expect(a.stats.objectsUsed).toBeGreaterThan(5);
      expect(a.stats.conversations).toBeGreaterThan(0);
      for (const k of NEED_KEYS) expect(a.needs[k]).toBeGreaterThan(0);
    }
  });
});
