import type { DayPhase, GameTime, Season } from '../types';

export const MINUTES_PER_DAY = 24 * 60;
/** the simulation starts on day 1 at 07:00 */
export const START_MINUTE = 7 * 60;

const DAY_MS = 86_400_000;

/**
 * local calendar date (days since 1970-01-01) of game day 0 for worlds nobody anchored to a real
 * date (headless runs, the lab): a Monday in mid-April, so the season is neutral and the first
 * weekend comes on day 6
 */
export const DEFAULT_BASE_DAY = Math.round(Date.UTC(2026, 3, 13) / DAY_MS);

export function timeFromTick(tick: number, baseDay: number = DEFAULT_BASE_DAY): GameTime {
  const total = tick + START_MINUTE;
  const dayIndex = Math.floor(total / MINUTES_PER_DAY);
  const ofDay = total - dayIndex * MINUTES_PER_DAY;
  const hour = Math.floor(ofDay / 60);
  const minute = ofDay % 60;
  const cal = calendarOf(baseDay + dayIndex);
  return {
    tick,
    day: dayIndex + 1,
    hour,
    minute,
    phase: phaseOf(hour),
    daylight: daylightAt(ofDay / 60, cal),
    season: cal.season,
    weekday: cal.weekday,
    sunrise: cal.rise,
    sunset: cal.set,
  };
}

// ---------------------------------------------------------------- calendar

export interface CalendarDay {
  season: Season;
  /** 0 = Monday … 6 = Sunday */
  weekday: number;
  /** sunrise / sunset in local clock hours (Warsaw, DST included) */
  rise: number;
  set: number;
}

const calendarCache = new Map<number, CalendarDay>();

/** season, weekday and sun times of a local calendar date (days since 1970-01-01) */
export function calendarOf(dayNumber: number): CalendarDay {
  let c = calendarCache.get(dayNumber);
  if (!c) {
    if (calendarCache.size > 1000) calendarCache.clear();
    const d = new Date(dayNumber * DAY_MS);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    const dayOfYear = Math.floor((dayNumber * DAY_MS - Date.UTC(year, 0, 1)) / DAY_MS);
    // day length: 7.8 h at the winter and 16.6 h at the summer solstice (Warsaw); solar noon is
    // ~11:35 local winter time, an hour later in summer time
    const length = 12.2 + 4.4 * Math.cos((2 * Math.PI * (dayOfYear - 172)) / 365);
    const noon = 11.6 + (dayNumber >= lastSunday(year, 2) && dayNumber < lastSunday(year, 9) ? 1 : 0);
    const season: Season = month === 11 || month < 2 ? 'winter' : month < 5 ? 'spring' : month < 8 ? 'summer' : 'autumn';
    c = { season, weekday: (((dayNumber + 3) % 7) + 7) % 7, rise: noon - length / 2, set: noon + length / 2 };
    calendarCache.set(dayNumber, c);
  }
  return c;
}

/** day number of the last Sunday of a month (0-based): the European clock changes happen then */
function lastSunday(year: number, month: number): number {
  const last = Math.round(Date.UTC(year, month + 1, 0) / DAY_MS);
  return last - ((last + 3 + 1) % 7);
}

export const isWeekend = (t: GameTime): boolean => t.weekday === 5 || t.weekday === 6;

/** Friday and Saturday evening plus the small hours after them: nothing early tomorrow */
export function isFreeEvening(t: GameTime): boolean {
  const wd = t.weekday;
  if (wd === undefined) return false;
  return t.hour >= 18 ? wd === 4 || wd === 5 : t.hour < 6 && (wd === 5 || wd === 6);
}

export function phaseOf(hour: number): DayPhase {
  if (hour >= 22 || hour < 6) return 'night';
  if (hour < 10) return 'morning';
  if (hour < 18) return 'day';
  return 'evening';
}

/** the sun times the light was tuned for before the calendar existed: ramps at dawn (5–7) and dusk (19–21.5) */
export const LEGACY_SUN = { rise: 6, set: 20.25 };

/** 0 at night, 1 during the day, linear ramps around sunrise (±1 h) and sunset (±1.25 h) */
export function daylightAt(hour: number, sun: { rise: number; set: number } = LEGACY_SUN): number {
  const dawn = sun.rise - 1;
  const dusk = sun.set + 1.25;
  if (hour < dawn || hour >= dusk) return 0;
  if (hour < sun.rise + 1) return (hour - dawn) / 2;
  if (hour < sun.set - 1.25) return 1;
  return 1 - (hour - (sun.set - 1.25)) / 2.5;
}

export function formatClock(t: GameTime): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}
