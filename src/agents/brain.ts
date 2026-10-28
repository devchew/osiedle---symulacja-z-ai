import type { Agent, GameTime, NeedKey, ObjectDef, ObjectInstance, World } from '../types';
import { NEED_KEYS } from '../types';
import { slotStandTile } from '../world/objects';
import { bedOf } from './home';
import { urgency } from './needs';
import { chatAcceptanceChance } from '../social/conversation';
import { goalObjectBias, goalTalkBias, type GoalBias } from './goals';

import { availability } from '../world/incidents';

// Utility AI: every candidate activity advertises how much it would reduce the
// agent's "discomfort"; the agent picks one of the best few, weighted by score.

export type Decision =
  | { kind: 'use'; objectUid: number; slot: number; score: number }
  | { kind: 'talk'; partnerId: number; score: number }
  | { kind: 'wander'; score: number }
  | { kind: 'idle'; score: number };

/** discomfort of a need value: 0 when satisfied, 100 when empty, convex */
function discomfort(v: number): number {
  const d = (100 - Math.max(0, Math.min(100, v))) / 10;
  return d * d;
}

/** how much a change of `delta` to need value `v` would relieve discomfort */
function relief(v: number, delta: number): number {
  return discomfort(v) - discomfort(v + delta);
}

/** discomfort added by a cost (delta < 0); unlike relief it keeps growing below 0, so costs never become free */
function costOf(v: number, delta: number): number {
  const d0 = (100 - v) / 10;
  const d1 = (100 - v - delta) / 10;
  return d1 * d1 - d0 * d0;
}

/** distance penalty: score / (1 + tiles / DISTANCE_SCALE) */
const DISTANCE_SCALE = 9;
const TALK_COOLDOWN = 240;
/** need costs (negative effects) are weighed less than gains when choosing */
const COST_WEIGHT = 0.5;
/** meal windows (fractional hours); food looks more attractive inside them */
export const MEAL_WINDOWS: readonly [number, number][] = [
  [7, 9],
  [12, 14],
  [17.5, 19.5],
];
/** at meal time agents feel this much hungrier when scoring food */
const MEAL_HUNGER_BONUS = 25;
/** food between meals is less attractive unless hunger is below this */
const SNACK_HUNGER = 35;
const BETWEEN_MEALS_FACTOR = 0.55;
/** repeating the last activity type / one of the last few is less attractive */
const NOVELTY_LAST = 0.5;
const NOVELTY_RECENT = 0.75;
const RECENT_MEMORY = 3;
/** own bed is strongly preferred; someone else's only when the own one is taken */
const OWN_BED_BONUS = 1.5;
const FOREIGN_BED_FACTOR = 0.35;

/** how strongly personality shapes the choice of activity: score *= 1 + trait * factor */
export const TRAIT_AFFINITY = {
  /** social objects (table, grill, TV, bench) */
  socialPerSociability: 0.6,
  /** quiet / solitary objects (books, fishing, computer, piano) */
  quietPerSociability: -0.55,
  exercisePerActivity: 1.8,
  outdoorPerActivity: 0.3,
  /** couch potatoes like the sofa */
  sofaPerActivity: -0.35,
  hygienePerNeatness: 0.5,
} as const;

/** below this energy a daytime nap is allowed */
const NAP_ENERGY = 28;

export function isSleepingObject(def: ObjectDef | undefined): boolean {
  return !!def?.tags?.includes('sleep');
}

export function averageDuration(def: ObjectDef): number {
  return (def.duration[0] + def.duration[1]) / 2;
}

export function isMealTime(time: GameTime): boolean {
  const h = time.hour + time.minute / 60;
  return MEAL_WINDOWS.some(([a, b]) => h >= a && h < b);
}

/** recently used object types per agent, newest last */
const recentUses = new WeakMap<Agent, string[]>();

export function rememberUse(agent: Agent, type: string): void {
  const list = recentUses.get(agent) ?? [];
  list.push(type);
  if (list.length > RECENT_MEMORY) list.shift();
  recentUses.set(agent, list);
}

function personality(agent: Agent, def: ObjectDef): number {
  const t = agent.traits;
  const tags = def.tags ?? [];
  const A = TRAIT_AFFINITY;
  let m = 1;
  if (def.social) m *= 1 + A.socialPerSociability * t.sociability;
  if (tags.includes('quiet')) m *= 1 + A.quietPerSociability * t.sociability;
  if (tags.includes('exercise')) m *= 1 + A.exercisePerActivity * t.activity;
  if (tags.includes('outdoor')) m *= 1 + A.outdoorPerActivity * t.activity;
  if (tags.includes('sofa')) m *= 1 + A.sofaPerActivity * t.activity;
  if ((def.effects.hygiene ?? 0) > 0) m *= 1 + A.hygienePerNeatness * t.neatness;
  return Math.max(0.05, m);
}

