import { expect, test, type Page } from '@playwright/test';

const SHOTS = 'test-results/shots';

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return errors;
}

async function agentPositions(page: Page): Promise<{ x: number; y: number }[]> {
  return page.evaluate(() => window.__sim.world.agents.map((a) => ({ ...a.pos })));
}

test('the simulation renders and runs on its own', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?seed=7');
  await page.waitForFunction(() => !!window.__sim);
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

  const before = await agentPositions(page);
  await page.waitForTimeout(2500);
  const after = await agentPositions(page);
  const moved = before.filter((p, i) => Math.hypot(p.x - after[i].x, p.y - after[i].y) > 0.5).length;
  expect(moved).toBeGreaterThan(0);

  await page.screenshot({ path: `${SHOTS}/day.png` });
  expect(errors).toEqual([]);
});

test('pause and speed controls work', async ({ page }) => {
  await page.goto('/?seed=7');
  await page.waitForFunction(() => !!window.__sim);
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => window.__sim.controls.paused)).toBe(true);
  const t = await page.evaluate(() => window.__sim.world.tick);
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__sim.world.tick)).toBe(t);
  await page.keyboard.press('Space');
  await page.keyboard.press('3');
  await expect.poll(() => page.evaluate(() => window.__sim.controls.speed)).toBe(4);
});

test('clicking an agent opens the inspector', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?seed=7&paused');
  await page.waitForFunction(() => !!window.__sim);
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
  await page.goto('/?seed=7&hour=23');
  await page.waitForFunction(() => !!window.__sim);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/night.png` });
  expect(errors).toEqual([]);
});

test('evening with conversations', async ({ page }) => {
  await page.goto('/?seed=7&hour=18');
  await page.waitForFunction(() => !!window.__sim);
  await page.waitForTimeout(1000);
  const convEvents = await page.evaluate(() => window.__sim.world.events.filter((e) => e.kind === 'conversation').length);
  expect(convEvents).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/evening.png` });
});
