import type { Agent, Grid, ObjectDef, ObjectInstance, Rng, Vec2, World } from '../types';
import { createRng } from '../core/rng';
import { fromJson, registerWorldState, toJson, type Json } from '../core/state';
import { MINUTES_PER_DAY, START_MINUTE } from '../core/time';
import { findPath } from '../agents/pathfinding';
import { pushEvent } from './events';
import { BREAKABLE, OBJECT_DEFS, REPAIR_PREFIX } from './objects';

// World events: weather and broken objects.
//
// Everything here is deterministic: incidents draw from their own RNG stream,
// derived from the world seed, so the weather of a seed does not change when
// agent behaviour (and thus world.rng consumption) is tuned. State lives in a
// WeakMap keyed by the world (no contract changes).
//
// Breakdowns swap the instance's `type` to `repair_<type>` (see objects.ts):
// the brain and the action state machine then see an ordinary object whose
// "use" is repairing it — no changes in src/agents needed. Progress is counted
// here; once enough minutes of work are in, the original type comes back.
// Interrupting agents goes through the `endAction` passed to tickIncidents by
// world.ts, so this module does not import the action state machine (no cycle).

// ---------------------------------------------------------------- types

export type WeatherKind = 'sunny' | 'cloudy' | 'rain' | 'storm';

/** stops what an agent is doing (agents/actions.ts endAction) */
export type EndAction = (world: World, agent: Agent, reason?: string) => void;

export interface WeatherInfo {
  kind: WeatherKind;
  /** Polish label for the HUD, e.g. "Deszcz" */
  label: string;
  icon: string;
  /** 0..1 — rain/storm strength (ramps in and out), cloud cover for 'cloudy', 0 for 'sunny' */
  intensity: number;
  /** true while it rains (rain or storm): outdoor activities are off */
  raining: boolean;
}

export interface BrokenInfo {
  uid: number;
  /** original object type, e.g. "fridge" */
  type: string;
  /** Polish name of the original object */
  name: string;
  /** tick when it broke */
  since: number;
  /** 0..1 */
  progress: number;
  /** agents repairing it right now */
  repairerIds: number[];
}

interface Spell {
  /** minutes of the day, end exclusive (may exceed 1440: clipped) */
  start: number;
  end: number;
  kind: 'rain' | 'storm';
  /** peak strength 0..1 */
  peak: number;
}

interface DayPlan {
  day: number;
  sky: 'sunny' | 'cloudy';
  spells: Spell[];
  /** minutes of the day when something breaks */
  breaks: number[];
}

interface Breakdown {
  uid: number;
  baseType: string;
  since: number;
  /** repair minutes needed (summed over repairers) */
  need: number;
  progress: number;
  /** agent id -> minutes worked */
  work: Map<number, number>;
}

interface IncidentState {
  /** weather plans and breakdown times only: depends on the seed alone */
  rng: Rng;
  /** in-the-moment choices (what breaks, reactions), which depend on the world state */
  eventRng: Rng;
  plan: DayPlan;
  /** weather kind at the last tick (for transition events) */
  last: WeatherKind | null;
  broken: Map<number, Breakdown>;
  /** external weather source (real-time mode); null = the seeded plan */
  override: WeatherSource | null;
}

/** one weather reading from an external source (e.g. real weather in real-time mode) */
export interface WeatherSample {
  kind: WeatherKind;
  /** 0..1, same meaning as WeatherInfo.intensity */
  intensity: number;
  /** optional Polish label / icon (e.g. "Mżawka", "Śnieg ❄️"); defaults per kind */
  label?: string;
  icon?: string;
}
/** weather at a tick; null = no data for that tick (the seeded plan is used) */
export type WeatherSource = (tick: number) => WeatherSample | null;

// ---------------------------------------------------------------- tuning

