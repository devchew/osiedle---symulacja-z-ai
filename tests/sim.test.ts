import { describe, expect, it } from 'vitest';
import { createWorld, tickWorld } from '../src/world/world';
import { NEED_KEYS, type World } from '../src/types';
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
    const world = run(4, 2 * DAY);
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
    // independent of the map's bed count: two more residents than beds
    const beds = createWorld(2).objects.filter((o) => o.type === 'bed').length;
    const world = createWorld(2, { agentCount: beds + 2 });
    expect(world.agents.filter((a) => bedOf(a) === undefined)).toHaveLength(2);
    for (let i = 0; i < DAY; i++) tickWorld(world);
  });
});

describe('walking around each other', () => {
  type P = { x: number; y: number };

  function place(world: World, standAt: P, from: P, to: P) {
    const [walker, stander] = world.agents;
    stander.pos = { ...standAt };
    stander.path = [];
    stander.action = { kind: 'idle', ticksLeft: 10_000, label: '', icon: '' };
    walker.pos = { ...from };
    walker.path = findPath(world.grid, from, to)!;
    walker.action = { kind: 'wander', phase: 'walking', ticksLeft: 10_000, label: '', icon: '' };
    return { world, walker, stander };
  }

  const free = (world: World, x: number, y: number) => !world.grid.solid[y * world.grid.width + x];
  const room = (world: World, id: string) => world.grid.rooms.find((r) => r.id === id)!.rect;

  it('steps around someone standing in the hall', () => {
    // the hub spans the living room and the kitchen; walk along a free row, the stander is in the way
    const world = createWorld(1, { agentCount: 2 });
    const living = room(world, 'living');
    const kitchen = room(world, 'kitchen');
    const x0 = living.x;
    const x1 = kitchen.x + kitchen.w - 1;
    const mid = Math.floor((x0 + x1) / 2);
    let y = -1;
    for (let r = living.y; r < living.y + living.h; r++) {
      let clear = free(world, mid, r - 1) || free(world, mid, r + 1); // room to step aside
      for (let x = x0; x <= x1; x++) clear = clear && free(world, x, r);
      if (clear) { y = r; break; }
    }
    expect(y).toBeGreaterThanOrEqual(0);
    const { walker } = place(world, { x: mid, y }, { x: x0, y }, { x: x1, y });
    expect(walker.path.some((p) => p.x === mid && p.y === y)).toBe(true);
    let ticks = 0;
    while (walker.action && ticks < 60) {
      updateAgent(world, walker, timeFromTick(world.tick));
      expect(Math.round(walker.pos.x) === mid && Math.round(walker.pos.y) === y).toBe(false);
      ticks++;
    }
    expect(walker.pos).toEqual({ x: x1, y });
  });

  it('never deadlocks in a doorway', () => {
    // walk from the hub into a bedroom; someone stands in the door the path goes through
    const world = createWorld(1, { agentCount: 2 });
    const bed = room(world, 'bedroom1');
    const from = { x: room(world, 'living').x + 3, y: room(world, 'living').y + 2 };
    const to = { x: bed.x + 1, y: bed.y + 1 };
    const path = findPath(world.grid, from, to)!;
    const door = path.find((p) => world.grid.tiles[p.y * world.grid.width + p.x] === 'door');
    expect(door).toBeDefined();
    const { walker } = place(world, door!, from, to);
    let ticks = 0;
    while (walker.action && ticks < 100) {
      updateAgent(world, walker, timeFromTick(world.tick));
      ticks++;
    }
    expect(walker.pos).toEqual(to);
  });
});
