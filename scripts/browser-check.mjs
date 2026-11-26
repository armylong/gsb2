import { chromium } from 'playwright-core';

const executablePath =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.stack || error.message}`));

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:4181/';
await page.goto(baseUrl, { waitUntil: 'networkidle' });

// Level 1: ask the shared engine for a hint, apply it, and run.
await page.getByRole('button', { name: /用同一套引擎搜索提示/ }).click();
await page.getByRole('button', { name: /应用提示摆放/ }).click();
await page.getByRole('button', { name: /放珠运行/ }).first().click();
await page.waitForSelector('.banner.won', { timeout: 10000 });
await page.screenshot({ path: '/tmp/gsb-level1-won.png' });

const level1Inspector = await page.locator('#inspector').innerText();
if (!level1Inspector.includes('第')) throw new Error('inspector did not render steps');

// Return to frame zero and step twice so the screenshot is a deterministic single-step view.
await page.locator('[data-action="first"]').click();
await page.locator('[data-action="next"]').click();
await page.locator('[data-action="next"]').click();
await page.waitForTimeout(100);
await page.screenshot({ path: '/tmp/gsb-level1-step.png' });

// Level 2: hint + run should expose the wait/reorder trace.
await page.getByRole('button', { name: /第二关/ }).click();
await page.getByRole('button', { name: /用同一套引擎搜索提示/ }).click();
await page.getByRole('button', { name: /应用提示摆放/ }).click();
await page.getByRole('button', { name: /放珠运行/ }).first().click();
await page.waitForSelector('.banner.won', { timeout: 10000 });
await page.screenshot({ path: '/tmp/gsb-level2-won.png' });
const bodyText = await page.locator('body').innerText();
for (const expected of ['同格竞争', 'lost-priority', 'SW-D', '本地校验']) {
  if (!bodyText.includes(expected)) throw new Error(`missing expected UI text: ${expected}`);
}

// Undo should revert the R1 placement change (compare active button state, not text).
const before = await page.locator('.chute-row').first().innerHTML();
await page.getByRole('button', { name: /撤销摆放/ }).click();
const after = await page.locator('.chute-row').first().innerHTML();
if (before === after) throw new Error('undo did not change chute editor');

console.log('browser-check: ok');
console.log(`console errors: ${errors.length}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
await browser.close();
