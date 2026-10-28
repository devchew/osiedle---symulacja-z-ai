import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import { timeFromTick } from '../src/core/time';

describe('rng', () => {
  it('is deterministic for a seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });
  it('int stays in inclusive range', () => {
    const r = createRng(1);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(2, 5);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(5);
    }
  });
  it('weightedIndex never picks zero weights', () => {
    const r = createRng(3);
    for (let i = 0; i < 500; i++) expect(r.weightedIndex([0, 1, 0, 2])).not.toBe(0);
  });
});

describe('time', () => {
  it('starts at 07:00 day 1', () => {
    const t = timeFromTick(0);
    expect([t.day, t.hour, t.minute, t.phase]).toEqual([1, 7, 0, 'morning']);
  });
  it('rolls over to day 2 at midnight', () => {
    const t = timeFromTick(17 * 60);
    expect([t.day, t.hour, t.phase, t.daylight]).toEqual([2, 0, 'night', 0]);
  });
});
