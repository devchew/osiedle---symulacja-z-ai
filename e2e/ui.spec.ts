import { expect, test, type Page } from '@playwright/test';

// Wave 5 UI: save / load / share links, new world dialog, stats panel, memories in the inspector.
// Shots land in test-results/shots/ui-*.png.

const SHOTS = 'test-results/shots';

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

type State = { tick: number; positions: { x: number; y: number }[]; needs: number[] };

async function state(page: Page): Promise<State> {
  return page.evaluate(() => {
    const w = window.__sim.world;
    return {
      tick: w.tick,
      positions: w.agents.map((a) => ({ ...a.pos })),
      needs: w.agents.map((a) => Math.round(a.needs.hunger * 1000)),
    };
  });
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

test('save to a slot, load it in another world: same tick and same positions', async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('cleared')) {
      localStorage.removeItem('sim.saves.v1');
      sessionStorage.setItem('cleared', '1');
    }
  });
  await open(page, '?seed=11&agents=5&paused');
  await page.evaluate(() => window.__sim.tick(437));
  const saved = await state(page);
  expect(saved.tick).toBe(437);

  await page.locator('.hud-save-btn').click();
  await expect(page.locator('#save-panel')).toBeVisible();
  await page.locator('.save-slot[data-slot="0"] .save-btn-save').click();
  await expect(page.locator('.save-slot[data-slot="0"]')).toContainText('Dzień 1, 14:17');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/ui-save-panel.png` });

  // a different world, paused (so the loaded game arrives paused too)
  await open(page, '?seed=99&agents=3&paused');
  expect(await page.evaluate(() => window.__sim.world.agents.length)).toBe(3);
  await page.keyboard.press('z');
  await expect(page.locator('#save-panel')).toBeVisible();
  await Promise.all([page.waitForURL(/tick=437/), page.locator('.save-slot[data-slot="0"] .save-btn-load').click()]);
  await page.waitForFunction(() => !!window.__sim);
  const loaded = await state(page);
  expect(loaded).toEqual(saved);
  expect(new URL(page.url()).searchParams.get('seed')).toBe('11');
  // the fingerprint matched: no mismatch warning
  await expect(page.locator('.ui-toast--warn')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('?tick= link replays to that moment (also via "Kopiuj link"), ~10k ticks quickly', async ({ page, context }) => {
  const errors = trackErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // reference: run the same world forward by hand
  await open(page, '?seed=5&agents=6&paused');
  await page.evaluate(() => window.__sim.tick(1234));
  const reference = await state(page);
  await page.locator('.hud-save-btn').click();
  await page.locator('.save-link').click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const url = new URL(link);
  expect(url.searchParams.get('seed')).toBe('5');
  expect(url.searchParams.get('agents')).toBe('6');
  expect(url.searchParams.get('tick')).toBe('1234');

  await open(page, `${url.search}&paused`);
  expect(await state(page)).toEqual(reference);
  await expect(page.locator('.ui-toast--warn')).toHaveCount(0);

  // a long replay shows progress and stays fast
  const t0 = Date.now();
  await page.goto('/?seed=5&agents=6&tick=10000&paused', { waitUntil: 'commit' });
  await expect(page.locator('.replay-overlay')).toBeVisible();
  await page.waitForFunction(() => !!window.__sim && window.__sim.world.tick === 10000, undefined, { timeout: 20_000 });
  const ms = Date.now() - t0;
  console.log(`replay of 10000 ticks incl. page load: ${ms} ms`);
  expect(ms).toBeLessThan(8000);
  await expect(page.locator('.replay-overlay')).toHaveCount(0);

  // progress overlay of a long replay (screenshot mid-way)
  await page.goto('/?seed=5&agents=6&tick=60000&paused', { waitUntil: 'commit' });
  await page.waitForFunction(() => parseInt(document.querySelector('.replay-overlay')?.getAttribute('aria-valuenow') ?? '0') >= 20);
  await page.screenshot({ path: `${SHOTS}/ui-replay.png` });
  await page.waitForFunction(() => window.__sim?.world.tick === 60000, undefined, { timeout: 30_000 });

  // ?hour= still works
  await open(page, '?seed=5&hour=9&paused');
  expect(await page.evaluate(() => window.__sim.world.tick)).toBe(120);
  expect(errors).toEqual([]);
});

test('stats panel: network, mood history and table are drawn', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page, '?seed=7&tick=3300&paused');
  await page.keyboard.press('t');
  const panel = page.locator('#stats-panel');
  await expect(panel).toBeVisible();
  await expect(page.locator('.hud-stats-btn')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(400);
  expect(await canvasColours(page, '.stats-net')).toBeGreaterThan(10);
  expect(await canvasColours(page, '.stats-chart')).toBeGreaterThan(10);
  const n = await page.evaluate(() => window.__sim.world.agents.length);
  await expect(panel.locator('.stats-table tbody tr')).toHaveCount(n);
  await expect(panel.locator('.stats-empty')).toBeHidden();

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

test('inspector shows memories (collapsible)', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page, '?seed=7&tick=2400&paused');
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

test('new world dialog starts a world with the chosen seed and residents', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page, '?seed=7&paused');
  await page.keyboard.press('n');
  const dialog = page.locator('.newworld');
  await expect(dialog).toBeVisible();
  // keys typed into the dialog do not reach the game
  await page.locator('#newworld-seed').fill('4242');
  await page.locator('#newworld-agents').fill('3');
  await page.screenshot({ path: `${SHOTS}/ui-newworld.png` });
  await Promise.all([page.waitForURL(/seed=4242/), dialog.locator('.newworld-start').click()]);
  await page.waitForFunction(() => !!window.__sim);
  expect(await page.evaluate(() => [window.__sim.world.seed, window.__sim.world.agents.length])).toEqual([4242, 3]);

  // help lists the new keys
  await page.keyboard.press('h');
  await expect(page.locator('.hud-help')).toContainText('statystyki');
  await expect(page.locator('.hud-help')).toContainText('nowy świat');
  expect(errors).toEqual([]);
});

test.describe('mobile 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('HUD fits; stats is a full-screen sheet; save panel fits', async ({ page }) => {
    const errors = trackErrors(page);
    await open(page, '?seed=7&tick=3300&paused');
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

    await page.locator('.hud-save-btn').tap();
    const save = (await page.locator('#save-panel').boundingBox())!;
    expect(save.x).toBeGreaterThanOrEqual(0);
    expect(save.x + save.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${SHOTS}/ui-mobile-save.png` });
    expect(errors).toEqual([]);
  });
});
