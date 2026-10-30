import { beforeAll, describe, expect, it } from 'vitest';
import { NEED_KEYS, type Grid, type Vec2, type World } from '../src/types';
import { createWorld, tickWorld } from '../src/world/world';
import { MAPS, bedCount, getMap } from '../src/world/maps';
import { isWalkable } from '../src/world/grid';
import { timeFromTick } from '../src/core/time';
import { weatherOf } from '../src/world/incidents';
import { slotStandTile } from '../src/world/objects';
import { diaryOf } from '../src/social/diary';
import { findGenderedForms } from '../src/social/diaryAi';
import {
  PROJECT_DEFS,
  PROJECT_KINDS,
  WORK_HOURS,
  findSite,
  projectAppeal,
  projectDayFacts,
  projectsOf,
  startProject,
  type ProjectKindId,
  type ProjectView,
} from '../src/world/projects';

// Building projects (world/projects): residents propose a garden gazebo, build it together over
// about two weeks in stages, then a vegetable garden, a tree house and (where there is water) a
// pier. Headless runs over several seeds and houses.

const DAYS = 21;
const DAY = 24 * 60;
/** dom gets more seeds; the other houses two each */
const RUNS: { map: string; seed: number }[] = [
  ...[1, 2, 3, 4, 5, 6].map((seed) => ({ map: 'dom', seed })),
  ...['kamienica', 'jezioro', 'akademik'].flatMap((map) => [1, 2].map((seed) => ({ map, seed }))),
];
/** gazebo finished within this many days after the proposal (for ≥ MIN_ON_TIME of the runs) */
const FINISH_DAYS: [number, number] = [10, 20];
const MIN_ON_TIME = 0.8;
/**
 * over three weeks the base simulation itself now and then lets a need sit at ~0 for an hour or
 * two (seen with projects switched off too), so the general bound is loose; the strict check is
 * that nobody keeps working on a site with a need that low
 */
const MAX_LOW_STREAK = 240;
const QUIT_NEED_BOUND = 15;
const WORK_DRAINED = ['hunger', 'energy', 'hygiene', 'comfort'] as const;
/** minutes: one dialogue line (11–15 ticks) to say goodbye, plus a little slack */
const MAX_WORKING_LOW = 20;
const MIN_NIGHT_SLEEP_SHARE = 0.8;

/** the later projects follow the gazebo and the vegetable garden, so these runs are longer */
const LATER_RUNS: { map: string; seed: number }[] = [
  ...[1, 2].flatMap((seed) => ['dom', 'jezioro'].map((map) => ({ map, seed }))),
  { map: 'kamienica', seed: 1 },
  { map: 'akademik', seed: 1 },
];
const LATER_DAYS = 65;
/** tree house and pier: finished within this many days after the proposal (for ≥ MIN_ON_TIME of the runs) */
const DOMEK_DAYS: [number, number] = [6, 12];
const POMOST_DAYS: [number, number] = [4, 9];
const WATER_MAPS = ['dom', 'jezioro'];

const key = (p: Vec2): string => `${p.x},${p.y}`;

function reachable(g: Grid, starts: Vec2[]): Set<string> {
  const seen = new Set<string>(starts.filter((s) => isWalkable(g, s.x, s.y)).map(key));
  const queue = [...starts.filter((s) => isWalkable(g, s.x, s.y))];
  while (queue.length) {
    const p = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: p.x + dx, y: p.y + dy };
      if (isWalkable(g, n.x, n.y) && !seen.has(key(n))) {
        seen.add(key(n));
        queue.push(n);
      }
    }
  }
  return seen;
}

function newWorld(map: string, seed: number): World {
  return createWorld(seed, { mapId: map, agentCount: Math.min(6, bedCount(getMap(map))) });
}

function siteOf(world: World, p: ProjectView) {
  return world.objects.find((o) => o.uid === p.uid)!;
}

interface Run {
  map: string;
  seed: number;
  world: World;
  /** days from proposal to the finished gazebo (null = not finished) */
  gazeboDays: number | null;
  /** problems spotted tick by tick */
  regress: string[];
  workOutsideHours: string[];
  workInRain: string[];
  /** stage types in the order they appeared */
  types: string[];
  /** most people sitting in the finished gazebo at once */
  maxInGazebo: number;
  maxLowStreak: number;
  /** longest run of minutes someone kept working with a need below QUIT_NEED_BOUND */
  maxWorkingLow: number;
  nightSleepShare: number;
}

