import type { World } from '../types';

// Real-time mode flags and live readings per world (no DOM: the HUD, the save
// panel and tests read them).

export interface RealtimeStatus {
  /** place name for the HUD, e.g. "Warszawa" or "Warszawa (domyślnie)" */
  place: string;
  lat: number;
  lon: number;
  /** where the location came from */
  source: 'gps' | 'url' | 'default';
  /** current real temperature in °C, null until the first weather reading */
  temperature: number | null;
  /** Date.now() of the last successful weather refresh, null if none */
  weatherUpdatedAt: number | null;
}

const statuses = new WeakMap<World, RealtimeStatus>();

/** true when the world runs in real-time mode (clock = local time, real weather): no saves / replay links */
export function isRealtime(world: World): boolean {
  return statuses.has(world);
}

export function realtimeStatus(world: World): RealtimeStatus | null {
  return statuses.get(world) ?? null;
}

export function markRealtime(world: World, status: RealtimeStatus): void {
  statuses.set(world, status);
}

export function updateRealtimeStatus(world: World, patch: Partial<RealtimeStatus>): void {
  const s = statuses.get(world);
  if (s) Object.assign(s, patch);
}
