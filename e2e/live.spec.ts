import { expect, test, type Page } from '@playwright/test';

// Wave 10: live view of the server worlds, place switcher, resident links (#name), read-only
// diaries, sandbox fork ("Co będzie dalej?") with 8×, back to live, phone layout, offline banner.
// Needs the live worlds on the preview server (server/worldsProxy.ts); a second frame arrives
// quickly with LIVE_SPEED (e.g. 30 → a tick every 2 s), at speed 1 it takes up to a minute.
// Shots land in test-results/shots/live-*.png.

const SHOTS = 'test-results/shots';

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return errors;
}

async function openLive(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => window.__sim?.mode === 'live' && (window.__sim.frames ?? 0) >= 1, undefined, { timeout: 30_000 });
}

test.beforeAll(async ({ request }) => {
  const res = await request.get('/api/live/places');
  test.skip(!res.ok(), 'live worlds are not running on the preview server');
});

test('live view: place, clock, real-time HUD, no simulation controls', async ({ page }) => {
  const errors = trackErrors(page);
  await openLive(page, '/kamienica');
  const info = await page.evaluate(() => ({ seed: window.__sim.world.seed, place: window.__sim.place, agents: window.__sim.world.agents.length }));
  expect(info).toEqual({ seed: 1912, place: 'kamienica', agents: 8 });

  const hud = page.locator('#hud');
  await expect(hud).toContainText('Kamienica');
  await expect(hud).toContainText('NA ŻYWO');
  await expect(hud.locator('.hud-clock')).toHaveText(/^\d{1,2}:\d{2}$/);
  // read-only: no pause / speeds, no saves, no resident count, no AI toggle, no new-world dialog
  await expect(hud.locator('.hud-pause')).toBeHidden();
  await expect(hud.locator('.hud-speed')).toHaveCount(4);
  await expect(hud.locator('.hud-speed').first()).toBeHidden();
  await expect(page.locator('.hud-save-btn')).toHaveCount(0);
  await expect(page.locator('.llm-toggle')).toHaveCount(0);
  await expect(page.locator('#save-panel')).toHaveCount(0);
  await page.keyboard.press('n');
  await expect(page.locator('.ui-newworld, .nw-dialog, [aria-label="Nowy świat"]')).toHaveCount(0);

  // the place switcher with the four places
  await expect(page.locator('#places .place-card')).toHaveCount(4);
  await expect(page.locator('#places .place-card.is-current')).toHaveAttribute('data-place', 'kamienica');
  await expect(page.locator('#places .place-hl').first()).not.toBeEmpty({ timeout: 10_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/live-kamienica.png` });

  // the help popover speaks about the live view
  await page.keyboard.press('h');
  await expect(page.locator('#hud-help')).toContainText('na serwerze');
  await expect(page.locator('#hud-help')).not.toContainText('nowy świat');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('live view: next frames arrive from the server (LIVE_SPEED)', async ({ page, request }) => {
  test.setTimeout(150_000);
  // with LIVE_FIXED_TIME (the default e2e server) the worlds never tick: covered by the next test
  const tickOf = async () => ((await (await request.get('/api/live/dom/snapshot')).json()) as { meta: { tick: number } }).meta.tick;
  const a = await tickOf();
  await new Promise((r) => setTimeout(r, 5000));
  test.skip((await tickOf()) === a, 'live worlds do not tick on this server (LIVE_FIXED_TIME or speed 1)');
  const errors = trackErrors(page);
  await openLive(page, '/dom');
  const t0 = await page.evaluate(() => window.__sim.world.tick);
  await page.waitForFunction(() => (window.__sim.frames ?? 0) >= 2, undefined, { timeout: 130_000 });
  const t1 = await page.evaluate(() => window.__sim.world.tick);
  expect(t1).toBeGreaterThan(t0);
  await expect(page.locator('.ui-conn')).toBeHidden();
  expect(errors).toEqual([]);
});

test('live view: a new frame updates the world and keeps the selection and open panels', async ({ page, request }) => {
  const errors = trackErrors(page);
  // two frames of the real place in one SSE response: the current state, then the next minute
  const frame = await (await request.get('/api/live/jezioro/snapshot')).json();
  const next = JSON.parse(JSON.stringify(frame));
  next.meta.tick += 1;
  next.snapshot.tick += 1;
  next.snapshot.agents[0].pos = { ...next.snapshot.agents[0].pos, x: next.snapshot.agents[0].pos.x + 1 };
  let served = 0;
  await page.route('**/api/live/jezioro/stream', async (route) => {
    served++;
    const body = served === 1 ? `event: frame\ndata: ${JSON.stringify(frame)}\n\n` : `event: frame\ndata: ${JSON.stringify(next)}\n\n`;
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body });
  });
  await openLive(page, '/jezioro');
  const name = await page.evaluate(() => window.__sim.world.agents[0].name);
  await page.evaluate(() => window.__sim.select(window.__sim.world.agents[0].id));
  await page.keyboard.press('t');
  await expect(page.locator('#stats-panel')).toBeVisible();
  // the stream closes after each response: the client reconnects and gets the next frame
  await page.waitForFunction((t) => window.__sim.world.tick === t, next.meta.tick, { timeout: 20_000 });
  expect(await page.evaluate(() => window.__sim.world.agents[0].pos.x)).toBe(next.snapshot.agents[0].pos.x);
  await expect(page.locator('#inspector .insp-name')).toHaveText(name);
  await expect(page.locator('#stats-panel')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#${encodeURIComponent(name)}$`));
  expect(errors.filter((e) => !/Failed to load resource|EventSource/.test(e))).toEqual([]);
});

