import type { Agent, GameTime, Gossip, ObjectInstance, Traits, Vec2, World } from '../types';
import { timeOf } from '../core/calendar';
import { isWeekend } from '../core/time';
import { fromJson, loadByAgent, registerWorldState, saveByAgent, toJson, type Json } from '../core/state';
import { slotStandTile } from '../world/objects';
import { pushEvent } from '../world/events';
import { trace } from '../world/trace';
import { availability } from '../world/incidents';
import { findPath } from './pathfinding';
import { applyEffects } from './needs';
import { clash, noteRelation, recordFriction, statusOf } from '../social/relationships';
import { LINE_TTL } from '../social/conversation';
import { JOINT_LINES } from '../social/dialogueProvider';
import type { GoalBias } from './goals';
import { callGathering, gatheringOf, invitationsOf } from './groups';
import { fishingOpen, SEASON_TUNING } from './seasons';

// Joint activities: long sessions that two to four residents do together on one object
// (console, card table) or on neighbouring objects (fishing spots side by side).
//
//   1. An initiator heads for a joint-capable object (picked by the normal utility AI, with a
//      bonus from jointObjectBias when friends are around and it is the right time of day).
//   2. onJointHeadingTo invites 1–3 suitable partners right away: each accepts or refuses with a
//      reason; those who accept drop what they were doing (unless important) and walk there.
//   3. The session starts once two people have arrived (the others join late); with nobody there
//      after JOINT_WAIT minutes the one who came plays alone (normal length) or gives up.
//   4. Everybody shares ONE end tick (60–150 min, never across a meal window or bedtime): their
//      `use` actions count down together and end together. Only a critical need (or rain for
//      fishing) takes someone away; the rest go on while at least two remain.
//   5. Small moments every ~20 min (goals, catches, a lost rook) update the score badge and bubbles;
//      at the end: one log line ("Wspólne wędkowanie: …") with gossip for notable results, sympathy
//      for every pair (fun together, minus clashing temperaments) and maybe a quarrel after a loss.
//
// State lives in a WeakMap per world (no contract changes). The state machine (actions.ts) asks
// jointMemberOf() to keep members seated (no "satisfied" exit, no chat extension) and calls the
// arrival hook; tickJoint (from tickGatherings) watches members and runs the session.

export type JointKind = 'fishing' | 'console' | 'boardgame';

export interface JointGame {
  id: string;
  /** Polish, e.g. "wyścigi" */
  label: string;
  icon: string;
  min: number;
  max: number;
  /** co-op: the team wins or loses together */
  coop?: boolean;
}

export const JOINT_GAMES: Record<JointKind, readonly JointGame[]> = {
  fishing: [{ id: 'fishing', label: 'wędkowanie', icon: '🎣', min: 2, max: 3 }],
  console: [
    { id: 'race', label: 'wyścigi', icon: '🏎️', min: 2, max: 4 },
    { id: 'football', label: 'futbol', icon: '⚽', min: 2, max: 4 },
    { id: 'fight', label: 'bijatyka', icon: '🥊', min: 2, max: 4 },
    { id: 'coop', label: 'co-op przygoda', icon: '🗡️', min: 2, max: 4, coop: true },
  ],
  boardgame: [
    { id: 'chess', label: 'szachy', icon: '♟️', min: 2, max: 2 },
    { id: 'cards', label: 'karty', icon: '🃏', min: 2, max: 4 },
    { id: 'eurobiznes', label: 'Eurobiznes', icon: '🎲', min: 2, max: 4 },
  ],
};

/** Polish activity name for logs and traces */
export const JOINT_LABEL: Record<JointKind, string> = { fishing: 'wędkowanie', console: 'granie na konsoli', boardgame: 'planszówki' };
const BADGE_ICON: Record<JointKind, string> = { fishing: '🎣', console: '🎮', boardgame: '🎲' };
/** conversation topic during a session (social/dialogueProvider has lines for these) */
export const JOINT_TOPIC: Record<JointKind, string> = { fishing: 'wędkowanie', console: 'gry na konsoli', boardgame: 'planszówki' };

export const JOINT_TUNING = {
  /** shared length in minutes [min, max] by kind (shortened to fit before a meal or bedtime) */
  DURATION: { fishing: [70, 180], console: [60, 150], boardgame: [60, 120] } as Record<JointKind, [number, number]>,
  /** never shorter than this (otherwise no joint session at all) */
  MIN_DURATION: 60,
  /** a session is only proposed with this much time to spare for getting there */
  WALK_MARGIN: 20,
  /** wait this long after the first arrival for a second person (longer while someone is a few steps away) */
  WAIT: 20,
  WAIT_MAX: 45,
  /** "a few steps away": remaining path tiles */
  NEAR_PATH: 9,
  /** a session whose people never arrive is called off after this long */
  GATHER_TIMEOUT: 80,
  /** while gathering, arrived members' ticksLeft is held at this (the session sets the real length) */
  HOLD: 400,
  /** invitations reach residents within this many tiles of the initiator… */
  INVITE_RADIUS: 30,
  /** …who can walk there in time (path tiles) */
  MAX_INVITE_PATH: 38,
  /** invitees need this sympathy towards the initiator */
  MIN_SYMPATHY: 5,
  /** neighbouring fishing spots: at most this far from the initiator's spot */
  FISH_RADIUS: 2.5,
  /** an agent is not tempted into another joint session for this long after one */
  COOLDOWN: 200,
  /** small moments every [min, max] minutes */
  MOMENT_EVERY: [12, 24] as [number, number],
  /** extra need gains per tick for the company while playing */
  COMPANY: { social: 0.2, fun: 0.05 },
  /** scoring pull when partners are around: score' = score * mult + add * taste * timeFit * calm */
  BIAS_MULT: 1.25,
  BIAS_ADD: 12,
  /** joining a session in progress (or gathering) as a friend */
  JOIN_BIAS: { mult: 1.4, add: 8 } as GoalBias,
  /** alone: a console session is a bit less fun, a card table is solitaire (rare) */
  SOLO_FACTOR: { fishing: 1, console: 0.75, boardgame: 0.2 } as Record<JointKind, number>,
  /** conversations of members wrap up this many minutes before the shared end */
  WRAP: 6,
  /** no new chats with members later than this before the end */
  NO_NEW_CHAT: 50,
  /** sympathy per pair at the end: base + compatibility (1.2 - 0.6 * temperament gap) */
  BOND: 2,
  /** quarrel after a clear loss: chance = base + clash - cheerfulness * k (only grumpy losers) */
  QUARREL_BASE: 0.12,
  QUARREL_MARGIN: 3,
  /** rivalry added by such a quarrel (a talk quarrel adds 15) */
  QUARREL_RIVALRY: 6,
} as const;

/** session time windows [from, until) in fractional hours; sessions must end by `until` */
const WINDOWS: Record<JointKind, [number, number]> = { fishing: [6.5, 20.5], console: [9, 23.75], boardgame: [9, 23.25] };
/** meal windows a session may not run across (people eat before) */
/** (joint sessions end a little before lunch and dinner: that is when grills and shared meals happen) */
const MEAL_STARTS = [7, 11.5, 17];
const MEAL_ENDS = [9, 14, 19.5];

