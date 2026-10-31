import type { Agent, SimEvent, World } from '../types';
import { NEED_KEYS } from '../types';
import { saveWorldModule, type Json } from '../core/state';
import { weatherOf } from '../world/incidents';
import { petsOf } from '../agents/pets';
import { isGuest } from '../agents/role';
import type { PlaceId, ReplayActionLite, ReplayAgentTrack, ReplayBubbleLite, ReplayPetTrack, ReplayResponse } from './protocol';

// Server-side recorder of the last 24 h of a live world, for the "Powtórka" view (issue #5).
//
// After every tick the recorder keeps what the viewer sees — each resident's position, facing, action
// and bubble, the pets, the set of objects, the weather, the new events — as change-only rows (a row
// holds until the next one), so a quiet world costs almost nothing. Needs / mood are sampled every
// NEEDS_EVERY ticks as integers and the building projects every PROJECTS_EVERY ticks when changed.
// It only reads the world (never touches rng or state), keeps at most WINDOW_TICKS of history (older
// rows are pruned, so memory is bounded) and its data is the response of GET /api/live/:place/replay
// (a few tens of KB gzipped for 8 residents), saved next to the world snapshot.

/** 24 game hours */
export const REPLAY_WINDOW_TICKS = 1440;
export const NEEDS_EVERY = 10;
export const PROJECTS_EVERY = 30;
/** safety cap on recorded events (about 5× a busy day) */
export const REPLAY_MAX_EVENTS = 3000;
export const REPLAY_FORMAT = 1;

type Rows<T extends unknown[]> = T[];

interface AgentRec {
  pos: Rows<[number, number, number, number]>;
  act: Rows<[number, ReplayActionLite | null]>;
  bub: Rows<[number, ReplayBubbleLite | null]>;
  needs: number[][];
  guest?: ReplayAgentTrack['guest'];
  pres: Rows<[number, 0 | 1]>;
  presKey: string;
  posKey: string;
  actKey: string;
  bubKey: string;
  needsKey: string;
}

interface PetRec {
  pos: Rows<[number, number, number, number, string, number | null]>;
  key: string;
}