/** day types: sunny / cloudy / rainy / stormy */
const DAY_WEIGHTS = [0.36, 0.28, 0.28, 0.08];
/** breakdowns per day: 0, 1, 2, 3 */
const BREAKS_PER_DAY = [0.12, 0.45, 0.33, 0.1];
const BREAK_WINDOW: [number, number] = [8 * 60, 18 * 60];
const MAX_BROKEN = 2;
/** outdoor utility multiplier while it rains */
export const RAIN_OUTDOOR = 0.05;
/** an outdoor activity under way when the rain starts ends within this many minutes */
const RAIN_GRACE = 6;
/** a repair needs this many minutes of work */
const REPAIR_WORK: [number, number] = [25, 40];
/** after this long without being fixed, a handyman comes */
const HANDYMAN_AFTER = 8 * 60;
/** minutes of fade at the start and end of a spell */
const RAMP = 25;

const SHELTER_LABEL = 'Chowa się przed deszczem';
const WAIT_LABEL = 'Czeka, aż przestanie padać';

/** accusative of the object name, for "Ola psuje lodówkę" / "Bartek naprawia lodówkę" */
const ACCUSATIVE: Record<string, string> = {
  fridge: 'lodówkę',
  stove: 'kuchenkę',
  shower: 'prysznic',
  bathtub: 'wannę',
  toilet: 'toaletę',
  sink: 'umywalkę',
  tv: 'telewizor',
  computer: 'komputer',
  exercise_bike: 'rowerek treningowy',
  treadmill: 'bieżnię',
};

/** what happens when it breaks by itself */
const BREAK_TEXT: Record<string, string> = {
  fridge: 'Lodówka przestaje chłodzić',
  stove: 'Kuchenka się psuje',
  shower: 'Prysznic przecieka',
  bathtub: 'Wanna się zatyka',
  toilet: 'Toaleta się zatyka',
  sink: 'Umywalka przecieka',
  tv: 'Telewizor gaśnie',
  computer: 'Komputer odmawia posłuszeństwa',
  exercise_bike: 'Rowerek treningowy się psuje',
  treadmill: 'Bieżnia staje',
};

const WEATHER_TEXT: Record<WeatherKind, { label: string; icon: string }> = {
  sunny: { label: 'Słonecznie', icon: '☀️' },
  cloudy: { label: 'Pochmurno', icon: '☁️' },
  rain: { label: 'Deszcz', icon: '🌧️' },
  storm: { label: 'Burza', icon: '⛈️' },
};

// ---------------------------------------------------------------- state

const states = new WeakMap<World, IncidentState>();

// snapshots (core/state.ts): both RNG streams by state; the weather override is a hook, not
// state (real-time mode re-attaches it with setWeatherOverride after a restore)
registerWorldState('incidents', {
  save: (world) => {
    const s = states.get(world);
    if (!s) return null;
    return { rng: s.rng.state(), eventRng: s.eventRng.state(), plan: toJson(s.plan), last: s.last, broken: toJson(s.broken) };
  },
  load: (world, data) => {
    const d = data as { rng: number; eventRng: number; plan: Json; last: WeatherKind | null; broken: Json };
    states.set(world, {
      rng: createRng((world.seed ^ 0x5eedc10d) >>> 0, d.rng),
      eventRng: createRng((world.seed ^ 0x0b5e55ed) >>> 0, d.eventRng),
      plan: fromJson<DayPlan>(d.plan),
      last: d.last,
      broken: fromJson<Map<number, Breakdown>>(d.broken),
      override: null,
    });
  },
  // the weather override is a hook: whoever attached it re-attaches it after an in-place update
  clear: (world) => void states.delete(world),
});

function dayOf(tick: number): number {
  return Math.floor((tick + START_MINUTE) / MINUTES_PER_DAY) + 1;
}

function minuteOfDay(tick: number): number {
  return (tick + START_MINUTE) % MINUTES_PER_DAY;
}

