import type { Agent, Relationships, World } from '../types';
import { pushEvent } from '../world/events';
import { fromJson, registerWorldState, toJson, type Json } from '../core/state';

export const REL_MIN = -100;
export const REL_MAX = 100;

const clamp = (v: number): number => Math.max(REL_MIN, Math.min(REL_MAX, v));
const keyOf = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** symmetric sympathy store; a pair of the same agent is always 0 and never stored */
export function createRelationships(): Relationships {
  const values = new Map<string, number>();
  return {
    get(a, b) {
      if (a === b) return 0;
      return values.get(keyOf(a, b)) ?? 0;
    },
    adjust(a, b, delta) {
      if (a === b || !Number.isFinite(delta)) return this.get(a, b);
      const key = keyOf(a, b);
      const next = clamp((values.get(key) ?? 0) + delta);
      values.set(key, next);
      return next;
    },
    all() {
      const out: { a: number; b: number; value: number }[] = [];
      for (const [key, value] of values) {
        const [a, b] = key.split(':').map(Number);
        out.push({ a, b, value });
      }
      return out.sort((x, y) => x.a - y.a || x.b - y.b);
    },
  };
}

/** Polish label for a sympathy value (-100..100) */
export function relationshipLabel(v: number): string {
  if (v <= -60) return 'wrogowie';
  if (v <= -25) return 'nie przepadają za sobą';
  if (v < -5) return 'chłodna znajomość';
  if (v < 15) return 'znajomi';
  if (v < 40) return 'koledzy';
  if (v < 75) return 'przyjaciele';
  return 'najlepsi przyjaciele';
}

// ---------------------------------------------------------------- relationship kinds (wave 5)
//
// Beyond the symmetric sympathy number every pair has a small record ("bond"):
// romance (0..100, grows only between compatible residents who already like each
// other, over repeated nice chats; exclusive), rivalry (0..100, grows with
// quarrels, fades with time and nice chats) and a short history. The status label
// is derived from sympathy + romance + rivalry with hysteresis; notable status
// changes are logged with a gossip story. State lives in a WeakMap per world, so
// the World / Relationships contracts are unchanged. Everything is PG: romance
// means flirty chats and seeking each other's company, nothing more.

export type RelationStatus =
  | 'couple'
  | 'crush'
  | 'enemies'
  | 'rivals'
  | 'best_friends'
  | 'friends'
  | 'pals'
  | 'acquaintances'
  | 'cool'
  | 'dislike';

export const STATUS_LABELS: Record<RelationStatus, string> = {
  couple: 'para',
  crush: 'zauroczenie',
  enemies: 'wrogowie',
  rivals: 'rywale',
  best_friends: 'najlepsi przyjaciele',
  friends: 'przyjaciele',
  pals: 'koledzy',
  acquaintances: 'znajomi',
  cool: 'chłodna znajomość',
  dislike: 'nie przepadają za sobą',
};

export const STATUS_ICONS: Record<RelationStatus, string> = {
  couple: '💕',
  crush: '😊',
  enemies: '💢',
  rivals: '⚡',
  best_friends: '🌟',
  friends: '🤝',
  pals: '🙂',
  acquaintances: '·',
  cool: '😐',
  dislike: '🙄',
};

export interface RelationHistoryEntry {
  tick: number;
  /** Polish, neutral (no names, no gendered past tense), e.g. "Zostają parą 💕" */
  text: string;
}

/** read-only view of a pair, for the UI and tests */
export interface RelationView {
  /** -100..100 (same as world.relationships.get) */
  sympathy: number;
  /** 0..100 */
  romance: number;
  /** 0..100 */
  rivalry: number;
  status: RelationStatus;
  /** Polish label, e.g. "para", "rywale", "przyjaciele" */
  label: string;
  icon: string;
  /** 0..1, how well the two click romantically (fixed per pair and world) */
  chemistry: number;
  /** oldest first, at most HISTORY_MAX */
  history: RelationHistoryEntry[];
}

