import type { Agent, Conversation, DialogueProvider, Grid, ObjectDef, ObjectInstance, Relationships, Room, SimEvent, TileKind, World } from '../types.ts';
import { createRng } from './rng.ts';

// World snapshots: the whole simulation state as plain JSON, and a working World rebuilt from it.
//
// The World object holds only part of the state; the rest lives in module-level WeakMaps keyed
// by the World or by Agent objects (goals, memories, bonds, diaries, projects…). Each such module
// registers a codec here at import time (registerWorldState) with its save/load functions next to
// its WeakMaps. snapshotWorld calls every save; restoreWorld builds the base World and calls every
// load in registration order; applySnapshot updates an existing World in place the same way
// (every codec's clear, then load). Agent-keyed state is saved by agent id, object-keyed state by
// uid, event-keyed state by index in world.events, conversation-keyed state by conversation id.
//
// Rules for codecs:
//  - save returns plain JSON (no Maps, Sets, functions, ±Infinity: use toJson / fromJson), never
//    aliases live objects, and returns null when the module has no state for the world yet (the
//    lazy state is then created on restore exactly when the original would create it);
//  - load must copy what it keeps (one snapshot may be restored many times);
//  - functions / external hooks (weather override, news feed, AI clients, listeners) are not
//    state: the owner re-attaches them after restoreWorld.
//
// This module imports only leaf modules (types, rng), so registering from anywhere never forms an
// import cycle. The pieces of a World that need simulation modules (object defs, the procedural
// dialogue provider, the relationships store) come from world.ts via registerWorldBase.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** bump whenever the snapshot layout or any codec's data changes incompatibly */
export const SNAPSHOT_VERSION = 1;

export interface SnapshotOptions {
  /**
   * activity trace (world/trace.ts): false/undefined = omitted (network snapshots), true = the
   * whole ring buffer, a number = at most that many newest entries. The trace only feeds
   * diagnostics and the diary (which reads entries newer than its last tick), so leaving it out
   * does not change the simulation.
   */
  includeTrace?: boolean | number;
  /**
   * diary day facts (social/diary.ts) kept per resident: undefined = all (up to 60 days, the
   * biggest part of an old world), n = the last n days. Facts only feed the optional AI rewrite of
   * recent entries and diaryFactsOf, so dropping old ones does not change the simulation.
   */
  diaryFactDays?: number;
}

/** compact snapshot for sending a world to the browser (live frames) */
export const NETWORK_SNAPSHOT: SnapshotOptions = { includeTrace: false, diaryFactDays: 2 };
/** full snapshot for persisting a live world (server volume) */
export const DISK_SNAPSHOT: SnapshotOptions = { includeTrace: true };

export interface RestoreOptions {
  /** dialogue provider for the restored world (default: a new procedural provider) */
  dialogue?: DialogueProvider;
}

export interface WorldStateCodec {
  /** null = no state for this world (yet) */
  save(world: World, opts: SnapshotOptions): Json;
  /** called only for non-null data, after the base world (agents, objects, events…) exists */
  load(world: World, data: Json): void;
  /**
   * forgets this module's state for `world` (and for its current agents). applySnapshot calls it
   * before every load, so state the new snapshot lacks does not outlive the update. Hooks of the
   * running page (listeners, clients) are not state and must survive it.
   */
  clear?(world: World): void;
  /**
   * the module came after snapshots already in use (live worlds on disk): a snapshot without its
   * key is still accepted, and `missing` runs instead of load whenever the data is absent or null
   */
  optional?: boolean;
  /** called instead of load when the snapshot has no data for this module */
  missing?(world: World): void;
}

export interface WorldSnapshot {
  version: number;
  seed: number;
  tick: number;
  /** world.rng.state() */
  rng: number;
  /** house layout id (copy of modules.map) */
  mapId: string | null;
  grid: SnapshotGrid;
  objects: ObjectInstance[];
  agents: Agent[];
  /** [a, b, sympathy] for every stored pair, a < b */
  relationships: [number, number, number][];
  conversations: Conversation[];
  events: SimEvent[];
  /** registered module state by key (registration order) */
  modules: Record<string, Json>;
}

