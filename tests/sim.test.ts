import { describe, expect, it } from 'vitest';
import { createWorld, tickWorld } from '../src/world/world';
import { NEED_KEYS } from '../src/types';
import { bedOf } from '../src/agents/home';
import { updateAgent } from '../src/agents/actions';
import { findPath } from '../src/agents/pathfinding';
import { timeFromTick } from '../src/core/time';

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

describe('beds', () => {
  it('gives everyone their own bed', () => {
    const world = createWorld(2);
    const beds = world.agents.map((a) => bedOf(a));
    expect(beds.every((b) => b !== undefined)).toBe(true);
    expect(new Set(beds).size).toBe(beds.length);
    for (const uid of beds) expect(world.objects.find((o) => o.uid === uid)?.type).toBe('bed');
  });

  it('agents beyond the bed count get none and still live', () => {
    const world = createWorld(2, { agentCount: 8 });
    expect(world.agents.filter((a) => bedOf(a) === undefined)).toHaveLength(2);
    for (let i = 0; i < DAY; i++) tickWorld(world);
  });
});

describe('walking around each other', () => {
  function setup(standAt: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }) {
    const world = createWorld(1, { agentCount: 2 });
    const [walker, stander] = world.agents;
    stander.pos = { ...standAt };
    stander.path = [];
    stander.action = { kind: 'idle', ticksLeft: 10_000, label: '', icon: '' };
    walker.pos = { ...from };
    walker.path = findPath(world.grid, from, to)!;
    walker.action = { kind: 'wander', phase: 'walking', ticksLeft: 10_000, label: '', icon: '' };
    return { world, walker, stander };
  }

  it('steps around someone standing in the hall', () => {
    // hall is two tiles high (y 9..10)
    const { world, walker } = setup({ x: 10, y: 9 }, { x: 6, y: 9 }, { x: 14, y: 9 });
    let ticks = 0;
    while (walker.action && ticks < 60) {
      updateAgent(world, walker, timeFromTick(world.tick));
      expect(Math.round(walker.pos.x) === 10 && Math.round(walker.pos.y) === 9).toBe(false);
      ticks++;
    }
    expect(walker.pos).toEqual({ x: 14, y: 9 });
  });

  it('never deadlocks in a doorway', () => {
    // bedroom 1 door (5,8) is the only way in: after a short wait the walker squeezes past
    const { world, walker } = setup({ x: 5, y: 8 }, { x: 5, y: 10 }, { x: 5, y: 5 });
    let ticks = 0;
    while (walker.action && ticks < 100) {
      updateAgent(world, walker, timeFromTick(world.tick));
      ticks++;
    }
    expect(walker.pos).toEqual({ x: 5, y: 5 });
  });
});
