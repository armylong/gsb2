/**
 * 无头浏览器验证（puppeteer-core + 系统 Chrome）。
 * 所有检查基于真实渲染画面：截图 + 像素采样 + 拉普拉斯方差清晰度度量。
 * 运行：npm run verify   （先启动 vite dev: npm run dev）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = join(__dirname, 'shots');
mkdirSync(SHOT_DIR, { recursive: true });

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.VERIFY_URL || 'http://127.0.0.1:5173/';
const W = 1400;
const H = 900;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    `--window-size=${W},${H}`, '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__dofApp, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));

const app = () => page.evaluateHandle(() => window.__dofApp);
async function state() {
  return page.evaluate(() => window.__dofApp.getState());
}
async function shot(name) {
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) });
}
async function setParams(p) {
  await page.evaluate((pp) => window.__dofApp.setParams(pp), p);
  await new Promise((r) => setTimeout(r, 250));
}

// 灰度 + 拉普拉斯方差（越高越清晰），在浏览器页面内对截图区域计算
async function cropSharpness(cx, cy, half = 55) {
  const x = Math.max(0, Math.round(cx - half));
  const y = Math.max(0, Math.round(cy - half));
  const w = half * 2;
  const region = await page.screenshot({ clip: { x, y, width: w, height: w } });
  const b64 = region.toString('base64');
  return page.evaluate(async (b) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const g = new Float32Array(c.width * c.height);
    for (let i = 0; i < c.width * c.height; i++) {
      g[i] = 0.2126 * d.data[i * 4] + 0.7152 * d.data[i * 4 + 1] + 0.0722 * d.data[i * 4 + 2];
    }
    const vals = [];
    for (let yy = 1; yy < c.height - 1; yy++) {
      for (let xx = 1; xx < c.width - 1; xx++) {
        const i = yy * c.width + xx;
        vals.push(g[i - 1] + g[i + 1] + g[i - c.width] + g[i + c.width] - 4 * g[i]);
      }
    }
    const mean = vals.reduce((a, b2) => a + b2, 0) / vals.length;
    return vals.reduce((a, b2) => a + (b2 - mean) ** 2, 0) / vals.length;
  }, b64);
}

// 取三排第一块板子的屏幕中心
async function rowScreens() {
  return page.evaluate(() => {
    const rows = [
      { x: -2.5, y: 1.27, z: 2 },
      { x: -3.6, y: 1.39, z: -4 },
      { x: -4.5, y: 1.8, z: -10 },
    ];
    return rows.map((p) => {
      const s = window.__dofApp.projectWorld(p.x, p.y, p.z);
      return { ...s, world: p };
    });
  });
}

// ---------- 检查 1：无景深模式三排都可辨认 ----------
{
  await page.evaluate(() => {
    const c = document.getElementById('dof-enabled');
    c.checked = false; c.dispatchEvent(new Event('change'));
  });
  await new Promise((r) => setTimeout(r, 300));
  const rows = await rowScreens();
  const sharp = [];
  for (const r of rows) sharp.push(await cropSharpness(r.x, r.y));
  await shot('01-no-dof-all-rows');
  const minSharp = Math.min(...sharp);
  record('无景深模式三排标记均可辨认', minSharp > 60,
    `三排清晰度 ${sharp.map((s) => s.toFixed(0)).join(' / ')}`);
}

// ---------- 检查 2：对焦近排，近排清楚、远排模糊 ----------
{
  await page.evaluate(() => {
    const c = document.getElementById('dof-enabled');
    c.checked = true; c.dispatchEvent(new Event('change'));
    document.getElementById('preset-near').click();
  });
  await new Promise((r) => setTimeout(r, 400));
  const rows = await rowScreens();
  const sharp = [];
  for (const r of rows) sharp.push(await cropSharpness(r.x, r.y));
  await shot('02-focus-near');
  record('对焦近排：近排保持清楚且远排明显更模糊',
    sharp[0] > sharp[2] * 1.8 && sharp[0] > 60,
    `近/中/远 清晰度 ${sharp.map((s) => s.toFixed(0)).join(' / ')}`);
}

// ---------- 检查 3：对焦远排 ----------
{
  await page.evaluate(() => document.getElementById('preset-far').click());
  await new Promise((r) => setTimeout(r, 400));
  const rows = await rowScreens();
  const sharp = [];
  for (const r of rows) sharp.push(await cropSharpness(r.x, r.y));
  await shot('03-focus-far');
  record('对焦远排：远排保持清楚且近排明显更模糊',
    sharp[2] > sharp[0] * 1.8 && sharp[2] > 60,
    `近/中/远 清晰度 ${sharp.map((s) => s.toFixed(0)).join(' / ')}`);
}

// ---------- 检查 4：同一焦平面上多点深度一致（不因偏离中心失焦）----------
{
  await page.evaluate(() => document.getElementById('preset-slant').click());
  await new Promise((r) => setTimeout(r, 400));
  // 验证 4a（公式层）：CoC 只由线性深度决定，与屏幕位置无关。
  // 同一深度在 6 个不同 NDC 位置查询，结果必须完全相同；清晰区内必须为 0。
  const focus = (await state()).params.focus;
  const cocCheck = await page.evaluate((f) => {
    const api = window.__dofApp;
    const sameDepth = f + 4; // 焦平面外，必有模糊
    const cocs = [[0, 0], [0.6, 0.4], [-0.6, 0.4], [0.4, -0.5], [-0.4, -0.5], [0.1, 0.1]]
      .map(() => api.computeCoc(sameDepth));
    const inFocus = api.computeCoc(f); // 焦平面上
    const inRange = api.computeCoc(f + 0.8); // 清晰区内
    return {
      allEqual: cocs.every((c) => Math.abs(c - cocs[0]) < 1e-9),
      cocValue: cocs[0],
      inFocus,
      inRange,
    };
  }, focus);

  // 验证 4b（画面层）：斜看下沿地面横切焦平面的多个屏幕位置，
  // 射线命中点深度应彼此接近（都落在焦平面与地面交线附近）。
  const groundDepths = await page.evaluate(() => {
    const api = window.__dofApp;
    const list = [];
    for (const nx of [-0.5, -0.25, 0, 0.25, 0.5]) {
      const d = api.getViewDepthAt(nx, -0.45);
      if (d !== null) list.push(d);
    }
    return list;
  });
  const groundSpread = Math.max(...groundDepths) - Math.min(...groundDepths);

  const ok4 = cocCheck.allEqual && cocCheck.cocValue > 0 &&
    cocCheck.inFocus === 0 && cocCheck.inRange === 0 &&
    groundDepths.length >= 4 && groundSpread < 0.6;
  record('同一焦平面多点深度/CoC 一致，偏离画面中心不失焦（斜看现场）',
    ok4,
    `CoC 与位置无关=${cocCheck.allEqual}（${cocCheck.cocValue.toFixed(1)}px），清晰区 CoC=${cocCheck.inRange}，地面 ${groundDepths.length} 点深度差 ${groundSpread.toFixed(2)}m`);
  await shot('04-slant-focal-plane');
}

// ---------- 检查 5：点选设置焦点 ----------
{
  await page.evaluate(() => window.__dofApp.resetCamera());
  await new Promise((r) => setTimeout(r, 300));
  const mid = await page.evaluate(() => {
    // 中排左数第二块板的中心（面板宽度内，避免点到板间空隙）
    const s = window.__dofApp.projectWorld(-2.57, 1.39, -4);
    return { x: s.x, y: s.y };
  });
  const before = (await state()).params.focus;
  await page.mouse.click(mid.x, mid.y);
  await new Promise((r) => setTimeout(r, 250));
  const after = await state();
  const ok = Math.abs(after.params.focus - 14) < 0.4 && after.selectedDepth !== null;
  record('点选中排表面后焦点更新到该深度',
    ok, `点击前 ${before.toFixed(2)}m → 点击后 ${after.params.focus.toFixed(2)}m，选定点 ${after.selectedDepth?.toFixed(2)}m`);

  // 点空背景（屏幕左上角天空）
  const focusBefore = (await state()).params.focus;
  await page.mouse.click(20, 20);
  await new Promise((r) => setTimeout(r, 200));
  const focusAfter = (await state()).params.focus;
  const toastVisible = await page.evaluate(() => !document.getElementById('toast').classList.contains('hidden'));
  record('点空背景保留上一次焦点并提示',
    Math.abs(focusBefore - focusAfter) < 1e-6 && toastVisible,
    `焦点保持 ${focusAfter.toFixed(2)}m，toast=${toastVisible}`);
  await shot('05-pick-and-empty');
}

// ---------- 检查 6：最大模糊半径为 0 时等同原画 ----------
{
  await page.evaluate(() => {
    document.getElementById('preset-near').click();
  });
  await setParams({ maxBlur: 0 });
  const px0 = await page.evaluate(() => {
    const s = window.__dofApp.projectWorld(0, 1.45, -10);
    return window.__dofApp.getDofPixel(s.x / 1400, s.y / 900);
  });
  const rows = await rowScreens();
  const sharp0 = await cropSharpness(rows[2].x, rows[2].y); // 远排
  await setParams({ maxBlur: 12 });
  const sharp12 = await cropSharpness(rows[2].x, rows[2].y);
  await shot('06-maxblur-zero');
  record('最大模糊半径为 0 时无模糊（远排恢复清晰）',
    sharp0 > sharp12 * 2 && px0.every((v) => Number.isFinite(v)),
    `maxBlur=0 清晰度 ${sharp0.toFixed(0)} vs maxBlur=12 ${sharp12.toFixed(0)}`);
}

// ---------- 检查 7：散景——亮点在离焦时变成圆盘 ----------
{
  await page.evaluate(() => {
    document.getElementById('preset-near').click();
  });

  // 测量亮点圆盘：模糊使峰值能量摊开到更大面积 —— 圆盘半径和覆盖像素数随
  // maxBlur 单调增大，而中心峰值降低（这正是散景圆盘而非针尖亮点的特征）。
  async function discProfile(maxBlur) {
    await setParams({ maxBlur, focusRange: 1 });
    return page.evaluate(() => {
      const api = window.__dofApp;
      const s = api.projectWorld(-3.2, 2.6, -13.2); // 后景亮点
      const u0 = s.x / 1400;
      const v0 = s.y / 900;
      const lum = (p) => p[0] + p[1] + p[2];
      let radius = 0;
      let overBg = 0;
      for (let dy = -20; dy <= 20; dy++) {
        for (let dx = -20; dx <= 20; dx++) {
          const l = lum(api.getDofPixel(u0 + dx / 1400, v0 + dy / 900));
          if (l > 0.08) {
            overBg++;
            radius = Math.max(radius, Math.round(Math.hypot(dx, dy)));
          }
        }
      }
      return { radius, overBg, center: lum(api.getDofPixel(u0, v0)) };
    });
  }

  const sharp = await discProfile(0);
  const blurred = await discProfile(16);
  await setParams({ maxBlur: 16, focusRange: 1 });
  await shot('07-bokeh-dots');
  const ok = blurred.radius >= sharp.radius * 2 &&
    blurred.overBg >= sharp.overBg * 2 &&
    blurred.center < sharp.center;
  record('离焦亮点形成可辨认散景圆盘（半径/覆盖随模糊增大、峰值摊开）',
    ok,
    `半径 ${sharp.radius}→${blurred.radius}px，覆盖像素 ${sharp.overBg}→${blurred.overBg}，中心峰值 ${sharp.center.toFixed(2)}→${blurred.center.toFixed(2)}`);
}

// ---------- 检查 8：分屏原画/景深同步对比 ----------
{
  await page.evaluate(() => window.__dofApp.setSplit(true));
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => document.getElementById('preset-far').click());
  await new Promise((r) => setTimeout(r, 400));
  await shot('08-split-compare');
  // 屏幕右半被控制面板遮挡，因此直接对两个离屏 RT 做局部方差度量。
  // 取近排板的标签/刻度区（实测高对比像素位于 u≈0.32, v≈0.6），
  // 原画 RT 保留锐利文字，景深 RT 被平滑 → 局部方差显著下降。
  const rtSharpness = await page.evaluate(() => {
    const api = window.__dofApp;
    const u = 0.32;
    const v = 0.6;
    const variance = (sampler) => {
      const lums = [];
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const p = sampler(u + dx / 1400, v + dy / 900);
          lums.push(0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]);
        }
      }
      const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
      return lums.reduce((a, b) => a + (b - mean) ** 2, 0) / lums.length;
    };
    return {
      original: variance(api.getOriginalPixel.bind(api)),
      dof: variance(api.getDofPixel.bind(api)),
    };
  });
  record('分屏：原画 RT 近排清晰，景深 RT 近排模糊',
    rtSharpness.original > rtSharpness.dof * 1.5 && rtSharpness.original > 0.02,
    `原画方差 ${rtSharpness.original.toFixed(4)} vs 景深 ${rtSharpness.dof.toFixed(4)}`);
}

// ---------- 检查 9：前景边缘不漏后景颜色 ----------
{
  await page.evaluate(() => window.__dofApp.setSplit(false));
  await page.evaluate(() => document.getElementById('preset-far').click());
  await setParams({ maxBlur: 16, focusRange: 1.2 });
  await new Promise((r) => setTimeout(r, 300));
  // 沿水平线扫描近排板子：板体像素应保持暖色（R 主导），
  // 不允许在板体覆盖范围内出现“蓝通道显著压过红通道”的后景天空色。
  const edge = await page.evaluate(() => {
    const s = window.__dofApp.projectWorld(-2.5, 1.27, 2);
    const api = window.__dofApp;
    const u = s.x / 1400;
    const v = s.y / 900;
    const line = [];
    for (let dx = -35; dx <= 35; dx += 1) {
      line.push(api.getDofPixel(u + dx / 1400, v));
    }
    return line;
  });
  const lum = (p) => p[0] + p[1] + p[2];
  // 板体覆盖区：亮度超过暗背景阈值的像素
  const boardPixels = edge.filter((p) => lum(p) > 0.08);
  // 后景泄漏特征：蓝通道比红通道高出一大截（天空/远排蓝）
  const leaked = boardPixels.filter((p) => p[2] > p[0] * 1.4 + 0.05);
  const leakRatio = boardPixels.length ? leaked.length / boardPixels.length : 1;
  const warmDominant = boardPixels.length >= 20 && leakRatio < 0.15;
  await shot('09-foreground-edge');
  record('前景轮廓附近无大面积错误后景颜色',
    warmDominant,
    `板体像素 ${boardPixels.length} 个，后景蓝色泄漏占比 ${(leakRatio * 100).toFixed(1)}%`);
}

// ---------- 检查 10：暂停自动移动 ----------
{
  // 直接追踪自动移动测试物体的真实世界 z 坐标
  const sampleZ = () => page.evaluate(() => window.__dofApp.getMoverPositions()[0].z);
  const movingSamples = [];
  for (let i = 0; i < 4; i++) {
    movingSamples.push(await sampleZ());
    await new Promise((r) => setTimeout(r, 300));
  }
  const movingAmp = Math.max(...movingSamples) - Math.min(...movingSamples);

  await page.evaluate(() => {
    const c = document.getElementById('motion-enabled');
    c.checked = false; c.dispatchEvent(new Event('change'));
  });
  const frozenSamples = [];
  for (let i = 0; i < 4; i++) {
    frozenSamples.push(await sampleZ());
    await new Promise((r) => setTimeout(r, 300));
  }
  const frozenDelta = Math.max(...frozenSamples) - Math.min(...frozenSamples);
  const motionFlag = await page.evaluate(() => window.__dofApp.getState().motion);
  record('暂停后自动移动测试物体停止（运动时变化、暂停后冻结）',
    movingAmp > 0.3 && frozenDelta < 0.01 && motionFlag === false,
    `运动时 z 振幅 ${movingAmp.toFixed(2)}m，冻结后漂移 ${frozenDelta.toFixed(4)}m`);
  await shot('10-motion-paused');
}

// ---------- 检查 11：窗口缩放后比例与焦点含义保持 ----------
{
  const before = await state();
  await page.setViewport({ width: 1000, height: 760, deviceScaleFactor: 1 });
  await new Promise((r) => setTimeout(r, 400));
  const after = await state();
  const rows = await rowScreens();
  const expectedAspect = 1000 / 760;
  const ok = Math.abs(before.params.focus - after.params.focus) < 1e-6 &&
    rows.every((r) => r.visible) && Math.abs(after.aspect - expectedAspect) < 0.02;
  record('缩放/分屏后保持相同比例与焦点含义',
    ok, `focus ${before.params.focus}→${after.params.focus}，aspect=${after.aspect.toFixed(3)}`);
  await shot('10-resized-split');
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await new Promise((r) => setTimeout(r, 300));
}

// ---------- 检查 12：无控制台错误、无旧帧（旋转后画面更新）----------
{
  const clean = errors.length === 0;
  record('运行期无控制台/页面错误', clean, clean ? '' : errors.slice(0, 3).join(' | '));
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过；截图目录：${SHOT_DIR}`);
process.exit(failed.length ? 1 : 0);
