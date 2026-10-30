import type { Agent, GameTime, ObjectDef, ObjectInstance, Vec2, World } from '../types';
import { timeFromTick } from '../core/time';
import { fromJson, registerWorldState, toJson, type Json } from '../core/state';
import { pushEvent } from '../world/events';
import { REL_TUNING, clash, recordFriction, statusOf, type RelationStatus } from '../social/relationships';
import { isMealTime } from './meals';
import { goalObjectBias, type GoalBias } from './goals';

// Group activities. A resident who heads for a "gathering" object at the right
// time (dining table at a meal, grill around lunch/dinner, TV in the evening)
// may invite the others: for a short window, nearby friends with OK needs get a
// strong score bonus for that object (and, for the grill, the garden benches
// around it). When three or more people overlap there, the gathering is logged
// once, with a gossip story. Couples are drawn to each other's company; rivals
// keep their distance. State lives in a WeakMap per world.

export type GatheringKind = 'meal' | 'grill' | 'movie';

export const GROUP_TUNING = {
  /** invitations last this many ticks (walking across the house takes ~40) */
  INVITE_WINDOW: 60,
  /** only residents within this many tiles of the host hear the invitation */
  INVITE_RADIUS: 22,
  /** invitees need at least this sympathy towards the host */
  INVITE_MIN_SYMPATHY: 0,
  /** chance to invite = base + sociability * k (clamped) */
  INVITE_BASE: 0.45,
  INVITE_PER_SOCIABILITY: 0.3,
  /** benches and other social garden seats within this radius of a grill belong to the grill party */
  GRILL_RADIUS: 7,
  /** per tick, someone at a gathering object with free seats may call the others over (× invite chance) */
  CALL_OVER_CHANCE: 0.012,
  /** × invite chance of the most sociable diner */
  MOVIE_PROPOSE_CHANCE: 1.3,
  /** a gathering is logged once at least this many people take part */
  MIN_PARTICIPANTS: 3,
  /** a gathering ends after this many ticks with fewer than 2 people */
  END_AFTER: 15,
  /** sympathy gained by every pair that took part, when the gathering ends */
  BOND_BONUS: 1,
} as const;

/** score' = score * mult + add * calm (see brain.withGoal) */
export const INVITE_BIAS: GoalBias = { mult: 1.5, add: 11 };
/** films need a stronger pull: by the evening most needs are met and beds beckon */
export const MOVIE_INVITE_FACTOR = 2.2;
/** a couple partner already using (or walking to) a social object */
export const PARTNER_BIAS: GoalBias = { mult: 1.6, add: 8 };
export const CRUSH_BIAS: GoalBias = { mult: 1.25, add: 3 };
/** a rival at the object: score multiplied by this (when calm; urgent needs override) */
export const RIVAL_AVOID = 0.45;

/** talk appeal multipliers by relation status */
export const TALK_STATUS_FACTOR: Partial<Record<RelationStatus, number>> = {
  couple: 1.8,
  crush: 1.4,
  best_friends: 1.15,
  rivals: 0.3,
  enemies: 0.15,
};

interface Invitation {
  objectUid: number;
  hostId: number;
  kind: GatheringKind;
  until: number;
  /** proposed over dinner: the host is not there yet and goes too */
  proposed?: boolean;
}

interface Gathering {
  objectUid: number;
  kind: GatheringKind;
  startTick: number;
  ids: Set<number>;
  announced: boolean;
  lowSince: number | null;
  /** a film was already suggested at this dinner */
  proposed?: boolean;
}

/** a logged gathering (UI / metrics) */
export interface GatheringRecord {
  tick: number;
  kind: GatheringKind;
  objectUid: number;
  /** Polish, e.g. "Wspólny grill" */
  label: string;
  /** everyone who took part (grows while the gathering lasts) */
  ids: number[];
  /** still going on */
  active: boolean;
}

interface GroupStore {
  invites: Invitation[];
  active: Map<number, Gathering>;
  log: GatheringRecord[];
  total: Record<GatheringKind, number>;
}

const LOG_MAX = 60;
const stores = new WeakMap<World, GroupStore>();

function store(world: World): GroupStore {
  let s = stores.get(world);
  if (!s) stores.set(world, (s = { invites: [], active: new Map(), log: [], total: { meal: 0, grill: 0, movie: 0 } }));
  return s;
}

