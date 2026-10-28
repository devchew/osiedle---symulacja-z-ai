import { loadEnv, type Connect, type Plugin } from 'vite';
import { isFreeModel } from '../src/social/llmProvider';
import { createDailyBudget, createLlmHandler, fetchKeyInfo, parseDailyLimit, parseModelList } from './llm';

// Vite plugin wrapper: mounts the handler from ./llm.ts on the dev and preview servers.
// The production server (server/prod.ts) mounts the same handler without Vite.
export * from './llm';

export function llmProxy(): Plugin {
  let handler: Connect.NextHandleFunction | null = null;
  return {
    name: 'sim-llm-proxy',
    configResolved(config) {
      // '' prefix: read all vars from .env files server-side; only VITE_* vars are ever exposed
      // to import.meta.env, so OPENROUTER_* stays out of the bundle
      const env = loadEnv(config.mode, config.envDir, '');
      const pick = (k: string): string | undefined => (env[k] || process.env[k] || '').trim() || undefined;
      const apiKey = pick('OPENROUTER_API_KEY');
      const models = parseModelList(pick('OPENROUTER_MODELS'));
      const daily = createDailyBudget(parseDailyLimit(pick('OPENROUTER_DAILY_LIMIT')));
      const log = (m: string): void => config.logger.warn(`[llm] ${m}`);
      const paid = models.filter((m) => !isFreeModel(m));
      if (apiKey && paid.length) log(`OPENROUTER_MODELS contains non-free models (may cost money): ${paid.join(', ')}`);
      handler = createLlmHandler({ apiKey, models, daily, log });
      if (apiKey && config.command === 'serve' && !process.env.VITEST) {
        // align the daily guard with the account's real free-model quota (50 or 1000 per UTC day)
        void fetchKeyInfo(apiKey).then((info) => {
          if (!info) return;
          daily.sync(info.used, info.limit);
          config.logger.info(`[llm] OpenRouter free requests today: ${info.used}/${info.limit}; proxy cap ${daily.limit}`);
        });
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => (handler ? handler(req, res, next) : next()));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => (handler ? handler(req, res, next) : next()));
    },
  };
}
