import type { Action, Agent, Bubble, Conversation, ObjectInstance, SimEvent, World } from '../types';
import { NEED_KEYS } from '../types';
import { applySnapshot, restoreWorld, snapshotWorld, NETWORK_SNAPSHOT, type Json } from '../core/state';
import '../world/world'; // registers the world base and every module's state codec
import { setWeatherOverride, type WeatherSample } from '../world/incidents';
import { petsOf } from '../agents/pets';
import { markRealtime, realtimeStatus, updateRealtimeStatus } from '../realtime/state';
import type { ReplayActionLite, ReplayAgentTrack, ReplayBubbleLite, ReplayPetTrack, ReplayResponse } from './protocol';

// Client side of the "Powtórka" view: turns a ReplayResponse (src/live/replayRecorder.ts) into a World
// the normal renderer and panels can show, and moves it to any recorded tick. The replay world is a
// copy of the live one (the same map, residents, relations, diaries…) whose moving parts — residents,
// pets, objects, weather, events, building projects — are overwritten with what was recorded for the
// tick. Nothing is simulated: the world is never ticked, so what is shown is exactly what happened.
// The live world keeps receiving frames in the background (liveApp), so going back is instant.

/** events kept in the replay world's log (the live world keeps 200 too) */
const EVENTS_KEPT = 200;
/** modules that only hold the walking trails / joint sessions of "now": absent in a replay */
const DROPPED_MODULES = ['movement', 'joint'];

/** playback speeds in recorded ticks (game minutes) per real second: 1 h in 6 s / 3 s / 1.5 s */
export const REPLAY_SPEEDS = [10, 20, 40] as const;
export const REPLAY_DEFAULT_SPEED = 20;

export interface ReplayPlayer {
  readonly world: World;
  readonly data: ReplayResponse;
  /** the tick shown now */
  readonly tick: number;
  readonly playing: boolean;
  /** ticks per real second */
  speed: number;
  /** plays / pauses (playing again from the end starts over) */
  setPlaying(playing: boolean): void;
  /** moves the playback by `dtSeconds` of real time; returns the render alpha (progress within the tick) */
  advance(dtSeconds: number): number;
  /** real temperature at the shown tick (null = unknown) */
  readonly temperature: number | null;
  /** shows the state at `tick` (clamped to the recording) */
  seek(tick: number): void;
}

/** the last row with row[0] <= tick (the first row when tick is before all of them) */
export function rowAt<T extends unknown[]>(rows: readonly T[], tick: number): T | undefined {
  if (rows.length === 0) return undefined;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((rows[mid][0] as number) <= tick) lo = mid;
    else hi = mid - 1;
  }
  return rows[lo];
}