function makePlan(rng: Rng, day: number): DayPlan {
  const type = rng.weightedIndex(DAY_WEIGHTS);
  const spells: Spell[] = [];
  const spell = (kind: Spell['kind'], start: number, len: number, peak: number) =>
    spells.push({ kind, start, end: Math.min(MINUTES_PER_DAY, start + len), peak });
  if (type === 1 && rng.chance(0.3)) spell('rain', rng.int(9 * 60, 19 * 60), rng.int(40, 90), rng.range(0.35, 0.6));
  if (type === 2) {
    const n = rng.chance(0.45) ? 2 : 1;
    for (let i = 0; i < n; i++) {
      // two spells: one in the first half of the day, one in the second
      const from = n === 1 ? 6 * 60 : i === 0 ? 5 * 60 : 13 * 60;
      const to = n === 1 ? 19 * 60 : i === 0 ? 11 * 60 : 20 * 60;
      spell('rain', rng.int(from, to), rng.int(90, 240), rng.range(0.55, 0.95));
    }
  }
  if (type === 3) {
    const start = rng.int(13 * 60, 19 * 60);
    const len = rng.int(60, 140);
    spell('rain', start - 50, 50, 0.7);
    spell('storm', start, len, 1);
    spell('rain', start + len, rng.int(40, 90), 0.6);
  }
  const breaks: number[] = [];
  const nBreaks = rng.weightedIndex(BREAKS_PER_DAY);
  for (let i = 0; i < nBreaks; i++) breaks.push(rng.int(BREAK_WINDOW[0], BREAK_WINDOW[1]));
  return { day, sky: type === 0 ? 'sunny' : 'cloudy', spells, breaks };
}

function stateOf(world: World): IncidentState {
  let s = states.get(world);
  if (!s) {
    const rng = createRng((world.seed ^ 0x5eedc10d) >>> 0);
    const eventRng = createRng((world.seed ^ 0x0b5e55ed) >>> 0);
    s = { rng, eventRng, plan: makePlan(rng, dayOf(world.tick)), last: null, broken: new Map(), override: null };
    states.set(world, s);
  }
  return s;
}

/** sets up the weather plan of the first day; call once from createWorld (lazy otherwise) */
export function initIncidents(world: World): void {
  stateOf(world).last = weatherOf(world).kind;
}

// ---------------------------------------------------------------- weather

function weatherAt(plan: DayPlan, minute: number): WeatherInfo {
  let kind: WeatherKind = plan.sky;
  let intensity = plan.sky === 'cloudy' ? 0.5 : 0;
  for (const sp of plan.spells) {
    if (minute < sp.start || minute >= sp.end) continue;
    const edge = Math.min(minute - sp.start, sp.end - minute);
    const k = sp.peak * (0.35 + 0.65 * Math.min(1, edge / RAMP));
    if (sp.kind === 'storm' || kind !== 'storm') {
      kind = sp.kind;
      intensity = k;
    }
  }
  return toInfo({ kind, intensity }, minute);
}

function toInfo(sample: WeatherSample, minute: number): WeatherInfo {
  const { kind } = sample;
  const t = WEATHER_TEXT[kind];
  const night = minute < 5 * 60 || minute >= 21 * 60;
  const label = kind === 'sunny' && night ? 'Pogodnie' : (sample.label ?? t.label);
  const icon = kind === 'sunny' && night ? '🌙' : (sample.icon ?? t.icon);
  const intensity = Math.max(0, Math.min(1, sample.intensity));
  return { kind, label, icon, intensity, raining: kind === 'rain' || kind === 'storm' };
}

/** weather at a tick: the external source when set and it has data, else the seeded plan of that tick's day */
function weatherAtTick(s: IncidentState, tick: number): WeatherInfo {
  const minute = minuteOfDay(tick);
  const sample = s.override?.(tick);
  return sample ? toInfo(sample, minute) : weatherAt(s.plan, minute);
}

/**
 * replaces the seeded weather with an external source (real-time mode), or restores the plan with null.
 * Downstream effects (rain availability, sheltering, transition events, rendering) are unchanged.
 * The seeded plan keeps being generated (same RNG draws), so breakdowns stay as they were.
 */
