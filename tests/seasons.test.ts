import { describe, expect, it } from 'vitest';
import type { World } from '../src/types';
import { createWorld, restoreWorld, snapshotWorld, tickWorld } from '../src/world/world';
import { setCalendar, timeAt, timeOf } from '../src/core/calendar';
import { MINUTES_PER_DAY, START_MINUTE, calendarOf, daylightAt, timeFromTick } from '../src/core/time';
import { isAgentSleeping } from '../src/agents/actions';
import { isMealTime } from '../src/agents/meals';
import { jointLog } from '../src/agents/joint';
import { snowCoverOf, weatherOf } from '../src/world/incidents';
import { residentsOf } from '../src/agents/role';

// Seasons and weekends (issue #10): the calendar of a world follows from the local date its day 1 falls on.

const DAY_MS = 86_400_000;
const dayNumber = (y: number, m: number, d: number): number => Math.round(Date.UTC(y, m - 1, d) / DAY_MS);

/** 2026-04-10 is a Friday: days 3 and 4 of the run are Saturday and Sunday */
const FRIDAY = dayNumber(2026, 4, 10);
const JANUARY_MONDAY = dayNumber(2027, 1, 4);
const JULY_MONDAY = dayNumber(2026, 7, 6);

function run(seed: number, baseDay: number, days: number, onTick?: (w: World) => void): World {
  const w = createWorld(seed);
  setCalendar(w, baseDay);
  for (let i = 0; i < days * MINUTES_PER_DAY; i++) {
    tickWorld(w);
    onTick?.(w);
  }
  return w;
}

describe('calendar', () => {
  it('derives weekday, season and sun times from the date of day 1', () => {
    const winter = timeFromTick(0, dayNumber(2026, 12, 21));
    expect([winter.weekday, winter.season]).toEqual([0, 'winter']);
    expect(winter.sunrise!).toBeGreaterThan(7.3);
    expect(winter.sunset!).toBeLessThan(16);

    const summer = timeFromTick(0, dayNumber(2026, 6, 21));
    expect([summer.weekday, summer.season]).toEqual([6, 'summer']);
    expect(summer.sunrise!).toBeLessThan(4.7);
    expect(summer.sunset!).toBeGreaterThan(20.5);
  });

  it('moves on to the next date at midnight, not at the 07:00 start of the game day', () => {
    const base = dayNumber(2026, 4, 10);
    expect(timeFromTick(16 * 60 + 59, base).weekday).toBe(4);
    expect(timeFromTick(17 * 60, base).weekday).toBe(5);
  });

  it('follows daylight saving time: sunrise jumps by an hour the day the clocks change', () => {
    const before = calendarOf(dayNumber(2026, 3, 28));
    const after = calendarOf(dayNumber(2026, 3, 29));
    expect(after.rise - before.rise).toBeGreaterThan(0.8);
    const backBefore = calendarOf(dayNumber(2026, 10, 24));
    const backAfter = calendarOf(dayNumber(2026, 10, 25));
    expect(backBefore.rise - backAfter.rise).toBeGreaterThan(0.8);
  });

  it('shortens the winter day and lengthens the summer one', () => {
    const winter = calendarOf(dayNumber(2026, 12, 21));
    const summer = calendarOf(dayNumber(2026, 6, 21));
    expect(daylightAt(17, winter)).toBe(0);
    expect(daylightAt(17, summer)).toBe(1);
    expect(daylightAt(21, summer)).toBeGreaterThan(0.2);
    expect(daylightAt(12, winter)).toBe(1);
  });

  it('is kept by snapshots', () => {
    const w = run(3, JANUARY_MONDAY, 1);
    const copy = restoreWorld(snapshotWorld(w));
    expect(timeOf(copy)).toEqual(timeOf(w));
    expect(timeOf(copy).season).toBe('winter');
    expect(snowCoverOf(copy)).toBe(snowCoverOf(w));
  });

  it('is deterministic: the same date and seed give the same week', () => {
    const a = run(5, FRIDAY, 2);
    const b = run(5, FRIDAY, 2);
    expect(a.rng.state()).toBe(b.rng.state());
    expect(a.agents.map((x) => x.action?.kind)).toEqual(b.agents.map((x) => x.action?.kind));
  });
});

