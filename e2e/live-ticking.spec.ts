import { expect, test } from '@playwright/test';

// Runs only in the "live-ticking" project: a server without LIVE_FIXED_TIME and with LIVE_SPEED=60
// (see playwright.config.ts), so the worlds really tick and new frames keep arriving over SSE.

test('live view: next frames arrive from the server and the view updates', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  const res = await request.get('/api/live/places');
  expect(res.ok(), 'live worlds are running on the ticking server').toBe(true);

  await page.goto('/dom');
  await page.waitForFunction(() => window.__sim?.mode === 'live' && (window.__sim.frames ?? 0) >= 1, undefined, { timeout: 30_000 });
  // positions alone can stay put for minutes (everyone sleeping or busy in place), so the view state
  // also covers needs, mood and the current action: all of them move with every applied frame
  const snapshot = (): Promise<{ frames: number; tick: number; state: string }> =>
    page.evaluate(() => ({
      frames: window.__sim.frames ?? 0,
      tick: window.__sim.world.tick,
      state: JSON.stringify(window.__sim.world.agents.map((a) => [a.needs, a.mood, a.action?.kind ?? null, a.pos])),
    }));
  const first = await snapshot();
  const clock = page.locator('#hud .hud-clock');
  const clock0 = await clock.textContent();

  // a tick every second: a few more frames and a moved world within seconds (slow CI runners are given time)
  await page.waitForFunction((f) => (window.__sim.frames ?? 0) >= f + 3, first.frames, { timeout: 45_000 });
  let next = await snapshot();
  expect(next.tick).toBeGreaterThan(first.tick);
  await expect
    .poll(async () => {
      next = await snapshot();
      return next.state !== first.state;
    }, { timeout: 30_000, message: 'residents (position, needs, mood or action) change between frames' })
    .toBe(true);

  // the HUD clock follows the world minute by minute
  await expect(clock).not.toHaveText(clock0 ?? '', { timeout: 10_000 });
  await expect(clock).toHaveText(/^\d{1,2}:\d{2}$/);
  await expect(page.locator('.ui-conn')).toBeHidden();
  expect(errors).toEqual([]);
});
