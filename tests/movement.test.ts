import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { Agent, World } from '../src/types';
import { createAgent } from '../src/agents/agent';
import {
  STROLL_SPEED,
  TICK_SECONDS,
  WALK_SPEED,
  WALK_TILES_PER_SECOND,
  placeAgent,
  stepAgent,
  trailForTick,
  trailOf,
  walkSeconds,
} from '../src/agents/movement';
import { AgentMotion, MOTION, type MotionView } from '../src/render/motion';
import { createWorld, tickWorld } from '../src/world/world';
import { traceOf } from '../src/world/trace';

// Wave 10: walking takes seconds (≈1.1 m/s, 0.8 m tiles), activities take real minutes.
// The simulation records the path actually walked; the renderer replays it (render/motion.ts).

function agentAt(x: number, y: number): Agent {
  return createAgent(0, 'Test', { x, y }, createRng(1));
}

const FAST_1X: MotionView = { realtime: false, tickSeconds: 0.2 };
const FAST_8X: MotionView = { realtime: false, tickSeconds: 0.025 };
const REALTIME: MotionView = { realtime: true, tickSeconds: 60 };

describe('walking speed', () => {
  it('is a realistic pace: ~1.1 m/s, a few dozen tiles per game minute', () => {
    expect(WALK_TILES_PER_SECOND * 0.8).toBeGreaterThan(0.9);
    expect(WALK_TILES_PER_SECOND * 0.8).toBeLessThan(1.6);
    expect(WALK_SPEED).toBeGreaterThanOrEqual(60);
    expect(WALK_SPEED).toBeLessThanOrEqual(90);
    // crossing the house (20 tiles) takes ~15 s
    expect(walkSeconds(20)).toBeGreaterThan(10);
    expect(walkSeconds(20)).toBeLessThan(20);
  });
});