interface Member {
  id: number;
  uid: number;
  slot: number;
  state: 'walking' | 'here' | 'left';
  arrivedAt: number | null;
  leftAt: number | null;
  leftReason: string | null;
  /** wins (competitive games), fish caught */
  score: number;
  /** biggest fish in kg */
  best: number;
}

interface Session {
  id: number;
  kind: JointKind;
  hostId: number;
  anchorUid: number;
  members: Member[];
  phase: 'gathering' | 'playing';
  createdAt: number;
  firstArrival: number | null;
  startTick: number | null;
  endTick: number | null;
  game: JointGame | null;
  nextMoment: number;
  /** co-op: missions won / lost */
  teamWins: number;
  teamLosses: number;
  laughs: number;
  rained: boolean;
  /** said no to this session: they don't walk in later either */
  refused: Set<number>;
  /** how many the initiator wants around (an introvert's quiet game stays a pair) */
  capacity: number;
  /** some members have chatted already */
  chatted: boolean;
}

/** a finished (or called-off) session, for metrics and the UI */
export interface JointRecord {
  kind: JointKind;
  game: string;
  hostId: number;
  /** everyone who played (arrived while the session was on) */
  ids: number[];
  start: number;
  end: number;
  /** minutes actually played together */
  minutes: number;
  /** log text, or the reason it did not happen */
  text: string;
  happened: boolean;
}

interface Store {
  sessions: Session[];
  nextId: number;
  log: JointRecord[];
  /** agent id -> tick of the end of their last session */
  lastPlayed: Map<number, number>;
}

const LOG_MAX = 400;
const stores = new WeakMap<World, Store>();

function store(world: World): Store {
  let s = stores.get(world);
  if (!s) stores.set(world, (s = { sessions: [], nextId: 1, log: [], lastPlayed: new Map() }));
  return s;
}

const hourOf = (t: GameTime): number => t.hour + t.minute / 60;
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const byId = (world: World, id: number): Agent | undefined => world.agents.find((a) => a.id === id);
const objOf = (world: World, uid: number): ObjectInstance | undefined => world.objects.find((o) => o.uid === uid);

export function jointKindOf(type: string): JointKind | null {
  if (type === 'fishing_spot') return 'fishing';
  if (type === 'console') return 'console';
  if (type === 'board_game_table') return 'boardgame';
  return null;
}

/** how much a personality likes an activity done together (introverts: fishing / board games; extroverts: console) */
export function jointTaste(kind: JointKind, t: Traits): number {
  switch (kind) {
    case 'fishing':
      return clamp(1 - 0.45 * t.sociability - 0.15 * t.activity, 0.3, 1.7);
    case 'console':
      return clamp(1 + 0.55 * t.sociability - 0.3 * t.activity + 0.15 * t.cheerfulness, 0.3, 1.8);
    case 'boardgame':
      return clamp(1 - 0.3 * t.sociability + 0.2 * t.neatness - 0.1 * t.activity, 0.3, 1.6);
  }
}

/** preferred group size (including oneself) */
function preferredSize(kind: JointKind, t: Traits, rng: World['rng']): number {
  const max = kind === 'fishing' ? 3 : 4;
  // introverts: one partner; extroverts: as many as fit (a console evening for four)
  const want = 2 + Math.max(0, t.sociability + 0.1) * (max - 2) * 1.3 + rng.range(-0.5, 0.5);
  return clamp(Math.round(want), 2, max);
}

/** 0..1.4: how well the time of day suits the activity */
function timeFit(kind: JointKind, h: number): number {
  switch (kind) {
    case 'fishing':
      return h < 6.5 || h >= 19.5 ? 0 : h < 11 ? 1.3 : h < 16 ? 0.9 : 1.1;
    // early evening belongs to dinner and the film on TV; late evening to games
    case 'console':
      return h < 10 ? 0.25 : h < 15 ? 0.6 : h < 19.5 ? 0.9 : h < 20.75 ? 0 : 1.4;
    case 'boardgame':
      return h < 10 ? 0.3 : h < 14 ? 0.7 : h < 19.5 ? 1.1 : h < 20.75 ? 0 : 1.2;
  }
}

/** minutes a session starting now could last: until the end of the activity window, the next meal or bedtime */
export function jointWindow(kind: JointKind, time: GameTime): number {
  const h = hourOf(time);
  // inside a meal window: eat first
  if (MEAL_ENDS.some((end, i) => h >= MEAL_STARTS[i] && h < end - 0.25)) return 0;
  return roomUntilBoundary(kind, h);
}

/** minutes until the end of the activity window or the start of the next meal window */
function roomUntilBoundary(kind: JointKind, h: number): number {
  const [from, until] = WINDOWS[kind];
  if (h < from || h >= until) return 0;
  let limit = until;
  for (const m of MEAL_STARTS) if (m > h) limit = Math.min(limit, m + 0.1);
  return Math.floor((limit - h) * 60);
}

// ---------------------------------------------------------------- queries (state machine, brain, render)

function sessionOf(world: World, agentId: number): { session: Session; member: Member } | undefined {
  const s = stores.get(world);
  if (!s) return undefined;
  for (const session of s.sessions) {
    const member = session.members.find((m) => m.id === agentId && m.state !== 'left');
    if (member) return { session, member };
  }
  return undefined;
}

/** what the state machine needs to know about an agent's joint session */
export interface JointMembership {
  kind: JointKind;
  phase: 'gathering' | 'playing';
  /** minutes until the shared end (playing), or null while gathering */
  remaining: number | null;
  label: string;
}

/** the agent's current joint session (member, not left), if any */
export function jointMemberOf(world: World, agent: Agent): JointMembership | undefined {
  const r = sessionOf(world, agent.id);
  if (!r) return undefined;
  const { session } = r;
  return {
    kind: session.kind,
    phase: session.phase,
    remaining: session.endTick === null ? null : session.endTick - world.tick,
    label: sessionLabel(session),
  };
}

function sessionLabel(s: Session): string {
  if (s.kind === 'fishing') return 'wspólne wędkowanie';
  const g = s.game ? ` (${s.game.label})` : '';
  return s.kind === 'console' ? `wspólne granie na konsoli${g}` : `wspólne planszówki${g}`;
}

/** too close to the shared end for a new chat with this agent */
export function jointBlocksChat(world: World, agent: Agent): boolean {
  const m = jointMemberOf(world, agent);
  if (!m) return false;
  if (agent.action?.kind === 'use' && agent.action.phase === 'walking') return true;
  return m.remaining !== null && m.remaining < JOINT_TUNING.NO_NEW_CHAT;
}

/** members of a playing session who are there right now (for ambient chats) */
/** how chatty a joint activity is (ambient chat chance factor): fishing is quiet, a console evening loud */
export const JOINT_CHATTINESS: Record<JointKind, number> = { fishing: 0.8, boardgame: 1.5, console: 2.6 };
/** chat chance factor for a group that has not said a word yet after half an hour */
export const JOINT_QUIET_BOOST = 4;

export function jointGroups(world: World): { kind: JointKind; agents: Agent[]; quiet: boolean }[] {
  const s = stores.get(world);
  if (!s) return [];
  const out: { kind: JointKind; agents: Agent[]; quiet: boolean }[] = [];
  for (const session of s.sessions) {
    if (session.phase !== 'playing' || session.endTick === null || session.endTick - world.tick < JOINT_TUNING.NO_NEW_CHAT) continue;
    const agents = session.members.filter((m) => m.state === 'here').map((m) => byId(world, m.id)).filter((a): a is Agent => !!a);
    // half an hour together without a word: even shy people say something
    const quiet = !session.chatted && session.startTick !== null && world.tick - session.startTick >= 30;
    if (agents.length >= 2) out.push({ kind: session.kind, agents, quiet });
  }
  return out;
}

