import type { Agent, NeedKey, ObjectDef, ObjectInstance, Rng, Vec2, World } from '../../types';
import { NEED_KEYS } from '../../types';
import { createRng } from '../../core/rng';
import { fromJson, registerWorldState, toJson, type Json } from '../../core/state';
import { MINUTES_PER_DAY, START_MINUTE } from '../../core/time';
import { pushEvent } from '../events';
import { markSolid } from '../grid';
import { findPath } from '../../agents/pathfinding';
import { mapIdOf } from '../maps';
import { brokenObjects, weatherOf } from '../incidents';
import { PROJECT_DEFS, PROJECT_KINDS, PROJECT_ORDER, SITE_HINTS, WORK_COSTS, projectTypeInfo, type ProjectKind, type ProjectKindId } from './defs';
import { residentsOf } from '../../agents/role';

// Multi-day building projects: residents build a garden gazebo ("altana") together over about
// two weeks, then a small vegetable garden ("warzywnik"), a tree house ("domek na drzewie") and,
// where there is water, a pier ("pomost").
//
// How it works without touching the agents: the construction site is an ordinary object whose
// "use" is working on it (def effects: fun and company; the costs — energy, hygiene, comfort —
// are applied here per worker minute, so a resident who is not bored still considers it), so the
// utility AI picks it like any other activity. `projectAppeal` (called by the brain) shapes when
// it is attractive: daytime 08–19 only, never in the rain, more when the project lags behind its
// loose schedule, less once today's share of work is done. Progress is counted here per worker
// minute (×TEAM_BONUS while two or more work together); each stage is its own object type, so a
// stage change swaps `obj.type` and the renderer redraws the site; the finished building is a new
// type again (the gazebo: a social seating spot).
//
// Determinism: decisions (when, who proposes, where to build, today's helpers) draw from an own
// RNG stream derived from the seed, so world.rng is not consumed here. Log events carry no
// agent ids (like weather / breakdowns they are world news with their own budget); the people
// involved are in the gossip (memories) and in projectDayFacts (diaries). Everything else follows
// from the world state, so a replay (seed + tick) rebuilds the same project state.

export { PROJECT_DEFS, PROJECT_KINDS, projectTypeInfo };
export type { ProjectKind, ProjectKindId };

// ---------------------------------------------------------------- tuning

/** a worker's minute counts this much while at least two work together */
export const TEAM_BONUS = 1.5;
/** construction work happens between these hours (end exclusive) */
export const WORK_HOURS: [number, number] = [8, 19];
const WORK_MINUTES_PER_DAY = (WORK_HOURS[1] - WORK_HOURS[0]) * 60;
/** first proposal: day 1 afternoon (share) or day 2 late morning */
const FIRST_PROPOSAL_DAY1 = 0.6;
/** the next project is proposed the day after the previous one is finished, at 10:00 + 0..300 min */
const NEXT_PROPOSAL_AT = 10 * 60;
/** schedule pull: appeal *= 1 + SCHEDULE_PULL * (expected share − done share), clamped */
const SCHEDULE_PULL = 10;
const SCHEDULE_MIN = 0.3;
const SCHEDULE_MAX = 4;
/** once today's work exceeds this many daily shares, the site is much less attractive */
const DAILY_ENOUGH = 1.5;
const DAILY_ENOUGH_FACTOR = 0.35;
/** something broken in the house comes first (repairs are the same kind of job) */
const BROKEN_FACTOR = 0.6;
/** late afternoon: the work winds down (grill, dinner and evening plans win more often) */
const WIND_DOWN_FROM = 17 * 60;
const WIND_DOWN_FACTOR = 0.6;
/** per-agent parts of the appeal (only when the brain passes the agent) */
const HELPER_BONUS = 1.5;
const BUILDER_BONUS = 1.15;
const FRIEND_AT_WORK = 0.25;
const FRIEND_SYMPATHY = 30;
const PRESSING_NEED = 25;
const PRESSING_FACTOR = 0.4;
/** a worker with a need below this stops working (the action ends next tick) ... */
const QUIT_NEED = 18;
/** ... for the needs the work does not serve (low fun / company is a reason to come, not to leave) */
const QUIT_NEEDS: readonly NeedKey[] = ['hunger', 'energy', 'hygiene', 'comfort'];
/** sympathy per minute worked side by side, and for every pair of the crew at the end */
const PAIR_PER_MINUTE = 0.02;
const CREW_BONUS = 6;
/** minutes of work that make someone part of the crew named at the end */
const CREW_MIN = 30;
/** the finished gazebo is the place to be on its first evening */
const CELEBRATION_UNTIL = 21 * 60 + 30;
const CELEBRATION_APPEAL = 2.5;
const MAX_MILESTONES = 30;

