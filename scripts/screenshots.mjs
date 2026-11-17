// 关键状态截图：输出到 scripts/shots/ 供人工核对渲染质量
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:5175/';
mkdirSync('scripts/shots', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

await page.screenshot({ path: 'scripts/shots/01-baseline.png' });

await page.click('[data-preset="smallcover"]');
await page.waitForTimeout(700);
await page.screenshot({ path: 'scripts/shots/02-smallcover.png' });

await page.click('[data-preset="acne"]');
await page.waitForTimeout(700);
await page.screenshot({ path: 'scripts/shots/03-acne.png' });

await page.click('[data-preset="peter"]');
await page.waitForTimeout(700);
await page.screenshot({ path: 'scripts/shots/04-peter.png' });

await page.click('[data-view="top"]');
await page.waitForTimeout(700);
await page.screenshot({ path: 'scripts/shots/05-topview.png' });
await page.click('[data-view="perspective"]');

await page.click('#mode-compare');
await page.waitForTimeout(900);
await page.check('input[name="active-side"][value="B"]');
await page.waitForTimeout(200);
await page.click('[data-preset="lowres"]');
await page.waitForTimeout(800);
await page.screenshot({ path: 'scripts/shots/06-compare.png' });

await page.setViewportSize({ width: 480, height: 900 });
await page.waitForTimeout(600);
await page.screenshot({ path: 'scripts/shots/07-mobile.png', fullPage: true });

console.log('screenshots done');
await browser.close();