/** a running session, for tests and the UI */
export interface JointSessionView {
  kind: JointKind;
  phase: 'gathering' | 'playing';
  hostId: number;
  game: string | null;
  /** members still in (walking there or present) */
  memberIds: number[];
  /** members present right now */
  hereIds: number[];
  startTick: number | null;
  endTick: number | null;
}

export function jointSessions(world: World): JointSessionView[] {
  return (stores.get(world)?.sessions ?? []).map((x) => ({
    kind: x.kind,
    phase: x.phase,
    hostId: x.hostId,
    game: x.game?.label ?? null,
    memberIds: x.members.filter((m) => m.state !== 'left').map((m) => m.id),
    hereIds: x.members.filter((m) => m.state === 'here').map((m) => m.id),
    startTick: x.startTick,
    endTick: x.endTick,
  }));
}

/** finished sessions, oldest first */
export function jointLog(world: World): readonly JointRecord[] {
  return stores.get(world)?.log ?? [];
}

/** what the renderer shows for an agent in a session: the score badge (drawn once per group) and props */
export interface JointView {
  kind: JointKind;
  game: string | null;
  /** set on one member per group: badge text and where to draw it (tile units) */
  badge: { text: string; x: number; y: number } | null;
}

const views = new WeakMap<Agent, JointView>();
const casts = new WeakMap<Agent, Vec2>();

// snapshots (core/state.ts): sessions keep their game as an id; the per-tick partner cache is not
// state (it is keyed by the tick and rebuilt on the next tick)
registerWorldState('joint', {
  save: (world) => {
    const s = stores.get(world);
    const v = saveByAgent(world, views);
    const c = saveByAgent(world, casts);
    if (!s && !v && !c) return null;
    const store = s ? toJson({ ...s, sessions: s.sessions.map((x) => ({ ...x, game: x.game?.id ?? null })) }) : null;
    return { store, views: v, casts: c };
  },
  load: (world, data) => {
    const d = data as { store: Json; views: Json; casts: Json };
    if (d.store) {
      const s = fromJson<Omit<Store, 'sessions'> & { sessions: (Omit<Session, 'game'> & { game: string | null })[] }>(d.store);
      const sessions = s.sessions.map((x) => ({ ...x, game: x.game === null ? null : JOINT_GAMES[x.kind].find((g) => g.id === x.game) ?? null }));
      stores.set(world, { ...s, sessions });
    }
    if (d.views) loadByAgent(world, views, d.views);
    if (d.casts) loadByAgent(world, casts, d.casts);
  },
  clear: (world) => {
    stores.delete(world);
    cache.delete(world);
    for (const a of world.agents) {
      views.delete(a);
      casts.delete(a);
    }
  },
});

/** called when someone starts fishing (alone or together): which way the water is, for the rod */
export function noteFishingCast(world: World, agent: Agent, obj: ObjectInstance): void {
  const g = world.grid;
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const x = obj.pos.x + dx;
      const y = obj.pos.y + dy;
      if (x < 0 || y < 0 || x >= g.width || y >= g.height || g.tiles[y * g.width + x] !== 'water') continue;
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = { x: dx / d, y: dy / d };
      }
    }
  if (!best) return;
  casts.set(agent, best);
  if (Math.abs(best.x) > 0.3) agent.facing = best.x < 0 ? -1 : 1;
}

/** unit vector towards the water for an agent fishing (renderer) */
export function fishingCastOf(agent: Agent): Vec2 | undefined {
  return casts.get(agent);
}

/** renderer hook (render/sprites.ts) */
export function jointViewOf(agent: Agent): JointView | undefined {
  return views.get(agent);
}

// ---------------------------------------------------------------- partners and scoring

function busyInBedOrBath(world: World, a: Agent): boolean {
  const act = a.action;
  if (act?.kind !== 'use') return false;
  const obj = objOf(world, act.objectUid);
  const tags = obj ? world.objectDefs[obj.type]?.tags ?? [] : [];
  return tags.includes('sleep') || (tags.includes('hygiene') && act.phase === 'using');
}

/** hard reasons someone cannot come (null = could come) */
function cannotCome(world: World, host: Agent, a: Agent): string | null {
  if (a.id === host.id) return 'self';
  if (a.away) return 'away';
  if (sessionOf(world, a.id)) return 'already';
  if (busyInBedOrBath(world, a)) return 'bed';
  if (a.action?.kind === 'talk' || world.conversations.some((c) => c.participants.includes(a.id))) return 'talking';
  if (a.needs.energy < 10 || a.needs.hunger < 10) return 'critical';
  const rel = world.relationships.get(a.id, host.id);
  const st = statusOf(world, a.id, host.id);
  if (rel < JOINT_TUNING.MIN_SYMPATHY || st === 'rivals' || st === 'enemies') return 'dislike';
  if (dist(a.pos, host.pos) > JOINT_TUNING.INVITE_RADIUS) return 'far';
  return null;
}

/** soft reason to say no right now (needs first), or null */
function needsFirst(a: Agent, h: number): string | null {
  if (a.needs.hunger < 30) return JOINT_LINES.refuseHungry;
  if (a.needs.energy < (h >= 21 ? 40 : 30)) return JOINT_LINES.refuseTired;
  if (a.needs.hygiene < 25) return JOINT_LINES.refuseDirty;
  return null;
}

function recentlyPlayed(world: World, id: number): boolean {
  const t = stores.get(world)?.lastPlayed.get(id);
  return t !== undefined && world.tick - t < JOINT_TUNING.COOLDOWN;
}

/** the object group a session would use: the console / table itself, or the fishing spots next to `obj` */
function groupObjects(world: World, obj: ObjectInstance, kind: JointKind): ObjectInstance[] {
  if (kind !== 'fishing') return [obj];
  return world.objects.filter((o) => o.type === obj.type && dist(o.pos, obj.pos) <= JOINT_TUNING.FISH_RADIUS);
}

function freeSeats(world: World, obj: ObjectInstance, kind: JointKind): { obj: ObjectInstance; slot: number }[] {
  const out: { obj: ObjectInstance; slot: number }[] = [];
  for (const o of groupObjects(world, obj, kind)) o.reservedBy.forEach((r, slot) => r === null && out.push({ obj: o, slot }));
  return out;
}

const cache = new WeakMap<World, { tick: number; byKey: Map<string, number> }>();

/** how many friends could plausibly join `agent` for `kind` right now (cached per tick) */
function availablePartners(world: World, agent: Agent, kind: JointKind): number {
  let c = cache.get(world);
  if (!c || c.tick !== world.tick) cache.set(world, (c = { tick: world.tick, byKey: new Map() }));
  const key = `${agent.id}:${kind}`;
  const hit = c.byKey.get(key);
  if (hit !== undefined) return hit;
  const h = hourOf(timeOf(world));
  let n = 0;
  for (const o of world.agents) if (!cannotCome(world, agent, o) && !needsFirst(o, h) && !recentlyPlayed(world, o.id)) n++;
  c.byKey.set(key, n);
  return n;
}

