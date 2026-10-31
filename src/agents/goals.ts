import type { Agent, GameTime, Gossip, ObjectInstance, Traits, World } from '../types';
import { START_MINUTE } from '../core/time';
import { loadByAgent, registerWorldState, saveByAgent, type Json } from '../core/state';
import { pushEvent } from '../world/events';
import { isGuest } from './role';

// Daily goals: every morning at 06:00 each resident picks a goal for the day,
// weighted by personality. The goal nudges choices in brain.ts (a bonus for the
// objects / partners that advance it) and is completed from what the agent
// actually does (hooks called from actions.ts). Unfinished goals expire at 22:00.
// State lives in a WeakMap keyed by the agent (the Agent contract is unchanged).

export type GoalKind =
  | 'cook'
  | 'exercise'
  | 'fish'
  | 'read'
  | 'piano'
  | 'computer'
  | 'friend'
  | 'reconcile'
  | 'grill'
  | 'garden'
  | 'rest'
  | 'meet'
  | 'movies';

/** what the UI may read about an agent's goal of the day */
export interface DailyGoal {
  kind: GoalKind;
  /** Polish label, e.g. "Złowić rybę" (talk goals include the partner's name) */
  label: string;
  icon: string;
  /** 0..1 */
  progress: number;
  /** e.g. "1/2", "✓"; empty for single-step goals in progress */
  progressText: string;
  done: boolean;
  /** the day ended (22:00) before the goal was reached */
  expired: boolean;
  partnerId?: number;
}

type PartnerRule = 'best' | 'worst' | 'stranger';

interface GoalDef {
  label: string;
  icon: string;
  /** each step is satisfied by one session on any of the listed object types (order free) */
  steps?: string[][];
  /** a session counts after this many ticks of use (or when it runs its full length) */
  minTicks?: number;
  /** the session only counts with someone else using the same object */
  withCompany?: boolean;
  /** goal = a conversation with this person */
  partner?: PartnerRule;
  /** phrase for the log: "Ola: cel dnia wykonany — <done>" */
  done: string;
  /** weight of picking this goal, given personality */
  weight(t: Traits): number;
  gossip?(agent: Agent, partner: Agent | undefined): Gossip;
  /** food goals are only pushed around meal times (keeps the meal rhythm) */
  food?: boolean;
}

const f = (v: number): number => Math.max(0.1, v);
const EXERCISE = ['exercise_bike', 'treadmill'];
const LOUNGE = ['tv', 'bench'];

