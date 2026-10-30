import type { WorldSnapshot } from '../core/state';

// Contract between the live-world server (server/worlds.ts) and the browser client.
// Four fixed places, each one shared world running 24/7 in real time (Europe/Warsaw clock).
// Changing anything here is a client+server change: log it in plan/DECISIONS.md.

export type PlaceId = 'dom' | 'kamienica' | 'jezioro' | 'akademik';

export interface PlaceDef {
  id: PlaceId;
  /** house layout id from src/world/maps */
  mapId: string;
  /** Polish display name */
  name: string;
  /** real city whose weather the place follows */
  city: string;
  lat: number;
  lon: number;
  /** fixed seed: the place's residents and their personalities */
  seed: number;
  residents: number;
}

export const PLACES: readonly PlaceDef[] = [
  { id: 'dom', mapId: 'dom', name: 'Dom z ogrodem', city: 'Józefów pod Warszawą', lat: 52.137, lon: 21.234, seed: 2026, residents: 6 },
  { id: 'kamienica', mapId: 'kamienica', name: 'Kamienica', city: 'Kraków', lat: 50.062, lon: 19.938, seed: 1912, residents: 8 },
  { id: 'jezioro', mapId: 'jezioro', name: 'Domek nad jeziorem', city: 'Giżycko', lat: 54.038, lon: 21.765, seed: 1410, residents: 4 },
  { id: 'akademik', mapId: 'akademik', name: 'Akademik', city: 'Wrocław', lat: 51.11, lon: 17.032, seed: 1702, residents: 8 },
];

export const DEFAULT_PLACE: PlaceId = 'dom';
export const LIVE_TIME_ZONE = 'Europe/Warsaw';

export function placeById(id: string | null | undefined): PlaceDef | undefined {
  return PLACES.find((p) => p.id === id);
}

/** GET → PlaceSummary[] */
export const LIVE_PLACES_URL = '/api/live/places';
/** GET → LiveFrame (one-off snapshot of a place) */
export const liveSnapshotUrl = (place: PlaceId): string => `/api/live/${place}/snapshot`;
/**
 * GET, Server-Sent Events. `event: frame` with `data: LiveFrame` (JSON) right after connecting
 * and after every simulation tick (once per real minute); `event: ping` keep-alives in between.
 */
export const liveStreamUrl = (place: PlaceId): string => `/api/live/${place}/stream`;

export interface LiveMeta {
  place: PlaceId;
  /** server wall clock (ms since epoch) when the frame was produced */
  serverTime: number;
  tick: number;
  /** real weather source for the place */
  weather: { city: string; temperature: number | null; source: 'open-meteo' | 'plan'; updatedAt: number | null };
  /** AI dialogue/diaries active on the server for this world */
  ai: boolean;
  /** real headlines feed active */
  news: boolean;
}

export interface LiveFrame {
  meta: LiveMeta;
  /** NETWORK_SNAPSHOT of the world after the tick */
  snapshot: WorldSnapshot;
}

export interface PlaceSummary {
  id: PlaceId;
  name: string;
  city: string;
  tick: number;
  residents: number;
  awake: number;
  /** short Polish highlight of what's going on, e.g. "2 osoby grają na konsoli" */
  highlight: string | null;
  temperature: number | null;
  weatherIcon: string;
}
