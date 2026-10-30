import { beforeAll, describe, expect, it } from 'vitest';
import type { World } from '../src/types';
import { createWorld, tickWorld } from '../src/world/world';
import { availability, brokenObjects, forecastOf, isBroken, isOutdoorTile, weatherOf, type WeatherKind } from '../src/world/incidents';
import { BREAKABLE, REPAIR_DEFS } from '../src/world/objects';

const DAYS = 7;
const SEEDS = [1, 2, 3];
const TICKS = DAYS * 24 * 60;
/** outdoor slack after the rain starts (finishing up, walking in) */
const GRACE = 25;

interface Repair {
  type: string;
  since: number;
  fixedAt: number | null;
  byResident: boolean;
}

interface Run {
  seed: number;
  world: World;
  weatherTicks: Record<WeatherKind, number>;
  rainTicks: number;
  /** agent-ticks outdoors / using outdoor objects during rain, after the grace period */
  outdoorInRain: number;
  outdoorUseInRain: number;
  /** same, on dry daytime ticks, for comparison */
  outdoorDry: number;
  dryDayTicks: number;
  repairs: Repair[];
  doubleBookings: number;
  maxBroken: number;
  events: string[];
}

function simulate(seed: number): Run {
  const world = createWorld(seed);
  const run: Run = {
    seed,
    world,
    weatherTicks: { sunny: 0, cloudy: 0, rain: 0, storm: 0 },
    rainTicks: 0,
    outdoorInRain: 0,
    outdoorUseInRain: 0,
    outdoorDry: 0,
    dryDayTicks: 0,
    repairs: [],
    doubleBookings: 0,
    maxBroken: 0,
    events: [],
  };
  const open = new Map<number, Repair>();
  let rainFor = 0;
  let lastEvent = world.events.length ? world.events[world.events.length - 1] : undefined;
  for (let t = 0; t < TICKS; t++) {
    tickWorld(world);
    const w = weatherOf(world);
    run.weatherTicks[w.kind]++;
    rainFor = w.raining ? rainFor + 1 : 0;
    const hour = Math.floor(((world.tick + 7 * 60) % 1440) / 60);
    const outside = world.agents.filter((a) => isOutdoorTile(world.grid, a.pos.x, a.pos.y)).length;
    if (rainFor > GRACE) {
      run.rainTicks++;
      run.outdoorInRain += outside;
      for (const a of world.agents) {
        if (a.action?.kind !== 'use' || a.action.phase !== 'using') continue;
        const obj = world.objects.find((o) => o.uid === (a.action as { objectUid: number }).objectUid)!;
        if (world.objectDefs[obj.type].tags?.includes('outdoor')) run.outdoorUseInRain++;
      }
    } else if (!w.raining && hour >= 9 && hour < 19) {
      run.dryDayTicks++;
      run.outdoorDry += outside;
    }

    // breakdowns / repairs
    const broken = brokenObjects(world);
    run.maxBroken = Math.max(run.maxBroken, broken.length);
    for (const b of broken) if (!open.has(b.uid)) open.set(b.uid, { type: b.type, since: b.since, fixedAt: null, byResident: false });
    for (const [uid, r] of open) {
      if (broken.some((b) => b.uid === uid)) continue;
      r.fixedAt = world.tick;
      run.repairs.push(r);
      open.delete(uid);
    }

    // slot bookings: every reservation matches exactly one agent's action
    const seen = new Set<string>();
    for (const a of world.agents) {
      if (a.action?.kind !== 'use') continue;
      const key = `${a.action.objectUid}:${a.action.slot}`;
      if (seen.has(key)) run.doubleBookings++;
      seen.add(key);
      const obj = world.objects.find((o) => o.uid === (a.action as { objectUid: number }).objectUid)!;
      if (obj.reservedBy[a.action.slot] !== a.id) run.doubleBookings++;
    }

    const i = lastEvent ? world.events.lastIndexOf(lastEvent) : -1;
    for (const e of world.events.slice(i + 1)) {
      run.events.push(e.text);
      if (/naprawia/.test(e.text) && e.gossip) {
        const r = run.repairs[run.repairs.length - 1];
        if (r) r.byResident = true;
      }
    }
    lastEvent = world.events[world.events.length - 1];
  }
  for (const r of open.values()) run.repairs.push(r);
  return run;
}

