import { describe, expect, it } from 'vitest';
import type { World } from '../src/types';
import { createWorld, restoreWorld, snapshotWorld, tickWorld } from '../src/world/world';
import { timeFromTick } from '../src/core/time';
import { MAPS } from '../src/world/maps';
import { commuteKindOf, WORK_EVENT_RE } from '../src/agents/work';
import { householdOf, pantryCapacity } from '../src/agents/household';
import { findGenderedForms } from '../src/social/diaryAi';

// Issue #8: some residents leave for work / classes on workdays, somebody does the shopping,
// the fridge runs down, the household has a budget (repairs cost money).

const DAY = 1440;

interface Run {
  world: World;
  /** most residents away at once */
  maxAway: number;
  /** fewest residents at home, over the whole run */
  minHome: number;
  /** ticks of the days (1-based) on which somebody commuted */
  commuteDays: Set<number>;
  shopDays: Set<number>;
  leaves: number;
}

function run(mapId: string, seed: number, days: number): Run {
  const world = createWorld(seed, { mapId });
  const r: Run = { world, maxAway: 0, minHome: world.agents.length, commuteDays: new Set(), shopDays: new Set(), leaves: 0 };
  const wasAway = new Set<number>();
  for (let t = 0; t < days * DAY; t++) {
    tickWorld(world);
    const day = timeFromTick(world.tick).day;
    const away = world.agents.filter((a) => a.away);
    r.maxAway = Math.max(r.maxAway, away.length);
    r.minHome = Math.min(r.minHome, world.agents.length - away.length);
    for (const a of away) {
      if (!wasAway.has(a.id)) {
        r.leaves++;
        (a.away!.kind === 'shop' ? r.shopDays : r.commuteDays).add(day);
      }
    }
    wasAway.clear();
    for (const a of away) wasAway.add(a.id);
  }
  return r;
}

const week = MAPS.map((m) => ({ mapId: m.id, ...run(m.id, 3, 7) }));

describe('work and shopping', () => {
  it('sends only some residents away: the house is never empty', () => {
    for (const r of week) {
      expect(r.maxAway, r.mapId).toBeGreaterThan(0);
      expect(r.minHome, r.mapId).toBeGreaterThanOrEqual(2);
    }
  });

  it('commutes on workdays and not on the weekend (days 6 and 7)', () => {
    for (const r of week) {
      expect([...r.commuteDays].filter((d) => d >= 6), r.mapId).toEqual([]);
      expect(r.commuteDays.size, r.mapId).toBeGreaterThanOrEqual(4);
    }
  });

  it('who commutes is decided by the seed, and some residents never do', () => {
    const w = createWorld(5);
    const kinds = w.agents.map((a) => commuteKindOf(w, a));
    expect(kinds.filter(Boolean).length).toBeGreaterThan(0);
    expect(kinds.filter((k) => !k).length).toBeGreaterThanOrEqual(2);
    expect(createWorld(5).agents.map((a) => commuteKindOf(createWorld(5), a))).toEqual(kinds);
  });

  it('an absent resident shows its errand in the action and comes back tired, paying wages', () => {
    const world = createWorld(3);
    const worker = world.agents.find((a) => commuteKindOf(world, a) === 'work')!;
    let before = 0;
    let wasAway = false;
    let label = '';
    let energyAfter = 0;
    for (let t = 0; t < 2 * DAY && !energyAfter; t++) {
      tickWorld(world);
      if (worker.away) {
        if (!wasAway) before = worker.needs.energy;
        wasAway = true;
        label = worker.action?.kind === 'idle' ? (worker.action.label ?? '') : '';
        expect(worker.action?.kind).toBe('idle');
      } else if (wasAway) energyAfter = worker.needs.energy;
    }
    expect(label).toMatch(/^W pracy \(wraca ok\. \d\d:\d\d\)$/);
    expect(energyAfter).toBeLessThan(before);
    expect(householdOf(world).earned).toBeGreaterThan(0);
  });

  it('somebody does the shopping when the pantry runs low, and it fills up', () => {
    const world = createWorld(7);
    const h = householdOf(world);
    h.stock = 0;
    for (let t = 0; t < 2 * DAY && h.trips === 0; t++) tickWorld(world);
    expect(h.trips).toBeGreaterThan(0);
    expect(h.stock).toBeGreaterThan(0);
    expect(h.stock).toBeLessThanOrEqual(pantryCapacity(world));
  });

  it('repairs and bills cost money, wages and grants earn it, and the budget stays afloat', () => {
    for (const r of week) {
      const h = householdOf(r.world);
      expect(h.spent.repairs, r.mapId).toBeGreaterThan(0);
      expect(h.spent.bills, r.mapId).toBeGreaterThan(0);
      expect(h.earned, r.mapId).toBeGreaterThan(0);
      expect(h.money, r.mapId).toBeGreaterThan(-400);
    }
  });

  it('is deterministic and survives a snapshot in the middle of an absence', () => {
    const a = createWorld(11);
    while (!a.agents.some((x) => x.away) && a.tick < 3 * DAY) tickWorld(a);
    expect(a.agents.some((x) => x.away)).toBe(true);
    const b = restoreWorld(JSON.parse(JSON.stringify(snapshotWorld(a))));
    expect(b.agents.map((x) => x.away)).toEqual(a.agents.map((x) => x.away));
    for (let t = 0; t < DAY; t++) {
      tickWorld(a);
      tickWorld(b);
    }
    expect(householdOf(b)).toEqual(householdOf(a));
    expect(b.agents.map((x) => [x.pos, x.away ?? null])).toEqual(a.agents.map((x) => [x.pos, x.away ?? null]));
    expect(b.rng.state()).toBe(a.rng.state());
  });

  it('loads snapshots from before the feature (no work / household state)', () => {
    const w = createWorld(2);
    for (let t = 0; t < 600; t++) tickWorld(w);
    const snap = JSON.parse(JSON.stringify(snapshotWorld(w)));
    delete snap.modules.work;
    delete snap.modules.household;
    const old = restoreWorld(snap);
    for (let t = 0; t < DAY; t++) tickWorld(old);
    expect(householdOf(old).money).toBeGreaterThan(-400);
  });

  it('keeps its texts free of gendered forms', () => {
    for (const r of week) {
      const texts = r.world.events.filter((e) => WORK_EVENT_RE.test(e.text)).map((e) => e.text);
      expect(texts.length).toBeGreaterThan(0);
      for (const t of texts) expect(findGenderedForms(t), t).toEqual([]);
    }
  });
});