export function setWeatherOverride(world: World, source: WeatherSource | null): void {
  stateOf(world).override = source;
}

export function hasWeatherOverride(world: World): boolean {
  return !!states.get(world)?.override;
}

/** current weather, for the HUD and the renderer */
export function weatherOf(world: World): WeatherInfo {
  return weatherAtTick(stateOf(world), world.tick);
}

/** today's weather in hourly steps (24 entries), e.g. for a forecast strip */
export function forecastOf(world: World): WeatherInfo[] {
  const s = stateOf(world);
  const dayStart = world.tick - minuteOfDay(world.tick);
  return Array.from({ length: 24 }, (_, h) => weatherAtTick(s, dayStart + h * 60 + 30));
}

export function isOutdoorTile(grid: Grid, x: number, y: number): boolean {
  const k = grid.tiles[Math.round(y) * grid.width + Math.round(x)];
  return k === 'grass' || k === 'path' || k === 'water';
}

function isOutdoorDef(def: ObjectDef | undefined): boolean {
  return !!def?.tags?.includes('outdoor');
}

/** nearest walkable indoor tile (BFS over walkable tiles) */
function nearestIndoor(grid: Grid, from: Vec2): Vec2 | null {
  const w = grid.width;
  const sx = Math.round(from.x);
  const sy = Math.round(from.y);
  const seen = new Uint8Array(w * grid.height);
  const queue = [sy * w + sx];
  seen[sy * w + sx] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi];
    const x = i % w;
    const y = (i - x) / w;
    const k = grid.tiles[i];
    if ((k === 'floor' || k === 'tile') && !grid.solid[i]) return { x, y };
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= grid.height) continue;
      const j = ny * w + nx;
      if (seen[j] || grid.solid[j]) continue;
      seen[j] = 1;
      queue.push(j);
    }
  }
  return null;
}

function waitForRain(agent: Agent, rng: Rng): void {
  agent.path = [];
  agent.action = { kind: 'idle', ticksLeft: rng.int(12, 25), label: WAIT_LABEL, icon: '🌧️' };
}

/** while it rains: outdoor activities wrap up, nobody starts new ones, people outside go in */
function applyRain(world: World, s: IncidentState, endAction: EndAction): void {
  for (const agent of world.agents) {
    const a = agent.action;
    if (a?.kind === 'use') {
      const obj = world.objects.find((o) => o.uid === a.objectUid);
      if (!obj || !isOutdoorDef(world.objectDefs[obj.type])) continue;
      if (a.phase === 'using') a.ticksLeft = Math.min(a.ticksLeft, RAIN_GRACE);
      else {
        // still on the way: change of plans (the goal bonus can outweigh the rain penalty)
        endAction(world, agent, 'deszcz — zmiana planów');
        waitForRain(agent, s.eventRng);
      }
      continue;
    }
    if (a?.kind === 'wander' && a.label === SHELTER_LABEL) continue;
    const outdoors = isOutdoorTile(world.grid, agent.pos.x, agent.pos.y);
    if (a?.kind === 'talk') {
      // a chat outside wraps up after the next line; nobody walks out to start one
      if (outdoors && a.phase === 'talking') {
        const conv = world.conversations.find((c) => c.id === a.conversationId);
        if (conv) conv.maxLines = Math.min(conv.maxLines, conv.lines.length + 1);
        continue;
      }
      if (!outdoors) continue;
      endAction(world, agent, 'deszcz');
    }
    if (outdoors) {
      const target = nearestIndoor(world.grid, agent.pos);
      const path = target && findPath(world.grid, agent.pos, target);
      if (path && path.length > 0) {
        agent.path = path;
        agent.action = { kind: 'wander', phase: 'walking', ticksLeft: 150, label: SHELTER_LABEL, icon: '☔' };
      }
      continue;
    }
    // indoors: a stroll that leads outside turns into looking out of the window
    if (a?.kind === 'wander') {
      const dest = agent.path[agent.path.length - 1];
      if (dest && isOutdoorTile(world.grid, dest.x, dest.y)) waitForRain(agent, s.eventRng);
    }
  }
}

