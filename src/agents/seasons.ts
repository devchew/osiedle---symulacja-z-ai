import type { GameTime, ObjectDef } from '../types';
import { isFreeEvening, isWeekend } from '../core/time';

// How the calendar shapes a day (shared by the utility AI, gatherings and joint activities).
// A leaf module: it only reads the GameTime. Hand-made times without calendar fields are
// neutral, and so is the default spring weekday, so tuning elsewhere stays valid.

/** sunrise / sunset of a mid-April day: the garden hours of the original tuning were set for them */
const REF_RISE = 5.75;
const REF_SET = 19.5;

export const SEASON_TUNING = {
  /** outdoor activities (garden, grill, bench, fishing) in winter; flowerbeds almost never */
  WINTER_OUTDOOR: 0.6,
  WINTER_FLOWERBED: 0.3,
  SUMMER_OUTDOOR: 1.1,
  /** wake-up on Saturday / Sunday: this many hours later */
  WEEKEND_SLEEP_IN: 2,
  /** extra hour of evening before Saturday / Sunday */
  FREE_EVENING: 1,
  /** joint activities and project work are this much more attractive on weekends */
  WEEKEND_JOINT: 2,
  WEEKEND_PROJECT: 1.3,
  /** night-time penalty on other activities (before a free day it is milder) */
  NIGHT_FACTOR: 0.6,
  NIGHT_FACTOR_FREE: 0.85,
} as const;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** hours the evening garden hours move with the sunset (long summer evenings, early winter dusk) */
export function eveningShift(t: GameTime): number {
  return t.sunset === undefined ? 0 : clamp(t.sunset - REF_SET, -3, 1.5);
}

/** hours the morning garden hours move with the sunrise (dark winter mornings) */
export function morningShift(t: GameTime): number {
  return t.sunrise === undefined ? 0 : clamp(t.sunrise - REF_RISE, -1.5, 2);
}

/** from this hour on night sleep is preferred (22:00 by default) */
export function bedtimeHour(t: GameTime): number {
  const free = isFreeEvening(t) ? SEASON_TUNING.FREE_EVENING : 0;
  return 22 + clamp(eveningShift(t) * 0.35, -1, 0.5) + free;
}

/** the hour night sleep lasts until; `tomorrow` = a sleep that starts this evening ends tomorrow */
export function wakeHour(t: GameTime, tomorrow = false): number {
  const sleepIn = t.weekday !== undefined && isWeekend({ ...t, weekday: (t.weekday + (tomorrow ? 1 : 0)) % 7 }) ? SEASON_TUNING.WEEKEND_SLEEP_IN : 0;
  return 6 + clamp(morningShift(t) * 0.25, 0, 0.5) + sleepIn;
}

/** garden multiplier by the hour: 0.5 around dawn and dusk, 0.12 in the dark (both move with the sun) */
export function outdoorDaylightFactor(t: GameTime): number {
  const h = t.hour + t.minute / 60;
  const eve = eveningShift(t);
  const morn = morningShift(t);
  if (h >= 21 + eve || h < 6 + morn) return 0.12;
  if (h >= 20 + eve || h < 7 + morn) return 0.5;
  return 1;
}

/** hour from which evening leisure is no longer outdoors */
export function outdoorEveningEnd(t: GameTime): number {
  return 20 + eveningShift(t);
}

/** season multiplier for an outdoor object (pets and projects are not up to the weather season) */
export function outdoorSeasonFactor(def: ObjectDef, t: GameTime): number {
  const tags = def.tags ?? [];
  if (!tags.includes('outdoor') || tags.includes('pet') || tags.includes('project') || tags.includes('project_done')) return 1;
  if (t.season === 'winter') return def.id === 'flowerbed' ? SEASON_TUNING.WINTER_FLOWERBED : SEASON_TUNING.WINTER_OUTDOOR;
  if (t.season === 'summer') return SEASON_TUNING.SUMMER_OUTDOOR;
  return 1;
}

/** fishing needs daylight: from a little after sunrise until the sunset */
export function fishingOpen(t: GameTime): boolean {
  const h = t.hour + t.minute / 60;
  return h >= 6.5 + morningShift(t) && h < 19.5 + eveningShift(t);
}