export interface SnapshotGrid {
  width: number;
  height: number;
  /** one character per tile, row-major (see TILE_CHARS) */
  tiles: string;
  /** '1' = solid, '0' = free, row-major */
  solid: string;
  rooms: Room[];
}

export class SnapshotVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotVersionError';
  }
}

// ---------------------------------------------------------------- registry

const registry = new Map<string, WorldStateCodec>();

/** registers a module's world state; call once at module import time */
export function registerWorldState(key: string, codec: WorldStateCodec): void {
  if (registry.has(key)) throw new Error(`registerWorldState: duplicate key "${key}"`);
  registry.set(key, codec);
}

/** registered keys in registration (= load) order */
export function registeredWorldStates(): string[] {
  return [...registry.keys()];
}

export interface WorldBase {
  objectDefs: Record<string, ObjectDef>;
  createDialogue(): DialogueProvider;
  createRelationships(): Relationships;
}

let base: WorldBase | null = null;

/** called by world/world.ts at import time */
export function registerWorldBase(b: WorldBase): void {
  base = b;
}

// ---------------------------------------------------------------- generic JSON codec

/**
 * plain JSON for any data built from objects, arrays, Maps, Sets and numbers (incl. ±Infinity,
 * NaN); undefined object fields are dropped, undefined array items kept. Always copies.
 */
export function toJson(v: unknown): Json {
  if (v === null) return null;
  switch (typeof v) {
    case 'number':
      return Number.isFinite(v) ? v : { __n: String(v) };
    case 'string':
    case 'boolean':
      return v;
    case 'undefined':
      return { __u: 1 };
    case 'object':
      break;
    default:
      throw new Error(`toJson: cannot encode a ${typeof v}`);
  }
  if (Array.isArray(v)) return v.map(toJson);
  if (v instanceof Map) return { __m: [...v].map(([k, x]) => [toJson(k), toJson(x)]) };
  if (v instanceof Set) return { __s: [...v].map(toJson) };
  if (v instanceof WeakMap || v instanceof WeakSet) throw new Error('toJson: WeakMap / WeakSet need a custom codec');
  const out: { [key: string]: Json } = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === undefined) continue;
    out[k] = toJson(x);
  }
  return out;
}

/** inverse of toJson (always builds new objects) */
export function fromJson<T = unknown>(j: Json): T {
  return decode(j) as T;
}

function decode(j: Json): unknown {
  if (j === null || typeof j !== 'object') return j;
  if (Array.isArray(j)) return j.map(decode);
  if ('__n' in j) return Number(j.__n);
  if ('__u' in j) return undefined;
  if ('__m' in j) return new Map((j.__m as Json[][]).map(([k, x]) => [decode(k), decode(x)]));
  if ('__s' in j) return new Set((j.__s as Json[]).map(decode));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(j)) out[k] = decode(x);
  return out;
}

// ---------------------------------------------------------------- helpers for codecs

/** Agent-keyed WeakMap → [[agentId, value], …] in world.agents order (null if empty) */
export function saveByAgent<T>(world: World, map: WeakMap<Agent, T>, enc: (v: T) => Json = toJson): Json {
  const out: Json[] = [];
  for (const a of world.agents) if (map.has(a)) out.push([a.id, enc(map.get(a) as T)]);
  return out.length ? out : null;
}

/** restores saveByAgent data onto the restored world's Agent objects */
export function loadByAgent<T>(world: World, map: WeakMap<Agent, T>, data: Json, dec: (j: Json) => T = fromJson): void {
  for (const [id, v] of data as [number, Json][]) {
    const agent = world.agents.find((a) => a.id === id);
    if (agent) map.set(agent, dec(v));
  }
}

/** indices (into world.events) of the events in a WeakSet */
export function saveEventSet(world: World, set: WeakSet<object>): number[] {
  const out: number[] = [];
  world.events.forEach((e, i) => set.has(e) && out.push(i));
  return out;
}

