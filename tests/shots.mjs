/** 生成 README 用的代表性截图: node tests/shots.mjs */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'tmp', 'shots');
const URL = process.env.LAB_URL || 'http://localhost:5174';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

const slider = (key, v) =>
  page.locator(`input[data-key="${key}"]`).evaluate((el, val) => {
    el.value = String(val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
const check = (key, on) =>
  page.locator(`input[data-key="${key}"]`).evaluate((el, want) => {
    if (el.checked !== want) el.click();
  }, on);

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__lab);

// 1. 正常混合形态: 壁鼓起+按凹+捏窄, 盖鼓起, 斜光
await slider('wall.bulge', 0.8);
await slider('wall.dent', -0.7);
await slider('wall.pinch', 0.5);
await slider('lid.bulge', 0.6);
await check('lightHelper', true);
await page.waitForTimeout(200);
await page.screenshot({ path: resolve(OUT, 'a-mixed.png') });

// 2. 影响区热图
await check('lightHelper', false);
await check('influence', true);
await check('seam', true);
await page.waitForTimeout(200);
await page.screenshot({ path: resolve(OUT, 'b-influence.png') });

// 3. 盖子打开 + 软垂
await check('influence', false);
await check('seam', false);
await slider('hingeDeg', 75);
await slider('flex', 0.8);
await page.waitForTimeout(200);
await page.screenshot({ path: resolve(OUT, 'c-hinge-open.png') });

// 4. 翻面检测
await slider('hingeDeg', 0);
await slider('flex', 0);
await page.evaluate(() => window.__lab.app.applyExtremeWeights());
await page.waitForTimeout(200);
await page.screenshot({ path: resolve(OUT, 'd-flip.png') });

// 5. 测点检查器
await page.evaluate(() => window.__lab.app.importJSON(JSON.stringify({
  version: 1, savedAt: 'x', meshParams: window.__lab.app.params,
  weights: {
    wall: { bulge: 0.9, dent: -0.6, pinch: 0.4 },
    lid: { bulge: 0.7, dent: 0, pinch: 0 },
    hingeDeg: 20, flex: 0.3,
  },
  pins: [
    { part: 'wall', vertex: 70 },
    { part: 'wall', vertex: 400 },
    { part: 'lid', vertex: 130 },
  ],
})));
await page.waitForTimeout(200);
await page.screenshot({ path: resolve(OUT, 'e-pins.png') });

console.log(errors.length ? `ERRORS: ${errors.join(' | ')}` : 'all screenshots ok');
await browser.close();
