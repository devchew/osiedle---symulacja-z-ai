import { describe, expect, it } from 'vitest';
import type { Agent, ObjectInstance, World } from '../src/types';
import { NEED_KEYS } from '../src/types';
import { createWorld, tickWorld } from '../src/world/world';
import { timeFromTick } from '../src/core/time';
import { slotStandTile } from '../src/world/objects';
import { setWeatherOverride } from '../src/world/incidents';
import { traceOf } from '../src/world/trace';
import { findPath } from '../src/agents/pathfinding';
import { endAction } from '../src/agents/actions';
import { scoreCandidates } from '../src/agents/brain';
import {
  JOINT_TOPIC,
  JOINT_TUNING,
  fishWord,
  jointKindOf,
  jointLog,
  jointMemberOf,
  jointSessions,
  jointTaste,
  jointViewOf,
  jointWindow,
  onJointHeadingTo,
  type JointKind,
} from '../src/agents/joint';
import { JOINT_LINES, TOPIC_LINES } from '../src/social/dialogueProvider';

// Joint activities (src/agents/joint.ts): invitations, gathering, one shared end, outcomes.

const TYPE: Record<JointKind, string> = { console: 'console', boardgame: 'board_game_table', fishing: 'fishing_spot' };
/** 15:00 (console / cards) and 09:30 (fishing): inside the activity windows, away from meals */
const START: Record<JointKind, number> = { console: 8 * 60, boardgame: 8 * 60, fishing: 150 };

interface Setup {
  world: World;
  host: Agent;
  obj: ObjectInstance;
}

function prepare(seed: number, kind: JointKind, agentCount = 6, hostSociability = 0.2): Setup {
  const world = createWorld(seed, { mapId: 'dom', agentCount });
  setWeatherOverride(world, () => ({ kind: 'sunny', intensity: 0 }));
  world.tick = START[kind];
  for (const a of world.agents) {
    for (const k of NEED_KEYS) a.needs[k] = 85;
    // cheerful, alike housemates: no quarrels in these tests
    a.traits = { sociability: 0.2, activity: 0, neatness: 0, cheerfulness: 0.6 };
  }
  for (let i = 0; i < world.agents.length; i++)
    for (let j = i + 1; j < world.agents.length; j++) world.relationships.adjust(world.agents[i].id, world.agents[j].id, 60);
  const host = world.agents[0];
  host.traits.sociability = hostSociability;
  // fishing: the middle spot of the trio on the south shore of the pond (33..35, 17)
  const obj =
    kind === 'fishing'
      ? world.objects.find((o) => o.type === 'fishing_spot' && o.pos.x === 34 && o.pos.y === 17)!
      : world.objects.find((o) => o.type === TYPE[kind])!;
  return { world, host, obj };
}

/** the host sets off to `obj` (as tryStart does) and maybe invites people */
function headTo({ world, host, obj }: Setup): void {
  const def = world.objectDefs[obj.type];
  obj.reservedBy[0] = host.id;
  host.path = findPath(world.grid, host.pos, slotStandTile(obj, def, 0))!;
  host.action = { kind: 'use', phase: 'walking', objectUid: obj.uid, slot: 0, ticksLeft: 40, label: '', icon: def.icon };
  onJointHeadingTo(world, host, obj, timeFromTick(world.tick), endAction);
}

/** first seed (deterministic) where at least `members` people are in the session after the invitations */
function session(kind: JointKind, members = 2, hostSociability = 0.2): Setup {
  for (let seed = 1; seed < 60; seed++) {
    const s = prepare(seed, kind, 6, hostSociability);
    headTo(s);
    const v = jointSessions(s.world)[0];
    if (v && v.memberIds.length >= members) return s;
  }
  throw new Error(`no ${kind} session with ${members} members`);
}

function runUntil(world: World, pred: () => boolean, max = 400): number {
  for (let i = 0; i < max; i++) {
    if (pred()) return i;
    tickWorld(world);
  }
  throw new Error('condition not reached');
}