describe('walked-path recording', () => {
  it('records every waypoint with its time within the tick', () => {
    const a = agentAt(0, 0);
    a.path = [{ x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 1 }];
    expect(stepAgent(a, WALK_SPEED, 5)).toBe('arrived');
    const pts = trailForTick(a, 5);
    expect(pts.map((p) => [p.x, p.y])).toEqual([[0, 0], [1, 0], [2, 1], [3, 1]]);
    expect(pts[0].t).toBe(0);
    const len = 1 + Math.SQRT2 + 1;
    expect(pts[3].t).toBeCloseTo(len / WALK_TILES_PER_SECOND, 6);
    for (let i = 1; i < pts.length; i++) expect(pts[i].t).toBeGreaterThan(pts[i - 1].t);
  });

  it('caps walking at one game minute per tick, across several calls, and resumes next tick', () => {
    const a = agentAt(0, 0);
    a.path = Array.from({ length: 200 }, (_, i) => ({ x: i + 1, y: 0 }));
    expect(stepAgent(a, WALK_SPEED, 1)).toBe('moving');
    expect(a.pos.x).toBeCloseTo(WALK_SPEED, 6);
    // the minute is used up: a second call in the same tick does not move
    expect(stepAgent(a, WALK_SPEED, 1)).toBe('moving');
    expect(a.pos.x).toBeCloseTo(WALK_SPEED, 6);
    expect(trailForTick(a, 1).at(-1)!.t).toBeCloseTo(TICK_SECONDS, 6);
    stepAgent(a, WALK_SPEED, 2);
    expect(a.pos.x).toBeCloseTo(2 * WALK_SPEED, 6);
    expect(trailForTick(a, 2)[0]).toMatchObject({ t: 0, x: expect.closeTo(WALK_SPEED, 6) });
  });

  it('strolls are slower than purposeful walks', () => {
    const a = agentAt(0, 0);
    a.path = [{ x: 1, y: 0 }, { x: 2, y: 0 }];
    stepAgent(a, STROLL_SPEED, 1);
    expect(trailForTick(a, 1).at(-1)!.t).toBeCloseTo(2 / (STROLL_SPEED / TICK_SECONDS), 6);
  });

  it('records short hops (stand tile → seat) after the walk, in the same timeline', () => {
    const a = agentAt(0, 0);
    a.path = [{ x: 1, y: 0 }];
    stepAgent(a, WALK_SPEED, 3);
    placeAgent(a, { x: 1, y: -0.6 }, 3);
    const pts = trailForTick(a, 3);
    expect(pts.at(-1)).toMatchObject({ x: 1, y: -0.6 });
    expect(pts.at(-1)!.t).toBeGreaterThan(pts.at(-2)!.t);
    expect(a.pos).toEqual({ x: 1, y: -0.6 });
  });

  it('without a tick (legacy callers) moves but does not record', () => {
    const a = agentAt(0, 0);
    a.path = [{ x: 1, y: 0 }];
    stepAgent(a);
    expect(trailOf(a)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- whole-world checks

const isWall = (w: World, x: number, y: number): boolean => {
  const tx = Math.round(x), ty = Math.round(y);
  return w.grid.tiles[ty * w.grid.width + tx] === 'wall';
};

interface Replay {
  walls: string[];
  /** worst real-time lag (seconds): how long a resident stood still in the simulation while the cursor was still walking */
  maxLag: number;
  /** real seconds spent visually moving */
  movingSeconds: number;
}

const SUB = 16;

/** runs a world and replays every agent's walk the way the renderer does, sampling densely */
function replay(seed: number, ticks: number, view: MotionView, frames: number): Replay {
  const w = createWorld(seed);
  const cursors = w.agents.map((a) => new AgentMotion(a.pos.x, a.pos.y));
  const out: Replay = { walls: [], maxLag: 0, movingSeconds: 0 };
  const behind = w.agents.map(() => 0);
  const lastPos = w.agents.map((a) => ({ ...a.pos }));
  const frameDt = view.tickSeconds / frames;
  for (let i = 0; i < ticks; i++) {
    tickWorld(w);
    w.agents.forEach((a, k) => {
      const m = cursors[k];
      m.ingest(a.pos, w.tick, trailOf(a));
      // the renderer's cursor, sampled in sub-steps finer than a frame (positions, not chords)
      for (let f = 0; f < frames * SUB; f++) {
        m.advance(frameDt / SUB, view);
        if (m.moving) out.movingSeconds += frameDt / SUB;
        if (isWall(w, m.x, m.y) && out.walls.length < 10) out.walls.push(`seed ${seed} t${w.tick} ${a.name} (${m.x.toFixed(2)}, ${m.y.toFixed(2)})`);
      }
      const still = a.pos.x === lastPos[k].x && a.pos.y === lastPos[k].y;
      lastPos[k] = { ...a.pos };
      if (still && (m.x !== a.pos.x || m.y !== a.pos.y)) behind[k] += view.tickSeconds;
      else behind[k] = 0;
      out.maxLag = Math.max(out.maxLag, behind[k]);
    });
  }
  return out;
}

describe('replayed walks (render/motion.ts)', () => {
  it('never pass through walls — fast mode 1× and 8×', () => {
    for (const seed of [1, 7]) {
      expect(replay(seed, 900, FAST_1X, 12).walls).toEqual([]);
      expect(replay(seed, 600, FAST_8X, 2).walls).toEqual([]);
    }
  });

  it('never pass through walls — real time, and walks take seconds there', () => {
    const r = replay(42, 600, REALTIME, 120);
    expect(r.walls).toEqual([]);
    // 6 residents, 10 game hours: walking is a small part of the time, but visible (minutes in total)
    expect(r.movingSeconds).toBeGreaterThan(60);
    expect(r.movingSeconds).toBeLessThan(0.25 * 6 * 600 * 60);
  });

  it('the fast-mode cursor keeps close to the simulation', () => {
    expect(replay(3, 900, FAST_1X, 12).maxLag).toBeLessThanOrEqual(MOTION.LAG_MAX + 1);
    expect(replay(3, 600, FAST_8X, 2).maxLag).toBeLessThanOrEqual(MOTION.LAG_MIN + 0.5);
  });

  it('a recorded walk replays along its waypoints at walking pace in real time', () => {
    const a = agentAt(0, 0);
    a.path = [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }];
    const m = new AgentMotion(0, 0);
    m.ingest(a.pos, 0, trailOf(a));
    stepAgent(a, WALK_SPEED, 1);
    m.ingest(a.pos, 1, trailOf(a));
    const total = 4 / WALK_TILES_PER_SECOND;
    m.advance(total / 2, REALTIME);
    // halfway along the L: at the corner (2, 0)
    expect(m.x).toBeCloseTo(2, 6);
    expect(m.y).toBeCloseTo(0, 6);
    expect(m.moving).toBe(true);
    m.advance(total / 2 + 0.01, REALTIME);
    expect([m.x, m.y]).toEqual([2, 2]);
    m.advance(0.1, REALTIME);
    expect(m.moving).toBe(false);
  });

  it('snaps on teleports and long fast-forwards instead of sliding through the house', () => {
    const m = new AgentMotion(0, 0);
    m.ingest({ x: 0, y: 0 }, 1, []);
    m.ingest({ x: 9, y: 9 }, 2, []);
    expect([m.x, m.y]).toEqual([9, 9]);
    m.ingest({ x: 9, y: 10 }, 2 + MOTION.SNAP_TICKS + 1, []);
    expect([m.x, m.y]).toEqual([9, 10]);
  });
});

describe('trips in the simulation', () => {
  const w = createWorld(42);
  for (let i = 0; i < 2000; i++) tickWorld(w);
  const tr = traceOf(w);

  it('typical trips complete within the tick they start (≤ 2 ticks)', () => {
    const starts = tr.filter((e) => e.kind === 'start' && e.text.startsWith('idzie do:'));
    let quick = 0, total = 0;
    for (const s of starts) {
      const arrive = tr.find((e) => e.agentId === s.agentId && e.tick >= s.tick && (e.kind === 'arrive' || e.kind === 'end') && e !== s);
      if (!arrive || arrive.kind !== 'arrive') continue;
      total++;
      if (arrive.tick - s.tick <= 1) quick++;
    }
    expect(total).toBeGreaterThan(50);
    expect(quick / total).toBeGreaterThan(0.97);
  });

  it('nobody stays on the way for long (avoidance never deadlocks)', () => {
    const w2 = createWorld(9);
    const onTheWay = new Map<number, number>();
    let worst = 0;
    for (let i = 0; i < 2500; i++) {
      tickWorld(w2);
      for (const a of w2.agents) {
        const act = a.action;
        const walking = (act?.kind === 'use' && act.phase === 'walking') || (act?.kind === 'talk' && act.phase === 'approaching');
        const n = walking ? (onTheWay.get(a.id) ?? 0) + 1 : 0;
        onTheWay.set(a.id, n);
        worst = Math.max(worst, n);
      }
    }
    expect(worst).toBeLessThanOrEqual(10);
  });

  it('walking is deterministic, trails included', () => {
    const run = () => {
      const x = createWorld(5);
      for (let i = 0; i < 700; i++) tickWorld(x);
      return JSON.stringify(x.agents.map((a) => [a.pos, trailOf(a).slice(-20)]));
    };
    expect(run()).toBe(run());
  });
});
