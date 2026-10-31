import { expect, test, type Page } from '@playwright/test';

// Accessibility (#15): keyboard selection, the screen-reader resident list, Polish labels,
// focus handling of panels, high-contrast and reduced-motion styles. Screenshots: test-results/shots/a11y-*.png.

const SHOTS = 'test-results/shots';

async function openLive(page: Page, path = '/kamienica'): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => window.__sim?.mode === 'live' && (window.__sim.frames ?? 0) >= 1, undefined, { timeout: 30_000 });
  await page.waitForSelector('.a11y-resident');
}

test.beforeAll(async ({ request }) => {
  const res = await request.get('/api/live/places');
  test.skip(!res.ok(), 'live worlds are not running on the preview server');
});

test('screen reader: labelled map, HUD buttons and resident list with activities', async ({ page }) => {
  await openLive(page);
  await expect(page.locator('#world')).toHaveAttribute('role', 'img');
  await expect(page.locator('#world')).toHaveAttribute('aria-label', /Mapa osiedla/);

  const unnamed = await page.$$eval('#hud button', (bs) => bs.filter((b) => !b.getAttribute('aria-label') && !b.textContent?.trim()).length);
  expect(unnamed).toBe(0);
  await expect(page.locator('.hud-help-btn')).toHaveAttribute('aria-label', 'Sterowanie (H)');
  await expect(page.locator('.hud-speed').first()).toHaveAttribute('aria-label', /Prędkość 1×/);

  const agents = await page.evaluate(() => window.__sim.world.agents.map((a) => a.name));
  const buttons = page.locator('.a11y-resident');
  await expect(buttons).toHaveCount(agents.length);
  for (const [i, name] of agents.entries()) await expect(buttons.nth(i)).toContainText(new RegExp(`^${name}( \\(gość\\))? — `));
  await expect(page.locator('#a11y-digest')).toContainText(/^Godzina \d{1,2}:\d{2}\./);
  await expect(page.locator('#a11y-digest')).toHaveAttribute('aria-live', 'polite');
});

test('keyboard: skip link, resident list, selection and cycling', async ({ page }) => {
  await openLive(page);
  await page.keyboard.press('Tab');
  const skip = page.locator('.a11y-skip');
  await expect(skip).toBeFocused();
  await page.screenshot({ path: `${SHOTS}/a11y-skip-link.png` });
  await page.keyboard.press('Enter');
  const first = page.locator('.a11y-resident').first();
  await expect(first).toBeFocused();
  expect(page.url()).not.toContain('#');
  await page.screenshot({ path: `${SHOTS}/a11y-resident-list.png` });

  await page.keyboard.press('Enter');
  const name = await page.evaluate(() => window.__sim.world.agents[0].name);
  await expect(page.locator('#inspector')).toBeVisible();
  await expect(page.locator('#inspector')).toContainText(name);
  await expect(first).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('Escape');
  await expect(page.locator('#inspector')).toBeHidden();
  await expect(first).toHaveAttribute('aria-pressed', 'false');

  // [ / ] step through the residents from anywhere
  await page.locator('#world').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(']');
  await expect(page.locator('.a11y-resident[aria-pressed="true"]')).toHaveCount(1);
  const a = await page.locator('.a11y-resident[aria-pressed="true"]').textContent();
  await page.keyboard.press(']');
  await expect.poll(() => page.locator('.a11y-resident[aria-pressed="true"]').textContent()).not.toBe(a);
  await page.keyboard.press('[');
  await expect.poll(() => page.locator('.a11y-resident[aria-pressed="true"]').textContent()).toBe(a);
});

test('keyboard: place switcher, panels take and return focus', async ({ page }) => {
  await openLive(page);
  const card = page.locator('#places .place-card[data-place="jezioro"]');
  await card.focus();
  await expect(card).toBeFocused();
  await page.screenshot({ path: `${SHOTS}/a11y-focus-place.png` });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/jezioro$/);
  await expect(page.locator('#places .place-card.is-current')).toHaveAttribute('data-place', 'jezioro');

  const statsBtn = page.locator('.hud-stats-btn');
  await statsBtn.focus();
  await page.keyboard.press('Enter');
  const panel = page.locator('.ui-stats');
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();
  await page.screenshot({ path: `${SHOTS}/a11y-panel-focus.png` });
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(statsBtn).toBeFocused();
});

test('high contrast and reduced motion styles apply', async ({ page }) => {
  await page.emulateMedia({ contrast: 'more', reducedMotion: 'reduce' });
  await openLive(page);
  const css = await page.evaluate(() => ({
    text: getComputedStyle(document.documentElement).getPropertyValue('--ui-text').trim(),
    border: getComputedStyle(document.documentElement).getPropertyValue('--ui-border').trim(),
    blur: getComputedStyle(document.getElementById('hud')!).backdropFilter,
    transition: getComputedStyle(document.querySelector('.place-card')!).transitionDuration,
  }));
  expect(css.text).toMatch(/^#(fff|ffffff)$/);
  expect(css.border).toMatch(/^#(fff|ffffff)$/);
  expect(css.blur).toBe('none');
  expect(parseFloat(css.transition)).toBeLessThan(0.001);
  await page.keyboard.press('t');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/a11y-high-contrast.png` });
});
