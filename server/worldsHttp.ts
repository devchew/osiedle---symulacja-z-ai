import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSegment, gzipStreamHeader, sseMessage, type LiveFrameData, type LiveHost } from './worlds';
import type { PlaceId } from '../src/live/protocol';

// HTTP endpoints of the live worlds (plain Node handlers; mounted by server/prod.ts and by the
// Vite plugin server/worldsProxy.ts):
//   GET /api/live/places              → PlaceSummary[]
//   GET /api/live/:place/snapshot     → LiveFrame (503 { error: 'starting' } until the world is synced)
//   GET /api/live/:place/chronicle    → ChronicleResponse (503 { error: 'starting' } until the world is synced)
//   GET /api/live/:place/replay      → ReplayResponse: the last 24 h recorded (503 `starting` until synced)
//   GET /api/live/:place/stream       → SSE: `event: frame` right away (as soon as the world is
//                                       synced) and after every tick; `event: ping` every ~25 s
// Frames are serialized once per tick by the host and written as the same Buffer to every
// subscriber; with `Accept-Encoding: gzip` the stream is gzip made of independently deflated,
// full-flushed segments (also computed once per frame), so compression costs nothing per viewer.

export const LIVE_PREFIX = '/api/live/';
export const PING_MS = 25_000;
/** SSE reconnect delay suggested to EventSource */
export const SSE_RETRY_MS = 5000;
/** a subscriber that has this much unsent data is too slow: dropped (EventSource reconnects) */
const MAX_BUFFERED = 4 * 1024 * 1024;

export interface LiveHttpOptions {
  /** concurrent SSE streams in total (default 200) */
  maxStreams?: number;
  /** concurrent SSE streams per client IP (default 8) */
  maxStreamsPerIp?: number;
  pingMs?: number;
  log?: (msg: string) => void;
}

export type LiveHandler = ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) & {
  /** ends all streams and stops the ping timer */
  close(): void;
  /** open streams (for tests / logs) */
  streams(): number;
};

interface Client {
  res: ServerResponse;
  gzip: boolean;
  ip: string;
  place: PlaceId;
  close(): void;
}

const PING = sseMessage('ping', '{}');
const PING_GZ = deflateSegment(PING);
const RETRY = `retry: ${SSE_RETRY_MS}\n\n`;
const RETRY_GZ = deflateSegment(RETRY);

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function acceptsGzip(req: IncomingMessage): boolean {
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''));
}

/**
 * client address for the per-IP limit: the last X-Forwarded-For hop (the one our reverse proxy,
 * e.g. Coolify's Traefik, appended), else the socket address
 */
export function clientIp(req: IncomingMessage): string {
  const xff = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return xff[xff.length - 1] ?? req.socket?.remoteAddress ?? '?';
}

export function createLiveHandler(host: LiveHost, opts: LiveHttpOptions = {}): LiveHandler {
  const maxStreams = opts.maxStreams ?? 200;
  const maxPerIp = opts.maxStreamsPerIp ?? 8;
  const log = opts.log ?? (() => {});
  const clients = new Set<Client>();
  const perIp = new Map<string, number>();
  const subscribed = new Set<PlaceId>();
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const write = (c: Client, plain: Buffer | string, gz: Buffer): void => {
    if (c.res.writableLength > MAX_BUFFERED) {
      log(`dropping a slow ${c.place} stream (${c.ip})`);
      c.close();
      return;
    }
    c.res.write(c.gzip ? gz : plain);
  };

  const sendFrame = (c: Client, f: LiveFrameData): void => write(c, f.sse, c.gzip ? f.sseDeflated() : Buffer.alloc(0));

  function ensureSubscribed(place: PlaceId): void {
    if (subscribed.has(place)) return;
    subscribed.add(place);
    host.onFrame(place, (f) => {
      for (const c of clients) if (c.place === place) sendFrame(c, f);
    });
  }

  function ensurePing(): void {
    if (pingTimer) return;
    pingTimer = setInterval(() => {
      for (const c of clients) write(c, PING, PING_GZ);
    }, opts.pingMs ?? PING_MS);
    (pingTimer as { unref?: () => void }).unref?.();
  }

  function stream(req: IncomingMessage, res: ServerResponse, place: PlaceId): void {
    const ip = clientIp(req);
    if (clients.size >= maxStreams) return sendJson(res, 503, { error: 'too many viewers' }, { 'Retry-After': '30' });
    if ((perIp.get(ip) ?? 0) >= maxPerIp) return sendJson(res, 429, { error: 'too many streams' }, { 'Retry-After': '30' });
    const gzip = acceptsGzip(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      Vary: 'Accept-Encoding',
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    });
    req.socket?.setNoDelay?.(true);
    let released = false;
    const releaseViewer = host.addViewer(place);
    const c: Client = {
      res,
      gzip,
      ip,
      place,
      close() {
        if (released) return;
        released = true;
        clients.delete(c);
        const n = (perIp.get(ip) ?? 1) - 1;
        if (n > 0) perIp.set(ip, n);
        else perIp.delete(ip);
        releaseViewer();
        if (!res.writableEnded) res.end();
      },
    };
    clients.add(c);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    req.on('close', () => c.close());
    res.on('close', () => c.close());
    res.on('error', () => c.close());
    ensureSubscribed(place);
    ensurePing();
    if (gzip) res.write(gzipStreamHeader());
    write(c, RETRY, RETRY_GZ);
    const frame = host.get(place)?.frame;
    // not synced yet: the first frame follows as soon as the world is ready
    if (frame) sendFrame(c, frame);
  }

  const handler = ((req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = (req.url ?? '').split('?')[0];
    if (!path.startsWith(LIVE_PREFIX)) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
    const parts = path.slice(LIVE_PREFIX.length).split('/');
    if (parts.length === 1 && parts[0] === 'places') {
      return sendJson(res, 200, host.summaries(), { 'Cache-Control': 'no-cache' });
    }
    const lw = parts.length === 2 ? host.get(parts[0]) : undefined;
    if (!lw || (parts[1] !== 'snapshot' && parts[1] !== 'stream' && parts[1] !== 'chronicle' && parts[1] !== 'replay')) return sendJson(res, 404, { error: 'not found' });
    if (parts[1] === 'stream') return stream(req, res, lw.place.id);
    if (parts[1] === 'chronicle' || parts[1] === 'replay') {
      const c = parts[1] === 'chronicle' ? host.chronicle(lw.place.id) : host.replay(lw.place.id);
      if (!c) return sendJson(res, 503, { error: 'starting' }, { 'Retry-After': '5' });
      if (req.headers['if-none-match'] === c.etag) {
        res.writeHead(304, { ETag: c.etag, 'Cache-Control': 'no-cache' }).end();
        return;
      }
      const gz = acceptsGzip(req);
      const data = gz ? c.jsonGzip() : Buffer.from(c.json);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Length': String(data.length),
        ETag: c.etag,
        Vary: 'Accept-Encoding',
        ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
      });
      res.end(req.method === 'HEAD' ? undefined : data);
      return;
    }
    const f = lw.frame;
    if (!lw.ready || !f) return sendJson(res, 503, { error: 'starting' }, { 'Retry-After': '5' });
    const etag = `"${f.place}-${f.tick}-${f.serverTime}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }).end();
      return;
    }
    const gzip = acceptsGzip(req);
    const body = gzip ? f.jsonGzip() : Buffer.from(f.json);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Length': String(body.length),
      ETag: etag,
      Vary: 'Accept-Encoding',
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }) as LiveHandler;

  handler.close = () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    for (const c of [...clients]) c.close();
  };
  handler.streams = () => clients.size;
  return handler;
}
