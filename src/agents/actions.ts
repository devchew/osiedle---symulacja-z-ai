import type { Agent, Conversation, ConversationContext, DialogueLine, GameTime, ObjectDef, ObjectInstance, Vec2, World } from '../types';
import { NEED_KEYS } from '../types';
import { decide, hasCriticalNeed, isSleepingObject, rememberTalk, rememberUse, canChat, type Decision } from './brain';
import { onFinishUse, onStartUse, useEffectScale } from './narration';
import { applyEffects } from './needs';
import { findPath, nearestWalkable } from './pathfinding';
import { WALK_SPEED, stepAgent } from './movement';
import { randomWalkableTile } from '../world/grid';
import { slotStandTile, slotUsePos } from '../world/objects';
import { pushEvent } from '../world/events';
import { conversationDelta, describeConversation, startConversation, willAcceptChat } from '../social/conversation';
import { relationshipLabel } from '../social/relationships';
import { createProceduralProvider } from '../social/dialogueProvider';
import { onConversationEnd, recallFor } from '../social/memory';

const TALK_EFFECTS = { social: 0.7, fun: 0.12 };
const APPROACH_TIMEOUT = 60;
const MIN_USE_BEFORE_INTERRUPT = 10;
const REPATH_EVERY = 8;
const LINE_TICKS: [number, number] = [11, 15];
const AMBIENT_CHAT_CHANCE = 0.02;
const TALK_DISTANCE = 1.6;
/** waiting behind an agent standing in the way: re-path every BLOCKED_REPATH ticks, walk through after BLOCKED_GIVE_UP */
const BLOCKED_REPATH = 3;
const BLOCKED_GIVE_UP = 12;
/** an unserved need below this interrupts any activity (after MIN_USE_BEFORE_INTERRUPT) */
const DESPERATE = 4;

const fallbackDialogue = createProceduralProvider();
let nextConversationId = 1;

export function objectByUid(world: World, uid: number): ObjectInstance | undefined {
  return world.objects.find((o) => o.uid === uid);
}

