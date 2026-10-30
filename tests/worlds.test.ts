import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, inflateRawSync, constants as zc } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { snapshotWorld, DISK_SNAPSHOT, NETWORK_SNAPSHOT } from '../src/core/state';
import { createProceduralProvider } from '../src/social/dialogueProvider';
import { createWorld } from '../src/world/world';
import { findGenderedForms } from '../src/social/diaryAi';
import {
  MAX_CATCH_UP_TICKS,
  baseDayFor,
  localTimeIn,
  localTimeOf,
  parseLocalTime,
  reanchorBaseDay,
  targetTick,
  type LocalTime,
} from '../src/realtime/clock';
import { PLACES, type LiveFrame, type PlaceSummary } from '../src/live/protocol';
import { createLiveHost, liveConfigFromEnv, placeHighlight, snapshotPath, type LiveHost } from '../server/worlds';
import { createLiveHandler } from '../server/worldsHttp';
import { AI_IDLE_SHARE, aiAllowed, createAiGate, createGatedDialogue, inProcessFetch } from '../server/worldsAi';
import { startLiveWorlds } from '../server/worldsSetup';
import { createDailyBudget, createLlmHandler } from '../server/llm';
import { chroniclePath } from '../server/chronicle';
import type { ChronicleResponse } from '../src/social/chronicle';
import type { ConversationContext } from '../src/types';

const WARSAW = 'Europe/Warsaw';
const lt = (s: string): LocalTime => parseLocalTime(s)!;
const quiet = (): void => {};
const hosts: LiveHost[] = [];
const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'live-worlds-'));
  dirs.push(d);
  return d;
}

function host(opts: Parameters<typeof createLiveHost>[0]): LiveHost {
  const h = createLiveHost({ log: quiet, ...opts });
  hosts.push(h);
  return h;
}