// ---------------------------------------------------------------- state

export type ProjectStatus = 'building' | 'done';

export interface Milestone {
  tick: number;
  text: string;
}

interface Project {
  id: number;
  kind: ProjectKind;
  uid: number;
  pos: Vec2;
  /** current stage index; kind.stages.length once finished */
  stage: number;
  proposerId: number;
  startTick: number;
  finishedTick: number | null;
  /** effective worker-minutes done */
  progress: number;
  /** agent id -> raw minutes worked */
  contributors: Map<number, number>;
  milestones: Milestone[];
  /** today's helpers ("dziś pomagam przy altanie") */
  helpers: { day: number; ids: number[] };
  /** effective minutes done today */
  today: { day: number; work: number };
  /** workers seen at the previous tick (for the first-minute bubble) */
  working: Set<number>;
  celebrated: boolean;
}

interface DayWork {
  projectId: number;
  minutes: number;
  with: Set<number>;
  /** stage labels reached while this agent worked today (or the stage that began) */
  stages: string[];
  proposed: boolean;
  finished: boolean;
}

interface ProjectState {
  rng: Rng;
  projects: Project[];
  /** next proposal: which kind and when (null = nothing planned) */
  next: { kind: ProjectKindId; tick: number } | null;
  /** `${day}|${agentId}` -> work records of that day */
  days: Map<string, DayWork[]>;
}

const states = new WeakMap<World, ProjectState>();

// snapshots (core/state.ts): the RNG by state, project kinds by id (the site objects, their
// stage types and the solid tiles are part of world.objects / world.grid)
registerWorldState('projects', {
  save: (world) => {
    const s = states.get(world);
    if (!s) return null;
    return {
      rng: s.rng.state(),
      projects: toJson(s.projects.map((p) => ({ ...p, kind: p.kind.id }))),
      next: toJson(s.next),
      days: toJson(s.days),
    };
  },
  load: (world, data) => {
    const d = data as { rng: number; projects: Json; next: Json; days: Json };
    const projects = fromJson<(Omit<Project, 'kind'> & { kind: ProjectKindId })[]>(d.projects).map((p) => ({ ...p, kind: PROJECT_KINDS[p.kind] }));
    states.set(world, {
      rng: createRng((world.seed ^ 0x6a17a2a5) >>> 0, d.rng),
      projects,
      next: fromJson<ProjectState['next']>(d.next),
      days: fromJson<Map<string, DayWork[]>>(d.days),
    });
  },
  clear: (world) => void states.delete(world),
});

function dayOf(tick: number): number {
  return Math.floor((tick + START_MINUTE) / MINUTES_PER_DAY) + 1;
}

function minuteOfDay(tick: number): number {
  return (tick + START_MINUTE) % MINUTES_PER_DAY;
}

/** tick of a given day (1-based) and minute of that day */
function tickAt(day: number, minute: number): number {
  return (day - 1) * MINUTES_PER_DAY + minute - START_MINUTE;
}

function stateOf(world: World): ProjectState {
  let s = states.get(world);
  if (!s) {
    const rng = createRng((world.seed ^ 0x6a17a2a5) >>> 0);
    const first = rng.chance(FIRST_PROPOSAL_DAY1) ? tickAt(1, rng.int(15 * 60, 18 * 60 + 30)) : tickAt(2, rng.int(10 * 60, 16 * 60));
    s = { rng, projects: [], next: { kind: PROJECT_ORDER[0], tick: first }, days: new Map() };
    states.set(world, s);
  }
  return s;
}

/** sets up project state for a new world (called once from createWorld) */
export function initProjects(world: World): void {
  stateOf(world);
}

function dayWork(s: ProjectState, day: number, agentId: number, projectId: number): DayWork {
  const key = `${day}|${agentId}`;
  let list = s.days.get(key);
  if (!list) s.days.set(key, (list = []));
  let w = list.find((x) => x.projectId === projectId);
  if (!w) list.push((w = { projectId, minutes: 0, with: new Set(), stages: [], proposed: false, finished: false }));
  return w;
}

function milestone(p: Project, tick: number, text: string): void {
  p.milestones.push({ tick, text });
  if (p.milestones.length > MAX_MILESTONES) p.milestones.shift();
}

// ---------------------------------------------------------------- site selection