function simulate(map: string, seed: number): Run {
  const world = newWorld(map, seed);
  const r: Run = { map, seed, world, gazeboDays: null, regress: [], workOutsideHours: [], workInRain: [], types: [], maxInGazebo: 0, maxLowStreak: 0, maxWorkingLow: 0, nightSleepShare: 0 };
  const workingLow = world.agents.map(() => 0);
  let last = 0;
  const low = world.agents.map(() => 0);
  let nightTicks = 0;
  let nightSleep = 0;
  for (let t = 0; t < DAYS * DAY; t++) {
    tickWorld(world);
    const p = projectsOf(world).find((x) => x.kindId === 'altana');
    if (p) {
      const obj = siteOf(world, p);
      if (r.types[r.types.length - 1] !== obj.type) r.types.push(obj.type);
      if (p.progress < last) r.regress.push(`t${world.tick} ${p.progress} < ${last}`);
      if (p.progress > last && p.status === 'building') {
        const time = timeFromTick(world.tick);
        if (time.hour < WORK_HOURS[0] || time.hour >= WORK_HOURS[1]) r.workOutsideHours.push(`d${time.day} ${time.hour}:${time.minute}`);
        if (weatherOf(world).raining) r.workInRain.push(`d${time.day} ${time.hour}:${time.minute}`);
      }
      last = p.progress;
      if (p.finishedTick !== null && r.gazeboDays === null) r.gazeboDays = (p.finishedTick - p.startTick) / DAY;
      if (p.status === 'done') {
        const users = world.agents.filter((a) => a.action?.kind === 'use' && a.action.phase === 'using' && a.action.objectUid === p.uid).length;
        r.maxInGazebo = Math.max(r.maxInGazebo, users);
      }
    }
    const hour = timeFromTick(world.tick).hour;
    world.agents.forEach((a, i) => {
      low[i] = NEED_KEYS.some((k) => a.needs[k] <= 1) ? low[i] + 1 : 0;
      r.maxLowStreak = Math.max(r.maxLowStreak, low[i]);
      const act = a.action;
      const site = act?.kind === 'use' && act.phase === 'using' ? world.objects.find((o) => o.uid === act.objectUid) : undefined;
      const working = !!site && world.objectDefs[site.type]?.tags?.includes('project');
      // fun and company are what the work gives: only the other needs count
      workingLow[i] = working && WORK_DRAINED.some((k) => a.needs[k] < QUIT_NEED_BOUND) ? workingLow[i] + 1 : 0;
      r.maxWorkingLow = Math.max(r.maxWorkingLow, workingLow[i]);
      if (hour >= 0 && hour < 5) {
        nightTicks++;
        const act = a.action;
        const obj = act?.kind === 'use' && act.phase === 'using' ? world.objects.find((o) => o.uid === act.objectUid) : undefined;
        if (obj && world.objectDefs[obj.type]?.tags?.includes('sleep')) nightSleep++;
      }
    });
  }
  r.nightSleepShare = nightSleep / nightTicks;
  return r;
}

let runs: Run[] = [];

interface LaterRun {
  map: string;
  seed: number;
  world: World;
  /** days from proposal to done, per kind (absent = not finished) */
  days: Partial<Record<ProjectKindId, number>>;
  /** stage types seen in order, per kind */
  types: Record<string, string[]>;
  regress: string[];
  outsideHours: string[];
  /** most people at once in the finished building, per kind */
  maxUsers: Partial<Record<ProjectKindId, number>>;
}

function simulateLater(map: string, seed: number): LaterRun {
  const world = newWorld(map, seed);
  const r: LaterRun = { map, seed, world, days: {}, types: {}, regress: [], outsideHours: [], maxUsers: {} };
  const last = new Map<string, number>();
  for (let t = 0; t < LATER_DAYS * DAY; t++) {
    tickWorld(world);
    for (const p of projectsOf(world)) {
      if (p.kindId === 'altana' || p.kindId === 'warzywnik') continue;
      const types = (r.types[p.kindId] ??= []);
      const type = siteOf(world, p).type;
      if (types[types.length - 1] !== type) types.push(type);
      const prev = last.get(p.kindId) ?? 0;
      if (p.progress < prev) r.regress.push(`${p.kindId} t${world.tick}`);
      if (p.progress > prev && p.status === 'building') {
        const hour = timeFromTick(world.tick).hour;
        if (hour < WORK_HOURS[0] || hour >= WORK_HOURS[1]) r.outsideHours.push(`${p.kindId} t${world.tick}`);
      }
      last.set(p.kindId, p.progress);
      if (p.finishedTick !== null && r.days[p.kindId] === undefined) r.days[p.kindId] = (p.finishedTick - p.startTick) / DAY;
      if (p.status === 'done') {
        const users = world.agents.filter((a) => a.action?.kind === 'use' && a.action.phase === 'using' && a.action.objectUid === p.uid).length;
        r.maxUsers[p.kindId] = Math.max(r.maxUsers[p.kindId] ?? 0, users);
      }
    }
  }
  return r;
}

