import type { Agent, Conversation, GameTime, ObjectDef, Needs, Traits, Vec2, World } from '../types';
import { registerWorldState, type Json } from '../core/state';
import { isWalkable } from '../world/grid';
import { slotStandTile } from '../world/objects';
import { pushEvent } from '../world/events';
import { availability, weatherOf } from '../world/incidents';
import { findPath, nearestWalkable } from './pathfinding';
import { computeMood } from './needs';
import { GUEST_ID_BASE, isGuest, isResident } from './role';

// Guests: people from outside who drop in, chat, use social objects and leave again (issue #7).
//  - a neighbour comes for coffee, the courier brings a parcel, friends come over for a barbecue or an
//    evening together (weekends and Friday evenings)
//  - they are ordinary agents with role 'guest' (so conversations, relations, gossip, the renderer and
//    snapshots just work), but live in a bounded pool of identities that return now and then: no bed,
//    goals or diary, needs held steady, and only the social objects are theirs to use
//  - they enter and leave through the edge of the map; the brain hooks are in brain.ts / actions.ts

type GuestKind = 'neighbour' | 'courier' | 'friend';

interface Identity {
  id: number;
  name: string;
  kind: GuestKind;
  color: string;
  traits: Traits;
}

/** the whole cast: ids stay stable, so relations and gossip about a guest survive between visits */
const POOL: readonly Identity[] = [
  { id: GUEST_ID_BASE, name: 'Halina', kind: 'neighbour', color: '#b5838d', traits: { sociability: 0.8, activity: -0.2, neatness: 0.4, cheerfulness: 0.5 } },
  { id: GUEST_ID_BASE + 1, name: 'Józef', kind: 'neighbour', color: '#6d6875', traits: { sociability: 0.5, activity: 0.1, neatness: 0.2, cheerfulness: -0.1 } },
  { id: GUEST_ID_BASE + 2, name: 'Kurier', kind: 'courier', color: '#e9b44c', traits: { sociability: 0.2, activity: 0.7, neatness: 0.5, cheerfulness: 0.3 } },
  { id: GUEST_ID_BASE + 3, name: 'Agata', kind: 'friend', color: '#e56b6f', traits: { sociability: 0.7, activity: 0.4, neatness: 0.1, cheerfulness: 0.7 } },
  { id: GUEST_ID_BASE + 4, name: 'Darek', kind: 'friend', color: '#5c8001', traits: { sociability: 0.6, activity: 0.2, neatness: -0.3, cheerfulness: 0.6 } },
  { id: GUEST_ID_BASE + 5, name: 'Iga', kind: 'friend', color: '#4cc9f0', traits: { sociability: 0.4, activity: 0.5, neatness: 0.3, cheerfulness: 0.8 } },
  { id: GUEST_ID_BASE + 6, name: 'Michał', kind: 'friend', color: '#7b2cbf', traits: { sociability: 0.3, activity: -0.1, neatness: 0.0, cheerfulness: 0.3 } },
];

export const GUEST_NAMES: readonly string[] = POOL.map((g) => g.name);

/** a guest's name by id, also between visits (diaries and chronicles outlive the visit) */
export function guestNameOf(id: number): string | undefined {
  return POOL.find((g) => g.id === id)?.name;
}

export const GUEST_TUNING = {
  /** per-minute arrival chance inside the kind's window (a few visits per day in all) */
  NEIGHBOUR_CHANCE: 0.0012,
  COURIER_CHANCE: 0.0018,
  FRIENDS_CHANCE: 0.003,
  /** hard caps: visits started per day, guests in the house at once */
  MAX_VISITS_PER_DAY: 4,
  MAX_PRESENT: 5,
  /** an identity comes back no sooner than this many minutes after leaving */
  REVISIT_GAP: { neighbour: 20 * 60, courier: 5 * 60, friend: 3 * 24 * 60 } as Record<GuestKind, number>,
  /** stay length in minutes [min, max] */
  STAY: { neighbour: [40, 90], courier: [14, 22], friend: [100, 190] } as Record<GuestKind, [number, number]>,
  /** friends go home by 22:30 */
  FRIENDS_HOME_MINUTE: 22 * 60 + 30,
  /** a guest in the middle of a chat may stay this long past the planned leaving time */
  CHAT_GRACE: 15,
  /** a leaving guest is removed after this long whatever happens (never grows unbounded) */
  LEAVE_LIMIT: 60,
  /** the courier chats only briefly */
  COURIER_LINES: 3,
} as const;