const key = (x: number, y: number): number => y * 10000 + x;

/** reachable walkable tiles from `src` (4-neighbourhood), optionally with extra blocked tiles */
function reach(world: World, src: Vec2, blocked?: Set<number>): number {
  const g = world.grid;
  const w = g.width;
  const seen = new Uint8Array(w * g.height);
  const start = src.y * w + src.x;
  if (g.solid[start]) return 0;
  seen[start] = 1;
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi];
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= g.height) continue;
      const j = ny * w + nx;
      if (seen[j] || g.solid[j] || blocked?.has(key(nx, ny))) continue;
      seen[j] = 1;
      queue.push(j);
    }
  }
  return queue.length;
}

function reaches(world: World, src: Vec2, targets: Vec2[], blocked: Set<number>): boolean {
  const g = world.grid;
  const w = g.width;
  const seen = new Uint8Array(w * g.height);
  const want = new Set(targets.map((t) => key(t.x, t.y)));
  seen[src.y * w + src.x] = 1;
  const queue = [src.y * w + src.x];
  for (let qi = 0; qi < queue.length && want.size; qi++) {
    const i = queue[qi];
    const x = i % w;
    const y = (i - x) / w;
    want.delete(key(x, y));
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= g.height) continue;
      const j = ny * w + nx;
      if (seen[j] || g.solid[j] || blocked.has(key(nx, ny))) continue;
      seen[j] = 1;
      queue.push(j);
    }
  }
  return want.size === 0;
}

interface Candidate {
  x: number;
  y: number;
  score: number;
}

/**
 * a free area for the site: footprint on grass only (water for kinds with site 'water'), away from
 * doors, paths, other objects and their use spots, with walkable work spots, and blocking it keeps
 * every reachable tile reachable
 */
export function findSite(world: World, kind: ProjectKind, rng: Rng | null = null): Vec2 | null {
  const g = world.grid;
  const { w, h } = kind.size;
  const onWater = kind.site === 'water';
  const ground = onWater ? 'water' : 'grass';
  const occupied = new Set<number>();
  // a pier may use the shore tiles of fishing spots (non-blocking) as work spots
  const solidOccupied = new Set<number>();
  const stands = new Set<number>();
  let source: Vec2 | null = null;
  for (const o of world.objects) {
    const def = world.objectDefs[o.type];
    if (!def) continue;
    for (let dy = 0; dy < def.size.h; dy++)
      for (let dx = 0; dx < def.size.w; dx++) {
        occupied.add(key(o.pos.x + dx, o.pos.y + dy));
        if (def.blocking) solidOccupied.add(key(o.pos.x + dx, o.pos.y + dy));
      }
    for (const sl of def.slots) {
      const sx = o.pos.x + sl.stand.x;
      const sy = o.pos.y + sl.stand.y;
      stands.add(key(sx, sy));
      if (!source && !g.solid[sy * g.width + sx]) source = { x: sx, y: sy };
    }
  }
  if (!source) return null;
  const agentTiles = new Set(world.agents.map((a) => key(Math.round(a.pos.x), Math.round(a.pos.y))));
  const doors: Vec2[] = [];
  for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) if (g.tiles[y * g.width + x] === 'door') doors.push({ x, y });
  const hints = SITE_HINTS[mapIdOf(world)] ?? [];
  const tile = (x: number, y: number) => (x < 0 || y < 0 || x >= g.width || y >= g.height ? null : g.tiles[y * g.width + x]);

  const cands: Candidate[] = [];
  for (let y = 1; y + h < g.height; y++) {
    for (let x = 1; x + w < g.width; x++) {
      let ok = true;
      for (let dy = 0; dy < h && ok; dy++)
        for (let dx = 0; dx < w && ok; dx++) {
          const k = key(x + dx, y + dy);
          if (tile(x + dx, y + dy) !== ground || (!onWater && g.solid[(y + dy) * g.width + x + dx]) || occupied.has(k) || stands.has(k) || agentTiles.has(k)) ok = false;
        }
      if (!ok) continue;
      let crowd = 0;
      let wet = false;
      for (let yy = y - 1; yy <= y + h && ok; yy++)
        for (let xx = x - 1; xx <= x + w && ok; xx++) {
          const t = tile(xx, yy);
          if (t === 'door' || t === 'wall') ok = false;
          if (t === 'water' && !onWater) wet = true;
          if (occupied.has(key(xx, yy))) crowd++;
        }
      if (!ok) continue;
      for (const sl of kind.slots) {
        const sx = x + sl.stand.x;
        const sy = y + sl.stand.y;
        const t = tile(sx, sy);
        if ((t !== 'grass' && t !== 'path') || g.solid[sy * g.width + sx] || (onWater ? solidOccupied : occupied).has(key(sx, sy))) ok = false;
      }
      if (!ok) continue;
      const cx = x + (w - 1) / 2;
      const cy = y + (h - 1) / 2;
      const dDoor = doors.length ? Math.min(...doors.map((d) => Math.hypot(d.x - cx, d.y - cy))) : 7;
      let score = -0.6 * Math.abs(dDoor - 7) - 0.5 * crowd - (wet ? 2 : 0);
      hints.forEach((r, i) => {
        if (x >= r.x && y >= r.y && x + w <= r.x + r.w && y + h <= r.y + r.h) score += 8 - 2 * i;
      });
      cands.push({ x, y, score });
    }
  }
  cands.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);

  const before = reach(world, source);
  const good: Candidate[] = [];
  for (const c of cands) {
    if (good.length >= 3 || (good.length > 0 && c.score < good[0].score - 1.5)) break;
    const blocked = new Set<number>();
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) blocked.add(key(c.x + dx, c.y + dy));
    // no tile reachable before may be cut off: only the footprint itself goes (nothing, on water)
    if (reach(world, source, blocked) !== before - (onWater ? 0 : w * h)) continue;
    if (!reaches(world, source, kind.slots.map((sl) => ({ x: c.x + sl.stand.x, y: c.y + sl.stand.y })), blocked)) continue;
    good.push(c);
  }
  if (!good.length) return null;
  const pick = rng && good.length > 1 ? good[rng.int(0, good.length - 1)] : good[0];
  return { x: pick.x, y: pick.y };
}

