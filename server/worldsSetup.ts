import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NewsService } from './news';
import type { DailyBudget } from './llm';
import { createLiveHost, openMeteoWeather, type LiveEnvConfig, type LiveHost } from './worlds';
import { createLiveHandler, type LiveHandler } from './worldsHttp';
import { inProcessFetch } from './worldsAi';

// Wiring shared by server/prod.ts and the Vite plugin: env config + the process' news service and
// /api/llm handler → a running live host and its HTTP handler.

export interface LiveDeps {
  /** the process' /api/llm handler and its daily budget; omit / no key = procedural dialogue */
  llm?: { handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void; daily: DailyBudget; apiKey: string | undefined } | null;
  news?: NewsService | null;
  log: (msg: string) => void;
  maxStreams?: number;
  maxStreamsPerIp?: number;
}

export interface LiveRuntime {
  host: LiveHost;
  handler: LiveHandler;
  /** saves synchronously and stops timers and streams */
  shutdown(): void;
}

export function startLiveWorlds(cfg: LiveEnvConfig, deps: LiveDeps): LiveRuntime | null {
  const { log } = deps;
  if (!cfg.enabled) {
    log('disabled (LIVE_WORLDS=off)');
    return null;
  }
  const ai = cfg.ai && deps.llm?.apiKey ? { fetch: inProcessFetch(deps.llm.handler), budget: deps.llm.daily } : null;
  const news = cfg.news && deps.news ? deps.news : null;
  const host = createLiveHost({
    dataDir: cfg.dataDir,
    speed: cfg.speed,
    fixedTime: cfg.fixedTime,
    weather: cfg.weather ? openMeteoWeather : null,
    news: news
      ? {
          headlines: async () => {
            const r = await news.get();
            return r.items;
          },
        }
      : null,
    ai,
    log,
  });
  log(
    `4 worlds: data ${cfg.dataDir ?? 'not persisted'}, speed ×${cfg.speed}` +
      `${cfg.fixedTime ? ', fixed clock' : ''}, weather ${cfg.weather ? 'on' : 'off'}, news ${news ? 'on' : 'off'}, AI ${ai ? 'on' : 'off'}`,
  );
  host.ready.catch(() => {}); // logged by the host; the HTTP endpoints then answer 503 'starting'
  const handler = createLiveHandler(host, { log, maxStreams: deps.maxStreams, maxStreamsPerIp: deps.maxStreamsPerIp });
  let done = false;
  return {
    host,
    handler,
    shutdown() {
      if (done) return;
      done = true;
      host.stop();
      host.saveAllSync();
      handler.close();
    },
  };
}