/** the session hosted by `host` (other residents may start their own meanwhile) */
const mine = (w: World, host: Agent) => jointSessions(w).find((x) => x.hostId === host.id);
const playing = (w: World, host: Agent) => mine(w, host)?.phase === 'playing';
const over = (w: World, host: Agent) => !mine(w, host);
const record = (w: World, host: Agent) => jointLog(w).filter((r) => r.hostId === host.id).at(-1)!;
const usingObj = (a: Agent, uids: number[]) => a.action?.kind === 'use' && uids.includes(a.action.objectUid);

describe('joint activities: catalogue', () => {
  it('knows its objects and fits sessions between meals and before bedtime', () => {
    expect(jointKindOf('console')).toBe('console');
    expect(jointKindOf('board_game_table')).toBe('boardgame');
    expect(jointKindOf('fishing_spot')).toBe('fishing');
    expect(jointKindOf('tv')).toBeNull();
    // 15:00 → a little before dinner (17:00), when shared meals and grills start
    expect(jointWindow('console', timeFromTick(8 * 60))).toBeGreaterThanOrEqual(120);
    expect(jointWindow('console', timeFromTick(8 * 60))).toBeLessThanOrEqual(130);
    // during lunch: eat first
    expect(jointWindow('boardgame', timeFromTick(5.5 * 60))).toBe(0);
    // no fishing in the dark, consoles until late evening
    expect(jointWindow('fishing', timeFromTick(14 * 60))).toBe(0);
    expect(jointWindow('console', timeFromTick(14 * 60))).toBeGreaterThan(60);
    expect(fishWord(1)).toBe('ryba');
    expect(fishWord(3)).toBe('ryby');
    expect(fishWord(5)).toBe('ryb');
    expect(fishWord(22)).toBe('ryby');
  });

  it('personality: introverts like fishing, extroverts the console', () => {
    const intro = { sociability: -0.9, activity: 0, neatness: 0, cheerfulness: 0 };
    const extro = { sociability: 0.9, activity: 0, neatness: 0, cheerfulness: 0 };
    expect(jointTaste('fishing', intro)).toBeGreaterThan(jointTaste('fishing', extro));
    expect(jointTaste('boardgame', intro)).toBeGreaterThan(jointTaste('boardgame', extro));
    expect(jointTaste('console', extro)).toBeGreaterThan(jointTaste('console', intro));
  });

  it('friends around make a console far more attractive than alone', () => {
    const together = prepare(1, 'console');
    const alone = prepare(1, 'console', 1);
    const score = (w: World) => {
      const c = w.objects.find((o) => o.type === 'console')!;
      const d = scoreCandidates(w, w.agents[0], timeFromTick(w.tick)).find((x) => x.kind === 'use' && x.objectUid === c.uid);
      return d?.score ?? 0;
    };
    expect(score(together.world)).toBeGreaterThan(score(alone.world) * 1.5);
  });

  it('dialogue lines are short and avoid gendered past tense', () => {
    const all: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') all.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(JOINT_LINES);
    for (const topic of Object.values(JOINT_TOPIC)) walk(TOPIC_LINES[topic]);
    expect(all.length).toBeGreaterThan(50);
    for (const t of all) {
      expect(t.length, t).toBeLessThanOrEqual(70);
      expect(t, t).not.toMatch(/\p{L}{2,}(łem|łam|łeś|łaś|ła|ło|ły)(?!\p{L})|\p{L}+[aeiy]li(?!\p{L})/u);
    }
  });
});