/** places the site object, marks it solid and re-routes anyone whose path crossed it */
function placeSite(world: World, kind: ProjectKind, pos: Vec2): ObjectInstance {
  const uid = world.objects.reduce((m, o) => Math.max(m, o.uid), 0) + 1;
  const obj: ObjectInstance = { uid, type: kind.stages[0].type, pos: { ...pos }, reservedBy: kind.slots.map(() => null) };
  world.objects.push(obj);
  const foot = new Set<number>();
  for (let dy = 0; dy < kind.size.h; dy++)
    for (let dx = 0; dx < kind.size.w; dx++) {
      markSolid(world.grid, pos.x + dx, pos.y + dy, true);
      foot.add(key(pos.x + dx, pos.y + dy));
    }
  for (const a of world.agents) {
    if (!a.path.some((p) => foot.has(key(p.x, p.y)))) continue;
    const dest = a.path[a.path.length - 1];
    const path = foot.has(key(dest.x, dest.y)) ? null : findPath(world.grid, a.pos, dest);
    if (path) {
      a.path = path;
      continue;
    }
    const act = a.action;
    if (act?.kind === 'use') {
      const o = world.objects.find((x) => x.uid === act.objectUid);
      if (o && o.reservedBy[act.slot] === a.id) o.reservedBy[act.slot] = null;
    }
    a.path = [];
    a.action = null;
  }
  return obj;
}

// ---------------------------------------------------------------- proposals

function isAsleep(world: World, a: Agent): boolean {
  const act = a.action;
  if (act?.kind !== 'use' || act.phase !== 'using') return false;
  const obj = world.objects.find((o) => o.uid === act.objectUid);
  return !!obj && !!world.objectDefs[obj.type]?.tags?.includes('sleep');
}