/** tuning of relationship kinds */
export const REL_TUNING = {
  /** romance ≥ this (and sympathy ≥ COUPLE_SYMPATHY) → couple; stays a couple down to COUPLE_STAY */
  COUPLE_AT: 55,
  COUPLE_STAY: 40,
  COUPLE_SYMPATHY: 35,
  COUPLE_SYMPATHY_STAY: 10,
  /** romance ≥ this → crush (stays down to CRUSH_STAY) */
  CRUSH_AT: 25,
  CRUSH_STAY: 15,
  /** romance only grows for pairs with chemistry ≥ this and sympathy ≥ ROMANCE_SYMPATHY */
  CHEMISTRY_MIN: 0.62,
  ROMANCE_SYMPATHY: 25,
  /** romance gained per nice chat = ROMANCE_GAIN * chemistry (×1.5 for a great one) */
  ROMANCE_GAIN: 12,
  /** romance gained per tick spent sitting together (same or neighbouring social seats) = ROMANCE_TOGETHER * chemistry */
  ROMANCE_TOGETHER: 0.04,
  /** romance lost per quarrel */
  ROMANCE_QUARREL: 15,
  /** rivalry ≥ this → rivals (stays down to RIVAL_STAY) */
  RIVAL_AT: 35,
  RIVAL_STAY: 10,
  /** rivals with sympathy ≤ this are enemies */
  ENEMY_SYMPATHY: -40,
  /** rivalry gained per quarrel (×1.5 when they already dislike each other) */
  RIVAL_GAIN: 15,
  /** rivalry lost per nice chat */
  RIVAL_NICE: 8,
  /** rivalry from a tense chat or a turned-down invitation to talk */
  RIVAL_TENSE: 10,
  RIVAL_REFUSED: 3,
  /** rivalry when the object one's daily goal needs is taken by the other (× 0.5 + clash) */
  RIVAL_COMPETE: 8,
  /** conversation delta thresholds (conversationDelta is roughly -8..8) */
  GREAT_CHAT: 5,
  NICE_CHAT: 2.5,
  TENSE_CHAT: -1.5,
  QUARREL: -4,
  /** clashing temperaments (neat vs messy, cheerful vs grumpy) feel this much colder in conversation, per unit of clash above CLASH_FROM */
  CLASH_FELT: 80,
  CLASH_FROM: 0.35,
  /** clashing pairs sitting together get on each other's nerves: rivalry per tick = ANNOY_TOGETHER * (clash - ANNOY_FROM) / (1 - ANNOY_FROM) */
  ANNOY_TOGETHER: 0.17,
  ANNOY_FROM: 0.55,
  /** per game day */
  RIVALRY_DECAY: 4,
  ROMANCE_DECAY: 1.5,
  /** sympathy bands keep their label within this margin of a boundary (no flapping) */
  BAND_MARGIN: 5,
} as const;

export const HISTORY_MAX = 10;
/** status checks and decay run every this many ticks */
const UPDATE_EVERY = 10;

interface Bond {
  romance: number;
  rivalry: number;
  status: RelationStatus;
  history: RelationHistoryEntry[];
}

interface BondStore {
  bonds: Map<string, Bond>;
  lastUpdate: number;
}

const stores = new WeakMap<World, BondStore>();

// sympathy values live in world.relationships (saved by core/state itself); bonds here
registerWorldState('relationships', {
  save: (world) => {
    const s = stores.get(world);
    if (!s) return null;
    return { bonds: toJson(s.bonds), lastUpdate: s.lastUpdate };
  },
  load: (world, data) => {
    const d = data as { bonds: Json; lastUpdate: number };
    stores.set(world, { bonds: fromJson<Map<string, Bond>>(d.bonds), lastUpdate: d.lastUpdate });
  },
});

function bondStore(world: World): BondStore {
  let s = stores.get(world);
  if (!s) stores.set(world, (s = { bonds: new Map(), lastUpdate: world.tick }));
  return s;
}

function freshBond(world: World, a: number, b: number): Bond {
  return { romance: 0, rivalry: 0, status: deriveStatus(world.relationships.get(a, b), 0, 0, undefined), history: [] };
}