afterEach(() => {
  for (const h of hosts.splice(0)) h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('Warsaw clock', () => {
  it('reads Warsaw wall time in winter and summer', () => {
    // 2026-01-15 11:30 UTC = 12:30 CET; 2026-07-15 11:30 UTC = 13:30 CEST
    expect(localTimeIn(new Date(Date.UTC(2026, 0, 15, 11, 30)), WARSAW)).toEqual(lt('2026-01-15T12:30'));
    expect(localTimeIn(new Date(Date.UTC(2026, 6, 15, 11, 30)), WARSAW)).toEqual(lt('2026-07-15T13:30'));
    // across midnight: 23:30 UTC on Oct 31 = 00:30 Nov 1 in Warsaw
    expect(localTimeIn(new Date(Date.UTC(2026, 9, 31, 23, 30)), WARSAW)).toEqual(lt('2026-11-01T00:30'));
  });

  it('follows DST changes (spring forward = +60 ticks, fall back = waits an hour)', () => {
    // 2026-03-29: 01:59 UTC = 02:59 CET → 01:00 UTC = 03:00 CEST
    const before = localTimeIn(new Date(Date.UTC(2026, 2, 29, 0, 59)), WARSAW);
    const after = localTimeIn(new Date(Date.UTC(2026, 2, 29, 1, 0)), WARSAW);
    expect(before.minute).toBe(1 * 60 + 59);
    expect(after.minute).toBe(3 * 60);
    const base = before.dayNumber - 3;
    expect(targetTick(after, base) - targetTick(before, base)).toBe(61);
    // 2026-10-25: 00:59 UTC = 02:59 CEST → 01:00 UTC = 02:00 CET (target goes back 59: the sim waits)
    const b2 = localTimeIn(new Date(Date.UTC(2026, 9, 25, 0, 59)), WARSAW);
    const a2 = localTimeIn(new Date(Date.UTC(2026, 9, 25, 1, 0)), WARSAW);
    expect(b2.minute).toBe(2 * 60 + 59);
    expect(a2.minute).toBe(2 * 60);
  });

  it('does not depend on the process time zone (UTC container)', () => {
    const old = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const d = new Date(Date.UTC(2026, 9, 29, 6, 5));
      expect(localTimeOf(d).minute).toBe(6 * 60 + 5); // the container's own clock: UTC
      expect(localTimeIn(d, WARSAW)).toEqual(lt('2026-10-29T07:05'));
      process.env.TZ = 'America/New_York';
      expect(localTimeIn(d, WARSAW)).toEqual(lt('2026-10-29T07:05'));
    } finally {
      if (old === undefined) delete process.env.TZ;
      else process.env.TZ = old;
    }
  });

  it('parses fixed times', () => {
    expect(parseLocalTime('2026-10-29 12:00')).toEqual(lt('2026-10-29T12:00'));
    expect(parseLocalTime('2026-10-29T25:00')).toBeNull();
    expect(parseLocalTime('jutro')).toBeNull();
  });

  it('re-anchors after a long downtime by whole days, keeping the minute of the day', () => {
    const base = lt('2026-10-01T07:00').dayNumber;
    const tick = 500;
    const now = lt('2026-10-29T15:17');
    const b = reanchorBaseDay(tick, now, base);
    expect(b).toBeGreaterThan(base);
    const behind = targetTick(now, b) - tick;
    expect(behind).toBeGreaterThan(0);
    expect(behind).toBeLessThanOrEqual(MAX_CATCH_UP_TICKS);
    // ahead (e.g. after LIVE_SPEED): moved back so the world is < 1 day behind
    const ahead = reanchorBaseDay(10_000, lt('2026-10-02T08:00'), base);
    const d = targetTick(lt('2026-10-02T08:00'), ahead) - 10_000;
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThan(1440);
    // in sync / DST hour: unchanged
    expect(reanchorBaseDay(100, lt('2026-10-01T08:00'), base)).toBe(base);
    expect(reanchorBaseDay(100, lt('2026-10-01T07:40'), base)).toBe(base);
  });
});

describe('env config', () => {
  it('has sane defaults and toggles', () => {
    const d = liveConfigFromEnv({});
    expect(d).toMatchObject({ enabled: true, dataDir: './data', speed: 1, fixedTime: null, ai: true, news: true, weather: true });
    expect(liveConfigFromEnv({}, false).ai).toBe(false);
    expect(liveConfigFromEnv({ LIVE_AI: 'on' }, false).ai).toBe(true);
    const c = liveConfigFromEnv({ LIVE_WORLDS: 'off', LIVE_AI: 'off', NEWS_FEEDS: 'off', LIVE_WEATHER: 'off', LIVE_SPEED: '60', DATA_DIR: '/app/data' });
    expect(c).toMatchObject({ enabled: false, ai: false, news: false, weather: false, speed: 60, dataDir: '/app/data' });
    // a fixed clock implies no persistence unless DATA_DIR is given
    expect(liveConfigFromEnv({ LIVE_FIXED_TIME: '2026-10-29T12:00' })).toMatchObject({ dataDir: null, fixedTime: lt('2026-10-29T12:00') });
    expect(liveConfigFromEnv({ DATA_DIR: 'off' }).dataDir).toBeNull();
    expect(liveConfigFromEnv({ LIVE_SPEED: 'abc' }).speed).toBe(1);
    expect(() => liveConfigFromEnv({ LIVE_FIXED_TIME: 'noon' })).toThrow(/LIVE_FIXED_TIME/);
  });

  it('LIVE_WORLDS=off starts nothing; no key = no AI', async () => {
    expect(startLiveWorlds(liveConfigFromEnv({ LIVE_WORLDS: 'off' }), { log: quiet })).toBeNull();
    const rt = startLiveWorlds(liveConfigFromEnv({ LIVE_FIXED_TIME: '2026-10-29T07:10', LIVE_WEATHER: 'off' }), {
      log: quiet,
      llm: { handler: createLlmHandler({ apiKey: undefined, log: quiet }), daily: createDailyBudget(10), apiKey: undefined },
    })!;
    await rt.host.ready;
    expect(rt.host.get('dom')!.ai).toBe(false);
    expect(rt.host.get('dom')!.frame!.json).toContain('"ai":false');
    rt.shutdown();
  });
});

describe('live host', () => {
  it('creates the four worlds at the current Warsaw time', async () => {
    const h = host({ fixedTime: lt('2026-10-29T09:30') });
    await h.ready;
    for (const p of PLACES) {
      const lw = h.get(p.id)!;
      expect(lw.ready).toBe(true);
      expect(lw.world.tick).toBe(150); // 07:00 → 09:30
      expect(lw.world.seed).toBe(p.seed);
      expect(lw.world.agents.length).toBe(p.residents);
      const f = JSON.parse(lw.frame!.json) as LiveFrame;
      expect(f.meta).toMatchObject({ place: p.id, tick: 150, ai: false, news: false });
      expect(f.meta.weather).toMatchObject({ city: p.city, source: 'plan', temperature: null });
      expect(f.snapshot.tick).toBe(150);
    }
    // before 07:00 the world starts yesterday 07:00 ("Dzień 2" early hours)
    const early = host({ fixedTime: lt('2026-10-29T03:00'), places: [PLACES[2]] });
    await early.ready;
    expect(early.get('jezioro')!.world.tick).toBe(20 * 60);
  });

  it('ticks once per wall-clock minute on the boundary and catches up after a stall', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 29, 8, 0, 10) }); // 09:00:10 in Warsaw (CET)
    const h = host({ places: [PLACES[0]] });
    await vi.advanceTimersByTimeAsync(0);
    await h.ready;
    const lw = h.get('dom')!;
    expect(lw.world.tick).toBe(120);
    const ticks: number[] = [];
    h.onFrame('dom', (f) => ticks.push(f.tick));
    await vi.advanceTimersByTimeAsync(49_000); // 09:00:59
    expect(lw.world.tick).toBe(120);
    await vi.advanceTimersByTimeAsync(1_100); // just past 09:01:00
    expect(lw.world.tick).toBe(121);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(lw.world.tick).toBe(126);
    expect(ticks).toEqual([121, 122, 123, 124, 125, 126]);
    // event loop stalled / laptop suspended for 10 minutes: the next timer catches up in one go
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lw.world.tick).toBe(126 + 11);
    expect(ticks.at(-1)).toBe(137);
  });

  it('LIVE_SPEED runs game minutes faster', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 29, 8, 0, 0) });
    const h = host({ places: [PLACES[2]], speed: 60 });
    await vi.advanceTimersByTimeAsync(0);
    await h.ready;
    const t0 = h.get('jezioro')!.world.tick;
    await vi.advanceTimersByTimeAsync(10_050);
    expect(h.get('jezioro')!.world.tick - t0).toBe(10);
  });

  it('summarises places in Polish', async () => {
    const h = host({ fixedTime: lt('2026-10-29T19:30') });
    await h.ready;
    const s: PlaceSummary[] = h.summaries();
    expect(s.map((x) => x.id)).toEqual(PLACES.map((p) => p.id));
    for (const x of s) {
      expect(x.tick).toBe(750);
      expect(x.awake).toBeLessThanOrEqual(x.residents);
      expect(typeof x.weatherIcon).toBe('string');
      if (x.highlight !== null) {
        expect(x.highlight.length).toBeGreaterThan(3);
        // no past-tense / gendered forms like "grał", "grała", "poszedł"
        expect(findGenderedForms(x.highlight), x.highlight).toEqual([]);
      }
    }
    expect(s.some((x) => x.highlight)).toBe(true);
    expect(placeHighlight(createWorld(1, { agentCount: 0 }))).toBeNull();
  });
});