export interface ReplayRecorder {
  /** appends the state of `world` after its current tick; `temperature` = the real temperature now (null = none) */
  record(world: World, temperature: number | null): void;
  /** drops everything after `tick` (a restored world is behind a saved recording and re-records it) */
  rewind(tick: number): void;
  /** last recorded tick (-1 = nothing yet) */
  readonly lastTick: number;
  /** the recording as a response (copies nothing: do not mutate; serialize it right away) */
  data(serverTime: number): ReplayResponse;
  /** replaces the recording with saved data of the same place; throws when it is unusable */
  restore(data: unknown): void;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;
const r2 = (n: number): number => Math.round(n * 20) / 20;

function actionLite(a: Agent['action']): ReplayActionLite | null {
  if (!a) return null;
  switch (a.kind) {
    case 'use':
      return { k: 'use', p: a.phase, o: a.objectUid, s: a.slot, l: a.label, i: a.icon };
    case 'talk':
      return { k: 'talk', p: a.phase, w: a.partnerId, c: a.conversationId, l: a.label, i: a.icon };
    case 'wander':
      return { k: 'wander', p: a.phase, l: a.label, i: a.icon };
    default:
      return { k: 'idle', l: a.label, i: a.icon };
  }
}

function bubbleLite(b: Agent['bubble']): ReplayBubbleLite | null {
  if (!b) return null;
  return b.tone ? { k: b.kind, t: b.text, tone: b.tone } : { k: b.kind, t: b.text };
}

/** the row valid at `tick` is the last one with row[0] <= tick; keeps one row at or before `cutoff` as the window's base state */
function prune<T extends unknown[]>(rows: T[], cutoff: number): void {
  let drop = 0;
  while (drop + 1 < rows.length && (rows[drop + 1][0] as number) <= cutoff) drop++;
  if (drop > 0) rows.splice(0, drop);
}

function cut<T extends unknown[]>(rows: T[], tick: number): void {
  while (rows.length && (rows[rows.length - 1][0] as number) > tick) rows.pop();
}

export function createReplayRecorder(place: PlaceId, windowTicks = REPLAY_WINDOW_TICKS): ReplayRecorder {
  let first = -1;
  let last = -1;
  let agents = new Map<number, AgentRec>();
  let pets = new Map<number, PetRec>();
  let objects: ReplayResponse['objects'] = [];
  let objectsKey = '';
  let weather: ReplayResponse['weather'] = [];
  let weatherKey = '';
  let events: ReplayResponse['events'] = [];
  let lastEventTick = -1;
  let projects: ReplayResponse['projects'] = [];
  let projectsKey = '';

  function recordAgents(tick: number, world: World): void {
    for (const a of world.agents) {
      let rec = agents.get(a.id);
      if (!rec) agents.set(a.id, (rec = { pos: [], act: [], bub: [], needs: [], pres: [], presKey: '', posKey: '', actKey: '', bubKey: '', needsKey: '' }));
      if (isGuest(a)) {
        rec.guest ??= { name: a.name, color: a.color, traits: { ...a.traits } };
        if (rec.presKey !== '1') {
          rec.pres.push([tick, 1]);
          rec.presKey = '1';
        }
      }
      const x = r1(a.pos.x), y = r1(a.pos.y);
      const posKey = `${x}|${y}|${a.facing}`;
      if (posKey !== rec.posKey) {
        rec.pos.push([tick, x, y, a.facing]);
        rec.posKey = posKey;
      }
      const act = actionLite(a.action);
      const actKey = JSON.stringify(act);
      if (actKey !== rec.actKey) {
        rec.act.push([tick, act]);
        rec.actKey = actKey;
      }
      const bub = bubbleLite(a.bubble);
      const bubKey = JSON.stringify(bub);
      if (bubKey !== rec.bubKey) {
        rec.bub.push([tick, bub]);
        rec.bubKey = bubKey;
      }
      if (rec.needs.length === 0 || tick % NEEDS_EVERY === 0) {
        const row = [Math.round(a.mood), ...NEED_KEYS.map((k) => Math.round(a.needs[k]))];
        const key = row.join('|');
        if (key !== rec.needsKey) {
          rec.needs.push([tick, ...row]);
          rec.needsKey = key;
        }
      }
    }
  }

  /** a visitor that left the map: one closing row, so a replay knows when to take it off */
  function recordDepartures(tick: number, world: World): void {
    for (const [id, rec] of agents) {
      if (!rec.guest || rec.presKey !== '1' || world.agents.some((a) => a.id === id)) continue;
      rec.pres.push([tick, 0]);
      rec.presKey = '0';
    }
  }

  function recordPets(tick: number, world: World): void {
    for (const p of petsOf(world)) {
      let rec = pets.get(p.id);
      if (!rec) pets.set(p.id, (rec = { pos: [], key: '' }));
      const x = r1(p.pos.x), y = r1(p.pos.y);
      const key = `${x}|${y}|${p.facing}|${p.activity}|${p.withId}`;
      if (key !== rec.key) {
        rec.pos.push([tick, x, y, p.facing, p.activity, p.withId]);
        rec.key = key;
      }
    }
  }

  function recordObjects(tick: number, world: World): void {
    const list = world.objects.map((o): [number, string, number, number] => [o.uid, o.type, o.pos.x, o.pos.y]);
    const key = JSON.stringify(list);
    if (key === objectsKey) return;
    objects.push([tick, list]);
    objectsKey = key;
  }

  function recordWeather(tick: number, world: World, temperature: number | null): void {
    const w = weatherOf(world);
    const intensity = r2(w.intensity);
    const temp = temperature === null ? null : Math.round(temperature);
    const snow = w.snow ? 1 : 0;
    const key = `${w.kind}|${intensity}|${w.label}|${w.icon}|${temp}|${snow}`;
    if (key === weatherKey) return;
    weather.push(snow ? [tick, w.kind, intensity, w.label, w.icon, temp, 1] : [tick, w.kind, intensity, w.label, w.icon, temp]);
    weatherKey = key;
  }

  function recordEvents(world: World): void {
    const list: readonly SimEvent[] = world.events;
    let from = list.length;
    while (from > 0 && list[from - 1].tick > lastEventTick) from--;
    for (let i = from; i < list.length; i++) events.push([list[i].tick, list[i].kind, list[i].text, [...list[i].agentIds]]);
    if (events.length > REPLAY_MAX_EVENTS) events.splice(0, events.length - REPLAY_MAX_EVENTS);
    lastEventTick = Math.max(lastEventTick, world.tick);
  }

  function recordProjects(tick: number, world: World): void {
    if (projects.length > 0 && tick % PROJECTS_EVERY !== 0) return;
    const mod = saveWorldModule(world, 'projects') as { projects?: Json } | null;
    const list = mod?.projects ?? [];
    const key = JSON.stringify(list);
    if (key === projectsKey) return;
    projects.push([tick, JSON.parse(key) as Json]);
    projectsKey = key;
  }

  /** rebuilds the "last row" keys after a restore / rewind so unchanged state is not recorded twice */
  function resetKeys(): void {
    for (const rec of agents.values()) {
      const pr = rec.pres[rec.pres.length - 1];
      rec.presKey = pr ? String(pr[1]) : '';
      const p = rec.pos[rec.pos.length - 1];
      rec.posKey = p ? `${p[1]}|${p[2]}|${p[3]}` : '';
      rec.actKey = rec.act.length ? JSON.stringify(rec.act[rec.act.length - 1][1]) : '';
      rec.bubKey = rec.bub.length ? JSON.stringify(rec.bub[rec.bub.length - 1][1]) : '';
      const n = rec.needs[rec.needs.length - 1];
      rec.needsKey = n ? n.slice(1).join('|') : '';
    }
    for (const rec of pets.values()) {
      const p = rec.pos[rec.pos.length - 1];
      rec.key = p ? `${p[1]}|${p[2]}|${p[3]}|${p[4]}|${p[5]}` : '';
    }
    objectsKey = objects.length ? JSON.stringify(objects[objects.length - 1][1]) : '';
    const w = weather[weather.length - 1];
    weatherKey = w ? `${w[1]}|${w[2]}|${w[3]}|${w[4]}|${w[5]}|${w[6] ?? 0}` : '';
    projectsKey = projects.length ? JSON.stringify(projects[projects.length - 1][1]) : '';
  }

  function pruneAll(cutoff: number): void {
    for (const rec of agents.values()) {
      prune(rec.pos, cutoff);
      prune(rec.act, cutoff);
      prune(rec.bub, cutoff);
      prune(rec.needs, cutoff);
      prune(rec.pres, cutoff);
    }
    for (const rec of pets.values()) prune(rec.pos, cutoff);
    prune(objects, cutoff);
    prune(weather, cutoff);
    prune(projects, cutoff);
    let drop = 0;
    while (drop < events.length && events[drop][0] < cutoff) drop++;
    if (drop) events.splice(0, drop);
    first = Math.max(first, cutoff);
  }

  return {
    get lastTick() {
      return last;
    },
    record(world, temperature) {
      const tick = world.tick;
      if (tick <= last) return;
      if (first < 0) first = tick;
      recordAgents(tick, world);
      recordDepartures(tick, world);
      recordPets(tick, world);
      recordObjects(tick, world);
      recordWeather(tick, world, temperature);
      recordEvents(world);
      recordProjects(tick, world);
      last = tick;
      if (tick % 60 === 0) pruneAll(tick - windowTicks);
    },
    rewind(tick) {
      if (tick >= last) return;
      for (const rec of agents.values()) {
        cut(rec.pos, tick);
        cut(rec.act, tick);
        cut(rec.bub, tick);
        cut(rec.needs, tick);
        cut(rec.pres, tick);
      }
      for (const rec of pets.values()) cut(rec.pos, tick);
      cut(objects, tick);
      cut(weather, tick);
      cut(projects, tick);
      while (events.length && events[events.length - 1][0] > tick) events.pop();
      last = tick;
      lastEventTick = Math.min(lastEventTick, tick);
      if (first > last) first = last;
      resetKeys();
    },
    data(serverTime) {
      const from = Math.max(first, last - windowTicks);
      return {
        format: REPLAY_FORMAT,
        place,
        fromTick: Math.max(0, from),
        toTick: last,
        serverTime,
        agents: [...agents].map(([id, r]): ReplayAgentTrack => ({ id, pos: r.pos, act: r.act, bub: r.bub, needs: r.needs, ...(r.guest ? { guest: r.guest, pres: r.pres } : {}) })),
        pets: [...pets].map(([id, r]): ReplayPetTrack => ({ id, pos: r.pos })),
        objects,
        weather,
        events: events.filter((e) => e[0] >= from),
        projects,
      };
    },
    restore(raw) {
      const d = raw as Partial<ReplayResponse> | null;
      if (!d || d.format !== REPLAY_FORMAT || d.place !== place || typeof d.fromTick !== 'number' || typeof d.toTick !== 'number') throw new Error(`not a replay of "${place}"`);
      if (![d.agents, d.pets, d.objects, d.weather, d.events, d.projects].every(Array.isArray)) throw new Error('bad replay rows');
      agents = new Map(
        d.agents!.map((t) => [t.id, { pos: t.pos, act: t.act, bub: t.bub, needs: t.needs, guest: t.guest, pres: t.pres ?? [], presKey: '', posKey: '', actKey: '', bubKey: '', needsKey: '' }] as const),
      );
      pets = new Map(d.pets!.map((t) => [t.id, { pos: t.pos, key: '' }] as const));
      objects = d.objects!;
      weather = d.weather!;
      events = d.events!;
      projects = d.projects!;
      first = d.fromTick;
      last = d.toTick;
      lastEventTick = d.toTick;
      resetKeys();
    },
  };
}
