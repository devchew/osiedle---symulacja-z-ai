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

// ---------------------------------------------------------------- time zones (server)

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  let f = zoneFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    zoneFormats.set(timeZone, f);
  }
  return f;
}

/**
 * wall-clock reading of `date` in an IANA time zone (e.g. 'Europe/Warsaw'), independent of the
 * process' own TZ. Same calendar-field semantics as localTimeOf, so it is DST-safe the same way.
 */
export function localTimeIn(date: Date, timeZone: string): LocalTime {
  const p: Record<string, number> = {};
  for (const part of zoneFormat(timeZone).formatToParts(date)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const hour = p.hour === 24 ? 0 : p.hour;
  return { dayNumber: Math.round(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS), minute: hour * 60 + p.minute };
}

/** "2026-10-29T12:00" / "2026-10-29 12:00" (a wall-clock reading, no zone) → LocalTime; null if malformed */
export function parseLocalTime(s: string): LocalTime | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return { dayNumber: Math.round(Date.UTC(y, mo - 1, d) / DAY_MS), minute: h * 60 + mi };
}

/** a long-running (server) world catches up at most this many ticks; beyond that the clock is re-anchored */
export const MAX_CATCH_UP_TICKS = 3 * MINUTES_PER_DAY;
/** ahead of the wall clock by more than this (not just a DST fall-back hour) → re-anchor instead of waiting */
export const MAX_AHEAD_TICKS = 90;

/**
 * Keeps a persistent world's game day ↔ calendar day anchor (baseDay) sane. Ticks never go back
 * and the minute of the day must keep matching the wall clock, so the anchor moves by whole days:
 *  - more than `maxBehind` ticks behind (server was down for days): the anchor moves forward so at
 *    most `maxBehind` ticks are replayed — the skipped days simply never happened in that world;
 *  - more than `maxAhead` ticks ahead (e.g. it ran with a speed-up): the anchor moves back so the
 *    world is less than a day behind and catches up.
 * Returns the (possibly unchanged) baseDay.
 */
export function reanchorBaseDay(tick: number, now: LocalTime, baseDay: number, maxBehind = MAX_CATCH_UP_TICKS, maxAhead = MAX_AHEAD_TICKS): number {
  const behind = targetTick(now, baseDay) - tick;
  if (behind > maxBehind) return baseDay + Math.ceil((behind - maxBehind) / MINUTES_PER_DAY);
  if (-behind > maxAhead) return baseDay - Math.ceil(-behind / MINUTES_PER_DAY);
  return baseDay;
}