describe('persistence', () => {
  it('round trip: saved world is restored at the same tick and continues deterministically', async () => {
    const dir = tmp();
    let now = Date.UTC(2026, 9, 29, 9, 0); // 10:00 Warsaw
    const a = host({ dataDir: dir, now: () => now, places: [PLACES[0], PLACES[2]] });
    await a.ready;
    await a.saveAll();
    expect(existsSync(snapshotPath(dir, 'dom'))).toBe(true);
    expect(existsSync(`${snapshotPath(dir, 'dom')}.tmp`)).toBe(false);
    const b = host({ dataDir: dir, now: () => now, places: [PLACES[0], PLACES[2]] });
    await b.ready;
    for (const id of ['dom', 'jezioro'] as const) {
      expect(b.get(id)!.restored).toBe(true);
      expect(b.get(id)!.world.tick).toBe(180);
      expect(b.get(id)!.baseDay).toBe(a.get(id)!.baseDay);
      expect(snapshotWorld(b.get(id)!.world, DISK_SNAPSHOT)).toEqual(snapshotWorld(a.get(id)!.world, DISK_SNAPSHOT));
    }
    now += 95 * 60_000;
    await Promise.all([a.sync(), b.sync()]);
    for (const id of ['dom', 'jezioro'] as const) {
      expect(b.get(id)!.world.tick).toBe(275);
      expect(snapshotWorld(b.get(id)!.world, NETWORK_SNAPSHOT)).toEqual(snapshotWorld(a.get(id)!.world, NETWORK_SNAPSHOT));
    }
  });

  it('after a long downtime catches up at most 3 days and re-anchors', async () => {
    const dir = tmp();
    let now = Date.UTC(2026, 9, 20, 9, 0);
    const a = host({ dataDir: dir, now: () => now, places: [PLACES[2]] });
    await a.ready;
    a.saveAllSync();
    const saved = a.get('jezioro')!.world.tick;
    now = Date.UTC(2026, 9, 29, 14, 17); // 9 days later, 15:17 Warsaw
    const b = host({ dataDir: dir, now: () => now, places: [PLACES[2]] });
    await b.ready;
    const lw = b.get('jezioro')!;
    expect(lw.world.tick - saved).toBeGreaterThan(0);
    expect(lw.world.tick - saved).toBeLessThanOrEqual(MAX_CATCH_UP_TICKS);
    expect(targetTick(localTimeIn(new Date(now), WARSAW), lw.baseDay)).toBe(lw.world.tick);
    expect(lw.world.tick % 1440).toBe((15 * 60 + 17 - 7 * 60 + 1440) % 1440);
  });

  it('corrupt or incompatible saves start fresh and are kept as .bak', async () => {
    const dir = tmp();
    writeFileSync(snapshotPath(dir, 'dom'), '{"format":1,"place":"dom"');
    writeFileSync(snapshotPath(dir, 'jezioro'), JSON.stringify({ format: 1, place: 'jezioro', baseDay: 1, savedAt: 0, snapshot: { version: 999, seed: 1410, mapId: 'jezioro', modules: {} } }));
    const logs: string[] = [];
    const h = createLiveHost({ dataDir: dir, fixedTime: lt('2026-10-29T08:00'), places: [PLACES[0], PLACES[2]], log: (m) => logs.push(m) });
    hosts.push(h);
    await h.ready;
    expect(h.get('dom')!.restored).toBe(false);
    expect(h.get('jezioro')!.restored).toBe(false);
    expect(h.get('dom')!.world.tick).toBe(60);
    expect(readFileSync(`${snapshotPath(dir, 'dom')}.bak`, 'utf8')).toBe('{"format":1,"place":"dom"');
    expect(existsSync(`${snapshotPath(dir, 'jezioro')}.bak`)).toBe(true);
    expect(logs.some((l) => /jezioro: cannot restore.*version 999/.test(l))).toBe(true);
    // a fresh save replaces the broken file
    await h.saveAll();
    expect(JSON.parse(readFileSync(snapshotPath(dir, 'dom'), 'utf8')).snapshot.tick).toBe(60);
  });
});

