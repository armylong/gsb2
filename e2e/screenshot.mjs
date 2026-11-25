import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto('http://localhost:5199', { waitUntil: 'networkidle' });
  if (theme === 'dark') {
    await page.locator('button:has-text("切深色")').click();
    await page.waitForTimeout(200);
  }
  // 载入「弱长音接强短音」示例，让曲线更有内容
  await page.locator('.preset-list button:has-text("弱长音")').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `e2e/screenshot-${theme}.png`, fullPage: true });
  await page.close();
}
await browser.close();
console.log('screenshots done');
