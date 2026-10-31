import type { World } from '../types';
import { residentsOf } from '../agents/role';

// Mood history for the stats panel: one sample per game hour, kept in the UI
// layer (the simulation keeps no history). main feeds it after every tick, also
// while replaying a save, so a loaded game has its past days filled in.

/** game hours kept: three days */
export const HISTORY_HOURS = 72;
const SAMPLE_EVERY = 60;

export interface MoodSample {
  tick: number;
  /** agent id → mood 0..100 */
  moods: Map<number, number>;
}

export interface MoodHistory {
  /** call after each tick; samples on full game hours */
  record(world: World): void;
  /** oldest first */
  samples(): readonly MoodSample[];
  /** forgets everything (another world) */
  clear(): void;
}

export function createMoodHistory(capacity = HISTORY_HOURS + 1): MoodHistory {
  const buf: MoodSample[] = [];
  let lastTick = -1;
  return {
    record(world) {
      // one sample per game hour: on the full hour, or the first tick seen in a new hour (live
      // frames may skip ticks); going back in time = another world: start over
      if (world.tick < lastTick) buf.length = 0;
      else if (world.tick === lastTick) return;
      else if (lastTick >= 0 && Math.floor(world.tick / SAMPLE_EVERY) === Math.floor(lastTick / SAMPLE_EVERY)) return;
      lastTick = world.tick;
      buf.push({ tick: world.tick, moods: new Map(residentsOf(world).map((a) => [a.id, a.mood])) });
      if (buf.length > capacity) buf.splice(0, buf.length - capacity);
    },
    samples: () => buf,
    clear() {
      buf.length = 0;
      lastTick = -1;
    },
  };
}