const NEIGHBOUR_HOURS: readonly [number, number] = [10, 18];
const COURIER_HOURS: readonly [number, number] = [9, 17];
const FRIEND_HOURS: Record<number, readonly [number, number]> = { 4: [18, 21], 5: [16, 21], 6: [15, 20] };
const ENTRANCE_SAMPLES = 6;

interface Visit {
  id: number;
  /** tick the guest is due to leave */
  leaveAt: number;
  leaving: boolean;
  /** the map-edge tile the guest came in through and walks out to */
  exit: Vec2;
}

interface GuestState {
  enabled: boolean;
  visits: Visit[];
  /** identity id -> tick of the last departure */
  lastLeft: Record<number, number>;
  /** day number and visits started on it */
  day: number;
  started: number;
}

const states = new WeakMap<World, GuestState>();

function stateOf(world: World): GuestState {
  let s = states.get(world);
  if (!s) states.set(world, (s = { enabled: true, visits: [], lastLeft: {}, day: 0, started: 0 }));
  return s;
}

registerWorldState('guests', {
  save: (world) => (states.has(world) ? (JSON.parse(JSON.stringify(states.get(world))) as Json) : null),
  load: (world, data) => {
    const d = data as unknown as GuestState;
    states.set(world, { enabled: d.enabled, visits: d.visits.map((v) => ({ ...v, exit: { ...v.exit } })), lastLeft: { ...d.lastLeft }, day: d.day, started: d.started });
  },
  clear: (world) => {
    states.delete(world);
  },
  optional: true,
});

/** guests are on by default; tests and hand-made scenes can switch them off */
export function setGuestsEnabled(world: World, enabled: boolean): void {
  stateOf(world).enabled = enabled;
}

/** the map-edge tile each guest on the map came in through (and leaves by) */
export function guestEntrances(world: World): { id: number; at: Vec2 }[] {
  return stateOf(world).visits.map((v) => ({ id: v.id, at: { ...v.exit } }));
}

const identityOf = (id: number): Identity | undefined => POOL.find((g) => g.id === id);

export function guestKindOf(agent: Agent): GuestKind | undefined {
  return isGuest(agent) ? identityOf(agent.id)?.kind : undefined;
}

/** a guest on the way out: nobody starts a chat with them any more */
export function isLeavingGuest(world: World, agent: Agent): boolean {
  return isGuest(agent) && !!states.get(world)?.visits.some((v) => v.id === agent.id && v.leaving);
}

// ---------------------------------------------------------------- what guests do (brain hooks)

/** guests use social objects only (table, sofa, TV, bench, grill); joint sessions and projects stay with residents */
export function guestMayUse(def: ObjectDef): boolean {
  const tags = def.tags ?? [];
  return !!def.social && !tags.includes('sleep') && !tags.includes('games') && !tags.includes('project') && !tags.includes('repair');
}

/** friends come for the barbecue: the grill is the place to be, unless it is winter */
export function guestObjectFactor(agent: Agent, def: ObjectDef, time: GameTime): number {
  return guestKindOf(agent) === 'friend' && def.id === 'grill' && time.season !== 'winter' ? 2 : 1;
}

/** the courier does one thing: hand over the parcel, so wandering and objects are dropped while someone is there to talk to */
export function guestKeepsOnlyTalk(agent: Agent): boolean {
  return guestKindOf(agent) === 'courier';
}

/** visits have their own topics, and the courier's chat is short */
export function tuneVisitChat(conv: Conversation, a: Agent, b: Agent, chance: (p: number) => boolean): void {
  const kind = guestKindOf(a) ?? guestKindOf(b);
  if (!kind) return;
  if (kind === 'courier') {
    conv.topic = 'przesyłka';
    conv.maxLines = Math.min(conv.maxLines, GUEST_TUNING.COURIER_LINES);
  } else if (chance(0.5)) conv.topic = 'wizyta';
}

// ---------------------------------------------------------------- the visit lifecycle

/** a guest agent standing at `pos` (also used by the replay player to bring a recorded guest back) */
export function createGuest(g: Pick<Identity, 'id' | 'name' | 'color' | 'traits'>, pos: Vec2): Agent {
  const needs: Needs = { hunger: 80, energy: 80, fun: 55, social: 40, hygiene: 80, comfort: 80 };
  return {
    id: g.id,
    name: g.name,
    color: g.color,
    traits: { ...g.traits },
    needs,
    mood: computeMood(needs, g.traits),
    pos: { x: pos.x, y: pos.y },
    prevPos: { x: pos.x, y: pos.y },
    facing: 1,
    path: [],
    action: null,
    bubble: null,
    stats: { conversations: 0, objectsUsed: 0, ticksIdle: 0 },
    role: 'guest',
  };
}

