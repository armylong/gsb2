import { chromium } from 'playwright';
const URL = `http://127.0.0.1:${process.env.PORT || 5173}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
await page.goto(URL);
await page.waitForSelector('#viewport canvas');
await sleep(800);
// 正常距离开阔地
await page.screenshot({ path: '/tmp/cam-shots/final-1-overview.png' });
// 低顶通道入口
await page.click('[data-level="lowceiling"]');
await sleep(400);
await page.screenshot({ path: '/tmp/cam-shots/final-2-lowceiling.png' });
await browser.close();
console.log('shots done');
