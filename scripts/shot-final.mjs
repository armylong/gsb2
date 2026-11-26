/** 最终整页 / 移动端截图检查 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

// 桌面整页
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1.5 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle0' });
await sleep(1800);
await page.screenshot({ path: '/tmp/gsb-shots/full-desktop.png', fullPage: true });

// 滚到说明区
await page.evaluate(() => document.querySelector('.notes-card')?.scrollIntoView());
await sleep(400);
await page.screenshot({ path: '/tmp/gsb-shots/full-notes.png' });

// 移动端
const mob = await browser.newPage();
await mob.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
mob.on('pageerror', (e) => errors.push('mobile: ' + e.message));
await mob.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle0' });
await sleep(1800);
await mob.screenshot({ path: '/tmp/gsb-shots/mobile-top.png' });
await mob.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await sleep(500);
await mob.screenshot({ path: '/tmp/gsb-shots/mobile-bottom.png' });

console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
if (errors.length) process.exit(1);
