import { describe, expect, it } from 'vitest';
import type { World } from '../src/types';
import { createWorld, tickWorld } from '../src/world/world';
import {
  NETWORK_SNAPSHOT,
  applySnapshot,
  SNAPSHOT_VERSION,
  SnapshotVersionError,
  registeredWorldStates,
  restoreWorld,
  snapshotWorld,
  type SnapshotOptions,
  type WorldSnapshot,
} from '../src/core/state';
import { createRng } from '../src/core/rng';
import { jointGroups, jointLog } from '../src/agents/joint';
import { gatheringLog } from '../src/agents/groups';
import { goalHistory } from '../src/agents/goals';
import { bedOf } from '../src/agents/home';
import { projectsOf } from '../src/world/projects';
import { brokenObjects, weatherOf } from '../src/world/incidents';
import { traceOf } from '../src/world/trace';
import { diaryOf, onDiaryChange } from '../src/social/diary';
import { agentMemories } from '../src/social/memory';
import { statusOf } from '../src/social/relationships';
import { mapIdOf } from '../src/world/maps';
import { currentHeadline } from '../src/world/news';
import { petsOf } from '../src/agents/pets';

const DAY = 24 * 60;

/** state modules every snapshot must carry (actions.ts registers 'actions' — pasted after wave 10 movement work) */
const REQUIRED_MODULES = [
  'actions',
  'movement',
  'map',
  'home',
  'brain',
  'goals',
  'narration',
  'joint',
  'groups',
  'relationships',
  'memory',
  'incidents',
  'projects',
  'news',
  'trace',
  'diary',
  'pets',
];

const roundTrip = (snap: WorldSnapshot): WorldSnapshot => JSON.parse(JSON.stringify(snap)) as WorldSnapshot;

/** section-by-section comparison of two snapshots, with readable failure labels */
function expectSameSnapshot(a: WorldSnapshot, b: WorldSnapshot, label: string): void {
  const { modules: ma, ...ra } = a;
  const { modules: mb, ...rb } = b;
  for (const k of Object.keys(ra) as (keyof typeof ra)[]) expect(rb[k], `${label}: ${k}`).toEqual(ra[k]);
  expect(Object.keys(mb), `${label}: module keys`).toEqual(Object.keys(ma));
  for (const k of Object.keys(ma)) expect(mb[k], `${label}: modules.${k}`).toEqual(ma[k]);
}

/** the same world through public read APIs (independent of the snapshot codecs) */
function publicView(world: World) {
  return {
    tick: world.tick,
    rng: world.rng.state(),
    agents: world.agents.map((a) => ({ ...a, bed: bedOf(a), goals: goalHistory(a) })),
    objects: world.objects,
    events: world.events,
    rel: world.relationships.all(),
    status: world.agents.flatMap((a) => world.agents.filter((b) => b.id > a.id).map((b) => statusOf(world, a.id, b.id))),
    memories: world.agents.map((a) => agentMemories(world, a.id)),
    diaries: world.agents.map((a) => diaryOf(world, a.id)),
    projects: projectsOf(world),
    weather: weatherOf(world),
    broken: brokenObjects(world),
    joint: jointLog(world),
    gatherings: gatheringLog(world),
    headline: currentHeadline(world),
    map: mapIdOf(world),
    pets: petsOf(world),
  };
}

function run(world: World, ticks: number): World {
  for (let i = 0; i < ticks; i++) tickWorld(world);
  return world;
}

type Scenario = { name: string; when: (w: World) => boolean };

const SCENARIOS: Scenario[] = [
  { name: 'day 1 morning', when: (w) => w.tick === 60 },
  { name: 'mid conversation', when: (w) => w.conversations.some((c) => c.lines.length >= 1 && c.lines.length < c.maxLines) },
  { name: 'mid joint session', when: (w) => jointGroups(w).length > 0 },
  {
    name: 'mid construction',
    when: (w) =>
      projectsOf(w).some((p) => p.status === 'building' && w.agents.some((a) => a.action?.kind === 'use' && a.action.phase === 'using' && a.action.objectUid === p.uid)),
  },
  { name: 'during rain', when: (w) => weatherOf(w).raining },
  { name: 'during a breakdown repair', when: (w) => brokenObjects(w).some((b) => b.repairerIds.length > 0) },
];