// ---------------------------------------------------------------- HTTP

class FakeRes extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  writableEnded = false;
  writableLength = 0;
  headersSent = false;
  statusCode = 200;
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.status = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }
  setHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  write(c: Buffer | string) {
    this.chunks.push(Buffer.from(c));
    return true;
  }
  end(c?: Buffer | string) {
    if (c) this.chunks.push(Buffer.from(c));
    if (!this.status) this.status = this.statusCode;
    this.writableEnded = true;
    return this;
  }
  body(): Buffer {
    return Buffer.concat(this.chunks);
  }
  /** SSE text, decoding the open-ended gzip stream when needed */
  text(): string {
    const b = this.body();
    if (this.headers['Content-Encoding'] !== 'gzip') return b.toString();
    expect([...b.subarray(0, 3)]).toEqual([0x1f, 0x8b, 0x08]);
    return inflateRawSync(b.subarray(10), { finishFlush: zc.Z_SYNC_FLUSH }).toString();
  }
}

function fakeReq(url: string, headers: Record<string, string> = {}, ip = '10.0.0.1'): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  Object.assign(req, { url, method: 'GET', headers, socket: { remoteAddress: ip, setNoDelay() {} } });
  return req;
}

function call(handler: ReturnType<typeof createLiveHandler>, req: IncomingMessage): FakeRes {
  const res = new FakeRes();
  handler(req, res as unknown as ServerResponse, () => res.writeHead(418).end());
  return res;
}

