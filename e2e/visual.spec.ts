import { expect, test, type Page } from '@playwright/test';

// Visual smoke tests: screenshots of the main states (for human review) plus a
// few layout invariants. Shots land in test-results/shots/visual-*.png.

const SHOTS = 'test-results/shots';

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return errors;
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => !!window.__sim);
  await page.waitForTimeout(1200);
}

type Rect = { x: number; y: number; w: number; h: number };
const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** screen rect of the house (bounding box of wall tiles) in the default camera view */
async function houseRect(page: Page): Promise<Rect> {
  return page.evaluate(() => {
    const { world, renderer } = window.__sim;
    const g = world.grid;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < g.height; y++)
      for (let x = 0; x < g.width; x++)
        if (g.tiles[y * g.width + x] === 'wall') {
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
    const a = renderer.toScreen(x0 - 0.5, y0 - 0.5);
    const b = renderer.toScreen(x1 + 0.5, y1 + 0.5);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  });
}

async function boxOf(page: Page, selector: string): Promise<Rect> {
  const b = await page.locator(selector).boundingBox();
  expect(b, selector).not.toBeNull();
  return { x: b!.x, y: b!.y, w: b!.width, h: b!.height };
}

test.describe('desktop 1400×900', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('day: house fully visible, not covered by HUD or log', async ({ page }) => {
    const errors = trackErrors(page);
    await open(page, '?seed=7&hour=12');
    const house = await houseRect(page);
    expect(house.x).toBeGreaterThanOrEqual(0);
    expect(house.y).toBeGreaterThanOrEqual(0);
    expect(house.x + house.w).toBeLessThanOrEqual(1400);
    expect(house.y + house.h).toBeLessThanOrEqual(900);
    expect(intersects(house, await boxOf(page, '#hud'))).toBe(false);
    await page.screenshot({ path: `${SHOTS}/visual-day.png` });
    expect(errors).toEqual([]);
  });

  test('dusk', async ({ page }) => {
    const errors = trackErrors(page);
    await open(page, '?seed=7&hour=20');
    await page.screenshot({ path: `${SHOTS}/visual-dusk.png` });
    expect(errors).toEqual([]);
  });

  test('night', async ({ page }) => {
    const errors = trackErrors(page);
    await open(page, '?seed=7&hour=23');
    await page.screenshot({ path: `${SHOTS}/visual-night.png` });
    expect(errors).toEqual([]);
  });

  test('inspector open + help popover', async ({ page }) => {
    const errors = trackErrors(page);
    await open(page, '?seed=7&hour=12&paused');
    const id = await page.evaluate(() => window.__sim.world.agents[0].id);
    await page.evaluate((i) => window.__sim.select(i), id);
    await expect(page.locator('#inspector')).toBeVisible();
    await expect(page.locator('#inspector .insp-now-text')).not.toBeEmpty();
    await page.screenshot({ path: `${SHOTS}/visual-inspector.png` });

    await page.keyboard.press('h');
    await expect(page.locator('.hud-help')).toBeVisible();
    await expect(page.locator('.hud-help')).toContainText('dwuklik');
    await page.waitForTimeout(300); // pop-in animation
    await page.screenshot({ path: `${SHOTS}/visual-help.png` });
    await page.keyboard.press('Escape');
    await expect(page.locator('.hud-help')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('double-click on an agent follows it', async ({ page }) => {
    const errors = trackErrors(page);
    await open(page, '?seed=7&hour=12&paused');
    const hit = await page.evaluate(() => {
      const { renderer, world } = window.__sim;
      const a = world.agents[0];
      return { ...renderer.toScreen(a.pos.x, a.pos.y - 0.1), id: a.id };
    });
    await page.mouse.dblclick(hit.x, hit.y);
    await expect.poll(() => page.evaluate(() => window.__sim.renderer.following)).toBe(hit.id);
    // panning with the keyboard cancels following
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(150);
    await page.keyboard.up('ArrowRight');
    expect(await page.evaluate(() => window.__sim.renderer.following)).toBeNull();
    expect(errors).toEqual([]);
  });

  test('event log is compact by default and expands', async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem('sim.log.collapsed'));
    await open(page, '?seed=7&hour=14');
    const visibleRows = () => page.locator('#log .log-row:visible').count();
    expect(await visibleRows()).toBeLessThanOrEqual(3);
    await page.locator('#log .log-toggle').click();
    expect(await visibleRows()).toBeGreaterThan(3);
  });
});

test.describe('mobile 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('layout fits and the house is visible', async ({ page }) => {
    const errors = trackErrors(page);
    await open(page, '?seed=7&hour=12');
    const hud = await boxOf(page, '#hud');
    expect(hud.x).toBeGreaterThanOrEqual(0);
    expect(hud.x + hud.w).toBeLessThanOrEqual(390);
    const log = await boxOf(page, '#log');
    expect(log.x + log.w).toBeLessThanOrEqual(390);
    const house = await houseRect(page);
    expect(intersects(house, hud)).toBe(false);
    expect(intersects(house, log)).toBe(false);
    await page.screenshot({ path: `${SHOTS}/visual-mobile.png` });

    const id = await page.evaluate(() => window.__sim.world.agents[1].id);
    await page.evaluate((i) => window.__sim.select(i), id);
    await expect(page.locator('#inspector')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/visual-mobile-inspector.png` });
    expect(errors).toEqual([]);
  });
});
