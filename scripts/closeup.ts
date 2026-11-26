/** 弯段特写：聚焦中间轮上的选中刻度，确认标记贴合弯段 */
import { chromium } from 'playwright-core';

const EXE = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

// 暂停并把 phase 调到选中 #5 出现在中间轮弯段附近：直接单步若干次观察
await page.click('#play');
await page.selectOption('#select-marker', '5');
await page.waitForTimeout(100);
await page.click('#focus');
await page.waitForTimeout(1000);
// 推进相机视角
await page.evaluate(() => {
  const s = (window as any).beltDebug.scene;
  s.camera.zoom = 2.1;
  s.camera.updateProjectionMatrix();
});
await page.waitForTimeout(300);
await page.screenshot({ path: 'shots/07-arc-closeup.png' });

// 直段特写：选 #25（下直段附近）
await page.selectOption('#select-marker', '25');
await page.waitForTimeout(100);
await page.click('#focus');
await page.waitForTimeout(1000);
await page.screenshot({ path: 'shots/08-line-closeup.png' });

await browser.close();
console.log('closeups done');
