import type { Agent, Conversation, Gossip, SimEvent, World } from '../types';
import { pushEvent } from '../world/events';
import { conversationDelta } from './conversation';

// Residents' memories and gossip.
//
// A *story* is a retellable Gossip, identified by its text (the same thing
// happening twice refreshes the story instead of duplicating it). Agents hold
// *memories* of stories: the subjects and nearby witnesses live through them
// (source "lived"), others hear about them in conversations (source "heard").
// Memory strength halves every couple of game days; weak memories are forgotten
// and each agent keeps only the strongest few.

/** agents this close (tiles) to the subject when something happens witness it */
export const WITNESS_RADIUS = 6;
/** memories kept per agent */
export const MEMORY_CAP = 12;
/** memories weaker than this are forgotten */
export const FORGET_BELOW = 0.1;
/** half-life of a memory in ticks (game minutes) */
export const HALF_LIFE_LIVED = 2.5 * 24 * 60;
export const HALF_LIFE_HEARD = 1.5 * 24 * 60;
/** a retold story is remembered this much weaker than the teller remembers it */
export const RETELL_FACTOR = 0.75;
/** max stories returned by recallFor */
export const RECALL_MAX = 3;
/** a shared moment can be reminisced about only after this many ticks */
const SHARED_MIN_AGE = 90;
/** conversation outcome thresholds (conversationDelta) that make a story */
const QUARREL_AT = -4.5;
const HEARTFELT_AT = 6;
/** gossip log lines: at most one per this many ticks, with this probability */
const LOG_COOLDOWN = 150;
const LOG_CHANCE = 0.35;
const PRUNE_EVERY = 60;

export type MemorySource = 'lived' | 'heard';

interface Story {
  gossip: Gossip;
  /** same story marked as a shared memory (returned by recall for "Pamiętasz, jak …?") */
  sharedGossip: Gossip;
  /** last time it happened */
  tick: number;
}

interface Memory {
  story: Story;
  /** strength at `tick` (0..1) */
  strength: number;
  /** when formed or last reinforced */
  tick: number;
  source: MemorySource;
  /** who told it (heard memories) */
  fromId?: number;
  /** agents this agent already told it to / reminisced with */
  toldTo: Set<number>;
}

export interface MemoryStats {
  /** distinct stories ever formed */
  stories: number;
  /** lines that retold a story (counted when conversations end) */
  gossipLines: number;
  /** listeners who learned a story they did not know */
  spreads: number;
  /** "remember when" moments between two agents who lived through it */
  reminisced: number;
  /** relationship changes towards third persons caused by gossip */
  opinionShifts: number;
}

interface Store {
  processed: WeakSet<SimEvent>;
  stories: Map<string, Story>;
  byGossip: WeakMap<Gossip, Story>;
  memories: Map<number, Memory[]>;
  lastPrune: number;
  lastLog: number;
  stats: MemoryStats;
}

const stores = new WeakMap<World, Store>();

