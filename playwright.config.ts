import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1400, height: 900 },
  },
  projects: [
    { name: 'chromium', testIgnore: 'live-ticking.spec.ts', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } } },
    {
      name: 'live-ticking',
      testMatch: 'live-ticking.spec.ts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 }, baseURL: 'http://localhost:4174' },
    },
  ],
  webServer: [
    {
      // no real TV headlines in e2e: keeps save/replay tests deterministic
      command: 'npm run build && npx vite preview --port 4173 --strictPort',
      // live worlds (server/worldsProxy.ts) pinned to a fixed Warsaw time: synced once, never tick,
      // no weather / news / AI, not persisted → /api/live/* frames are identical on every run
      env: { NEWS_FEEDS: 'off', LIVE_FIXED_TIME: '2026-10-29T12:00', LIVE_WEATHER: 'off', LIVE_AI: 'off', DATA_DIR: 'off' },
      url: 'http://localhost:4173',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      // second server, no LIVE_FIXED_TIME: worlds really tick (LIVE_SPEED=60 → one sim minute per second); reuses the build above
      command: 'npx vite preview --port 4174 --strictPort',
      env: { NEWS_FEEDS: 'off', LIVE_SPEED: '60', LIVE_WEATHER: 'off', LIVE_AI: 'off', DATA_DIR: 'off' },
      url: 'http://localhost:4174',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
