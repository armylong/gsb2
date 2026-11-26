/** 临时细节截图：只截 #flatMap 元素，检查标签避让与奇点对齐 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1500, height: 1040, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle0' });
await sleep(1500);

await page.click('[data-proj="azimuthal"]');
await sleep(600);
await page.$eval('#flatMap', (c) => c.toDataURL()); // noop warm
const map = await page.$('#flatMap');
await map.screenshot({ path: '/tmp/gsb-shots/map-az-beijing.png' });

await page.select('#centerSelect', 'svalbard');
await sleep(500);
await map.screenshot({ path: '/tmp/gsb-shots/map-az-svalbard.png' });

await page.select('#centerSelect', 'reykjavik');
await sleep(500);
await map.screenshot({ path: '/tmp/gsb-shots/map-az-reykjavik.png' });

await page.select('#centerSelect', 'beijing');
await page.click('[data-preset="antipodal"]');
await sleep(500);
await map.screenshot({ path: '/tmp/gsb-shots/map-az-antipodal.png' });

await page.click('[data-proj="equirect"]');
await page.click('[data-preset="antimeridian"]');
await sleep(500);
await map.screenshot({ path: '/tmp/gsb-shots/map-eq-anti.png' });

console.log('done');
await browser.close();
