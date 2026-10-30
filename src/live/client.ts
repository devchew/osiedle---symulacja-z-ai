import { LIVE_PLACES_URL, liveChronicleUrl, liveReplayUrl, liveSnapshotUrl, liveStreamUrl, type ChronicleResponse, type LiveFrame, type PlaceId, type PlaceSummary, type ReplayResponse } from './protocol';

// Network side of the live view: the place list, one-off snapshots and the
// Server-Sent Events stream of one place with reconnects. No simulation, no DOM besides
// EventSource / fetch.

export type StreamStatus = 'connecting' | 'online' | 'offline';

export interface LiveStream {
  readonly place: PlaceId;
  readonly status: StreamStatus;
  /** stops the stream for good (switching places, leaving the page) */
  close(): void;
  /** drops the current connection and connects again now (e.g. after the tab was hidden) */
  reconnect(): void;
}

export interface StreamHandlers {
  frame(frame: LiveFrame): void;
  status?(status: StreamStatus, info: { attempt: number; retryInMs: number | null }): void;
}

export interface StreamOptions {
  /** backoff: first retry after this many ms, doubling up to maxDelayMs (default 1 s → 30 s) */
  minDelayMs?: number;
  maxDelayMs?: number;
  /**
   * no frame or ping for this long = a dead connection (proxy dropped it silently): reconnect.
   * Frames come every minute and pings in between; default 150 s.
   */
  staleMs?: number;
  /** for tests */
  eventSource?: typeof EventSource;
}

/** next backoff delay: min·2^attempt, capped, ±20% jitter so tabs don't reconnect in lockstep */
export function backoffDelay(attempt: number, min = 1000, max = 30_000, rnd = Math.random): number {
  const base = Math.min(max, min * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.4 * rnd()));
}

export function parseFrame(data: string): LiveFrame | null {
  try {
    const f = JSON.parse(data) as LiveFrame;
    if (!f || typeof f !== 'object' || !f.meta || !f.snapshot || typeof f.meta.tick !== 'number') return null;
    return f;
  } catch {
    return null;
  }
}

/** subscribes to a place's live frames (immediately one frame, then one per tick) */
export function connectLive(place: PlaceId, handlers: StreamHandlers, opts: StreamOptions = {}): LiveStream {
  const ES = opts.eventSource ?? EventSource;
  const minDelay = opts.minDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  const staleMs = opts.staleMs ?? 150_000;
  let es: EventSource | null = null;
  let status: StreamStatus = 'connecting';
  let attempt = 0;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (s: StreamStatus, retryInMs: number | null = null): void => {
    status = s;
    handlers.status?.(s, { attempt, retryInMs });
  };

  const alive = (): void => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => fail(), staleMs);
  };

  function open(): void {
    if (closed) return;
    retryTimer = null;
    setStatus('connecting');
    const src = new ES(liveStreamUrl(place));
    es = src;
    alive();
    src.addEventListener('frame', (e) => {
      if (es !== src) return;
      const f = parseFrame((e as MessageEvent<string>).data);
      if (!f) return;
      alive();
      if (status !== 'online') {
        attempt = 0;
        setStatus('online');
      }
      handlers.frame(f);
    });
    src.addEventListener('ping', () => {
      if (es === src) alive();
    });
    src.addEventListener('error', () => {
      if (es !== src) return;
      // EventSource retries by itself, but not after HTTP errors and with a fixed delay:
      // always take over with our own backoff
      fail();
    });
  }

  function fail(): void {
    if (closed) return;
    es?.close();
    es = null;
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = null;
    if (retryTimer) return;
    const delay = backoffDelay(attempt, minDelay, maxDelay);
    attempt++;
    setStatus('offline', delay);
    retryTimer = setTimeout(open, delay);
  }

  open();
  return {
    place,
    get status() {
      return status;
    },
    close() {
      closed = true;
      es?.close();
      es = null;
      if (retryTimer) clearTimeout(retryTimer);
      if (staleTimer) clearTimeout(staleTimer);
    },
    reconnect() {
      if (closed) return;
      es?.close();
      es = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      attempt = 0;
      open();
    },
  };
}

async function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function fetchPlaces(timeoutMs = 8000): Promise<PlaceSummary[]> {
  return getJson<PlaceSummary[]>(LIVE_PLACES_URL, timeoutMs);
}

export async function fetchSnapshot(place: PlaceId, timeoutMs = 20_000): Promise<LiveFrame> {
  const f = await getJson<LiveFrame>(liveSnapshotUrl(place), timeoutMs);
  if (!f?.meta || !f.snapshot) throw new Error('Invalid live snapshot');
  return f;
}

export async function fetchChronicle(place: PlaceId, timeoutMs = 10_000): Promise<ChronicleResponse> {
  const c = await getJson<ChronicleResponse>(liveChronicleUrl(place), timeoutMs);
  if (!c || !Array.isArray(c.days)) throw new Error('Invalid chronicle');
  return c;
}

/** a recording that can be played: at least one tick long, with residents */
function usableReplay(data: unknown): data is ReplayResponse {
  const d = data as Partial<ReplayResponse> | null;
  return (
    !!d &&
    d.format === 1 &&
    typeof d.fromTick === 'number' &&
    typeof d.toTick === 'number' &&
    d.toTick > d.fromTick &&
    Array.isArray(d.agents) &&
    d.agents.length > 0 &&
    Array.isArray(d.pets) &&
    Array.isArray(d.objects) &&
    Array.isArray(d.weather) &&
    Array.isArray(d.events) &&
    Array.isArray(d.projects)
  );
}

/** the recording of the place's last 24 h (can be a few hundred KB of JSON, gzipped on the wire) */
export async function fetchReplay(place: PlaceId, timeoutMs = 30_000): Promise<ReplayResponse> {
  const r = await getJson<ReplayResponse>(liveReplayUrl(place), timeoutMs);
  if (!usableReplay(r)) throw new Error('Invalid replay');
  return r;
}