/** the session gathering / playing at (or right next to) this object */
function sessionAt(world: World, obj: ObjectInstance): Session | undefined {
  const s = stores.get(world);
  if (!s || s.sessions.length === 0) return undefined;
  const kind = jointKindOf(obj.type);
  if (!kind) return undefined;
  return s.sessions.find(
    (x) => x.kind === kind && x.members.some((m) => m.state !== 'left' && (m.uid === obj.uid || (kind === 'fishing' && dist(objOf(world, m.uid)?.pos ?? obj.pos, obj.pos) <= JOINT_TUNING.FISH_RADIUS))),
  );
}

function canJoin(world: World, agent: Agent, session: Session): boolean {
  if (session.members.some((m) => m.id === agent.id) || session.refused.has(agent.id)) return false;
  const active = session.members.filter((m) => m.state !== 'left');
  const max = Math.min(session.capacity, session.game?.max ?? 4);
  if (active.length >= max) return false;
  if (session.endTick !== null && session.endTick - world.tick < 40) return false;
  return active.every((m) => {
    const st = statusOf(world, agent.id, m.id);
    return world.relationships.get(agent.id, m.id) >= 0 && st !== 'rivals' && st !== 'enemies';
  });
}

const NO_BIAS: GoalBias = { mult: 1, add: 0 };

/**
 * scoring pull of a joint-capable object (brain.ts): friends around at the right time of day make a
 * console / card table / fishing spot much more attractive; alone, a card table is barely worth it.
 * A session in progress pulls friends in and keeps others away. `calm` fades the additive part.
 */
export function jointObjectBias(world: World, agent: Agent, obj: ObjectInstance, time: GameTime): GoalBias {
  const kind = jointKindOf(obj.type);
  if (!kind) return NO_BIAS;
  const T = JOINT_TUNING;
  const there = sessionAt(world, obj);
  if (there) return canJoin(world, agent, there) ? T.JOIN_BIAS : { mult: 0.15, add: 0 };
  if (sessionOf(world, agent.id)) return NO_BIAS;
  const solo: GoalBias = { mult: T.SOLO_FACTOR[kind], add: 0 };
  if (recentlyPlayed(world, agent.id) || jointWindow(kind, time) < T.MIN_DURATION + T.WALK_MARGIN) return solo;
  if (freeSeats(world, obj, kind).length < 2) return solo;
  const partners = availablePartners(world, agent, kind);
  if (partners === 0) return solo;
  const fit = timeFit(kind, hourOf(time));
  if (fit <= 0 || (kind === 'fishing' && !fishingOpen(time))) return solo;
  // somebody calls everyone to a film or a grill: that wins over a new game
  if (kind !== 'fishing' && invitationsOf(world).some((i) => i.kind !== 'meal' && i.hostId !== agent.id)) return solo;
  const taste = jointTaste(kind, agent.traits);
  // more friends around: a bit more tempting (an extrovert's console evening)
  const crowd = kind === 'console' ? 1 + 0.15 * Math.min(3, partners - 1) * Math.max(0, agent.traits.sociability + 0.3) : 1;
  // weekends are for doing things together; the winter lake is less inviting
  const calendar = (isWeekend(time) ? SEASON_TUNING.WEEKEND_JOINT : 1) * (kind === 'fishing' && time.season === 'winter' ? SEASON_TUNING.WINTER_OUTDOOR : 1);
  return { mult: T.BIAS_MULT, add: T.BIAS_ADD * taste * fit * crowd * calendar };
}

// ---------------------------------------------------------------- starting a session

/** chance that `a` says yes to `host` (before soft refusals) */
function acceptChance(world: World, host: Agent, a: Agent, kind: JointKind): number {
  const rel = world.relationships.get(a.id, host.id);
  const st = statusOf(world, a.id, host.id);
  let p = 0.3 + rel / 160 + 0.32 * (jointTaste(kind, a.traits) - 1) + 0.12 * a.traits.sociability;
  if (a.needs.fun < 55) p += 0.15;
  if (a.needs.social < 55) p += 0.1;
  if (st === 'couple') p += 0.25;
  else if (st === 'crush' || st === 'best_friends') p += 0.12;
  if (recentlyPlayed(world, a.id)) p -= 0.3;
  return clamp(p, 0.05, 0.92);
}

