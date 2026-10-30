import { expect, test, type Page } from '@playwright/test';
import { SHOTS, mockLive, openLive, trackErrors } from './support/live';
import { frameFor } from './support/worldFixtures';

// Panels of the live view on a fixture world (e2e/support): stats panel, memories in the inspector,
// phone layout. Shots land in test-results/shots/ui-*.png.

const DOM = { place: 'dom' } as const;
/** day 3 */
const TICK_STATS = 3300;
const TICK_MEMORIES = 2400;

/** distinct colours in a canvas (sampled) — proves something was drawn */
async function canvasColours(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const set = new Set<number>();
    for (let i = 0; i < d.length; i += 4 * 37) if (d[i + 3] > 0) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return set.size;
  }, selector);
}

test('stats panel: network, mood history and table are drawn', async ({ page }) => {
  const errors = trackErrors(page);
  const live = await mockLive(page, frameFor(DOM, TICK_STATS));
  await openLive(page, '/dom');
  // the mood history is recorded from the frames in the browser: let a few arrive
  for (let i = 1; i <= 3; i++) await live.push(frameFor(DOM, TICK_STATS + i * 30));
  await page.keyboard.press('t');
  const panel = page.locator('#stats-panel');
  await expect(panel).toBeVisible();
  await expect(page.locator('.hud-stats-btn')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(400);
  expect(await canvasColours(page, '.stats-net')).toBeGreaterThan(10);
  expect(await canvasColours(page, '.stats-chart')).toBeGreaterThan(10);
  await expect(panel.locator('.stats-empty')).toBeHidden();
  const n = await page.evaluate(() => window.__sim.world.agents.length);
  await expect(panel.locator('.stats-table tbody tr')).toHaveCount(n);

  // hover an edge between the first two residents (midpoint of the chord)
  const box = (await panel.locator('.stats-net').boundingBox())!;
  const mid = await page.evaluate(
    ({ w, h, n }) => {
      const R = Math.max(30, Math.min(w, h) / 2 - 40);
      const p = (i: number) => {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        return { x: w / 2 + Math.cos(a) * R, y: h / 2 + Math.sin(a) * R };
      };
      const a = p(0);
      const b = p(1);
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    },
    { w: box.width, h: box.height, n },
  );
  await page.mouse.move(box.x + mid.x, box.y + mid.y);
  await expect(panel.locator('.stats-info')).toContainText('↔');
  // hover the chart for the crosshair tooltip
  const chart = (await panel.locator('.stats-chart').boundingBox())!;
  await page.mouse.move(chart.x + chart.width * 0.6, chart.y + chart.height / 2);
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${SHOTS}/ui-stats.png` });

  // clicking a name opens the inspector; Esc closes the stats first
  await panel.locator('.stats-name').first().click();
  await expect(page.locator('#inspector')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.locator('#inspector')).toBeVisible();
  expect(errors).toEqual([]);
});

test('stats and diary panels stay clear of the open inspector (720–1300 px)', async ({ page }) => {
  const errors = trackErrors(page);
  await mockLive(page, frameFor(DOM, TICK_MEMORIES));
  await openLive(page, '/dom');
  const id = await page.evaluate(() => window.__sim.world.agents[0].id);
  await page.evaluate((i) => window.__sim.select(i), id);
  const inspector = page.locator('#inspector');
  await expect(inspector).toBeVisible();

  for (const width of [740, 800, 1000, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [panelId, open] of [
      ['#stats-panel', () => page.keyboard.press('t')],
      ['#diary-panel', () => page.locator('#inspector .insp-diary-btn').click()],
    ] as const) {
      await open();
      const panel = page.locator(panelId);
      await expect(panel).toBeVisible();
      await page.waitForTimeout(250);
      const p = (await panel.boundingBox())!;
      const i = (await inspector.boundingBox())!;
      expect(p.x, `${panelId} left edge at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(p.x + p.width, `${panelId} clears the inspector at ${width}px`).toBeLessThanOrEqual(i.x);
      if (width === 740 || width === 1000) await page.screenshot({ path: `${SHOTS}/ui-panel-${panelId.slice(1, 6)}-${width}.png` });
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await expect(inspector).toBeVisible();
    }
  }
  expect(errors).toEqual([]);
});

test('inspector shows memories (collapsible)', async ({ page }) => {
  const errors = trackErrors(page);
  await mockLive(page, frameFor(DOM, TICK_MEMORIES));
  await openLive(page, '/dom');
  // the resident with the most memories
  const id = await page.evaluate(() => {
    const w = window.__sim.world;
    let best = w.agents[0].id;
    let max = -1;
    for (const a of w.agents) {
      window.__sim.select(a.id);
      const n = document.querySelectorAll('#inspector .mem-row').length;
      if (n > max) {
        max = n;
        best = a.id;
      }
    }
    return best;
  });
  await page.evaluate((i) => window.__sim.select(i), id);
  const section = page.locator('#inspector .insp-memories');
  await expect(section).toBeVisible();
  await expect(section).toContainText('Wspomnienia');
  const rows = section.locator('.mem-row');
  expect(await rows.count()).toBeGreaterThan(0);
  expect(await rows.count()).toBeLessThanOrEqual(5);
  await expect(section.locator('.mem-tag').first()).toHaveText(/przeżyte|zasłyszane|od: /);
  await section.locator('.mem-row').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/ui-memories.png` });

  await section.locator('.insp-sec-toggle').click();
  await expect(section.locator('.insp-sec-body')).toBeHidden();
  await section.locator('.insp-sec-toggle').click();
  await expect(section.locator('.insp-sec-body')).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('mobile 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('HUD fits; stats is a full-screen sheet', async ({ page }) => {
    const errors = trackErrors(page);
    await mockLive(page, frameFor(DOM, TICK_STATS));
    await openLive(page, '/dom');
    const hud = (await page.locator('#hud').boundingBox())!;
    expect(hud.x).toBeGreaterThanOrEqual(0);
    expect(hud.x + hud.width).toBeLessThanOrEqual(390);
    await page.locator('.hud-stats-btn').tap();
    const panel = page.locator('#stats-panel');
    await expect(panel).toBeVisible();
    const b = (await panel.boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(389);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/ui-mobile-stats.png` });
    await page.locator('#stats-panel .panel-header .ui-icon-btn').tap();
    await expect(panel).toBeHidden();
    expect(errors).toEqual([]);
  });
});
