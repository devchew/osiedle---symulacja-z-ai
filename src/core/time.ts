import type { DayPhase, GameTime } from '../types';

export const MINUTES_PER_DAY = 24 * 60;
/** the simulation starts on day 1 at 07:00 */
export const START_MINUTE = 7 * 60;

export function timeFromTick(tick: number): GameTime {
  const total = tick + START_MINUTE;
  const day = Math.floor(total / MINUTES_PER_DAY) + 1;
  const ofDay = total % MINUTES_PER_DAY;
  const hour = Math.floor(ofDay / 60);
  const minute = ofDay % 60;
  return { tick, day, hour, minute, phase: phaseOf(hour), daylight: daylightAt(ofDay / 60) };
}

export function phaseOf(hour: number): DayPhase {
  if (hour >= 22 || hour < 6) return 'night';
  if (hour < 10) return 'morning';
  if (hour < 18) return 'day';
  return 'evening';
}

/** 0 at night, 1 during the day, linear ramps at dawn (5–7) and dusk (19–21.5) */
export function daylightAt(hour: number): number {
  if (hour < 5 || hour >= 21.5) return 0;
  if (hour < 7) return (hour - 5) / 2;
  if (hour < 19) return 1;
  return 1 - (hour - 19) / 2.5;
}

export function formatClock(t: GameTime): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}