function agentById(world: World, id: number): Agent | undefined {
  return world.agents.find((a) => a.id === id);
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** path to a tile next to another agent, who may be sitting on solid furniture */
function pathToAgent(world: World, agent: Agent, other: Agent): Vec2[] | null {
  const goal = nearestWalkable(world.grid, other.pos);
  return goal ? findPath(world.grid, agent.pos, goal) : null;
}

function faceTowards(agent: Agent, target: Vec2): void {
  if (Math.abs(target.x - agent.pos.x) > 0.05) agent.facing = target.x < agent.pos.x ? -1 : 1;
}

export function isAgentSleeping(world: World, agent: Agent): boolean {
  const a = agent.action;
  if (a?.kind !== 'use' || a.phase !== 'using') return false;
  const obj = objectByUid(world, a.objectUid);
  return !!obj && isSleepingObject(world.objectDefs[obj.type]);
}

// ---------------------------------------------------------------- starting actions

function tryStart(world: World, agent: Agent, d: Decision, time: GameTime): boolean {
  const rng = world.rng;
  switch (d.kind) {
    case 'use': {
      const obj = objectByUid(world, d.objectUid);
      if (!obj || obj.reservedBy[d.slot] !== null) return false;
      const def = world.objectDefs[obj.type];
      const path = findPath(world.grid, agent.pos, slotStandTile(obj, def, d.slot));
      if (!path) return false;
      obj.reservedBy[d.slot] = agent.id;
      agent.path = path;
      agent.action = {
        kind: 'use',
        phase: 'walking',
        objectUid: obj.uid,
        slot: d.slot,
        ticksLeft: isSleepingObject(def) ? sleepLength(time, rng.int(0, 60)) : rng.int(def.duration[0], def.duration[1]),
        label: `Idzie: ${def.name.toLowerCase()}`,
        icon: def.icon,
      };
      return true;
    }
    case 'talk': {
      const partner = agentById(world, d.partnerId);
      if (!partner) return false;
      const path = pathToAgent(world, agent, partner);
      if (!path) return false;
      agent.path = path;
      agent.action = {
        kind: 'talk',
        phase: 'approaching',
        partnerId: partner.id,
        conversationId: null,
        // enough time to cover the distance (partners may move a bit meanwhile)
        ticksLeft: Math.max(APPROACH_TIMEOUT, Math.ceil((path.length * 1.5) / WALK_SPEED) + 20),
        label: `Idzie pogadać: ${partner.name}`,
        icon: '💬',
      };
      return true;
    }
    case 'wander': {
      const r = 8;
      const area = { x: Math.round(agent.pos.x) - r, y: Math.round(agent.pos.y) - r, w: 2 * r + 1, h: 2 * r + 1 };
      const path = findPath(world.grid, agent.pos, randomWalkableTile(world.grid, rng, area));
      if (!path || path.length === 0) return false;
      agent.path = path;
      agent.action = { kind: 'wander', phase: 'walking', ticksLeft: 80, label: 'Przechadza się', icon: '🚶' };
      return true;
    }
    case 'idle':
      rememberUse(agent, 'idle');
      agent.path = [];
      agent.action = { kind: 'idle', ticksLeft: rng.int(4, 16), label: 'Rozgląda się', icon: '👀' };
      return true;
  }
}

function sameTarget(a: Decision, b: Decision): boolean {
  if (a.kind === 'use' && b.kind === 'use') return a.objectUid === b.objectUid;
  if (a.kind === 'talk' && b.kind === 'talk') return a.partnerId === b.partnerId;
  return a.kind === b.kind;
}

function startNext(world: World, agent: Agent, time: GameTime): void {
  const failed: Decision[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const d = decide(world, agent, time, (c) => failed.some((f) => sameTarget(f, c)));
    if (tryStart(world, agent, d, time)) return;
    failed.push(d);
  }
  tryStart(world, agent, { kind: 'idle', score: 0 }, time);
}

// ---------------------------------------------------------------- ending actions

/** stops whatever the agent is doing, releasing reservations */
export function endAction(world: World, agent: Agent): void {
  const a = agent.action;
  if (a?.kind === 'use') {
    const obj = objectByUid(world, a.objectUid);
    if (obj) {
      if (obj.reservedBy[a.slot] === agent.id) obj.reservedBy[a.slot] = null;
      if (a.phase === 'using') {
        const def = world.objectDefs[obj.type];
        agent.pos = slotStandTile(obj, def, a.slot);
        if (isSleepingObject(def)) pushEvent(world, 'info', `${agent.name} wstaje z łóżka`, [agent.id]);
      }
    }
  }
  agent.action = null;
  agent.path = [];
}

/** night sleep lasts until the morning (06:30 + jitter); daytime sleep is a short nap */
function sleepLength(time: GameTime, jitter: number): number {
  const minuteOfDay = time.hour * 60 + time.minute;
  const wake = 6 * 60 + jitter;
  if (time.hour >= 19) return 24 * 60 - minuteOfDay + wake;
  if (minuteOfDay < wake - 60) return wake - minuteOfDay;
  return 60 + jitter;
}

function satisfied(agent: Agent, def: ObjectDef): boolean {
  // sleep length (until the morning, or a short nap) is decided up front in ticksLeft
  if (isSleepingObject(def)) return false;
  let any = false;
  for (const k of NEED_KEYS) {
    const e = def.effects[k];
    if (e && e > 0) {
      any = true;
      if (agent.needs[k] < 99) return false;
    }
  }
  return any;
}

// ---------------------------------------------------------------- per-tick update

export function updateAgent(world: World, agent: Agent, time: GameTime): void {
  if (!agent.action) startNext(world, agent, time);
  const a = agent.action!;

  switch (a.kind) {
    case 'use': {
      const obj = objectByUid(world, a.objectUid);
      if (!obj) return endAction(world, agent);
      const def = world.objectDefs[obj.type];
      if (a.phase === 'walking') {
        if (walk(world, agent) !== 'moving') {
          a.phase = 'using';
          usedFor.set(agent, 0);
          a.label = def.verb;
          agent.pos = slotUsePos(obj, def, a.slot);
          agent.stats.objectsUsed++;
          rememberUse(agent, obj.type);
          if (isSleepingObject(def)) pushEvent(world, 'use', `${agent.name} idzie spać`, [agent.id]);
          else onStartUse(world, agent, def, usersOf(world, obj, agent));
        }
        return;
      }
      applyEffects(agent, def.effects, useEffectScale(agent));
      a.ticksLeft--;
      const used = (usedFor.get(agent) ?? 0) + 1;
      usedFor.set(agent, used);
      const done = a.ticksLeft <= 0 || satisfied(agent, def);
      if (done || (used >= MIN_USE_BEFORE_INTERRUPT && interruptedByNeed(agent, def))) {
        endAction(world, agent);
        if (!isSleepingObject(def)) onFinishUse(world, agent, def, done);
      }
      return;
    }
    case 'talk': {
      const partner = agentById(world, a.partnerId);
      if (!partner) return endAction(world, agent);
      if (a.phase === 'talking') {
        applyEffects(agent, TALK_EFFECTS);
        faceTowards(agent, partner.pos);
        if (!world.conversations.some((c) => c.id === a.conversationId)) endAction(world, agent);
        return;
      }
      a.ticksLeft--;
      if (a.ticksLeft <= 0 || !canChat(partner, world)) return endAction(world, agent);
      if (dist(agent.pos, partner.pos) <= TALK_DISTANCE) return invite(world, agent, partner);
      if (agent.path.length === 0 || a.ticksLeft % REPATH_EVERY === 0) {
        const path = pathToAgent(world, agent, partner);
        if (!path) return endAction(world, agent);
        agent.path = path;
      }
      walk(world, agent);
      return;
    }
    case 'wander':
      a.ticksLeft--;
      if (walk(world, agent) !== 'moving' || a.ticksLeft <= 0) {
        agent.action = null;
        agent.path = [];
      }
      return;
    case 'idle':
      agent.stats.ticksIdle++;
      if (--a.ticksLeft <= 0) agent.action = null;
      return;
  }
}

const usedFor = new WeakMap<Agent, number>();

function usersOf(world: World, obj: ObjectInstance, self: Agent): Agent[] {
  return world.agents.filter(
    (o) => o !== self && o.action?.kind === 'use' && o.action.objectUid === obj.uid && o.action.phase === 'using',
  );
}

// ---------------------------------------------------------------- walking with avoidance

const blockedFor = new WeakMap<Agent, number>();

/** an agent that is not walking (using, talking, idle) on tile x,y */
function standingAt(world: World, self: Agent, x: number, y: number): boolean {
  for (const o of world.agents) {
    if (o !== self && o.path.length === 0 && Math.round(o.pos.x) === x && Math.round(o.pos.y) === y) return true;
  }
  return false;
}

/**
 * stepAgent, but agents don't walk through someone standing on their next waypoint:
 * they wait, re-path around standing agents every few ticks, and after a timeout
 * walk through anyway (never deadlocks). The final waypoint is never treated as blocked.
 */
function walk(world: World, agent: Agent): 'moving' | 'arrived' | 'idle' {
  const next = agent.path[0];
  if (!next || agent.path.length < 2 || !standingAt(world, agent, next.x, next.y)) {
    blockedFor.delete(agent);
    return stepAgent(agent);
  }
  const n = (blockedFor.get(agent) ?? 0) + 1;
  blockedFor.set(agent, n);
  if (n > BLOCKED_GIVE_UP) return stepAgent(agent);
  if (n % BLOCKED_REPATH === 0) {
    const goal = agent.path[agent.path.length - 1];
    const detour = findPath(world.grid, agent.pos, goal, {
      extraBlocked: (x, y) => !(x === goal.x && y === goal.y) && standingAt(world, agent, x, y),
      maxNodes: 2000,
    });
    if (detour && detour.length > 0 && detour.length <= agent.path.length + 8) {
      agent.path = detour;
      blockedFor.delete(agent);
      return stepAgent(agent);
    }
  }
  if (agent.path.length > 0) faceTowards(agent, next);
  return 'moving';
}

/**
 * a critical need the object doesn't serve cuts the activity short — but only once
 * the needs it does serve are reasonably met, otherwise agents thrash between objects
 */
function interruptedByNeed(agent: Agent, def: ObjectDef): boolean {
  const served = NEED_KEYS.filter((k) => (def.effects[k] ?? 0) > 0);
  const sleeping = isSleepingObject(def);
  // a need about to hit zero wins regardless (sleep is only cut short by hunger)
  // (once the needs this object serves are no longer pressing themselves)
  const desperate = NEED_KEYS.some((k) => !served.includes(k) && agent.needs[k] < DESPERATE && (!sleeping || k === 'hunger'));
  if (desperate && served.every((k) => agent.needs[k] >= 30)) return true;
  if (served.some((k) => agent.needs[k] < 50)) return false;
  const limit = sleeping ? 4 : 10;
  return NEED_KEYS.some((k) => !served.includes(k) && agent.needs[k] < limit && (!sleeping || k === 'hunger'));
}

function invite(world: World, agent: Agent, partner: Agent): void {
  agent.path = [];
  const rel = world.relationships.get(partner.id, agent.id);
  rememberTalk(world, agent.id, partner.id);
  if (!willAcceptChat(partner, agent, rel, world.rng)) {
    world.relationships.adjust(agent.id, partner.id, -1);
    agent.bubble = { kind: 'thought', text: '🙁', ttl: 20 };
    pushEvent(world, 'conversation', `${partner.name} nie ma ochoty na rozmowę z: ${agent.name}`, [agent.id, partner.id]);
    agent.action = null;
    return;
  }
  endAction(world, partner);
  const conv = startConversation(nextConversationId++, agent, partner, world.tick, world.rng);
  world.conversations.push(conv);
  for (const [self, other] of [
    [agent, partner],
    [partner, agent],
  ] as const) {
    self.path = [];
    self.action = {
      kind: 'talk',
      phase: 'talking',
      partnerId: other.id,
      conversationId: conv.id,
      ticksLeft: 0,
      label: `Rozmawia: ${other.name}`,
      icon: '💬',
    };
    faceTowards(self, other.pos);
  }
}

// ---------------------------------------------------------------- conversations

function inThisConversation(world: World, agent: Agent, conv: Conversation): boolean {
  const a = agent.action;
  if (a?.kind === 'talk') return a.conversationId === conv.id;
  // ambient chats happen while both keep using a social object
  if (a?.kind === 'use' && a.phase === 'using') {
    const obj = objectByUid(world, a.objectUid);
    return !!obj && !!world.objectDefs[obj.type].social;
  }
  return false;
}

function say(world: World, conv: Conversation, line: DialogueLine): void {
  conv.lines.push(line);
  conv.pending = false;
  const speaker = agentById(world, line.speakerId);
  if (speaker) speaker.bubble = { kind: 'speech', text: line.text, ttl: LINE_TICKS[1] + 3, tone: line.tone };
}

function endConversation(world: World, conv: Conversation): void {
  world.conversations = world.conversations.filter((c) => c !== conv);
  const [a, b] = conv.participants.map((id) => agentById(world, id));
  if (!a || !b) return;
  rememberTalk(world, a.id, b.id);
  for (const p of [a, b]) {
    if (p.action?.kind === 'talk' && p.action.conversationId === conv.id) {
      p.action = null;
      p.path = [];
    }
  }
  if (conv.lines.length < 2) return;
  onConversationEnd(world, conv);
  a.stats.conversations++;
  b.stats.conversations++;
  const before = world.relationships.get(a.id, b.id);
  const delta = conversationDelta(a, b, conv.lines);
  const after = world.relationships.adjust(a.id, b.id, delta);
  pushEvent(world, 'conversation', describeConversation(a, b, conv, delta), [a.id, b.id]);
  const label = relationshipLabel(after);
  if (label !== relationshipLabel(before)) {
    pushEvent(world, 'relationship', `${a.name} i ${b.name} — teraz: ${label}`, [a.id, b.id]);
  }
}

export function tickConversations(world: World, time: GameTime): void {
  for (const conv of [...world.conversations]) {
    const [a, b] = conv.participants.map((id) => agentById(world, id));
    if (
      !a || !b ||
      !inThisConversation(world, a, conv) || !inThisConversation(world, b, conv) ||
      dist(a.pos, b.pos) > 3.5 ||
      hasCriticalNeed(a) || hasCriticalNeed(b)
    ) {
      endConversation(world, conv);
      continue;
    }
    if (conv.pending || --conv.nextLineIn > 0) continue;
    if (conv.lines.length >= conv.maxLines) {
      endConversation(world, conv);
      continue;
    }
    const turn = conv.lines.length;
    const speaker = turn % 2 === 0 ? a : b;
    const listener = speaker === a ? b : a;
    const ctx: ConversationContext = {
      speaker,
      listener,
      relationship: world.relationships.get(speaker.id, listener.id),
      topic: conv.topic,
      history: conv.lines,
      turn,
      isLast: turn === conv.maxLines - 1,
      time,
      gossip: recallFor(world, speaker, listener),
    };
    conv.nextLineIn = world.rng.int(LINE_TICKS[0], LINE_TICKS[1]);
    const result = world.dialogue.nextLine(ctx, world.rng);
    if (result instanceof Promise) {
      conv.pending = true;
      speaker.bubble = { kind: 'thought', text: '…', ttl: 200 };
      result
        .then((line) => say(world, conv, line))
        .catch(() => say(world, conv, fallbackDialogue.nextLine(ctx, world.rng) as DialogueLine));
    } else {
      say(world, conv, result);
    }
  }
}

/** agents sharing a social object (table, sofa, bench…) sometimes start chatting on their own */
export function ambientChats(world: World): void {
  const busy = new Set(world.conversations.flatMap((c) => c.participants));
  const byObject = new Map<number, Agent[]>();
  for (const ag of world.agents) {
    const a = ag.action;
    if (a?.kind !== 'use' || a.phase !== 'using' || busy.has(ag.id)) continue;
    const obj = objectByUid(world, a.objectUid);
    if (!obj || !world.objectDefs[obj.type].social) continue;
    byObject.set(obj.uid, [...(byObject.get(obj.uid) ?? []), ag]);
  }
  for (const group of byObject.values()) {
    if (group.length < 2 || !world.rng.chance(AMBIENT_CHAT_CHANCE)) continue;
    const [x, y] = group;
    world.conversations.push(startConversation(nextConversationId++, x, y, world.tick, world.rng));
  }
}
