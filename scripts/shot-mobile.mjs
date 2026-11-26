/** 移动端工作区中部截图 */
import puppeteer from 'puppeteer-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle0' });
await sleep(1800);
await page.evaluate(() => document.querySelector('.workspace')?.scrollIntoView());
await sleep(600);
await page.screenshot({ path: '/tmp/gsb-shots/mobile-workspace.png' });
console.log('done');
await browser.close();
