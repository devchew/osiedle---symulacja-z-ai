import { expect, test } from '@playwright/test';
import type { World } from '../src/types';
import { isGuest } from '../src/agents/role';
import { SHOTS, mockLive, openLive, trackErrors } from './support/live';
import { frameFor, timelineOf } from './support/worldFixtures';

// Guests from outside (issue #7) in the live view: they walk on the map like everybody else, show up
// in the screen-reader list and the inspector marked as guests (no diary, no goal), are not counted
// as residents, and vanish again when a later frame no longer has them. How visits are scheduled is
// tested headlessly in tests/guests.test.ts. Shot: test-results/shots/guests-*.png.

const DOM = { place: 'dom' } as const;
const timeline = timelineOf(DOM);
const guestsOf = (w: World) => w.agents.filter(isGuest);

test('guests are marked in the list and the inspector, and leave with a later frame', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackErrors(page);
  const present = timeline.findTick((w) => guestsOf(w).length >= 2 && guestsOf(w).every((g) => g.action?.kind !== 'wander'), { step: 15 });
  const gone = timeline.findTick((w) => guestsOf(w).length === 0, { from: present, step: 15 });
  const live = await mockLive(page, frameFor(DOM, present));
  await openLive(page, '/dom').catch((e) => {
    throw new Error(`${e.message}\nbrowser errors: ${errors.join(' | ')}`);
  });
  await page.waitForTimeout(800);

  const info = await page.evaluate(() => {
    const { world } = window.__sim;
    const guests = world.agents.filter((a) => a.role === 'guest');
    return { guests: guests.map((g) => ({ id: g.id, name: g.name })), residents: world.agents.length - guests.length };
  });
  expect(info.guests.length).toBeGreaterThanOrEqual(2);

  const list = page.locator('.a11y-resident');
  await expect(list).toHaveCount(info.guests.length + info.residents);
  await expect(list.filter({ hasText: '(gość)' })).toHaveCount(info.guests.length);

  await page.evaluate((id) => window.__sim.select(id), info.guests[0].id);
  await expect(page.locator('.insp-name')).toHaveText(`${info.guests[0].name} · gość`);
  await expect(page.locator('.insp-diary-btn')).toBeHidden();
  await expect(page.locator('.insp-goal')).toBeHidden();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/guests-visit.png` });

  // a later frame without guests removes them from the world on screen
  await live.push(frameFor(DOM, gone));
  await expect.poll(() => page.evaluate(() => window.__sim.world.agents.filter((a) => a.role === 'guest').length)).toBe(0);
  await expect(page.locator('.a11y-resident')).toHaveCount(info.residents);
  expect(errors).toEqual([]);
});
