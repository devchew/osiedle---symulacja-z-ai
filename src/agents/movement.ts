import type { Agent, Vec2, World } from '../types';

// Walking in real units. One tick is one game minute, one tile is about 0.8 m and
// residents walk at a relaxed indoor pace of ~1.1 m/s, so a typical trip across the
// house (10–25 tiles) takes 7–20 game *seconds*: it starts and ends within one tick.
// The simulation therefore treats walking as (almost) free, while the renderer
// replays the recorded trail (see `trailOf` and src/render/motion.ts) at a speed that
// suits the view: real seconds in real-time mode, a short visible walk in the lab.

/** game seconds per tick */
export const TICK_SECONDS = 60;
/** metres per tile (a door is ~1 tile wide, a bed ~2.5 tiles long) */
export const TILE_METERS = 0.8;
/** relaxed indoor walking pace, m/s */
export const WALK_MPS = 1.1;
/** walking speed in tiles per game second (≈ 1.375) */
export const WALK_TILES_PER_SECOND = WALK_MPS / TILE_METERS;
/** tiles per tick (game minute), ≈ 82 — most trips complete within the tick they start */
export const WALK_SPEED = WALK_TILES_PER_SECOND * TICK_SECONDS;
/** ambling pace of a stroll ("Przechadza się"), tiles per tick (~0.55 m/s) */
export const STROLL_SPEED = WALK_SPEED / 2;

/**
 * a point of the path actually walked: tile position reached `t` game seconds into
 * tick `tick`. Consecutive points of one agent are joined by straight segments that
 * never cross walls (pathfinding waypoints, or the short hop between a stand tile and a seat).
 */
export interface TrailPoint {
  tick: number;
  /** game seconds since the start of the tick, 0..TICK_SECONDS */
  t: number;
  x: number;
  y: number;
}

/** points kept per agent: a few ticks of walking, enough for any render frame to catch up */
const TRAIL_MAX = 160;

interface MoveState {
  trail: TrailPoint[];
  /** walking-time already spent in tick `tick` (game seconds) */
  clockTick: number;
  clockT: number;
}

// Render-side information only: nothing here feeds back into decisions, so the
// simulation stays deterministic with or without it (it is still saved with the world
// so that a restored world animates the walk in progress).
const moves = new WeakMap<Walker, MoveState>();

/** anything that walks the grid: residents and pets (agents/pets.ts) */
export type Walker = Pick<Agent, 'pos' | 'path' | 'facing'>;

function stateOf(agent: Walker): MoveState {
  let s = moves.get(agent);
  if (!s) {
    s = { trail: [], clockTick: -1, clockT: 0 };
    moves.set(agent, s);
  }
  return s;
}

/** game seconds the agent has already spent moving in `tick` */
function clockAt(s: MoveState, tick: number): number {
  if (s.clockTick !== tick) {
    s.clockTick = tick;
    s.clockT = 0;
  }
  return s.clockT;
}

function push(s: MoveState, p: TrailPoint): void {
  s.trail.push(p);
  if (s.trail.length > TRAIL_MAX) s.trail.splice(0, s.trail.length - TRAIL_MAX);
}

/** records the agent's current position as the start of a movement, unless it is already the last point */
function markStart(s: MoveState, agent: Walker, tick: number, t: number): void {
  const last = s.trail[s.trail.length - 1];
  if (last && last.tick === tick && last.x === agent.pos.x && last.y === agent.pos.y) return;
  push(s, { tick, t, x: agent.pos.x, y: agent.pos.y });
}

/** the recorded walked path (oldest first); the renderer reads points newer than the last tick it saw */
export function trailOf(agent: Walker): readonly TrailPoint[] {
  return moves.get(agent)?.trail ?? [];
}

/** the walked points of one tick, oldest first */
export function trailForTick(agent: Walker, tick: number): TrailPoint[] {
  return trailOf(agent).filter((p) => p.tick === tick);
}

/**
 * Moves the agent along its path by up to `speed` tiles per tick, carrying leftover
 * distance over waypoints. Assigns a new `pos` object; never touches `prevPos` (the world
 * tick does). With `tick` the walk is recorded (trail + timing within the tick) and the
 * agent's walking time per tick is capped at one minute across several calls.
 */