export function loadEventSet(world: World, set: WeakSet<object>, data: Json): void {
  for (const i of data as number[]) {
    const e = world.events[i];
    if (e) set.add(e);
  }
}

// ---------------------------------------------------------------- grid

const TILE_CHARS: Record<TileKind, string> = { grass: 'g', path: 'p', floor: 'f', tile: 't', wall: 'w', door: 'd', water: '~' };
const CHAR_TILES = Object.fromEntries(Object.entries(TILE_CHARS).map(([k, c]) => [c, k as TileKind])) as Record<string, TileKind>;

function encodeGrid(g: Grid): SnapshotGrid {
  return {
    width: g.width,
    height: g.height,
    tiles: g.tiles
      .map((t) => {
        const c = TILE_CHARS[t];
        if (!c) throw new Error(`snapshotWorld: unknown tile kind "${t}"`);
        return c;
      })
      .join(''),
    solid: g.solid.map((s) => (s ? '1' : '0')).join(''),
    rooms: clone(g.rooms),
  };
}

function decodeGrid(g: SnapshotGrid): Grid {
  const n = g.width * g.height;
  if (g.tiles.length !== n || g.solid.length !== n) throw new Error('restoreWorld: grid size mismatch');
  return {
    width: g.width,
    height: g.height,
    tiles: [...g.tiles].map((c) => {
      const t = CHAR_TILES[c];
      if (!t) throw new Error(`restoreWorld: unknown tile char "${c}"`);
      return t;
    }),
    solid: [...g.solid].map((c) => c === '1'),
    rooms: clone(g.rooms),
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ---------------------------------------------------------------- snapshot / restore

/** the whole simulation state of `world` as plain JSON (see SnapshotOptions) */
export function snapshotWorld(world: World, opts: SnapshotOptions = {}): WorldSnapshot {
  const modules: Record<string, Json> = {};
  for (const [key, codec] of registry) modules[key] = codec.save(world, opts) ?? null;
  return {
    version: SNAPSHOT_VERSION,
    seed: world.seed,
    tick: world.tick,
    rng: world.rng.state(),
    mapId: typeof modules.map === 'string' ? modules.map : null,
    grid: encodeGrid(world.grid),
    objects: clone(world.objects),
    agents: clone(world.agents),
    relationships: world.relationships.all().map((r) => [r.a, r.b, r.value]),
    conversations: clone(world.conversations),
    events: clone(world.events),
    modules,
  };
}

/** one registered module's state as plain JSON (null = none), without snapshotting the rest of the world */
export function saveWorldModule(world: World, key: string, opts: SnapshotOptions = NETWORK_SNAPSHOT): Json {
  return registry.get(key)?.save(world, opts) ?? null;
}

/** throws SnapshotVersionError when `snap` cannot be restored by this build */
export function checkSnapshot(snap: unknown): asserts snap is WorldSnapshot {
  const s = snap as Partial<WorldSnapshot> | null;
  if (!s || typeof s !== 'object' || typeof s.version !== 'number') throw new SnapshotVersionError('Not a world snapshot');
  if (s.version !== SNAPSHOT_VERSION)
    throw new SnapshotVersionError(`World snapshot version ${s.version} is not supported (expected ${SNAPSHOT_VERSION})`);
  const mods = s.modules ?? {};
  const unknown = Object.keys(mods).filter((k) => !registry.has(k));
  const missing = [...registry].filter(([k, c]) => !c.optional && !(k in mods)).map(([k]) => k);
  if (unknown.length || missing.length)
    throw new SnapshotVersionError(
      `World snapshot modules do not match this build (unknown: ${unknown.join(', ') || '-'}; missing: ${missing.join(', ') || '-'})`,
    );
}

/** builds a working World from a snapshot (the snapshot itself is not modified or aliased) */
export function restoreWorld(snap: WorldSnapshot, opts: RestoreOptions = {}): World {
  if (!base) throw new Error('restoreWorld: world modules are not loaded (import src/world/world.ts first)');
  checkSnapshot(snap);
  const relationships = base.createRelationships();
  for (const [a, b, v] of snap.relationships) relationships.adjust(a, b, v);
  const world: World = {
    seed: snap.seed,
    rng: createRng(snap.seed, snap.rng),
    tick: snap.tick,
    grid: decodeGrid(snap.grid),
    objectDefs: base.objectDefs,
    objects: clone(snap.objects),
    agents: clone(snap.agents),
    relationships,
    // an async (LLM) line in flight is lost with the old world: ask again
    conversations: clone(snap.conversations).map((c) => (c.pending ? { ...c, pending: false } : c)),
    events: clone(snap.events),
    dialogue: opts.dialogue ?? base.createDialogue(),
  };
  for (const [key, codec] of registry) {
    const data = snap.modules[key];
    if (data !== null && data !== undefined) codec.load(world, data);
    else codec.missing?.(world);
  }
  return world;
}

// ---------------------------------------------------------------- in-place update

/** replaces the own fields of `dst` with a copy of `src` (the object keeps its identity) */
function overwrite<T extends object>(dst: T, src: T): T {
  const d = dst as Record<string, unknown>;
  for (const k of Object.keys(d)) if (!(k in src)) delete d[k];
  return Object.assign(dst, clone(src));
}

/** makes `target` hold `source` items in order, reusing (and overwriting) the existing item with the same key */
function syncById<T extends object>(target: T[], source: readonly T[], keyOf: (t: T) => number): void {
  const old = new Map(target.map((t) => [keyOf(t), t] as const));
  const next = source.map((s) => {
    const existing = old.get(keyOf(s));
    return existing ? overwrite(existing, s) : clone(s);
  });
  target.splice(0, target.length, ...next);
}

function sameGridShape(a: Grid, b: Grid): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.tiles.length === b.tiles.length &&
    a.tiles.every((t, i) => t === b.tiles[i]) &&
    JSON.stringify(a.rooms) === JSON.stringify(b.rooms)
  );
}

