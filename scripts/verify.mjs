/**
 * scripts/verify.mjs —— 用系统 Chrome 做无浏览器驱动验证：
 * 截图各关键状态、收集 console/page 错误、检查自检结果、模拟交互。
 * 运行：node scripts/verify.mjs
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://127.0.0.1:4173/';
const OUT = '/tmp/gsb-shots';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--window-size=1500,1040',
  ],
  defaultViewport: { width: 1500, height: 1040, deviceScaleFactor: 2 },
});

const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
await sleep(1800); // 等 WebGL 首帧与动画

async function shot(name) {
  await sleep(450);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('shot', name);
}

// 自检结果
const summary = await page.$eval('#selfTestSummary', (el) => el.textContent);
const tests = await page.$$eval('.selftest-list li', (lis) =>
  lis.map((li) => ({
    cls: li.className,
    text: li.querySelector('.st-name')?.textContent,
    detail: li.querySelector('.st-detail')?.textContent,
  })),
);
console.log('SELFTEST SUMMARY:', summary);
for (const t of tests) console.log(`  [${t.cls}] ${t.text} — ${t.detail}`);

// 1. 初始：跨反经线 + 经纬图
await shot('01-antimeridian-equirect');

// 2. 切方位投影（中心北京）
await page.click('[data-proj="azimuthal"]');
await shot('02-antimeridian-azimuthal-beijing');

// 3. 方位中心换成雷克雅未克
await page.select('#centerSelect', 'reykjavik');
await shot('03-antimeridian-azimuthal-reykjavik');
await page.select('#centerSelect', 'beijing');

// 4. 极地航线 + 经纬图
await page.click('[data-proj="equirect"]');
await page.click('[data-preset="polar"]');
await shot('04-polar-equirect');

// 5. 极地 + 方位投影，中心斯瓦尔巴（极地中心感）
await page.click('[data-proj="azimuthal"]');
await page.select('#centerSelect', 'svalbard');
await shot('05-polar-azimuthal-svalbard');
await page.select('#centerSelect', 'beijing');
await page.click('[data-proj="equirect"]');

// 6. 重合
await page.click('[data-preset="same"]');
await shot('06-same');

// 7. 近对跖
await page.click('[data-preset="nearanti"]');
await shot('07-near-antipodal');

// 8. 精确对跖 + 方位图
await page.click('[data-preset="antipodal"]');
await page.click('[data-proj="azimuthal"]');
await shot('08-antipodal-azimuthal');
await page.click('[data-proj="equirect"]');

// 9. 回到跨反经线，拖 slider
await page.click('[data-preset="antimeridian"]');
await page.$eval('#scrub', (el) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  ).set;
  setter.call(el, '820');
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await shot('09-scrub-82');

// 10. 平面地图网格 hover 扫描，验证拾取、tooltip 与主读数严格一致
const box = await page.$eval('#flatMap', (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
let hoverFound = false;
let consistencyOk = false;
for (let fx = 0.12; fx < 0.95 && !hoverFound; fx += 0.06) {
  for (let fy = 0.15; fy < 0.9; fy += 0.08) {
    await page.mouse.move(box.x + box.w * fx, box.y + box.h * fy);
    await sleep(30);
    const hidden = await page.$eval('.map-tooltip', (el) => el.hidden);
    if (!hidden) {
      hoverFound = true;
      const ttCoord = await page.$eval('.map-tooltip .tt-row', (el) => el.textContent);
      const roCoord = await page.$eval('#roCoords', (el) => el.textContent);
      consistencyOk = ttCoord === roCoord;
      console.log('MAP HOVER ->', ttCoord, '| readout:', roCoord, '| exact match:', consistencyOk);
      await shot('10-map-hover');
      break;
    }
  }
}
console.log('map hover hit:', hoverFound, 'consistency:', consistencyOk);
await page.mouse.move(0, 0);

// 11. 球面航线 hover/scrub（在点选测试之前，航线仍是上海->洛杉矶）
const g = await page.$eval('#globeStage canvas', (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
let globeScrub = false;
let globeConsistency = false;
for (let fx = 0.3; fx < 0.75 && !globeScrub; fx += 0.04) {
  for (const fy of [0.42, 0.5, 0.58]) {
    await page.mouse.move(g.x + g.w * fx, g.y + g.h * fy);
    await sleep(40);
    const hidden = await page.$eval('.globe-tooltip', (el) => el.hidden);
    if (!hidden) {
      const tt = await page.$eval('.globe-tooltip', (el) => el.innerText.replace(/\n/g, ' | '));
      const ttCoord = await page.$eval('.globe-tooltip .tt-row', (el) => el.textContent);
      const roCoord = await page.$eval('#roCoords', (el) => el.textContent);
      globeConsistency = ttCoord === roCoord;
      console.log('GLOBE HOVER ->', tt, '| exact match:', globeConsistency);
      globeScrub = true;
      await page.mouse.down();
      await page.mouse.move(g.x + g.w * (fx + 0.1), g.y + g.h * (fy - 0.08), { steps: 6 });
      await sleep(150);
      await shot('11-globe-scrub-drag');
      await page.mouse.up();
      break;
    }
  }
}
console.log('globe route hover/scrub hit:', globeScrub, 'consistency:', globeConsistency);

// 12. 旋转镜头：航线数据/读数不应改变
const totalBefore = await page.$eval('#roTotal', (el) => el.textContent);
const distBefore = await page.$eval('#roDistance', (el) => el.textContent);
await page.mouse.move(g.x + g.w * 0.5, g.y + g.h * 0.9);
await page.mouse.down();
await page.mouse.move(g.x + g.w * 0.64, g.y + g.h * 0.72, { steps: 8 });
await page.mouse.up();
await sleep(500);
const totalAfter = await page.$eval('#roTotal', (el) => el.textContent);
const distAfter = await page.$eval('#roDistance', (el) => el.textContent);
console.log('rotate preserves route:', totalBefore === totalAfter, totalBefore, '| scrub dist preserved:', distBefore === distAfter, distBefore);
await shot('12-rotated-view');

// 13. 球上点选起点（放最后，会改起点）
const before = await page.$eval('#startLat', (el) => el.value);
await page.click('#pickStart');
await page.mouse.click(g.x + g.w * 0.52, g.y + g.h * 0.46);
await sleep(300);
const after = await page.$eval('#startLat', (el) => el.value);
console.log('globe pick startLat before/after:', before, '->', after);
await page.click('#pickStart'); // 关闭
await shot('13-after-globe-pick');

// 读数一致性：当前 readout 文本
const readout = await page.$eval('.readout-card', (el) => el.innerText);
console.log('READOUT:\n' + readout);

console.log('CONSOLE/PAGE ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
await browser.close();

const failed = tests.filter((t) => t.cls !== 'st-pass');
const behavioralFail =
  !hoverFound ||
  !consistencyOk ||
  !globeScrub ||
  !globeConsistency ||
  totalBefore !== totalAfter ||
  distBefore !== distAfter;
if (failed.length || errors.length || behavioralFail) process.exit(1);
