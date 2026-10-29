import type { Agent, Conversation, ConversationContext, DialogueLine, GameTime, ObjectDef, ObjectInstance, Vec2, World } from '../types';
import { NEED_KEYS } from '../types';
import { decide, engagement, rememberLeft, hasCriticalNeed, isSleepingObject, rememberTalk, rememberUse, canChat, type Decision } from './brain';
import { onFinishUse, onStartUse, useEffectScale } from './narration';
import { applyEffects } from './needs';
import { findPath, nearestWalkable } from './pathfinding';
import { WALK_SPEED, stepAgent } from './movement';
import { randomWalkableTile } from '../world/grid';
import { slotStandTile, slotUsePos } from '../world/objects';
import { pushEvent } from '../world/events';
import { trace } from '../world/trace';
import { newsFor } from '../world/news';
import { availability } from '../world/incidents';
import { chatAcceptanceChance, conversationDelta, describeConversation, startConversation, type ConversationMood } from '../social/conversation';
import { feltSympathy, recordConversation, recordFriction, statusOf } from '../social/relationships';
import { createProceduralProvider } from '../social/dialogueProvider';
import { onConversationEnd, recallFor } from '../social/memory';
import { goalConversation, goalUseEnd, goalUseTick, updateGoal } from './goals';
import { gatheringOf as gatheringOfAgent, noticeCompetition, onHeadingTo } from './groups';
import { JOINT_CHATTINESS, JOINT_QUIET_BOOST, JOINT_TOPIC, jointGroups, jointMemberOf, noteFishingCast, onJointArrive, onJointHeadingTo, tickJoint } from './joint';

const TALK_EFFECTS = { social: 0.7, fun: 0.12 };
const APPROACH_TIMEOUT = 60;
const MIN_USE_BEFORE_INTERRUPT = 10;
/** "needs satisfied" may end an activity only after this long (no sit-down, stand-up flicker) */
const MIN_USE_BEFORE_SATISFIED = 20;
/** a chat keeps people seated a bit longer so it can finish; past WRAP_UP it heads for a goodbye */
const MAX_CHAT_EXTENSION = 60;
const CHAT_WRAP_UP = 20;
/** don't start an ambient chat with someone about to leave */
const MIN_TICKS_LEFT_FOR_CHAT = 15;
const REPATH_EVERY = 8;
const LINE_TICKS: [number, number] = [11, 15];
const AMBIENT_CHAT_CHANCE = 0.02;
/** ambient chats are this much likelier during a gathering, and per extra free person at the object */
const AMBIENT_GATHERING_FACTOR = 2;
const AMBIENT_PER_EXTRA = 0.5;
/** ambient chat partners must sit at most this far apart (conversations end beyond 3.5) */
const AMBIENT_REACH = 3;
const TALK_DISTANCE = 1.6;
/** waiting behind an agent standing in the way: re-path every BLOCKED_REPATH ticks, walk through after BLOCKED_GIVE_UP */
const BLOCKED_REPATH = 3;
const BLOCKED_GIVE_UP = 12;
/** an unserved need below this interrupts any activity (after MIN_USE_BEFORE_INTERRUPT) */
const DESPERATE = 4;

const fallbackDialogue = createProceduralProvider();
/** conversation ids are per world, so two worlds with the same seed stay identical */
const conversationIds = new WeakMap<World, number>();
function nextConversationId(world: World): number {
  const id = (conversationIds.get(world) ?? 0) + 1;
  conversationIds.set(world, id);
  return id;
}

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
      if (!isSleepingObject(def)) {
        onHeadingTo(world, agent, obj, time);
        // a console, a card table, fishing spots: maybe with friends (joint.ts)
        onJointHeadingTo(world, agent, obj, time, endAction);
      }
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

function describeDecision(world: World, d: Decision): string {
  switch (d.kind) {
    case 'use': {
      const obj = objectByUid(world, d.objectUid);
      return obj ? `${world.objectDefs[obj.type]?.name ?? obj.type}#${obj.uid}` : `obiekt#${d.objectUid}`;
    }
    case 'talk':
      return `rozmowa z ${agentById(world, d.partnerId)?.name ?? d.partnerId}`;
    case 'wander':
      return 'spacer';
    case 'idle':
      return 'bezczynność';
  }
}