/** what someone is busy with that makes them less keen to drop it (null = free) */
function busyWith(world: World, a: Agent): { factor: number; what: string } | null {
  const act = a.action;
  if (!act || act.kind === 'wander' || act.kind === 'idle') return null;
  if (act.kind === 'talk') return { factor: 0, what: 'rozmowa' };
  const obj = objOf(world, act.objectUid);
  const def = obj && world.objectDefs[obj.type];
  if (!def) return null;
  // part of a shared meal, a grill party or a film night (or on the way to one): stays there
  if (gatheringOf(world, a.id) || invitationsOf(world).some((i) => i.objectUid === act.objectUid)) return { factor: 0, what: def.verb.toLowerCase() };
  if (def.tags?.includes('food')) return { factor: act.phase === 'using' ? 0.2 : 0.35, what: def.verb.toLowerCase() };
  // fixing something broken, or on the way to wash: that comes first
  if (obj.type.startsWith('repair_') || def.tags?.includes('hygiene')) return { factor: 0, what: def.verb.toLowerCase() };
  if (act.phase === 'using' && act.ticksLeft > 15) return { factor: 0.5, what: def.verb.toLowerCase() };
  return null;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} i ${names[names.length - 1]}`;
}

/** sends `a` on their way to a seat of the session (reserving it); false if there is no way */
function sendTo(world: World, a: Agent, obj: ObjectInstance, slot: number, label: string, path: Vec2[]): boolean {
  const def = world.objectDefs[obj.type];
  obj.reservedBy[slot] = a.id;
  a.path = path;
  a.action = { kind: 'use', phase: 'walking', objectUid: obj.uid, slot, ticksLeft: JOINT_TUNING.HOLD, label: `Idzie: ${label}`, icon: def.icon };
  return true;
}

/**
 * called (actions.ts) when `agent` sets off to use `obj`: joins a session there, or starts a new
 * one by inviting partners. `endAction` is passed in to stop invitees' current actions.
 */
export function onJointHeadingTo(world: World, agent: Agent, obj: ObjectInstance, time: GameTime, endAction: (w: World, a: Agent, reason: string) => void): void {
  const kind = jointKindOf(obj.type);
  if (!kind || agent.action?.kind !== 'use') return;
  const s = store(world);
  const there = sessionAt(world, obj);
  if (there) {
    if (!canJoin(world, agent, there)) return;
    there.members.push({ id: agent.id, uid: obj.uid, slot: agent.action.slot, state: 'walking', arrivedAt: null, leftAt: null, leftReason: null, score: 0, best: 0 });
    agent.action.ticksLeft = JOINT_TUNING.HOLD;
    agent.action.label = `Idzie: ${sessionLabel(there)}`;
    trace(world, agent, 'start', `wspólne: dołącza — ${sessionLabel(there)}`);
    return;
  }
  const T = JOINT_TUNING;
  const h = hourOf(time);
  if (sessionOf(world, agent.id) || recentlyPlayed(world, agent.id) || jointWindow(kind, time) < T.MIN_DURATION + T.WALK_MARGIN || timeFit(kind, h) <= 0) return;
  if (kind === 'fishing' && !fishingOpen(time)) return;
  if (agent.needs.energy < (h >= 21 ? 40 : 30) || agent.needs.hunger < 30 || agent.needs.hygiene < 18) return;
  const seats = freeSeats(world, obj, kind);
  if (seats.length === 0) return;
  const size = Math.min(preferredSize(kind, agent.traits, world.rng), seats.length + 1);

  // who to ask: friends first, then those who like this kind of thing
  const candidates = world.agents
    .filter((o) => !cannotCome(world, agent, o))
    .map((o) => ({ o, w: world.relationships.get(o.id, agent.id) + 30 * jointTaste(kind, o.traits) + world.rng.range(0, 20) }))
    .sort((x, y) => y.w - x.w)
    .map((x) => x.o);
  if (candidates.length === 0) return;

  const session: Session = {
    id: s.nextId++,
    kind,
    hostId: agent.id,
    anchorUid: obj.uid,
    members: [{ id: agent.id, uid: obj.uid, slot: agent.action.slot, state: 'walking', arrivedAt: null, leftAt: null, leftReason: null, score: 0, best: 0 }],
    phase: 'gathering',
    createdAt: world.tick,
    firstArrival: null,
    startTick: null,
    endTick: null,
    game: null,
    nextMoment: 0,
    teamWins: 0,
    teamLosses: 0,
    laughs: 0,
    rained: false,
    refused: new Set(),
    capacity: size,
    chatted: false,
  };
  const label = sessionLabel(session);
  agent.bubble = { kind: 'speech', text: world.rng.pick(JOINT_LINES.invite[kind]), ttl: 25, tone: 'positive' };
  const accepted: Agent[] = [];
  const refusals: string[] = [];
  for (const o of candidates) {
    if (accepted.length >= size - 1 || seats.length === 0) break;
    const rel = Math.round(world.relationships.get(o.id, agent.id));
    trace(world, agent, 'invite', `${o.name} (${label}, sympatia ${rel}), ${o.name} teraz: ${o.action ? o.action.label : 'nic'}`);
    const soft = needsFirst(o, h);
    const busy = busyWith(world, o);
    let reason: string | null = soft;
    if (!reason) {
      const p = acceptChance(world, agent, o, kind) * (busy ? busy.factor : 1);
      if (!world.rng.chance(p)) reason = busy ? world.rng.pick(JOINT_LINES.refuseBusy) : world.rng.pick(JOINT_LINES.refuseMood[kind]);
    }
    if (reason) {
      trace(world, o, 'refuse', `wspólne: ${JOINT_LABEL[kind]} od ${agent.name}${busy ? ` (zajęcie: ${busy.what})` : ''} — „${reason}”`);
      if (!o.bubble || o.bubble.kind === 'thought') o.bubble = { kind: 'speech', text: reason, ttl: 20, tone: 'neutral' };
      refusals.push(o.name);
      session.refused.add(o.id);
      continue;
    }
    const seat = seats[0];
    const path = findPath(world.grid, o.pos, slotStandTile(seat.obj, world.objectDefs[seat.obj.type], seat.slot));
    // too far to make it in time: not asked after all
    if (!path || path.length > T.MAX_INVITE_PATH) continue;
    seats.shift();
    trace(world, o, 'accept', `wspólne: ${JOINT_LABEL[kind]} od ${agent.name}`);
    if (o.action) endAction(world, o, `przerwane: wspólne ${JOINT_LABEL[kind]} z ${agent.name}`);
    if (!sendTo(world, o, seat.obj, seat.slot, `${label} z ${agent.name}`, path)) continue;
    trace(world, o, 'start', `idzie do: ${world.objectDefs[seat.obj.type].name}#${seat.obj.uid} — ${label} z ${agent.name}`);
    o.bubble = { kind: 'speech', text: world.rng.pick(JOINT_LINES.accept), ttl: 20, tone: 'positive' };
    session.members.push({ id: o.id, uid: seat.obj.uid, slot: seat.slot, state: 'walking', arrivedAt: null, leftAt: null, leftReason: null, score: 0, best: 0 });
    accepted.push(o);
  }
  if (accepted.length === 0) {
    trace(world, agent, 'start', `wspólne: ${JOINT_LABEL[kind]} — nikt nie ma czasu (${refusals.join(', ')}), dalej solo`);
    agent.bubble = { kind: 'thought', text: world.rng.pick(JOINT_LINES.alone), ttl: 25 };
    return;
  }
  agent.action.ticksLeft = T.HOLD;
  agent.action.label = `Idzie: ${label}`;
  s.sessions.push(session);
  trace(world, agent, 'start', `wspólne: zbiórka — ${label}, idą: ${accepted.map((a) => a.name).join(', ')}${refusals.length ? `, odmowy: ${refusals.join(', ')}` : ''}`);
}

/** called on arrival at the object (actions.ts); returns a trace suffix */
export function onJointArrive(world: World, agent: Agent): string | null {
  const r = sessionOf(world, agent.id);
  const a = agent.action;
  if (!r || a?.kind !== 'use') return null;
  const { session, member } = r;
  member.state = 'here';
  member.arrivedAt = world.tick;
  if (session.phase === 'playing' && session.endTick !== null) {
    a.ticksLeft = Math.max(5, session.endTick - world.tick);
    a.label = capitalize(sessionLabel(session));
    return `${sessionLabel(session)} — dołącza, do końca ${a.ticksLeft} min`;
  }
  a.ticksLeft = JOINT_TUNING.HOLD;
  if (session.firstArrival === null) session.firstArrival = world.tick;
  a.label = 'Czeka na resztę';
  return `${sessionLabel(session)} — czeka na resztę`;
}

const capitalize = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

// ---------------------------------------------------------------- running sessions

function memberStillThere(a: Agent | undefined, m: Member): 'walking' | 'here' | null {
  const act = a?.action;
  if (!act || act.kind !== 'use' || act.objectUid !== m.uid || act.slot !== m.slot) return null;
  return act.phase === 'using' ? 'here' : 'walking';
}

/** someone still on the way can make it before the longest wait is over */
function nearlyThere(world: World, session: Session, waited: number): boolean {
  const left = JOINT_TUNING.WAIT_MAX - waited;
  return session.members.some((m) => {
    if (m.state !== 'walking') return false;
    const a = byId(world, m.id);
    // the one who called everybody is worth waiting for (up to GATHER_TIMEOUT)
    if (m.id === session.hostId && a && a.path.length > 0) return true;
    return (a?.path.length ?? 999) <= Math.max(JOINT_TUNING.NEAR_PATH, left * 0.4);
  });
}

function chooseGame(world: World, session: Session, players: Agent[]): JointGame {
  // those still on the way will join: the game must fit everybody
  const count = Math.max(players.length, session.members.filter((m) => m.state !== 'left').length);
  const games = JOINT_GAMES[session.kind].filter((g) => count >= g.min && count <= g.max);
  const weights = games.map((g) => {
    let w = 1;
    // quiet pairs like chess, bigger groups a property game; coop for friendly groups
    if (g.id === 'chess') w = 1.5 - 0.5 * avg(players, (p) => p.traits.sociability);
    if (g.id === 'eurobiznes') w = players.length >= 3 ? 1.6 : 0.6;
    if (g.coop) w = 0.7 + 0.5 * avg(players, (p) => p.traits.cheerfulness);
    if (g.id === 'fight') w = 0.7 + 0.4 * avg(players, (p) => p.traits.activity);
    return Math.max(0.1, w);
  });
  return games[world.rng.weightedIndex(weights)];
}

