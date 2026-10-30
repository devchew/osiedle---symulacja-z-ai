// Visual walking: replays the path each agent actually walked (agents/movement.ts trailOf)
// at a speed that suits the view, independently of the tick rate.
//
// The simulation finishes most walks within one tick (a game minute), so plain
// prevPos→pos interpolation would either teleport residents or cut through walls.
// Instead each agent has a visual cursor that follows a queue of recorded points:
//  - real-time mode: 1 game second of walking = 1 real second (walks take seconds,
//    like in life; the walk starts when the tick arrives, at the start of the minute);
//  - lab (5 ticks/s × speed): a brisk, still readable pace (MOTION.FAST_RATE),
//    sped up when the cursor lags too far behind the simulation (MOTION lag limits),
//    so the resident arrives at most ~1 s (1×) / 0.3 s (8×) after the simulation did.
// After the queue is drained the agent stands at its simulated position. Pure (no DOM),
// so tests can sample it.

import type { Agent } from '../types';
import { WALK_TILES_PER_SECOND, type TrailPoint } from '../agents/movement';

export const MOTION = {
  /** lab: game seconds of walking replayed per real second (≈ 6 tiles/s) */
  FAST_RATE: 4.5,
  /** lab: the cursor may lag the simulation by this many ticks… */
  LAG_TICKS: 6,
  /** …clamped to [min, max] real seconds */
  LAG_MIN: 0.3,
  LAG_MAX: 1.2,
  /** real time: catch up faster when more than this many seconds of walking are queued (dropped frames) */
  REALTIME_MAX_LAG: 8,
  /** untracked moves longer than this (tiles) are teleports: snap, never slide through walls */
  SNAP_DISTANCE: 2.5,
  /** more ticks than this since the last frame (fast-forward, replay): snap to the simulated position */
  SNAP_TICKS: 30,
} as const;

export interface MotionView {
  /** true in real-time mode (1 tick = 1 real minute) */
  realtime: boolean;
  /** real seconds per tick in the lab (measured), e.g. 0.2 at 1× */
  tickSeconds: number;
}

interface Seg {
  x: number;
  y: number;
  /** game seconds to get here from the previous point (0 = instantly) */
  dt: number;
}

export class AgentMotion {
  x: number;
  y: number;
  /** start of the head segment */
  private fromX: number;
  private fromY: number;
  private queue: Seg[] = [];
  /** game seconds already spent on the head segment */
  private prog = 0;
  private lastTick = -1;
  /** playback rate (game seconds per real second), fixed when walks are queued so a walk ends on time */
  private rate = 0;
  /** facing while walking (0 = use the agent's own) */
  facing: -1 | 0 | 1 = 0;
  /** visually walking this frame */
  moving = false;
  /** tiles moved during the last advance (for the leg animation) */
  moved = 0;

  constructor(x: number, y: number) {
    this.x = this.fromX = x;
    this.y = this.fromY = y;
  }

  /** game seconds of walking still queued */
  get pending(): number {
    let s = -this.prog;
    for (const q of this.queue) s += q.dt;
    return Math.max(0, s);
  }

  get queued(): number {
    return this.queue.length;
  }

  private snap(x: number, y: number): void {
    this.queue = [];
    this.prog = 0;
    this.x = this.fromX = x;
    this.y = this.fromY = y;
  }

  private tail(): { x: number; y: number } {
    return this.queue.length ? this.queue[this.queue.length - 1] : { x: this.x, y: this.y };
  }

  /** appends a move to (x, y); untracked far moves teleport */
  private add(x: number, y: number, dt: number | null): void {
    const t = this.tail();
    const d = Math.hypot(x - t.x, y - t.y);
    if (d < 1e-6) return;
    if (dt === null) {
      if (d > MOTION.SNAP_DISTANCE) return this.snap(x, y);
      dt = d / WALK_TILES_PER_SECOND;
    }
    this.queue.push({ x, y, dt: Math.max(0, dt) });
  }

