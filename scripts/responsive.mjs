/**
 * 响应式巡检：在几种典型宽度下截图，并检查没有横向滚动。
 * 需要先运行 `npm run preview`（默认 http://localhost:4173/）。
 */
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:4173/';
const browser = await chromium.launch();
const sizes = [
  { width: 1440, height: 980 },
  { width: 1180, height: 900 },
  { width: 1024, height: 820 },
  { width: 834, height: 1112 },
  { width: 390, height: 844 },
  { width: 344, height: 720 },
];
const results = [];
for (const size of sizes) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const metrics = await page.evaluate(() => {
    const canvas = document.querySelector('.board-canvas');
    const rect = canvas.getBoundingClientRect();
    return {
      canvasWidth: Math.round(rect.width),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  await page.screenshot({ path: `tmp/shots/resp-${size.width}.png` });
  results.push({ viewport: `${size.width}x${size.height}`, ...metrics, errors });
  await page.close();
}
console.log(JSON.stringify(results, null, 2));
await browser.close();
const bad = results.some((r) => r.overflow > 0 || r.errors.length > 0);
process.exit(bad ? 1 : 0);