const hourOf = (t: GameTime): number => t.hour + t.minute / 60;
/** TV invitations (and the "Wieczór filmowy" label) from this hour; earlier full TV seats are a "Wspólny seans" */
const MOVIE_FROM = 17;
/** dinner gatherings ending in this window may turn into a movie night */
const MOVIE_PROPOSE: [number, number] = [18, 20.5];
/** …once the dinner has gone on for this many ticks */
const MOVIE_PROPOSE_AFTER = 20;

/** the gathering an object can host right now (for invitations) */
function inviteKind(type: string, time: GameTime): GatheringKind | null {
  const h = hourOf(time);
  if (type === 'dining_table') return isMealTime(time) ? 'meal' : null;
  if (type === 'grill') return h >= 11 && h < 20 ? 'grill' : null;
  if (type === 'tv') return h >= MOVIE_FROM && h < 22 ? 'movie' : null;
  return null;
}

/** the gathering kind an object stands for when people are already there */
function gatheringKind(type: string): GatheringKind | null {
  if (type === 'dining_table') return 'meal';
  if (type === 'grill') return 'grill';
  if (type === 'tv') return 'movie';
  return null;
}

const INVITE_LINES: Record<GatheringKind, string[]> = {
  meal: ['Kto je ze mną? 🍲', 'Chodźcie jeść! 🍽️', 'Siadamy do stołu?'],
  grill: ['Kto na grilla? 🌭', 'Rozpalam grilla, zapraszam! 🔥', 'Kiełbaski dla chętnych! 🌭'],
  movie: ['Seans! Kto ogląda? 🍿', 'Zaraz film, dołączycie? 📺', 'Wieczór filmowy? 🍿'],
};

