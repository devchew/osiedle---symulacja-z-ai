import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, deflateRawSync, constants as zc } from 'node:zlib';
import type { Agent, World } from '../src/types';
import { createWorld, restoreWorld, tickWorld } from '../src/world/world';
import { NETWORK_SNAPSHOT, DISK_SNAPSHOT, SnapshotVersionError, snapshotWorld, type WorldSnapshot } from '../src/core/state';
import { setWeatherOverride, weatherOf } from '../src/world/incidents';
import { hasRealNews, setNewsFeed } from '../src/world/news';
import { setDiaryAiEnabled } from '../src/social/diary';
import { collectEvents, createChronicle, rewindChronicle, toView, type ChronicleStore } from '../src/social/chronicle';
import { isAgentSleeping } from '../src/agents/actions';
import { jointSessions, type JointKind } from '../src/agents/joint';
import { joinNames } from '../src/agents/groups';
import { activeProject } from '../src/world/projects';
import { baseDayFor, localTimeIn, parseLocalTime, MAX_CATCH_UP_TICKS, reanchorBaseDay, targetTick, tickToLocal, type LocalTime } from '../src/realtime/clock';
import { fetchRealWeather, weatherSource, type RealWeather } from '../src/realtime/weather';
import { LIVE_TIME_ZONE, PLACES, type LiveFrame, type PlaceDef, type PlaceId, type PlaceSummary } from '../src/live/protocol';
import { createAiGate, createGatedChronicleClient, createGatedDiaryClient, createGatedDialogue, type AiBudgetView, type AiGate } from './worldsAi';
import type { ChronicleAiClient } from '../src/social/chronicleAi';
import { chroniclePath, decodeChronicle, encodeChronicle, summaryCandidate, summaryRequest } from './chronicle';
import { createReplayRecorder, type ReplayRecorder } from '../src/live/replayRecorder';
import { decodeReplay, encodeReplay, replayPath } from './replay';

// Live worlds host: the four PLACES as shared worlds running 24/7 in real time on the server.
// No Vite imports — used by server/prod.ts and by the Vite plugin (server/worldsProxy.ts).
//
// Clock: 1 tick = 1 game minute = 1 real minute; the game clock equals Europe/Warsaw wall time
// regardless of the process TZ (clock.ts localTimeIn). Each world keeps its own anchor `baseDay`
// (calendar day of game day 0) next to its snapshot. A fresh world is fast-forwarded from tick 0
// (day 1, 07:00) to now. A timer fires right after every wall-clock minute boundary and steps each
// world up to the target tick (catching up after event-loop stalls / suspend, in chunks that yield
// to the event loop). More than MAX_CATCH_UP_TICKS (3 days) behind — e.g. the container was down
// for a week — the anchor is moved forward by whole days instead of replaying everything: those
// days simply never happened in the world (reanchorBaseDay).
//
// Inputs: real weather per place (Open-Meteo, Warsaw-time hourly keys, refreshed every 15 min,
// fed through setWeatherOverride), real headlines shared by all worlds (setNewsFeed), and AI
// dialogue + diary rewrites through this process' /api/llm handler with a per-world budget share
// (worldsAi.ts). Hooks are not snapshot state: they are attached after create / restore.
//
// Persistence: DATA_DIR/<place>.json = { format, place, baseDay, savedAt, snapshot: DISK_SNAPSHOT },
// written atomically (tmp + rename) every 5 minutes and on shutdown. A file that cannot be restored
// (corrupt, other snapshot version, other place) is renamed to <place>.json.bak and the world starts
// fresh.
//
// Chronicle (src/social/chronicle.ts): after every tick the worlds' new events are classified and
// the important ones kept for 14 days in DATA_DIR/<place>.chronicle.json (saved with the snapshot).
// With AI on, each finished day gets one budgeted AI summary (a failure keeps the procedural one).
//
// Replay (src/live/replayRecorder.ts): after every tick the world's visible state is recorded as
// change-only rows for the last 24 h (bounded memory) and served read-only as one JSON document
// (GET /api/live/:place/replay); saved in DATA_DIR/<place>.replay.json just before the snapshot.
//
// Frames: after every tick each world's LiveFrame (NETWORK_SNAPSHOT) is serialized once and
// shared by every subscriber (see LiveFrameData; gzip variants are computed lazily, once).

