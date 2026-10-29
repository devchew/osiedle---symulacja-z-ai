import { expect, test, type Page } from '@playwright/test';

// Wave 9: building projects — the gazebo under construction (site, progress badge, panel under B),
// a stage change toast, and the finished gazebo. Shots land in test-results/shots/project-*.png.

const SHOTS = 'test-results/shots';
const DAY = 24 * 60;
/** day 7, 12:00 — the gazebo of seed 1 is well under way */
const MID_TICK = 6 * DAY + 5 * 60;
/** day 17, 12:00 — usually finished by then (the test ticks on if not) */
const LATE_TICK = 16 * DAY + 5 * 60;

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return errors;
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => !!window.__sim?.projects, undefined, { timeout: 45_000 });
}

/** zooms the camera in on the gazebo (wheel at its screen position) */
async function zoomToGazebo(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const p = await page.evaluate(() => {
      const g = window.__sim.projectList().find((x) => x.kindId === 'altana')!;
      return window.__sim.renderer.toScreen(g.pos.x + 1, g.pos.y + 1);
    });
    await page.mouse.move(p.x, p.y);
    await page.mouse.wheel(0, -160);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(500);
}

test('mid-construction: the site, the progress badge, the panel (B) and a stage toast', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page, `?seed=1&tick=${MID_TICK}&paused`);
  const p = await page.evaluate(() => window.__sim.projectList()[0]);
  expect(p, 'a project was proposed').toBeDefined();
  expect(p.kindId).toBe('altana');
  expect(p.status).toBe('building');
  expect(p.progress).toBeGreaterThan(0);
  const type = await page.evaluate((uid) => window.__sim.world.objects.find((o) => o.uid === uid)!.type, p.uid);
  expect(type.startsWith('altana_')).toBe(true);

  // HUD button and help entry
  const btn = page.locator('.hud-projects-btn');
  await expect(btn).toBeVisible();
  await page.locator('.hud-help-btn').click();
  await expect(page.locator('#hud-help')).toContainText('projekty budowlane');
  await page.locator('.hud-help-btn').click();

  // panel via the B key
  await page.keyboard.press('b');
  const panel = page.locator('#projects-panel');
  await expect(panel).toBeVisible();
  await expect(btn).toHaveClass(/is-active/);
  await expect(panel.locator('.proj-card--active .proj-name')).toHaveText('Altana w ogrodzie');
  await expect(panel.locator('.proj-card--active .proj-pct')).toHaveText(`${Math.floor(p.progress * 100)}%`);
  await expect(panel.locator('.proj-stage--current')).toHaveCount(1);
  await expect(panel.locator('.proj-stage--current')).toHaveText(p.stageLabel);
  expect(await panel.locator('.proj-crew-row').count()).toBe(p.contributors.length);
  expect(p.contributors.length).toBeGreaterThan(0);
  await expect(panel.locator('.proj-log li').first()).toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/project-panel.png` });

  // B again closes it
  await page.keyboard.press('b');
  await expect(panel).toBeHidden();

  // the site up close, with the badge above it
  await zoomToGazebo(page);
  await page.screenshot({ path: `${SHOTS}/project-site.png` });

  // on to the next stage: a toast announces it
  const stage0 = p.stage;
  const reached = await page.evaluate((s0) => {
    for (let i = 0; i < 12 * 24; i++) {
      window.__sim.tick(60);
      if (window.__sim.projectList()[0].stage > s0) return true;
    }
    return false;
  }, stage0);
  expect(reached, 'the next stage within 12 days').toBe(true);
  await expect(page.locator('.ui-toast').filter({ hasText: /czas na|gotowa/ }).first()).toBeVisible({ timeout: 3000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/project-stage.png` });

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the finished gazebo: drawn in the garden, listed as finished, people use it', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page, `?seed=1&tick=${LATE_TICK}&paused`);
  const done = await page.evaluate(() => {
    for (let i = 0; i < 10 * 24; i++) {
      const g = window.__sim.projectList().find((x) => x.kindId === 'altana');
      if (g?.status === 'done') return true;
      window.__sim.tick(60);
    }
    return false;
  });
  expect(done, 'the gazebo gets finished').toBe(true);
  // move to a sunny-ish afternoon so the garden is busy
  await page.evaluate(() => {
    const now = window.__sim.world.tick;
    const minuteOfDay = (now + 7 * 60) % (24 * 60);
    window.__sim.tick((24 * 60 + 16 * 60 - minuteOfDay) % (24 * 60));
  });
  const g = await page.evaluate(() => window.__sim.projectList().find((x) => x.kindId === 'altana')!);
  const type = await page.evaluate((uid) => window.__sim.world.objects.find((o) => o.uid === uid)!.type, g.uid);
  expect(type).toBe('altana');

  await page.keyboard.press('b');
  const panel = page.locator('#projects-panel');
  await expect(panel.locator('.proj-card--done .proj-name').first()).toContainText('Altana');
  expect(await panel.locator('.proj-card--done .proj-person').count()).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/project-done-panel.png` });
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  await zoomToGazebo(page);
  await page.screenshot({ path: `${SHOTS}/project-gazebo.png` });

  // the log mentions the crew
  const log = await page.evaluate(() => window.__sim.world.events.map((e) => e.text).join('\n'));
  const all = await page.evaluate(() => window.__sim.projectList().flatMap((p) => p.milestones.map((m) => m.text)).join('\n'));
  expect(`${log}\n${all}`).toContain('Altana gotowa! Ekipa:');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the vegetable garden comes next (a second, smaller project)', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page, `?seed=1&tick=${LATE_TICK}&paused`);
  const ok = await page.evaluate(() => {
    for (let i = 0; i < 14 * 24; i++) {
      const v = window.__sim.projectList().find((x) => x.kindId === 'warzywnik');
      if (v && v.progress > 0.4) return true;
      window.__sim.tick(60);
    }
    return false;
  });
  expect(ok, 'the vegetable garden is under way').toBe(true);
  const v = await page.evaluate(() => window.__sim.projectList().find((x) => x.kindId === 'warzywnik')!);
  for (let i = 0; i < 4; i++) {
    const p = await page.evaluate((pos) => window.__sim.renderer.toScreen(pos.x + 1, pos.y + 0.5), v.pos);
    await page.mouse.move(p.x, p.y);
    await page.mouse.wheel(0, -160);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/project-warzywnik.png` });
  await page.keyboard.press('b');
  await expect(page.locator('#projects-panel .proj-card--active .proj-name')).toHaveText('Warzywnik');
  await expect(page.locator('#projects-panel .proj-card--done .proj-name').first()).toContainText('Altana');
  expect(errors, errors.join('\n')).toEqual([]);
});
