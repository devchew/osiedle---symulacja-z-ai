import { expect, test, type Page } from '@playwright/test';

// Sound (#13): off by default, HUD toggle (button + M), remembered in localStorage, audio only after a gesture.
// Screenshot: test-results/shots/sound-on.png.

const SHOTS = 'test-results/shots';

declare global {
  interface Window {
    __audioCtx?: AudioContext[];
  }
}

async function openLive(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    window.__audioCtx = [];
    window.AudioContext = class extends Native {
      constructor(opts?: AudioContextOptions) {
        super(opts);
        window.__audioCtx!.push(this);
      }
    };
  });
  await page.goto('/dom');
  await page.waitForFunction(() => window.__sim?.mode === 'live' && (window.__sim.frames ?? 0) >= 1, undefined, { timeout: 30_000 });
}

test.beforeAll(async ({ request }) => {
  const res = await request.get('/api/live/places');
  test.skip(!res.ok(), 'live worlds are not running on the preview server');
});

test('sound is off by default, starts on click, is remembered and toggles with M', async ({ page }) => {
  await openLive(page);
  const btn = page.locator('.hud-sound-btn');
  await expect(btn).toHaveAttribute('aria-label', 'Dźwięk (M)');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.__audioCtx!.length)).toBe(0);

  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('sim.sound'))).toBe('1');
  await expect.poll(() => page.evaluate(() => window.__audioCtx![0]?.state)).toBe('running');
  await page.screenshot({ path: `${SHOTS}/sound-on.png` });

  await page.reload();
  await page.waitForFunction(() => window.__sim?.mode === 'live' && (window.__sim.frames ?? 0) >= 1, undefined, { timeout: 30_000 });
  await expect(page.locator('.hud-sound-btn')).toHaveAttribute('aria-pressed', 'true');
  // a remembered "on" still waits for a gesture (autoplay policy)
  expect(await page.evaluate(() => window.__audioCtx!.length)).toBe(0);

  await page.keyboard.press('m');
  await expect(page.locator('.hud-sound-btn')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('sim.sound'))).toBe('0');
});

test('sound button is reachable with the keyboard', async ({ page }) => {
  await openLive(page);
  const btn = page.locator('.hud-sound-btn');
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
});
