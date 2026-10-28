import { loadEnv, type Connect, type Plugin } from 'vite';
import { createNewsHandler, createNewsService, parseFeedList } from './news';

// Vite plugin wrapper: mounts the handler from ./news.ts on the dev and preview servers.
// The production server (server/prod.ts) mounts the same handler without Vite.
export * from './news';

export function newsProxy(): Plugin {
  let handler: Connect.NextHandleFunction | null = null;
  return {
    name: 'sim-news-proxy',
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir, '');
      const feeds = parseFeedList((env.NEWS_FEEDS || process.env.NEWS_FEEDS || '').trim() || undefined);
      const log = (m: string): void => config.logger.warn(`[news] ${m}`);
      handler = createNewsHandler(createNewsService({ feeds, log }), log);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => (handler ? handler(req, res, next) : next()));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => (handler ? handler(req, res, next) : next()));
    },
  };
}
