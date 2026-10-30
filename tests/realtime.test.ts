import { describe, expect, it } from 'vitest';
import type { World } from '../src/types';
import { createWorld, tickWorld } from '../src/world/world';
import { availability, forecastOf, hasWeatherOverride, isOutdoorTile, setWeatherOverride, weatherOf } from '../src/world/incidents';
import { worldCheck } from './tools/worldCheck';
import {
  baseDayFor,
  localTimeOf,
  targetTick,
  tickToLocal,
} from '../src/realtime/clock';
import { mapWmo, parseForecast, weatherSource } from '../src/realtime/weather';
import { isRealtime, markRealtime, realtimeStatus } from '../src/realtime/state';
import { timeFromTick } from '../src/core/time';

/** local wall-clock date (constructed from local fields, so the test is time-zone independent) */
const at = (y: number, m: number, d: number, h: number, min: number, s = 0): Date => new Date(y, m - 1, d, h, min, s);

describe('real-time clock', () => {
  it('maps local time after 07:00 to today', () => {
    const now = localTimeOf(at(2026, 10, 28, 7, 0));
    const base = baseDayFor(now);
    expect(base).toBe(now.dayNumber);
    expect(targetTick(now, base)).toBe(0);
    const later = localTimeOf(at(2026, 10, 28, 21, 37));
    const t = targetTick(later, base);
    expect(t).toBe(14 * 60 + 37);
    expect(timeFromTick(t)).toMatchObject({ day: 1, hour: 21, minute: 37 });
  });

  it('maps local time before 07:00 to the next game day (started yesterday at 07:00)', () => {
    const now = localTimeOf(at(2026, 10, 28, 3, 15));
    const base = baseDayFor(now);
    expect(base).toBe(now.dayNumber - 1);
    const t = targetTick(now, base);
    expect(timeFromTick(t)).toMatchObject({ day: 2, hour: 3, minute: 15 });
    expect(localTimeOf(at(2026, 10, 28, 6, 59)).minute).toBe(419);
  });

  it('rolls over midnight and month ends', () => {
    const base = baseDayFor(localTimeOf(at(2026, 10, 31, 22, 0)));
    const t = targetTick(localTimeOf(at(2026, 11, 1, 0, 5)), base);
    expect(timeFromTick(t)).toMatchObject({ day: 2, hour: 0, minute: 5 });
    expect(tickToLocal(t, base)).toEqual({ date: '2026-11-01', hour: 0, minute: 5 });
    expect(tickToLocal(0, base)).toEqual({ date: '2026-10-31', hour: 7, minute: 0 });
  });

  it('is DST-safe: follows local wall-clock fields, a calendar day is always 1440 ticks', () => {
    for (const [y, m, d] of [
      [2026, 3, 29], // EU spring forward
      [2026, 10, 25], // EU fall back
      [2026, 3, 8], // US spring forward
    ]) {
      const base = baseDayFor(localTimeOf(at(y, m, d - 1, 12, 0)));
      const before = targetTick(localTimeOf(at(y, m, d - 1, 12, 0)), base);
      const after = targetTick(localTimeOf(at(y, m, d, 12, 0)), base);
      expect(after - before).toBe(1440);
      expect(timeFromTick(after)).toMatchObject({ day: 2, hour: 12, minute: 0 });
    }
  });
});

describe('WMO weather codes', () => {
  it('maps codes to weather kinds', () => {
    expect(mapWmo(0).kind).toBe('sunny');
    expect(mapWmo(1).kind).toBe('sunny');
    expect(mapWmo(2).kind).toBe('cloudy');
    expect(mapWmo(3).kind).toBe('cloudy');
    expect(mapWmo(45)).toMatchObject({ kind: 'cloudy', label: 'Mgła' });
    for (const c of [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86]) expect(mapWmo(c).kind, String(c)).toBe('rain');
    for (const c of [95, 96, 99]) expect(mapWmo(c).kind, String(c)).toBe('storm');
    expect(mapWmo(1234).kind).toBe('cloudy');
  });

  it('grades intensity and uses cloud cover for cloudy skies', () => {
    expect(mapWmo(61).intensity).toBeLessThan(mapWmo(63).intensity);
    expect(mapWmo(63).intensity).toBeLessThan(mapWmo(65).intensity);
    expect(mapWmo(3, 100).intensity).toBe(1);
    expect(mapWmo(2, 40).intensity).toBeCloseTo(0.4);
    expect(mapWmo(73)).toMatchObject({ label: 'Śnieg' });
    for (let c = 0; c < 100; c++) {
      const w = mapWmo(c);
      expect(w.intensity).toBeGreaterThanOrEqual(0);
      expect(w.intensity).toBeLessThanOrEqual(1);
    }
  });

  it('parses an Open-Meteo response into an hourly source', () => {
    const data = parseForecast({
      current: { time: '2026-10-28T10:15', weather_code: 95, cloud_cover: 100, temperature_2m: 12.4 },
      hourly: {
        time: ['2026-10-28T09:00', '2026-10-28T10:00', '2026-10-28T11:00'],
        weather_code: [0, 3, 63],
        cloud_cover: [0, 90, 100],
        temperature_2m: [10, 11, 12],
      },
    });
    expect(data.current?.temperature).toBe(12.4);
    const base = baseDayFor(localTimeOf(at(2026, 10, 28, 9, 0)));
    const src = weatherSource(() => data, () => base);
    const tickAt = (h: number, m: number) => targetTick(localTimeOf(at(2026, 10, 28, h, m)), base);
    expect(src(tickAt(9, 30))?.kind).toBe('sunny');
    expect(src(tickAt(10, 40))?.kind).toBe('storm'); // current reading wins for the current hour
    expect(src(tickAt(11, 0))?.kind).toBe('rain');
    expect(src(tickAt(14, 0))).toBeNull(); // no data → plan
    expect(weatherSource(() => null, () => base)(0)).toBeNull();
  });
});