export const SAVE_EVERY_MS = 5 * 60_000;
export const WEATHER_REFRESH_MS = 15 * 60_000;
export const NEWS_REFRESH_MS = 15 * 60_000;
/** ticks stepped before yielding to the event loop while catching up */
export const CATCH_UP_CHUNK = 240;
/** the minute timer fires this long after the boundary (so the wall clock surely shows the new minute) */
const TIMER_SLACK_MS = 30;
const FILE_FORMAT = 1;

export interface LiveNewsSource {
  /** current headlines (may be empty); never throws */
  headlines(): Promise<readonly { title: string; source?: string }[]>;
}

export interface LiveAiOptions {
  /** fetch() reaching this process' /api/llm handler (worldsAi.inProcessFetch) */
  fetch: typeof fetch;
  /** the handler's daily budget (shared with browser callers) */
  budget: AiBudgetView;
}

export type WeatherFetcher = (place: PlaceDef) => Promise<RealWeather>;

export interface LiveHostOptions {
  places?: readonly PlaceDef[];
  /** directory for snapshots; null = no persistence */
  dataDir?: string | null;
  /** game minutes per real minute (default 1 = real time; 60 → one tick per second) */
  speed?: number;
  /** pin the clock to this Warsaw wall-clock reading (deterministic e2e); no ticks after the sync */
  fixedTime?: LocalTime | null;
  timeZone?: string;
  /** real time source (ms), default Date.now */
  now?: () => number;
  /** real weather; null = seeded weather plan */
  weather?: WeatherFetcher | null;
  news?: LiveNewsSource | null;
  ai?: LiveAiOptions | null;
  saveEveryMs?: number;
  /** wait this long for the first weather / news before the initial fast-forward (default 6 s) */
  inputTimeoutMs?: number;
  log?: (msg: string) => void;
}

/** one serialized frame, shared by all subscribers of a world */
export interface LiveFrameData {
  place: PlaceId;
  tick: number;
  serverTime: number;
  /** JSON of the LiveFrame */
  json: string;
  /** the SSE message `event: frame` (utf-8) */
  sse: Buffer;
  /** `sse` as a self-contained raw-deflate segment (full flush) for gzip streams, computed once */
  sseDeflated(): Buffer;
  /** `json` gzipped (snapshot endpoint), computed once */
  jsonGzip(): Buffer;
}

/** one serialized chronicle response (GET /api/live/:place/chronicle), cached until the chronicle changes */
export interface ChronicleData {
  etag: string;
  json: string;
  /** `json` gzipped, computed once */
  jsonGzip(): Buffer;
}

/** one serialized replay response (GET /api/live/:place/replay), cached until the next tick */
export interface ReplayData {
  etag: string;
  json: string;
  /** `json` gzipped, computed once */
  jsonGzip(): Buffer;
}

export interface LiveWorld {
  place: PlaceDef;
  world: World;
  /** the last 24 h, recorded after every tick */
  replay: ReplayRecorder;
  /** important events of the last days (see src/social/chronicle.ts) */
  chronicle: ChronicleStore;
  /** local calendar day number (days since 1970-01-01) of game day 0 */
  baseDay: number;
  ready: boolean;
  /** restored from disk (false = created fresh) */
  restored: boolean;
  weather: RealWeather | null;
  weatherUpdatedAt: number | null;
  ai: boolean;
  frame: LiveFrameData | null;
}

export interface LiveHost {
  /** resolves when every world is synced to the clock */
  readonly ready: Promise<void>;
  readonly places: readonly PlaceDef[];
  get(id: string): LiveWorld | undefined;
  summaries(): PlaceSummary[];
  /** the place's chronicle; undefined for an unknown place or while the world is not synced */
  chronicle(id: string): ChronicleData | undefined;
  /** the place's last-24 h recording; undefined for an unknown place or while the world is not synced */
  replay(id: string): ReplayData | undefined;
  /** subscribe to a world's frames (called after each published tick) */
  onFrame(id: PlaceId, fn: (frame: LiveFrameData) => void): () => void;
  /** registers a viewer (SSE stream) of a world, for the AI budget priority; returns the release function */
  addViewer(id: PlaceId): () => void;
  viewers(id: PlaceId): number;
  /** the current local wall-clock reading used by the worlds */
  localNow(): LocalTime;
  /** steps every ready world up to the clock now (also what the minute timer runs) */
  sync(): Promise<void>;
  saveAll(): Promise<void>;
  /** synchronous save, for shutdown / process exit */
  saveAllSync(): void;
  /** stops timers (no save) */
  stop(): void;
  readonly aiGate: AiGate | null;
}