  /**
   * takes in what the agent walked since the last call: trail points of ticks
   * (lastTick, tick], then its current position (short untracked hops are walked too)
   */
  ingest(pos: { x: number; y: number }, tick: number, trail: readonly TrailPoint[]): void {
    if (this.lastTick < 0 || tick < this.lastTick || tick - this.lastTick > MOTION.SNAP_TICKS) {
      this.snap(pos.x, pos.y);
      this.lastTick = tick;
      return;
    }
    if (tick === this.lastTick) return;
    let prev: TrailPoint | null = null;
    for (const p of trail) {
      if (p.tick <= this.lastTick || p.tick > tick) continue;
      // the first point of a walk is where the agent stood: reached without walking (or a teleport)
      const sameWalk = prev !== null && prev.tick === p.tick;
      this.add(p.x, p.y, sameWalk ? p.t - prev!.t : null);
      prev = p;
    }
    this.add(pos.x, pos.y, null);
    this.lastTick = tick;
  }

  /** moves the cursor by `dtReal` real seconds of playback */
  advance(dtReal: number, view: MotionView): void {
    const pending = this.pending;
    // the rate is chosen so that everything queued finishes within the allowed lag, and only
    // ever raised while walking (recomputing it from the shrinking remainder would never finish)
    let need: number;
    if (view.realtime) need = Math.max(1, pending / MOTION.REALTIME_MAX_LAG);
    else {
      const lag = Math.min(MOTION.LAG_MAX, Math.max(MOTION.LAG_MIN, MOTION.LAG_TICKS * view.tickSeconds));
      need = Math.max(MOTION.FAST_RATE, pending / lag);
    }
    if (this.queue.length === 0 || need > this.rate || (view.realtime && this.rate > need && pending <= MOTION.REALTIME_MAX_LAG)) this.rate = need;
    let budget = Math.max(0, dtReal) * this.rate;
    const x0 = this.x, y0 = this.y;
    let walked = false;
    while (this.queue.length > 0) {
      const head = this.queue[0];
      const need = head.dt - this.prog;
      if (need <= budget + 1e-9) {
        budget -= Math.max(0, need);
        if (head.dt > 0) walked = true;
        this.x = this.fromX = head.x;
        this.y = this.fromY = head.y;
        this.prog = 0;
        this.queue.shift();
        continue;
      }
      this.prog += budget;
      const k = this.prog / head.dt;
      this.x = this.fromX + (head.x - this.fromX) * k;
      this.y = this.fromY + (head.y - this.fromY) * k;
      walked = true;
      break;
    }
    const dx = this.x - x0;
    this.moved = Math.hypot(dx, this.y - y0);
    this.moving = this.queue.length > 0 || (walked && this.moved > 1e-6);
    if (Math.abs(dx) > 1e-4) this.facing = dx < 0 ? -1 : 1;
    else if (!this.moving) this.facing = 0;
  }
}

/** per-agent motion cursors for one world */
export class MotionTracker {
  private readonly cursors = new Map<number, AgentMotion>();
  private lastTick = -1;
  private lastTickAt = 0;
  /** measured real seconds per tick (lab) */
  tickSeconds = 0.2;

  constructor(private readonly trailOf: (a: Agent) => readonly TrailPoint[]) {}

  /** call once per frame before reading positions */
  update(agents: readonly Agent[], tick: number, nowMs: number, dtReal: number, realtime: boolean): void {
    if (tick !== this.lastTick) {
      if (this.lastTick >= 0 && tick > this.lastTick && this.lastTickAt > 0) {
        const per = (nowMs - this.lastTickAt) / 1000 / (tick - this.lastTick);
        if (per > 0 && per < 5) this.tickSeconds += (per - this.tickSeconds) * 0.3;
      }
      this.lastTick = tick;
      this.lastTickAt = nowMs;
    }
    const view: MotionView = { realtime, tickSeconds: this.tickSeconds };
    for (const a of agents) {
      let m = this.cursors.get(a.id);
      if (!m) this.cursors.set(a.id, (m = new AgentMotion(a.pos.x, a.pos.y)));
      m.ingest(a.pos, tick, this.trailOf(a));
      m.advance(dtReal, view);
    }
  }

  of(id: number): AgentMotion | undefined {
    return this.cursors.get(id);
  }
}
