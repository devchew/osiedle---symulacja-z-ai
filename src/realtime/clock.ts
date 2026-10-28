import { MINUTES_PER_DAY, START_MINUTE } from '../core/time';

// Real-time clock maths (pure, no DOM). The game clock shows local wall-clock
// time: tick t lies on game day floor((t + 07:00) / 24 h), and game day 0
// (the "Dzień 1" the world starts on) is mapped to a local calendar date
// (`baseDay`). Everything is computed from local calendar fields (y/m/d h:m),
// never from elapsed milliseconds, so DST changes keep the clock equal to the
// wall clock: spring forward = 60 ticks to catch up, fall back = the
// simulation waits an hour (ticks never go backwards).

/** local wall-clock reading: calendar day number + minute of the day */
export interface LocalTime {
  /** days since 1970-01-01 of the local calendar date (DST-independent) */
  dayNumber: number;
  /** 0..1439, local hours * 60 + minutes */
  minute: number;
}

const DAY_MS = 86_400_000;

export function localTimeOf(date: Date): LocalTime {
  return {
    dayNumber: Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS),
    minute: date.getHours() * 60 + date.getMinutes(),
  };
}

/**
 * local calendar day of game day 0 when syncing at `now`: today if it is
 * already 07:00 or later, else yesterday (the simulation then runs from
 * yesterday 07:00 into today's early hours — "Dzień 2" before 07:00)
 */
export function baseDayFor(now: LocalTime): number {
  return now.minute >= START_MINUTE ? now.dayNumber : now.dayNumber - 1;
}

/** the tick whose game clock equals the local time `now` */
export function targetTick(now: LocalTime, baseDay: number): number {
  return (now.dayNumber - baseDay) * MINUTES_PER_DAY + now.minute - START_MINUTE;
}

/** local calendar date (YYYY-MM-DD) and hour of a tick — for looking up hourly weather */
export function tickToLocal(tick: number, baseDay: number): { date: string; hour: number; minute: number } {
  const total = tick + START_MINUTE;
  const day = Math.floor(total / MINUTES_PER_DAY);
  const ofDay = total - day * MINUTES_PER_DAY;
  const date = new Date((baseDay + day) * DAY_MS).toISOString().slice(0, 10);
  return { date, hour: Math.floor(ofDay / 60), minute: ofDay % 60 };
}

/** progress through the current wall-clock minute, 0..1 — the render interpolation alpha */
export function minuteFraction(date: Date): number {
  return (date.getSeconds() * 1000 + date.getMilliseconds()) / 60_000;
}

/** behind by at most this many ticks: caught up live, a slice per frame */
export const FAST_FORWARD_AFTER = 180;
/** at most this many ticks per animation frame while catching up live */
export const LIVE_STEP_MAX = 30;

export type CatchUp =
  | { mode: 'idle' }
  /** step this many ticks now (more next frame) */
  | { mode: 'step'; ticks: number }
  /** too far behind (sleeping tab, long pause): fast-forward in chunks with the progress overlay */
  | { mode: 'fastForward'; ticks: number };

/** what to do when the simulation is `behind` ticks behind the wall clock (≤ 0: ahead or in sync) */
export function catchUp(behind: number): CatchUp {
  if (behind <= 0) return { mode: 'idle' };
  if (behind > FAST_FORWARD_AFTER) return { mode: 'fastForward', ticks: behind };
  return { mode: 'step', ticks: Math.min(behind, LIVE_STEP_MAX) };
}