// ---------------------------------------------------------------- env

export interface LiveEnvConfig {
  enabled: boolean;
  dataDir: string | null;
  speed: number;
  fixedTime: LocalTime | null;
  ai: boolean;
  news: boolean;
  weather: boolean;
}

const off = (v: string | undefined): boolean => /^(off|0|false|no)$/i.test((v ?? '').trim());

/**
 * LIVE_WORLDS=off (disable), DATA_DIR (default ./data; "off" = no persistence), LIVE_SPEED (1),
 * LIVE_FIXED_TIME ("2026-10-29T12:00", Warsaw wall time; implies no persistence unless DATA_DIR is
 * set explicitly), LIVE_AI=off, LIVE_WEATHER=off, NEWS_FEEDS=off. `aiDefault` = AI when LIVE_AI is
 * unset (prod: on, dev server: off — set LIVE_AI=on to spend the quota from `npm run dev`).
 */
export function liveConfigFromEnv(env: Record<string, string | undefined>, aiDefault = true): LiveEnvConfig {
  const fixedRaw = (env.LIVE_FIXED_TIME ?? '').trim();
  const fixedTime = fixedRaw ? parseFixedTime(fixedRaw) : null;
  const dataRaw = (env.DATA_DIR ?? '').trim();
  const dataDir = off(dataRaw) ? null : dataRaw || (fixedTime ? null : './data');
  const speed = Number((env.LIVE_SPEED ?? '').trim() || 1);
  return {
    enabled: !off(env.LIVE_WORLDS),
    dataDir,
    speed: Number.isFinite(speed) && speed > 0 ? Math.min(speed, 3600) : 1,
    fixedTime,
    ai: (env.LIVE_AI ?? '').trim() === '' ? aiDefault : !off(env.LIVE_AI),
    news: !off(env.NEWS_FEEDS),
    weather: !off(env.LIVE_WEATHER),
  };
}

function parseFixedTime(s: string): LocalTime {
  const t = parseLocalTime(s);
  if (!t) throw new Error(`LIVE_FIXED_TIME must look like 2026-10-29T12:00 (got "${s}")`);
  return t;
}

// ---------------------------------------------------------------- highlights (Polish, no gendered forms)

const JOINT_PLURAL: Record<JointKind, string> = { fishing: 'łowią ryby 🎣', console: 'grają na konsoli 🕹️', boardgame: 'grają w planszówki 🎲' };
/** objects where several people doing the same thing reads well in plural */
const GROUP_PLURAL: Record<string, string> = {
  table: 'jedzą razem przy stole 🍲',
  grill: 'grillują razem 🌭',
  tv: 'oglądają razem telewizję 📺',
  bench: 'odpoczywają razem na ławce 🪑',
  console: 'grają na konsoli 🕹️',
  boardgame: 'grają w planszówki 🎲',
  pier: 'łowią ryby 🎣',
};
const DULL = /^(toilet|sink|bed|shower|bath)/;

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

/** short Polish line about what is going on in a world, or null when nothing is */
export function placeHighlight(world: World): string | null {
  const name = (id: number): string => world.agents.find((a) => a.id === id)?.name ?? '?';
  const awake = world.agents.filter((a) => !isAgentSleeping(world, a));
  if (!awake.length) return world.agents.length ? '💤 Cisza nocna' : null;

  const sessions = jointSessions(world)
    .filter((s) => s.phase === 'playing' && s.hereIds.length >= 2)
    .sort((a, b) => b.hereIds.length - a.hereIds.length);
  if (sessions.length) return `${joinNames(sessions[0].hereIds.map(name))} ${JOINT_PLURAL[sessions[0].kind]}`;

  const using = new Map<string, Agent[]>();
  for (const a of awake) {
    const act = a.action;
    if (act?.kind !== 'use' || act.phase !== 'using') continue;
    const obj = world.objects.find((o) => o.uid === act.objectUid);
    if (!obj || !GROUP_PLURAL[obj.type]) continue;
    using.set(obj.type, [...(using.get(obj.type) ?? []), a]);
  }
  const group = [...using.entries()].filter(([, as]) => as.length >= 2).sort((a, b) => b[1].length - a[1].length)[0];
  if (group) return `${joinNames(group[1].map((a) => a.name))} ${GROUP_PLURAL[group[0]]}`;

  const project = activeProject(world);
  if (project && project.workerIds.length) return `🔨 Budowa (${project.name}): ${joinNames(project.workerIds.map(name))}`;

  const talk = world.conversations.find((c) => c.lines.length > 0 || c.pending);
  if (talk) return `💬 ${joinNames(talk.participants.map(name))} rozmawiają`;

  for (const a of awake) {
    const act = a.action;
    if (act?.kind !== 'use' || act.phase !== 'using' || !act.label) continue;
    const obj = world.objects.find((o) => o.uid === act.objectUid);
    if (obj && DULL.test(obj.type)) continue;
    return `${act.icon} ${a.name}: ${lowerFirst(act.label)}`;
  }
  return null;
}

