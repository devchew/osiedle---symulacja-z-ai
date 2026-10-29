// simulation modules have import cycles whose top-level state depends on evaluation order:
// load the world entry first, exactly like the tests and the browser do
import '../src/world/world';
import { createDailyBudget, createLlmHandler, parseDailyLimit, parseModelList } from './llm';
import { createNewsService, parseFeedList } from './news';
import { liveConfigFromEnv } from './worlds';
import { startLiveWorlds, type LiveRuntime } from './worldsSetup';

// Entry for the Vite plugin (server/worldsProxy.ts, loaded through Vite's module runner): live
// worlds configured from env with their own /api/llm handler instance and news cache.

export function startLiveWorldsFromEnv(env: Record<string, string | undefined>, opts: { log: (m: string) => void; aiDefault: boolean }): LiveRuntime | null {
  const { log } = opts;
  const cfg = liveConfigFromEnv(env, opts.aiDefault);
  const apiKey = env.OPENROUTER_API_KEY?.trim() || undefined;
  const daily = createDailyBudget(parseDailyLimit(env.OPENROUTER_DAILY_LIMIT));
  const llm = cfg.ai && apiKey ? { handler: createLlmHandler({ apiKey, models: parseModelList(env.OPENROUTER_MODELS), daily, log }), daily, apiKey } : null;
  const feeds = parseFeedList(env.NEWS_FEEDS?.trim() || undefined);
  return startLiveWorlds(cfg, { llm, news: feeds.length ? createNewsService({ feeds, log }) : null, log });
}
