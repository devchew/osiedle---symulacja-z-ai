import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Wave 8: residents' diaries — inspector entry point, overview (P), notebook view, .txt export.
// Shots land in test-results/shots/diary-*.png.

const SHOTS = 'test-results/shots';

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return errors;
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/lab${query}`);
  await page.waitForFunction(() => !!window.__sim?.diary, undefined, { timeout: 30_000 });
}

/** resident with the most diary entries (ties: lowest id) */
async function writer(page: Page): Promise<{ id: number; name: string; count: number }> {
  return page.evaluate(() => {
    const s = window.__sim;
    const rows = s.world.agents.map((a) => ({ id: a.id, name: a.name, count: s.diary.entryCount(a.id) }));
    rows.sort((x, y) => y.count - x.count || x.id - y.id);
    return rows[0];
  });
}

test('day 1 evening: inspector opens the diary with a written entry; download and overview work', async ({ page }) => {
  const errors = trackErrors(page);
  // tick 1000 = day 1, 23:40 — everyone has gone to bed and written about the day
  await open(page, '?seed=7&tick=1000&paused');
  const w = await writer(page);
  expect(w.count, 'someone wrote a diary entry on day 1').toBeGreaterThan(0);

  // the HUD button shows unread entries
  await expect(page.locator('.hud-diary-btn')).toHaveClass(/has-badge/);

  await page.evaluate((id) => window.__sim.select(id), w.id);
  const entry = page.locator('#inspector .insp-diary-btn');
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('Pamiętnik');
  await expect(entry).toHaveClass(/has-badge/);
  await entry.click();

  const panel = page.locator('#diary-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.diary-title')).toContainText(w.name);
  await expect(panel.locator('.diary-page-day')).toHaveText('Dzień 1');
  await expect(panel.locator('.diary-page-when')).toContainText(/\d\d:\d\d/);
  await expect(panel.locator('.diary-day')).toHaveCount(w.count);
  const paragraphs = panel.locator('.diary-text p');
  expect(await paragraphs.count()).toBeGreaterThan(0);
  const text = (await panel.locator('.diary-text').innerText()).trim();
  expect(text.length, 'entry text is not empty').toBeGreaterThan(40);
  // the inspector badge is cleared once read
  await expect(entry).not.toHaveClass(/has-badge/);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/diary-desktop.png` });

  // export via formatDiary
  const [download] = await Promise.all([page.waitForEvent('download'), panel.locator('.diary-download').click()]);
  expect(download.suggestedFilename()).toMatch(/^pamietnik-[a-z0-9-]+-seed7-dzien1\.txt$/);
  const file = await readFile((await download.path())!, 'utf8');
  expect(file.length).toBeGreaterThan(40);
  expect(file).toContain(w.name);

  // overview: every resident listed, latest entries shown, the read one has no unread dot
  await panel.locator('.diary-back').click();
  const n = await page.evaluate(() => window.__sim.world.agents.length);
  const items = panel.locator('.diary-ov-item');
  await expect(items).toHaveCount(n);
  const mine = panel.locator(`.diary-ov-item[data-agent="${w.id}"]`);
  await expect(mine).toContainText('Dzień 1');
  expect((await mine.locator('.diary-ov-snippet').innerText()).length).toBeGreaterThan(20);
  await expect(mine.locator('.diary-unread')).toHaveCount(0);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/diary-overview.png` });

  // overview "download all"
  const [all] = await Promise.all([page.waitForEvent('download'), panel.locator('.diary-download').click()]);
  expect(all.suggestedFilename()).toMatch(/^pamietnik-wszyscy-seed7-dzien1\.txt$/);

  // Esc closes the diary but keeps the inspector open; P toggles the overview
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.locator('#inspector')).toBeVisible();
  await page.keyboard.press('p');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.diary-overview')).toBeVisible();
  await page.keyboard.press('p');
  await expect(panel).toBeHidden();

  // the help popover lists the key
  await page.keyboard.press('h');
  await expect(page.locator('#hud-help')).toContainText('pamiętniki');
  await page.keyboard.press('h');

  expect(errors).toEqual([]);
});

test('day 2: new entry toast, unread dot, ← / → switch days without panning the camera', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page, '?seed=7&tick=1000&paused');
  const w = await writer(page);
  await page.evaluate((id) => window.__sim.diary.openFor(id), w.id);
  await page.keyboard.press('Escape');

  // through day 2's evening (synchronous ticks: the UI picks up onDiaryChange)
  await page.evaluate(() => window.__sim.tick(1440));
  await expect(page.locator('.ui-toast', { hasText: '📔' }).first()).toBeVisible({ timeout: 5000 });
  const count = await page.evaluate((id) => window.__sim.diary.entryCount(id), w.id);
  expect(count).toBeGreaterThan(1);
  await expect.poll(() => page.evaluate((id) => window.__sim.diary.hasUnread(id), w.id)).toBe(true);

  await page.evaluate((id) => window.__sim.diary.openFor(id), w.id);
  const panel = page.locator('#diary-panel');
  const last = await page.evaluate((id) => window.__sim.diary.entryCount(id), w.id);
  await expect(panel.locator('.diary-pos')).toHaveText(`${last} / ${last}`);
  await expect(panel.locator('.diary-next')).toBeDisabled();
  const camBefore = await page.evaluate(() => JSON.stringify(window.__sim.renderer.toScreen(0, 0)));

  await page.keyboard.press('ArrowLeft');
  await expect(panel.locator('.diary-pos')).toHaveText(`${last - 1} / ${last}`);
  await expect(panel.locator('.diary-next')).toBeEnabled();
  await page.keyboard.press('ArrowRight');
  await expect(panel.locator('.diary-pos')).toHaveText(`${last} / ${last}`);
  // days list: newest first; clicking the oldest goes to day 1
  await panel.locator('.diary-day').last().click();
  await expect(panel.locator('.diary-page-day')).toHaveText('Dzień 1');
  await expect(panel.locator('.diary-prev')).toBeDisabled();
  expect(await page.evaluate(() => JSON.stringify(window.__sim.renderer.toScreen(0, 0)))).toBe(camBefore);
  expect(errors).toEqual([]);
});

test('empty diary at the start of the day', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page, '?seed=7&paused');
  const name = await page.evaluate(() => {
    window.__sim.select(window.__sim.world.agents[0].id);
    return window.__sim.world.agents[0].name;
  });
  await expect(page.locator('#inspector .insp-diary-btn')).toContainText('pusty');
  await page.locator('#inspector .insp-diary-btn').click();
  const panel = page.locator('#diary-panel');
  await expect(panel.locator('.diary-empty')).toHaveText(
    `Pamiętnik jest jeszcze pusty — pierwszy wpis pojawi się wieczorem, gdy ${name} pójdzie spać.`,
  );
  await expect(panel.locator('.diary-download')).toBeDisabled();
  await panel.locator('.diary-back').click();
  await expect(panel.locator('.diary-ov-snippet--empty').first()).toContainText('Jeszcze nic nie napisano');
  await expect(page.locator('.hud-diary-btn')).not.toHaveClass(/has-badge/);
  expect(errors).toEqual([]);
});

test('mobile: the diary is a full-screen sheet with readable text', async ({ page }) => {
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '?seed=7&tick=1000&paused');
  const w = await writer(page);
  expect(w.count).toBeGreaterThan(0);
  await page.evaluate((id) => window.__sim.select(id), w.id);
  await page.locator('#inspector .insp-diary-btn').click();
  const panel = page.locator('#diary-panel');
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeLessThanOrEqual(0.5);
  expect(box.y).toBeLessThanOrEqual(0.5);
  expect(box.width).toBeGreaterThanOrEqual(389);
  expect(box.height).toBeGreaterThanOrEqual(843);
  const fontSize = await panel.locator('.diary-text p').first().evaluate((p) => parseFloat(getComputedStyle(p).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);
  // no horizontal overflow of the page itself
  const overflow = await panel.locator('.diary-page').evaluate((p) => p.scrollWidth - p.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/diary-mobile.png` });

  await panel.locator('.diary-back').click();
  await expect(panel.locator('.diary-ov-item')).not.toHaveCount(0);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/diary-mobile-overview.png` });
  expect(errors).toEqual([]);
});