/** keeps a guest's needs steady: they are not here to eat, sleep or wash, only to socialise */
function holdNeeds(agent: Agent): void {
  const n = agent.needs;
  n.hunger = n.energy = n.hygiene = n.comfort = 80;
  n.social = Math.min(n.social, 45);
  n.fun = Math.min(n.fun, 55);
}

function inWindow(hours: readonly [number, number] | undefined, time: GameTime): boolean {
  return !!hours && time.hour >= hours[0] && time.hour < hours[1];
}

function isAsleep(world: World, agent: Agent): boolean {
  const a = agent.action;
  if (a?.kind !== 'use' || a.phase !== 'using') return false;
  const obj = world.objects.find((o) => o.uid === a.objectUid);
  return !!obj && !!world.objectDefs[obj.type]?.tags?.includes('sleep');
}

function perimeter(world: World): Vec2[] {
  const g = world.grid;
  const out: Vec2[] = [];
  for (let x = 0; x < g.width; x++) for (const y of [0, g.height - 1]) if (isWalkable(g, x, y)) out.push({ x, y });
  for (let y = 1; y < g.height - 1; y++) for (const x of [0, g.width - 1]) if (isWalkable(g, x, y)) out.push({ x, y });
  return out;
}

/** a map-edge tile with a short walk to `target`, among a few random ones */
function pickEntrance(world: World, target: Vec2): Vec2 | null {
  const edge = perimeter(world);
  let best: { tile: Vec2; len: number } | null = null;
  for (let i = 0; i < ENTRANCE_SAMPLES && edge.length > 0; i++) {
    const tile = world.rng.pick(edge);
    const len = findPath(world.grid, tile, target)?.length;
    if (len !== undefined && (!best || len < best.len)) best = { tile, len };
  }
  return best?.tile ?? null;
}

/** where a visit of this kind is headed: a free social object, or (the courier) someone awake to talk to */
function destination(world: World, kind: GuestKind, awake: Agent[]): Vec2 | null {
  if (kind === 'courier') return awake.length > 0 ? nearestWalkable(world.grid, world.rng.pick(awake).pos) : null;
  const spots = world.objects.filter((o) => {
    const def = world.objectDefs[o.type];
    return def && guestMayUse(def) && availability(world, o, def) >= 1 && o.reservedBy.some((r) => r === null);
  });
  if (spots.length === 0) return null;
  const obj = world.rng.pick(spots);
  const def = world.objectDefs[obj.type];
  return slotStandTile(obj, def, Math.max(0, obj.reservedBy.findIndex((r) => r === null)));
}

function present(world: World, id: number): boolean {
  return world.agents.some((a) => a.id === id);
}

function available(world: World, s: GuestState, g: Identity): boolean {
  if (present(world, g.id)) return false;
  const left = s.lastLeft[g.id];
  return left === undefined || world.tick - left >= GUEST_TUNING.REVISIT_GAP[g.kind];
}

function arrivalChance(kind: GuestKind, time: GameTime): number {
  const wd = time.weekday ?? 0;
  switch (kind) {
    case 'neighbour':
      return inWindow(NEIGHBOUR_HOURS, time) ? GUEST_TUNING.NEIGHBOUR_CHANCE : 0;
    case 'courier':
      return wd <= 5 && inWindow(wd === 5 ? [9, 13] : COURIER_HOURS, time) ? GUEST_TUNING.COURIER_CHANCE : 0;
    case 'friend':
      return inWindow(FRIEND_HOURS[wd], time) ? GUEST_TUNING.FRIENDS_CHANCE : 0;
  }
}

function arrivalText(party: Identity[], time: GameTime): string {
  const names = party.map((g) => g.name).join(', ');
  switch (party[0].kind) {
    case 'neighbour':
      return `Wizyta: ${names} wpada na kawę ☕`;
    case 'courier':
      return `Wizyta: ${names} przywozi paczkę 📦`;
    case 'friend':
      return time.season === 'winter' ? `Wizyta: znajomi (${names}) przychodzą na wspólny wieczór 🎲` : `Wizyta: znajomi (${names}) przychodzą na grilla 🌭`;
  }
}

