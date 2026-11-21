/**
 * 本地冒烟测试: 用 Playwright 驱动真实页面, 逐条核对需求。
 * 运行: 先 `npm run dev`, 再 `node tests/smoke.mjs`
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, '..', 'tmp', 'shots');
const URL = process.env.LAB_URL || 'http://localhost:5173';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

const EPS = 1e-9;
const lab = () => page.evaluateHandle(() => window.__lab);
const snap = async () => page.evaluate(() => window.__lab.app.debugSnapshot());
const aligned = (s) => s.seamMaxGap >= 0 && s.seamMaxGap < EPS;
const setSlider = (key, value) =>
  page.locator(`input[data-key="${key}"]`).evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
const setCheck = (key, checked) =>
  page.locator(`input[data-key="${key}"]`).evaluate((el, c) => {
    if (el.checked !== c) el.click();
  }, checked);

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__lab, { timeout: 8000 });

// ---- 需求 1: 同一基础网格, 三目标独立可调, 边缘固定 ----
console.log('需求1 三目标混合 + 固定点');
let s0 = await snap();
check('初始无翻转', s0.invertedCount === 0);
check('初始接缝间距为 0', aligned(s0), `gap=${s0.seamMaxGap}`);
check('初始壁底环零位移', s0.bottomDrift === 0, `drift=${s0.bottomDrift}`);

await setSlider('wall.bulge', 0.9);
let s1 = await snap();
check('壁鼓起后仍无翻转', s1.invertedCount === 0);
check('壁鼓起后壁底环仍固定', s1.bottomDrift === 0, `drift=${s1.bottomDrift}`);
check('壁鼓起后接缝仍对齐', aligned(s1), `gap=${s1.seamMaxGap}`);

await setSlider('wall.dent', -0.8);
let s2 = await snap();
check('鼓起+按凹可同时开启', s2.weights.wall.bulge === 0.9 && s2.weights.wall.dent === -0.8);
check('两目标叠加后底环仍固定', s2.bottomDrift === 0);

await setSlider('wall.pinch', 0.6);
let s3 = await snap();
check('三目标可同时混合', Object.values(s3.weights.wall).every((v) => v !== 0));
check('混合后接缝仍对齐', aligned(s3), `gap=${s3.seamMaxGap}`);

// ---- 需求 2: 壁/盖独立范围, 接缝对齐, 盖子单独开合有可区分变形 ----
console.log('需求2 部件独立 + 接缝 + 开合');
await setSlider('lid.bulge', 0.8);
let s4 = await snap();
check('盖权重与壁权重独立', s4.weights.lid.bulge === 0.8 && s4.weights.wall.bulge === 0.9);
check('盖变形后接缝仍对齐', aligned(s4), `gap=${s4.seamMaxGap}`);

const lidRimBefore = await page.evaluate(() => {
  const g = window.__lab.app.built.lid.geometry;
  const n = g.attributes.position.count;
  return new Array(8).fill(0).map((_, i) => {
    const idx = n - 64 + i * 8;
    return [g.attributes.position.getX(idx), g.attributes.position.getY(idx)];
  });
});
await setSlider('hingeDeg', 70);
const lidRimAfter = await page.evaluate(() => {
  const g = window.__lab.app.built.lid.geometry;
  const n = g.attributes.position.count;
  return new Array(8).fill(0).map((_, i) => {
    const idx = n - 64 + i * 8;
    return [g.attributes.position.getX(idx), g.attributes.position.getY(idx)];
  });
});
const rimMoved = lidRimAfter.some((p, i) => Math.hypot(p[0] - lidRimBefore[i][0], p[1] - lidRimBefore[i][1]) > 0.05);
check('盖子开合后外圈发生刚体位移', rimMoved);
let s5 = await snap();
check('开盖状态接缝考核跳过(预期分离)', s5.seamMaxGap === -1);

await setSlider('hingeDeg', 0);
let s6 = await snap();
check('合盖后接缝重新对齐', aligned(s6), `gap=${s6.seamMaxGap}`);
await setSlider('flex', 0.9);
await setSlider('hingeDeg', 60);
let s7 = await snap();
const softDroop = await page.evaluate(() => {
  const g = window.__lab.app.built.lid.geometry;
  // 新拓扑盖心为顶点 0; 软垂应让盖心相对外圈更低
  const center = g.attributes.position.getY(0);
  const rim = g.attributes.position.getY(g.attributes.position.count - 1);
  return { center, rim };
});
check('软垂让盖心低于外圈(可区分变形)', softDroop.center < softDroop.rim, JSON.stringify(softDroop));
await setSlider('hingeDeg', 0);
await setSlider('flex', 0);

// ---- 需求 3: 翻面检测 + 受光检查 ----
console.log('需求3 翻面标记 + 斜光');
await page.evaluate(() => window.__lab.app.applyExtremeWeights());
let s8 = await snap();
check('极端权重触发翻转或濒临翻转标记', s8.invertedCount + s8.strainedCount > 0,
  `inv=${s8.invertedCount} strained=${s8.strainedCount}`);
await setCheck('lightHelper', true);
await page.waitForTimeout(100);
check('光源方向标记可开启无报错', pageErrors.length === 0);
await page.screenshot({ path: resolve(SHOTS, '01-flip-highlight.png') });
await page.evaluate(() => window.__lab.app.importJSON(JSON.stringify({
  version: 1, savedAt: 'reset', meshParams: window.__lab.app.params,
  weights: { wall: { bulge: 0, dent: 0, pinch: 0 }, lid: { bulge: 0, dent: 0, pinch: 0 }, hingeDeg: 0, flex: 0 },
  pins: [],
})));
await setCheck('lightHelper', false);

// ---- 影响区热图(共同影响区域可视化) ----
await setCheck('influence', true);
await setSlider('wall.bulge', 1);
await setSlider('wall.dent', -1);
await page.waitForTimeout(100);
await page.screenshot({ path: resolve(SHOTS, '02-influence-overlap.png') });
check('热图模式无报错', pageErrors.length === 0);
await setCheck('influence', false);
await setCheck('seam', true);
let sSeam = await snap();
check('接缝连线可开启且闭合间距为0', aligned(sSeam));
await page.screenshot({ path: resolve(SHOTS, '03-seam-markers.png') });
await setCheck('seam', false);

// ---- 需求 4: 关键帧录制 + 时间轴往返, 反向不跳变 ----
console.log('需求4 关键帧与时间轴');
await page.locator('button', { hasText: '录为 A 帧' }).click();
await setSlider('wall.bulge', 0);
await setSlider('wall.dent', 0);
await setSlider('lid.bulge', 1.1);
await setSlider('hingeDeg', 45);
await page.locator('button', { hasText: '录为 B 帧' }).click();

// 拖到中间
await page.locator('input.timeline').evaluate((el) => {
  el.value = '0.5';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const mid = await snap();
check('时间轴中点权重为两帧插值',
  Math.abs(mid.weights.lid.bulge - 0.55) < 1e-9 && Math.abs(mid.weights.hingeDeg - 22.5) < 1e-9,
  JSON.stringify(mid.weights));

const geomAtMid = await page.evaluate(() => {
  const g = window.__lab.app.built.wall.geometry;
  return Array.from(g.attributes.position.array.slice(0, 300));
});
// 反向拖回 0.25 再回到 0.5: 同 t 必须同画面
await page.locator('input.timeline').evaluate((el) => {
  el.value = '0.25';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.value = '0.5';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const geomAtMid2 = await page.evaluate(() => {
  const g = window.__lab.app.built.wall.geometry;
  return Array.from(g.attributes.position.array.slice(0, 300));
});
const sameShape = geomAtMid.every((v, i) => Math.abs(v - geomAtMid2[i]) < 1e-10);
check('同 t 反向拖动画面完全一致(无跳变)', sameShape);

// 往返播放
await page.locator('button', { hasText: '往返播放' }).click();
await page.waitForTimeout(600);
await page.locator('button', { hasText: '暂停' }).click();
const playing = await snap();
check('播放后停在连续画面而非默认形状',
  playing.weights.lid.bulge !== 0 || playing.weights.hingeDeg !== 0,
  JSON.stringify(playing.weights));
await page.screenshot({ path: resolve(SHOTS, '04-playback-paused.png') });

// ---- 需求 5: 测点 + 存读档复现 ----
console.log('需求5 测点与存读档');
await page.evaluate(() => window.__lab.app.debugAddPin('wall', 70));
await page.evaluate(() => window.__lab.app.debugAddPin('lid', 130));
const pinSnap = await snap();
check('测点可钉住多个', pinSnap.pinCount === 2);
await page.waitForTimeout(100);
const cards = await page.locator('.pin-card').count();
check('测点卡片渲染(含变形前后位置与目标标签)', cards === 2);
const cardText = await page.locator('.pin-card').first().innerText();
check('卡片包含变形前/后位置', cardText.includes('变形前') && cardText.includes('变形后'));
check('卡片包含目标参与标签', cardText.includes('鼓起') || cardText.includes('按凹') || cardText.includes('捏窄'));

const json = await page.evaluate(() => window.__lab.app.exportJSON());
const config = JSON.parse(json);
check('导出 JSON 含权重/测点/网格参数',
  !!config.weights && Array.isArray(config.pins) && config.pins.length === 2 && !!config.meshParams);

const beforeReload = await page.evaluate(() => {
  const g = window.__lab.app.built.wall.geometry;
  return Array.from(g.attributes.position.array.slice(0, 400));
});
const err = await page.evaluate((txt) => window.__lab.app.importJSON(txt), json);
check('载入返回无错误', err === null, err);
const afterReload = await page.evaluate(() => {
  const g = window.__lab.app.built.wall.geometry;
  return Array.from(g.attributes.position.array.slice(0, 400));
});
const identical = beforeReload.every((v, i) => Math.abs(v - afterReload[i]) < 1e-10);
check('重新载入后同一画面(顶点位置逐分量一致)', identical);
const afterPins = await snap();
check('测点随配置恢复', afterPins.pinCount === 2);

// 坏数据应被拒绝
const badErr = await page.evaluate(() =>
  window.__lab.app.importJSON(JSON.stringify({ version: 9, weights: {}, pins: [] })));
check('非法配置被拒绝并报错', typeof badErr === 'string' && badErr.length > 0);

// ---- 控制台错误汇总 ----
console.log('运行时错误');
check('全程无页面/控制台错误', pageErrors.length === 0, pageErrors.join(' | '));

await page.screenshot({ path: resolve(SHOTS, '05-final.png'), fullPage: false });
await browser.close();

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