function bondOf(world: World, a: number, b: number): Bond {
  const s = bondStore(world);
  const key = keyOf(a, b);
  let bond = s.bonds.get(key);
  if (!bond) s.bonds.set(key, (bond = freshBond(world, a, b)));
  return bond;
}

/** read-only access: never creates state (UI reads must not change the simulation) */
function peekBond(world: World, a: number, b: number): Bond {
  return stores.get(world)?.bonds.get(keyOf(a, b)) ?? freshBond(world, a, b);
}

/** sympathy band (the plain friendship ladder) */
function band(v: number): RelationStatus {
  if (v <= -60) return 'enemies';
  if (v <= -25) return 'dislike';
  if (v < -5) return 'cool';
  if (v < 15) return 'acquaintances';
  if (v < 40) return 'pals';
  if (v < 75) return 'friends';
  return 'best_friends';
}

/** status from the numbers; `prev` gives hysteresis so labels don't flap around thresholds */
export function deriveStatus(sympathy: number, romance: number, rivalry: number, prev: RelationStatus | undefined): RelationStatus {
  const T = REL_TUNING;
  const wasCouple = prev === 'couple';
  if (romance >= (wasCouple ? T.COUPLE_STAY : T.COUPLE_AT) && sympathy >= (wasCouple ? T.COUPLE_SYMPATHY_STAY : T.COUPLE_SYMPATHY)) return 'couple';
  const wasCrush = prev === 'crush' || wasCouple;
  if (romance >= (wasCrush ? T.CRUSH_STAY : T.CRUSH_AT) && sympathy >= 0) return 'crush';
  const wasRival = prev === 'rivals' || prev === 'enemies';
  if (rivalry >= (wasRival ? T.RIVAL_STAY : T.RIVAL_AT)) return sympathy <= T.ENEMY_SYMPATHY ? 'enemies' : 'rivals';
  const b = band(sympathy);
  if (prev && prev !== b && (band(sympathy + T.BAND_MARGIN) === prev || band(sympathy - T.BAND_MARGIN) === prev)) return prev;
  return b;
}