/** some needs matter more when they run low (relief is multiplied by this) */
export const NEED_WEIGHT: Record<NeedKey, number> = {
  hunger: 1.5,
  energy: 1.3,
  fun: 1,
  social: 1.2,
  hygiene: 0.8,
  comfort: 0.7,
};

/** 0..1: how urgent the most pressing need served by the object is; urgent needs make distance matter less */
function servedUrgency(agent: Agent, def: ObjectDef): number {
  let u = 0;
  for (const k of NEED_KEYS) if ((def.effects[k] ?? 0) > 0) u = Math.max(u, urgency(agent.needs[k]) * NEED_WEIGHT[k]);
  return Math.min(1, u);
}

/** 0..1: the agent's most pressing need overall; goal bonuses fade as it grows */
function overallUrgency(agent: Agent): number {
  let u = 0;
  for (const k of NEED_KEYS) u = Math.max(u, urgency(agent.needs[k]) * NEED_WEIGHT[k]);
  return Math.min(1, u);
}

/** applies a daily-goal bias; the additive part only while no need is pressing */
function withGoal(score: number, bias: GoalBias, calm: number): number {
  return bias.add === 0 && bias.mult === 1 ? score : score * bias.mult + bias.add * calm;
}

function scoreObject(agent: Agent, def: ObjectDef, time: GameTime): number {
  const dur = averageDuration(def);
  const tags = def.tags ?? [];
  const food = tags.includes('food');
  const meal = food && isMealTime(time);
  let score = 0;
  for (const k of NEED_KEYS) {
    const e = def.effects[k];
    if (!e) continue;
    let v = agent.needs[k];
    if (k === 'hunger' && meal) v = Math.max(0, v - MEAL_HUNGER_BONUS);
    score += e > 0 ? relief(v, e * dur) * NEED_WEIGHT[k] : -costOf(v, e * dur) * NEED_WEIGHT[k] * COST_WEIGHT;
  }
  if (score <= 0) return 0;

  // personality matters for leisure; an urgent need overrides taste
  score *= 1 + (personality(agent, def) - 1) * (1 - servedUrgency(agent, def));
  if (food && !meal && agent.needs.hunger > SNACK_HUNGER && !tags.includes('snack')) score *= BETWEEN_MEALS_FACTOR;

  const recent = recentUses.get(agent);
  if (recent && recent.length > 0 && !isSleepingObject(def)) {
    if (recent[recent.length - 1] === def.id) score *= NOVELTY_LAST;
    else if (recent.includes(def.id)) score *= NOVELTY_RECENT;
  }

  const h = time.hour;
  if (isSleepingObject(def)) {
    const night = h >= 22 || h < 6;
    const evening = h >= 20 && h < 22;
    if (night) score *= agent.needs.energy < 85 ? 2.5 : 1;
    else if (evening) score *= 1.3;
    // daytime naps only when really tired; otherwise a rested-enough bed beats idling
    else if (agent.needs.energy > NAP_ENERGY) return 0;
    // take care of a pressing need before turning in, unless exhausted
    if (agent.needs.energy > 20 && (agent.needs.hunger < 25 || agent.needs.social < 20 || agent.needs.hygiene < 25)) score *= 0.5;
  } else {
    // the garden is for daytime
    if (tags.includes('outdoor')) {
      if (h >= 21 || h < 6) score *= 0.12;
      else if (h >= 20 || h < 7) score *= 0.5;
    }
    // the night belongs to sleep unless something is urgent
    if (h >= 23 || h < 5) score *= 0.6;
  }
  return score;
}

function freeSlot(obj: ObjectInstance): number {
  return obj.reservedBy.findIndex((r) => r === null);
}

/** below this, hunger or energy make an agent turn down (and end) conversations */
export const CRITICAL_NEED = 10;

export function hasCriticalNeed(agent: Agent): boolean {
  return agent.needs.energy < CRITICAL_NEED || agent.needs.hunger < CRITICAL_NEED;
}

export function canChat(other: Agent, world: World): boolean {
  const a = other.action;
  if (hasCriticalNeed(other)) return false;
  if (!a) return true;
  if (a.kind === 'talk') return false;
  if (a.kind === 'use') {
    const obj = world.objects.find((o) => o.uid === a.objectUid);
    const def = obj && world.objectDefs[obj.type];
    // nobody gets chatted up in bed or in the bathroom
    if (def && (isSleepingObject(def) || def.tags?.includes('hygiene'))) return false;
  }
  return true;
}

