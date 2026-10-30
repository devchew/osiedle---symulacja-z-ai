import { expect, test, type Page } from '@playwright/test';

// Wave 10: live view of the server worlds, place switcher, resident links (#name), read-only
// diaries, phone layout, offline banner.
// Needs the live worlds on the preview server (server/worldsProxy.ts), pinned to a fixed time here;
// real ticking is covered by live-ticking.spec.ts (LIVE_SPEED=60 server).
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
  // the first frame built the world and the static layer; later frames must only update them
  await page.evaluate(() => {
    const w = window as unknown as { first: unknown };
    w.first = window.__sim.world;
  });
  await page.waitForFunction(() => window.__sim.renderer.staticBuilds >= 1);
  const builds = await page.evaluate(() => window.__sim.renderer.staticBuilds);
  const name = await page.evaluate(() => window.__sim.world.agents[0].name);
  await page.evaluate(() => window.__sim.select(window.__sim.world.agents[0].id));
  await page.keyboard.press('t');
  await expect(page.locator('#stats-panel')).toBeVisible();
  // the stream closes after each response: the client reconnects and gets the next frame
  await page.waitForFunction((t) => window.__sim.world.tick === t, next.meta.tick, { timeout: 20_000 });
  expect(await page.evaluate(() => window.__sim.world.agents[0].pos.x)).toBe(next.snapshot.agents[0].pos.x);
  // updated in place: the same World object, and no rebuild of the static layer
  expect(await page.evaluate(() => (window as unknown as { first: unknown }).first === window.__sim.world)).toBe(true);
  expect(await page.evaluate(() => window.__sim.renderer.staticBuilds)).toBe(builds);
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

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
const MOCK_CHRONICLE = {
  place: 'kamienica',
  tick: 600,
  days: [
    {
      date: TODAY,
      summary: 'Najważniejsze: 1 nowa para, 2 awarie, burza.',
      summarySource: 'procedural',
      total: 5,
      items: [
        { tick: 480, kind: 'couple', icon: '💕', text: 'Ola i Kuba są parą 💕', agentIds: [0, 1], weight: 1 },
        { tick: 520, kind: 'breakdown', icon: '🔧', text: 'Ewa naprawia lodówkę 🔧✨', agentIds: [2], weight: 0.5 },
        { tick: 560, kind: 'weather', icon: '⛈️', text: 'Nadciąga burza ⛈️', agentIds: [], weight: 0.5 },
      ],
    },
    {
      date: '2026-10-28',
      summary: 'Spokojny dzień nad jeziorem: wspólny grill i kilka drobnych napraw. Wieczorem wszyscy odpoczywają.',
      summarySource: 'ai',
      total: 2,
      items: [{ tick: 120, kind: 'together', icon: '🤝', text: 'Wspólny grill: Ola, Kuba, Ewa 🌭', agentIds: [0, 1, 2], weight: 0.5 }],
    },
  ],
};

