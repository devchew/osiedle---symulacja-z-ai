import { describe, expect, it } from 'vitest';
import { parseFrame } from '../src/live/client';
import { applyFrame } from '../src/live/frames';
import { PLACES } from '../src/live/protocol';
import { timeOf } from '../src/core/calendar';
import { timeFromTick } from '../src/core/time';
import { WorldTimeline, tickAt } from '../e2e/support/worldFixtures';

// The world fixtures of the e2e tests (e2e/support): frames the live client accepts, reproducible,
// for any tick of a place.

describe('e2e world fixtures', () => {
  it('tickAt: day 1 starts at 07:00', () => {
    expect(timeFromTick(tickAt(7)).hour).toBe(7);
    expect(timeFromTick(tickAt(23)).hour).toBe(23);
    expect(timeFromTick(tickAt(12, 3))).toMatchObject({ day: 3, hour: 12 });
  });

  it.each(PLACES.map((p) => p.id))('%s: the frame is valid, reproducible and restores into the place world', (place) => {
    const def = PLACES.find((p) => p.id === place)!;
    const a = new WorldTimeline({ place }).frameAt(tickAt(10));
    const b = new WorldTimeline({ place }).frameAt(tickAt(10));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(parseFrame(JSON.stringify(a))).not.toBeNull();
    const { world } = applyFrame(null, null, a);
    expect(world.seed).toBe(def.seed);
    expect(world.agents).toHaveLength(def.residents);
    expect(world.tick).toBe(tickAt(10));
  });

  it('date: the frame restores with the calendar of that day (season, Monday)', () => {
    const frame = new WorldTimeline({ place: 'dom', date: '2026-12-21' }).frameAt(tickAt(15));
    const t = timeOf(applyFrame(null, null, frame).world);
    expect(t).toMatchObject({ season: 'winter', weekday: 0 });
  });

  it('goes back by starting over and finds ticks by a condition', () => {
    const t = new WorldTimeline({ place: 'dom' });
    const late = t.frameAt(600);
    expect(t.frameAt(100).meta.tick).toBe(100);
    expect(JSON.stringify(t.frameAt(600))).toBe(JSON.stringify(late));
    expect(t.findTick((w) => w.tick >= 250, { step: 50 })).toBe(250);
    expect(() => t.findTick(() => false, { maxTicks: 100 })).toThrow(/no tick found/);
  });
});