const avg = (xs: Agent[], f: (a: Agent) => number): number => xs.reduce((s, a) => s + f(a), 0) / Math.max(1, xs.length);

function startPlaying(world: World, session: Session, here: Agent[]): void {
  const T = JOINT_TUNING;
  const time = timeOf(world);
  const [lo, hi] = T.DURATION[session.kind];
  const taste = avg(here, (p) => jointTaste(session.kind, p.traits));
  let d = Math.round(world.rng.int(lo, hi) * clamp(0.8 + 0.25 * taste, 0.8, 1.2));
  const room = roomUntilBoundary(session.kind, hourOf(time));
  // the window may have shrunk while people were on their way; a short game is still a game
  d = clamp(Math.min(Math.max(d, T.MIN_DURATION), room > 0 ? room : 45), 45, hi);
  session.phase = 'playing';
  session.startTick = world.tick;
  session.endTick = world.tick + d;
  session.game = chooseGame(world, session, here);
  session.nextMoment = world.tick + world.rng.int(T.MOMENT_EVERY[0], T.MOMENT_EVERY[1]);
  const label = capitalize(sessionLabel(session));
  for (const p of here) {
    const a = p.action;
    if (a?.kind === 'use') {
      a.ticksLeft = d;
      a.label = label;
    }
    trace(world, p, 'start', `wspólne: start — ${sessionLabel(session)}, razem: ${here.map((x) => x.name).join(', ')}, ${d} min`);
  }
  const first = here.find((p) => p.id === session.hostId) ?? here[0];
  first.bubble = { kind: 'speech', text: world.rng.pick(JOINT_LINES.start[session.kind]), ttl: 20, tone: 'positive' };
}

/** nobody else came (or everybody else dropped out): the one who is there carries on alone, or gives up */
function fallBackSolo(world: World, s: Store, session: Session, reason: string, endAction: (w: World, a: Agent, reason: string) => void): void {
  for (const m of session.members) {
    if (m.state === 'left') continue;
    const a = byId(world, m.id);
    const act = a?.action;
    if (!a || act?.kind !== 'use') continue;
    const obj = objOf(world, act.objectUid);
    const def = obj && world.objectDefs[obj.type];
    if (!def) continue;
    if (session.kind === 'boardgame' || act.phase === 'walking') {
      endAction(world, a, `wspólne odwołane: ${reason}`);
      continue;
    }
    act.ticksLeft = world.rng.int(def.duration[0], def.duration[1]);
    act.label = def.verb;
    a.bubble = { kind: 'thought', text: world.rng.pick(JOINT_LINES.alone), ttl: 25 };
    trace(world, a, 'start', `wspólne: ${JOINT_LABEL[session.kind]} odwołane (${reason}) — solo na ${act.ticksLeft} min`);
  }
  close(world, s, session, false, reason);
}

function close(world: World, s: Store, session: Session, happened: boolean, text: string): void {
  s.sessions = s.sessions.filter((x) => x !== session);
  const ids = session.members.filter((m) => m.arrivedAt !== null && session.startTick !== null).map((m) => m.id);
  const end = world.tick;
  s.log.push({
    kind: session.kind,
    game: session.game?.label ?? JOINT_LABEL[session.kind],
    hostId: session.hostId,
    ids: happened ? ids : [],
    start: session.startTick ?? session.createdAt,
    end,
    minutes: happened && session.startTick !== null ? end - session.startTick : 0,
    text,
    happened,
  });
  if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
  for (const m of session.members) {
    const a = byId(world, m.id);
    if (a) views.delete(a);
    if (happened) s.lastPlayed.set(m.id, end);
  }
}

/** a small moment of the game: score changes, bubbles */
function moment(world: World, session: Session, here: Agent[]): void {
  const rng = world.rng;
  const L = JOINT_LINES;
  const memberOf = (a: Agent): Member => session.members.find((m) => m.id === a.id)!;
  const say = (a: Agent, text: string, tone: 'positive' | 'neutral' | 'negative' = 'positive'): void => {
    // don't talk over a conversation line said this or last minute
    if (a.bubble?.kind === 'speech' && a.bubble.ttl >= LINE_TTL - 1) return;
    a.bubble = { kind: 'speech', text, ttl: 18, tone };
  };
  if (rng.chance(0.15)) {
    session.laughs++;
    const a = rng.pick(here);
    say(a, rng.pick(L.laugh));
    a.needs.fun = Math.min(100, a.needs.fun + 3);
    return;
  }
  if (session.kind === 'fishing') {
    // everyone has a go; somebody may get a bite
    const weights = here.map((a) => 1 + 0.3 * a.traits.activity + (rng.next() - 0.5) * 0.4);
    const a = here[rng.weightedIndex(weights)];
    const m = memberOf(a);
    if (rng.chance(0.42)) {
      const kg = Math.round(rng.range(0.3, 1.6) * (rng.chance(0.12) ? 3 : 1) * 10) / 10;
      m.score++;
      m.best = Math.max(m.best, kg);
      say(a, kg >= 2.5 ? rng.pick(L.fishing.big) : rng.pick(L.fishing.catch));
      a.needs.fun = Math.min(100, a.needs.fun + 4);
    } else if (rng.chance(0.4)) say(a, rng.pick(L.fishing.miss), 'neutral');
    else say(a, rng.pick(L.fishing.wait), 'neutral');
    return;
  }
  const game = session.game!;
  if (game.coop) {
    const win = rng.chance(0.55 + 0.05 * here.length);
    if (win) session.teamWins++;
    else session.teamLosses++;
    for (const a of here) memberOf(a).score += win ? 1 : 0;
    say(rng.pick(here), rng.pick(win ? L.console.coopWin : L.console.coopFail), win ? 'positive' : 'neutral');
    return;
  }
  // competitive round: skill = small random edge + activity / neatness flavour
  const weights = here.map((a) => 1 + 0.25 * (session.kind === 'console' ? a.traits.activity : a.traits.neatness) + rng.range(0, 0.6));
  if (rng.chance(session.kind === 'boardgame' && game.id === 'chess' ? 0.25 : 0.1)) {
    // a draw / an uneventful turn
    say(rng.pick(here), rng.pick(game.id === 'chess' ? L.board.chessMove : L.draw), 'neutral');
    return;
  }
  const winner = here[rng.weightedIndex(weights)];
  memberOf(winner).score++;
  const losers = here.filter((a) => a !== winner);
  const pool = session.kind === 'console' ? L.console.win[game.id] ?? L.console.win.race : game.id === 'chess' ? L.board.chessWin : game.id === 'cards' ? L.board.cardsWin : L.board.euroWin;
  say(winner, rng.pick(pool));
  winner.needs.fun = Math.min(100, winner.needs.fun + 3);
  const loser = rng.pick(losers);
  if (loser && rng.chance(0.5)) say(loser, rng.pick(loser.traits.cheerfulness < -0.3 ? L.sore : L.lose), loser.traits.cheerfulness < -0.3 ? 'negative' : 'neutral');
}