/** human-readable current action for the trace */
export function describeAction(world: World, agent: Agent): string {
  const a = agent.action;
  if (!a) return 'nic';
  switch (a.kind) {
    case 'use': {
      const obj = objectByUid(world, a.objectUid);
      const name = obj ? `${world.objectDefs[obj.type]?.name ?? obj.type}#${obj.uid}` : `#${a.objectUid}`;
      return `${a.phase === 'walking' ? 'idzie do' : 'używa'}: ${name} (zostało ${a.ticksLeft} min)`;
    }
    case 'talk':
      return `${a.phase === 'approaching' ? 'podchodzi do' : 'rozmawia z'}: ${agentById(world, a.partnerId)?.name ?? a.partnerId}`;
    case 'wander':
      return 'spacer';
    case 'idle':
      return a.label;
  }
}

function startNext(world: World, agent: Agent, time: GameTime): void {
  noticeCompetition(world, agent, time);
  const failed: Decision[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    let top: Decision[] = [];
    const d = decide(world, agent, time, (c) => failed.some((f) => sameTarget(f, c)), (c) => (top = c));
    const alts = top.filter((c) => c !== d).map((c) => `${describeDecision(world, c)} ${c.score.toFixed(1)}`).join(', ');
    trace(world, agent, 'decide', `${describeDecision(world, d)} ${d.score.toFixed(1)}${alts ? ` | inne: ${alts}` : ''}${failed.length ? ` | po porażce: ${failed.map((f) => describeDecision(world, f)).join(', ')}` : ''}`);
    if (tryStart(world, agent, d, time)) {
      trace(world, agent, 'start', describeAction(world, agent));
      return;
    }
    failed.push(d);
  }
  tryStart(world, agent, { kind: 'idle', score: 0 }, time);
  trace(world, agent, 'start', `${describeAction(world, agent)} (nic innego nie wyszło)`);
}

// ---------------------------------------------------------------- ending actions

