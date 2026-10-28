import type { World } from '../types';
import { storageGet, storageSet } from './dom';

// Saves. The simulation is deterministic per seed (procedural dialogue), so a
// save is just "which world, how far": { seed, agentCount, tick }. Loading
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
  /** real time of saving, ms since epoch */
  savedAt: number;
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
    return {
      auto: isSave(parsed.auto) ? parsed.auto : null,
      slots: empty.slots.map((_, i) => (isSave(parsed.slots?.[i]) ? parsed.slots![i] : null)),
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
    savedAt: Date.now(),
  };
}

export interface StartParams {
  seed: number;
  agentCount: number;
  /** tick to replay to before the game starts (0 = fresh world) */
  tick: number;
  /** expected worldCheck at `tick`, when the link came from a save */
  check: string | null;
  paused: boolean;
}

/** reads ?seed, ?agents, ?tick (or ?hour = that hour of day 1), ?check, ?paused */
export function parseStartParams(params: URLSearchParams, maxAgents: number, randomSeed: () => number): StartParams {
  const seed = Math.floor(Number(params.get('seed'))) || randomSeed();
  const agentCount = Math.min(maxAgents, Math.max(1, Math.floor(Number(params.get('agents'))) || Math.min(6, maxAgents)));
  let tick = 0;
  const t = params.get('tick');
  const hour = params.get('hour');
  if (t !== null && Number.isFinite(Number(t))) tick = Math.floor(Number(t));
  else if (hour !== null && Number.isFinite(Number(hour))) tick = ((Math.floor(Number(hour)) - 7 + 24) % 24) * 60;
  tick = Math.max(0, Math.min(MAX_REPLAY_TICKS, tick));
  return { seed, agentCount, tick, check: params.get('check'), paused: params.has('paused') };
}

/** URL (same page) that recreates this save: ?seed=…&agents=…&tick=… */
export function linkFor(save: Pick<SaveData, 'seed' | 'agentCount' | 'tick' | 'check'>, opts: { paused?: boolean; base?: string } = {}): string {
  const base = opts.base ?? `${location.origin}${location.pathname}`;
  const q = new URLSearchParams({ seed: String(save.seed), agents: String(save.agentCount), tick: String(save.tick) });
  if (save.check) q.set('check', save.check);
  let url = `${base}?${q.toString()}`;
  if (opts.paused) url += '&paused';
  return url;
}

/** URL of a brand new world */
export function newWorldLink(seed: number, agentCount: number): string {
  return `${location.origin}${location.pathname}?${new URLSearchParams({ seed: String(seed), agents: String(agentCount) })}`;
}

export function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 999_999_999);
}
