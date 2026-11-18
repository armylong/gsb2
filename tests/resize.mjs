// 窗口尺寸变化检查：resize 后渲染目标跟随、描边仍正常绘制、无控制台错误。
import { chromium } from 'playwright';

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await page.goto('http://127.0.0.1:5234', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.locator('#object-list li').nth(0).click();

const measureOutline = async () =>
  page.evaluate(() => {
    const hook = window.__outlineDemo;
    const mask = hook.pipeline.captureOutlineMask(
      hook.getScene(),
      hook.getCamera(),
      hook.getObjects().filter((o) => !o.hidden),
      'visible',
      2,
      1,
    );
    let count = 0;
    for (const a of mask.alpha) if (a > 40) count++;
    return { width: mask.width, height: mask.height, count };
  });

const before = await measureOutline();
await page.setViewportSize({ width: 1024, height: 700 });
await page.waitForTimeout(400);
const after = await measureOutline();
await page.setViewportSize({ width: 1600, height: 1000 });
await page.waitForTimeout(400);
const after2 = await measureOutline();

console.log('初始:', JSON.stringify(before));
console.log('缩小:', JSON.stringify(after));
console.log('放大:', JSON.stringify(after2));

const pass =
  errors.length === 0 &&
  after.width === 1024 - 300 && // 侧栏 300px
  after2.width === 1600 - 300 &&
  after.count > 0 &&
  after2.count > 0;
console.log(
  pass ? 'PASS  窗口变化后渲染目标与描边均正确' : 'FAIL  尺寸或描边异常',
  errors.length ? '错误: ' + errors.join(' | ') : '',
);
await browser.close();
process.exit(pass ? 0 : 1);