/** number of rows with row[0] <= tick */
function countUpTo<T extends unknown[] | { tick: number }>(rows: readonly T[], tick: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const at = Array.isArray(rows[mid]) ? ((rows[mid] as unknown[])[0] as number) : (rows[mid] as { tick: number }).tick;
    if (at <= tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function toAction(a: ReplayActionLite | null): Action | null {
  if (!a) return null;
  const common = { ticksLeft: 1, label: a.l, icon: a.i };
  switch (a.k) {
    case 'use':
      return { kind: 'use', phase: a.p === 'walking' ? 'walking' : 'using', objectUid: a.o ?? -1, slot: a.s ?? 0, ...common };
    case 'talk':
      return { kind: 'talk', phase: a.p === 'approaching' ? 'approaching' : 'talking', partnerId: a.w ?? -1, conversationId: a.c ?? null, ...common };
    case 'wander':
      return { kind: 'wander', phase: 'walking', ...common };
    default:
      return { kind: 'idle', ...common };
  }
}

function toBubble(b: ReplayBubbleLite | null): Bubble | null {
  return b ? { kind: b.k, text: b.t, ttl: 3, ...(b.tone ? { tone: b.tone } : {}) } : null;
}

/** builds the replay world from the live one (which is not modified) and the recording */
export function createReplayPlayer(live: World, data: ReplayResponse): ReplayPlayer {
  const snap = snapshotWorld(live, NETWORK_SNAPSHOT);
  snap.tick = data.fromTick;
  for (const k of DROPPED_MODULES) if (k in snap.modules) snap.modules[k] = null;
  const world = restoreWorld(snap);
  const status = realtimeStatus(live);
  if (status) markRealtime(world, { ...status });

  let tick = data.fromTick;
  let temperature: number | null = null;
  let sample: WeatherSample | null = null;
  setWeatherOverride(world, () => sample);

  const agentTracks = new Map<number, ReplayAgentTrack>(data.agents.map((t) => [t.id, t]));
  const petTracks = new Map<number, ReplayPetTrack>(data.pets.map((t) => [t.id, t]));
  // objects and projects change rarely: applied together through applySnapshot when their row changes
  let objectsRows = -1;
  let projectsRows = -1;
  // event objects are created once, so the log can follow them by identity
  const events: SimEvent[] = data.events.map(([t, kind, text, agentIds]) => ({ tick: t, kind, text, agentIds: [...agentIds] }));
  let eventCount = -1;
  // keeps the same Action / Bubble object while a row holds (renderer and panels compare identities)
  const cache = new Map<number, { act: unknown; actObj: Action | null; bub: unknown; bubObj: Bubble | null }>();

  function structural(t: number): void {
    const objRows = countUpTo(data.objects, t);
    const prjRows = countUpTo(data.projects, t);
    if (objRows === objectsRows && prjRows === projectsRows) return;
    objectsRows = objRows;
    projectsRows = prjRows;
    const next = snapshotWorld(world, NETWORK_SNAPSHOT);
    const objs = rowAt(data.objects, t);
    if (objs) {
      next.objects = objs[1].map(([uid, type, x, y]): ObjectInstance => {
        const slots = world.objectDefs[type]?.slots.length ?? 1;
        return { uid, type, pos: { x, y }, reservedBy: Array.from({ length: slots }, () => null) };
      });
    }
    const prj = rowAt(data.projects, t);
    const projectsModule = next.modules.projects as { projects?: Json } | null;
    if (prj && projectsModule) next.modules.projects = { ...projectsModule, projects: prj[1] };
    applySnapshot(world, next);
    setWeatherOverride(world, () => sample);
  }

  function agent(a: Agent, track: ReplayAgentTrack, t: number): void {
    const p = rowAt(track.pos, t);
    if (p) {
      a.pos = { x: p[1], y: p[2] };
      a.prevPos = { x: p[1], y: p[2] };
      a.facing = p[3] < 0 ? -1 : 1;
    }
    a.path = [];
    let c = cache.get(a.id);
    if (!c) cache.set(a.id, (c = { act: undefined, actObj: null, bub: undefined, bubObj: null }));
    const act = rowAt(track.act, t);
    if (act !== c.act) {
      c.act = act;
      c.actObj = act ? toAction(act[1]) : null;
    }
    a.action = c.actObj;
    const bub = rowAt(track.bub, t);
    if (bub !== c.bub) {
      c.bub = bub;
      c.bubObj = bub ? toBubble(bub[1]) : null;
    }
    a.bubble = c.bubObj;
    const needs = rowAt(track.needs, t);
    if (needs) {
      a.mood = needs[1];
      NEED_KEYS.forEach((k, i) => (a.needs[k] = needs[2 + i]));
    }
  }

  function conversations(): void {
    const byId = new Map<number, Conversation>();
    for (const a of world.agents) {
      const act = a.action;
      if (act?.kind !== 'talk' || act.conversationId === null) continue;
      const cv = byId.get(act.conversationId);
      if (cv) {
        if (cv.participants[1] === -1 && a.id !== cv.participants[0]) cv.participants[1] = a.id;
      } else {
        byId.set(act.conversationId, {
          id: act.conversationId,
          participants: [a.id, act.partnerId],
          topic: '',
          lines: [],
          nextLineIn: 0,
          pending: false,
          maxLines: 0,
          startedAt: tick,
        });
      }
    }
    world.conversations.splice(0, world.conversations.length, ...byId.values());
  }

  function seek(to: number): void {
    const t = Math.max(data.fromTick, Math.min(data.toTick, Math.round(to)));
    structural(t);
    world.tick = t;
    tick = t;
    for (const a of world.agents) {
      const track = agentTracks.get(a.id);
      if (track) agent(a, track, t);
    }
    for (const p of petsOf(world)) {
      const row = rowAt(petTracks.get(p.id)?.pos ?? [], t);
      if (!row) continue;
      p.pos = { x: row[1], y: row[2] };
      p.facing = row[3] < 0 ? -1 : 1;
      p.activity = row[4] as typeof p.activity;
      p.withId = row[5];
      p.path = [];
    }
    conversations();
    const w = rowAt(data.weather, t);
    if (w) {
      sample = { kind: w[1], intensity: w[2], ...(w[3] ? { label: w[3] } : {}), ...(w[4] ? { icon: w[4] } : {}), ...(w[6] ? { snow: true } : {}) };
      temperature = w[5];
      updateRealtimeStatus(world, { temperature });
    }
    const upTo = countUpTo(events, t);
    if (upTo !== eventCount) {
      eventCount = upTo;
      world.events.splice(0, world.events.length, ...events.slice(Math.max(0, upTo - EVENTS_KEPT), upTo));
    }
  }

  let pos = data.fromTick;
  let playing = true;
  let speed = REPLAY_DEFAULT_SPEED;

  seek(data.fromTick);
  return {
    world,
    data,
    get tick() {
      return tick;
    },
    get playing() {
      return playing;
    },
    get speed() {
      return speed;
    },
    set speed(v: number) {
      speed = Math.max(1, v);
    },
    setPlaying(p) {
      if (p && pos >= data.toTick) pos = data.fromTick;
      playing = p;
    },
    advance(dt) {
      if (playing) {
        pos = Math.min(data.toTick, pos + Math.max(0, dt) * speed);
        if (pos >= data.toTick) playing = false;
      }
      seek(Math.floor(pos));
      return pos >= data.toTick ? 0 : pos - Math.floor(pos);
    },
    get temperature() {
      return temperature;
    },
    seek(to) {
      pos = Math.max(data.fromTick, Math.min(data.toTick, to));
      seek(to);
    },
  };
}