test('chronicle panel: K opens it, days with summaries, Esc and other panels close it', async ({ page }) => {
  const errors = trackErrors(page);
  await page.route('**/api/live/kamienica/chronicle', (route) => route.fulfill({ json: MOCK_CHRONICLE }));
  await openLive(page, '/kamienica');
  const panel = page.locator('#chronicle-panel');
  await expect(panel).toBeHidden();
  await page.keyboard.press('k');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('aria-label', 'Kronika miejsca');
  await expect(panel.locator('.chr-day')).toHaveCount(2);
  await expect(panel.locator('.chr-day').first()).toContainText('Dziś');
  await expect(panel.locator('.chr-day').first()).toContainText('1 nowa para');
  await expect(panel.locator('.chr-day').nth(1)).toContainText('podsumowanie AI');
  await expect(panel.locator('.chr-item')).toHaveCount(4);
  await expect(page.locator('#hud .hud-chronicle-btn')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/live-chronicle.png` });

  // clicking the person marker selects the resident
  await panel.locator('.chr-item').first().locator('.chr-link[aria-label="Pokaż mieszkańca na mapie"]').click();
  await expect(page.locator('#inspector')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  // the panels close each other
  await page.keyboard.press('k');
  await expect(panel).toBeVisible();
  await page.keyboard.press('b');
  await expect(page.locator('#projects-panel')).toBeVisible();
  await expect(panel).toBeHidden();
  await page.keyboard.press('k');
  await expect(panel).toBeVisible();
  await expect(page.locator('#projects-panel')).toBeHidden();
  expect(errors).toEqual([]);
});

test('chronicle panel: real endpoint, empty state and error state; phone layout', async ({ page, request }) => {
  const res = await request.get('/api/live/akademik/chronicle');
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(data.place).toBe('akademik');
  expect(Array.isArray(data.days)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/live/akademik/chronicle', (route) => route.fulfill({ json: { place: 'akademik', tick: 1, days: [] } }));
  await openLive(page, '/akademik');
  await page.keyboard.press('k');
  const panel = page.locator('#chronicle-panel');
  await expect(panel).toContainText('Kronika jest jeszcze pusta');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await page.unroute('**/api/live/akademik/chronicle');

  await page.route('**/api/live/akademik/chronicle', (route) => route.fulfill({ json: { ...MOCK_CHRONICLE, place: 'akademik' } }));
  await page.keyboard.press('k');
  await expect(panel).toBeVisible();
  // the panel first shows the previous (empty) answer and swaps in the new one when it arrives
  await expect(panel.locator('.chr-day')).toHaveCount(2, { timeout: 10_000 });
  const box = await panel.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${SHOTS}/live-chronicle-mobile.png` });
  await page.keyboard.press('Escape');
  await page.unroute('**/api/live/akademik/chronicle');

  await page.route('**/api/live/akademik/chronicle', (route) => route.fulfill({ status: 503, json: { error: 'starting' } }));
  await page.keyboard.press('k');
  await expect(panel.locator('.chr-day')).toHaveCount(2); // keeps what it already showed
  expect(await page.locator('.chr-note').count()).toBe(0);
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
  // every HUD button is on screen
  for (const sel of ['#hud .hud-help-btn']) {
    const r = await page.locator(sel).boundingBox();
    expect(r && r.x >= 0 && r.x + r.width <= 390, sel).toBe(true);
  }
  await page.screenshot({ path: `${SHOTS}/live-mobile.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
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

test('replay: the button plays the recorded hours with a clear banner and leads back to live', async ({ page, request }) => {
  const errors = trackErrors(page);
  const raw = await request.get('/api/live/kamienica/replay');
  expect(raw.ok()).toBe(true);
  expect((await raw.body()).length).toBeLessThan(1_000_000);

  await openLive(page, '/kamienica');
  const liveTick = await page.evaluate(() => window.__sim.world.tick);
  const btn = page.locator('#hud .hud-replay-btn');
  await expect(btn).toBeVisible();
  await btn.click();

  const bar = page.locator('.ui-replay');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('POWTÓRKA');
  await expect(page.locator('body')).toHaveClass(/is-replay/);
  await expect(page.locator('#hud .hud-live-pill').first()).toBeHidden();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  const start = await page.evaluate(() => window.__sim.replay);
  expect(start).not.toBeNull();
  expect(start!.toTick - start!.fromTick).toBeGreaterThan(60);
  expect(start!.toTick).toBeLessThanOrEqual(liveTick);

  // it plays on its own, faster than real time
  await page.waitForFunction((t) => (window.__sim.replay?.tick ?? 0) >= t + 20, start!.fromTick, { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/live-replay.png` });

  // pause + scrub to the middle
  await bar.locator('.rp-play').click();
  await expect(bar.locator('.rp-play')).toHaveText('▶');
  const mid = Math.floor((start!.fromTick + start!.toTick) / 2);
  await bar.locator('.rp-range').fill(String(mid));
  await expect.poll(() => page.evaluate(() => window.__sim.replay?.tick)).toBe(mid);
  expect(await page.evaluate(() => window.__sim.world.tick)).toBe(mid);
  await expect(bar.locator('.rp-time')).toContainText('temu');

  await bar.locator('.rp-live').click();
  await expect(bar).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/is-replay/);
  await expect(page.locator('#hud .hud-live-pill').first()).toBeVisible();
  expect(await page.evaluate(() => window.__sim.replay)).toBeNull();
  expect(await page.evaluate(() => window.__sim.world.tick)).toBeGreaterThanOrEqual(liveTick);
  expect(errors).toEqual([]);
});

test('replay: an unavailable recording shows a notice and stays live', async ({ page }) => {
  await page.route('**/api/live/jezioro/replay', (route) => route.fulfill({ status: 503, json: { error: 'starting' } }));
  await openLive(page, '/jezioro');
  await page.locator('#hud .hud-replay-btn').click();
  await expect(page.locator('.ui-toast, [role="status"]').filter({ hasText: 'Powtórka jest niedostępna' }).first()).toBeVisible();
  await expect(page.locator('.ui-replay')).toBeHidden();
  await expect(page.locator('#hud .hud-replay-btn')).toHaveAttribute('aria-pressed', 'false');
});