export function stepAgent(agent: Walker, speed = WALK_SPEED, tick?: number): 'moving' | 'arrived' | 'idle' {
  if (agent.path.length === 0) return 'idle';
  const s = tick === undefined ? null : stateOf(agent);
  const perSecond = speed / TICK_SECONDS;
  let t = s && tick !== undefined ? clockAt(s, tick) : 0;
  if (s && t >= TICK_SECONDS - 1e-9) return 'moving';
  if (s && tick !== undefined) markStart(s, agent, tick, t);
  let { x, y } = agent.pos;
  let budget = s ? perSecond * (TICK_SECONDS - t) : speed;
  while (budget > 1e-9 && agent.path.length > 0) {
    const w = agent.path[0];
    const dx = w.x - x, dy = w.y - y;
    const d = Math.hypot(dx, dy);
    if (Math.abs(dx) > 1e-9) agent.facing = dx < 0 ? -1 : 1;
    if (d <= budget + 1e-6) {
      x = w.x; y = w.y;
      budget = Math.max(0, budget - d);
      agent.path.shift();
      t += d / perSecond;
    } else {
      x += (dx / d) * budget;
      y += (dy / d) * budget;
      t += budget / perSecond;
      budget = 0;
    }
    if (s && tick !== undefined) push(s, { tick, t: Math.min(TICK_SECONDS, t), x, y });
  }
  agent.pos = { x, y };
  if (s) s.clockT = Math.min(TICK_SECONDS, t);
  return agent.path.length === 0 ? 'arrived' : 'moving';
}

/**
 * a short step without pathfinding (stand tile → seat, getting up from furniture):
 * sets `pos` and records it on the trail at walking pace
 */
export function placeAgent(agent: Walker, p: Vec2, tick: number): void {
  const s = stateOf(agent);
  const t0 = clockAt(s, tick);
  const d = Math.hypot(p.x - agent.pos.x, p.y - agent.pos.y);
  if (d > 1e-9) {
    markStart(s, agent, tick, t0);
    const t = Math.min(TICK_SECONDS, t0 + d / WALK_TILES_PER_SECOND);
    push(s, { tick, t, x: p.x, y: p.y });
    s.clockT = t;
  }
  agent.pos = { x: p.x, y: p.y };
}

/** game seconds a walk of `tiles` takes at `speed` tiles per tick */
export function walkSeconds(tiles: number, speed = WALK_SPEED): number {
  return (tiles / speed) * TICK_SECONDS;
}

// ---------------------------------------------------------------- snapshot helpers (world state registry)

export interface MovementSnapshot {
  /** per agent id */
  agents: Record<number, { trail: TrailPoint[]; clockTick: number; clockT: number }>;
}

export function saveMovementState(world: World): MovementSnapshot {
  const agents: MovementSnapshot['agents'] = {};
  for (const a of world.agents) {
    const s = moves.get(a);
    if (s) agents[a.id] = { trail: s.trail.map((p) => ({ ...p })), clockTick: s.clockTick, clockT: s.clockT };
  }
  return { agents };
}

/** one walker's trail and walking clock as plain data (null = none yet) */
export function saveWalkerMove(w: Walker): MovementSnapshot['agents'][number] | null {
  const s = moves.get(w);
  return s ? { trail: s.trail.map((p) => ({ ...p })), clockTick: s.clockTick, clockT: s.clockT } : null;
}

export function loadWalkerMove(w: Walker, data: MovementSnapshot['agents'][number] | null | undefined): void {
  if (data) moves.set(w, { trail: data.trail.map((p) => ({ ...p })), clockTick: data.clockTick, clockT: data.clockT });
  else moves.delete(w);
}

export function loadMovementState(world: World, data: MovementSnapshot | null | undefined): void {
  for (const a of world.agents) {
    const s = data?.agents[a.id];
    if (s) moves.set(a, { trail: s.trail.map((p) => ({ ...p })), clockTick: s.clockTick, clockT: s.clockT });
    else moves.delete(a);
  }
}
