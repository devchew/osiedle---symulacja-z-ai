import type { GameTime, World } from '../types';
import { registerWorldState } from './state';
import { DEFAULT_BASE_DAY, timeFromTick } from './time';

// The calendar date of a world: which local date (days since 1970-01-01) its game day 0 falls on.
// Live worlds are anchored to the Europe/Warsaw calendar by the server (setCalendar, same anchor
// as the clock); worlds nobody anchored use DEFAULT_BASE_DAY, so headless runs stay deterministic.
// Seasons, weekdays and sun times follow from the date alone (core/time.ts).

const baseDays = new WeakMap<World, number>();

registerWorldState('calendar', {
  save: (world) => {
    const base = baseDays.get(world);
    return base === undefined ? null : { baseDay: base };
  },
  load: (world, data) => {
    const base = (data as { baseDay?: unknown }).baseDay;
    if (typeof base === 'number' && Number.isFinite(base)) baseDays.set(world, base);
  },
  clear: (world) => void baseDays.delete(world),
  optional: true,
});

export function setCalendar(world: World, baseDay: number): void {
  baseDays.set(world, baseDay);
}

export function calendarBaseDay(world: World): number {
  return baseDays.get(world) ?? DEFAULT_BASE_DAY;
}

/** the world's clock reading at its current tick, with calendar fields */
export function timeOf(world: World): GameTime {
  return timeFromTick(world.tick, calendarBaseDay(world));
}

/** the clock reading at any tick of the world */
export function timeAt(world: World, tick: number): GameTime {
  return timeFromTick(tick, calendarBaseDay(world));
}