/**
 * updates `world` in place to the state of `snap`, as if it were restoreWorld(snap) but keeping
 * the World, its Agent / object / conversation instances (matched by id / uid), the event objects
 * that did not change, and the hooks of the running page (dialogue provider, diary listeners).
 * `world.grid` stays the same object while tiles and rooms are unchanged (the renderer keys its
 * static layer on it); only `solid` is refreshed then. Throws (before touching `world`) when the
 * snapshot cannot be restored by this build.
 */
export function applySnapshot(world: World, snap: WorldSnapshot): void {
  if (!base) throw new Error('applySnapshot: world modules are not loaded (import src/world/world.ts first)');
  checkSnapshot(snap);
  const grid = decodeGrid(snap.grid);

  world.seed = snap.seed;
  world.tick = snap.tick;
  if (world.rng.setState) world.rng.setState(snap.rng);
  else world.rng = createRng(snap.seed, snap.rng);

  if (sameGridShape(world.grid, grid)) grid.solid.forEach((s, i) => (world.grid.solid[i] = s));
  else world.grid = grid;

  syncById(world.objects, snap.objects, (o) => o.uid);
  syncById(world.agents, snap.agents, (a) => a.id);
  // an async (LLM) line in flight is lost, as in restoreWorld: ask again
  syncById(
    world.conversations,
    snap.conversations.map((c) => (c.pending ? { ...c, pending: false } : c)),
    (c) => c.id,
  );

  const oldEvents = new Map<string, SimEvent[]>();
  for (const e of world.events) {
    const k = JSON.stringify(e);
    const list = oldEvents.get(k);
    if (list) list.push(e);
    else oldEvents.set(k, [e]);
  }
  const events = snap.events.map((e) => oldEvents.get(JSON.stringify(e))?.shift() ?? clone(e));
  world.events.splice(0, world.events.length, ...events);

  const relationships = base.createRelationships();
  for (const [a, b, v] of snap.relationships) relationships.adjust(a, b, v);
  world.relationships = relationships;

  for (const [key, codec] of registry) {
    codec.clear?.(world);
    const data = snap.modules[key];
    if (data !== null && data !== undefined) codec.load(world, data);
    else codec.missing?.(world);
  }
}