export const GOALS: Record<GoalKind, GoalDef> = {
  cook: {
    label: 'Ugotować coś dobrego', icon: '🍳', steps: [['stove']], minTicks: 25, food: true,
    done: 'ugotowany pyszny obiad 🍳',
    weight: (t) => f(1 + 0.4 * t.neatness) * f(1 + 0.2 * t.sociability),
    gossip: (a) => ({ text: `${a.name} gotuje pyszny obiad`, aboutIds: [a.id], valence: 0.5 }),
  },
  exercise: {
    label: 'Poćwiczyć', icon: '🏋️', steps: [EXERCISE, EXERCISE], minTicks: 20,
    done: 'dwa treningi zaliczone 🏅',
    weight: (t) => f(1 + 1.2 * t.activity),
    gossip: (a) => ({ text: `${a.name} trenuje jak zawodowiec`, aboutIds: [a.id], valence: 0.3 }),
  },
  fish: {
    label: 'Złowić rybę', icon: '🎣', steps: [['fishing_spot']], minTicks: 40,
    done: 'złowiona ryba 🎣',
    weight: (t) => f(1 - 0.8 * t.sociability) * f(1 + 0.2 * t.activity),
    gossip: (a) => ({ text: `${a.name} łowi wielką rybę`, aboutIds: [a.id], valence: 0.6 }),
  },
  read: {
    label: 'Poczytać', icon: '📖', steps: [['bookshelf']], minTicks: 30,
    done: 'rozdział przeczytany 📖',
    weight: (t) => f(1 - 0.8 * t.sociability) * f(1 - 0.3 * t.activity),
  },
  piano: {
    label: 'Pograć na pianinie', icon: '🎹', steps: [['piano']], minTicks: 25,
    done: 'koncert na pianinie 🎹',
    weight: (t) => 0.8 * f(1 - 0.7 * t.sociability),
    gossip: (a) => ({ text: `${a.name} pięknie gra na pianinie`, aboutIds: [a.id], valence: 0.4 }),
  },
  computer: {
    label: 'Pograć na komputerze', icon: '🎮', steps: [['computer']], minTicks: 30,
    done: 'partia rozegrana 🎮',
    weight: (t) => 0.7 * f(1 - 0.7 * t.sociability) * f(1 - 0.2 * t.activity),
  },
  friend: {
    label: 'Spotkać się z przyjacielem', icon: '🤗', partner: 'best',
    done: 'pogawędka z przyjacielem 🤗',
    weight: (t) => f(1 + 0.8 * t.sociability),
  },
  reconcile: {
    label: 'Pogodzić się', icon: '🕊️', partner: 'worst',
    done: 'rozmowa na zgodę 🕊️',
    weight: (t) => 1.2 * f(1 + 0.4 * t.cheerfulness) * f(1 + 0.3 * t.sociability),
    gossip: (a, p) => ({ text: `${a.name} i ${p?.name ?? 'ktoś'} zakopują topór wojenny`, aboutIds: p ? [a.id, p.id] : [a.id], valence: 0.5 }),
  },
  grill: {
    label: 'Zrobić grilla ze znajomymi', icon: '🌭', steps: [['grill']], minTicks: 15, withCompany: true, food: true,
    done: 'grill ze znajomymi 🌭',
    weight: (t) => 0.9 * f(1 + 0.8 * t.sociability) * f(1 + 0.3 * t.activity),
    gossip: (a) => ({ text: `${a.name} urządza grilla dla wszystkich`, aboutIds: [a.id], valence: 0.6 }),
  },
  garden: {
    label: 'Zadbać o ogród', icon: '🌷', steps: [['flowerbed']], minTicks: 25,
    done: 'grządka zadbana 🌷',
    weight: (t) => 0.9 * f(1 + 0.5 * t.neatness) * f(1 - 0.5 * t.sociability),
    gossip: (a) => ({ text: `${a.name} ma najpiękniejsze kwiaty w okolicy`, aboutIds: [a.id], valence: 0.4 }),
  },
  rest: {
    label: 'Odpocząć', icon: '🛁', steps: [['bathtub'], LOUNGE], minTicks: 20,
    done: 'kąpiel i odpoczynek 🛁',
    weight: (t) => f(1 - 0.8 * t.activity),
  },
  meet: {
    label: 'Poznać kogoś lepiej', icon: '🤝', partner: 'stranger',
    done: 'nowa znajomość 🤝',
    weight: (t) => 0.9 * f(1 + 0.9 * t.sociability),
  },
  movies: {
    label: 'Maraton filmowy', icon: '🍿', steps: [['tv'], ['tv']], minTicks: 25,
    done: 'maraton filmowy 🍿',
    weight: (t) => 0.9 * f(1 - 0.6 * t.activity) * f(1 + 0.3 * t.sociability),
    gossip: (a) => ({ text: `${a.name} urządza maraton filmowy`, aboutIds: [a.id], valence: 0.2 }),
  },
};

export const GOAL_KINDS = Object.keys(GOALS) as GoalKind[];
/** solitary goals (used by the soak test to check personality shows in the choice) */
export const QUIET_GOALS: readonly GoalKind[] = ['fish', 'read', 'piano', 'computer', 'garden'];

/** goals are picked at 06:00 and expire at 22:00 */
export const GOAL_START_HOUR = 6;
export const GOAL_END_HOUR = 22;
/** a repeat of yesterday's goal is this much less likely */
const REPEAT_FACTOR = 0.25;
/** reconciling needs someone the agent actually dislikes */
const RECONCILE_BELOW = -5;
/** reward on completion (mood follows needs) and a small dip when the day ends without it */
const DONE_BUMP = { fun: 14, comfort: 6 };
const EXPIRED_FUN = -4;

interface GoalState {
  kind: GoalKind;
  /** goal day index, see goalDayOf */
  day: number;
  /** steps completed (index = step) */
  stepsDone: boolean[];
  partnerId?: number;
  done: boolean;
  expired: boolean;
  /** someone else used the same object during the current session (withCompany goals) */
  company: boolean;
}

export interface GoalRecord {
  day: number;
  kind: GoalKind;
  done: boolean;
  /** goal was still running (not yet expired) when history was read */
  open: boolean;
}

const state = new WeakMap<Agent, GoalState>();
const history = new WeakMap<Agent, GoalRecord[]>();

registerWorldState('goals', {
  save: (world) => {
    const s = saveByAgent(world, state);
    const h = saveByAgent(world, history);
    return s || h ? { state: s, history: h } : null;
  },
  load: (world, data) => {
    const d = data as { state: Json; history: Json };
    if (d.state) loadByAgent(world, state, d.state);
    if (d.history) loadByAgent(world, history, d.history);
  },
  clear: (world) => {
    for (const a of world.agents) {
      state.delete(a);
      history.delete(a);
    }
  },
});