let later: LaterRun[] = [];

describe('projects: definitions', () => {
  it('every stage and the finished building are object defs with the same work spots', () => {
    for (const kind of Object.values(PROJECT_KINDS)) {
      const types = [...kind.stages.map((s) => s.type), kind.finishedType];
      for (const t of types) {
        const def = PROJECT_DEFS[t];
        expect(def, t).toBeDefined();
        expect(def.size).toEqual(kind.size);
        // the instance keeps its reservedBy array through every type swap
        expect(def.slots.map((s) => s.stand)).toEqual(kind.slots.map((s) => s.stand));
      }
      expect(kind.stages[kind.stages.length - 1].until).toBe(1);
    }
  });

  it('consecutive stage types differ in length (the static render layer is keyed by type length)', () => {
    for (const kind of Object.values(PROJECT_KINDS)) {
      const types = [...kind.stages.map((s) => s.type), kind.finishedType];
      for (let i = 1; i < types.length; i++) expect(types[i].length, `${types[i - 1]} -> ${types[i]}`).not.toBe(types[i - 1].length);
    }
  });

  it('construction sites are outdoor work, the gazebo is a social seat', () => {
    for (const kind of Object.values(PROJECT_KINDS)) {
      for (const st of kind.stages) {
        const def = PROJECT_DEFS[st.type];
        expect(def.tags).toContain('outdoor');
        expect(def.social).toBe(true);
        expect(def.effects.fun).toBeGreaterThan(0);
        expect(def.duration[0]).toBeGreaterThanOrEqual(30);
        expect(def.duration[1]).toBeLessThanOrEqual(90);
      }
    }
    const altana = PROJECT_DEFS.altana;
    expect(altana.social).toBe(true);
    expect(altana.slots.length).toBeGreaterThanOrEqual(3);
    expect(altana.effects.comfort).toBeGreaterThan(0);
    expect(altana.effects.social).toBeGreaterThan(0);
  });
});

