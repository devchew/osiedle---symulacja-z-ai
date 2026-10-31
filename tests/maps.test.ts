import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { NEED_KEYS, type NeedKey, type World } from '../src/types';
import { createWorld, tickWorld } from '../src/world/world';
import { MAPS, bedCount, mapIdOf } from '../src/world/maps';
import { mapToAscii } from '../src/world/maps/build';
import { timeFromTick } from '../src/core/time';

// A few game days in every house (src/world/maps), headless. Layout problems show up as
// people who cannot reach things, starve, sleep in the afternoon or stand around.
// DUMP_MAPS=1 also writes ASCII pictures of all houses to test-results/maps.txt.

const DAYS = 4;
/** MAP_SEEDS=1,2,…,8 to explore more seeds */
const SEEDS = process.env.MAP_SEEDS ? process.env.MAP_SEEDS.split(',').map(Number) : [1, 2];
const MAX_LOW_STREAK = 60;
const MAX_STUCK = 120;
const MIN_NIGHT_SLEEP_SHARE = 0.75;

interface AgentRun {
  name: string;
  maxLowStreak: number;
  lowNeed: NeedKey | null;
  maxStuck: number;
  sleepTicks: number;
  sleepNightTicks: number;
  eatTicks: number;
  conversations: number;
  /** activity -> ticks */
  activities: Record<string, number>;
}

interface MapRun {
  mapId: string;
  seed: number;
  world: World;
  doubleBookings: number;
  agents: AgentRun[];
}

function run(mapId: string, seed: number): MapRun {
  const map = MAPS.find((m) => m.id === mapId)!;
  const world = createWorld(seed, { mapId, agentCount: Math.min(6, bedCount(map)) });
  const agents: AgentRun[] = world.agents.map((a) => ({
    name: a.name, maxLowStreak: 0, lowNeed: null, maxStuck: 0, sleepTicks: 0, sleepNightTicks: 0, eatTicks: 0, conversations: 0, activities: {},
  }));
  const low = agents.map(() => 0);
  const stuck = agents.map(() => 0);
  let doubleBookings = 0;
  for (let t = 0; t < DAYS * 24 * 60; t++) {
    tickWorld(world);
    const hour = timeFromTick(world.tick).hour;
    const holders = world.objects.flatMap((o) => o.reservedBy.filter((r) => r !== null));
    if (new Set(holders).size !== holders.length) doubleBookings++;
    world.agents.forEach((agent, i) => {
      const m = agents[i];
      const a = agent.action;
      let active = a?.kind === 'talk' && a.phase === 'talking';
      if (a?.kind === 'use' && a.phase === 'using') {
        active = true;
        const obj = world.objects.find((o) => o.uid === a.objectUid)!;
        const tags = world.objectDefs[obj.type].tags ?? [];
        m.activities[obj.type] = (m.activities[obj.type] ?? 0) + 1;
        if (tags.includes('sleep')) {
          m.sleepTicks++;
          if (hour >= 20 || hour < 9) m.sleepNightTicks++;
        }
        if (tags.includes('food')) m.eatTicks++;
      }
      const lowNeed = NEED_KEYS.find((k) => agent.needs[k] <= 1);
      low[i] = lowNeed ? low[i] + 1 : 0;
      if (low[i] > m.maxLowStreak) {
        m.maxLowStreak = low[i];
        m.lowNeed = lowNeed ?? null;
      }
      const moved = agent.pos.x !== agent.prevPos.x || agent.pos.y !== agent.prevPos.y;
      stuck[i] = moved || active || agent.away ? 0 : stuck[i] + 1;
      m.maxStuck = Math.max(m.maxStuck, stuck[i]);
    });
  }
  world.agents.forEach((a, i) => (agents[i].conversations = a.stats.conversations));
  if (process.env.MAPS_REPORT)
    writeFileSync(
      `test-results/maps-${mapId}-${seed}.txt`,
      agents.map((a) => `${a.name} conv=${a.conversations} eat=${a.eatTicks} sleep=${a.sleepTicks}/${a.sleepNightTicks} low=${a.maxLowStreak}${a.lowNeed ?? ''} stuck=${a.maxStuck} ${JSON.stringify(a.activities)}`).join('\n') + '\n',
    );
  return { mapId, seed, world, doubleBookings, agents };
}

const NEW_MAPS = MAPS.filter((m) => m.id !== 'dom');

describe.each(NEW_MAPS.map((m) => [m.id]))('house %s: a few days of life', (mapId) => {
  let runs: MapRun[] = [];
  beforeAll(() => {
    runs = SEEDS.map((seed) => run(mapId, seed));
  });
  const label = (r: MapRun, a: AgentRun): string => `${mapId} seed ${r.seed} ${a.name}`;

  it('builds the chosen house', () => {
    for (const r of runs) {
      expect(mapIdOf(r.world)).toBe(mapId);
      expect(r.world.agents.length).toBe(Math.min(6, bedCount(MAPS.find((m) => m.id === mapId)!)));
    }
  });

  it('never double-books an object slot', () => {
    for (const r of runs) expect(r.doubleBookings, `seed ${r.seed}`).toBe(0);
  });

  it('keeps every need away from zero', () => {
    for (const r of runs) for (const a of r.agents) expect(a.maxLowStreak, `${label(r, a)} (${a.lowNeed})`).toBeLessThanOrEqual(MAX_LOW_STREAK);
  });

  it('nobody gets stuck', () => {
    for (const r of runs) for (const a of r.agents) expect(a.maxStuck, label(r, a)).toBeLessThanOrEqual(MAX_STUCK);
  });

  it('sleeps mostly at night', () => {
    for (const r of runs)
      for (const a of r.agents) {
        expect(a.sleepTicks, label(r, a)).toBeGreaterThan(DAYS * 6 * 60);
        expect(a.sleepNightTicks / a.sleepTicks, label(r, a)).toBeGreaterThanOrEqual(MIN_NIGHT_SLEEP_SHARE);
      }
  });

  it('everyone eats, talks and does varied things', () => {
    for (const r of runs) {
      // small houses with shy residents talk less, but the house is never silent
      const total = r.agents.reduce((s, a) => s + a.conversations, 0);
      expect(total, `${mapId} seed ${r.seed}`).toBeGreaterThanOrEqual(2 * r.agents.length);
      for (const a of r.agents) {
        expect(a.eatTicks, label(r, a)).toBeGreaterThan(DAYS * 60);
        expect(a.conversations, label(r, a)).toBeGreaterThanOrEqual(1);
        expect(Object.keys(a.activities).length, label(r, a)).toBeGreaterThanOrEqual(5);
      }
    }
  });
});

it.runIf(!!process.env.DUMP_MAPS)('dumps house layouts', () => {
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/maps.txt', MAPS.map((m) => `${m.id} (${m.name})\n${mapToAscii(m.create())}\n`).join('\n'));
});
