import { expect, test, type Page } from '@playwright/test';

// Wave 7 houses: picking a house in the new world dialog, ?map= links, saves keep the house,
// saving disabled in real-time mode. Shots of every house: test-results/shots/house-*.png.

const SHOTS = 'test-results/shots';
const HOUSES = ['dom', 'kamienica', 'jezioro', 'akademik'];

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return errors;
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => !!window.__sim, undefined, { timeout: 20_000 });
}

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

test('new world dialog: pick "Akademik", the world reloads in that house', async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => localStorage.removeItem('sim.newworld.v1'));
  await open(page, '?seed=7&paused');
  await page.keyboard.press('n');
  const dialog = page.locator('.newworld');
  await expect(dialog).toBeVisible();
  const cards = dialog.locator('.newworld-house');
  await expect(cards).toHaveCount(HOUSES.length);
  await expect(dialog.locator('.newworld-house[aria-checked="true"]')).toHaveAttribute('data-map', 'dom');
  for (const id of HOUSES) expect(await canvasColours(page, `.newworld-house[data-map="${id}"] canvas`), id).toBeGreaterThan(4);
  await expect(dialog).toContainText('Domek nad jeziorem');

  // the lake cabin has 4 beds: the residents slider follows
  await dialog.locator('.newworld-house[data-map="jezioro"]').click();
  await expect(page.locator('#newworld-agents')).toHaveAttribute('max', '4');
  await dialog.locator('.newworld-house[data-map="akademik"]').click();
  await expect(page.locator('#newworld-agents')).toHaveAttribute('max', '8');
  await page.locator('#newworld-agents').fill('7');
  await page.locator('#newworld-seed').fill('321');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/house-dialog.png` });

  await Promise.all([page.waitForURL(/map=akademik/), dialog.locator('.newworld-start').click()]);
  await page.waitForFunction(() => !!window.__sim);
  const info = await page.evaluate(() => ({
    seed: window.__sim.world.seed,
    agents: window.__sim.world.agents.length,
    width: window.__sim.world.grid.width,
    rooms: window.__sim.world.grid.rooms.map((r) => r.name),
  }));
  expect(info.seed).toBe(321);
  expect(info.agents).toBe(7);
  expect(info.rooms).toContain('Świetlica');
  await page.waitForTimeout(600);
  expect(await canvasColours(page, '#world')).toBeGreaterThan(20);

  // the dialog remembers the last choice
  await page.keyboard.press('n');
  await expect(page.locator('.newworld-house[aria-checked="true"]')).toHaveAttribute('data-map', 'akademik');
  await expect(page.locator('#newworld-agents')).toHaveValue('7');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('save and load keep the house', async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('cleared')) {
      localStorage.removeItem('sim.saves.v1');
      sessionStorage.setItem('cleared', '1');
    }
  });
  await open(page, '?map=kamienica&seed=12&agents=5&paused');
  await page.evaluate(() => window.__sim.tick(300));
  const saved = await page.evaluate(() => ({ tick: window.__sim.world.tick, pos: window.__sim.world.agents.map((a) => ({ ...a.pos })) }));
  await page.locator('.hud-save-btn').click();
  await page.locator('.save-slot[data-slot="0"] .save-btn-save').click();
  await expect(page.locator('.save-slot[data-slot="0"]')).toContainText('Kamienica');

  await open(page, '?seed=99&agents=3&paused');
  expect(await page.evaluate(() => window.__sim.world.grid.width)).toBe(44);
  await page.keyboard.press('z');
  await Promise.all([page.waitForURL(/map=kamienica/), page.locator('.save-slot[data-slot="0"] .save-btn-load').click()]);
  await page.waitForFunction(() => !!window.__sim);
  const loaded = await page.evaluate(() => ({ tick: window.__sim.world.tick, pos: window.__sim.world.agents.map((a) => ({ ...a.pos })) }));
  expect(loaded).toEqual(saved);
  expect(await page.evaluate(() => window.__sim.world.grid.rooms.some((r) => r.name === 'Podwórko'))).toBe(true);
  await expect(page.locator('.ui-toast--warn')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('old saves without a house load into "Dom z ogrodem"', async ({ page }) => {
  await page.addInitScript(() => {
    const old = { version: 1, seed: 5, agentCount: 4, tick: 120, savedAt: Date.now() };
    localStorage.setItem('sim.saves.v1', JSON.stringify({ auto: null, slots: [old, null, null] }));
  });
  await open(page, '?map=akademik&seed=1&paused');
  await page.keyboard.press('z');
  await expect(page.locator('.save-slot[data-slot="0"]')).toContainText('Dom z ogrodem');
  await Promise.all([page.waitForURL(/tick=120/), page.locator('.save-slot[data-slot="0"] .save-btn-load').click()]);
  expect(new URL(page.url()).searchParams.get('map')).toBe('dom');
});

test('real-time mode: saving and links are disabled', async ({ page }) => {
  await open(page, '?mode=real&seed=4&map=jezioro');
  await page.waitForFunction(() => window.__sim.world.agents.length > 0);
  await page.locator('.hud-save-btn').click();
  const panel = page.locator('#save-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.save-realtime-note')).toBeVisible();
  await expect(panel.locator('.save-realtime-note')).toContainText('W trybie na żywo zapis i linki są niedostępne');
  await expect(panel.locator('.save-link')).toBeDisabled();
  for (const b of await panel.locator('.save-btn-save').all()) await expect(b).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/house-realtime-save.png` });
});

test.describe('every house by day', () => {
  for (const id of HOUSES) {
    test(`house ${id}`, async ({ page }) => {
      const errors = trackErrors(page);
      await open(page, `?map=${id}&seed=7&hour=12`);
      await page.waitForTimeout(1200);
      expect(await page.evaluate(() => window.__sim.world.grid.rooms.length)).toBeGreaterThan(3);
      // the plot fits the screen
      const fit = await page.evaluate(() => {
        const { world, renderer } = window.__sim;
        const a = renderer.toScreen(-0.5, -0.5);
        const b = renderer.toScreen(world.grid.width - 0.5, world.grid.height - 0.5);
        return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
      });
      expect(fit.x0).toBeGreaterThanOrEqual(-1);
      expect(fit.x1).toBeLessThanOrEqual(1401);
      expect(await canvasColours(page, '#world')).toBeGreaterThan(20);
      await page.screenshot({ path: `${SHOTS}/house-${id}.png` });
      expect(errors).toEqual([]);
    });
  }
});

test.describe('mobile 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('new world dialog fits and scrolls', async ({ page }) => {
    await open(page, '?seed=7&paused');
    await page.keyboard.press('n');
    const dialog = page.locator('.newworld');
    await expect(dialog).toBeVisible();
    const b = (await dialog.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
    expect(b.y + b.height).toBeLessThanOrEqual(844);
    await expect(dialog.locator('.newworld-start')).toBeInViewport();
    await expect(page.locator('#newworld-seed')).toHaveValue('');
    await page.waitForTimeout(300); // pop-in animation
    await page.screenshot({ path: `${SHOTS}/house-dialog-mobile.png` });
  });
});
