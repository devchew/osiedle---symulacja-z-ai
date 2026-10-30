import { expect, test } from '@playwright/test';
import { SHOTS, mockLive, openLive, trackErrors } from './support/live';
import { frameFor, tickAt } from './support/worldFixtures';

// The live view of a fixture world (e2e/support): rendering, the clock following the frames,
// picking a resident, day / evening / night looks. Shots land in test-results/shots/.

const DOM = { place: 'dom' } as const;

async function agentPositions(page: import('@playwright/test').Page): Promise<{ x: number; y: number }[]> {
  return page.evaluate(() => window.__sim.world.agents.map((a) => ({ ...a.pos })));
}

test('the world renders and the next frame moves the clock and the residents', async ({ page }) => {
  const errors = trackErrors(page);
  const t0 = tickAt(10);
  const live = await mockLive(page, frameFor(DOM, t0));
  await openLive(page, '/dom');
  await page.waitForTimeout(1500);

  // canvas is drawn: many distinct colours in a sample
  const colours = await page.evaluate(() => {
    const c = document.getElementById('world') as HTMLCanvasElement;
    const g = c.getContext('2d')!;
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const set = new Set<number>();
    for (let i = 0; i < d.length; i += 4 * 997) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return set.size;
  });
  expect(colours).toBeGreaterThan(20);
  await expect(page.locator('#hud .hud-clock')).toHaveText('10:00');

  // an hour later (the fixture of that moment): the clock ran and somebody has changed place
  const before = await agentPositions(page);
  await live.push(frameFor(DOM, t0 + 60));
  expect(await page.evaluate(() => window.__sim.world.tick)).toBe(t0 + 60);
  await expect(page.locator('#hud .hud-clock')).toHaveText('11:00');
  const now = await agentPositions(page);
  expect(before.filter((p, i) => Math.hypot(p.x - now[i].x, p.y - now[i].y) > 0.5).length).toBeGreaterThan(0);

  await page.screenshot({ path: `${SHOTS}/day.png` });
  expect(errors).toEqual([]);
});

test('clicking an agent opens the inspector', async ({ page }) => {
  const errors = trackErrors(page);
  await mockLive(page, frameFor(DOM, tickAt(12)));
  await openLive(page, '/dom');
  await page.waitForTimeout(500);
  // find the screen position of an agent by scanning for a pick hit
  const hit = await page.evaluate(() => {
    const { renderer, world } = window.__sim;
    for (let y = 0; y < innerHeight; y += 6)
      for (let x = 0; x < innerWidth; x += 6) {
        const a = renderer.pickAgent(x, y);
        if (a && a.id === world.agents[0].id) return { x, y };
      }
    return null;
  });
  expect(hit).not.toBeNull();
  await page.mouse.click(hit!.x, hit!.y);
  await expect(page.locator('#inspector')).toBeVisible();
  const name = await page.evaluate(() => window.__sim.world.agents[0].name);
  await expect(page.locator('#inspector')).toContainText(name);
  await page.screenshot({ path: `${SHOTS}/inspector.png` });
  expect(errors).toEqual([]);
});

test('night view after a busy day', async ({ page }) => {
  const errors = trackErrors(page);
  await mockLive(page, frameFor(DOM, tickAt(23)));
  await openLive(page, '/dom');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/night.png` });
  expect(errors).toEqual([]);
});

test('evening with conversations', async ({ page }) => {
  await mockLive(page, frameFor(DOM, tickAt(18)));
  await openLive(page, '/dom');
  await page.waitForTimeout(1000);
  // the conversations of the day are in the log
  await expect(page.locator('#log .log-row').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/evening.png` });
});