/** deterministic 0..1 per pair and world seed */
function spark(seed: number, a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  let h = (seed * 374761393 + lo * 668265263 + hi * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** 0..1: how well two residents click (a fixed spark plus similar temperament) */
export function chemistry(world: World, a: number, b: number): number {
  const A = world.agents.find((x) => x.id === a);
  const B = world.agents.find((x) => x.id === b);
  if (!A || !B || a === b) return 0;
  const sim = (k: 'cheerfulness' | 'activity' | 'sociability') => 1 - Math.abs(A.traits[k] - B.traits[k]) / 2;
  return 0.55 * spark(world.seed, a, b) + 0.2 * sim('cheerfulness') + 0.15 * sim('activity') + 0.1 * sim('sociability');
}

/** 0..1: how much two temperaments clash (neat vs messy, cheerful vs grumpy) */
export function clash(world: World, a: number, b: number): number {
  const A = world.agents.find((x) => x.id === a);
  const B = world.agents.find((x) => x.id === b);
  if (!A || !B || a === b) return 0;
  return (Math.abs(A.traits.neatness - B.traits.neatness) + Math.abs(A.traits.cheerfulness - B.traits.cheerfulness)) / 4;
}

/** id of the person `id` has a romance (crush or couple) with, if any */
export function partnerOf(world: World, id: number): number | undefined {
  let best: { other: number; romance: number } | undefined;
  for (const [key, bond] of bondStore(world).bonds) {
    if (bond.status !== 'couple' && bond.status !== 'crush') continue;
    const [a, b] = key.split(':').map(Number);
    if (a !== id && b !== id) continue;
    if (!best || bond.romance > best.romance) best = { other: a === id ? b : a, romance: bond.romance };
  }
  return best?.other;
}

/** romance can grow only for a compatible pair that likes each other and is not attached elsewhere */
function romanceAllowed(world: World, a: number, b: number, bond: Bond): boolean {
  const T = REL_TUNING;
  if (bond.rivalry >= 20) return false;
  if (world.relationships.get(a, b) < T.ROMANCE_SYMPATHY) return false;
  if (chemistry(world, a, b) < T.CHEMISTRY_MIN) return false;
  for (const id of [a, b]) {
    const p = partnerOf(world, id);
    if (p !== undefined && p !== a && p !== b) return false;
  }
  return true;
}

function addHistory(world: World, bond: Bond, text: string): void {
  bond.history.push({ tick: world.tick, text });
  if (bond.history.length > HISTORY_MAX) bond.history.splice(0, bond.history.length - HISTORY_MAX);
}

/** adds a neutral note to a pair's history (e.g. a shared gathering) */
export function noteRelation(world: World, a: number, b: number, text: string): void {
  if (a === b) return;
  addHistory(world, bondOf(world, a, b), text);
}

const clamp100 = (v: number): number => Math.max(0, Math.min(100, v));

/**
 * feeds a finished conversation into the pair's bond: nice chats grow romance
 * (if allowed) and soften rivalry; quarrels grow rivalry and cool romance.
 * `delta` is the sympathy change of the conversation (conversationDelta).
 */
export function recordConversation(world: World, a: number, b: number, delta: number, topic: string): 'nice' | 'quarrel' | 'plain' {
  const T = REL_TUNING;
  const bond = bondOf(world, a, b);
  if (delta >= T.NICE_CHAT) {
    bond.rivalry = clamp100(bond.rivalry - T.RIVAL_NICE);
    const gain = T.ROMANCE_GAIN * chemistry(world, a, b) * (delta >= T.GREAT_CHAT ? 1.5 : 1);
    if (romanceAllowed(world, a, b, bond)) bond.romance = clamp100(bond.romance + gain);
    updatePair(world, a, b);
    return 'nice';
  }
  if (delta <= T.QUARREL) {
    recordQuarrel(world, a, b, `Kłótnia — temat: ${topic}`);
    return 'quarrel';
  }
  if (delta <= T.TENSE_CHAT) {
    recordFriction(world, a, b, T.RIVAL_TENSE);
    return 'quarrel';
  }
  updatePair(world, a, b);
  return 'plain';
}

/** small friction (a tense chat, a turned-down chat): rivalry grows a little */
export function recordFriction(world: World, a: number, b: number, amount: number = REL_TUNING.RIVAL_REFUSED): void {
  if (a === b) return;
  const bond = bondOf(world, a, b);
  const dislike = world.relationships.get(a, b) < 0 ? 1.5 : 1;
  bond.rivalry = clamp100(bond.rivalry + amount * dislike);
  bond.romance = clamp100(bond.romance - amount / 2);
  updatePair(world, a, b);
}

/** a quarrel of any kind (conversation, TV remote…): rivalry up, romance down */
export function recordQuarrel(world: World, a: number, b: number, text: string): void {
  if (a === b) return;
  const T = REL_TUNING;
  const bond = bondOf(world, a, b);
  const dislike = world.relationships.get(a, b) < 0 ? 1.5 : 1;
  bond.rivalry = clamp100(bond.rivalry + T.RIVAL_GAIN * dislike);
  bond.romance = clamp100(bond.romance - T.ROMANCE_QUARREL);
  addHistory(world, bond, text);
  updatePair(world, a, b);
}

interface StatusStory {
  log: string;
  history: string;
  gossip?: { text: string; valence: number };
}

/** what to say when a pair moves from `from` to `to`; undefined = not worth a log line */
function storyFor(from: RelationStatus, to: RelationStatus, A: string, B: string): StatusStory | undefined {
  const both = `${A} i ${B}`;
  const negative = (s: RelationStatus) => s === 'rivals' || s === 'enemies';
  const rank: Partial<Record<RelationStatus, number>> = { pals: 1, friends: 2, best_friends: 3, crush: 3, couple: 4 };
  switch (to) {
    case 'couple':
      return { log: `${both} są parą 💕`, history: 'Zostają parą 💕', gossip: { text: `${both} są parą`, valence: 0.7 } };
    case 'crush':
      if (from === 'couple') return { log: `${both} się rozstają 💔`, history: 'Rozstanie 💔', gossip: { text: `${both} się rozstają`, valence: -0.4 } };
      return { log: `${both} mają się ku sobie 😊`, history: 'Zauroczenie 😊', gossip: { text: `${both} mają się ku sobie`, valence: 0.4 } };
    case 'rivals':
      if (from === 'enemies') return undefined;
      return { log: `${both} zostają rywalami ⚡`, history: 'Zostają rywalami ⚡', gossip: { text: `${both} zostają rywalami`, valence: -0.5 } };
    case 'enemies':
      return { log: `${both} nie mogą się znieść 💢`, history: 'Wrogowie 💢', gossip: { text: `${both} nie mogą się znieść`, valence: -0.7 } };
  }
  if (from === 'couple') return { log: `${both} się rozstają 💔`, history: 'Rozstanie 💔', gossip: { text: `${both} się rozstają`, valence: -0.4 } };
  if (negative(from) && !negative(to) && to !== 'dislike' && to !== 'cool')
    return { log: `${both} zakopują topór wojenny 🕊️`, history: 'Zgoda 🕊️', gossip: { text: `${both} zakopują topór wojenny`, valence: 0.5 } };
  if (negative(from)) return { log: `${both} — koniec rywalizacji`, history: 'Koniec rywalizacji' };
  if ((rank[to] ?? 0) > (rank[from] ?? 0) && from !== 'crush') {
    if (to === 'best_friends')
      return { log: `${both} są najlepszymi przyjaciółmi 🌟`, history: 'Najlepsi przyjaciele 🌟', gossip: { text: `${both} są najlepszymi przyjaciółmi`, valence: 0.5 } };
    if (to === 'friends') return { log: `${both} się przyjaźnią 🤝`, history: 'Przyjaźń 🤝', gossip: { text: `${both} się przyjaźnią`, valence: 0.3 } };
  }
  return undefined;
}

/** re-derives the pair's status and logs notable changes */
function updatePair(world: World, a: number, b: number): void {
  const bond = bondOf(world, a, b);
  const next = deriveStatus(world.relationships.get(a, b), bond.romance, bond.rivalry, bond.status);
  if (next === bond.status) return;
  const prev = bond.status;
  bond.status = next;
  // a couple that drops to a crush is a break-up: let the spark fade properly
  if (prev === 'couple' && next !== 'couple') bond.romance = Math.min(bond.romance, REL_TUNING.CRUSH_STAY - 1);
  const A = world.agents.find((x) => x.id === a);
  const B = world.agents.find((x) => x.id === b);
  if (!A || !B) return;
  const story = storyFor(prev, bond.status, A.name, B.name);
  if (!story) return;
  addHistory(world, bond, story.history);
  pushEvent(
    world,
    'relationship',
    story.log,
    [a, b],
    story.gossip ? { text: story.gossip.text, aboutIds: [a, b], valence: story.gossip.valence } : undefined,
  );
}

/** decay and status checks for all pairs; call once per tick (it throttles itself) */
export function updateRelations(world: World): void {
  const s = bondStore(world);
  const elapsed = world.tick - s.lastUpdate;
  if (elapsed < UPDATE_EVERY && s.bonds.size > 0) return;
  s.lastUpdate = world.tick;
  const days = Math.max(0, elapsed) / (24 * 60);
  const seated = world.agents.filter((x) => seatedSocially(world, x));
  const ids = world.agents.map((x) => x.id);
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const bond = bondOf(world, ids[i], ids[j]);
      bond.rivalry = clamp100(bond.rivalry - REL_TUNING.RIVALRY_DECAY * days);
      bond.romance = clamp100(bond.romance - REL_TUNING.ROMANCE_DECAY * days);
      updatePair(world, ids[i], ids[j]);
    }
  // time spent side by side (dinner, a film, a bench) lets a spark grow, or gets on clashing nerves
  for (let i = 0; i < seated.length; i++)
    for (let j = i + 1; j < seated.length; j++) {
      const x = seated[i];
      const y = seated[j];
      if (Math.hypot(x.pos.x - y.pos.x, x.pos.y - y.pos.y) > TOGETHER_REACH) continue;
      const T = REL_TUNING;
      const bond = bondOf(world, x.id, y.id);
      const c = clash(world, x.id, y.id);
      if (c > T.ANNOY_FROM) bond.rivalry = clamp100(bond.rivalry + (T.ANNOY_TOGETHER * (c - T.ANNOY_FROM)) / (1 - T.ANNOY_FROM) * elapsed);
      else if (romanceAllowed(world, x.id, y.id, bond)) bond.romance = clamp100(bond.romance + T.ROMANCE_TOGETHER * chemistry(world, x.id, y.id) * elapsed);
      updatePair(world, x.id, y.id);
    }
}

/** seats closer than this count as "together" */
const TOGETHER_REACH = 3;

function seatedSocially(world: World, agent: Agent): boolean {
  const a = agent.action;
  if (a?.kind !== 'use' || a.phase !== 'using') return false;
  const obj = world.objects.find((o) => o.uid === a.objectUid);
  return !!obj && !!world.objectDefs[obj.type]?.social;
}

/** full view of a pair (the UI's inspector and the stats panel read this) */
export function relationOf(world: World, a: number, b: number): RelationView {
  const sympathy = world.relationships.get(a, b);
  if (a === b) {
    return { sympathy: 0, romance: 0, rivalry: 0, status: 'acquaintances', label: STATUS_LABELS.acquaintances, icon: '', chemistry: 0, history: [] };
  }
  const bond = peekBond(world, a, b);
  return {
    sympathy,
    romance: Math.round(bond.romance),
    rivalry: Math.round(bond.rivalry),
    status: bond.status,
    label: STATUS_LABELS[bond.status],
    icon: STATUS_ICONS[bond.status],
    chemistry: Math.round(chemistry(world, a, b) * 100) / 100,
    history: bond.history.map((h) => ({ ...h })),
  };
}

/** every other resident's relation to `id`, closest first */
export function relationsOf(world: World, id: number): (RelationView & { otherId: number })[] {
  return world.agents
    .filter((o) => o.id !== id)
    .map((o) => ({ otherId: o.id, ...relationOf(world, id, o.id) }))
    .sort((x, y) => y.romance - x.romance || y.sympathy - x.sympathy);
}

/** number of pairs per status (all pairs of current residents) */
export function relationStats(world: World): Record<RelationStatus, number> {
  const out = Object.fromEntries(Object.keys(STATUS_LABELS).map((k) => [k, 0])) as Record<RelationStatus, number>;
  const ids = world.agents.map((x) => x.id);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out[peekBond(world, ids[i], ids[j]).status]++;
  return out;
}

/** current couples as [a, b] with a < b */
export function couplesOf(world: World): [number, number][] {
  const out: [number, number][] = [];
  const ids = world.agents.map((x) => x.id).sort((x, y) => x - y);
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) if (peekBond(world, ids[i], ids[j]).status === 'couple') out.push([ids[i], ids[j]]);
  return out;
}

/**
 * sympathy as felt in conversation: couples and crushes are warmer, rivals
 * colder (so rivals quarrel more). Used for ConversationContext.relationship.
 */
export function feltSympathy(world: World, a: number, b: number): number {
  const v = world.relationships.get(a, b);
  if (a === b) return v;
  const bond = peekBond(world, a, b);
  let felt = v;
  if (bond.status === 'couple') felt += 20;
  else if (bond.status === 'crush') felt += 10;
  else if (bond.status === 'rivals' || bond.status === 'enemies') felt -= 15 + bond.rivalry * 0.3;
  felt -= REL_TUNING.CLASH_FELT * Math.max(0, clash(world, a, b) - REL_TUNING.CLASH_FROM);
  return clamp(felt);
}

/** status only (cheap; used by the brain) */
export function statusOf(world: World, a: number, b: number): RelationStatus {
  return a === b ? 'acquaintances' : peekBond(world, a, b).status;
}
