import { loadEnv, runnerImport, type Connect, type Plugin } from 'vite';
import type { LiveRuntime } from './worldsSetup.ts';

// Vite plugin wrapper: the live worlds (/api/live/*) on the dev and preview servers, so `npm run dev`
// and Playwright's `vite preview` have them too. The production server mounts the same handler.
// Differences from production: AI is off unless LIVE_AI=on (the dev server would otherwise spend
// the free quota all day), and the plugin has its own /api/llm handler instance + news cache.
// Not started under Vitest. The worlds code (the whole simulation) is loaded with Vite's module
// runner when the server starts instead of being bundled into vite.config.ts.

type Entry = typeof import('./worldsEntry');

export function worldsProxy(): Plugin {
  let env: Record<string, string | undefined> = {};
  let root = process.cwd();
  let runtime: Promise<LiveRuntime | null> | null = null;
  let log: (m: string) => void = (m) => console.log(m);

  const start = (): Promise<LiveRuntime | null> => {
    if (runtime) return runtime;
    if (process.env.VITEST) return (runtime = Promise.resolve(null));
    runtime = runnerImport<Entry>(`${root}/server/worldsEntry.ts`, { configFile: false, root, logLevel: 'error' })
      .then(({ module }) => {
        const rt = module.startLiveWorldsFromEnv(env, { log, aiDefault: false });
        // dev server restarts (config change) and Ctrl-C: keep the worlds' progress
        if (rt) {
          process.once('exit', () => rt.shutdown());
          for (const sig of ['SIGINT', 'SIGTERM'] as const)
            process.once(sig, () => {
              rt.shutdown();
              // we were the only listener: keep the default behaviour (exit)
              if (process.listenerCount(sig) === 0) process.exit(sig === 'SIGINT' ? 130 : 143);
            });
        }
        return rt;
      })
      .catch((err: unknown) => {
        log(`failed to start: ${(err as Error)?.stack ?? err}`);
        return null;
      });
    return runtime;
  };

  const stop = (): void => {
    const rt = runtime;
    runtime = null;
    void rt?.then((r) => r?.shutdown());
  };

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (!(req.url ?? '').startsWith('/api/live/')) return next();
    void start().then((rt) => {
      if (rt) return rt.handler(req, res, next);
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"error":"live worlds disabled"}');
    });
  };

  return {
    name: 'sim-live-worlds',
    configResolved(config) {
      const fileEnv = loadEnv(config.mode, config.envDir, '');
      // process env wins over .env files (Playwright / CLI overrides)
      env = { ...fileEnv, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== '')) };
      log = (m) => config.logger.info(`[live] ${m}`, { timestamp: true });
      root = config.root;
    },
    configureServer(server) {
      void start();
      server.httpServer?.once('close', stop);
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      void start();
      server.httpServer?.once('close', stop);
      server.middlewares.use(middleware);
    },
  };
}