describe('world snapshots: registry and format', () => {
  it('every stateful module is registered', () => {
    createWorld(1);
    const keys = registeredWorldStates();
    for (const k of REQUIRED_MODULES) expect(keys, `module "${k}" registered`).toContain(k);
  });

  it('is plain JSON (no Maps, functions or undefined) and survives a JSON round trip', () => {
    const w = run(createWorld(4), DAY + 300);
    const snap = snapshotWorld(w, { includeTrace: true });
    expect(roundTrip(snap)).toStrictEqual(snap);
    expect(snap.version).toBe(SNAPSHOT_VERSION);
    expect(snap.mapId).toBe('dom');
  });

  it('restore → snapshot gives the same snapshot (no identity, no aliasing)', () => {
    for (const opts of [{}, { includeTrace: true }, NETWORK_SNAPSHOT] as SnapshotOptions[]) {
      const w = run(createWorld(9, { mapId: 'jezioro' }), 2 * DAY + 77);
      const snap = roundTrip(snapshotWorld(w, opts));
      const copy = roundTrip(snap);
      const r1 = restoreWorld(snap);
      expectSameSnapshot(snap, snapshotWorld(r1, opts), 'restored');
      // ticking a restored world must not touch the snapshot it came from
      run(r1, 200);
      expect(snap).toEqual(copy);
      expect(mapIdOf(restoreWorld(snap))).toBe('jezioro');
    }
  });

  it('rejects other versions and other module sets with SnapshotVersionError', () => {
    const snap = roundTrip(snapshotWorld(run(createWorld(2), 30)));
    expect(() => restoreWorld({ ...snap, version: SNAPSHOT_VERSION + 1 })).toThrow(SnapshotVersionError);
    expect(() => restoreWorld({ ...snap, version: SNAPSHOT_VERSION + 1 })).toThrow(/version/);
    expect(() => restoreWorld({ ...snap, modules: { ...snap.modules, bogus: 1 } })).toThrow(SnapshotVersionError);
    const { diary: _drop, ...noDiary } = snap.modules;
    expect(() => restoreWorld({ ...snap, modules: noDiary })).toThrow(/missing: diary/);
    expect(() => restoreWorld({ foo: 1 } as unknown as WorldSnapshot)).toThrow(SnapshotVersionError);
  });

  it('rng state can be restored', () => {
    const a = createRng(77);
    for (let i = 0; i < 10; i++) a.next();
    const b = createRng(77, a.state());
    const c = createRng(1);
    c.setState!(a.state());
    const seq = [a.next(), a.next(), a.next()];
    expect([b.next(), b.next(), b.next()]).toEqual(seq);
    expect([c.next(), c.next(), c.next()]).toEqual(seq);
  });
});

describe('world snapshots: determinism (restore then tick = tick the original)', () => {
  const AFTER = DAY;
  const HORIZON = 4 * DAY;

  for (const seed of [3, 7, 12]) {
    it(`seed ${seed}: restored worlds stay identical at every scenario`, () => {
      const world = createWorld(seed);
      const pending: { name: string; due: number; restored: World }[] = [];
      const found = new Set<string>();
      for (let t = 0; t < HORIZON + AFTER; t++) {
        if (world.tick < HORIZON) {
          for (const sc of SCENARIOS) {
            if (found.has(sc.name) || !sc.when(world)) continue;
            found.add(sc.name);
            // through JSON, as it would come from disk / the network
            const restored = restoreWorld(roundTrip(snapshotWorld(world)));
            pending.push({ name: sc.name, due: world.tick + AFTER, restored });
          }
        }
        tickWorld(world);
        for (const p of pending) {
          if (p.due < 0) continue;
          tickWorld(p.restored);
          if (p.restored.tick !== world.tick) throw new Error('tick drift');
          if (world.tick === p.due) {
            expectSameSnapshot(snapshotWorld(world), snapshotWorld(p.restored), `seed ${seed}, ${p.name}`);
            expect(publicView(p.restored), `seed ${seed}, ${p.name}: public view`).toEqual(publicView(world));
            p.due = -1;
          }
        }
      }
      // the always-present scenarios must have been exercised
      expect([...found]).toEqual(expect.arrayContaining(['day 1 morning', 'mid conversation']));
      expect(pending.every((p) => p.due === -1)).toBe(true);
      // keep a record of what each seed covered (all six across the seeds, see below)
      covered.push(...found);
    }, 60_000);
  }

  const covered: string[] = [];
  it('the seeds together cover every scenario', () => {
    for (const sc of SCENARIOS) expect(covered, sc.name).toContain(sc.name);
  });

  it('an old snapshot catches up with the live world', () => {
    const live = createWorld(21, { mapId: 'kamienica' });
    run(live, 300);
    const old = roundTrip(snapshotWorld(live));
    run(live, 3 * DAY);
    const restored = restoreWorld(old);
    run(restored, live.tick - restored.tick);
    expectSameSnapshot(snapshotWorld(live), snapshotWorld(restored), 'catch-up');
    expect(publicView(restored)).toEqual(publicView(live));
  }, 60_000);

  it('a restored trace continues like the original', () => {
    const w = run(createWorld(5), DAY);
    const restored = restoreWorld(roundTrip(snapshotWorld(w, { includeTrace: true })));
    expect(traceOf(restored)).toEqual(traceOf(w));
    run(w, 500);
    run(restored, 500);
    expect(traceOf(restored)).toEqual(traceOf(w));
  });

  it('a network snapshot (no trace, recent diary facts) restores the same simulation', () => {
    const w = run(createWorld(8), 3 * DAY);
    const restored = restoreWorld(roundTrip(snapshotWorld(w, NETWORK_SNAPSHOT)));
    expect(traceOf(restored)).toHaveLength(0);
    run(w, DAY);
    run(restored, DAY);
    expectSameSnapshot(snapshotWorld(w, NETWORK_SNAPSHOT), snapshotWorld(restored, NETWORK_SNAPSHOT), 'network');
    expect(publicView(restored)).toEqual(publicView(w));
  }, 60_000);
});

