// Usage: node scripts/screenshot.mjs <url> <out.png> [waitMs=1500] [width=1440] [height=900]
// Prints console errors and page errors; exits 1 if any page error occurred.
import { chromium } from '@playwright/test';

const [url, out, waitMs = '1500', width = '1440', height = '900'] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/screenshot.mjs <url> <out.png> [waitMs] [width] [height]');
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) }, deviceScaleFactor: 1 });
let errors = 0;
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') console.log(`[console.${msg.type()}] ${msg.text()}`);
});
page.on('pageerror', (err) => {
  errors++;
  console.log(`[pageerror] ${err.message}`);
});
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(Number(waitMs));
await page.screenshot({ path: out });
console.log(`saved ${out}`);
await browser.close();
process.exit(errors ? 1 : 0);
