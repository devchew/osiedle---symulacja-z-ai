import { expect, test, type Page } from '@playwright/test';
import { SHOTS, mockLive, openLive, trackErrors } from './support/live';
import { frameFor, tickAt } from './support/worldFixtures';
import { PLACES, type PlaceId } from '../src/live/protocol';

// Every place's house in the live view (fixture worlds from e2e/support) and the house pets (#9).
// Shots of every house: test-results/shots/house-*.png.

const HOUSES: readonly PlaceId[] = PLACES.map((p) => p.id);

async function open(page: Page, place: PlaceId, hour: number): Promise<void> {
  await mockLive(page, frameFor({ place }, tickAt(hour)));
  await openLive(page, `/${place}`);
  await page.waitForTimeout(1200);
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

test.describe('every house by day', () => {
  for (const id of HOUSES) {
    test(`house ${id}`, async ({ page }) => {
      const errors = trackErrors(page);
      await open(page, id, 12);
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

test.describe('pets (#9)', () => {
  for (const [id, hour] of [['dom', 12], ['kamienica', 12], ['dom', 23]] as const) {
    test(`pet in ${id} at ${hour}:00: close-up, click opens the pet panel`, async ({ page }) => {
      const errors = trackErrors(page);
      await open(page, id, hour);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${SHOTS}/pet-${id}-${hour}-overview.png` });
      const at = async (): Promise<{ x: number; y: number; name: string }> =>
        page.evaluate(() => {
          const { renderer } = window.__sim;
          const p = renderer.petVisuals()[0];
          return { ...renderer.toScreen(p.x, p.y), name: p.name };
        });
      // the event log covers the bottom-left corner, where some pets live
      await page.evaluate(() => (document.getElementById('log')!.style.display = 'none'));
      let p = await at();
      // zoom in on the pet
      for (let i = 0; i < 4; i++) {
        await page.mouse.move(p.x, p.y);
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(350);
        p = await at();
      }
      await page.waitForTimeout(500);
      // drag the pet to the middle of the screen (clear of the HUD, the log and the inspector)
      p = await at();
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move((p.x + 600) / 2, (p.y + 450) / 2, { steps: 4 });
      await page.mouse.move(600, 450, { steps: 4 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      p = await at();
      await page.mouse.click(p.x, p.y + 4);
      const panel = page.locator('#inspector');
      await expect(panel).toBeVisible();
      await expect(panel).toHaveClass(/is-pet/);
      await expect(panel.locator('.insp-name')).toContainText(p.name);
      await page.screenshot({ path: `${SHOTS}/pet-${id}-${hour}-closeup.png` });
      expect(errors).toEqual([]);
    });
  }
});
