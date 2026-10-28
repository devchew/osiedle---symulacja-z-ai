import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import { NEED_KEYS } from '../src/types';
import type { Agent, Grid, Needs, Traits, Vec2 } from '../src/types';
import { AGENT_NAMES, createAgent, createAgents } from '../src/agents/agent';
import { NEED_DECAY, applyEffects, computeMood, decayNeeds, lowestNeed, urgency } from '../src/agents/needs';
import { findPath, nearestWalkable } from '../src/agents/pathfinding';
import { WALK_SPEED, stepAgent } from '../src/agents/movement';

/** '#' = solid, anything else walkable */
function gridFrom(rows: string[]): Grid {
  const height = rows.length, width = rows[0].length;
  const solid: boolean[] = [];
  for (const r of rows) for (const c of r) solid.push(c === '#');
  return { width, height, tiles: solid.map((s) => (s ? 'wall' : 'floor')), solid, rooms: [] };
}

const neutral: Traits = { sociability: 0, activity: 0, neatness: 0, cheerfulness: 0 };
const fullNeeds = (): Needs => ({ hunger: 100, energy: 100, fun: 100, social: 100, hygiene: 100, comfort: 100 });

function testAgent(traits: Traits = neutral, pos: Vec2 = { x: 0, y: 0 }): Agent {
  const a = createAgent(0, 'Test', pos, createRng(1));
  a.traits = { ...traits };
  a.needs = fullNeeds();
  return a;
}

function isValidPath(grid: Grid, from: Vec2, path: Vec2[]): boolean {
  let p = from;
  for (const q of path) {
    const dx = q.x - p.x, dy = q.y - p.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) return false;
    if (grid.solid[q.y * grid.width + q.x]) return false;
    if (dx !== 0 && dy !== 0 && (grid.solid[p.y * grid.width + q.x] || grid.solid[q.y * grid.width + p.x])) return false;
    p = q;
  }
  return true;
}

describe('findPath', () => {
  it('walks a straight line', () => {
    const g = gridFrom(['.....']);
    expect(findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 })).toEqual([
      { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 },
    ]);
  });

  it('returns [] when start equals goal and rounds non-integer input', () => {
    const g = gridFrom(['...']);
    expect(findPath(g, { x: 1, y: 0 }, { x: 1, y: 0 })).toEqual([]);
    expect(findPath(g, { x: 0.6, y: 0.2 }, { x: 1.4, y: 0 })).toEqual([]);
  });

  it('goes around walls', () => {
    const g = gridFrom([
      '.#...',
      '.#.#.',
      '...#.',
    ]);
    const path = findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 })!;
    expect(path).not.toBeNull();
    expect(path[path.length - 1]).toEqual({ x: 4, y: 0 });
    expect(isValidPath(g, { x: 0, y: 0 }, path)).toBe(true);
  });

  it('prefers diagonals in open space (octile)', () => {
    const g = gridFrom(['....', '....', '....', '....']);
    expect(findPath(g, { x: 0, y: 0 }, { x: 3, y: 3 })).toHaveLength(3);
  });

  it('returns null when unreachable or goal is solid', () => {
    const g = gridFrom(['..#..', '..#..']);
    expect(findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 })).toBeNull();
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 })).toBeNull();
    expect(findPath(g, { x: 0, y: 0 }, { x: 9, y: 0 })).toBeNull();
  });

  it('does not cut corners', () => {
    const g = gridFrom([
      '.#',
      '..',
    ]);
    // diagonal (0,0)->(1,1) would clip the wall at (1,0)
    expect(findPath(g, { x: 0, y: 0 }, { x: 1, y: 1 })).toEqual([{ x: 0, y: 1 }, { x: 1, y: 1 }]);
    const g2 = gridFrom(['.#', '#.']);
    expect(findPath(g2, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });

  it('respects extraBlocked but never blocks the start tile', () => {
    const g = gridFrom(['...', '...', '...']);
    const blockedMid = (x: number, y: number) => x === 1 && y !== 2;
    const path = findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 }, { extraBlocked: blockedMid })!;
    expect(path.some((p) => p.x === 1 && p.y !== 2)).toBe(false);
    expect(path[path.length - 1]).toEqual({ x: 2, y: 0 });
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 }, { extraBlocked: () => true })).toBeNull();
    // start blocked by extraBlocked (agent standing on its own tile) is fine
    expect(findPath(g, { x: 0, y: 0 }, { x: 1, y: 0 }, { extraBlocked: (x, y) => x === 0 && y === 0 })).toEqual([{ x: 1, y: 0 }]);
  });

  it('gives up after maxNodes', () => {
    const g = gridFrom(Array.from({ length: 50 }, () => '.'.repeat(50)));
    expect(findPath(g, { x: 0, y: 0 }, { x: 49, y: 49 }, { maxNodes: 10 })).toBeNull();
    expect(findPath(g, { x: 0, y: 0 }, { x: 49, y: 49 })).toHaveLength(49);
  });

  it('nearestWalkable finds the closest free tile', () => {
    const g = gridFrom(['###', '##.', '###']);
    expect(nearestWalkable(g, { x: 0, y: 0 })).toEqual({ x: 2, y: 1 });
    expect(nearestWalkable(g, { x: -5, y: 1 })).toEqual({ x: 2, y: 1 });
    expect(nearestWalkable(gridFrom(['##']), { x: 0, y: 0 })).toBeNull();
  });
});