/** text of the score badge ("🎮 2:1", "🎣 3 ryby") */
function badgeText(session: Session, here: Member[]): string {
  const icon = session.game?.icon && session.kind !== 'fishing' ? session.game.icon : BADGE_ICON[session.kind];
  if (session.phase !== 'playing') return `${BADGE_ICON[session.kind]} …`;
  if (session.kind === 'fishing') {
    const n = session.members.reduce((s, m) => s + m.score, 0);
    return `${icon} ${n} ${fishWord(n)}`;
  }
  if (session.game?.coop) return `${icon} ${session.teamWins}:${session.teamLosses}`;
  return `${icon} ${here.map((m) => m.score).join(':')}`;
}

/** "ryba" / "ryby" / "ryb" */
export function fishWord(n: number): string {
  if (n === 1) return 'ryba';
  const d = n % 10;
  const dd = n % 100;
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'ryby' : 'ryb';
}

function updateViews(world: World, session: Session): void {
  const here = session.members.filter((m) => m.state === 'here');
  const agents = here.map((m) => byId(world, m.id)).filter((a): a is Agent => !!a);
  let holder: Agent | null = null;
  for (const a of agents) if (!holder || a.id < holder.id) holder = a;
  for (const m of session.members) {
    const a = byId(world, m.id);
    if (!a) continue;
    if (m.state !== 'here') {
      views.delete(a);
      continue;
    }
    let badge: JointView['badge'] = null;
    if (a === holder && agents.length >= 2 && session.phase === 'playing') {
      const x = agents.reduce((s, p) => s + p.pos.x, 0) / agents.length;
      const y = Math.min(...agents.map((p) => p.pos.y));
      badge = { text: badgeText(session, here), x, y: y - 1.55 };
    }
    views.set(a, { kind: session.kind, game: session.game?.id ?? null, badge });
  }
}

/** advances every session; called once per tick (from groups.tickGatherings) */
export function tickJoint(world: World, endAction: (w: World, a: Agent, reason: string) => void): void {
  const s = stores.get(world);
  if (!s || s.sessions.length === 0) return;
  const T = JOINT_TUNING;
  for (const session of [...s.sessions]) {
    // who is still in
    for (const m of session.members) {
      if (m.state === 'left') continue;
      const a = byId(world, m.id);
      const now = memberStillThere(a, m);
      if (now === null) {
        m.state = 'left';
        m.leftAt = world.tick;
        m.leftReason = !a ? 'zniknięcie' : session.rained ? 'deszcz' : session.endTick !== null && world.tick >= session.endTick ? 'koniec' : a.needs.energy < 12 || a.needs.hunger < 12 ? 'pilna potrzeba' : 'inne zajęcie';
        if (a) views.delete(a);
        if (a && m.leftReason !== 'koniec' && session.phase === 'playing') trace(world, a, 'end', `wspólne: odchodzi wcześniej — ${sessionLabel(session)} (${m.leftReason})`);
      } else if (now === 'here' && m.state === 'walking') {
        // arrival is normally reported by onJointArrive; this catches anything else
        m.state = 'here';
        m.arrivedAt ??= world.tick;
        if (session.firstArrival === null) session.firstArrival = world.tick;
      }
    }
    const anchor = objOf(world, session.anchorUid);
    if (anchor && session.kind === 'fishing' && availability(world, anchor, world.objectDefs[anchor.type]) < 0.5) session.rained = true;
    const here = session.members.filter((m) => m.state === 'here');
    const active = session.members.filter((m) => m.state !== 'left');
    const hereAgents = here.map((m) => byId(world, m.id)).filter((a): a is Agent => !!a);

    if (session.phase === 'gathering') {
      if (here.length >= 2) startPlaying(world, session, hereAgents);
      else if (active.length <= 1) {
        fallBackSolo(world, s, session, session.rained ? 'deszcz' : 'reszta zmienia plany', endAction);
        continue;
      } else if (session.firstArrival !== null && world.tick - session.firstArrival > T.WAIT && !nearlyThere(world, session, world.tick - session.firstArrival)) {
        fallBackSolo(world, s, session, 'nikt nie dochodzi', endAction);
        continue;
      } else if (world.tick - session.createdAt > T.GATHER_TIMEOUT) {
        fallBackSolo(world, s, session, 'za długo', endAction);
        continue;
      }
      updateViews(world, session);
      continue;
    }

    // playing
    if (here.length < 2 && !(here.length === 1 && active.length >= 2)) {
      finish(world, s, session, endAction);
      continue;
    }
    for (const a of hereAgents) applyEffects(a, T.COMPANY);
    if (!session.chatted && world.conversations.some((c) => c.participants.every((id) => here.some((m) => m.id === id)))) session.chatted = true;
    if (here.length >= 2 && world.tick >= session.nextMoment) {
      moment(world, session, hereAgents);
      session.nextMoment = world.tick + world.rng.int(T.MOMENT_EVERY[0], T.MOMENT_EVERY[1]);
    }
    // chats among (or with) members wrap up before the shared end
    if (session.endTick !== null && session.endTick - world.tick <= T.WRAP) {
      for (const c of world.conversations) {
        if (c.participants.some((id) => active.some((m) => m.id === id))) c.maxLines = Math.min(c.maxLines, c.lines.length + 1);
      }
    }
    updateViews(world, session);
  }
}

/** the session is over: outcomes, relationships, the log line */
function finish(world: World, s: Store, session: Session, endAction: (w: World, a: Agent, reason: string) => void): void {
  const T = JOINT_TUNING;
  // whoever is still at it (e.g. the last one after the others had to leave) stops too
  const stillThere = session.members.filter((m) => m.state !== 'left');
  const early = session.endTick !== null && world.tick < session.endTick - 1;
  for (const m of stillThere) {
    const a = byId(world, m.id);
    if (a) endAction(world, a, early ? 'wspólne: reszta odchodzi' : 'wspólne: koniec');
    m.state = 'left';
    m.leftAt = world.tick;
    m.leftReason = 'koniec';
  }
  const start = session.startTick ?? world.tick;
  const minutes = world.tick - start;
  const players = session.members.filter((m) => m.arrivedAt !== null && (m.leftAt ?? world.tick) - Math.max(m.arrivedAt, start) >= Math.min(15, minutes / 2));
  const agents = players.map((m) => byId(world, m.id)).filter((a): a is Agent => !!a);
  if (agents.length < 2 || minutes < 10) {
    close(world, s, session, false, 'za krótko');
    return;
  }
  const time = timeOf(world);
  const outcome = describeOutcome(session, players, agents, minutes, time);

  // sympathy for every pair: time well spent, minus clashing temperaments
  for (let i = 0; i < agents.length; i++)
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i];
      const b = agents[j];
      const gap = Math.abs(a.traits.cheerfulness - b.traits.cheerfulness) + Math.abs(a.traits.sociability - b.traits.sociability);
      const delta = (T.BOND + 1.2 - 0.6 * gap) * Math.min(1, minutes / 60);
      world.relationships.adjust(a.id, b.id, Math.round(delta * 10) / 10);
    }
  // winners feel great; a grumpy loser may start a quarrel
  if (outcome.winner) {
    outcome.winner.needs.fun = Math.min(100, outcome.winner.needs.fun + 6);
    const loser = outcome.loser;
    if (loser && outcome.margin >= T.QUARREL_MARGIN && loser.traits.cheerfulness < -0.2) {
      const p = T.QUARREL_BASE + 0.5 * clash(world, loser.id, outcome.winner.id) - 0.3 * loser.traits.cheerfulness;
      if (world.rng.chance(clamp(p, 0, 0.7))) {
        // a sore loser: friction (not a full quarrel) and a note in the pair's history
        recordFriction(world, loser.id, outcome.winner.id, T.QUARREL_RIVALRY);
        noteRelation(world, loser.id, outcome.winner.id, `Kłótnia po przegranej: ${session.game?.label ?? JOINT_LABEL[session.kind]}`);
        world.relationships.adjust(loser.id, outcome.winner.id, -4);
        loser.bubble = { kind: 'speech', text: world.rng.pick(JOINT_LINES.quarrel), ttl: 25, tone: 'negative' };
        pushEvent(world, 'relationship', `${loser.name} ↔ ${outcome.winner.name}: kłótnia o wynik gry (${session.game?.label ?? JOINT_LABEL[session.kind]}) 💢`, [loser.id, outcome.winner.id], {
          text: `${loser.name} i ${outcome.winner.name} kłócą się o wynik gry`,
          aboutIds: [loser.id, outcome.winner.id],
          valence: -0.4,
        });
      }
    }
  }
  const ids = agents.map((a) => a.id);
  pushEvent(world, 'info', outcome.log, ids, outcome.gossip ? { ...outcome.gossip, aboutIds: outcome.gossip.aboutIds } : undefined);
  // a good catch around lunch or dinner: grill it together
  if (session.kind === 'fishing' && !session.rained && players.some((m) => m.score > 0)) grillTheCatch(world, agents, outcome.winner ?? agents[0]);
  for (const a of agents) trace(world, a, 'end', `wspólne: koniec — ${outcome.log}`);
  close(world, s, session, true, outcome.log);
}

