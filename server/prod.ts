// simulation modules have import cycles whose top-level state depends on evaluation order:
// load the world entry first, exactly like the tests and the browser do
import '../src/world/world';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { isFreeModel } from '../src/social/llmProvider';
import { createDailyBudget, createLlmHandler, fetchKeyInfo, parseDailyLimit, parseModelList } from './llm';
import { createNewsHandler, createNewsService, parseFeedList } from './news';
import { liveConfigFromEnv } from './worlds';
import { startLiveWorlds } from './worldsSetup';

// Production server (used by the Docker image): serves the static build from dist/ and
// mounts the same /api/llm and /api/news handlers the Vite dev server uses — without Vite.
// Configuration comes from environment variables only (never baked into the image):
//   PORT (8080), STATIC_DIR (./dist), OPENROUTER_API_KEY, OPENROUTER_MODELS,
//   OPENROUTER_DAILY_LIMIT, NEWS_FEEDS ("off" disables real headlines),
//   live worlds (server/worlds.ts): LIVE_WORLDS=off, DATA_DIR (./data), LIVE_AI=off, LIVE_WEATHER=off,
//   LIVE_SPEED, LIVE_FIXED_TIME, LIVE_MAX_STREAMS (200), LIVE_MAX_STREAMS_PER_IP (8).

const env = (k: string): string | undefined => (process.env[k] ?? '').trim() || undefined;
const PORT = Number(env('PORT') ?? 8080);
const ROOT = resolve(env('STATIC_DIR') ?? 'dist');
const log = (m: string): void => console.log(`${new Date().toISOString()} ${m}`);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

// ---------------------------------------------------------------- API handlers

const apiKey = env('OPENROUTER_API_KEY');
const models = parseModelList(env('OPENROUTER_MODELS'));
const daily = createDailyBudget(parseDailyLimit(env('OPENROUTER_DAILY_LIMIT')));
const paid = models.filter((m) => !isFreeModel(m));
if (apiKey && paid.length) log(`[llm] OPENROUTER_MODELS contains non-free models (may cost money): ${paid.join(', ')}`);
log(`[llm] ${apiKey ? `enabled, models: ${models.join(', ')}` : 'disabled (no OPENROUTER_API_KEY) — procedural dialogue only'}`);
if (apiKey) {
  void fetchKeyInfo(apiKey).then((info) => {
    if (!info) return;
    daily.sync(info.used, info.limit);
    log(`[llm] OpenRouter free requests today: ${info.used}/${info.limit}; proxy cap ${daily.limit}`);
  });
}
const llm = createLlmHandler({ apiKey, models, daily, log: (m) => log(`[llm] ${m}`) }) as Handler;

const feeds = parseFeedList(env('NEWS_FEEDS'));
log(`[news] ${feeds.length ? `${feeds.length} feeds` : 'disabled — local bulletins only'}`);
const newsService = createNewsService({ feeds, log: (m) => log(`[news] ${m}`) });
const news = createNewsHandler(newsService, (m) => log(`[news] ${m}`)) as Handler;

// the four shared live worlds; same /api/llm handler (key, limits, daily budget) and news cache
const live = startLiveWorlds(liveConfigFromEnv(process.env), {
  llm: { handler: llm, daily, apiKey },
  news: feeds.length ? newsService : null,
  log: (m) => log(`[live] ${m}`),
  maxStreams: Number(env('LIVE_MAX_STREAMS') ?? 200),
  maxStreamsPerIp: Number(env('LIVE_MAX_STREAMS_PER_IP') ?? 8),
});

// ---------------------------------------------------------------- static files

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  // no path traversal outside ROOT
  let file = normalize(join(ROOT, rel));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    res.writeHead(403).end();
    return;
  }
  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = join(file, 'index.html');
    info = await stat(file).catch(() => null);
  }
  // single-page app: unknown paths without an extension get index.html
  if (!info && !extname(rel)) {
    file = join(ROOT, 'index.html');
    info = await stat(file).catch(() => null);
  }
  if (!info) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  const hashed = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
    // Vite puts content-hashed files in assets/: cache them forever, everything else revalidates
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- server

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  const fallthrough = (): void => {
    serveStatic(req, res).catch((e: unknown) => {
      log(`static error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  };
  if (path.startsWith('/api/llm')) return llm(req, res, () => res.writeHead(404).end());
  if (path.startsWith('/api/news')) return news(req, res, () => res.writeHead(404).end());
  if (path.startsWith('/api/live/')) {
    if (live) return live.handler(req, res, () => res.writeHead(404).end());
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"live worlds disabled"}');
    return;
  }
  fallthrough();
});

server.listen(PORT, () => log(`Osiedle listening on :${PORT}, static files from ${ROOT}`));

// graceful shutdown for docker stop
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log(`${sig} — shutting down`);
    // save the live worlds first (synchronous), then close the streams so server.close can finish
    live?.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