/** goal days start at 06:00 */
export function goalDayOf(tick: number): number {
  return Math.floor((tick + START_MINUTE - GOAL_START_HOUR * 60) / (24 * 60));
}

function isGoalTime(time: GameTime): boolean {
  return time.hour >= GOAL_START_HOUR && time.hour < GOAL_END_HOUR;
}

function partnerFor(world: World, agent: Agent, rule: PartnerRule): number | undefined {
  let best: { id: number; key: number } | undefined;
  for (const o of world.agents) {
    if (o.id === agent.id || isGuest(o)) continue;
    const rel = world.relationships.get(agent.id, o.id);
    const key = rule === 'best' ? rel : rule === 'worst' ? -rel : -Math.abs(rel);
    if (!best || key > best.key) best = { id: o.id, key };
  }
  if (!best) return undefined;
  if (rule === 'worst' && -best.key >= RECONCILE_BELOW) return undefined;
  return best.id;
}

function pick(world: World, agent: Agent, day: number): GoalState {
  const prev = state.get(agent)?.kind;
  const options: { kind: GoalKind; partnerId?: number; w: number }[] = [];
  for (const kind of GOAL_KINDS) {
    const def = GOALS[kind];
    let partnerId: number | undefined;
    if (def.partner) {
      partnerId = partnerFor(world, agent, def.partner);
      if (partnerId === undefined) continue;
    }
    options.push({ kind, partnerId, w: def.weight(agent.traits) * (kind === prev ? REPEAT_FACTOR : 1) });
  }
  const o = options[world.rng.weightedIndex(options.map((x) => x.w))];
  const def = GOALS[o.kind];
  return {
    kind: o.kind,
    day,
    stepsDone: (def.steps ?? [[]]).map(() => false),
    partnerId: o.partnerId,
    done: false,
    expired: false,
    company: false,
  };
}

function record(agent: Agent, s: GoalState): void {
  const list = history.get(agent) ?? [];
  const last = list[list.length - 1];
  const rec = { day: s.day, kind: s.kind, done: s.done, open: !s.done && !s.expired };
  if (last && last.day === s.day) list[list.length - 1] = rec;
  else list.push(rec);
  history.set(agent, list);
}

function bump(agent: Agent, delta: Partial<Record<'fun' | 'comfort', number>>): void {
  for (const [k, v] of Object.entries(delta) as ['fun' | 'comfort', number][]) agent.needs[k] = Math.max(0, Math.min(100, agent.needs[k] + v));
}

/** picks a new goal at the start of every goal day and expires unfinished ones at night; call once per tick */
export function updateGoal(world: World, agent: Agent, time: GameTime): void {
  if (isGuest(agent)) return;
  const day = goalDayOf(time.tick);
  let s = state.get(agent);
  if (!s || s.day !== day) {
    s = pick(world, agent, day);
    state.set(agent, s);
    record(agent, s);
    return;
  }
  if (!s.done && !s.expired && !isGoalTime(time)) {
    s.expired = true;
    bump(agent, { fun: EXPIRED_FUN });
    record(agent, s);
  }
}

function active(agent: Agent): GoalState | undefined {
  const s = state.get(agent);
  return s && !s.done && !s.expired ? s : undefined;
}

function complete(world: World, agent: Agent, s: GoalState): void {
  s.done = true;
  record(agent, s);
  const def = GOALS[s.kind];
  bump(agent, DONE_BUMP);
  agent.bubble = { kind: 'thought', text: `✨${def.icon}`, ttl: 30 };
  const partner = world.agents.find((a) => a.id === s.partnerId);
  const ids = partner ? [agent.id, partner.id] : [agent.id];
  pushEvent(world, 'mood', `${agent.name}: cel dnia wykonany — ${def.done}`, ids, def.gossip?.(agent, partner));
}

/** called every tick while the agent uses an object: notices company for "with friends" goals */
export function goalUseTick(world: World, agent: Agent, obj: ObjectInstance): void {
  const s = active(agent);
  if (!s || s.company || !GOALS[s.kind].withCompany || !GOALS[s.kind].steps?.some((st) => st.includes(obj.type))) return;
  s.company = world.agents.some(
    (o) => o !== agent && o.action?.kind === 'use' && o.action.objectUid === obj.uid && o.action.phase === 'using',
  );
}

/** called when a session on an object ends; `ticks` = how long it was used, `completed` = full planned length */
export function goalUseEnd(world: World, agent: Agent, type: string, ticks: number, completed: boolean): void {
  const s = active(agent);
  const company = s?.company ?? false;
  if (s) s.company = false;
  if (!s) return;
  const def = GOALS[s.kind];
  if (!def.steps || (ticks < (def.minTicks ?? 0) && !completed)) return;
  if (def.withCompany && !company) return;
  const i = def.steps.findIndex((st, idx) => !s.stepsDone[idx] && st.includes(type));
  if (i < 0) return;
  s.stepsDone[i] = true;
  if (s.stepsDone.every(Boolean)) complete(world, agent, s);
}