/** the fisher with the best catch calls everybody to the nearest working grill (groups.callGathering) */
function grillTheCatch(world: World, fishers: Agent[], host: Agent): void {
  const h = hourOf(timeOf(world));
  if (!((h >= 11 && h < 14) || (h >= 16.5 && h < 19.5))) return;
  let best: ObjectInstance | null = null;
  let bestD = Infinity;
  for (const o of world.objects) {
    if (o.type !== 'grill' || o.reservedBy.every((r) => r !== null)) continue;
    const d = dist(o.pos, host.pos);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  if (!best || bestD > JOINT_TUNING.INVITE_RADIUS) return;
  if (callGathering(world, host, best, world.rng.pick(JOINT_LINES.grillCatch))) {
    trace(world, host, 'start', `wspólne: po wędkowaniu zaprasza na grilla z rybami (${fishers.map((f) => f.name).join(', ')})`);
  }
}

interface Outcome {
  log: string;
  gossip?: Gossip;
  winner?: Agent;
  loser?: Agent;
  margin: number;
}

function hoursText(minutes: number): string {
  const h = Math.round(minutes / 30) / 2;
  if (h < 1) return `${minutes} min`;
  return `${String(h).replace('.', ',')} h`;
}

function describeOutcome(session: Session, players: Member[], agents: Agent[], minutes: number, time: GameTime): Outcome {
  const names = agents.map((a) => a.name);
  const list = names.join(', ');
  const all = joinNames(names);
  const ids = agents.map((a) => a.id);
  const late = time.hour >= 23 || time.hour < 4;
  const lateText = late ? ', do późna' : '';
  const scoreOf = (a: Agent): Member => players.find((m) => m.id === a.id)!;
  const ranked = [...agents].sort((x, y) => scoreOf(y).score - scoreOf(x).score || scoreOf(y).best - scoreOf(x).best);
  const top = ranked[0];
  const bottom = ranked[ranked.length - 1];
  const margin = scoreOf(top).score - scoreOf(bottom).score;
  const draw = agents.length >= 2 && scoreOf(top).score === scoreOf(ranked[1]).score;
  const dur = hoursText(minutes);

  if (session.kind === 'fishing') {
    const total = players.reduce((s, m) => s + m.score, 0);
    if (session.rained) {
      const caught = total > 0 ? `, ${total} ${fishWord(total)}` : '';
      return { log: `Wspólne wędkowanie: ${list} — deszcz przerywa${caught} 🌧️`, margin: 0 };
    }
    if (total === 0) return { log: `Wspólne wędkowanie (${dur}): ${list} — dziś bez brań 🎣`, margin: 0, gossip: { text: `${all} łowią godzinami i nic`, aboutIds: ids, valence: -0.1 } };
    const best = scoreOf(top).best;
    const bestBy = [...agents].sort((x, y) => scoreOf(y).best - scoreOf(x).best)[0];
    const kg = String(best).replace('.', ',');
    const log = `Wspólne wędkowanie (${dur}): ${list} — ${total} ${fishWord(total)}, największa: ${bestBy.name} (${kg} kg) 🎣`;
    const notable = best >= 2.5 || total >= 4;
    return {
      log,
      winner: bestBy,
      margin: 0,
      gossip: notable ? { text: best >= 2.5 ? `${bestBy.name} łowi rybę na ${kg} kg` : `${all} łowią razem ${total} ${fishWord(total)}`, aboutIds: best >= 2.5 ? [bestBy.id] : ids, valence: 0.5 } : undefined,
    };
  }

  const game = session.game!;
  // competitive results list the players from the best
  const order = game.coop ? agents : ranked;
  const scores = order.map((a) => scoreOf(a).score).join(':');
  const listed = order.map((a) => a.name).join(', ');
  const head = session.kind === 'console' ? `Wspólne granie (${game.label}, ${dur}${lateText})` : `Wspólna gra (${game.label}, ${dur}${lateText})`;
  const marathon: Gossip | undefined = late ? { text: `${all} grają w ${session.kind === 'console' ? 'gry wideo' : game.label} do późna`, aboutIds: ids, valence: 0.2 } : undefined;
  if (game.coop) {
    const ok = session.teamWins >= session.teamLosses;
    return {
      log: `${head}: ${list} — ${ok ? `misja zaliczona (${session.teamWins}:${session.teamLosses}) 🗡️` : `boss nie do pokonania (${session.teamWins}:${session.teamLosses}) 💀`}`,
      margin: 0,
      gossip: marathon ?? (ok && session.teamWins >= 4 ? { text: `${all} przechodzą razem grę do końca`, aboutIds: ids, valence: 0.4 } : undefined),
    };
  }
  if (draw) return { log: `${head}: ${listed} — remis ${scores} 🤝`, margin: 0, gossip: marathon };
  const icon = session.kind === 'console' ? '🏆' : game.icon;
  const what = game.id === 'eurobiznes' ? `${top.name} zostaje magnatem` : `wygrywa ${top.name}`;
  const big = margin >= 3;
  const gossip: Gossip | undefined =
    marathon ??
    (big
      ? {
          text:
            session.kind === 'console'
              ? `${top.name} wygrywa turniej ${game.id === 'football' ? 'futbolu' : game.id === 'race' ? 'wyścigów' : 'bijatyki'} na konsoli`
              : game.id === 'chess'
                ? `${top.name} wygrywa w szachy`
                : game.id === 'cards'
                  ? `${top.name} wygrywa każde rozdanie w karty`
                  : `${top.name} wygrywa w Eurobiznes`,
          aboutIds: [top.id],
          valence: 0.4,
        }
      : undefined);
  return { log: `${head}: ${listed} — ${what} ${scores} ${icon}`, gossip, winner: top, loser: bottom, margin };
}