describe('needs', () => {
  it('decays to ~0 within the calibrated time and clamps', () => {
    const a = testAgent();
    // traits are neutral in testAgent, so fun hits 0 after 100 / NEED_DECAY.fun ticks
    const funTicks = Math.ceil(100 / NEED_DECAY.fun);
    for (let t = 0; t < funTicks; t++) decayNeeds(a, { sleeping: false, hour: 12 });
    expect(a.needs.fun).toBeLessThan(1);
    expect(a.needs.hunger).toBeGreaterThan(20);
    for (let t = 0; t < 30 * 60; t++) decayNeeds(a, { sleeping: false, hour: 12 });
    for (const k of NEED_KEYS) expect(a.needs[k]).toBe(0);
  });

  it('sleeping: energy does not decay, hunger slower', () => {
    const awake = testAgent(), asleep = testAgent();
    for (let t = 0; t < 120; t++) {
      decayNeeds(awake, { sleeping: false, hour: 2 });
      decayNeeds(asleep, { sleeping: true, hour: 2 });
    }
    expect(asleep.needs.energy).toBe(100);
    expect(100 - asleep.needs.hunger).toBeCloseTo((100 - awake.needs.hunger) * 0.4, 5);
  });

  it('traits modulate decay', () => {
    const extro = testAgent({ ...neutral, sociability: 1 });
    const intro = testAgent({ ...neutral, sociability: -1 });
    const neat = testAgent({ ...neutral, neatness: 1 });
    const messy = testAgent({ ...neutral, neatness: -1 });
    for (let t = 0; t < 120; t++) for (const a of [extro, intro, neat, messy]) decayNeeds(a, { sleeping: false, hour: 12 });
    expect(extro.needs.social).toBeLessThan(intro.needs.social);
    expect(neat.needs.hygiene).toBeLessThan(messy.needs.hygiene);
  });

  it('applyEffects scales and clamps', () => {
    const a = testAgent();
    a.needs.hunger = 50;
    applyEffects(a, { hunger: 10, energy: -30 }, 2);
    expect(a.needs.hunger).toBe(70);
    expect(a.needs.energy).toBe(40);
    applyEffects(a, { hunger: 1000, fun: -1000 });
    expect(a.needs.hunger).toBe(100);
    expect(a.needs.fun).toBe(0);
  });

  it('urgency is convex in [0,1]', () => {
    expect(urgency(100)).toBe(0);
    expect(urgency(0)).toBeCloseTo(1);
    const vals = [100, 80, 60, 40, 20, 10, 0].map(urgency);
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]);
    expect(urgency(10) - urgency(20)).toBeGreaterThan(urgency(80) - urgency(90));
  });

  it('mood: higher needs and cheerfulness give better mood; one low need hurts', () => {
    const good = fullNeeds();
    const mid: Needs = { hunger: 60, energy: 60, fun: 60, social: 60, hygiene: 60, comfort: 60 };
    const oneLow: Needs = { ...fullNeeds(), hunger: 5 };
    expect(computeMood(good, neutral)).toBeGreaterThan(computeMood(mid, neutral));
    expect(computeMood(mid, { ...neutral, cheerfulness: 1 })).toBeCloseTo(computeMood(mid, { ...neutral, cheerfulness: -1 }) + 20, 9);
    const naive = (100 * 5 + 5) / 6;
    expect(computeMood(oneLow, neutral)).toBeLessThan(naive - 5);
    for (const n of [good, mid, oneLow]) for (const c of [-1, 1]) {
      const m = computeMood(n, { ...neutral, cheerfulness: c });
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(100);
    }
  });

  it('lowestNeed', () => {
    expect(lowestNeed({ ...fullNeeds(), social: 3 })).toBe('social');
  });

  it('exports tunable decay rates', () => {
    expect(NEED_DECAY.fun).toBeGreaterThan(NEED_DECAY.hygiene);
  });
});

