// 浏览器冒烟测试：真实启动无头 Chromium 操作页面。
// 运行：node smoke/smoke.mjs（需先 npm run build；脚本会自己起 vite preview）
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHOTS = join(HERE, 'shots');
const DL = join(HERE, 'downloads');
const PORT = 4317;
const EXE = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

async function waitForPort(port, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.ok) return;
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('preview server 未启动');
}

function pngSize(buf) {
  // IHDR：字节 16..24 为宽高大端整数
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, stdio: 'ignore', shell: true,
});
await waitForPort(PORT);
await mkdir(SHOTS, { recursive: true });
await rm(DL, { recursive: true, force: true });
await mkdir(DL, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const downloads = [];
page.on('download', async (d) => {
  const path = join(DL, d.suggestedFilename());
  await d.saveAs(path);
  downloads.push({ name: d.suggestedFilename(), path });
});
page.on('pageerror', (e) => { failures++; console.log(`  ❌ 页面异常: ${e.message}`); });

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#canvas');
  await page.waitForFunction(() => window.__epi?.snapshot().hasModel === true);
  console.log('\n[1] 首屏默认歪叶片');
  let snap = await page.evaluate(() => window.__epi.snapshot());
  check('默认模型已加载', snap.hasModel);
  check('DFT 成分总数 = 采样数-1 = 359', snap.total === 359, `total=${snap.total}`);
  check('默认保留 24 个旋转圆', snap.keep === 24);
  await page.screenshot({ path: join(SHOTS, '01-trace-default.png') });

  console.log('\n[2] 展示顺序可换、轨迹不变（容差 1e-9，加法顺序仅产生机器级浮点差）');
  const head0 = snap.rebuiltHead, tail0 = snap.rebuiltTail;
  const close = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;
  for (const mode of ['amplitude', 'reverse', 'frequency']) {
    await page.click(`#order-mode button[data-order="${mode}"]`);
    const s = await page.evaluate(() => window.__epi.snapshot());
    check(
      `顺序 ${mode} 末端曲线保持`,
      close(s.rebuiltHead, head0) && close(s.rebuiltTail, tail0),
    );
  }

  console.log('\n[3] 保留数量：轮廓逐步恢复');
  await page.locator('#keep').fill('4');
  await page.waitForFunction(() => window.__epi.snapshot().keep === 4);
  const rms4 = (await page.evaluate(() => window.__epi.snapshot())).rms;
  await page.locator('#keep').fill('64');
  const rms64 = (await page.evaluate(() => window.__epi.snapshot())).rms;
  const total = (await page.evaluate(() => window.__epi.snapshot())).total;
  await page.locator('#keep').fill(String(total));
  const rmsFull = (await page.evaluate(() => window.__epi.snapshot())).rms;
  check('误差随保留数下降', rms4 > rms64 && rms64 > rmsFull, `${rms4.toFixed(2)} > ${rms64.toFixed(2)} > ${rmsFull.toExponential(1)}`);
  check('全保留近完全重建', rmsFull < 1e-9, `rms=${rmsFull.toExponential(2)}`);
  await page.locator('#keep').fill('24');

  console.log('\n[4] 播放控制：暂停 / 单步 / 拖进度');
  await page.click('#btn-play');
  const pausedText = await page.textContent('#btn-play');
  check('暂停按钮切换文案', pausedText === '播放');
  const p0 = (await page.evaluate(() => window.__epi.snapshot())).phase;
  await page.click('#btn-step-fwd');
  const p1 = (await page.evaluate(() => window.__epi.snapshot())).phase;
  check('单步前进 1/360 相位', Math.abs((p1 - p0 + 1) % 1 - 1 / 360) < 1e-9, `${p0.toFixed(4)}→${p1.toFixed(4)}`);
  await page.locator('#phase').fill('995');
  const pNearEnd = (await page.evaluate(() => window.__epi.snapshot())).phase;
  await page.screenshot({ path: join(SHOTS, '02-near-seam.png') });
  check('可拖到接近一圈结束', pNearEnd > 0.99, `phase=${pNearEnd}`);

  console.log('\n[5] 偏差视图与参照');
  await page.click('#btn-view-deviation');
  snap = await page.evaluate(() => window.__epi.snapshot());
  check('切到偏差视图', snap.view === 'deviation');
  check('色条图例显示', await page.isVisible('#heat-legend'));
  await page.screenshot({ path: join(SHOTS, '03-deviation.png') });
  const refPixels = await page.evaluate(() => {
    const nonBlank = (id) => {
      const cv = document.getElementById(id);
      const ctx = cv.getContext('2d');
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 30 || d[i + 1] > 30 || d[i + 2] > 30) n++;
      return n;
    };
    return { circle: nonBlank('ref-circle'), translated: nonBlank('ref-translated') };
  });
  check('两个参照小图已绘制', refPixels.circle > 500 && refPixels.translated > 500, JSON.stringify(refPixels));
  await page.click('#btn-view-trace');

  console.log('\n[6] 手画：闭合提示与吸附');
  const box = await page.locator('#canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  // 故意留 ~10% 缺口的椭圆
  await page.mouse.move(cx + 200, cy);
  await page.mouse.down();
  for (let i = 1; i <= 50; i++) {
    const a = (2 * Math.PI * 0.9 * i) / 50;
    await page.mouse.move(cx + 200 * Math.cos(a), cy + 150 * Math.sin(a));
  }
  await page.mouse.up();
  check('缺口提示出现', await page.isVisible('#closure-banner'));
  const bannerText = await page.textContent('#closure-banner');
  check('提示分级为 loose/open', /偏差|缺口/.test(bannerText), bannerText);
  check('处理按钮出现', await page.isVisible('#closure-actions'));
  await page.screenshot({ path: join(SHOTS, '04-closure-prompt.png') });
  await page.click('#closure-actions button[data-close="auto-close"]');
  snap = await page.evaluate(() => window.__epi.snapshot());
  check('吸附闭合后生成新模型', snap.hasModel && snap.total === 359);

  console.log('\n[7] 反向手画：最大成分的频率符号翻转');
  // 先用桥接分支提交一笔带缺口的线，验证 bridge-line 路径可用
  await page.mouse.move(cx + 160, cy);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    const a = (2 * Math.PI * 0.88 * i) / 40;
    await page.mouse.move(cx + 160 * Math.cos(a), cy + 120 * Math.sin(a));
  }
  await page.mouse.up();
  await page.waitForSelector('#closure-actions button:not(.hidden)');
  await page.click('#closure-actions button[data-close="bridge-line"]');
  snap = await page.evaluate(() => window.__epi.snapshot());
  check('直线桥接后模型生成', snap.hasModel && snap.total === 359);

  // keep-open：开放折线也能跑完整条流水线（DFT 把它当周期信号）
  await page.mouse.move(cx + 150, cy);
  await page.mouse.down();
  for (let i = 1; i <= 36; i++) {
    const a = (2 * Math.PI * 0.85 * i) / 36;
    await page.mouse.move(cx + 150 * Math.cos(a), cy + 110 * Math.sin(a));
  }
  await page.mouse.up();
  await page.waitForSelector('#closure-actions');
  await page.click('#closure-actions button[data-close="keep-open"]');
  snap = await page.evaluate(() => window.__epi.snapshot());
  check('保留缺口分支可生成模型', snap.hasModel);

  const exportJsonAndRead = async () => {
    await page.click('#btn-export-json');
    await page.waitForTimeout(300);
    const dl = downloads[downloads.length - 1];
    return JSON.parse(await readFile(dl.path, 'utf8'));
  };
  const drawEllipse = async (clockwise) => {
    await page.mouse.move(cx + 180, cy);
    await page.mouse.down();
    for (let i = 1; i <= 60; i++) {
      const a = (2 * Math.PI * i) / 60;
      const ang = clockwise ? -a : a;
      await page.mouse.move(cx + 180 * Math.cos(ang), cy + 130 * Math.sin(ang));
    }
    await page.mouse.up();
    await page.waitForTimeout(150);
  };
  await drawEllipse(false);
  const jsonCCW = await exportJsonAndRead();
  const topA = jsonCCW.components.filter((c) => c.k !== 0).sort((a, b) => b.radius - a.radius)[0];
  await drawEllipse(true);
  const jsonCW = await exportJsonAndRead();
  const topB = jsonCW.components.filter((c) => c.k !== 0).sort((a, b) => b.radius - a.radius)[0];
  check('反向手画使主导圆旋转方向翻转', Math.sign(topA.k) === -Math.sign(topB.k), `k: ${topA.k} vs ${topB.k}`);
  // 每次提交后取景会重新缩放，绝对半径不可直接比；按各自包围盒归一化
  const bboxMax = (json) => {
    const xs = json.originalPath.map((p) => p.x), ys = json.originalPath.map((p) => p.y);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  };
  const ratioA = topA.radius / bboxMax(jsonCCW);
  const ratioB = topB.radius / bboxMax(jsonCW);
  check('归一化后主导圆占比接近（形状相同）', Math.abs(ratioA - ratioB) / Math.max(ratioA, ratioB) < 0.08,
    `${ratioA.toFixed(3)} vs ${ratioB.toFixed(3)}`);

  console.log('\n[8] 导出：尺寸独立于网页缩放 + 无跨首尾连线');
  await page.locator('#exp-w').fill('2000');
  await page.locator('#exp-h').fill('1000');
  await page.click('#btn-export-png');
  await page.waitForTimeout(400);
  const pngDl = downloads.find((d) => d.name.endsWith('.png'));
  check('PNG 已下载', !!pngDl);
  if (pngDl) {
    const size = pngSize(await readFile(pngDl.path));
    check('PNG 尺寸等于指定导出尺寸（与网页缩放无关）', size.width === 2000 && size.height === 1000, JSON.stringify(size));
  }
  const svgDl = downloads.find((d) => d.name.endsWith('.svg'));
  if (!svgDl) { await page.click('#btn-export-svg'); await page.waitForTimeout(300); }
  const svg = await readFile(downloads.find((d) => d.name.endsWith('.svg')).path, 'utf8');
  const rebuiltLine = svg.split('\n').find((l) => l.includes('#d95926'));
  check('SVG 重建路径不含闭合指令 Z（无跨画布连线）', rebuiltLine && !rebuiltLine.includes('Z'));
  const json = downloads.filter((d) => d.name.endsWith('.json')).pop();
  const parsed = JSON.parse(await readFile(json.path, 'utf8'));
  check('JSON 含圆成分与一圈路径', parsed.components.length > 1 && parsed.rebuiltPath.length === 360);
  check('JSON 记录偏差统计', parsed.deviation && typeof parsed.deviation.rmsShapeError === 'number');

  console.log('\n[8b] 非法导出尺寸回退到安全值');
  await page.locator('#exp-w').fill('0');
  await page.locator('#exp-h').fill('');
  await page.click('#btn-export-png');
  await page.waitForTimeout(400);
  const fallbackPng = downloads[downloads.length - 1];
  const fallbackSize = pngSize(await readFile(fallbackPng.path));
  check('非法尺寸回退 1600×1200', fallbackSize.width === 1600 && fallbackSize.height === 1200, JSON.stringify(fallbackSize));
  await page.locator('#exp-w').fill('2000');
  await page.locator('#exp-h').fill('1000');

  console.log('\n[8c] 两个预设均可加载');
  await page.click('#btn-preset-lop');
  snap = await page.evaluate(() => window.__epi.snapshot());
  check('不对称轮廓加载', snap.hasModel && snap.keep === 24);
  await page.screenshot({ path: join(SHOTS, '06-lopsided.png') });
  await page.click('#btn-preset-circle');
  snap = await page.evaluate(() => window.__epi.snapshot());
  // 预设圆经过等弧长重采样（折线弦近似），非数学完美圆；残差应小于半径的 0.5%
  check('正圆参照加载且 24 圆近完全恢复', snap.hasModel && snap.rms < 0.6, `rms=${snap.rms.toExponential(1)}（半径≈120）`);
  await page.click('#btn-preset-leaf');

  console.log('\n[9] 页面内自检面板');
  await page.click('#btn-checks');
  await page.waitForSelector('#check-list li');
  const items = await page.$$eval('#check-list li', (els) => els.map((e) => ({
    pass: e.classList.contains('pass'), text: e.textContent.slice(0, 24),
  })));
  check('自检列出 9 项且全部通过', items.length === 9 && items.every((i) => i.pass), `${items.filter((i) => i.pass).length}/9`);
  await page.screenshot({ path: join(SHOTS, '05-checks.png') });
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${failures === 0 ? '🎉 浏览器冒烟全部通过' : `⚠️ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