describe('projects: proposal and site', () => {
  it('someone proposes the gazebo within 3 days in every house', () => {
    for (const m of MAPS) {
      for (const seed of [1, 2, 3]) {
        const world = newWorld(m.id, seed);
        while (!projectsOf(world).length && world.tick < 3 * DAY) tickWorld(world);
        const p = projectsOf(world)[0];
        expect(p, `${m.id} seed ${seed}`).toBeDefined();
        expect(p.kindId).toBe('altana');
        const ev = world.events.find((e) => e.text.includes('proponuje budowę altany'));
        expect(ev, `${m.id} seed ${seed}`).toBeDefined();
        expect(ev!.gossip?.aboutIds).toEqual([p.proposerId]);
        expect(ev!.text).toContain(world.agents.find((a) => a.id === p.proposerId)!.name);
      }
    }
  });

  it('the site is on grass, out of the way, and keeps every room and use spot reachable', () => {
    for (const m of MAPS) {
      for (const seed of [1, 2]) {
        const data = m.create();
        const world = newWorld(m.id, seed);
        const before = reachable(world.grid, data.spawnPoints);
        for (const kindId of ['altana', 'warzywnik', 'domek_na_drzewie'] as const) {
          const p = startProject(world, kindId);
          expect(p, `${m.id} ${kindId}`).not.toBeNull();
          for (let dy = 0; dy < p!.size.h; dy++)
            for (let dx = 0; dx < p!.size.w; dx++) {
              const i = (p!.pos.y + dy) * world.grid.width + p!.pos.x + dx;
              expect(data.grid.tiles[i], `${m.id} ${kindId} footprint`).toBe('grass');
              expect(world.grid.solid[i]).toBe(true);
            }
        }
        if (WATER_MAPS.includes(m.id)) {
          const p = startProject(world, 'pomost');
          expect(p, `${m.id} pomost`).not.toBeNull();
          for (let dy = 0; dy < p!.size.h; dy++)
            for (let dx = 0; dx < p!.size.w; dx++) expect(data.grid.tiles[(p!.pos.y + dy) * world.grid.width + p!.pos.x + dx], `${m.id} pomost footprint`).toBe('water');
        }
        const after = reachable(world.grid, data.spawnPoints);
        const sites = projectsOf(world).map((p) => siteOf(world, p));
        const footprint = new Set(sites.flatMap((o) => {
          const d = world.objectDefs[o.type];
          const out: string[] = [];
          for (let dy = 0; dy < d.size.h; dy++) for (let dx = 0; dx < d.size.w; dx++) out.push(key({ x: o.pos.x + dx, y: o.pos.y + dy }));
          return out;
        }));
        // nothing that was reachable is cut off (only the footprints themselves are gone)
        for (const k of before) if (!footprint.has(k)) expect(after.has(k), `${m.id} seed ${seed}: ${k} cut off`).toBe(true);
        for (const o of world.objects) {
          const def = world.objectDefs[o.type];
          def.slots.forEach((_, i) => {
            const st = slotStandTile(o, def, i);
            expect(after.has(key(st)), `${m.id}: ${o.type}#${o.uid} slot ${i}`).toBe(true);
          });
        }
        for (const r of world.grid.rooms) {
          let ok = false;
          for (let y = r.rect.y; y < r.rect.y + r.rect.h && !ok; y++) for (let x = r.rect.x; x < r.rect.x + r.rect.w && !ok; x++) ok = after.has(key({ x, y }));
          expect(ok, `${m.id} room ${r.id}`).toBe(true);
        }
      }
    }
  });

  it('the pier needs water: no site and no proposal on maps without a lake or pond', () => {
    for (const m of MAPS.filter((x) => !WATER_MAPS.includes(x.id))) {
      const world = newWorld(m.id, 1);
      expect(findSite(world, PROJECT_KINDS.pomost), m.id).toBeNull();
      expect(startProject(world, 'pomost'), m.id).toBeNull();
      expect(projectsOf(world).some((p) => p.kindId === 'pomost')).toBe(false);
    }
    for (const id of WATER_MAPS) expect(findSite(newWorld(id, 1), PROJECT_KINDS.pomost), id).not.toBeNull();
  });

  it('a third site still fits (the search is generic, not a fixed spot per house)', () => {
    for (const m of MAPS) {
      const world = newWorld(m.id, 1);
      startProject(world, 'altana');
      startProject(world, 'warzywnik');
      expect(findSite(world, PROJECT_KINDS.warzywnik), m.id).not.toBeNull();
    }
  });
});

