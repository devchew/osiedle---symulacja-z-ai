import { describe, expect, it, vi } from 'vitest';

// Issue #1: the simulation used to have import cycles, so module-level state (the object catalogue,
// registered world state) depended on which module was evaluated first — a client entry that loaded
// another module before world/world.ts ran a different world. Every load order must give the same
// world: each case starts from a fresh module registry, evaluates the modules in its own order and
// only then builds and runs a world.

const LOADERS: Record<string, () => Promise<unknown>> = {
  'world/objects': () => import('../src/world/objects'),
  'world/projects': () => import('../src/world/projects'),
  'world/incidents': () => import('../src/world/incidents'),
  'world/maps': () => import('../src/world/maps'),
  'world/maps/build': () => import('../src/world/maps/build'),
  'world/news': () => import('../src/world/news'),
  'agents/actions': () => import('../src/agents/actions'),
  'agents/brain': () => import('../src/agents/brain'),
  'agents/groups': () => import('../src/agents/groups'),
  'agents/joint': () => import('../src/agents/joint'),
  'agents/work': () => import('../src/agents/work'),
  'agents/household': () => import('../src/agents/household'),
  'social/diary': () => import('../src/social/diary'),
  'core/state': () => import('../src/core/state'),
};
const NAMES = Object.keys(LOADERS);
const rotate = (n: number): string[] => [...NAMES.slice(n), ...NAMES.slice(0, n)];

const ORDERS: Record<string, string[]> = {
  forward: NAMES,
  reverse: [...NAMES].reverse(),
  'from incidents': rotate(NAMES.indexOf('world/incidents')),
  'from brain': rotate(NAMES.indexOf('agents/brain')),
  'from groups': rotate(NAMES.indexOf('agents/groups')),
};

const TICKS = 1500;

interface Run {
  snapshot: string;
  missingProjectDefs: string[];
}

async function runWorld(order: string[]): Promise<Run> {
  vi.resetModules();
  for (const name of order) await LOADERS[name]();
  const { createWorld, tickWorld, snapshotWorld } = await import('../src/world/world');
  const { PROJECT_DEFS } = await import('../src/world/projects/defs');
  const world = createWorld(7, { mapId: 'akademik', agentCount: 6 });
  for (let i = 0; i < TICKS; i++) tickWorld(world);
  const snap = snapshotWorld(world);
  // registry order follows module evaluation order; only the content has to match
  const modules = Object.fromEntries(Object.entries(snap.modules).sort(([a], [b]) => a.localeCompare(b)));
  return {
    snapshot: JSON.stringify({ ...snap, modules }),
    missingProjectDefs: Object.keys(PROJECT_DEFS).filter((t) => !world.objectDefs[t]),
  };
}

describe('module load order', () => {
  let baseline: Run;

  it('world entry first: catalogue complete', async () => {
    baseline = await runWorld([]);
    expect(baseline.missingProjectDefs).toEqual([]);
  });

  for (const [label, order] of Object.entries(ORDERS)) {
    it(`same world after ${TICKS} ticks when loading ${label}`, async () => {
      const run = await runWorld(order);
      expect(run.missingProjectDefs).toEqual([]);
      expect(run.snapshot === baseline.snapshot).toBe(true);
    });
  }
});