describe('applySnapshot: in-place update', () => {
  it('turns a world into the snapshot it is given, whatever it held before', () => {
    for (const opts of [NETWORK_SNAPSHOT, { includeTrace: true }] as SnapshotOptions[]) {
      // A knows things B does not (other seed, map, cast size, trace, diary, projects)
      const a = run(createWorld(9, { mapId: 'jezioro', agentCount: 4 }), 2 * DAY + 77);
      const b = run(createWorld(4, { agentCount: 6 }), DAY + 500);
      const snap = roundTrip(snapshotWorld(b, opts));
      const copy = roundTrip(snap);
      applySnapshot(a, snap);
      const fresh = restoreWorld(snap);
      expectSameSnapshot(snapshotWorld(fresh, opts), snapshotWorld(a, opts), 'applied');
      expect(publicView(a)).toEqual(publicView(fresh));
      expect(snap).toEqual(copy);
      // and it keeps simulating exactly like a restored world (no stale module state)
      run(a, 300);
      run(fresh, 300);
      expectSameSnapshot(snapshotWorld(fresh, opts), snapshotWorld(a, opts), 'applied, then ticked');
    }
  }, 60_000);

  it('keeps the World, the residents, the grid and the unchanged events (frame after frame)', () => {
    const server = createWorld(1912, { agentCount: 8, mapId: 'kamienica' });
    run(server, 100);
    const view = restoreWorld(roundTrip(snapshotWorld(server, NETWORK_SNAPSHOT)));
    const agents = [...view.agents];
    const objects = [...view.objects];
    const grid = view.grid;
    const events = [...view.events];
    run(server, 60);
    applySnapshot(view, roundTrip(snapshotWorld(server, NETWORK_SNAPSHOT)));
    expect(view.agents.every((x, i) => x === agents[i])).toBe(true);
    expect(view.objects.every((x, i) => x === objects[i])).toBe(true);
    expect(view.grid).toBe(grid);
    for (const e of events) if (view.events.some((x) => JSON.stringify(x) === JSON.stringify(e))) expect(view.events).toContain(e);
    expect(view.tick).toBe(server.tick);
    expectSameSnapshot(snapshotWorld(server, NETWORK_SNAPSHOT), snapshotWorld(view, NETWORK_SNAPSHOT), 'frames');
  });

  it('keeps page hooks (diary listeners) and refuses a bad snapshot without touching the world', () => {
    const view = run(createWorld(5), 100);
    const seen: number[] = [];
    onDiaryChange(view, (e) => seen.push(e.agentId));
    const server = run(createWorld(5), 100);
    run(server, 10);
    applySnapshot(view, roundTrip(snapshotWorld(server, NETWORK_SNAPSHOT)));
    run(view, 2 * DAY);
    expect(seen.length).toBeGreaterThan(0);

    const before = JSON.stringify(snapshotWorld(view));
    const bad = roundTrip(snapshotWorld(server));
    expect(() => applySnapshot(view, { ...bad, version: SNAPSHOT_VERSION + 1 })).toThrow(SnapshotVersionError);
    expect(JSON.stringify(snapshotWorld(view))).toBe(before);
  }, 60_000);
});

describe('world snapshots: size', () => {
  it('a 30-day-old world fits in ~1 MB over the network', () => {
    const w = run(createWorld(6), 30 * DAY);
    const net = JSON.stringify(snapshotWorld(w, NETWORK_SNAPSHOT)).length;
    const full = JSON.stringify(snapshotWorld(w)).length;
    expect(net).toBeLessThan(1_000_000);
    expect(full).toBeLessThan(1_500_000);
    expect(net).toBeLessThan(full);
  }, 120_000);
});