function startVisit(world: World, s: GuestState, time: GameTime, kind: GuestKind): void {
  const awake = world.agents.filter((a) => isResident(a) && !isAsleep(world, a));
  if (awake.length === 0) return;
  const pool = POOL.filter((g) => g.kind === kind && available(world, s, g));
  const size = kind === 'friend' ? world.rng.int(2, 3) : 1;
  if (pool.length < Math.min(size, 2) || (kind !== 'friend' && pool.length === 0)) return;
  const party: Identity[] = [];
  while (party.length < size && pool.length > 0) party.push(pool.splice(world.rng.int(0, pool.length - 1), 1)[0]);
  if (s.visits.length + party.length > GUEST_TUNING.MAX_PRESENT) return;
  const target = destination(world, kind, awake);
  const entrance = target && pickEntrance(world, target);
  if (!entrance) return;
  const [lo, hi] = GUEST_TUNING.STAY[kind];
  let stay = world.rng.int(lo, hi);
  if (kind === 'friend') stay = Math.max(45, Math.min(stay, GUEST_TUNING.FRIENDS_HOME_MINUTE - (time.hour * 60 + time.minute)));
  for (const g of party) {
    const agent = createGuest(g, entrance);
    if (kind === 'courier') agent.bubble = { kind: 'speech', text: '📦 Paczka!', ttl: 15, tone: 'positive' };
    world.agents.push(agent);
    s.visits.push({ id: g.id, leaveAt: world.tick + stay, leaving: false, exit: { ...entrance } });
  }
  if (s.day !== time.day) {
    s.day = time.day;
    s.started = 0;
  }
  s.started++;
  pushEvent(world, 'info', arrivalText(party, time), party.map((g) => g.id));
}

function removeGuest(world: World, s: GuestState, v: Visit): void {
  const i = world.agents.findIndex((a) => a.id === v.id);
  if (i >= 0) world.agents.splice(i, 1);
  world.conversations = world.conversations.filter((c) => !c.participants.includes(v.id));
  for (const o of world.objects) o.reservedBy = o.reservedBy.map((r) => (r === v.id ? null : r));
  s.visits = s.visits.filter((x) => x !== v);
  s.lastLeft[v.id] = world.tick;
}

type EndAction = (world: World, agent: Agent, reason?: string) => void;

function beginLeaving(world: World, v: Visit, agent: Agent, endAction: EndAction): void {
  endAction(world, agent, 'wychodzi');
  v.leaving = true;
  const path = findPath(world.grid, agent.pos, v.exit);
  // no way out: simply gone from the next tick
  if (!path) return;
  agent.path = path;
  agent.action = { kind: 'wander', phase: 'walking', ticksLeft: GUEST_TUNING.LEAVE_LIMIT, label: 'Wychodzi', icon: '👋' };
}

/**
 * once per tick, before the agents act: new visits, departures, and steady needs.
 * `endAction` is passed in by world.ts (like for incidents) so this module does not import the action machine.
 */
export function tickGuests(world: World, time: GameTime, endAction: EndAction): void {
  const s = stateOf(world);
  for (const v of [...s.visits]) {
    const agent = world.agents.find((a) => a.id === v.id);
    if (!agent) {
      s.visits = s.visits.filter((x) => x !== v);
      continue;
    }
    if (v.leaving) {
      if ((!agent.action && agent.path.length === 0) || world.tick >= v.leaveAt + GUEST_TUNING.LEAVE_LIMIT) removeGuest(world, s, v);
      continue;
    }
    holdNeeds(agent);
    const chatting = world.conversations.some((c) => c.participants.includes(agent.id));
    // the courier is done as soon as the parcel is handed over
    const delivered = guestKindOf(agent) === 'courier' && agent.stats.conversations > 0 && !chatting;
    if (delivered || (world.tick >= v.leaveAt && (!chatting || world.tick >= v.leaveAt + GUEST_TUNING.CHAT_GRACE))) beginLeaving(world, v, agent, endAction);
  }

  if (!s.enabled) return;
  if (s.day !== time.day) {
    s.day = time.day;
    s.started = 0;
  }
  if (s.started >= GUEST_TUNING.MAX_VISITS_PER_DAY || s.visits.length >= GUEST_TUNING.MAX_PRESENT) return;
  const weather = weatherOf(world).kind;
  for (const kind of ['neighbour', 'courier', 'friend'] as const) {
    const p = arrivalChance(kind, time);
    if (p === 0 || (kind === 'friend' && weather === 'storm')) continue;
    if (world.rng.chance(p)) {
      startVisit(world, s, time, kind);
      break;
    }
  }
}
