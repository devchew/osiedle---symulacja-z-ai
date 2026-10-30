import type { Agent, GameTime, World } from '../types';
import { loadByAgent, registerWorldState, saveByAgent } from '../core/state';
import { timeAt } from '../core/calendar';
import { formatClock } from '../core/time';
import { findPath } from './pathfinding';
import { applyEffects } from './needs';
import { pushEvent } from '../world/events';
import { trace } from '../world/trace';
import { mapIdOf } from '../world/maps';
import { earn, householdOf, pantryCapacity, pantryIsLow, payBills, restock } from './household';

// Work, classes and shopping (issue #8). Some residents leave on workdays (a commute, hours away,
// tired on return); the rest work from home or are retired and keep the house lively. While away an
// agent has `Agent.away`, an idle action with the same label (so every view shows it without
// special cases) and sits on the map-edge tile it left through, hidden by the renderer. A shopping
// trip is a short absence of anyone free when the pantry runs low (agents/household.ts).
// All randomness comes from world.rng; who commutes is a pure function of the seed and agent ids.

export type TripKind = 'work' | 'classes' | 'shop';
export type Commute = Exclude<TripKind, 'shop'>;

export const WORK_TUNING = {
  /** residents who commute, per map (share of the house); the rest stay in or around it all day */
  COMMUTE_SHARE: { dom: 0.34, kamienica: 0.4, jezioro: 0.25, akademik: 0.5 } as Record<string, number>,
  /** what the n-th commuter does (cycled); students in the dormitory, a mix elsewhere */
  KINDS: { dom: ['work', 'classes'], kamienica: ['work', 'classes', 'work'], jezioro: ['work'], akademik: ['classes'] } as Record<string, Commute[]>,
  /** minute of the day to leave, and the length of the absence, [min, max] */
  WORK_LEAVE: [450, 525] as [number, number],
  WORK_LENGTH: [450, 540] as [number, number],
  CLASSES_LEAVE: [480, 630] as [number, number],
  CLASSES_LENGTH: [210, 420] as [number, number],
  /** residents leave once their current activity ends, but at most this long after the planned minute */
  LEAVE_GRACE: 20,
  /** a late resident still goes, up to this many minutes after the planned minute */
  LEAVE_WINDOW: 120,
  /** a sick day, now and then */
  SICK_CHANCE: 0.04,
  /** zł earned per shift / day of classes (a grant); a resident working from home or retired earns HOME_INCOME on workdays */
  WAGE: [60, 90] as [number, number],
  GRANT: [18, 28] as [number, number],
  HOME_INCOME: 25,
  /** shopping: opening hours, trip length, chance per free decision of a resident, energy needed */
  SHOP_HOURS: [9, 20] as [number, number],
  SHOP_LENGTH: [25, 55] as [number, number],
  SHOP_CHANCE: 0.1,
  SHOP_MIN_ENERGY: 20,
  /** coming home from work, with the pantry low, a stop at the shop on the way */
  SHOP_ON_THE_WAY: 0.5,
  /** the exhaustion of a day away: energy lost on return */
  TIRED: { work: 8, classes: 5 } as Record<Commute, number>,
} as const;

/** per-tick need changes while away: lunch, colleagues, something to do */
const AWAY_EFFECTS: Record<TripKind, Partial<Record<keyof Agent['needs'], number>>> = {
  work: { hunger: 0.05, social: 0.07, fun: 0.03 },
  classes: { hunger: 0.04, social: 0.09, fun: 0.02 },
  shop: { fun: 0.05 },
};

const TRIP_ICON: Record<TripKind, string> = { work: '💼', classes: '🎓', shop: '🛒' };
const TRIP_LABEL: Record<TripKind, string> = { work: 'W pracy', classes: 'Na zajęciach', shop: 'W sklepie' };
const LEAVING_LABEL: Record<TripKind, string> = { work: 'Wychodzi do pracy', classes: 'Idzie na zajęcia', shop: 'Idzie do sklepu' };
/** events about commuting have their own channel in the metrics (tests/tools/metrics.ts) */
export const WORK_EVENT_RE = /💼|🎓|🛒|🛍/;

interface WorkState {
  /** GameTime.day this plan is for */
  day: number;
  /** ticks of the planned departure and return; 0 = no commute today */
  leaveAt: number;
  backAt: number;
  /** left home today (the commute is over once back) */
  gone: boolean;
  /** walking to the exit for this kind of trip */
  leaving: TripKind | null;
}

const states = new WeakMap<Agent, WorkState>();

registerWorldState('work', {
  save: (world) => saveByAgent(world, states),
  load: (world, data) => loadByAgent(world, states, data),
  clear: (world) => world.agents.forEach((a) => states.delete(a)),
  optional: true,
});

type EndAction = (world: World, agent: Agent, reason?: string) => void;

// ---------------------------------------------------------------- who commutes