function frames(sse: string): LiveFrame[] {
  return sse
    .split('\n\n')
    .filter((m) => m.startsWith('event: frame\n'))
    .map((m) => JSON.parse(m.slice(m.indexOf('data: ') + 6)) as LiveFrame);
}

describe('HTTP endpoints', () => {
  it('serves places, snapshots (plain + gzip) and 404s', async () => {
    const h = host({ fixedTime: lt('2026-10-29T12:00') });
    await h.ready;
    const handler = createLiveHandler(h);
    const places = call(handler, fakeReq('/api/live/places'));
    expect(places.status).toBe(200);
    expect((JSON.parse(places.body().toString()) as PlaceSummary[]).length).toBe(4);
    const snap = call(handler, fakeReq('/api/live/kamienica/snapshot'));
    expect(snap.status).toBe(200);
    const f = JSON.parse(snap.body().toString()) as LiveFrame;
    expect(f.meta.place).toBe('kamienica');
    expect(f.snapshot.tick).toBe(300);
    const gz = call(handler, fakeReq('/api/live/kamienica/snapshot', { 'accept-encoding': 'gzip, br' }));
    expect(gz.headers['Content-Encoding']).toBe('gzip');
    expect(gunzipSync(gz.body()).toString()).toBe(snap.body().toString());
    expect(gz.body().length).toBeLessThan(snap.body().length / 3);
    const etag = snap.headers.ETag;
    expect(call(handler, fakeReq('/api/live/kamienica/snapshot', { 'if-none-match': etag })).status).toBe(304);
    expect(call(handler, fakeReq('/api/live/mars/snapshot')).status).toBe(404);
    expect(call(handler, fakeReq('/api/live/dom/other')).status).toBe(404);
    expect(call(handler, fakeReq('/api/live/dom/stream/x')).status).toBe(404);
    expect(call(handler, fakeReq('/api/news')).status).toBe(418); // not ours: next()
    handler.close();
  });

  it('streams the initial frame and every tick to many clients, plain and gzip', async () => {
    let now = Date.UTC(2026, 9, 29, 10, 0);
    const h = host({ now: () => now, places: [PLACES[0], PLACES[1]] });
    await h.ready;
    const handler = createLiveHandler(h, { pingMs: 50 });
    const reqs = [fakeReq('/api/live/dom/stream'), fakeReq('/api/live/dom/stream', { 'accept-encoding': 'gzip' }, '10.0.0.2'), fakeReq('/api/live/kamienica/stream')];
    const [plain, gz, other] = reqs.map((r) => call(handler, r));
    expect(plain.headers['Content-Type']).toMatch(/text\/event-stream/);
    expect(plain.headers['Cache-Control']).toMatch(/no-cache/);
    expect(plain.headers['X-Accel-Buffering']).toBe('no');
    expect(gz.headers['Content-Encoding']).toBe('gzip');
    expect(frames(plain.text()).map((f) => f.meta.tick)).toEqual([240]);
    expect(frames(gz.text()).map((f) => f.meta.tick)).toEqual([240]);
    expect(h.viewers('dom')).toBe(2);

    now += 60_000;
    await h.sync();
    now += 60_000;
    await h.sync();
    expect(frames(plain.text()).map((f) => f.meta.tick)).toEqual([240, 241, 242]);
    expect(frames(gz.text()).map((f) => f.meta.tick)).toEqual([240, 241, 242]);
    expect(frames(other.text()).map((f) => f.meta.place)).toEqual(['kamienica', 'kamienica', 'kamienica']);
    // the very same serialized frame for everyone
    expect(frames(plain.text())[2]).toEqual(frames(gz.text())[2]);

    await new Promise((r) => setTimeout(r, 120));
    expect(plain.text()).toContain('event: ping');
    expect(gz.text()).toContain('event: ping');

    (reqs[0] as unknown as EventEmitter).emit('close');
    expect(plain.writableEnded).toBe(true);
    expect(h.viewers('dom')).toBe(1);
    expect(handler.streams()).toBe(2);
    handler.close();
    expect(handler.streams()).toBe(0);
    expect(h.viewers('dom')).toBe(0);
  });

  it('limits streams per IP and in total', async () => {
    const h = host({ fixedTime: lt('2026-10-29T12:00'), places: [PLACES[0]] });
    await h.ready;
    const handler = createLiveHandler(h, { maxStreams: 3, maxStreamsPerIp: 2 });
    expect(call(handler, fakeReq('/api/live/dom/stream')).status).toBe(200);
    expect(call(handler, fakeReq('/api/live/dom/stream')).status).toBe(200);
    expect(call(handler, fakeReq('/api/live/dom/stream')).status).toBe(429);
    // behind the reverse proxy the client is the last X-Forwarded-For hop
    expect(call(handler, fakeReq('/api/live/dom/stream', { 'x-forwarded-for': '1.2.3.4' })).status).toBe(200);
    expect(call(handler, fakeReq('/api/live/dom/stream', {}, '10.9.9.9')).status).toBe(503);
    handler.close();
  });
});