// ---------------------------------------------------------------- frames

const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff]);

/** first bytes of a gzip SSE stream; follow with deflated segments (deflateSegment) */
export function gzipStreamHeader(): Buffer {
  return GZIP_HEADER;
}

/**
 * one self-contained raw-deflate segment: compressed independently and ended with a full flush
 * (byte-aligned, no final block), so any sequence of segments after GZIP_HEADER is a valid
 * (open-ended) gzip stream. This lets every SSE subscriber share one compressed copy of a frame.
 */
export function deflateSegment(data: Buffer | string): Buffer {
  return deflateRawSync(typeof data === 'string' ? Buffer.from(data) : data, { finishFlush: zc.Z_FULL_FLUSH, level: 6 });
}

export function sseMessage(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

function makeFrame(lw: LiveWorld, serverTime: number, newsOn: boolean): LiveFrameData {
  const { kind, intensity, label, icon } = weatherOf(lw.world);
  const frame: LiveFrame = {
    meta: {
      place: lw.place.id,
      serverTime,
      tick: lw.world.tick,
      weather: {
        city: lw.place.city,
        temperature: lw.weather?.current?.temperature ?? null,
        source: lw.weather ? 'open-meteo' : 'plan',
        updatedAt: lw.weatherUpdatedAt,
        sample: { kind, intensity, label, icon },
      },
      ai: lw.ai,
      news: newsOn && hasRealNews(lw.world),
    },
    snapshot: snapshotWorld(lw.world, NETWORK_SNAPSHOT),
  };
  const json = JSON.stringify(frame);
  const sse = Buffer.from(sseMessage('frame', json));
  let deflated: Buffer | null = null;
  let gz: Buffer | null = null;
  return {
    place: lw.place.id,
    tick: lw.world.tick,
    serverTime,
    json,
    sse,
    sseDeflated: () => (deflated ??= deflateSegment(sse)),
    jsonGzip: () => (gz ??= gzipSync(json)),
  };
}

// ---------------------------------------------------------------- persistence

interface SavedWorld {
  format: number;
  place: PlaceId;
  baseDay: number;
  savedAt: number;
  snapshot: WorldSnapshot;
}

export function snapshotPath(dataDir: string, place: PlaceId): string {
  return join(dataDir, `${place}.json`);
}

function encodeSave(lw: LiveWorld, savedAt: number): string {
  const s: SavedWorld = { format: FILE_FORMAT, place: lw.place.id, baseDay: lw.baseDay, savedAt, snapshot: snapshotWorld(lw.world, DISK_SNAPSHOT) };
  return JSON.stringify(s);
}

/** parses + restores a save file's content; throws on anything unusable */
export function decodeSave(text: string, place: PlaceDef): { world: World; baseDay: number } {
  const s = JSON.parse(text) as Partial<SavedWorld>;
  if (!s || s.format !== FILE_FORMAT || s.place !== place.id || typeof s.baseDay !== 'number' || !s.snapshot)
    throw new SnapshotVersionError(`not a live world save for "${place.id}"`);
  if (s.snapshot.seed !== place.seed || (s.snapshot.mapId ?? 'dom') !== place.mapId)
    throw new SnapshotVersionError(`save for "${place.id}" has another seed / map`);
  return { world: restoreWorld(s.snapshot), baseDay: s.baseDay };
}

// ---------------------------------------------------------------- host

const sleep0 = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export function createLiveHost(opts: LiveHostOptions = {}): LiveHost {
  const places = opts.places ?? PLACES;
  const tz = opts.timeZone ?? LIVE_TIME_ZONE;
  const realNow = opts.now ?? Date.now;
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const fixed = opts.fixedTime ?? null;
  const dataDir = opts.dataDir ?? null;
  const log = opts.log ?? ((m: string) => console.log(`[live] ${m}`));
  const inputTimeout = opts.inputTimeoutMs ?? 6000;
  const startReal = realNow();
  const worlds = new Map<PlaceId, LiveWorld>();
  const listeners = new Map<PlaceId, Set<(f: LiveFrameData) => void>>();
  const viewerCounts = new Map<PlaceId, number>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let minuteTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let syncing: Promise<void> | null = null;
  let headlines: readonly { title: string; source?: string }[] = [];

  /** virtual ms: wall time, sped up by LIVE_SPEED from the host start */
  const virtualMs = (): number => startReal + (realNow() - startReal) * speed;
  const localNow = (): LocalTime => fixed ?? localTimeIn(new Date(virtualMs()), tz);

  const aiGate = opts.ai
    ? createAiGate({ budget: opts.ai.budget, worlds: places.length, watched: (p) => (viewerCounts.get(p as PlaceId) ?? 0) > 0, now: realNow })
    : null;

  // ------------------------------------------------ inputs
  async function refreshWeather(lw: LiveWorld): Promise<void> {
    if (!opts.weather) return;
    try {
      lw.weather = await opts.weather(lw.place);
      lw.weatherUpdatedAt = realNow();
    } catch (err) {
      log(`${lw.place.id}: weather refresh failed (${(err as Error)?.message ?? err})`);
    }
  }

  async function refreshNews(): Promise<void> {
    if (!opts.news) return;
    try {
      const items = await opts.news.headlines();
      if (!items.length) return;
      headlines = items;
      for (const lw of worlds.values()) setNewsFeed(lw.world, headlines);
    } catch (err) {
      log(`news refresh failed (${(err as Error)?.message ?? err})`);
    }
  }

  function attachHooks(lw: LiveWorld): void {
    // weather: hourly real readings keyed by Warsaw local hour of each tick
    if (opts.weather)
      setWeatherOverride(
        lw.world,
        weatherSource(
          () => lw.weather,
          () => lw.baseDay,
        ),
      );
    if (headlines.length) setNewsFeed(lw.world, headlines);
  }

  function attachAi(lw: LiveWorld): void {
    if (!opts.ai || !aiGate) return;
    const fallback = lw.world.dialogue;
    lw.world.dialogue = createGatedDialogue(lw.place.id, aiGate, opts.ai.fetch, fallback);
    setDiaryAiEnabled(lw.world, true, { client: createGatedDiaryClient(lw.place.id, aiGate, opts.ai.fetch), spacingMs: 8000 });
    chronicleClients.set(lw.place.id, createGatedChronicleClient(lw.place.id, aiGate, opts.ai.fetch));
    lw.ai = true;
  }

  // ------------------------------------------------ chronicle
  const chronicleClients = new Map<PlaceId, ChronicleAiClient>();
  const summarizing = new Set<PlaceId>();
  const chronicleCache = new Map<PlaceId, ChronicleData & { key: string }>();

  const dateOf = (lw: { baseDay: number }) => (tick: number): string => tickToLocal(tick, lw.baseDay).date;

  /** never throws: an unusable file is renamed to .bak and the chronicle starts over */
  async function loadChronicle(place: PlaceDef, world: World, baseDay: number, restored: boolean): Promise<ChronicleStore> {
    let store = createChronicle();
    if (dataDir) {
      const file = chroniclePath(dataDir, place.id);
      let text: string | null = null;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        /* no chronicle yet */
      }
      if (text !== null) {
        try {
          store = decodeChronicle(text, place);
        } catch (err) {
          log(`${place.id}: cannot read ${file} (${(err as Error)?.message ?? err}) — starting a new chronicle, old file kept as .bak`);
          await rename(file, `${file}.bak`).catch(() => {});
        }
      }
    }
    // a fresh world restarts at tick 0: older days stay, the new ticks are collected from the start
    if (restored) rewindChronicle(store, world.tick);
    else store.lastTick = 0;
    collectEvents(store, world.events, world.tick, dateOf({ baseDay }));
    return store;
  }

  function maybeSummarize(lw: LiveWorld): void {
    const client = chronicleClients.get(lw.place.id);
    if (!client || stopped || summarizing.has(lw.place.id)) return;
    const day = summaryCandidate(lw.chronicle, tickToLocal(lw.world.tick, lw.baseDay).date);
    if (!day) return;
    day.aiTried = true;
    summarizing.add(lw.place.id);
    client
      .write(summaryRequest(lw.place, day, lw.world.agents.map((a) => a.name)))
      .then(
        (text) => {
          day.ai = text;
        },
        (err: unknown) => log(`${lw.place.id}: chronicle summary of ${day.date} failed (${(err as Error)?.message ?? err})`),
      )
      .finally(() => summarizing.delete(lw.place.id));
  }

  function chronicleData(lw: LiveWorld): ChronicleData {
    const key = `${lw.chronicle.lastTick}-${lw.chronicle.days.filter((d) => d.ai).length}`;
    const hit = chronicleCache.get(lw.place.id);
    if (hit && hit.key === key) return hit;
    const json = JSON.stringify(toView(lw.chronicle, lw.place.id, lw.chronicle.lastTick));
    let gz: Buffer | null = null;
    const data = { key, etag: `"c-${lw.place.id}-${key}"`, json, jsonGzip: () => (gz ??= gzipSync(json)) };
    chronicleCache.set(lw.place.id, data);
    return data;
  }

  // ------------------------------------------------ replay
  const replayCache = new Map<PlaceId, ReplayData & { key: string }>();

  function replayData(lw: LiveWorld): ReplayData {
    const key = `${lw.replay.lastTick}`;
    const hit = replayCache.get(lw.place.id);
    if (hit && hit.key === key) return hit;
    const json = JSON.stringify(lw.replay.data(realNow()));
    let gz: Buffer | null = null;
    const data = { key, etag: `"r-${lw.place.id}-${key}"`, json, jsonGzip: () => (gz ??= gzipSync(json)) };
    replayCache.set(lw.place.id, data);
    return data;
  }

  /** never throws: an unusable file is renamed to .bak and the recording starts over */
  async function loadReplay(place: PlaceDef, world: World, restored: boolean): Promise<ReplayRecorder> {
    const rec = createReplayRecorder(place.id);
    if (!dataDir || !restored) return rec;
    const file = replayPath(dataDir, place.id);
    let text: string | null = null;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      /* no recording yet */
    }
    if (text === null) return rec;
    try {
      decodeReplay(text, rec);
      rec.rewind(world.tick);
      return rec;
    } catch (err) {
      log(`${place.id}: cannot read ${file} (${(err as Error)?.message ?? err}) — starting a new recording, old file kept as .bak`);
      await rename(file, `${file}.bak`).catch(() => {});
      return createReplayRecorder(place.id);
    }
  }

  // ------------------------------------------------ load / create
  async function load(place: PlaceDef): Promise<LiveWorld> {
    if (dataDir) {
      const file = snapshotPath(dataDir, place.id);
      let text: string | null = null;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        /* no save yet */
      }
      if (text !== null) {
        try {
          const { world, baseDay } = decodeSave(text, place);
          log(`${place.id}: restored at tick ${world.tick}`);
          return { place, world, replay: await loadReplay(place, world, true), chronicle: await loadChronicle(place, world, baseDay, true), baseDay, ready: false, restored: true, weather: null, weatherUpdatedAt: null, ai: false, frame: null };
        } catch (err) {
          log(`${place.id}: cannot restore ${file} (${(err as Error)?.message ?? err}) — starting fresh, old file kept as .bak`);
          await rename(file, `${file}.bak`).catch(() => {});
        }
      }
    }
    const world = createWorld(place.seed, { agentCount: place.residents, mapId: place.mapId });
    const baseDay = baseDayFor(localNow());
    return { place, world, replay: await loadReplay(place, world, false), chronicle: await loadChronicle(place, world, baseDay, false), baseDay, ready: false, restored: false, weather: null, weatherUpdatedAt: null, ai: false, frame: null };
  }

  /** steps `lw` up to the clock (re-anchoring when far off); yields between chunks */
  async function catchUp(lw: LiveWorld): Promise<number> {
    const now = localNow();
    const anchored = reanchorBaseDay(lw.world.tick, now, lw.baseDay, MAX_CATCH_UP_TICKS);
    if (anchored !== lw.baseDay) {
      log(`${lw.place.id}: clock re-anchored by ${anchored - lw.baseDay} day(s)`);
      lw.baseDay = anchored;
    }
    let stepped = 0;
    for (;;) {
      const behind = targetTick(localNow(), lw.baseDay) - lw.world.tick;
      if (behind <= 0 || stopped) break;
      const n = Math.min(behind, CATCH_UP_CHUNK);
      const date = dateOf(lw);
      for (let i = 0; i < n; i++) {
        tickWorld(lw.world);
        collectEvents(lw.chronicle, lw.world.events, lw.world.tick, date);
        lw.replay.record(lw.world, lw.weather?.current?.temperature ?? null);
      }
      stepped += n;
      if (behind > n) await sleep0();
    }
    return stepped;
  }

  function publish(lw: LiveWorld): void {
    lw.frame = makeFrame(lw, realNow(), !!opts.news);
    for (const fn of listeners.get(lw.place.id) ?? []) {
      try {
        fn(lw.frame);
      } catch (err) {
        log(`${lw.place.id}: frame listener failed (${(err as Error)?.message ?? err})`);
      }
    }
  }

  async function start(): Promise<void> {
    if (dataDir) await mkdir(dataDir, { recursive: true });
    const loaded = await Promise.all(places.map((p) => load(p)));
    for (const lw of loaded) worlds.set(lw.place.id, lw);
    // first readings before the fast-forward, so the hours replayed get real weather and headlines
    const first = Promise.all([refreshNews(), ...loaded.map((lw) => refreshWeather(lw))]);
    await Promise.race([first, new Promise((r) => timers.push(setTimeout(r, inputTimeout)))]);
    for (const lw of loaded) {
      if (stopped) return;
      attachHooks(lw);
      const t0 = Date.now();
      const n = await catchUp(lw);
      attachAi(lw);
      lw.ready = true;
      publish(lw);
      maybeSummarize(lw);
      log(`${lw.place.id}: ${lw.restored ? 'restored' : 'new'} world at tick ${lw.world.tick} (+${n} ticks in ${Date.now() - t0} ms)`);
    }
    if (stopped) return;
    if (opts.weather) timers.push(setInterval(() => void Promise.all([...worlds.values()].map(refreshWeather)), WEATHER_REFRESH_MS));
    if (opts.news) timers.push(setInterval(() => void refreshNews(), NEWS_REFRESH_MS));
    if (dataDir) timers.push(setInterval(() => void host.saveAll(), opts.saveEveryMs ?? SAVE_EVERY_MS));
    for (const t of timers) (t as { unref?: () => void }).unref?.();
    scheduleMinute();
  }

  function scheduleMinute(): void {
    if (stopped || fixed) return;
    const v = virtualMs();
    const toBoundary = 60_000 - (((v % 60_000) + 60_000) % 60_000);
    const delay = toBoundary / speed + TIMER_SLACK_MS;
    minuteTimer = setTimeout(() => {
      void host.sync().finally(scheduleMinute);
    }, delay);
    (minuteTimer as { unref?: () => void }).unref?.();
  }

  async function saveOne(lw: LiveWorld): Promise<void> {
    if (!dataDir || !lw.ready) return;
    // the recording first: after a crash it is never behind the snapshot (a restore rewinds it if ahead)
    const rfile = replayPath(dataDir, lw.place.id);
    await writeFile(`${rfile}.tmp`, encodeReplay(lw.replay, realNow()));
    await rename(`${rfile}.tmp`, rfile);
    const file = snapshotPath(dataDir, lw.place.id);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, encodeSave(lw, realNow()));
    await rename(tmp, file);
    // after the snapshot: a crash in between leaves the chronicle behind (re-collected from the world's events), never ahead
    const cfile = chroniclePath(dataDir, lw.place.id);
    await writeFile(`${cfile}.tmp`, encodeChronicle(lw.place.id, lw.chronicle));
    await rename(`${cfile}.tmp`, cfile);
  }

  const host: LiveHost = {
    ready: Promise.resolve(),
    places,
    aiGate,
    get: (id) => worlds.get(id as PlaceId),
    localNow,
    summaries() {
      return places.map((p) => {
        const lw = worlds.get(p.id);
        const w = lw?.world;
        return {
          id: p.id,
          name: p.name,
          city: p.city,
          tick: w?.tick ?? 0,
          residents: w?.agents.length ?? p.residents,
          awake: w ? w.agents.filter((a) => !isAgentSleeping(w, a)).length : 0,
          highlight: w && lw.ready ? placeHighlight(w) : null,
          temperature: lw?.weather?.current?.temperature ?? null,
          weatherIcon: w ? weatherOf(w).icon : '⛅',
        };
      });
    },
    chronicle(id) {
      const lw = worlds.get(id as PlaceId);
      return lw?.ready ? chronicleData(lw) : undefined;
    },
    replay(id) {
      const lw = worlds.get(id as PlaceId);
      return lw?.ready ? replayData(lw) : undefined;
    },
    onFrame(id, fn) {
      let set = listeners.get(id);
      if (!set) listeners.set(id, (set = new Set()));
      set.add(fn);
      return () => set.delete(fn);
    },
    addViewer(id) {
      viewerCounts.set(id, (viewerCounts.get(id) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        viewerCounts.set(id, Math.max(0, (viewerCounts.get(id) ?? 1) - 1));
      };
    },
    viewers: (id) => viewerCounts.get(id) ?? 0,
    sync() {
      // one pass at a time; a call during a pass waits for it and then runs its own
      const run = async (): Promise<void> => {
        for (const lw of worlds.values()) {
          if (!lw.ready || stopped) continue;
          const n = await catchUp(lw);
          if (n > 0) publish(lw);
          maybeSummarize(lw);
        }
      };
      const prev = syncing ?? Promise.resolve();
      const next = prev.then(run, run).finally(() => {
        if (syncing === next) syncing = null;
      });
      syncing = next;
      return next;
    },
    async saveAll() {
      for (const lw of worlds.values()) {
        try {
          await saveOne(lw);
        } catch (err) {
          log(`${lw.place.id}: save failed (${(err as Error)?.message ?? err})`);
        }
      }
    },
    saveAllSync() {
      if (!dataDir) return;
      try {
        mkdirSync(dataDir, { recursive: true });
      } catch {
        /* reported by the write */
      }
      for (const lw of worlds.values()) {
        if (!lw.ready) continue;
        try {
          const rfile = replayPath(dataDir, lw.place.id);
          writeFileSync(`${rfile}.tmp`, encodeReplay(lw.replay, realNow()));
          renameSync(`${rfile}.tmp`, rfile);
          const file = snapshotPath(dataDir, lw.place.id);
          writeFileSync(`${file}.tmp`, encodeSave(lw, realNow()));
          renameSync(`${file}.tmp`, file);
          const cfile = chroniclePath(dataDir, lw.place.id);
          writeFileSync(`${cfile}.tmp`, encodeChronicle(lw.place.id, lw.chronicle));
          renameSync(`${cfile}.tmp`, cfile);
        } catch (err) {
          log(`${lw.place.id}: save failed (${(err as Error)?.message ?? err})`);
        }
      }
    },
    stop() {
      stopped = true;
      if (minuteTimer) clearTimeout(minuteTimer);
      for (const t of timers) clearTimeout(t as ReturnType<typeof setTimeout>);
      for (const t of timers) clearInterval(t as ReturnType<typeof setInterval>);
      for (const lw of worlds.values()) {
        setDiaryAiEnabled(lw.world, false);
      }
    },
  };
  (host as { ready: Promise<void> }).ready = start().catch((err: unknown) => {
    log(`start failed: ${(err as Error)?.stack ?? err}`);
    throw err;
  });
  return host;
}

// ---------------------------------------------------------------- wiring helpers

/** real weather for a place, Warsaw-time hourly keys */
export const openMeteoWeather: WeatherFetcher = (place) => fetchRealWeather(place.lat, place.lon, 8000, LIVE_TIME_ZONE);

/** reads a saved world without starting anything (tools / tests) */
export function readSavedWorld(dataDir: string, place: PlaceDef): { world: World; baseDay: number } {
  return decodeSave(readFileSync(snapshotPath(dataDir, place.id), 'utf8'), place);
}