function hash(seed: number, id: number): number {
  let h = (seed ^ 0x9e3779b9) + Math.imul(id + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** what this resident does away from home on workdays; null = works from home / retired */
export function commuteKindOf(world: World, agent: Agent): Commute | null {
  const mapId = mapIdOf(world);
  const share = WORK_TUNING.COMMUTE_SHARE[mapId] ?? 0;
  const n = world.agents.length;
  // always somebody at home
  const count = Math.min(Math.round(n * share), Math.max(0, n - 2));
  if (count === 0) return null;
  const ranked = world.agents.map((a) => ({ id: a.id, h: hash(world.seed, a.id) })).sort((x, y) => x.h - y.h || x.id - y.id);
  const idx = ranked.findIndex((r) => r.id === agent.id);
  const kinds = WORK_TUNING.KINDS[mapId] ?? ['work'];
  return idx >= 0 && idx < count ? kinds[idx % kinds.length] : null;
}

const isWorkday = (t: GameTime): boolean => t.weekday === undefined || t.weekday < 5;

// ---------------------------------------------------------------- plan of the day

function planFor(world: World, time: GameTime, kind: Commute | null): WorkState {
  const s: WorkState = { day: time.day, leaveAt: 0, backAt: 0, gone: false, leaving: null };
  if (!kind || !isWorkday(time)) return s;
  const T = WORK_TUNING;
  const [leave, length] = kind === 'work' ? [T.WORK_LEAVE, T.WORK_LENGTH] : [T.CLASSES_LEAVE, T.CLASSES_LENGTH];
  const rng = world.rng;
  const at = rng.int(leave[0], leave[1]);
  const len = rng.int(length[0], length[1]);
  if (rng.chance(T.SICK_CHANCE)) return s;
  const dayStart = world.tick - (time.hour * 60 + time.minute);
  s.leaveAt = dayStart + at;
  s.backAt = dayStart + at + len;
  return s;
}

function stateOf(world: World, agent: Agent, time: GameTime): WorkState {
  let s = states.get(agent);
  if (!s || s.day !== time.day) {
    s = planFor(world, time, commuteKindOf(world, agent));
    states.set(agent, s);
  }
  return s;
}

// ---------------------------------------------------------------- leaving and coming back

/** the walkable map-edge tile closest to the agent: where residents leave the property */
function exitTile(world: World, agent: Agent): { x: number; y: number } {
  const g = world.grid;
  let best = { x: Math.round(agent.pos.x), y: Math.round(agent.pos.y) };
  let bestD = Infinity;
  const consider = (x: number, y: number): void => {
    if (g.solid[y * g.width + x]) return;
    const d = Math.hypot(x - agent.pos.x, y - agent.pos.y);
    if (d < bestD) {
      bestD = d;
      best = { x, y };
    }
  };
  for (let x = 0; x < g.width; x++) {
    consider(x, 0);
    consider(x, g.height - 1);
  }
  for (let y = 1; y < g.height - 1; y++) {
    consider(0, y);
    consider(g.width - 1, y);
  }
  return best;
}

function startLeaving(world: World, agent: Agent, kind: TripKind, s: WorkState, endAction: EndAction): void {
  endAction(world, agent, LEAVING_LABEL[kind].toLowerCase());
  const exit = exitTile(world, agent);
  const path = findPath(world.grid, agent.pos, exit) ?? [];
  agent.path = path;
  agent.action = { kind: 'wander', phase: 'walking', ticksLeft: path.length * 2 + 10, label: LEAVING_LABEL[kind], icon: TRIP_ICON[kind] };
  s.leaving = kind;
  trace(world, agent, 'start', `${LEAVING_LABEL[kind].toLowerCase()} (${path.length} pól do wyjścia)`);
}

function leave(world: World, agent: Agent, kind: TripKind, s: WorkState, time: GameTime): void {
  const T = WORK_TUNING;
  const rng = world.rng;
  s.leaving = null;
  let until: number;
  if (kind === 'shop') {
    until = world.tick + rng.int(T.SHOP_LENGTH[0], T.SHOP_LENGTH[1]);
    householdOf(world).shopper = agent.id;
  } else {
    s.gone = true;
    until = s.backAt;
  }
  const back = formatClock(timeAt(world, until));
  const label = `${TRIP_LABEL[kind]} (wraca ok. ${back})`;
  agent.away = { kind, label, icon: TRIP_ICON[kind], until };
  agent.path = [];
  agent.bubble = null;
  agent.action = { kind: 'idle', ticksLeft: until - world.tick, label, icon: TRIP_ICON[kind] };
  const text = kind === 'work' ? 'wychodzi do pracy 💼' : kind === 'classes' ? 'idzie na zajęcia 🎓' : 'idzie do sklepu 🛒';
  pushEvent(world, 'info', `${agent.name} ${text}`, [agent.id]);
  trace(world, agent, 'start', `${label}, ${time.hour}:${String(time.minute).padStart(2, '0')}`);
}

function comeBack(world: World, agent: Agent, away: NonNullable<Agent['away']>): void {
  const T = WORK_TUNING;
  const rng = world.rng;
  delete agent.away;
  agent.path = [];
  agent.action = null;
  const kind = away.kind;
  if (kind === 'shop') {
    const h = householdOf(world);
    if (h.shopper === agent.id) h.shopper = null;
    h.trips++;
    const bought = restock(world);
    pushEvent(world, 'info', `${agent.name} wraca ze sklepu z zakupami 🛍️`, [agent.id]);
    trace(world, agent, 'end', `wraca ze sklepu, porcji w zakupach: ${bought}`);
    return;
  }
  const [lo, hi] = kind === 'work' ? T.WAGE : T.GRANT;
  earn(world, rng.int(lo, hi));
  applyEffects(agent, { energy: -T.TIRED[kind] });
  agent.bubble = { kind: 'thought', text: rng.pick(['Uff, wreszcie w domu 🏠', 'Ale dzień… 😮‍💨', 'Czas odpocząć 🛋️']), ttl: 30 };
  pushEvent(world, 'info', `${agent.name} wraca ${kind === 'work' ? 'z pracy 💼' : 'z zajęć 🎓'}`, [agent.id]);
  trace(world, agent, 'end', `wraca ${kind === 'work' ? 'z pracy' : 'z zajęć'}`);
  // a stop at the shop on the way home
  if (kind === 'work' && pantryIsLow(world) && householdOf(world).shopper === null && rng.chance(T.SHOP_ON_THE_WAY)) {
    const h = householdOf(world);
    h.trips++;
    const bought = restock(world);
    pushEvent(world, 'info', `${agent.name} wstępuje do sklepu po drodze 🛍️`, [agent.id]);
    trace(world, agent, 'end', `zakupy po drodze, porcji: ${bought}`);
  }
}

// ---------------------------------------------------------------- per tick

function departureDue(world: World, agent: Agent, s: WorkState, kind: Commute | null): boolean {
  if (!kind || s.gone || s.leaveAt === 0) return false;
  const late = world.tick - s.leaveAt;
  if (late < 0 || late > WORK_TUNING.LEAVE_WINDOW) return false;
  if (agent.needs.energy < 12) return false;
  const a = agent.action;
  if (a?.kind === 'talk') return false;
  return !a || late >= WORK_TUNING.LEAVE_GRACE;
}

function shoppingDue(world: World, agent: Agent, s: WorkState, time: GameTime): boolean {
  const T = WORK_TUNING;
  if (agent.action || time.hour < T.SHOP_HOURS[0] || time.hour >= T.SHOP_HOURS[1]) return false;
  if (agent.needs.energy < T.SHOP_MIN_ENERGY || !pantryIsLow(world) || householdOf(world).shopper !== null) return false;
  // still to go to work today
  if (!s.gone && s.leaveAt > 0 && world.tick < s.backAt) return false;
  return world.rng.chance(T.SHOP_CHANCE);
}

/**
 * called before an agent's own update: starts / ends commutes and shopping trips. Returns true
 * while the agent is away (it then takes no further part in the tick).
 */
export function tickWork(world: World, agent: Agent, time: GameTime, endAction: EndAction): boolean {
  const away = agent.away;
  if (away) {
    if (world.tick >= away.until) {
      comeBack(world, agent, away);
      return false;
    }
    applyEffects(agent, AWAY_EFFECTS[away.kind]);
    agent.action = { kind: 'idle', ticksLeft: away.until - world.tick, label: away.label, icon: away.icon };
    return true;
  }

  const s = stateOf(world, agent, time);
  if (s.leaving) {
    const a = agent.action;
    if (a?.kind === 'wander' && a.icon === TRIP_ICON[s.leaving] && a.label === LEAVING_LABEL[s.leaving]) return false;
    if (!a) {
      leave(world, agent, s.leaving, s, time);
      return true;
    }
    // the walk was replaced (shelter from the rain…): decide again below
    s.leaving = null;
  }

  const kind = commuteKindOf(world, agent);
  if (departureDue(world, agent, s, kind)) {
    startLeaving(world, agent, kind!, s, endAction);
    return false;
  }
  if (shoppingDue(world, agent, s, time)) {
    startLeaving(world, agent, 'shop', s, endAction);
    return false;
  }
  return false;
}

/** once a tick, after the agents: bills at midnight, income of those who work from home or are retired */
export function tickEconomy(world: World, time: GameTime): void {
  const minute = time.hour * 60 + time.minute;
  if (minute === 0) payBills(world);
  if (minute === 17 * 60 && isWorkday(time)) {
    for (const a of world.agents) if (!commuteKindOf(world, a)) earn(world, WORK_TUNING.HOME_INCOME);
  }
}

export function isAway(agent: Agent): boolean {
  return !!agent.away;
}

/** short Polish summary of the household for the UI */
export function householdSummary(world: World): { money: number; stock: number; capacity: number; away: number } {
  const h = householdOf(world);
  return { money: Math.round(h.money), stock: h.stock, capacity: pantryCapacity(world), away: world.agents.filter((a) => a.away).length };
}