// ---------------------------------------------------------------- AI budget

describe('AI budget split', () => {
  it('gives each world a share, idle worlds half of it, watched worlds the pool', () => {
    const base = { limit: 100, worlds: 4 };
    expect(aiAllowed({ ...base, usedTotal: 0, usedByWorld: 0, watched: false })).toBe(true);
    expect(aiAllowed({ ...base, usedTotal: 30, usedByWorld: 25 * AI_IDLE_SHARE, watched: false })).toBe(false);
    expect(aiAllowed({ ...base, usedTotal: 30, usedByWorld: 24, watched: true })).toBe(true);
    // watched beyond its share: allowed while > 10% of the limit is left
    expect(aiAllowed({ ...base, usedTotal: 80, usedByWorld: 40, watched: true })).toBe(true);
    expect(aiAllowed({ ...base, usedTotal: 90, usedByWorld: 40, watched: true })).toBe(false);
    expect(aiAllowed({ ...base, usedTotal: 100, usedByWorld: 0, watched: true })).toBe(false);
    expect(aiAllowed({ ...base, limit: 0, usedTotal: 0, usedByWorld: 0, watched: true })).toBe(false);
  });

  it('gate counts per world and day; a refused dialogue line falls back to procedural synchronously', () => {
    let now = Date.UTC(2026, 9, 29, 12);
    const daily = createDailyBudget(8, () => now);
    const watched = new Set<string>();
    const gate = createAiGate({ budget: daily, worlds: 4, watched: (p) => watched.has(p), now: () => now });
    expect(gate.tryAcquire('dom')).toBe(true); // share 2, idle → 1
    expect(gate.tryAcquire('dom')).toBe(false);
    watched.add('dom');
    expect(gate.tryAcquire('dom')).toBe(true);
    expect(gate.usedBy('dom')).toBe(2);
    gate.refund('dom');
    expect(gate.usedBy('dom')).toBe(1);
    now += 86_400_000;
    expect(gate.usedBy('dom')).toBe(0);

    const fetchSpy = vi.fn();
    const denyAll = { tryAcquire: () => false, refund() {}, usedBy: () => 0 };
    const world = createWorld(5, { agentCount: 2 });
    const provider = createGatedDialogue('dom', denyAll, fetchSpy as unknown as typeof fetch, createProceduralProvider());
    const ctx = { speaker: world.agents[0], listener: world.agents[1], topic: 'pogoda', history: [], relationship: 0, time: { day: 1, hour: 12, minute: 0, phase: 'day' } } as unknown as ConversationContext;
    const line = provider.nextLine(ctx, world.rng);
    expect(line instanceof Promise).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('inProcessFetch reaches the /api/llm handler without the network', async () => {
    const f = inProcessFetch(createLlmHandler({ apiKey: undefined, log: quiet }));
    const status = await f('http://live.internal/api/llm/status');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ available: false });
    const line = await f('http://live.internal/api/llm/line', { method: 'POST', body: '{}' });
    expect(line.status).toBe(503);
    const echo = inProcessFetch((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        res.statusCode = 201;
        res.end(JSON.stringify({ method: req.method, url: req.url, body }));
      });
    });
    const r = await echo('http://x/api/llm/diary?a=1', { method: 'POST', body: '{"x":1}' });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ method: 'POST', url: '/api/llm/diary?a=1', body: '{"x":1}' });
  });
});