function propose(world: World, s: ProjectState): void {
  const next = s.next!;
  const awake = residentsOf(world).filter((a) => !isAsleep(world, a));
  if (!awake.length) {
    next.tick = world.tick + 30;
    return;
  }
  const weights = awake.map((a) => Math.max(0.05, 1 + a.traits.activity + 0.6 * a.traits.sociability + (a.mood - 50) / 50));
  const proposer = awake[s.rng.weightedIndex(weights)];
  const kind = PROJECT_KINDS[next.kind];
  const pos = findSite(world, kind, s.rng);
  const after = PROJECT_ORDER[PROJECT_ORDER.indexOf(next.kind) + 1];
  if (!pos) {
    // nowhere to build it: skip to the next idea tomorrow
    s.next = after ? { kind: after, tick: tickAt(dayOf(world.tick) + 1, NEXT_PROPOSAL_AT + s.rng.int(0, 300)) } : null;
    return;
  }
  s.next = null;
  const obj = placeSite(world, kind, pos);
  const p: Project = {
    id: s.projects.length + 1,
    kind,
    uid: obj.uid,
    pos: { ...pos },
    stage: 0,
    proposerId: proposer.id,
    startTick: world.tick,
    finishedTick: null,
    progress: 0,
    contributors: new Map(),
    milestones: [],
    helpers: { day: 0, ids: [] },
    today: { day: dayOf(world.tick), work: 0 },
    working: new Set(),
    celebrated: false,
  };
  s.projects.push(p);
  proposer.bubble = { kind: 'speech', text: kind.pitch, ttl: 40, tone: 'positive' };
  const text = `${proposer.name} ${kind.proposal}`;
  pushEvent(world, 'info', `${text} 🔨`, [], { text, aboutIds: [proposer.id], valence: 0.5 });
  pushEvent(world, 'info', `${kind.stages[0].startText} 🔨`, []);
  milestone(p, world.tick, `${proposer.name} ${kind.proposal}`);
  dayWork(s, dayOf(world.tick), proposer.id, p.id).proposed = true;
}

// ---------------------------------------------------------------- work

function workersOf(world: World, uid: number): Agent[] {
  return world.agents.filter((a) => a.action?.kind === 'use' && a.action.objectUid === uid && a.action.phase === 'using');
}

function isRaining(world: World): boolean {
  return weatherOf(world).raining;
}

/** true while construction work may go on (daytime, no rain) */
export function canWorkNow(world: World): boolean {
  const m = minuteOfDay(world.tick);
  return m >= WORK_HOURS[0] * 60 && m < WORK_HOURS[1] * 60 && !isRaining(world);
}

/** working minutes (08–19) between two ticks */
function workMinutesBetween(from: number, to: number): number {
  if (to <= from) return 0;
  const clip = (t: number): number => {
    const d = dayOf(t);
    const m = minuteOfDay(t);
    return (d - 1) * WORK_MINUTES_PER_DAY + Math.max(0, Math.min(WORK_MINUTES_PER_DAY, m - WORK_HOURS[0] * 60));
  };
  return clip(to) - clip(from);
}

function pickHelpers(world: World, s: ProjectState, p: Project, day: number): void {
  const pool = residentsOf(world).filter((a) => a.traits.activity > -0.4);
  const ids: number[] = [];
  const n = Math.min(pool.length, 1 + s.rng.int(0, 1));
  const left = [...pool];
  for (let i = 0; i < n; i++) {
    const weights = left.map((a) => Math.max(0.05, 1 + a.traits.activity + 0.5 * a.traits.sociability + (p.contributors.has(a.id) ? 0.4 : 0)));
    const a = left.splice(s.rng.weightedIndex(weights), 1)[0];
    ids.push(a.id);
  }
  p.helpers = { day, ids };
}