function store(world: World): Store {
  let s = stores.get(world);
  if (!s) {
    s = {
      processed: new WeakSet(),
      stories: new Map(),
      byGossip: new WeakMap(),
      memories: new Map(),
      lastPrune: world.tick,
      lastLog: -1e9,
      stats: { stories: 0, gossipLines: 0, spreads: 0, reminisced: 0, opinionShifts: 0 },
    };
    stores.set(world, s);
  }
  return s;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** current strength of a memory, decayed since it was formed / reinforced */
function effective(m: Memory, tick: number): number {
  const half = m.source === 'lived' ? HALF_LIFE_LIVED : HALF_LIFE_HEARD;
  return m.strength * 0.5 ** (Math.max(0, tick - m.tick) / half);
}

function memoriesOf(s: Store, id: number): Memory[] {
  let list = s.memories.get(id);
  if (!list) s.memories.set(id, (list = []));
  return list;
}

function find(list: Memory[], story: Story): Memory | undefined {
  return list.find((m) => m.story === story);
}

function isAsleep(world: World, agent: Agent): boolean {
  const a = agent.action;
  if (a?.kind !== 'use' || a.phase !== 'using') return false;
  const obj = world.objects.find((o) => o.uid === a.objectUid);
  return !!obj && !!world.objectDefs[obj.type]?.tags?.includes('sleep');
}

/** awake agents (not subjects) within WITNESS_RADIUS of any subject */
export function witnessesOf(world: World, aboutIds: readonly number[]): Agent[] {
  const subjects = world.agents.filter((a) => aboutIds.includes(a.id));
  return world.agents.filter(
    (a) =>
      !aboutIds.includes(a.id) &&
      !isAsleep(world, a) &&
      subjects.some((s) => Math.hypot(s.pos.x - a.pos.x, s.pos.y - a.pos.y) <= WITNESS_RADIUS),
  );
}

function storyFor(world: World, s: Store, gossip: Gossip): Story {
  let story = s.stories.get(gossip.text);
  if (story) {
    story.tick = world.tick;
    return story;
  }
  const g: Gossip = { text: gossip.text, aboutIds: [...gossip.aboutIds], valence: clamp(gossip.valence, -1, 1) };
  story = { gossip: g, sharedGossip: { ...g, shared: true }, tick: world.tick };
  s.stories.set(g.text, story);
  s.byGossip.set(story.gossip, story);
  s.byGossip.set(story.sharedGossip, story);
  s.stats.stories++;
  return story;
}

function enforceCap(list: Memory[], tick: number): void {
  if (list.length <= MEMORY_CAP) return;
  list.sort((a, b) => effective(b, tick) - effective(a, tick) || b.tick - a.tick);
  list.length = MEMORY_CAP;
}

/** adds or reinforces a memory; returns true if the agent did not know the story before */
function remember(world: World, s: Store, agentId: number, story: Story, strength: number, source: MemorySource, fromId?: number): boolean {
  const list = memoriesOf(s, agentId);
  const existing = find(list, story);
  if (existing) {
    const now = effective(existing, world.tick);
    if (source === 'lived' || strength > now) {
      existing.strength = clamp(Math.max(now, strength), 0, 1);
      existing.tick = world.tick;
      if (source === 'lived') existing.source = 'lived';
    }
    return false;
  }
  list.push({ story, strength: clamp(strength, 0, 1), tick: world.tick, source, fromId, toldTo: new Set() });
  enforceCap(list, world.tick);
  return true;
}

function importance(g: Gossip): number {
  return 0.35 + 0.65 * Math.min(1, Math.abs(g.valence));
}

/** subjects and witnesses remember `gossip` as something they lived through */
export function witnessStory(world: World, gossip: Gossip): void {
  const s = store(world);
  const story = storyFor(world, s, gossip);
  const base = importance(story.gossip);
  for (const id of story.gossip.aboutIds) if (world.agents.some((a) => a.id === id)) remember(world, s, id, story, base, 'lived');
  for (const w of witnessesOf(world, story.gossip.aboutIds)) remember(world, s, w.id, story, base * 0.9, 'lived');
}

function prune(world: World, s: Store): void {
  for (const [id, list] of s.memories) {
    const kept = list.filter((m) => effective(m, world.tick) >= FORGET_BELOW);
    if (kept.length !== list.length) s.memories.set(id, kept);
  }
}

/** called once per tick: turn new world events into memories of the agents involved / present */
export function updateMemories(world: World): void {
  const s = store(world);
  const fresh: SimEvent[] = [];
  for (let i = world.events.length - 1; i >= 0; i--) {
    const e = world.events[i];
    if (s.processed.has(e)) break;
    fresh.push(e);
  }
  for (let i = fresh.length - 1; i >= 0; i--) {
    const e = fresh[i];
    s.processed.add(e);
    if (e.gossip) witnessStory(world, e.gossip);
  }
  if (world.tick - s.lastPrune >= PRUNE_EVERY) {
    s.lastPrune = world.tick;
    prune(world, s);
  }
}

/** stories `speaker` could bring up when talking to `listener` (most interesting first) */
export function recallFor(world: World, speaker: Agent, listener: Agent): Gossip[] {
  const s = stores.get(world);
  if (!s) return [];
  const mine = s.memories.get(speaker.id);
  if (!mine || mine.length === 0) return [];
  const theirs = s.memories.get(listener.id) ?? [];
  const scored: { g: Gossip; score: number }[] = [];
  for (const m of mine) {
    const eff = effective(m, world.tick);
    if (eff < FORGET_BELOW || m.toldTo.has(listener.id)) continue;
    const g = m.story.gossip;
    // only third persons: retelling to or about the people talking reads oddly without declension
    if (g.aboutIds.includes(speaker.id) || g.aboutIds.includes(listener.id)) continue;
    const age = world.tick - m.story.tick;
    const fresh = 1 + 0.5 * 0.5 ** (age / (24 * 60));
    const weight = eff * (0.6 + Math.abs(g.valence)) * fresh;
    const known = find(theirs, m.story);
    if (!known) {
      scored.push({ g, score: weight });
    } else if (m.source === 'lived' && known.source === 'lived' && age >= SHARED_MIN_AGE && effective(known, world.tick) >= FORGET_BELOW) {
      scored.push({ g: m.story.sharedGossip, score: weight * 0.6 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, RECALL_MAX).map((x) => x.g);
}

const QUARREL_TEXTS = ['{a} i {b} kłócą się', '{a} i {b} mają ostrą sprzeczkę', '{a} i {b} skaczą sobie do oczu'];
const HEARTFELT_TEXTS = ['{a} i {b} świetnie się dogadują', '{a} i {b} gadają jak najlepsi kumple', '{a} i {b} godzinami rozmawiają'];

/** story about the conversation itself (big quarrel / heartfelt talk), or null */
export function conversationGossip(a: Agent, b: Agent, conv: Conversation): Gossip | null {
  if (conv.lines.length < 2) return null;
  const delta = conversationDelta(a, b, conv.lines);
  const pick = (list: string[]): string => list[Math.abs(conv.id) % list.length].replace('{a}', a.name).replace('{b}', b.name);
  if (delta <= QUARREL_AT) return { text: pick(QUARREL_TEXTS), aboutIds: [a.id, b.id], valence: -0.6 };
  if (delta >= HEARTFELT_AT && conv.lines.length >= 4) return { text: pick(HEARTFELT_TEXTS), aboutIds: [a.id, b.id], valence: 0.4 };
  return null;
}

/** called when a conversation with ≥2 lines ends: gossip spreads, opinions about third persons shift */
export function onConversationEnd(world: World, conv: Conversation): void {
  const s = store(world);
  const [a, b] = conv.participants.map((id) => world.agents.find((x) => x.id === id));
  if (!a || !b) return;
  const handled = new Set<Story>();
  for (const line of conv.lines) {
    if (!line.gossip) continue;
    const story = s.byGossip.get(line.gossip) ?? s.stories.get(line.gossip.text);
    if (!story || handled.has(story)) continue;
    handled.add(story);
    s.stats.gossipLines++;
    const speaker = line.speakerId === a.id ? a : b;
    const listener = speaker === a ? b : a;
    const told = find(memoriesOf(s, speaker.id), story);
    if (!told) continue;
    told.toldTo.add(listener.id);
    const heard = find(memoriesOf(s, listener.id), story);
    if (heard && line.gossip.shared) {
      // reminiscing refreshes both memories and brings the two closer a little
      remember(world, s, speaker.id, story, effective(told, world.tick) + 0.15, told.source);
      remember(world, s, listener.id, story, effective(heard, world.tick) + 0.15, heard.source);
      heard.toldTo.add(speaker.id);
      s.stats.reminisced++;
      if (story.gossip.valence > 0) world.relationships.adjust(speaker.id, listener.id, 1);
      continue;
    }
    if (heard) continue;
    remember(world, s, listener.id, story, Math.max(0.2, effective(told, world.tick) * RETELL_FACTOR), 'heard', speaker.id);
    s.stats.spreads++;
    // the listener's opinion of the subjects shifts, scaled by how much they trust the teller
    const trust = clamp(0.5 + world.relationships.get(listener.id, speaker.id) / 100, 0.2, 1.5);
    const v = story.gossip.valence;
    if (Math.abs(v) >= 0.15) {
      const delta = Math.sign(v) * clamp(Math.round(Math.abs(v) * 3 * trust), 1, 3);
      for (const subject of story.gossip.aboutIds) {
        if (subject === listener.id || subject === speaker.id) continue;
        world.relationships.adjust(listener.id, subject, delta);
        s.stats.opinionShifts++;
      }
    }
    if (world.tick - s.lastLog >= LOG_COOLDOWN && world.rng.chance(LOG_CHANCE)) {
      s.lastLog = world.tick;
      pushEvent(world, 'conversation', `${speaker.name} → ${listener.name}: plotka (${story.gossip.text})`, [speaker.id, listener.id]);
    }
  }
  const own = conversationGossip(a, b, conv);
  if (own) witnessStory(world, own);
}

// ---------------------------------------------------------------- read-only views (UI, tests, metrics)

export interface MemoryView {
  gossip: Gossip;
  strength: number;
  source: MemorySource;
  fromId?: number;
}

/** an agent's current memories, strongest first */
export function agentMemories(world: World, agentId: number): MemoryView[] {
  const s = stores.get(world);
  const list = s?.memories.get(agentId) ?? [];
  return list
    .map((m) => ({ gossip: m.story.gossip, strength: effective(m, world.tick), source: m.source, fromId: m.fromId }))
    .filter((m) => m.strength >= FORGET_BELOW)
    .sort((x, y) => y.strength - x.strength);
}

export function memoryStats(world: World): MemoryStats {
  return { ...store(world).stats };
}