describe('weekends', () => {
  it('start brunch later', () => {
    const base = FRIDAY;
    const at = (day: number, h: number) => timeFromTick(day * MINUTES_PER_DAY + h * 60 - START_MINUTE, base);
    expect(isMealTime(at(0, 7.5))).toBe(true);
    expect(isMealTime(at(1, 7.5))).toBe(false);
    expect(isMealTime(at(1, 9.5))).toBe(true);
  });

  it('let residents sleep in', () => {
    const wakes: { weekend: number[]; weekday: number[] } = { weekend: [], weekday: [] };
    for (const seed of [1, 2, 3]) {
      const asleep = new Map<number, boolean>();
      run(seed, FRIDAY, 6, (w) => {
        const t = timeOf(w);
        for (const a of w.agents) {
          const now = isAgentSleeping(w, a);
          // the first getting up after a night (before noon)
          if (asleep.get(a.id) && !now && t.hour < 12) (t.weekday === 5 || t.weekday === 6 ? wakes.weekend : wakes.weekday).push(t.hour + t.minute / 60);
          asleep.set(a.id, now);
        }
      });
    }
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(wakes.weekend.length).toBeGreaterThan(10);
    expect(mean(wakes.weekend)).toBeGreaterThan(mean(wakes.weekday) + 1);
  });

  it('bring more joint activities per hour awake than weekdays', () => {
    const sessions = { weekend: 0, weekday: 0 };
    const awake = { weekend: 0, weekday: 0 };
    const isFree = (wd: number | undefined): 'weekend' | 'weekday' => (wd === 5 || wd === 6 ? 'weekend' : 'weekday');
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const w = run(seed, FRIDAY, 7, (x) => {
        const k = isFree(timeOf(x).weekday);
        for (const a of residentsOf(x)) if (!isAgentSleeping(x, a)) awake[k]++;
      });
      for (const r of jointLog(w)) if (r.happened) sessions[isFree(timeAt(w, r.start).weekday)]++;
    }
    expect(sessions.weekend / awake.weekend).toBeGreaterThan((sessions.weekday / awake.weekday) * 1.1);
  });
});

describe('seasons', () => {
  const outdoor = ['flowerbed', 'bench', 'grill', 'fishing_spot'];
  const gardenTicks = (baseDay: number): number => {
    let n = 0;
    for (const seed of [1, 2, 3, 4]) {
      run(seed, baseDay, 4, (w) => {
        for (const a of w.agents) {
          if (a.action?.kind !== 'use' || a.action.phase !== 'using') continue;
          const uid = a.action.objectUid;
          const obj = w.objects.find((o) => o.uid === uid);
          if (obj && outdoor.includes(obj.type)) n++;
        }
      });
    }
    return n;
  };

  it('keep residents out of the garden in winter more than in summer', () => {
    const winter = gardenTicks(JANUARY_MONDAY);
    const summer = gardenTicks(JULY_MONDAY);
    expect(winter).toBeGreaterThan(0);
    expect(winter).toBeLessThan(summer * 0.8);
  });

  it('let the seeded winter rain fall as snow that covers the ground, and never in summer', () => {
    let winterSnow = 0;
    let maxCover = 0;
    let summerSnow = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      run(seed, JANUARY_MONDAY, 7, (w) => {
        if (weatherOf(w).snow) winterSnow++;
        maxCover = Math.max(maxCover, snowCoverOf(w));
      });
      run(seed, JULY_MONDAY, 7, (w) => {
        if (weatherOf(w).snow || snowCoverOf(w) > 0) summerSnow++;
      });
    }
    expect(winterSnow).toBeGreaterThan(0);
    expect(maxCover).toBeGreaterThan(0.2);
    expect(summerSnow).toBe(0);
  });

  it('stay up later in summer evenings than in winter ones', () => {
    const lateOutdoors = (baseDay: number): number => {
      let n = 0;
      for (const seed of [1, 2, 3, 4]) {
        run(seed, baseDay, 4, (w) => {
          if (w.tick % MINUTES_PER_DAY < 15 * 60 - START_MINUTE || timeOf(w).hour < 19) return;
          for (const a of w.agents) if (a.action?.kind === 'use' && a.action.phase === 'using' && w.objects.find((o) => o.uid === (a.action as { objectUid: number }).objectUid)?.type === 'grill') n++;
        });
      }
      return n;
    };
    expect(lateOutdoors(JULY_MONDAY)).toBeGreaterThan(lateOutdoors(JANUARY_MONDAY));
  });
});