function weatherEvents(world: World, s: IncidentState, now: WeatherInfo): void {
  const prev = s.last;
  s.last = now.kind;
  if (prev === null || prev === now.kind) return;
  const wasRaining = prev === 'rain' || prev === 'storm';
  let text: string | null = null;
  if (now.kind === 'storm') text = wasRaining ? 'Zaczyna się burza ⛈️' : 'Nadciąga burza ⛈️';
  else if (now.kind === 'rain') text = prev === 'storm' ? 'Burza przechodzi, jeszcze pada 🌧️' : 'Zaczyna padać 🌧️';
  else if (wasRaining) text = now.kind === 'sunny' ? 'Przejaśnia się ☀️' : 'Przestaje padać ☁️';
  if (text) pushEvent(world, 'info', text, []);
}

// ---------------------------------------------------------------- breakdowns

/** the original type of a (possibly broken) object */
export function baseTypeOf(type: string): string {
  return type.startsWith(REPAIR_PREFIX) ? type.slice(REPAIR_PREFIX.length) : type;
}

export function isBroken(obj: ObjectInstance): boolean {
  return obj.type.startsWith(REPAIR_PREFIX);
}

function usersOf(world: World, obj: ObjectInstance, phase?: 'walking' | 'using'): Agent[] {
  return world.agents.filter(
    (a) => a.action?.kind === 'use' && a.action.objectUid === obj.uid && (!phase || a.action.phase === phase),
  );
}

function breakSomething(world: World, s: IncidentState, endAction: EndAction): void {
  if (s.broken.size >= MAX_BROKEN) return;
  const brokenTypes = new Set([...s.broken.values()].map((b) => b.baseType));
  const candidates = world.objects.filter((o) => BREAKABLE.includes(o.type) && !brokenTypes.has(o.type));
  if (!candidates.length) return;
  // things break while being used more often than when idle
  const weights = candidates.map((o) => (usersOf(world, o, 'using').length > 0 ? 3 : 1));
  const obj = candidates[s.eventRng.weightedIndex(weights)];
  const baseType = obj.type;
  const def = world.objectDefs[baseType];
  const culprit = usersOf(world, obj, 'using')[0];
  for (const a of usersOf(world, obj)) endAction(world, a, 'awaria obiektu');
  if (culprit) culprit.bubble = { kind: 'speech', text: s.eventRng.pick(['Ups… 😳', 'Ojej, coś trzasnęło!', 'To nie moja wina!']), ttl: 30, tone: 'negative' };

  obj.type = REPAIR_PREFIX + baseType;
  // one repairer at a time: the repair variant has a single slot
  obj.reservedBy = [null];
  s.broken.set(obj.uid, {
    uid: obj.uid,
    baseType,
    since: world.tick,
    need: s.eventRng.int(REPAIR_WORK[0], REPAIR_WORK[1]),
    progress: 0,
    work: new Map(),
  });

  const acc = ACCUSATIVE[baseType] ?? def.name.toLowerCase();
  if (culprit) {
    pushEvent(world, 'info', `${culprit.name} psuje ${acc} 🔧`, [culprit.id], {
      text: `${culprit.name} psuje ${acc}`,
      aboutIds: [culprit.id],
      valence: -0.4,
    });
  } else pushEvent(world, 'info', `${BREAK_TEXT[baseType] ?? `${def.name} się psuje`} 🔧`, []);
}

