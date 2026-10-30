import type { Page } from '@playwright/test';
import { PLACES, type ChronicleResponse, type LiveFrame, type PlaceId, type PlaceSummary } from '../../src/live/protocol';

// Serving world fixtures (./worldFixtures.ts) to the live view under /api/live/*, so a test controls
// exactly what the world looks like and when the next frame arrives. The preview server is only used
// for the static files.
//
//   const live = await mockLive(page, frameFor({ place: 'dom' }, tickAt(12)));
//   await openLive(page, '/dom');
//   await live.push(frameFor({ place: 'dom' }, tickAt(12) + 60));   // "the next minute" arrives
//
// The stream is not a real SSE response: route.fulfill() ends the response, which makes the client
// reconnect and flash the offline banner. Instead a small EventSource stub is installed that takes
// its first frame from the /snapshot route and gets later frames from `push`. Real streaming
// (real ticks, reconnects) belongs to the live-server e2e project, not here.

export const SHOTS = 'test-results/shots';

export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return errors;
}

export interface LiveMock {
  /** replaces the place's frame and delivers it to the open page; resolves once the client has applied it */
  push(frame: LiveFrame): Promise<void>;
}

export interface MockOptions {
  /** chronicle of every place (default: an empty one) */
  chronicle?: (place: PlaceId) => ChronicleResponse;
}

/** browser side: EventSource that gets its frames from the page's fetch and `__liveFixture.push` */
function installStreamStub(): void {
  type Listener = (e: { data: string }) => void;
  class StubSource {
    private readonly listeners = new Map<string, Listener[]>();
    private closed = false;
    constructor(readonly url: string) {
      sources.add(this);
      const place = /\/api\/live\/([^/]+)\/stream/.exec(url)?.[1];
      fetch(`/api/live/${place}/snapshot`)
        .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
        .then((data) => this.emit('frame', data))
        .catch(() => this.emit('error', ''));
    }
    addEventListener(type: string, fn: Listener): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    close(): void {
      this.closed = true;
      sources.delete(this);
    }
    emit(type: string, data: string): void {
      if (!this.closed) for (const fn of this.listeners.get(type) ?? []) fn({ data });
    }
  }
  const sources = new Set<StubSource>();
  const w = window as unknown as { EventSource: unknown; __liveFixture: unknown };
  w.EventSource = StubSource;
  w.__liveFixture = {
    push(place: string, data: string): void {
      for (const s of sources) if (s.url.includes(`/api/live/${place}/`)) s.emit('frame', data);
    },
  };
}

function summaries(frames: ReadonlyMap<PlaceId, LiveFrame>): PlaceSummary[] {
  return PLACES.map((p) => ({
    id: p.id,
    name: p.name,
    city: p.city,
    tick: frames.get(p.id)?.meta.tick ?? 0,
    residents: 0, // hides the "awake n/m" counter: it would need simulated sleep states
    awake: 0,
    highlight: null,
    temperature: null,
    weatherIcon: '☀️',
  }));
}

/** serves `frames` (one per place; the places without one answer 503) under /api/live/* for this page */
export async function mockLive(page: Page, frames: LiveFrame | readonly LiveFrame[], opts: MockOptions = {}): Promise<LiveMock> {
  const current = new Map<PlaceId, LiveFrame>();
  const json = new Map<PlaceId, string>();
  const set = (f: LiveFrame): string => {
    current.set(f.meta.place, f);
    const text = JSON.stringify(f);
    json.set(f.meta.place, text);
    return text;
  };
  for (const f of Array.isArray(frames) ? frames : [frames as LiveFrame]) set(f);

  await page.addInitScript(installStreamStub);
  await page.route('**/api/live/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/live/places') return route.fulfill({ json: summaries(current) });
    const m = /^\/api\/live\/([^/]+)\/(snapshot|chronicle)$/.exec(path);
    const place = PLACES.find((p) => p.id === m?.[1])?.id;
    if (!m || !place) return route.fulfill({ status: 404, json: { error: 'not found' } });
    if (m[2] === 'chronicle') return route.fulfill({ json: opts.chronicle?.(place) ?? { place, tick: current.get(place)?.meta.tick ?? 0, days: [] } });
    const body = json.get(place);
    return body ? route.fulfill({ contentType: 'application/json', body }) : route.fulfill({ status: 503, json: { error: 'starting' } });
  });

  return {
    async push(frame) {
      const text = set(frame);
      const before = await page.evaluate(() => window.__sim?.frames ?? 0);
      await page.evaluate(([place, data]) => (window as unknown as { __liveFixture: { push(p: string, d: string): void } }).__liveFixture.push(place, data), [frame.meta.place, text]);
      await page.waitForFunction((n) => (window.__sim?.frames ?? 0) > n, before, { timeout: 10_000 });
    },
  };
}

/** opens a live route and waits for the first frame to be on screen */
export async function openLive(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => window.__sim?.mode === 'live' && (window.__sim.frames ?? 0) >= 1, undefined, { timeout: 30_000 });
}