function crewOf(world: World, p: Project): Agent[] {
  const sorted = [...p.contributors.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const crew = sorted.filter(([, m]) => m >= CREW_MIN);
  const ids = (crew.length ? crew : sorted.slice(0, 1)).map(([id]) => id);
  return ids.map((id) => world.agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} i ${names[names.length - 1]}`;
}

function advanceStage(world: World, s: ProjectState, p: Project, obj: ObjectInstance, workers: Agent[]): void {
  p.stage++;
  const st = p.kind.stages[p.stage];
  obj.type = st.type;
  pushEvent(world, 'info', st.startText, []);
  milestone(p, world.tick, st.startText);
  const prev = p.kind.stages[p.stage - 1];
  for (const a of workers) {
    dayWork(s, dayOf(world.tick), a.id, p.id).stages.push(prev.label.toLowerCase());
    a.bubble = { kind: 'speech', text: 'Kolejny etap za nami! 💪', ttl: 30, tone: 'positive' };
  }
}

function finish(world: World, s: ProjectState, p: Project, obj: ObjectInstance, workers: Agent[]): void {
  const kind = p.kind;
  p.stage = kind.stages.length;
  p.finishedTick = world.tick;
  obj.type = kind.finishedType;
  // workers wrap up right away (the action ends next tick at the same spot)
  for (const a of workers) if (a.action?.kind === 'use') a.action.ticksLeft = Math.min(a.action.ticksLeft, 1);
  const crew = crewOf(world, p);
  const names = crew.map((a) => a.name);
  const text = `${kind.doneText} Ekipa: ${names.join(', ')} 🎉`;
  pushEvent(world, 'info', text, [], {
    text: `${joinNames(names)} ${names.length > 1 ? 'kończą' : 'kończy'} budowę: ${kind.short.toLowerCase()}`,
    aboutIds: crew.map((a) => a.id),
    valence: 0.8,
  });
  milestone(p, world.tick, text);
  for (let i = 0; i < crew.length; i++) for (let j = i + 1; j < crew.length; j++) world.relationships.adjust(crew[i].id, crew[j].id, CREW_BONUS);
  const day = dayOf(world.tick);
  for (const a of crew) {
    a.needs.fun = Math.min(100, a.needs.fun + 15);
    a.bubble = { kind: 'speech', text: 'Udało się! 🎉', ttl: 40, tone: 'positive' };
    dayWork(s, day, a.id, p.id).finished = true;
  }
  const after = PROJECT_ORDER[PROJECT_ORDER.indexOf(kind.id) + 1];
  if (after && !s.projects.some((x) => x.kind.id === after)) s.next = { kind: after, tick: tickAt(day + 1, NEXT_PROPOSAL_AT + s.rng.int(0, 300)) };
}

function tickProject(world: World, s: ProjectState, p: Project): void {
  const obj = world.objects.find((o) => o.uid === p.uid);
  if (!obj) return;
  const day = dayOf(world.tick);
  if (p.finishedTick !== null) {
    celebrate(world, p, obj, day);
    return;
  }
  if (p.today.day !== day) p.today = { day, work: 0 };
  if (p.helpers.day !== day && minuteOfDay(world.tick) >= 6 * 60) pickHelpers(world, s, p, day);

  const workers = workersOf(world, p.uid);
  for (const a of workers) {
    for (const [k, v] of Object.entries(WORK_COSTS) as [keyof typeof WORK_COSTS, number][]) a.needs[k] = Math.max(0, Math.min(100, a.needs[k] + v));
  }
  if (!canWorkNow(world)) {
    // evening or rain: whoever is still at it wraps up
    for (const a of workers) if (a.action?.kind === 'use') a.action.ticksLeft = Math.min(a.action.ticksLeft, 1);
    p.working.clear();
    return;
  }
  // someone running on empty (hungry, tired, unwashed…) puts the tools down for today
  for (const a of workers) {
    if (a.action?.kind !== 'use' || !QUIT_NEEDS.some((nk) => a.needs[nk] < QUIT_NEED)) continue;
    if (a.action.ticksLeft > 1) a.action.ticksLeft = 1;
    // a chat at the site would keep them there (actions.ts chat extension): its next line is the goodbye
    const conv = world.conversations.find((c) => c.participants.includes(a.id));
    if (conv) conv.maxLines = Math.min(conv.maxLines, conv.lines.length + 1);
  }
  const n = workers.length;
  if (n === 0) {
    p.working.clear();
    return;
  }
  const eff = n * (n >= 2 ? TEAM_BONUS : 1);
  p.progress = Math.min(p.kind.work, p.progress + eff);
  p.today.work += eff;
  const now = new Set<number>();
  for (const a of workers) {
    now.add(a.id);
    p.contributors.set(a.id, (p.contributors.get(a.id) ?? 0) + 1);
    const dw = dayWork(s, day, a.id, p.id);
    dw.minutes++;
    for (const b of workers) if (b !== a) dw.with.add(b.id);
    if (!p.working.has(a.id) && !a.bubble) a.bubble = { kind: 'thought', text: '🔨', ttl: 20 };
  }
  p.working = now;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) world.relationships.adjust(workers[i].id, workers[j].id, PAIR_PER_MINUTE);

  while (p.stage < p.kind.stages.length - 1 && p.progress >= p.kind.stages[p.stage].until * p.kind.work) advanceStage(world, s, p, obj, workers);
  if (p.progress >= p.kind.work) finish(world, s, p, obj, workers);
}

function celebrate(world: World, p: Project, obj: ObjectInstance, day: number): void {
  if (p.celebrated || p.kind.id !== 'altana' || dayOf(p.finishedTick!) !== day || minuteOfDay(world.tick) >= CELEBRATION_UNTIL) return;
  const there = workersOf(world, obj.uid);
  if (there.length < 3) return;
  p.celebrated = true;
  const text = 'Ekipa świętuje w nowej altanie 🥂';
  pushEvent(world, 'info', text, []);
  milestone(p, world.tick, text);
}

/** advances projects; called once per tick right after incidents */
export function tickProjects(world: World): void {
  const s = stateOf(world);
  if (s.next && world.tick >= s.next.tick) propose(world, s);
  for (const p of s.projects) tickProject(world, s, p);
}

// ---------------------------------------------------------------- appeal

function projectOfUid(world: World, uid: number): Project | undefined {
  return states.get(world)?.projects.find((p) => p.uid === uid);
}

/**
 * extra utility multiplier for project objects; 1 = neutral.
 * Sites: 0 outside 08–19 and in the rain; follows the schedule (lagging → more, today's share
 * done → less). With `agent` (optional, when the brain passes it): today's helpers, earlier
 * builders and friends at work like it more, pressing needs make it less attractive.
 * The finished gazebo is the place to be on its first evening.
 */
export function projectAppeal(world: World, obj: ObjectInstance, def: ObjectDef, agent?: Agent): number {
  const info = projectTypeInfo(def.id);
  if (!info) return 1;
  const p = projectOfUid(world, obj.uid);
  if (!p) return 1;
  if (p.finishedTick !== null) {
    const fresh = dayOf(p.finishedTick) === dayOf(world.tick) && minuteOfDay(world.tick) < CELEBRATION_UNTIL;
    return fresh && p.kind.id === 'altana' ? CELEBRATION_APPEAL : 1;
  }
  if (!canWorkNow(world)) return 0;
  const k = p.kind;
  // not capped at 1: an overdue project keeps pulling harder
  const expected = workMinutesBetween(p.startTick, world.tick) / (k.plannedDays * WORK_MINUTES_PER_DAY);
  const lag = expected - p.progress / k.work;
  let m = Math.max(SCHEDULE_MIN, Math.min(SCHEDULE_MAX, 1 + SCHEDULE_PULL * lag));
  const dailyShare = k.work / k.plannedDays;
  if (p.today.day === dayOf(world.tick) && p.today.work > DAILY_ENOUGH * dailyShare) m *= DAILY_ENOUGH_FACTOR;
  if (brokenObjects(world).length > 0) m *= BROKEN_FACTOR;
  if (minuteOfDay(world.tick) >= WIND_DOWN_FROM) m *= WIND_DOWN_FACTOR;
  if (agent) {
    if (p.helpers.day === dayOf(world.tick) && p.helpers.ids.includes(agent.id)) m *= HELPER_BONUS;
    else if (p.contributors.has(agent.id)) m *= BUILDER_BONUS;
    let friends = 0;
    for (const w of workersOf(world, p.uid)) if (w.id !== agent.id && world.relationships.get(agent.id, w.id) >= FRIEND_SYMPATHY) friends++;
    m *= 1 + FRIEND_AT_WORK * Math.min(2, friends);
    if (NEED_KEYS.some((nk) => agent.needs[nk] < PRESSING_NEED)) m *= PRESSING_FACTOR;
  }
  return m;
}

// ---------------------------------------------------------------- read-only views (UI, diary, tests)

export interface ProjectView {
  id: number;
  kindId: ProjectKindId;
  name: string;
  short: string;
  icon: string;
  /** "Altana gotowa!" */
  doneText: string;
  status: ProjectStatus;
  /** object uid of the site / building */
  uid: number;
  pos: Vec2;
  size: { w: number; h: number };
  /** current stage index (stages.length when done) */
  stage: number;
  stages: { label: string; until: number }[];
  stageLabel: string;
  /** 0..1 */
  progress: number;
  /** 0..1 within the current stage */
  stageProgress: number;
  proposerId: number;
  startTick: number;
  finishedTick: number | null;
  plannedDays: number;
  /** estimate of the total length in days, from the pace so far (planned days until there is a pace) */
  estimatedDays: number;
  contributors: { id: number; minutes: number }[];
  workerIds: number[];
  helperIds: number[];
  milestones: readonly Milestone[];
}

function view(world: World, p: Project): ProjectView {
  const k = p.kind;
  const done = p.finishedTick !== null;
  const progress = done ? 1 : p.progress / k.work;
  const from = p.stage === 0 ? 0 : k.stages[Math.min(p.stage, k.stages.length) - 1].until;
  const to = done ? 1 : k.stages[p.stage].until;
  const elapsedDays = (world.tick - p.startTick) / MINUTES_PER_DAY;
  let estimatedDays = k.plannedDays;
  if (done) estimatedDays = (p.finishedTick! - p.startTick) / MINUTES_PER_DAY;
  else if (progress >= 0.1 && elapsedDays >= 1) estimatedDays = Math.max(elapsedDays, elapsedDays / progress);
  const today = dayOf(world.tick);
  return {
    id: p.id,
    kindId: k.id,
    name: k.name,
    short: k.short,
    icon: k.icon,
    doneText: k.doneText,
    status: done ? 'done' : 'building',
    uid: p.uid,
    pos: { ...p.pos },
    size: { ...k.size },
    stage: p.stage,
    stages: k.stages.map((st) => ({ label: st.label, until: st.until })),
    stageLabel: done ? 'Gotowe' : k.stages[p.stage].label,
    progress,
    stageProgress: done ? 1 : Math.max(0, Math.min(1, (progress - from) / (to - from))),
    proposerId: p.proposerId,
    startTick: p.startTick,
    finishedTick: p.finishedTick,
    plannedDays: k.plannedDays,
    estimatedDays,
    contributors: [...p.contributors.entries()].map(([id, minutes]) => ({ id, minutes })).sort((a, b) => b.minutes - a.minutes || a.id - b.id),
    workerIds: done ? [] : workersOf(world, p.uid).map((a) => a.id),
    helperIds: !done && p.helpers.day === today ? [...p.helpers.ids] : [],
    milestones: p.milestones,
  };
}

/** all projects of the world (oldest first) */
export function projectsOf(world: World): ProjectView[] {
  const s = states.get(world);
  return s ? s.projects.map((p) => view(world, p)) : [];
}

/** the project under construction, if any */
export function activeProject(world: World): ProjectView | null {
  return projectsOf(world).find((p) => p.status === 'building') ?? null;
}

/** next planned proposal (for tests / UI hints) */
export function nextProposal(world: World): { kind: ProjectKindId; tick: number } | null {
  const n = stateOf(world).next;
  return n ? { ...n } : null;
}

/**
 * a daily-goal-like motivation for the goals system: "Dziś pomagam przy altanie" when the agent
 * is one of today's helpers of a project under construction, else null
 */
export function projectGoalFor(world: World, agentId: number): string | null {
  const s = states.get(world);
  if (!s) return null;
  const day = dayOf(world.tick);
  const p = s.projects.find((x) => x.finishedTick === null && x.helpers.day === day && x.helpers.ids.includes(agentId));
  return p ? `Dziś pomagam przy: ${p.kind.short.toLowerCase()}` : null;
}

export interface ProjectDayFact {
  /** "altana" */
  kindId: ProjectKindId;
  /** nominative short name, lower case ("altana") */
  name: string;
  /** locative ("altanie") for "pracuję przy altanie" */
  locative: string;
  /** genitive ("altany") for "przy budowie altany" */
  genitive: string;
  /** accusative ("altanę") for "budujemy altanę" */
  accusative: string;
  minutes: number;
  /** names of the people who worked alongside */
  with: string[];
  /** stages finished while working today (lower case labels) */
  stages: string[];
  proposed: boolean;
  finished: boolean;
  /** the crew's names when the project was finished today */
  crew: string[];
}

/** what the agent did for projects on a given game day (for the diary) */
export function projectDayFacts(world: World, agentId: number, day: number): ProjectDayFact[] {
  const s = states.get(world);
  const list = s?.days.get(`${day}|${agentId}`);
  if (!s || !list) return [];
  const name = (id: number) => world.agents.find((a) => a.id === id)?.name ?? '?';
  return list.map((w) => {
    const p = s.projects.find((x) => x.id === w.projectId)!;
    return {
      kindId: p.kind.id,
      name: p.kind.short.toLowerCase(),
      locative: p.kind.locative,
      genitive: p.kind.genitive,
      accusative: p.kind.accusative,
      minutes: w.minutes,
      with: [...w.with].map(name),
      stages: [...w.stages],
      proposed: w.proposed,
      finished: w.finished,
      crew: w.finished ? crewOf(world, p).map((a) => a.name) : [],
    };
  });
}

/** true for construction sites (not finished buildings) */
export function isConstructionSite(type: string): boolean {
  const info = projectTypeInfo(type);
  return !!info && info.stage < info.kind.stages.length;
}

/** test / debug hook: proposes a project right now (null when it exists already or there is no room) */
export function startProject(world: World, kindId: ProjectKindId): ProjectView | null {
  const s = stateOf(world);
  if (s.projects.some((p) => p.kind.id === kindId)) return null;
  const saved = s.next;
  s.next = { kind: kindId, tick: world.tick };
  propose(world, s);
  // a planned proposal of another kind stays planned
  if (saved && saved.kind !== kindId) s.next = saved;
  const p = s.projects.find((x) => x.kind.id === kindId);
  return p ? view(world, p) : null;
}