/** recent conversation partners: pair key -> tick of the last chat */
const lastTalk = new WeakMap<World, Map<string, number>>();

export function rememberTalk(world: World, a: number, b: number): void {
  let m = lastTalk.get(world);
  if (!m) lastTalk.set(world, (m = new Map()));
  m.set(a < b ? `${a}-${b}` : `${b}-${a}`, world.tick);
}

function talkedRecently(world: World, a: number, b: number): boolean {
  const t = lastTalk.get(world)?.get(a < b ? `${a}-${b}` : `${b}-${a}`);
  return t !== undefined && world.tick - t < TALK_COOLDOWN;
}

export function scoreCandidates(world: World, agent: Agent, time: GameTime): Decision[] {
  const out: Decision[] = [];
  const own = bedOf(agent);
  const ownObj = own === undefined ? undefined : world.objects.find((o) => o.uid === own);
  const ownFree = !!ownObj && (ownObj.reservedBy[0] === null || ownObj.reservedBy[0] === agent.id);
  // urgency 0.35 (need ~35) already halves the goal pull; 0.7+ removes it
  const calm = Math.max(0, 1 - overallUrgency(agent) / 0.7);

  for (const obj of world.objects) {
    const def = world.objectDefs[obj.type];
    if (!def || def.slots.length === 0) continue;
    const slot = freeSlot(obj);
    if (slot < 0) continue;
    let base = scoreObject(agent, def, time) * availability(world, obj, def);
    if (!isSleepingObject(def)) base = withGoal(base, goalObjectBias(world, agent, obj, time), calm);
    if (base <= 0) continue;
    if (isSleepingObject(def) && own !== undefined) {
      if (obj.uid === own) base *= OWN_BED_BONUS;
      else if (ownFree) continue;
      else base *= FOREIGN_BED_FACTOR;
    }
    const stand = slotStandTile(obj, def, slot);
    const dist = Math.hypot(stand.x - agent.pos.x, stand.y - agent.pos.y);
    const reach = DISTANCE_SCALE * (1 + 2 * servedUrgency(agent, def));
    out.push({ kind: 'use', objectUid: obj.uid, slot, score: base / (1 + dist / reach) });
  }

  const socialRelief = NEED_WEIGHT.social * relief(agent.needs.social, 45) + 0.5 * relief(agent.needs.fun, 10);
  const talkReach = DISTANCE_SCALE * (1 + 2 * urgency(agent.needs.social));
  for (const other of world.agents) {
    if (other.id === agent.id || !canChat(other, world) || talkedRecently(world, agent.id, other.id)) continue;
    const rel = world.relationships.get(agent.id, other.id);
    const dist = Math.hypot(other.pos.x - agent.pos.x, other.pos.y - agent.pos.y);
    const busy = other.action?.kind === 'wander' || other.path.length > 0 ? 0.5 : 1;
    // people sense who is in the mood for a chat
    const receptive = 0.3 + chatAcceptanceChance(other, agent, world.relationships.get(other.id, agent.id));
    const appeal = busy * receptive * socialRelief * (1 + rel / 200) * (1 + 0.5 * agent.traits.sociability);
    const score = withGoal(appeal, goalTalkBias(agent, other.id, time), calm) / (1 + dist / talkReach);
    if (score > 0) out.push({ kind: 'talk', partnerId: other.id, score });
  }

  // standing around once is fine; again and again looks broken
  const recent = recentUses.get(agent) ?? [];
  const idled = recent.filter((r) => r === 'idle').length;
  out.push({ kind: 'wander', score: 4 + 3 * agent.traits.activity });
  out.push({ kind: 'idle', score: (2 - agent.traits.activity) * Math.pow(0.35, idled) });
  return out;
}

/** picks among the top candidates, weighted by score², so behaviour is purposeful but not robotic */
export function decide(world: World, agent: Agent, time: GameTime, exclude?: (d: Decision) => boolean): Decision {
  const candidates = scoreCandidates(world, agent, time)
    .filter((d) => !exclude?.(d))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const i = world.rng.weightedIndex(candidates.map((c) => c.score * c.score));
  return candidates[i] ?? { kind: 'idle', score: 0 };
}

export function mostUrgentNeed(agent: Agent): NeedKey {
  let worst: NeedKey = 'hunger';
  for (const k of NEED_KEYS) if (agent.needs[k] < agent.needs[worst]) worst = k;
  return worst;
}