describe('weather override', () => {
  const outdoorCount = (w: World) => w.agents.filter((a) => isOutdoorTile(w.grid, a.pos.x, a.pos.y)).length;
  const outdoorObj = (w: World) => w.objects.find((o) => w.objectDefs[o.type]?.tags?.includes('outdoor') && w.objectDefs[o.type].slots.length > 0)!;

  it('real rain empties the garden; clearing the override restores the seeded plan', () => {
    const world = createWorld(7);
    const planned = Array.from({ length: 24 }, (_, h) => forecastOf(world)[h].kind);
    const obj = outdoorObj(world);
    expect(obj).toBeTruthy();

    // a dry morning outside first
    setWeatherOverride(world, () => ({ kind: 'sunny', intensity: 0 }));
    expect(hasWeatherOverride(world)).toBe(true);
    for (let i = 0; i < 4 * 60; i++) tickWorld(world);

    const start = world.tick;
    setWeatherOverride(world, (t) => (t >= start ? { kind: 'rain', intensity: 0.8, label: 'Ulewa' } : null));
    expect(weatherOf(world)).toMatchObject({ kind: 'rain', raining: true, label: 'Ulewa' });
    expect(availability(world, obj, world.objectDefs[obj.type])).toBeLessThan(0.1);
    tickWorld(world);
    expect(world.events.some((e) => e.text.startsWith('Zaczyna padać'))).toBe(true);
    for (let i = 0; i < 60; i++) tickWorld(world);
    expect(outdoorCount(world)).toBe(0);
    expect(forecastOf(world).every((f) => f.kind === 'rain' || f.kind === 'sunny')).toBe(true);

    setWeatherOverride(world, null);
    expect(hasWeatherOverride(world)).toBe(false);
    expect(forecastOf(world).map((f) => f.kind)).toEqual(planned);
  });

  it('leaves the seeded simulation deterministic (override set and cleared, or never set)', () => {
    const run = (touch: boolean) => {
      const w = createWorld(3);
      if (touch) {
        setWeatherOverride(w, () => null); // a source without data falls back to the plan
        for (let i = 0; i < 600; i++) tickWorld(w);
        setWeatherOverride(w, null);
      }
      for (let i = touch ? 600 : 0; i < 1800; i++) tickWorld(w);
      return { check: worldCheck(w), events: w.events.map((e) => `${e.tick}:${e.text}`).join('|') };
    };
    expect(run(true)).toEqual(run(false));
    expect(run(false)).toEqual(run(false));
  });

  it('night label for a clear sky, custom labels otherwise', () => {
    const w = createWorld(1);
    setWeatherOverride(w, () => ({ kind: 'sunny', intensity: 0, label: 'Bezchmurnie' }));
    expect(weatherOf(w).label).toBe('Bezchmurnie'); // 07:00
    for (let i = 0; i < 15 * 60; i++) tickWorld(w); // 22:00
    expect(weatherOf(w)).toMatchObject({ label: 'Pogodnie', icon: '🌙' });
  });
});

describe('real-time flag', () => {
  it('marks a world as real-time', () => {
    const w = createWorld(1);
    expect(isRealtime(w)).toBe(false);
    expect(realtimeStatus(w)).toBeNull();
    markRealtime(w, { place: 'Warszawa (domyślnie)', lat: 52.23, lon: 21.01, source: 'default', temperature: 9.5, weatherUpdatedAt: null });
    expect(isRealtime(w)).toBe(true);
    expect(realtimeStatus(w)?.temperature).toBe(9.5);
  });
});