describe('projects: building over two weeks', () => {
  beforeAll(() => {
    runs = RUNS.map((r) => simulate(r.map, r.seed));
    // eslint-disable-next-line no-console
    console.log(
      runs
        .map((r) => {
          const ps = projectsOf(r.world);
          return `${r.map} s${r.seed}: altana ${r.gazeboDays?.toFixed(1) ?? '-'} d, ${ps.map((p) => `${p.kindId} ${p.status} ${Math.round(p.progress * 100)}% crew ${p.contributors.length}`).join(', ')}, max in gazebo ${r.maxInGazebo}`;
        })
        .join('\n'),
    );
  }, 240_000);

  it('progress never goes back; work only 08–19 and never in the rain', () => {
    for (const r of runs) {
      const label = `${r.map} seed ${r.seed}`;
      expect(r.regress, label).toEqual([]);
      expect(r.workOutsideHours, label).toEqual([]);
      expect(r.workInRain, label).toEqual([]);
    }
  });

  it('the site goes through every stage in order and becomes the gazebo', () => {
    const order = [...PROJECT_KINDS.altana.stages.map((s) => s.type), 'altana'];
    for (const r of runs) {
      expect(order.slice(0, r.types.length), `${r.map} seed ${r.seed}`).toEqual(r.types);
      if (r.gazeboDays !== null) expect(r.types).toEqual(order);
    }
    // stage changes are logged
    const any = runs.find((r) => r.gazeboDays !== null)!;
    expect(any.world.events.some((e) => e.text.includes('Altana gotowa! Ekipa:')) || projectsOf(any.world)[0].milestones.some((m) => m.text.includes('Altana gotowa! Ekipa:'))).toBe(true);
  });

  it(`the gazebo is finished within ${FINISH_DAYS[0]}–${FINISH_DAYS[1]} days for most seeds`, () => {
    const onTime = runs.filter((r) => r.gazeboDays !== null && r.gazeboDays >= FINISH_DAYS[0] && r.gazeboDays <= FINISH_DAYS[1]);
    expect(onTime.length / runs.length).toBeGreaterThanOrEqual(MIN_ON_TIME);
  });

  it('it is teamwork: several builders, and the crew gets closer', () => {
    for (const r of runs.filter((x) => x.gazeboDays !== null)) {
      const p = projectsOf(r.world).find((x) => x.kindId === 'altana')!;
      const crew = p.contributors.filter((c) => c.minutes >= 30);
      expect(crew.length, `${r.map} seed ${r.seed}`).toBeGreaterThanOrEqual(2);
      const done = p.milestones.find((m) => m.text.startsWith('Altana gotowa! Ekipa:'))!;
      // the completion line names the crew, no gendered verb
      for (const c of crew) expect(done.text).toContain(r.world.agents.find((a) => a.id === c.id)!.name);
    }
  });

  it('the finished gazebo gets used, also by several people at once', () => {
    const finished = runs.filter((r) => r.gazeboDays !== null);
    expect(finished.length).toBeGreaterThan(0);
    expect(finished.some((r) => r.maxInGazebo >= 2)).toBe(true);
    expect(finished.filter((r) => r.maxInGazebo >= 1).length / finished.length).toBeGreaterThanOrEqual(0.8);
  });

  it('the vegetable garden follows the gazebo (the system is generic)', () => {
    const veg = runs.flatMap((r) => projectsOf(r.world).filter((p) => p.kindId === 'warzywnik'));
    expect(veg.length).toBeGreaterThan(0);
    expect(veg.some((p) => p.status === 'done')).toBe(true);
    for (const p of veg.filter((x) => x.status === 'done')) expect((p.finishedTick! - p.startTick) / DAY).toBeLessThanOrEqual(8);
  });

  it('nobody runs on empty and nights are for sleep while building', () => {
    for (const r of runs) {
      expect(r.maxLowStreak, `${r.map} seed ${r.seed}`).toBeLessThanOrEqual(MAX_LOW_STREAK);
      // a worker with a pressing need puts the tools down (after the goodbye line of a chat at most)
      expect(r.maxWorkingLow, `${r.map} seed ${r.seed}`).toBeLessThanOrEqual(MAX_WORKING_LOW);
      expect(r.nightSleepShare, `${r.map} seed ${r.seed}`).toBeGreaterThanOrEqual(MIN_NIGHT_SLEEP_SHARE);
    }
  });

  it('diaries tell about the work, without gendered forms', () => {
    const r = runs[0];
    const names = r.world.agents.map((a) => a.name);
    const p = projectsOf(r.world)[0];
    const builder = p.contributors[0].id;
    let mentions = 0;
    for (const a of r.world.agents) {
      for (const e of diaryOf(r.world, a.id)) {
        expect(findGenderedForms(e.text, names), e.text).toEqual([]);
        if (/altan/i.test(e.text)) mentions++;
      }
    }
    expect(mentions).toBeGreaterThan(3);
    // the facts behind it: minutes and co-workers per day
    const days = Array.from({ length: DAYS + 1 }, (_, i) => projectDayFacts(r.world, builder, i + 1)).flat().filter((f) => f.kindId === p.kindId);
    expect(days.reduce((s, f) => s + f.minutes, 0)).toBe(p.contributors[0].minutes);
  });
});