describe('movement', () => {
  it('returns idle with empty path', () => {
    expect(stepAgent(testAgent())).toBe('idle');
  });

  it('moves at constant speed across waypoints and arrives', () => {
    const a = testAgent();
    a.prevPos = { x: 0, y: 0 };
    a.path = [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
    const results: string[] = [];
    const ticks = Math.ceil(3 / WALK_SPEED - 1e-9);
    for (let i = 0; i < ticks - 1; i++) {
      const before = { ...a.pos };
      const r = stepAgent(a);
      results.push(r);
      if (r === 'moving') expect(Math.hypot(a.pos.x - before.x, a.pos.y - before.y)).toBeCloseTo(WALK_SPEED, 9);
      if (r === 'arrived') break;
    }
    // the last of `ticks` steps is the arrival
    expect(results).toHaveLength(ticks - 1);
    expect(results.every((r) => r === 'moving')).toBe(true);
    expect(stepAgent(a)).toBe('arrived');
    expect(a.pos).toEqual({ x: 3, y: 0 });
    expect(stepAgent(a)).toBe('idle');
    expect(a.prevPos).toEqual({ x: 0, y: 0 });
  });

  it('updates facing from horizontal direction', () => {
    const a = testAgent(neutral, { x: 5, y: 5 });
    a.path = [{ x: 4, y: 5 }];
    stepAgent(a);
    expect(a.facing).toBe(-1);
    a.path = [{ x: 5, y: 5 }];
    stepAgent(a);
    expect(a.facing).toBe(1);
  });
});

describe('agents', () => {
  it('createAgents gives unique names, ids and distinct spawns', () => {
    const spawns = Array.from({ length: 10 }, (_, i) => ({ x: i, y: 2 }));
    const agents = createAgents(8, spawns, createRng(42));
    expect(new Set(agents.map((a) => a.name)).size).toBe(8);
    expect(new Set(agents.map((a) => a.id)).size).toBe(8);
    expect(new Set(agents.map((a) => `${a.pos.x},${a.pos.y}`)).size).toBe(8);
    expect(new Set(agents.map((a) => a.color)).size).toBe(8);
    for (const a of agents) {
      expect(a.prevPos).toEqual(a.pos);
      expect(a.prevPos).not.toBe(a.pos);
      expect(a.path).toEqual([]);
      for (const k of NEED_KEYS) expect(a.needs[k]).toBeGreaterThanOrEqual(55);
      for (const t of Object.values(a.traits)) expect(Math.abs(t)).toBeLessThanOrEqual(1);
    }
    expect(AGENT_NAMES.length).toBeGreaterThanOrEqual(12);
  });

  it('is deterministic per seed', () => {
    const spawns = [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }];
    expect(createAgents(3, spawns, createRng(7))).toEqual(createAgents(3, spawns, createRng(7)));
  });
});