function centre(obj: ObjectInstance, def: ObjectDef): Vec2 {
  return { x: obj.pos.x + (def.size.w - 1) / 2, y: obj.pos.y + (def.size.h - 1) / 2 };
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** social garden seats that belong to the party around this grill */
function nearGrill(world: World, grill: ObjectInstance, obj: ObjectInstance, def: ObjectDef): boolean {
  if (obj.uid === grill.uid || !def.social || !def.tags?.includes('outdoor')) return false;
  const gdef = world.objectDefs[grill.type];
  return !!gdef && dist(centre(grill, gdef), centre(obj, def)) <= GROUP_TUNING.GRILL_RADIUS;
}

/**
 * called when `agent` sets off to use `obj`: at the right time and with a sociable
 * enough temper it invites the others (speech bubble + a short-lived score bonus)
 */
export function onHeadingTo(world: World, agent: Agent, obj: ObjectInstance, time: GameTime): void {
  maybeInvite(world, agent, obj, time, 1);
}

function inviteChance(agent: Agent): number {
  const T = GROUP_TUNING;
  return Math.max(0.1, Math.min(0.85, T.INVITE_BASE + T.INVITE_PER_SOCIABILITY * agent.traits.sociability));
}

function maybeInvite(world: World, agent: Agent, obj: ObjectInstance, time: GameTime, scale: number): void {
  const kind = inviteKind(obj.type, time);
  if (!kind) return;
  const s = store(world);
  s.invites = s.invites.filter((i) => i.until > world.tick);
  if (s.invites.some((i) => i.objectUid === obj.uid)) return;
  const T = GROUP_TUNING;
  if (!world.rng.chance(inviteChance(agent) * scale)) return;
  s.invites.push({ objectUid: obj.uid, hostId: agent.id, kind, until: world.tick + T.INVITE_WINDOW });
  agent.bubble = { kind: 'speech', text: world.rng.pick(INVITE_LINES[kind]), ttl: 25, tone: 'positive' };
}

/**
 * `host` calls everyone to a gathering at `obj` right away (no chance roll), e.g. after fishing:
 * "let's grill the fish". Returns false when the object hosts nothing now or is already invited to.
 */
export function callGathering(world: World, host: Agent, obj: ObjectInstance, text: string): boolean {
  const kind = inviteKind(obj.type, timeFromTick(world.tick));
  if (!kind) return false;
  const s = store(world);
  s.invites = s.invites.filter((i) => i.until > world.tick);
  if (s.invites.some((i) => i.objectUid === obj.uid)) return false;
  s.invites.push({ objectUid: obj.uid, hostId: host.id, kind, until: world.tick + GROUP_TUNING.INVITE_WINDOW, proposed: true });
  host.bubble = { kind: 'speech', text, ttl: 25, tone: 'positive' };
  return true;
}

/** active invitations (UI may show them) */
export function invitationsOf(world: World): readonly { objectUid: number; hostId: number; kind: GatheringKind; until: number }[] {
  return store(world).invites.filter((i) => i.until > world.tick);
}

function combine(a: GoalBias, b: GoalBias): GoalBias {
  return { mult: a.mult * b.mult, add: a.add + b.add };
}

const NO_BIAS: GoalBias = { mult: 1, add: 0 };

/**
 * social pull of an object for `agent`: invitations from friends, a partner's
 * company, a rival's presence. `calm` (0..1) fades the pull when a need is urgent.
 */
export function socialObjectBias(world: World, agent: Agent, obj: ObjectInstance, def: ObjectDef, calm: number): GoalBias {
  let bias = NO_BIAS;
  const s = stores.get(world);
  if (s) {
    let best: GoalBias | null = null;
    for (const inv of s.invites) {
      if (inv.until <= world.tick || (inv.hostId === agent.id && !inv.proposed)) continue;
      const host = world.agents.find((a) => a.id === inv.hostId);
      if (!host) continue;
      const target = inv.objectUid === obj.uid || (inv.kind === 'grill' && nearGrill(world, objectOf(world, inv.objectUid)!, obj, def));
      if (!target) continue;
      const rel = world.relationships.get(agent.id, host.id);
      const status = statusOf(world, agent.id, host.id);
      const own = inv.hostId === agent.id;
      if (!own && (rel < GROUP_TUNING.INVITE_MIN_SYMPATHY || status === 'rivals' || status === 'enemies')) continue;
      if (dist(agent.pos, host.pos) > GROUP_TUNING.INVITE_RADIUS) continue;
      const warmth = own ? 1.2 : (1 + rel / 100) * (status === 'couple' ? 1.5 : status === 'crush' ? 1.2 : 1);
      const b = { mult: INVITE_BIAS.mult, add: INVITE_BIAS.add * warmth * (inv.kind === 'movie' ? MOVIE_INVITE_FACTOR : 1) };
      if (!best || b.add > best.add) best = b;
    }
    if (best) bias = best;
  }
  if (!def.social) return bias;
  // who is there already (or on the way)
  let avoid = false;
  for (const o of world.agents) {
    if (o === agent || o.action?.kind !== 'use' || o.action.objectUid !== obj.uid) continue;
    const st = statusOf(world, agent.id, o.id);
    if (st === 'couple') bias = combine(bias, PARTNER_BIAS);
    else if (st === 'crush') bias = combine(bias, CRUSH_BIAS);
    else if (st === 'rivals' || st === 'enemies') avoid = true;
  }
  if (avoid) bias = { mult: bias.mult * (1 - (1 - RIVAL_AVOID) * calm), add: 0 };
  return bias;
}

/** talk appeal multiplier for a pair (couples seek each other, rivals avoid each other) */
export function talkStatusFactor(world: World, a: number, b: number): number {
  return TALK_STATUS_FACTOR[statusOf(world, a, b)] ?? 1;
}

function objectOf(world: World, uid: number): ObjectInstance | undefined {
  return world.objects.find((o) => o.uid === uid);
}

function isUsing(a: Agent, uid: number): boolean {
  return a.action?.kind === 'use' && a.action.phase === 'using' && a.action.objectUid === uid;
}

/** everyone taking part in a gathering around `anchor` right now */
function participants(world: World, anchor: ObjectInstance): Agent[] {
  const out = world.agents.filter((a) => isUsing(a, anchor.uid));
  if (anchor.type !== 'grill') return out;
  const gdef = world.objectDefs[anchor.type];
  const c = centre(anchor, gdef);
  for (const a of world.agents) {
    if (out.includes(a)) continue;
    const act = a.action;
    if (act?.kind === 'use' && act.phase === 'using') {
      const obj = objectOf(world, act.objectUid);
      const def = obj && world.objectDefs[obj.type];
      if (obj && def && nearGrill(world, anchor, obj, def)) out.push(a);
    } else if (act?.kind === 'talk' && act.phase === 'talking' && dist(a.pos, c) <= GROUP_TUNING.GRILL_RADIUS) {
      // chatting next to the grill counts too
      out.push(a);
    }
  }
  return out;
}

/** "Ola, Bartek i Kasia" (names are never declined) */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} i ${names[names.length - 1]}`;
}

function describe(kind: GatheringKind, time: GameTime, names: string[]): { label: string; log: string; gossip: string; valence: number } {
  const all = joinNames(names);
  const list = names.join(', ');
  switch (kind) {
    case 'meal': {
      const h = hourOf(time);
      const [label, meal] = h < 11 ? ['Wspólne śniadanie', 'śniadanie'] : h < 16 ? ['Wspólny obiad', 'obiad'] : ['Wspólna kolacja', 'kolację'];
      return { label, log: `${label}: ${list} 🍽️`, gossip: `${all} jedzą razem ${meal}`, valence: 0.4 };
    }
    case 'grill':
      return { label: 'Wspólny grill', log: `Wspólny grill: ${list} 🌭`, gossip: `${all} grillują razem w ogrodzie`, valence: 0.5 };
    case 'movie':
      if (hourOf(time) < MOVIE_FROM && time.hour >= 5)
        return { label: 'Wspólny seans', log: `Wspólny seans: ${list} 📺`, gossip: `${all} oglądają razem serial`, valence: 0.3 };
      return { label: 'Wieczór filmowy', log: `Wieczór filmowy: ${list} 🍿`, gossip: `${all} urządzają wieczór filmowy`, valence: 0.4 };
  }
}

/** detects gatherings, logs new ones and closes finished ones; call once per tick */
export function tickGatherings(world: World): void {
  const s = store(world);
  const time = timeFromTick(world.tick);
  const T = GROUP_TUNING;
  if (s.invites.length > 0) s.invites = s.invites.filter((i) => i.until > world.tick);
  for (const anchor of world.objects) {
    if (anchor.type !== 'dining_table' && anchor.type !== 'grill' && anchor.type !== 'tv') continue;
    const people = participants(world, anchor);
    // someone already there may call the others over (while seats are free)
    if (people.length > 0 && people.length < T.MIN_PARTICIPANTS + 1 && anchor.reservedBy.includes(null)) {
      const caller = people[world.tick % people.length];
      if (isUsing(caller, anchor.uid)) maybeInvite(world, caller, anchor, time, T.CALL_OVER_CHANCE);
    }
    let g = s.active.get(anchor.uid);
    if (!g) {
      if (people.length < T.MIN_PARTICIPANTS) continue;
      const kind = gatheringKind(anchor.type);
      if (!kind) continue;
      g = { objectUid: anchor.uid, kind, startTick: world.tick, ids: new Set(), announced: false, lowSince: null };
      s.active.set(anchor.uid, g);
    }
    for (const p of people) g.ids.add(p.id);
    if (!g.announced) {
      g.announced = true;
      const names = people.map((p) => p.name);
      const d = describe(g.kind, time, names);
      s.total[g.kind]++;
      s.log.push({ tick: world.tick, kind: g.kind, objectUid: anchor.uid, label: d.label, ids: [...g.ids], active: true });
      if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
      const ids = people.map((p) => p.id);
      // everyday meals are logged but not worth retelling (they would crowd memories out)
      pushEvent(world, 'info', d.log, ids, g.kind === 'meal' ? undefined : { text: d.gossip, aboutIds: ids, valence: d.valence });
    } else {
      const rec = s.log.find((r) => r.active && r.objectUid === anchor.uid);
      if (rec) rec.ids = [...g.ids];
    }
    if (people.length >= 2) {
      g.lowSince = null;
      proposeMovie(world, s, g);
    }
    else if (g.lowSince === null) g.lowSince = world.tick;
    else if (world.tick - g.lowSince >= T.END_AFTER) endGathering(world, s, g);
  }
}

/** after a shared dinner someone may suggest a film (host + invitation to the TV) */
function proposeMovie(world: World, s: GroupStore, g: Gathering): void {
  const h = hourOf(timeFromTick(world.tick));
  if (g.proposed || g.kind !== 'meal' || h < MOVIE_PROPOSE[0] || h >= MOVIE_PROPOSE[1]) return;
  if (world.tick - g.startTick < MOVIE_PROPOSE_AFTER) return;
  g.proposed = true;
  const tv = world.objects.find((o) => o.type === 'tv' && o.reservedBy.every((r) => r === null));
  if (!tv || s.invites.some((i) => i.objectUid === tv.uid && i.until > world.tick)) return;
  const candidates = world.agents
    .filter((a) => isUsing(a, g.objectUid))
    .filter((a): a is Agent => !!a && a.needs.energy > 35 && dist(a.pos, centre(tv, world.objectDefs[tv.type])) <= GROUP_TUNING.INVITE_RADIUS);
  if (candidates.length < 2) return;
  const host = candidates.reduce((x, y) => (y.traits.sociability > x.traits.sociability ? y : x));
  if (!world.rng.chance(inviteChance(host) * GROUP_TUNING.MOVIE_PROPOSE_CHANCE)) return;
  s.invites.push({ objectUid: tv.uid, hostId: host.id, kind: 'movie', until: world.tick + GROUP_TUNING.INVITE_WINDOW, proposed: true });
  host.bubble = { kind: 'speech', text: world.rng.pick(['Może jakiś film? 🍿', 'Kto na seans po kolacji? 📺', 'Obejrzymy coś razem? 🍿']), ttl: 25, tone: 'positive' };
}

function endGathering(world: World, s: GroupStore, g: Gathering): void {
  s.active.delete(g.objectUid);
  const rec = s.log.find((r) => r.active && r.objectUid === g.objectUid);
  if (rec) rec.active = false;
  const ids = [...g.ids];
  // a nice evening together brings people a little closer
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const st = statusOf(world, ids[i], ids[j]);
      if (st !== 'rivals' && st !== 'enemies') world.relationships.adjust(ids[i], ids[j], GROUP_TUNING.BOND_BONUS);
    }
}

/** recent gatherings, oldest first (UI / metrics) */
export function gatheringLog(world: World): readonly GatheringRecord[] {
  return stores.get(world)?.log ?? [];
}

/** number of gatherings logged since the world started, per kind */
export function gatheringTotals(world: World): Record<GatheringKind, number> {
  return { ...(stores.get(world)?.total ?? { meal: 0, grill: 0, movie: 0 }) };
}

/** gathering ids (anchor object uid) the agent currently takes part in, if any */
export function gatheringOf(world: World, agentId: number): GatheringRecord | undefined {
  return stores.get(world)?.log.find((r) => r.active && r.ids.includes(agentId));
}

// ---------------------------------------------------------------- competition

/** someone else occupying the thing you set your heart on today is a small friction (per pair, at most this often) */
const COMPETE_COOLDOWN = 240;
const lastCompete = new WeakMap<World, Map<string, number>>();

registerWorldState('groups', {
  save: (world) => {
    const s = stores.get(world);
    const c = lastCompete.get(world);
    return s || c ? { store: s ? toJson(s) : null, compete: c ? toJson(c) : null } : null;
  },
  load: (world, data) => {
    const d = data as { store: Json; compete: Json };
    if (d.store) stores.set(world, fromJson<GroupStore>(d.store));
    if (d.compete) lastCompete.set(world, fromJson<Map<string, number>>(d.compete));
  },
  clear: (world) => {
    stores.delete(world);
    lastCompete.delete(world);
  },
});

/**
 * called when `agent` picks its next activity: objects its daily goal wants but that
 * are fully taken make it a little sore at whoever holds them (more for clashing temperaments)
 */
export function noticeCompetition(world: World, agent: Agent, time: GameTime): void {
  let m = lastCompete.get(world);
  for (const obj of world.objects) {
    if (obj.reservedBy.length === 0 || obj.reservedBy.some((r) => r === null || r === agent.id)) continue;
    if (goalObjectBias(world, agent, obj, time).mult <= 1) continue;
    for (const holder of obj.reservedBy) {
      if (holder === null || !world.agents.some((a) => a.id === holder)) continue;
      const key = agent.id < holder ? `${agent.id}:${holder}` : `${holder}:${agent.id}`;
      if (!m) lastCompete.set(world, (m = new Map()));
      const last = m.get(key);
      if (last !== undefined && world.tick - last < COMPETE_COOLDOWN) continue;
      m.set(key, world.tick);
      recordFriction(world, agent.id, holder, REL_TUNING.RIVAL_COMPETE * (0.5 + clash(world, agent.id, holder)));
    }
  }
}
