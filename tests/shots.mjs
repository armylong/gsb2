import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5234', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

const out = fileURLToPath(new URL('../test-results/', import.meta.url));
const items = page.locator('#object-list li');

// 遮挡布局：选中挡板后的球体(id1)、圆台(id3) 和挡板前的带孔环(id6)，看虚线与实线区分
await page.click('[data-layout="occlusion"]');
for (const n of [0, 2, 5]) await items.nth(n).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}occlusion-selected.png` });

// 仅可见模式对照
await page.click('#btn-visible');
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}occlusion-visible-only.png` });
await page.click('#btn-hidden');

// 宽度 6px
await page.locator('#width-slider').fill('6');
await page.locator('#width-slider').dispatchEvent('input');
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}width-6px.png` });

// touch 布局三个对象同时选中，验证身份色
await page.click('[data-layout="touch"]');
await page.click('#btn-clear');
for (const n of [6, 7, 8]) await items.nth(n).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}touch-three.png` });

console.log(errors.length ? 'ERRORS: ' + errors.join(' | ') : 'OK, screenshots written');
await browser.close();