describe('joint activities: a session', () => {
  it('invites friends, who drop what they do and walk over', () => {
    const { world, host, obj } = session('console', 2);
    const v = mine(world, host)!;
    expect(v.kind).toBe('console');
    expect(v.phase).toBe('gathering');
    expect(v.hostId).toBe(host.id);
    for (const id of v.memberIds.filter((x) => x !== host.id)) {
      const a = world.agents.find((x) => x.id === id)!;
      expect(a.action?.kind).toBe('use');
      expect(usingObj(a, [obj.uid])).toBe(true);
      expect(obj.reservedBy).toContain(a.id);
      expect(jointMemberOf(world, a)?.phase).toBe('gathering');
    }
    const kinds = traceOf(world).map((e) => e.kind);
    expect(kinds).toContain('invite');
    expect(kinds).toContain('accept');
  });

  it('starts once two have arrived, with ONE shared length, and they end together', () => {
    const { world, obj, host } = session('console', 2);
    runUntil(world, () => playing(world, host));
    const v = mine(world, host)!;
    const len = v.endTick! - v.startTick!;
    expect(len).toBeGreaterThanOrEqual(JOINT_TUNING.MIN_DURATION);
    expect(len).toBeLessThanOrEqual(JOINT_TUNING.DURATION.console[1]);
    const ids = v.memberIds;
    const members = world.agents.filter((a) => ids.includes(a.id));
    const ends = new Map<number, number>();
    // everyone present counts down the same clock (late arrivals join it) and nobody leaves early
    runUntil(
      world,
      () => {
        const here = members.filter((a) => a.action?.kind === 'use' && a.action.phase === 'using' && usingObj(a, [obj.uid]));
        const left = new Set(here.map((a) => (a.action as { ticksLeft: number }).ticksLeft));
        if (here.length >= 2) expect(left.size, `tick ${world.tick}`).toBe(1);
        for (const a of members) if (!ends.has(a.id) && !usingObj(a, [obj.uid])) ends.set(a.id, world.tick);
        return over(world, host);
      },
      300,
    );
    expect(new Set(ends.values()).size).toBe(1);
    const rec = record(world, host);
    expect(rec.happened).toBe(true);
    expect(rec.minutes).toBe(len);
    expect(rec.ids.length).toBeGreaterThanOrEqual(2);
    expect(rec.text).toMatch(/^Wspólne granie \(/);
    expect(world.events.some((e) => e.text === rec.text)).toBe(true);
  });

  it('outcomes: a log line, friends grow closer, a score badge while playing', () => {
    const { world, host } = session('boardgame', 2);
    const v0 = mine(world, host)!;
    const pairs = (ids: number[]) => ids.flatMap((a, i) => ids.slice(i + 1).map((b) => world.relationships.get(a, b)));
    runUntil(world, () => playing(world, host));
    const ids = mine(world, host)!.memberIds;
    const before = pairs(ids);
    // the badge is drawn once per group, above the players
    const players = world.agents.filter((a) => ids.includes(a.id));
    runUntil(world, () => players.some((a) => jointViewOf(a)?.badge));
    const badges = players.map((a) => jointViewOf(a)?.badge).filter(Boolean);
    expect(badges).toHaveLength(1);
    expect(badges[0]!.text).toMatch(/^(♟️|🃏|🎲) \d+(:\d+)+$/);
    runUntil(world, () => over(world, host), 300);
    const rec = record(world, host);
    expect(rec.text).toMatch(/^Wspólna gra \((szachy|karty|Eurobiznes), /);
    expect(rec.text).toMatch(/wygrywa|magnatem|remis/);
    const after = pairs(ids);
    after.forEach((v, i) => expect(v).toBeGreaterThan(before[i]));
    expect(v0.memberIds.length).toBeGreaterThanOrEqual(2);
    // no badges after the end
    expect(players.some((a) => jointViewOf(a))).toBe(false);
  });

  it('a critical need takes one player away; the others play on while two remain', () => {
    const { world, obj, host } = session('console', 3, 1);
    runUntil(world, () => playing(world, host) && mine(world, host)!.hereIds.length >= 3);
    const v = mine(world, host)!;
    const end = v.endTick!;
    runUntil(world, () => world.tick >= v.startTick! + 15);
    const quitter = world.agents.find((a) => a.id === v.hereIds[v.hereIds.length - 1])!;
    for (const k of NEED_KEYS) quitter.needs[k] = 95;
    quitter.needs.hunger = 2;
    runUntil(world, () => !usingObj(quitter, [obj.uid]), 5);
    const left = mine(world, host)!;
    expect(left.memberIds).not.toContain(quitter.id);
    expect(left.hereIds.length).toBeGreaterThanOrEqual(2);
    expect(left.endTick).toBe(end);
    // with one player left the session is over for them too
    const last = world.agents.find((a) => a.id === left.hereIds[0])!;
    for (const id of left.memberIds) if (id !== last.id) endAction(world, world.agents.find((a) => a.id === id)!, 'test');
    tickWorld(world);
    expect(over(world, host)).toBe(true);
    expect(usingObj(last, [obj.uid])).toBe(false);
    expect(record(world, host).happened).toBe(true);
  });

  it('rain ends a fishing session for everybody', () => {
    const { world, host } = session('fishing', 2);
    runUntil(world, () => playing(world, host));
    const ids = mine(world, host)!.memberIds;
    runUntil(world, () => world.tick >= mine(world, host)!.startTick! + 20);
    setWeatherOverride(world, () => ({ kind: 'rain', intensity: 0.9 }));
    const ticks = runUntil(world, () => over(world, host), 30);
    expect(ticks).toBeLessThanOrEqual(12);
    const rec = record(world, host);
    expect(rec.kind).toBe('fishing');
    expect(rec.text).toMatch(/^Wspólne wędkowanie: .* deszcz przerywa/);
    for (const id of ids) {
      const a = world.agents.find((x) => x.id === id)!;
      expect(a.action?.kind === 'use' && world.objects.find((o) => o.uid === (a.action as { objectUid: number }).objectUid)?.type === 'fishing_spot').toBe(false);
    }
  });

  it('fishing partners take the neighbouring spots', () => {
    const { world, obj, host } = session('fishing', 2);
    const v = mine(world, host)!;
    for (const id of v.memberIds) {
      const a = world.agents.find((x) => x.id === id)!;
      const spot = world.objects.find((o) => o.uid === (a.action as { objectUid: number }).objectUid)!;
      expect(spot.type).toBe('fishing_spot');
      expect(Math.hypot(spot.pos.x - obj.pos.x, spot.pos.y - obj.pos.y)).toBeLessThanOrEqual(JOINT_TUNING.FISH_RADIUS);
    }
  });

  it('a hungry friend says no, with a reason', () => {
    for (let seed = 1; seed < 30; seed++) {
      const s = prepare(seed, 'console', 2);
      const friend = s.world.agents[1];
      friend.needs.hunger = 20;
      headTo(s);
      expect(jointSessions(s.world)).toHaveLength(0);
      const refuse = traceOf(s.world).find((e) => e.kind === 'refuse' && e.agentId === friend.id);
      expect(refuse?.text).toContain(JOINT_LINES.refuseHungry);
      expect(friend.bubble?.text).toBe(JOINT_LINES.refuseHungry);
      return;
    }
  });

  it('when the others drop out, the one there carries on alone (normal length)', () => {
    for (let seed = 1; seed < 40; seed++) {
      const s = prepare(seed, 'console', 2);
      headTo(s);
      if (jointSessions(s.world).length === 0) continue;
      const friend = s.world.agents[1];
      endAction(s.world, friend, 'test: changes plans');
      runUntil(s.world, () => jointSessions(s.world).length === 0, 5);
      const rec = jointLog(s.world).at(-1)!;
      expect(rec.happened).toBe(false);
      runUntil(s.world, () => s.host.action?.kind === 'use' && s.host.action.phase === 'using', 200);
      const a = s.host.action as { ticksLeft: number };
      expect(a.ticksLeft).toBeLessThanOrEqual(s.world.objectDefs.console.duration[1]);
      return;
    }
    throw new Error('no session formed');
  });

  it('is deterministic for a seed', () => {
    const run = () => {
      const w = createWorld(3);
      for (let i = 0; i < 2 * 24 * 60; i++) tickWorld(w);
      return { log: jointLog(w).map((r) => `${r.start}-${r.end} ${r.text}`), rng: w.rng.state() };
    };
    const a = run();
    expect(a.log.length).toBeGreaterThan(0);
    expect(run()).toEqual(a);
  });
});
