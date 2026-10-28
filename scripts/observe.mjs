// Watches the running app in a real browser for N minutes at 1× speed and saves
// the activity trace, event log, periodic screenshots and console errors.
// usage: node scripts/observe.mjs <url> <minutes> <outDir>
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [url, minutesArg = '15', outDir = 'test-results/observe'] = process.argv.slice(2);
const minutes = Number(minutesArg);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`[console] ${m.text()}`));

await page.goto(url);
await page.waitForFunction(() => !!window.__sim);
const started = Date.now();
const samples = [];

for (let m = 1; m <= minutes; m++) {
  await page.waitForTimeout(60_000);
  const s = await page.evaluate(async () => {
    // rough fps over one second
    const fps = await new Promise((resolve) => {
      let n = 0;
      const t0 = performance.now();
      const f = () => (performance.now() - t0 < 1000 ? (n++, requestAnimationFrame(f)) : resolve(n));
      requestAnimationFrame(f);
    });
    const w = window.__sim.world;
    return { tick: w.tick, fps, conversations: w.conversations.length, moods: w.agents.map((a) => Math.round(a.mood)) };
  });
  samples.push({ minute: m, ...s });
  await page.screenshot({ path: join(outDir, `min-${String(m).padStart(2, '0')}.png`) });
  console.log(`minute ${m}: tick ${s.tick}, fps ${s.fps}, moods ${s.moods.join(',')}`);
}

const trace = await page.evaluate(() => window.__sim.trace());
const events = await page.evaluate(() => {
  const w = window.__sim.world;
  return w.events.map((e) => {
    const m = (e.tick + 420) % 1440;
    const day = Math.floor((e.tick + 420) / 1440) + 1;
    return `D${day} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}  ${e.kind.padEnd(12)} ${e.text}`;
  });
});
writeFileSync(join(outDir, 'trace.txt'), trace);
writeFileSync(join(outDir, 'events.txt'), events.join('\n'));
writeFileSync(join(outDir, 'samples.json'), JSON.stringify({ url, realMinutes: (Date.now() - started) / 60000, samples, errors }, null, 2));
console.log(`done: ${trace.split('\n').length} trace lines, ${events.length} events, ${errors.length} errors`);
await browser.close();