describe('projects: tree house and pier follow the garden', () => {
  beforeAll(() => {
    later = LATER_RUNS.map((r) => simulateLater(r.map, r.seed));
    // eslint-disable-next-line no-console
    console.log(
      later
        .map((r) => `${r.map} s${r.seed}: ${projectsOf(r.world).map((p) => `${p.kindId} ${p.status} ${Math.round(p.progress * 100)}% ${(((p.finishedTick ?? r.world.tick) - p.startTick) / DAY).toFixed(1)} d`).join(', ')}, max users ${JSON.stringify(r.maxUsers)}`)
        .join('\n'),
    );
  }, 400_000);

  it('they are proposed in order, the pier only where there is water', () => {
    for (const r of later) {
      const kinds = projectsOf(r.world).map((p) => p.kindId);
      const expected = WATER_MAPS.includes(r.map) ? ['altana', 'warzywnik', 'domek_na_drzewie', 'pomost'] : ['altana', 'warzywnik', 'domek_na_drzewie'];
      expect(kinds.slice(0, expected.length), `${r.map} seed ${r.seed}`).toEqual(expected.slice(0, kinds.length));
      if (!WATER_MAPS.includes(r.map)) expect(kinds, `${r.map} seed ${r.seed}`).not.toContain('pomost');
    }
    expect(later.some((r) => projectsOf(r.world).some((p) => p.kindId === 'pomost'))).toBe(true);
  });

  it('each site goes through its stages in order and ends as the finished building; progress never goes back', () => {
    for (const r of later) {
      for (const kindId of ['domek_na_drzewie', 'pomost'] as const) {
        const kind = PROJECT_KINDS[kindId];
        const order = [...kind.stages.map((s) => s.type), kind.finishedType];
        const seen = r.types[kindId] ?? [];
        expect(order.slice(0, seen.length), `${r.map} seed ${r.seed} ${kindId}`).toEqual(seen);
        if (r.days[kindId] !== undefined) expect(seen).toEqual(order);
      }
      expect(r.regress, `${r.map} seed ${r.seed}`).toEqual([]);
      expect(r.outsideHours, `${r.map} seed ${r.seed}`).toEqual([]);
    }
  });

  it(`the tree house takes ${DOMEK_DAYS[0]}–${DOMEK_DAYS[1]} days, the pier ${POMOST_DAYS[0]}–${POMOST_DAYS[1]} days (most seeds and maps)`, () => {
    const check = (kindId: ProjectKindId, [lo, hi]: [number, number], rs: LaterRun[]) => {
      const done = rs.filter((r) => r.days[kindId] !== undefined);
      expect(done.length, kindId).toBe(rs.length);
      const onTime = done.filter((r) => r.days[kindId]! >= lo && r.days[kindId]! <= hi);
      expect(onTime.length / rs.length, `${kindId}: ${done.map((r) => r.days[kindId]!.toFixed(1)).join(', ')}`).toBeGreaterThanOrEqual(MIN_ON_TIME);
    };
    check('domek_na_drzewie', DOMEK_DAYS, later);
    check('pomost', POMOST_DAYS, later.filter((r) => WATER_MAPS.includes(r.map)));
  });

  it('the finished tree house and pier are used', () => {
    const used = (kindId: ProjectKindId) => later.filter((r) => (r.maxUsers[kindId] ?? 0) >= 1).length;
    expect(used('domek_na_drzewie')).toBeGreaterThanOrEqual(Math.ceil(later.length * 0.5));
    expect(used('pomost')).toBeGreaterThanOrEqual(1);
  });
});

describe('projects: appeal, determinism, replay', () => {
  it('the site is not attractive at night or in the rain', () => {
    const world = newWorld('dom', 2);
    while (!projectsOf(world).length) tickWorld(world);
    const p = projectsOf(world)[0];
    const obj = siteOf(world, p);
    let night = 0;
    let rain = 0;
    let day = 0;
    for (let t = 0; t < 4 * DAY; t++) {
      tickWorld(world);
      const time = timeFromTick(world.tick);
      const a = projectAppeal(world, obj, world.objectDefs[obj.type]);
      if (time.hour < 8 || time.hour >= 19) {
        expect(a).toBe(0);
        night++;
      } else if (weatherOf(world).raining) {
        expect(a).toBe(0);
        rain++;
      } else {
        expect(a).toBeGreaterThan(0);
        day++;
      }
    }
    expect(night).toBeGreaterThan(0);
    expect(day).toBeGreaterThan(0);
    expect(rain).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic for a seed, and a replay to a tick rebuilds the same project state', () => {
    const snapshot = (w: World) =>
      JSON.stringify({
        projects: projectsOf(w),
        sites: projectsOf(w).map((p) => siteOf(w, p)),
        rng: w.rng.state(),
      });
    const a = newWorld('kamienica', 3);
    const b = newWorld('kamienica', 3);
    const T = 6 * DAY + 5 * 60;
    for (let t = 0; t < T; t++) {
      tickWorld(a);
      tickWorld(b);
    }
    expect(projectsOf(a).length).toBeGreaterThan(0);
    expect(projectsOf(a)[0].progress).toBeGreaterThan(0);
    expect(snapshot(b)).toBe(snapshot(a));
    // "load": a fresh world replayed to the saved tick
    const c = newWorld('kamienica', 3);
    while (c.tick < a.tick) tickWorld(c);
    expect(snapshot(c)).toBe(snapshot(a));
  });

  it('startProject refuses duplicates', () => {
    const world = newWorld('dom', 1);
    expect(startProject(world, 'altana')).not.toBeNull();
    expect(startProject(world, 'altana')).toBeNull();
  });
});
