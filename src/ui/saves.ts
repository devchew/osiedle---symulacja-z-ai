import type { World } from '../types';
import { DEFAULT_MAP_ID, getMap, mapIdOf } from '../world/maps';
import { isRealtime } from '../realtime/state';
import { storageGet, storageSet } from './dom';

// Saves. The simulation is deterministic per seed (procedural dialogue), so a
// save is just "which world, how far": { seed, agentCount, map, tick }. Loading
// rebuilds the world by replaying ticks. `check` fingerprints the saved state so
// a load can tell whether the replay arrived at the same place (it may not with
// AI dialogues on, or after the simulation code changed).

export const SAVE_VERSION = 1;
export const SLOT_COUNT = 3;
const STORAGE_KEY = 'sim.saves.v1';
/** replays longer than this are refused (≈ 60 game days) */
export const MAX_REPLAY_TICKS = 60 * 24 * 60;

export interface SaveData {
  version: number;
  seed: number;
  agentCount: number;
  tick: number;
  /** fingerprint of the world at `tick` (see worldCheck) */
  check?: string;
  /** AI dialogues were on while playing: a replay may differ */
  ai?: boolean;
  /** house layout id (src/world/maps); saves from before wave 7 have none = 'dom' */
  map?: string;
  /** 'real' = played in real-time mode (no replay: saving is disabled there, kept for completeness) */
  mode?: 'real';
  /** real time of saving, ms since epoch */
  savedAt: number;
}

/** house of a save (old saves without one were made in the default house) */
export function mapOfSave(s: Pick<SaveData, 'map'>): string {
  return getMap(s.map ?? DEFAULT_MAP_ID).id;
}

export interface SaveStore {
  auto: SaveData | null;
  slots: (SaveData | null)[];
}

function isSave(v: unknown): v is SaveData {
  const s = v as SaveData;
  return !!s && typeof s === 'object' && [s.seed, s.agentCount, s.tick, s.version].every((n) => typeof n === 'number' && Number.isFinite(n));
}

export function readSaves(): SaveStore {
  const empty: SaveStore = { auto: null, slots: Array.from({ length: SLOT_COUNT }, () => null) };
  const raw = storageGet(STORAGE_KEY);
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<SaveStore>;
    const norm = (v: unknown): SaveData | null => (isSave(v) ? { ...v, map: mapOfSave(v) } : null);
    return {
      auto: norm(parsed.auto),
      slots: empty.slots.map((_, i) => norm(parsed.slots?.[i])),
    };
  } catch {
    return empty;
  }
}

/** writes a save to a slot (0-based) or the autosave; false if storage is unavailable */
export function writeSave(slot: number | 'auto', data: SaveData): boolean {
  const store = readSaves();
  if (slot === 'auto') store.auto = data;
  else store.slots[slot] = data;
  return storageSet(STORAGE_KEY, JSON.stringify(store));
}

export function clearSave(slot: number): boolean {
  const store = readSaves();
  store.slots[slot] = null;
  return storageSet(STORAGE_KEY, JSON.stringify(store));
}

/** short FNV-1a fingerprint of the deterministic state: tick, rng state, agent positions */
export function worldCheck(world: World): string {
  let h = 0x811c9dc5;
  const mix = (n: number): void => {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193);
  };
  mix(world.tick);
  mix(world.rng.state());
  for (const a of world.agents) {
    mix(a.id);
    mix(Math.round(a.pos.x * 1000));
    mix(Math.round(a.pos.y * 1000));
  }
  return (h >>> 0).toString(36);
}

export function saveFromWorld(world: World, ai = false): SaveData {
  return {
    version: SAVE_VERSION,
    seed: world.seed,
    agentCount: world.agents.length,
    tick: world.tick,
    check: worldCheck(world),
    ai: ai || undefined,
    map: mapIdOf(world),
    mode: isRealtime(world) ? 'real' : undefined,
    savedAt: Date.now(),
  };
}

export interface StartParams {
  seed: number;
  /** house layout id (?map=, unknown or missing = 'dom') */
  mapId: string;
  /** ?mode=real: clock and weather follow the real world */
  realtime: boolean;
  agentCount: number;
  /** tick to replay to before the game starts (0 = fresh world) */
  tick: number;
  /** expected worldCheck at `tick`, when the link came from a save */
  check: string | null;
  paused: boolean;
}

/** reads ?seed, ?map, ?mode, ?agents, ?tick (or ?hour = that hour of day 1), ?check, ?paused */
export function parseStartParams(params: URLSearchParams, maxAgents: number, randomSeed: () => number): StartParams {
  const seed = Math.floor(Number(params.get('seed'))) || randomSeed();
  const agentCount = Math.min(maxAgents, Math.max(1, Math.floor(Number(params.get('agents'))) || Math.min(6, maxAgents)));
  let tick = 0;
  const t = params.get('tick');
  const hour = params.get('hour');
  if (t !== null && Number.isFinite(Number(t))) tick = Math.floor(Number(t));
  else if (hour !== null && Number.isFinite(Number(hour))) tick = ((Math.floor(Number(hour)) - 7 + 24) % 24) * 60;
  tick = Math.max(0, Math.min(MAX_REPLAY_TICKS, tick));
  const realtime = params.get('mode') === 'real';
  return {
    seed,
    mapId: getMap(params.get('map')).id,
    realtime,
    agentCount,
    tick,
    check: params.get('check'),
    paused: params.has('paused'),
  };
}

const pageBase = (): string => `${location.origin}${location.pathname}`;

/**
 * URL (same page) that recreates this save: ?seed=…&agents=…&map=…&tick=…
 * A real-time save links to the live world instead (?mode=real, no tick / check: nothing to replay).
 */
export function linkFor(
  save: Pick<SaveData, 'seed' | 'agentCount' | 'tick' | 'check' | 'map' | 'mode'>,
  opts: { paused?: boolean; base?: string } = {},
): string {
  const q = new URLSearchParams({ seed: String(save.seed), agents: String(save.agentCount), map: mapOfSave(save) });
  if (save.mode === 'real') q.set('mode', 'real');
  else {
    q.set('tick', String(save.tick));
    if (save.check) q.set('check', save.check);
  }
  let url = `${opts.base ?? pageBase()}?${q.toString()}`;
  if (opts.paused && save.mode !== 'real') url += '&paused';
  return url;
}

/** URL of a brand new world (in the given house, optionally in real-time mode) */
export function newWorldLink(seed: number, agentCount: number, opts: { map?: string; realtime?: boolean; base?: string } = {}): string {
  const q = new URLSearchParams({ seed: String(seed), agents: String(agentCount), map: getMap(opts.map).id });
  if (opts.realtime) q.set('mode', 'real');
  return `${opts.base ?? pageBase()}?${q.toString()}`;
}

export function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 999_999_999);
}