test('place switcher changes the URL and the world without a reload', async ({ page }) => {
  const errors = trackErrors(page);
  await openLive(page, '/dom');
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 42));
  await page.locator('#places [data-place="akademik"]').click();
  await expect(page).toHaveURL(/\/akademik$/);
  await page.waitForFunction(() => window.__sim.world.seed === 1702, undefined, { timeout: 20_000 });
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(42);
  await expect(page.locator('#hud')).toContainText('Akademik');
  await expect(page.locator('#places .place-card.is-current')).toHaveAttribute('data-place', 'akademik');
  expect(await page.title()).toContain('Akademik');

  // back button returns to the previous place
  await page.goBack();
  await expect(page).toHaveURL(/\/dom$/);
  await page.waitForFunction(() => window.__sim.world.seed === 2026, undefined, { timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('#name selects a resident; diary opens read-only', async ({ page }) => {
  const errors = trackErrors(page);
  await openLive(page, '/jezioro');
  const name = await page.evaluate(() => window.__sim.world.agents[1].name);

  await page.goto(`/jezioro#${encodeURIComponent(name.toLowerCase())}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) >= 1, undefined, { timeout: 30_000 });
  await expect(page.locator('#inspector')).toBeVisible();
  await expect(page.locator('#inspector .insp-name')).toHaveText(name);
  // the hash is normalised to the resident's name
  await expect(page).toHaveURL(new RegExp(`#${encodeURIComponent(name)}$`));

  // clicking elsewhere / Esc clears the hash
  await page.locator('#inspector .insp-diary-btn').click();
  const diary = page.locator('#diary-panel');
  await expect(diary).toBeVisible();
  await expect(diary).toContainText(`Pamiętnik: ${name}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/live-diary.png` });
  await page.keyboard.press('Escape');
  await expect(diary).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#inspector')).toBeHidden();
  await expect(page).toHaveURL(/\/jezioro$/);
  expect(errors).toEqual([]);
});

test('sandbox: fork the live world, run it at 8×, survive a reload, back to live', async ({ page }) => {
  const errors = trackErrors(page);
  await openLive(page, '/kamienica');
  const liveTick = await page.evaluate(() => window.__sim.world.tick);

  await page.locator('#places .places-fork').click();
  await expect(page).toHaveURL(/\/sandbox\?from=kamienica$/);
  await page.waitForFunction(() => window.__sim?.mode === 'sandbox', undefined, { timeout: 30_000 });
  const bar = page.locator('#sandbox-bar');
  await expect(bar).toContainText('Symulacja w Twojej przeglądarce — świat na żywo toczy się dalej bez zmian');
  await expect(bar).toContainText('Kamienica');
  const fork = await page.evaluate(() => ({ seed: window.__sim.world.seed, tick: window.__sim.world.tick }));
  expect(fork.seed).toBe(1912);
  expect(fork.tick).toBeGreaterThanOrEqual(liveTick);

  // time controls: 8× (key 4)
  const hud = page.locator('#hud');
  await expect(hud.locator('.hud-pause')).toBeVisible();
  await page.keyboard.press('4');
  await expect(hud.locator('.hud-speed').nth(3)).toHaveClass(/is-active/);
  await page.waitForTimeout(2500);
  const ran = await page.evaluate(() => window.__sim.world.tick);
  expect(ran - fork.tick).toBeGreaterThan(40);
  await expect(page.locator('.hud-save-btn')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/live-sandbox.png` });

  // the copy lives in sessionStorage: a reload continues it
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => window.__sim.world.tick);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.reload();
  await page.waitForFunction(() => window.__sim?.mode === 'sandbox', undefined, { timeout: 30_000 });
  const after = await page.evaluate(() => window.__sim.world.tick);
  expect(after).toBeGreaterThanOrEqual(before);

  // the live world was not touched
  const placeTick = await page.evaluate(async () => (await (await fetch('/api/live/places')).json()).find((p: { id: string }) => p.id === 'kamienica').tick);
  expect(placeTick).toBeLessThan(after);

  await bar.getByText('↩ Wróć na żywo').click();
  await expect(page).toHaveURL(/\/kamienica$/);
  await page.waitForFunction(() => window.__sim?.mode === 'live' && (window.__sim.frames ?? 0) >= 1, undefined, { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test('phone layout: place tabs, HUD and log fit the screen', async ({ page }) => {
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openLive(page, '/akademik');
  await page.waitForTimeout(600);
  const boxes = await page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    return { hud: r('#hud'), places: r('#places'), log: r('#log'), scrollW: document.documentElement.scrollWidth };
  });
  expect(boxes.scrollW).toBeLessThanOrEqual(390);
  expect(boxes.hud.right).toBeLessThanOrEqual(390);
  expect(boxes.places.top).toBeGreaterThanOrEqual(boxes.hud.bottom - 1);
  expect(boxes.places.right).toBeLessThanOrEqual(390);
  expect(boxes.log.top).toBeGreaterThan(boxes.places.bottom);
  // every HUD button and the fork button are on screen
  for (const sel of ['#hud .hud-help-btn', '#places .places-fork']) {
    const r = await page.locator(sel).boundingBox();
    expect(r && r.x >= 0 && r.x + r.width <= 390, sel).toBe(true);
  }
  await page.screenshot({ path: `${SHOTS}/live-mobile.png` });

  await page.locator('#places .places-fork').click();
  await page.waitForFunction(() => window.__sim?.mode === 'sandbox', undefined, { timeout: 30_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/live-mobile-sandbox.png` });
  const sb = await page.evaluate(() => {
    const r = document.querySelector('#sandbox-bar')!.getBoundingClientRect();
    return { right: r.right, scrollW: document.documentElement.scrollWidth };
  });
  expect(sb.right).toBeLessThanOrEqual(390);
  expect(sb.scrollW).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
});

test('no connection: offline banner, then the world appears when the server answers', async ({ page }) => {
  let block = true;
  await page.route('**/api/live/*/stream', (route) => (block ? route.fulfill({ status: 503, body: 'down' }) : route.continue()));
  await page.goto('/dom');
  await expect(page.locator('.ui-conn')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.ui-conn')).toContainText('Łączenie z osiedlem…');
  await page.screenshot({ path: `${SHOTS}/live-offline.png` });
  block = false;
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) >= 1, undefined, { timeout: 30_000 });
  await expect(page.locator('.ui-conn')).toBeHidden();
});
