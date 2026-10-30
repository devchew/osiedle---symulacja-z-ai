import type { GameTime } from '../types';
import { isWeekend } from '../core/time';

// Meal times shared by the utility AI (agents/brain.ts) and gatherings (agents/groups.ts).
// A leaf module so neither has to import the other.

/** meal windows (fractional hours); food looks more attractive inside them */
export const MEAL_WINDOWS: readonly [number, number][] = [
  [7, 9],
  [12, 14],
  [17.5, 19.5],
];

/** weekend breakfast is a late brunch */
const WEEKEND_BREAKFAST: [number, number] = [8.5, 10.5];

export function isMealTime(time: GameTime): boolean {
  const h = time.hour + time.minute / 60;
  const weekend = isWeekend(time);
  return MEAL_WINDOWS.some(([a, b], i) => {
    const [from, to] = weekend && i === 0 ? WEEKEND_BREAKFAST : [a, b];
    return h >= from && h < to;
  });
}