describe('world incidents: weather and breakdowns', () => {
  let runs: Run[] = [];
  beforeAll(() => {
    runs = SEEDS.map(simulate);
    for (const r of runs) {
      const fixed = r.repairs.filter((x) => x.fixedAt !== null);
      const hrs = fixed.map((x) => (x.fixedAt! - x.since) / 60);
      console.log(
        `seed ${r.seed}: weather h ${JSON.stringify(Object.fromEntries(Object.entries(r.weatherTicks).map(([k, v]) => [k, Math.round(v / 60)])))}` +
          `, outdoors/tick dry ${(r.outdoorDry / Math.max(1, r.dryDayTicks)).toFixed(2)} rain ${(r.outdoorInRain / Math.max(1, r.rainTicks)).toFixed(3)}` +
          ` (outdoor use ${r.outdoorUseInRain})` +
          `, breakdowns ${r.repairs.length} (by residents ${fixed.filter((x) => x.byResident).length}), repair h avg ${(hrs.reduce((a, b) => a + b, 0) / Math.max(1, hrs.length)).toFixed(1)} max ${Math.max(0, ...hrs).toFixed(1)}`,
      );
    }
  }, 120_000);

  it('is deterministic for a seed', () => {
    const a = createWorld(7);
    const b = createWorld(7);
    for (let t = 0; t < 3 * 1440; t++) {
      tickWorld(a);
      tickWorld(b);
    }
    expect(a.events.map((e) => e.text)).toEqual(b.events.map((e) => e.text));
    expect(forecastOf(a)).toEqual(forecastOf(b));
    expect(a.rng.state()).toBe(b.rng.state());
  });

  it('has a varied weather plan: mostly dry, rain on some days, storms rare', () => {
    // plan distribution over many seeds (cheap: only the plan, no simulation)
    const days: Record<string, number> = { dry: 0, rain: 0, storm: 0 };
    let rainHours = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const f = forecastOf(createWorld(seed, { agentCount: 1 }));
      const kinds = new Set(f.map((w) => w.kind));
      if (kinds.has('storm')) days.storm++;
      else if (kinds.has('rain')) days.rain++;
      else days.dry++;
      rainHours += f.filter((w) => w.raining).length;
    }
    expect(days.dry / 300).toBeGreaterThan(0.5);
    expect(days.rain / 300).toBeGreaterThan(0.15);
    expect(days.storm / 300).toBeGreaterThan(0.01);
    expect(days.storm / 300).toBeLessThan(0.15);
    // rainy periods last a few hours
    const perRainyDay = rainHours / (days.rain + days.storm);
    expect(perRainyDay).toBeGreaterThan(1);
    expect(perRainyDay).toBeLessThan(7);
  });

  it('logs the start and the end of the rain', () => {
    const all = runs.flatMap((r) => r.events);
    expect(all.some((t) => t.startsWith('Zaczyna padać') || t.startsWith('Nadciąga burza'))).toBe(true);
    expect(all.some((t) => t.startsWith('Przejaśnia się') || t.startsWith('Przestaje padać'))).toBe(true);
  });

  it('rain empties the garden', () => {
    for (const r of runs) {
      if (r.rainTicks < 60) continue;
      expect(r.outdoorUseInRain, `seed ${r.seed}`).toBe(0);
      // at most a passer-by now and then (e.g. walking between two doors)
      expect(r.outdoorInRain / r.rainTicks, `seed ${r.seed}`).toBeLessThan(0.15);
    }
    expect(runs.some((r) => r.rainTicks >= 60)).toBe(true);
  });

  it('outdoor objects are unusable in the rain, broken ones advertise their repair', () => {
    const r = runs.find((x) => x.rainTicks > 0)!;
    expect(r).toBeDefined();
    const w = createWorld(r.seed);
    const bench = w.objects.find((o) => o.type === 'bench')!;
    for (let t = 0; t < TICKS && !weatherOf(w).raining; t++) tickWorld(w);
    expect(weatherOf(w).raining).toBe(true);
    expect(availability(w, bench, w.objectDefs.bench)).toBeLessThan(0.1);
  });

  it('things break about 1–2 times a day and get repaired within 12 game hours', () => {
    for (const r of runs) {
      const perDay = r.repairs.length / DAYS;
      expect(perDay, `seed ${r.seed}`).toBeGreaterThanOrEqual(0.7);
      expect(perDay, `seed ${r.seed}`).toBeLessThanOrEqual(2.5);
      expect(r.maxBroken).toBeLessThanOrEqual(2);
      for (const x of r.repairs) {
        const end = x.fixedAt ?? r.world.tick;
        expect(end - x.since, `seed ${r.seed} ${x.type}`).toBeLessThanOrEqual(12 * 60);
      }
    }
    // most repairs are done by residents, not the handyman
    const all = runs.flatMap((r) => r.repairs.filter((x) => x.fixedAt !== null));
    // (~0.55–0.6 over 40 seeds; three seeds are noisy, so the bar is just "most")
    expect(all.filter((x) => x.byResident).length / all.length).toBeGreaterThan(0.5);
  });

  it('broken objects use the repair variant and come back intact', () => {
    for (const r of runs) {
      for (const o of r.world.objects) {
        if (!isBroken(o)) continue;
        expect(REPAIR_DEFS[o.type]).toBeDefined();
      }
      expect(r.world.objects.every((o) => !isBroken(o) || BREAKABLE.includes(o.type.replace('repair_', '')))).toBe(true);
    }
  });

  it('never double-books an object slot', () => {
    for (const r of runs) expect(r.doubleBookings, `seed ${r.seed}`).toBe(0);
  });

  it('keeps residents alive and well through a week of weather and breakdowns', () => {
    for (const r of runs)
      for (const a of r.world.agents) {
        expect(Number.isFinite(a.pos.x) && Number.isFinite(a.pos.y)).toBe(true);
        expect(a.mood, `seed ${r.seed} ${a.name}`).toBeGreaterThan(10);
        expect(a.stats.objectsUsed).toBeGreaterThan(DAYS * 5);
      }
  });
});