it('fresh worlds use the clock anchor of the day they start', () => {
  expect(baseDayFor(lt('2026-10-29T06:59'))).toBe(lt('2026-10-28T00:00').dayNumber);
});

describe('chronicle', () => {
  const DAY = 86_400_000;
  const dom = [PLACES[0]];

  async function twoDays(dir: string, extra: Partial<Parameters<typeof createLiveHost>[0]> = {}) {
    let now = Date.UTC(2026, 9, 29, 9, 0);
    const h = host({ dataDir: dir, now: () => now, places: dom, ...extra });
    await h.ready;
    now += 2 * DAY;
    await h.sync();
    return { h, now: () => now };
  }

  it('collects the important events of past days and survives a restart', async () => {
    const dir = tmp();
    const { h, now } = await twoDays(dir);
    const view = JSON.parse(h.chronicle('dom')!.json) as ChronicleResponse;
    expect(view.place).toBe('dom');
    expect(view.days.length).toBeGreaterThanOrEqual(2);
    expect(view.days[0].date > view.days[1].date).toBe(true);
    expect(view.days.every((d) => d.items.length > 0 && d.summary.length > 0)).toBe(true);
    await h.saveAll();
    expect(existsSync(chroniclePath(dir, 'dom'))).toBe(true);
    expect(existsSync(`${chroniclePath(dir, 'dom')}.tmp`)).toBe(false);
    const b = host({ dataDir: dir, now, places: dom });
    await b.ready;
    expect(b.get('dom')!.restored).toBe(true);
    expect(b.get('dom')!.chronicle.days).toEqual(h.get('dom')!.chronicle.days);
    expect(JSON.parse(b.chronicle('dom')!.json)).toEqual(view);
  });

  it('catches up what a crash left out of the file and drops what the restored world has not seen yet', async () => {
    const dir = tmp();
    const { h, now } = await twoDays(dir);
    await h.saveAll();
    const full = JSON.parse(readFileSync(chroniclePath(dir, 'dom'), 'utf8'));
    const items = (store: { days: { items: { tick: number }[] }[] }) => store.days.flatMap((d) => d.items).length;
    const world = h.get('dom')!.world;
    // chronicle behind the snapshot: the events still in world.events come back
    const behind = { ...full, lastTick: world.tick - 100, days: full.days.map((d: { items: { tick: number }[] }) => ({ ...d, items: d.items.filter((i) => i.tick <= world.tick - 100) })) };
    writeFileSync(chroniclePath(dir, 'dom'), JSON.stringify(behind));
    const b = host({ dataDir: dir, now, places: dom });
    await b.ready;
    expect(items(b.get('dom')!.chronicle)).toBe(items(full));
    // chronicle ahead of the snapshot: later items are replayed by the world, not kept twice
    const ahead = { ...full, lastTick: world.tick + 500, days: [...full.days, { date: '2099-01-01', items: [{ tick: world.tick + 400, kind: 'moment', icon: '✨', text: 'Z przyszłości', agentIds: [], weight: 1 }] }] };
    writeFileSync(chroniclePath(dir, 'dom'), JSON.stringify(ahead));
    const c = host({ dataDir: dir, now, places: dom });
    await c.ready;
    expect(c.get('dom')!.chronicle.days.some((d) => d.date === '2099-01-01')).toBe(false);
    expect(items(c.get('dom')!.chronicle)).toBe(items(full));
  });

  it('keeps an unusable chronicle file as .bak and starts a new one', async () => {
    const dir = tmp();
    writeFileSync(chroniclePath(dir, 'dom'), '{"format":1,"place":"dom"');
    const logs: string[] = [];
    const h = host({ dataDir: dir, fixedTime: lt('2026-10-29T08:00'), places: dom, log: (m) => logs.push(m) });
    await h.ready;
    expect(readFileSync(`${chroniclePath(dir, 'dom')}.bak`, 'utf8')).toBe('{"format":1,"place":"dom"');
    expect(logs.some((l) => /dom: cannot read .*chronicle/.test(l))).toBe(true);
    expect(h.chronicle('dom')).toBeDefined();
    await h.saveAll();
    expect(JSON.parse(readFileSync(chroniclePath(dir, 'dom'), 'utf8')).format).toBe(1);
  });

  it('serves GET /api/live/:place/chronicle (plain, gzip, 304, HEAD, 404, 503 while starting)', async () => {
    const dir = tmp();
    const { h } = await twoDays(dir);
    const handler = createLiveHandler(h);
    const r = call(handler, fakeReq('/api/live/dom/chronicle'));
    expect(r.status).toBe(200);
    expect(r.headers['Cache-Control']).toBe('no-cache');
    expect((JSON.parse(r.body().toString()) as ChronicleResponse).days.length).toBeGreaterThan(0);
    const gz = call(handler, fakeReq('/api/live/dom/chronicle', { 'accept-encoding': 'gzip' }));
    expect(gz.headers['Content-Encoding']).toBe('gzip');
    expect(gunzipSync(gz.body()).toString()).toBe(r.body().toString());
    expect(call(handler, fakeReq('/api/live/dom/chronicle', { 'if-none-match': r.headers.ETag })).status).toBe(304);
    const head = call(handler, Object.assign(fakeReq('/api/live/dom/chronicle'), { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.body().length).toBe(0);
    expect(call(handler, fakeReq('/api/live/mars/chronicle')).status).toBe(404);
    handler.close();
  });

  it('writes one AI summary per finished day through the budget, falling back to the procedural text on refusal', async () => {
    const calls: string[] = [];
    const answer = 'Spokojny dzień na osiedlu: rano wspólne śniadanie, w południe jedna drobna naprawa. Wieczorem wszyscy odpoczywają przed telewizorem i cieszą się ciszą.';
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/api/llm/chronicle')) return new Response(JSON.stringify({ text: answer, model: 'm/x:free' }), { status: 200 });
      return new Response('{}', { status: 503 });
    }) as typeof fetch;
    const dir = tmp();
    const { h } = await twoDays(dir, { ai: { fetch: fetchImpl, budget: { limit: 100, used: 0 } } });
    await vi.waitFor(() => expect(h.get('dom')!.chronicle.days.some((d) => d.ai)).toBe(true));
    const done = h.get('dom')!.chronicle.days.filter((d) => d.ai);
    expect(done).toHaveLength(1);
    expect(done[0].ai).toBe(answer);
    const view = JSON.parse(h.chronicle('dom')!.json) as ChronicleResponse;
    expect(view.days.find((d) => d.date === done[0].date)).toMatchObject({ summarySource: 'ai', summary: answer });
    expect(calls.filter((u) => u.endsWith('/api/llm/chronicle'))).toHaveLength(1);
    // one more finished day within two days gets its turn, then nothing is asked twice
    await h.sync();
    await vi.waitFor(() => expect(h.get('dom')!.chronicle.days.filter((d) => d.ai)).toHaveLength(2));
    await h.sync();
    await h.sync();
    expect(calls.filter((u) => u.endsWith('/api/llm/chronicle'))).toHaveLength(2);

    // the budget share is used up: no request, a procedural summary stays
    const refused = host({ fixedTime: lt('2026-10-29T08:00'), places: dom, ai: { fetch: fetchImpl, budget: { limit: 0, used: 0 } } });
    await refused.ready;
    expect(refused.chronicle('dom')).toBeDefined();
    expect(refused.get('dom')!.chronicle.days.every((d) => !d.ai)).toBe(true);
  });
});
