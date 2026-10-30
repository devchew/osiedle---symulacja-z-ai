import { expect, test, type Page } from '@playwright/test';
import type { World } from '../src/types';
import { projectsOf } from '../src/world/projects';
import { SHOTS, mockLive, openLive, trackErrors } from './support/live';
import { DAY, frameFor, timelineOf, tickAt } from './support/worldFixtures';

// Building projects in the live view (fixture world from e2e/support): the gazebo under construction
// (site, progress badge, panel under B), a stage change toast, the finished gazebo, the vegetable
// garden. How projects progress is tested headlessly in tests/projects.test.ts; here only what the
// browser shows. Shots land in test-results/shots/project-*.png.

const DOM = { place: 'dom' } as const;
const timeline = timelineOf(DOM);
const gazebo = (w: World) => projectsOf(w).find((x) => x.kindId === 'altana');

/** zooms the camera in on the site of a project of `kindId` (wheel at its screen position) */
async function zoomTo(page: Page, kindId: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const p = await page.evaluate((kind) => {
      const g = window.__sim.projectList().find((x) => x.kindId === kind)!;
      return window.__sim.renderer.toScreen(g.pos.x + 1, g.pos.y + 1);
    }, kindId);
    await page.mouse.move(p.x, p.y);
    await page.mouse.wheel(0, -160);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(500);
}

test('mid-construction: the site, the progress badge, the panel (B) and a stage toast', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackErrors(page);
  // the gazebo a little over a third done; later the moment the next stage starts
  const mid = timeline.findTick((w) => (gazebo(w)?.progress ?? 0) > 0.35 && gazebo(w)?.status === 'building', { step: 60 });
  const stage0 = gazebo(timeline.advanceTo(mid))!.stage;
  const nextStage = timeline.findTick((w) => gazebo(w)!.stage > stage0, { from: mid, step: 30 });
  const live = await mockLive(page, frameFor(DOM, mid));
  await openLive(page, '/dom');
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
  await zoomTo(page, 'altana');
  await page.screenshot({ path: `${SHOTS}/project-site.png` });

  // the frame of the next stage: a toast announces it
  await live.push(frameFor(DOM, nextStage));
  await expect(page.locator('.ui-toast').filter({ hasText: /czas na|gotowa/ }).first()).toBeVisible({ timeout: 3000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/project-stage.png` });

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the finished gazebo: drawn in the garden, listed as finished, people use it', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackErrors(page);
  const done = timeline.findTick((w) => gazebo(w)?.status === 'done', { step: 60 });
  // a sunny-ish afternoon after it was finished, so the garden is busy
  const afternoon = done + (((tickAt(16) - done) % DAY) + DAY) % DAY + DAY;
  await mockLive(page, frameFor(DOM, afternoon));
  await openLive(page, '/dom');
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

  await zoomTo(page, 'altana');
  await page.screenshot({ path: `${SHOTS}/project-gazebo.png` });

  // the log mentions the crew
  const log = await page.evaluate(() => window.__sim.world.events.map((e) => e.text).join('\n'));
  const all = await page.evaluate(() => window.__sim.projectList().flatMap((p) => p.milestones.map((m) => m.text)).join('\n'));
  expect(`${log}\n${all}`).toContain('Altana gotowa! Ekipa:');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the vegetable garden comes next (a second, smaller project)', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackErrors(page);
  const garden = timeline.findTick((w) => (projectsOf(w).find((x) => x.kindId === 'warzywnik')?.progress ?? 0) > 0.4, { step: 60 });
  await mockLive(page, frameFor(DOM, garden));
  await openLive(page, '/dom');
  await zoomTo(page, 'warzywnik');
  await page.screenshot({ path: `${SHOTS}/project-warzywnik.png` });
  await page.keyboard.press('b');
  await expect(page.locator('#projects-panel .proj-card--active .proj-name')).toHaveText('Warzywnik');
  await expect(page.locator('#projects-panel .proj-card--done .proj-name').first()).toContainText('Altana');
  expect(errors, errors.join('\n')).toEqual([]);
});

/** drags a project's footprint to the middle of the screen, then zooms in on it */
async function centreAndZoom(page: Page, kindId: string): Promise<void> {
  const where = (k: string) =>
    page.evaluate((id) => {
      const g = window.__sim.projectList().find((x) => x.kindId === id)!;
      return window.__sim.renderer.toScreen(g.pos.x + (g.size.w - 1) / 2, g.pos.y + (g.size.h - 1) / 2);
    }, k);
  await page.evaluate(() => window.__sim.renderer.fitView());
  await page.waitForTimeout(200);
  const from = await where(kindId);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(700, 450, { steps: 10 });
  await page.mouse.up();
  for (let i = 0; i < 4; i++) {
    const p = await where(kindId);
    await page.mouse.move(p.x, p.y);
    await page.mouse.wheel(0, -160);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(500);
}

test('tree house and pier: every stage is drawn, the pier stands on the pond', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = trackErrors(page);
  const spec = { place: 'dom', seed: 1 } as const;
  const tl = timelineOf(spec);
  const project = (w: World, kindId: string) => projectsOf(w).find((x) => x.kindId === kindId);
  // every frame of the run in Node (the timeline moves forward only): per project proposed, each stage reached, finished
  const plan = ['domek_na_drzewie', 'pomost'].map((kindId) => {
    const proposed = tl.findTick((w) => !!project(w, kindId), { step: 30, maxTicks: 70 * DAY });
    const stages = project(tl.advanceTo(proposed), kindId)!.stages.length;
    expect(stages, `${kindId} is proposed`).toBeGreaterThan(0);
    const ticks: number[] = [];
    for (let stage = 0, from = proposed; stage <= stages; stage++) {
      from = tl.findTick((w) => project(w, kindId)!.stage >= stage, { from, step: 30 });
      ticks.push(from);
    }
    return { kindId, proposed, ticks };
  });

  const live = await mockLive(page, frameFor(spec, plan[0].proposed));
  await openLive(page, '/dom');
  for (const { kindId, proposed, ticks } of plan) {
    await live.push(frameFor(spec, proposed));
    // one shot per stage and one of the finished building
    for (const tick of ticks) {
      await live.push(frameFor(spec, tick));
      const type = await page.evaluate((k) => {
        const p = window.__sim.projectList().find((x) => x.kindId === k)!;
        return window.__sim.world.objects.find((o) => o.uid === p.uid)!.type;
      }, kindId);
      await centreAndZoom(page, kindId);
      await page.screenshot({ path: `${SHOTS}/project-${type}.png` });
      const c = await page.evaluate((k) => {
        const g = window.__sim.projectList().find((x) => x.kindId === k)!;
        return window.__sim.renderer.toScreen(g.pos.x + (g.size.w - 1) / 2, g.pos.y + (g.size.h - 1) / 2);
      }, kindId);
      await page.screenshot({
        path: `${SHOTS}/crop-${type}.png`,
        clip: { x: Math.max(0, c.x - 200), y: Math.max(0, c.y - 170), width: 400, height: 340 },
      });
    }
    const p = await page.evaluate((k) => window.__sim.projectList().find((x) => x.kindId === k)!, kindId);
    expect(p.status).toBe('done');
  }
  expect(errors, errors.join('\n')).toEqual([]);
});
