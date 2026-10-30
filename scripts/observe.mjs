// Watches the LIVE view of a server world in a real browser for N real minutes and saves
// the event log, periodic screenshots, per-minute samples and console errors.
// usage: node scripts/observe.mjs <url> <minutes> <outDir>
//   e.g. LIVE_SPEED=60 npm run dev     (one sim minute per second: 15 real minutes ≈ 15 game hours)
//        node scripts/observe.mjs http://localhost:5173/kamienica 15 test-results/observe
// The world ticks on the server (LIVE_SPEED / LIVE_FIXED_TIME / DATA_DIR env); the browser only renders frames,
// so trace.txt is empty (frames carry no activity trace; events.txt, samples.json and the screenshots show what the
// client saw). For decisions / activity traces and to reproduce a world from a seed headlessly (and much faster) use
// tests/tools/tracedump.test.ts (see CONTRIBUTING.md).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [url = 'http://localhost:5173/kamienica', minutesArg = '15', outDir = 'test-results/observe'] = process.argv.slice(2);
const minutes = Number(minutesArg);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`[console] ${m.text()}`));

await page.goto(url);
await page.waitForFunction(() => window.__sim?.mode === 'live' && (window.__sim.frames ?? 0) >= 1, undefined, { timeout: 60_000 });
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