function fix(world: World, s: IncidentState, b: Breakdown, by: Agent | null, endAction: EndAction): void {
  const obj = world.objects.find((o) => o.uid === b.uid);
  s.broken.delete(b.uid);
  if (!obj) return;
  for (const a of usersOf(world, obj)) endAction(world, a, 'naprawa zakończona');
  obj.type = b.baseType;
  obj.reservedBy = world.objectDefs[b.baseType].slots.map(() => null);
  const acc = ACCUSATIVE[b.baseType] ?? OBJECT_DEFS[b.baseType]?.name.toLowerCase() ?? b.baseType;
  if (by) {
    by.bubble = { kind: 'speech', text: 'Gotowe! Działa jak nowe 🔧', ttl: 30, tone: 'positive' };
    by.needs.fun = Math.min(100, by.needs.fun + 8);
    pushEvent(world, 'use', `${by.name} naprawia ${acc} 🔧✨`, [by.id], {
      text: `${by.name} naprawia ${acc}`,
      aboutIds: [by.id],
      valence: 0.5,
    });
  } else pushEvent(world, 'info', `Przychodzi fachowiec i naprawia ${acc} 🧰`, []);
}

function tickRepairs(world: World, s: IncidentState, endAction: EndAction): void {
  for (const b of [...s.broken.values()]) {
    const obj = world.objects.find((o) => o.uid === b.uid);
    if (!obj) {
      s.broken.delete(b.uid);
      continue;
    }
    for (const a of usersOf(world, obj, 'using')) {
      const first = !b.work.has(a.id);
      b.work.set(a.id, (b.work.get(a.id) ?? 0) + 1);
      b.progress++;
      if (first) a.bubble = { kind: 'thought', text: '🔧', ttl: 20 };
    }
    if (b.progress >= b.need) {
      let best: Agent | null = null;
      let most = 0;
      for (const [id, m] of b.work) {
        if (m > most) {
          most = m;
          best = world.agents.find((x) => x.id === id) ?? null;
        }
      }
      fix(world, s, b, best, endAction);
    } else if (world.tick - b.since >= HANDYMAN_AFTER && usersOf(world, obj, 'using').length === 0) fix(world, s, b, null, endAction);
  }
}

/** objects that are broken right now, for the UI */
export function brokenObjects(world: World): BrokenInfo[] {
  const s = states.get(world);
  if (!s) return [];
  return [...s.broken.values()].map((b) => {
    const obj = world.objects.find((o) => o.uid === b.uid);
    return {
      uid: b.uid,
      type: b.baseType,
      name: OBJECT_DEFS[b.baseType]?.name ?? b.baseType,
      since: b.since,
      progress: Math.min(1, b.progress / b.need),
      repairerIds: obj ? usersOf(world, obj, 'using').map((a) => a.id) : [],
    };
  });
}

// ---------------------------------------------------------------- tick

/** advances weather and incidents; called once per tick after agents act. `endAction` interrupts agents (rain, breakdowns, finished repairs) */
export function tickIncidents(world: World, endAction: EndAction): void {
  const s = stateOf(world);
  const day = dayOf(world.tick);
  if (day !== s.plan.day) s.plan = makePlan(s.rng, day);
  const minute = minuteOfDay(world.tick);

  const weather = weatherAtTick(s, world.tick);
  weatherEvents(world, s, weather);
  if (weather.raining) applyRain(world, s, endAction);

  for (const m of s.plan.breaks) if (m === minute) breakSomething(world, s, endAction);
  tickRepairs(world, s, endAction);
}

/**
 * multiplier (0 = unusable) applied to an object's utility score:
 * rain for outdoor activities; broken objects advertise their repair, more urgently the longer they wait
 */
export function availability(world: World, obj: ObjectInstance, def: ObjectDef): number {
  if (isBroken(obj)) {
    const b = states.get(world)?.broken.get(obj.uid);
    const hours = b ? (world.tick - b.since) / 60 : 0;
    return Math.min(10, 5 + hours);
  }
  if (isOutdoorDef(def) && weatherAtTick(stateOf(world), world.tick).raining) return RAIN_OUTDOOR;
  return 1;
}
