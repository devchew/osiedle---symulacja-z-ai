import type { Json, WorldSnapshot } from '../core/state';
import type { SimEventKind } from '../types';
import type { WeatherKind, WeatherSample } from '../world/incidents';

export type { ChronicleDayView, ChronicleItem, ChronicleKind, ChronicleResponse } from '../social/chronicle';

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

/**
 * GET → ChronicleResponse: the place's most important events of the last days (newest day first),
 * kept on the server across restarts; 503 { error: 'starting' } until the world is synced
 */
export const liveChronicleUrl = (place: PlaceId): string => `/api/live/${place}/chronicle`;

/**
 * GET → ReplayResponse: a compact recording of the last 24 h of the place (every tick: positions,
 * actions, bubbles, weather, events…), read-only, ETag + gzip; 503 { error: 'starting' } until the
 * world is synced. Kept on the server across restarts (DATA_DIR/<place>.replay.json).
 */
export const liveReplayUrl = (place: PlaceId): string => `/api/live/${place}/replay`;

export interface LiveMeta {
  place: PlaceId;
  /** server wall clock (ms since epoch) when the frame was produced */
  serverTime: number;
  tick: number;
  /** real weather source for the place; `sample` = the exact weather the server shows now (weatherOf) */
  weather: {
    city: string;
    temperature: number | null;
    source: 'open-meteo' | 'plan';
    updatedAt: number | null;
    sample?: WeatherSample;
  };
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

// ---------------------------------------------------------------- replay of the last 24 h

/** one row = the state from `tick` on, until the next row (changes only; the first row is the state at the window start) */
export interface ReplayActionLite {
  k: 'use' | 'talk' | 'wander' | 'idle';
  /** phase (use / talk / wander) */
  p?: string;
  /** objectUid (use) */
  o?: number;
  /** slot (use) */
  s?: number;
  /** partnerId (talk) */
  w?: number;
  /** conversationId (talk) */
  c?: number | null;
  /** label */
  l: string;
  /** icon */
  i: string;
}

export interface ReplayBubbleLite {
  k: 'speech' | 'thought';
  t: string;
  tone?: 'positive' | 'neutral' | 'negative';
}

export interface ReplayAgentTrack {
  id: number;
  /** [tick, x, y, facing]: where the resident stood after the tick */
  pos: [number, number, number, number][];
  act: [number, ReplayActionLite | null][];
  bub: [number, ReplayBubbleLite | null][];
  /** [tick, mood, hunger, energy, fun, social, hygiene, comfort], sampled every 10 ticks (integers) */
  needs: number[][];
}

export interface ReplayPetTrack {
  id: number;
  /** [tick, x, y, facing, activity, withId] */
  pos: [number, number, number, number, string, number | null][];
}

/** the response of GET /api/live/:place/replay (and the content of DATA_DIR/<place>.replay.json) */
export interface ReplayResponse {
  format: 1;
  place: PlaceId;
  /** first / last recorded tick; the window is at most 24 h (1440 ticks) */
  fromTick: number;
  toTick: number;
  /** server wall clock (ms since epoch) of toTick */
  serverTime: number;
  agents: ReplayAgentTrack[];
  pets: ReplayPetTrack[];
  /** [tick, [[uid, type, x, y], …]] whenever the set of objects changed (breakdowns, building stages) */
  objects: [number, [number, string, number, number][]][];
  /** [tick, kind, intensity, label|null, icon|null, temperature|null] */
  weather: [number, WeatherKind, number, string | null, string | null, number | null][];
  /** [tick, kind, text, agentIds]: the world's events in the window (the same log as live) */
  events: [number, SimEventKind, string, number[]][];
  /** [tick, projects of the projects module (JSON)], sampled every 30 ticks when changed */
  projects: [number, Json][];
}
