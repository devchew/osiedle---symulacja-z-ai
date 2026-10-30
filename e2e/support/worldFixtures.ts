import type { World } from '../../src/types';
import { createWorld, tickWorld } from '../../src/world/world';
import { snapshotWorld, NETWORK_SNAPSHOT } from '../../src/core/state';
import { setCalendar } from '../../src/core/calendar';
import { weatherOf } from '../../src/world/incidents';
import { placeById, type LiveFrame, type PlaceId } from '../../src/live/protocol';

// World fixtures for the e2e tests (issue #35): LiveFrames generated in Node by the real simulation
// for a given place / seed / tick, the same way server/worlds.ts builds them (createWorld → tickWorld
// → NETWORK_SNAPSHOT). Playwright serves them under /api/live/* (see ./live.ts). No DOM, no Playwright.

export const DAY = 24 * 60;
/** serverTime of tick 0 in the fixture frames: constant, so the frames are reproducible */
export const FIXTURE_SERVER_TIME = Date.UTC(2026, 9, 29, 6, 0);

export interface WorldSpec {
  place: PlaceId;
  /** default: the place's own seed and residents; a different seed keeps the place's house */
  seed?: number;
  agents?: number;
  /** local calendar date (YYYY-MM-DD) of day 1: sets season and weekday; default: the headless calendar */
  date?: string;
}

/** tick of `hour`:00 on `day` (the world starts on day 1 at 07:00); hours past 24 continue into the next day */
export function tickAt(hour: number, day = 1): number {
  return (day - 1) * DAY + (hour - 7) * 60;
}

/** the frame the server would send: snapshot of `world` plus the place meta (plan weather, no AI, no news) */
export function liveFrame(world: World, place: PlaceId): LiveFrame {
  const def = placeById(place);
  if (!def) throw new Error(`unknown place "${place}"`);
  const { kind, intensity, label, icon } = weatherOf(world);
  return {
    meta: {
      place,
      serverTime: FIXTURE_SERVER_TIME + world.tick * 60_000,
      tick: world.tick,
      weather: { city: def.city, temperature: null, source: 'plan', updatedAt: null, sample: { kind, intensity, label, icon } },
      ai: false,
      news: false,
    },
    snapshot: snapshotWorld(world, NETWORK_SNAPSHOT),
  };
}

/** one simulated world that moves forward only; frames and searches are taken along the way */
export class WorldTimeline {
  private world!: World;

  constructor(readonly spec: WorldSpec) {
    this.reset();
  }

  private reset(): void {
    const def = placeById(this.spec.place);
    if (!def) throw new Error(`unknown place "${this.spec.place}"`);
    this.world = createWorld(this.spec.seed ?? def.seed, { agentCount: this.spec.agents ?? def.residents, mapId: def.mapId });
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(this.spec.date ?? '');
    if (date) setCalendar(this.world, Math.round(Date.UTC(+date[1], +date[2] - 1, +date[3]) / 86_400_000));
  }

  /** the world at `tick` (it cannot go back: asking for an earlier tick starts over) */
  advanceTo(tick: number): World {
    if (tick < this.world.tick) this.reset();
    while (this.world.tick < tick) tickWorld(this.world);
    return this.world;
  }

  frameAt(tick: number): LiveFrame {
    return liveFrame(this.advanceTo(tick), this.spec.place);
  }

  /** first tick at or after `from` (default 0; stepping `step` ticks) where `pred` holds; throws when not within `maxTicks` */
  findTick(pred: (world: World) => boolean, opts: { from?: number; step?: number; maxTicks?: number } = {}): number {
    const { from = 0, step = 60, maxTicks = 30 * DAY } = opts;
    for (let t = Math.max(from, 0); t <= from + maxTicks; t += step) if (pred(this.advanceTo(t))) return t;
    throw new Error(`no tick found within ${maxTicks} ticks of ${from} (${this.spec.place})`);
  }
}

const timelines = new Map<string, WorldTimeline>();

/** shared timeline of a spec (per worker process): later requests reuse the already simulated days */
export function timelineOf(spec: WorldSpec): WorldTimeline {
  const key = `${spec.place}/${spec.seed ?? ''}/${spec.agents ?? ''}/${spec.date ?? ''}`;
  let t = timelines.get(key);
  if (!t) timelines.set(key, (t = new WorldTimeline(spec)));
  return t;
}

/** frame of `spec` at `tick` */
export function frameFor(spec: WorldSpec, tick: number): LiveFrame {
  return timelineOf(spec).frameAt(tick);
}
