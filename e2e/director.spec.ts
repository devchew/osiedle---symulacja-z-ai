import { expect, test, type Page } from '@playwright/test';

// Director mode (#12): HUD toggle, the camera following a staged conversation, pause when the
// viewer takes the camera. Shots land in test-results/shots/director-*.png.

const SHOTS = 'test-results/shots';

async function openLive(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => window.__sim?.mode === 'live' && (window.__sim.frames ?? 0) >= 1, undefined, { timeout: 30_000 });
}

test.beforeAll(async ({ request }) => {
  const res = await request.get('/api/live/places');
  test.skip(!res.ok(), 'live worlds are not running on the preview server');
});

test('director mode: off by default, toggle has Polish label, follows a quarrel, pauses on drag', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openLive(page, '/dom');

  const btn = page.locator('#hud .hud-director-btn');
  await expect(btn).toHaveAttribute('aria-label', /Tryb reżysera/);
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.director-caption')).toBeHidden();
  expect(await page.evaluate(() => window.__sim.renderer.following)).toBeNull();

  // stage a quarrel between the first two residents in the browser's copy of the world
  const [a, b] = await page.evaluate(() => {
    const w = window.__sim.world;
    const tone = 'negative' as const;
    w.conversations.push({
      id: 9001,
      participants: [w.agents[1].id, w.agents[2].id],
      topic: 'pogoda',
      lines: [1, 2, 3].map((i) => ({ speakerId: w.agents[1 + (i % 2)].id, text: '…', tone })),
      nextLineIn: 5,
      pending: false,
      maxLines: 8,
      startedAt: w.tick,
    });
    return [w.agents[1].id, w.agents[2].id];
  });
  expect(a).not.toBe(b);

  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.director-caption')).toContainText('Kłótnia');
  expect(await page.evaluate(() => window.__sim.renderer.following)).toBe(a);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/director-follow.png` });

  // dragging the map is the viewer's call: the mode pauses
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(760, 480, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('.director-caption')).toContainText('Wstrzymano');
  expect(await page.evaluate(() => window.__sim.renderer.following)).toBeNull();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');

  // R switches it off
  await page.keyboard.press('r');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.director-caption')).toBeHidden();
  expect(errors).toEqual([]);
});
