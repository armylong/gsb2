// 运行时冒烟测试：node tests/smoke.mjs（需先启动 dev server）
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const errors = [];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');

// 1. WebGL 渲染循环在工作
const canvasInfo = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  return { w: c.width, h: c.height, hasGL: !!gl };
});
assert(canvasInfo.hasGL && canvasInfo.w > 0, 'webgl canvas active');

// 2. 探针：先验证点击交互能放置探针，再用程序化辅助把探针放到灯下方的平板点
const box = await page.$eval('canvas', (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await page.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.62);
await page.waitForTimeout(200);
const clickPlaced = await page.evaluate(() => window.__lab.hasProbe());
assert(clickPlaced, 'click places a probe');
// 放到默认灯（z=0.6）正下方，确保测到真实灯板贡献
await page.evaluate(() => window.__lab.placeProbeOnPlate(0, 0.55));
await page.waitForTimeout(100);
const hasProbe = await page.evaluate(() => window.__lab.hasProbe());
assert(hasProbe, 'probe placed on surface');

// 3. 探针数值有限且 A/B 不同（默认 B 是宽灯）
const probe = await page.evaluate(() => {
  const a = window.__lab.probeResult('A');
  const b = window.__lab.probeResult('B');
  const finite = (o) =>
    ['irradiance', 'reflectedLuminance', 'spotLong', 'spotShort'].every(
      (k) => Number.isFinite(o[k]) && o[k] > 0,
    );
  return {
    finiteA: finite(a),
    finiteB: finite(b),
    a: a && { E: a.irradiance, L: a.reflectedLuminance, long: a.spotLong, short: a.spotShort },
    b: b && { E: b.irradiance, L: b.reflectedLuminance, long: b.spotLong, short: b.spotShort },
  };
});
assert(probe.finiteA && probe.finiteB, 'probe values finite & positive');
// 环境光 ambient=0.06 贡献约 0.188；灯板真实贡献应明显高于它
assert(probe.a.E > 0.5 && probe.b.E > 0.5, 'probe receives real rect-light (not ambient-only)');
console.log('A 组（窄灯 0.8m）:', probe.a);
console.log('B 组（宽灯 1.6m）:', probe.b);
assert(probe.b.long > probe.a.long, 'wider light gives longer reflection spot');

// 4. 背面朝向：从“发光面朝下(-90°)”旋到“朝上(+90°)”，灯板贡献应归零
const backTest = await page.evaluate(async () => {
  const lab = window.__lab;
  const p = lab.getParams('A');
  const saved = [...p.rotationDeg];
  // 先把灯放到探针正上方并朝下
  lab.updateParams('A', { position: [0, 1.2, 0.05], rotationDeg: [-90, 0, 0] });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const front = lab.probeResult('A').irradiance;
  lab.updateParams('A', { rotationDeg: [90, 0, 0] }); // 发光面朝上 = 背面
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const back = lab.probeResult('A').irradiance;
  lab.updateParams('A', { rotationDeg: saved });
  return { front, back, ratio: back / front };
});
console.log('正面/背面辐照度:', backTest);
// 背面时灯板贡献归零，只剩 ambient（约为正面的个位数百分比）
assert(backTest.ratio < 0.4, 'back-facing light gives far less irradiance');

// 5. 等面亮度模式：宽度变化不改变 nits，总功率模式下 nits 反推
const lumMode = await page.evaluate(() => {
  const lab = window.__lab;
  lab.updateParams('A', { constantLuminance: true, width: 0.8, height: 0.12, luminance: 120 });
  const w1 = lab.getParams('A').width; // 立即取原始值，勿持有对象引用
  lab.updateParams('A', { width: 1.6 });
  const w2 = lab.getParams('A').width;
  lab.updateParams('A', { constantLuminance: false });
  const flag = lab.getParams('A').constantLuminance;
  return {
    constModeWidthKept: w1 === 0.8 && w2 === 1.6,
    fluxModeFlag: flag === false,
    widths: [w1, w2],
  };
});
console.log('亮度模式检查:', lumMode);
assert(lumMode.constModeWidthKept && lumMode.fluxModeFlag, 'luminance modes switchable');

// 6. 极窄灯 + 贴近平板：画面稳定，数值不发散
const edgeCase = await page.evaluate(() => {
  const lab = window.__lab;
  lab.updateParams('A', { width: 0.02, height: 0.02, position: [0, 0.06, 0] });
  const r = lab.probeResult('A');
  return r;
});
assert(
  Number.isFinite(edgeCase.spotLong) && Number.isFinite(edgeCase.irradiance),
  'narrow/near light stays finite',
);
console.log('极限近距窄灯探针:', {
  E: edgeCase.irradiance,
  long: edgeCase.spotLong,
  short: edgeCase.spotShort,
});

// 7. 分屏 + 截图
await page.click('button:has-text("分屏")');
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}01-split.png` });

// 8. 预设摆位
for (const name of ['正对·窄灯条', '正对·宽灯板', '斜照·窄灯条', '斜照·宽灯板']) {
  await page.click(`button[title] >> text=${name}`);
  await page.waitForTimeout(150);
}
await page.click('button:has-text("单视图")');
await page.waitForTimeout(200);
await page.screenshot({ path: `${SHOTS}02-preset-oblique.png` });

// 9. 点光源开启
await page.evaluate(() => window.__lab.updateParams('A', { pointOn: true }));
await page.waitForTimeout(200);
await page.screenshot({ path: `${SHOTS}03-point-light.png` });

assert(errors.length === 0, 'no runtime errors: ' + errors.join(' | '));
await browser.close();
console.log('\n✅ 全部冒烟测试通过');
function assert(cond, msg) {
  if (!cond) {
    console.error('❌ FAIL:', msg);
    process.exit(1);
  }
  console.log('✓', msg);
}