/** called when a real conversation (≥ 2 lines) between a and b ends */
export function goalConversation(world: World, a: Agent, b: Agent): void {
  for (const [self, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const s = active(self);
    if (s && GOALS[s.kind].partner && s.partnerId === other.id) complete(world, self, s);
  }
}

/** remaining step object types of the agent's active goal (empty when none) */
function wantedTypes(s: GoalState): string[] {
  const steps = GOALS[s.kind].steps;
  if (!steps) return [];
  return steps.flatMap((st, i) => (s.stepsDone[i] ? [] : st));
}

/** score bonus from goals for using an object: score' = score * mult + add */
export interface GoalBias {
  mult: number;
  add: number;
}

const NO_BIAS: GoalBias = { mult: 1, add: 0 };
/** strong enough to show, weak enough that urgent needs still win (add is scaled down by urgency in brain) */
export const GOAL_BIAS: GoalBias = { mult: 1.8, add: 9 };
/** others are drawn to a grill where someone with the grill goal is cooking */
export const JOIN_BIAS: GoalBias = { mult: 1.5, add: 6 };
export const TALK_BIAS: GoalBias = { mult: 2, add: 14 };
/** extra pull of the remaining steps once a multi-step goal is under way */
const HALF_DONE_FACTOR = 1.6;
/** goals push only during daytime activity hours */
const BIAS_HOURS: [number, number] = [7, 21];

function biasHours(time: GameTime): boolean {
  return time.hour >= BIAS_HOURS[0] && time.hour < BIAS_HOURS[1];
}

/** food goals (cooking, grilling) only around lunch and dinner, so meals stay on schedule */
function foodHours(time: GameTime): boolean {
  const h = time.hour + time.minute / 60;
  return (h >= 11.5 && h < 14) || (h >= 17 && h < 19.5);
}

/** the pull of an unfinished goal grows through the afternoon (×1 until 14:00, ×1.6 from 20:00) */
function late(bias: GoalBias, time: GameTime): GoalBias {
  const k = 1 + 0.6 * Math.min(1, Math.max(0, (time.hour + time.minute / 60 - 14) / 6));
  return k === 1 ? bias : { mult: bias.mult, add: bias.add * k };
}

export function goalObjectBias(world: World, agent: Agent, obj: ObjectInstance, time: GameTime): GoalBias {
  if (!biasHours(time)) return NO_BIAS;
  const s = active(agent);
  if (s && wantedTypes(s).includes(obj.type)) {
    if (GOALS[s.kind].food && !foodHours(time)) return NO_BIAS;
    // half-way there: finishing it is even more tempting
    const half = s.stepsDone.some(Boolean) ? HALF_DONE_FACTOR : 1;
    const b = late(GOAL_BIAS, time);
    return { mult: b.mult, add: b.add * half };
  }
  if (obj.type === 'grill' && foodHours(time)) {
    // join someone who wants company at this grill
    for (const o of world.agents) {
      if (o === agent || o.action?.kind !== 'use' || o.action.objectUid !== obj.uid) continue;
      const g = active(o);
      if (g && GOALS[g.kind].withCompany) return JOIN_BIAS;
    }
  }
  return NO_BIAS;
}

export function goalTalkBias(agent: Agent, partnerId: number, time: GameTime): GoalBias {
  if (!biasHours(time)) return NO_BIAS;
  const s = active(agent);
  return s && GOALS[s.kind].partner && s.partnerId === partnerId ? late(TALK_BIAS, time) : NO_BIAS;
}

/** the agent's goal of the day, for the UI */
export function goalOf(agent: Agent, world?: World): DailyGoal | undefined {
  const s = state.get(agent);
  if (!s) return undefined;
  const def = GOALS[s.kind];
  const total = def.steps ? s.stepsDone.length : 1;
  const n = s.done ? total : def.steps ? s.stepsDone.filter(Boolean).length : 0;
  const partner = world?.agents.find((a) => a.id === s.partnerId);
  return {
    kind: s.kind,
    label: partner ? `${def.label} · ${partner.name}` : def.label,
    icon: def.icon,
    progress: n / total,
    progressText: s.done ? '✓' : s.expired ? '—' : total > 1 ? `${n}/${total}` : '',
    done: s.done,
    expired: s.expired,
    partnerId: s.partnerId,
  };
}

/** all goals the agent has had, oldest first */
export function goalHistory(agent: Agent): readonly GoalRecord[] {
  return history.get(agent) ?? [];
}
