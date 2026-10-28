import type { Agent, GameTime, NeedKey, ObjectDef, ObjectInstance, World } from '../types';
import { NEED_KEYS } from '../types';
import { slotStandTile } from '../world/objects';

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

const DISTANCE_SCALE = 20;
const TALK_COOLDOWN = 240;

export function isSleepingObject(def: ObjectDef | undefined): boolean {
  return !!def?.tags?.includes('sleep');
}

export function averageDuration(def: ObjectDef): number {
  return (def.duration[0] + def.duration[1]) / 2;
}

function scoreObject(agent: Agent, def: ObjectDef, time: GameTime): number {
  const dur = averageDuration(def);
  let score = 0;
  for (const k of NEED_KEYS) {
    const e = def.effects[k];
    if (!e) continue;
    score += relief(agent.needs[k], e * dur);
  }
  if (score <= 0) return 0;

  const t = agent.traits;
  const tags = def.tags ?? [];
  if (def.social) score *= 1 + 0.25 * t.sociability;
  if (tags.includes('outdoor')) score *= 1 + 0.2 * t.activity;
  if (def.effects.energy !== undefined && def.effects.energy < 0) score *= 1 + 0.3 * t.activity;
  if (def.effects.hygiene !== undefined && def.effects.hygiene > 0) score *= 1 + 0.25 * t.neatness;

  if (isSleepingObject(def)) {
    const night = time.hour >= 22 || time.hour < 6;
    const evening = time.hour >= 20 && time.hour < 22;
    if (night) score *= agent.needs.energy < 85 ? 2.5 : 1;
    else if (evening) score *= 1.3;
    else if (agent.needs.energy > 25) score *= 0.15;
  } else if (time.hour >= 23 || time.hour < 5) {
    // the night belongs to sleep unless something is urgent
    score *= 0.6;
  }
  return score;
}

function freeSlot(obj: ObjectInstance): number {
  return obj.reservedBy.findIndex((r) => r === null);
}

export function canChat(other: Agent, world: World): boolean {
  const a = other.action;
  if (!a) return true;
  if (a.kind === 'talk') return false;
  if (a.kind === 'use') {
    const obj = world.objects.find((o) => o.uid === a.objectUid);
    if (obj && isSleepingObject(world.objectDefs[obj.type])) return false;
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

  for (const obj of world.objects) {
    const def = world.objectDefs[obj.type];
    if (!def || def.slots.length === 0) continue;
    const slot = freeSlot(obj);
    if (slot < 0) continue;
    const base = scoreObject(agent, def, time);
    if (base <= 0) continue;
    const stand = slotStandTile(obj, def, slot);
    const dist = Math.hypot(stand.x - agent.pos.x, stand.y - agent.pos.y);
    out.push({ kind: 'use', objectUid: obj.uid, slot, score: base / (1 + dist / DISTANCE_SCALE) });
  }

  const socialRelief = relief(agent.needs.social, 45) + 0.5 * relief(agent.needs.fun, 10);
  for (const other of world.agents) {
    if (other.id === agent.id || !canChat(other, world) || talkedRecently(world, agent.id, other.id)) continue;
    const rel = world.relationships.get(agent.id, other.id);
    const dist = Math.hypot(other.pos.x - agent.pos.x, other.pos.y - agent.pos.y);
    const busy = other.action?.kind === 'wander' || other.path.length > 0 ? 0.5 : 1;
    const score = (busy * socialRelief * (1 + rel / 200) * (1 + 0.35 * agent.traits.sociability)) / (1 + dist / DISTANCE_SCALE);
    if (score > 0) out.push({ kind: 'talk', partnerId: other.id, score });
  }

  out.push({ kind: 'wander', score: 4 + 3 * agent.traits.activity });
  out.push({ kind: 'idle', score: 2 - agent.traits.activity });
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