/** stops whatever the agent is doing, releasing reservations */
export function endAction(world: World, agent: Agent, reason = 'koniec'): void {
  const a = agent.action;
  if (a) trace(world, agent, 'end', `${describeAction(world, agent)} — ${reason}`);
  if (a?.kind === 'use') {
    const obj = objectByUid(world, a.objectUid);
    if (obj) {
      if (obj.reservedBy[a.slot] === agent.id) obj.reservedBy[a.slot] = null;
      if (a.phase === 'using') {
        const def = world.objectDefs[obj.type];
        agent.pos = slotStandTile(obj, def, a.slot);
        rememberLeft(agent, obj.uid, world.tick);
        if (isSleepingObject(def)) pushEvent(world, 'info', `${agent.name} wstaje z łóżka`, [agent.id]);
        else goalUseEnd(world, agent, obj.type, usedFor.get(agent) ?? 0, a.ticksLeft <= 0);
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
  updateGoal(world, agent, time);
  if (!agent.action) startNext(world, agent, time);
  const a = agent.action!;

  switch (a.kind) {
    case 'use': {
      const obj = objectByUid(world, a.objectUid);
      if (!obj) return endAction(world, agent, 'obiekt zniknął');
      const def = world.objectDefs[obj.type];
      if (a.phase === 'walking') {
        if (walk(world, agent) !== 'moving') {
          a.phase = 'using';
          const together = onJointArrive(world, agent);
          trace(world, agent, 'arrive', together ? `${def.name}#${obj.uid} — ${together}` : `${def.name}#${obj.uid} na ${a.ticksLeft} min`);
          usedFor.set(agent, 0);
          chatExtension.delete(agent);
          if (!together) a.label = def.verb;
          agent.pos = slotUsePos(obj, def, a.slot);
          if (obj.type === 'fishing_spot') noteFishingCast(world, agent, obj);
          agent.stats.objectsUsed++;
          rememberUse(agent, obj.type);
          if (isSleepingObject(def)) pushEvent(world, 'use', `${agent.name} idzie spać`, [agent.id]);
          else onStartUse(world, agent, def, usersOf(world, obj, agent));
        }
        return;
      }
      applyEffects(agent, def.effects, useEffectScale(agent));
      goalUseTick(world, agent, obj);
      a.ticksLeft--;
      const used = (usedFor.get(agent) ?? 0) + 1;
      usedFor.set(agent, used);
      // joint sessions share one end: nobody leaves because their own needs are met
      const joint = jointMemberOf(world, agent);
      let done = a.ticksLeft <= 0 || (!joint && used >= MIN_USE_BEFORE_SATISFIED && satisfied(agent, def));
      // mid-chat at a shared object: stay until the conversation wraps up (within reason)
      if (done && !joint && !isSleepingObject(def) && !hasCriticalNeed(agent) && inAmbientChat(world, agent) && availability(world, obj, def) >= 0.5) {
        const ext = (chatExtension.get(agent) ?? 0) + 1;
        chatExtension.set(agent, ext);
        if (ext <= MAX_CHAT_EXTENSION) {
          a.ticksLeft = Math.max(a.ticksLeft, 1);
          done = false;
          if (ext === CHAT_WRAP_UP) {
            // time to go: the next line is the farewell
            const conv = world.conversations.find((c) => c.participants.includes(agent.id));
            if (conv) conv.maxLines = Math.min(conv.maxLines, conv.lines.length + 1);
          }
        }
      }
      if (done || (used >= MIN_USE_BEFORE_INTERRUPT && interruptedByNeed(agent, def))) {
        endAction(world, agent, a.ticksLeft <= 0 ? 'czas minął' : done ? 'potrzeby zaspokojone' : `przerwane: pilna potrzeba (${worstNeed(agent)})`);
        // a joint session has its own outcomes (catches, wins)
        if (!isSleepingObject(def)) onFinishUse(world, agent, def, done && !joint);
      }
      return;
    }
    case 'talk': {
      const partner = agentById(world, a.partnerId);
      if (!partner) return endAction(world, agent, 'brak partnera');
      if (a.phase === 'talking') {
        applyEffects(agent, TALK_EFFECTS);
        faceTowards(agent, partner.pos);
        if (!world.conversations.some((c) => c.id === a.conversationId)) endAction(world, agent, 'rozmowa skończona');
        return;
      }
      a.ticksLeft--;
      if (a.ticksLeft <= 0) return endAction(world, agent, 'za długo podchodzi');
      if (!canChat(partner, world)) return endAction(world, agent, `${partner.name} zajęty/a: ${describeAction(world, partner)}`);
      if (dist(agent.pos, partner.pos) <= TALK_DISTANCE) return invite(world, agent, partner);
      if (agent.path.length === 0 || a.ticksLeft % REPATH_EVERY === 0) {
        const path = pathToAgent(world, agent, partner);
        if (!path) return endAction(world, agent, 'brak drogi do partnera');
        agent.path = path;
      }
      walk(world, agent);
      return;
    }
    case 'wander':
      a.ticksLeft--;
      if (walk(world, agent) !== 'moving' || a.ticksLeft <= 0) {
        trace(world, agent, 'end', 'spacer — koniec');
        agent.action = null;
        agent.path = [];
      }
      return;
    case 'idle':
      agent.stats.ticksIdle++;
      if (--a.ticksLeft <= 0) {
        trace(world, agent, 'end', `${a.label} — koniec`);
        agent.action = null;
      }
      return;
  }
}

const usedFor = new WeakMap<Agent, number>();
const chatExtension = new WeakMap<Agent, number>();

function inAmbientChat(world: World, agent: Agent): boolean {
  return world.conversations.some((c) => c.participants.includes(agent.id));
}

function worstNeed(agent: Agent): string {
  return NEED_KEYS.reduce((w, k) => (agent.needs[k] < agent.needs[w] ? k : w), NEED_KEYS[0]);
}

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
  const eng = engagement(world, partner);
  trace(world, agent, 'invite', `${partner.name} (sympatia ${Math.round(rel)}), ${partner.name} teraz: ${describeAction(world, partner)}`);
  if (!world.rng.chance(chatAcceptanceChance(partner, agent, rel) * eng.acceptFactor)) {
    trace(world, partner, 'refuse', `zaproszenie od ${agent.name}${eng.busyWith ? ` (zajęcie: ${eng.busyWith})` : ''}`);
    world.relationships.adjust(agent.id, partner.id, eng.busyWith ? 0 : -1);
    if (!eng.busyWith) recordFriction(world, agent.id, partner.id);
    agent.bubble = { kind: 'thought', text: eng.busyWith ? '🙂' : '🙁', ttl: 20 };
    partner.bubble = { kind: 'speech', text: eng.busyWith ? world.rng.pick(BUSY_LINES) : world.rng.pick(NO_MOOD_LINES), ttl: 20, tone: 'neutral' };
    pushEvent(
      world,
      'conversation',
      eng.busyWith
        ? `${partner.name} nie ma teraz czasu dla: ${agent.name} (${eng.busyWith})`
        : `${partner.name} nie ma ochoty na rozmowę z: ${agent.name}`,
      [agent.id, partner.id],
    );
    trace(world, agent, 'end', `podchodzi do: ${partner.name} — odmowa`);
    agent.action = null;
    return;
  }
  trace(world, partner, 'accept', `zaproszenie od ${agent.name}${eng.chatInPlace ? ' (rozmowa na miejscu)' : ''}`);
  // seated at a table/sofa/bench: chat right there, without leaving it
  if (!eng.chatInPlace) endAction(world, partner, `przerwane: zaproszenie od ${agent.name}`);
  const conv = startConversation(nextConversationId(world), agent, partner, world.tick, world.rng, moodOf(world, agent.id, partner.id));
  world.conversations.push(conv);
  trace(world, agent, 'conv-start', `z ${partner.name}, temat: ${conv.topic}, do ${conv.maxLines} kwestii`);
  trace(world, partner, 'conv-start', `z ${agent.name}, temat: ${conv.topic}`);
  for (const [self, other] of eng.chatInPlace ? ([[agent, partner]] as const) : ([[agent, partner], [partner, agent]] as const)) {
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

const BUSY_LINES = ['Może później!', 'Chwilkę, coś kończę…', 'Teraz nie bardzo, sorry!', 'Daj mi skończyć!'];
const NO_MOOD_LINES = ['Nie teraz…', 'Wybacz, nie mam nastroju', 'Innym razem'];

// ---------------------------------------------------------------- conversations

function inThisConversation(world: World, agent: Agent, conv: Conversation): boolean {
  const a = agent.action;
  if (a?.kind === 'talk') return a.conversationId === conv.id;
  // ambient chats happen while both keep using a social object
  if (a?.kind === 'use' && a.phase === 'using') {
    const obj = objectByUid(world, a.objectUid);
    // …and while playing / fishing together
    return (!!obj && !!world.objectDefs[obj.type].social) || !!jointMemberOf(world, agent);
  }
  return false;
}

function say(world: World, conv: Conversation, line: DialogueLine): void {
  conv.lines.push(line);
  conv.pending = false;
  const speaker = agentById(world, line.speakerId);
  if (speaker) speaker.bubble = { kind: 'speech', text: line.text, ttl: LINE_TICKS[1] + 3, tone: line.tone };
}

function endConversation(world: World, conv: Conversation, reason = 'koniec tematu'): void {
  world.conversations = world.conversations.filter((c) => c !== conv);
  const [a, b] = conv.participants.map((id) => agentById(world, id));
  if (!a || !b) return;
  for (const [p, o] of [[a, b], [b, a]] as const) {
    trace(world, p, 'conv-end', `z ${o.name}: ${conv.lines.length}/${conv.maxLines} kwestii — ${reason}`);
  }
  rememberTalk(world, a.id, b.id);
  for (const p of [a, b]) {
    if (p.action?.kind === 'talk' && p.action.conversationId === conv.id) {
      p.action = null;
      p.path = [];
    }
  }
  if (conv.lines.length < 2) return;
  onConversationEnd(world, conv);
  goalConversation(world, a, b);
  a.stats.conversations++;
  b.stats.conversations++;
  const delta = conversationDelta(a, b, conv.lines);
  world.relationships.adjust(a.id, b.id, delta);
  pushEvent(world, 'conversation', describeConversation(a, b, conv, delta), [a.id, b.id]);
  // romance / rivalry and status changes (logged by social/relationships)
  const outcome = recordConversation(world, a.id, b.id, delta, conv.topic);
  const st = statusOf(world, a.id, b.id);
  if (outcome === 'nice' && (st === 'couple' || st === 'crush')) {
    for (const p of [a, b]) p.bubble = { kind: 'thought', text: st === 'couple' ? '💕' : '😊', ttl: 25 };
  }
}

/** how the pair's bond colours a new conversation */
function moodOf(world: World, a: number, b: number): ConversationMood | undefined {
  const st = statusOf(world, a, b);
  if (st === 'couple' || st === 'crush') return 'romantic';
  if (st === 'rivals' || st === 'enemies') return 'tense';
  return undefined;
}

export function tickConversations(world: World, time: GameTime): void {
  for (const conv of [...world.conversations]) {
    const [a, b] = conv.participants.map((id) => agentById(world, id));
    const broken = !a || !b
      ? 'brak uczestnika'
      : conv.lines.length >= conv.maxLines && !conv.pending ? null
      : !inThisConversation(world, a, conv) ? `${a.name} odchodzi: ${describeAction(world, a)}`
      : !inThisConversation(world, b, conv) ? `${b.name} odchodzi: ${describeAction(world, b)}`
      : dist(a.pos, b.pos) > 3.5 ? 'za daleko od siebie'
      : hasCriticalNeed(a) ? `${a.name}: krytyczna potrzeba (${worstNeed(a)})`
      : hasCriticalNeed(b) ? `${b.name}: krytyczna potrzeba (${worstNeed(b)})`
      : null;
    if (broken) {
      endConversation(world, conv, broken);
      continue;
    }
    if (!a || !b) continue;
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
      // couples speak warmer, rivals colder (see feltSympathy)
      relationship: feltSympathy(world, speaker.id, listener.id),
      topic: conv.topic,
      history: conv.lines,
      turn,
      isLast: turn === conv.maxLines - 1,
      time,
      gossip: recallFor(world, speaker, listener),
      news: newsFor(world, speaker),
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

/**
 * agents sharing a social object (table, sofa, bench…) or a gathering (grill party)
 * sometimes start chatting on their own; a big table can hold several chats at once.
 */
export function ambientChats(world: World): void {
  // joint sessions (console, cards, fishing together) run first: they may end or wrap up chats
  tickJoint(world, endAction);
  const busy = new Set(world.conversations.flatMap((c) => c.participants));
  const byObject = new Map<number, Agent[]>();
  const seated: Agent[] = [];
  for (const ag of world.agents) {
    const a = ag.action;
    if (a?.kind !== 'use' || a.phase !== 'using' || busy.has(ag.id) || a.ticksLeft < MIN_TICKS_LEFT_FOR_CHAT) continue;
    const obj = objectByUid(world, a.objectUid);
    if (!obj || !world.objectDefs[obj.type].social) continue;
    // players of a joint session chat as their own group (below), about the game
    if (jointMemberOf(world, ag)) continue;
    byObject.set(obj.uid, [...(byObject.get(obj.uid) ?? []), ag]);
    seated.push(ag);
  }
  const groups: { agents: Agent[]; topic?: string; boost?: number }[] = [...byObject.values()].map((agents) => ({ agents }));
  for (const g of jointGroups(world)) {
    // sociable players chat more; fishing is a quiet affair
    const soc = g.agents.reduce((s, ag) => s + ag.traits.sociability, 0) / g.agents.length;
    groups.push({ agents: g.agents, topic: JOINT_TOPIC[g.kind], boost: JOINT_CHATTINESS[g.kind] * Math.max(0.3, 1 + 0.6 * soc) * (g.quiet ? JOINT_QUIET_BOOST : 1) });
  }
  // neighbouring seats of a gathering (grill + bench) form one group
  const gathered = seated.filter((ag) => gatheringOfAgent(world, ag.id));
  if (gathered.length >= 2) groups.push({ agents: gathered });
  for (const group of groups) {
    const free = group.agents.filter((ag) => !busy.has(ag.id));
    if (free.length < 2) continue;
    const boost = (group.boost ?? (free.some((ag) => gatheringOfAgent(world, ag.id)) ? AMBIENT_GATHERING_FACTOR : 1)) * (1 + AMBIENT_PER_EXTRA * (free.length - 2));
    if (!world.rng.chance(AMBIENT_CHAT_CHANCE * boost)) continue;
    const pairs: [Agent, Agent][] = [];
    const weights: number[] = [];
    for (let i = 0; i < free.length; i++)
      for (let j = i + 1; j < free.length; j++) {
        const x = free[i];
        const y = free[j];
        if (dist(x.pos, y.pos) > AMBIENT_REACH) continue;
        const st = statusOf(world, x.id, y.id);
        pairs.push([x, y]);
        // friends and couples chat up each other; rivals can't help bickering
        weights.push(1 + Math.max(0, world.relationships.get(x.id, y.id)) / 50 + (st === 'couple' ? 2 : st === 'crush' ? 1 : st === 'rivals' || st === 'enemies' ? 0.5 : 0));
      }
    if (pairs.length === 0) continue;
    const [x, y] = pairs[world.rng.weightedIndex(weights)];
    busy.add(x.id);
    busy.add(y.id);
    const conv = startConversation(nextConversationId(world), x, y, world.tick, world.rng, moodOf(world, x.id, y.id));
    // players mostly talk about the game (sometimes about anything)
    if (group.topic && world.rng.chance(0.6)) conv.topic = group.topic;
    world.conversations.push(conv);
    trace(world, x, 'conv-start', `przy okazji z ${y.name}, temat: ${conv.topic}, do ${conv.maxLines} kwestii`);
    trace(world, y, 'conv-start', `przy okazji z ${x.name}, temat: ${conv.topic}`);
  }
}
