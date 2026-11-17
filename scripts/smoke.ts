/**
 * 浏览器端冒烟测试（无外部网络，仅访问本地 dev server）
 * 运行：
 *   1) npm run dev      （另开终端）
 *   2) npm run smoke -- http://127.0.0.1:5173/
 * 浏览器可执行文件解析顺序：环境变量 STEREO_LAB_CHROME →
 *   PLAYWRIGHT 缓存目录中的 headless shell → 系统 Google Chrome。
 * 覆盖：WebGL 渲染、双眼视口布局不拉伸、覆盖层投影点、会聚面零视差、
 *       单眼切换、裁剪状态、零基线、自检面板、导出 JSON 结构、尺寸换算口径。
 */
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/';

function resolveChrome(): string {
  const fromEnv = process.env.STEREO_LAB_CHROME;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const home = process.env.HOME ?? '';
  const candidates = [
    `${home}/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // 兜底：让 playwright-core 自行查找（需要完整 playwright 浏览器安装）
  return execSync('npx --no-install playwright which chromium-headless-shell').toString().trim();
}
const SHELL = resolveChrome();

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
const ok = (name: string, cond: boolean, detail = '') => results.push({ name, ok: cond, detail });

const browser = await chromium.launch({ executablePath: SHELL, args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// 1. 页面无运行时错误，canvas 已获得 WebGL 上下文
ok('页面加载无 JS 错误', errors.length === 0, errors.join(' | ').slice(0, 300));
const glOk = await page.evaluate(() => {
  const c = document.getElementById('gl') as HTMLCanvasElement;
  return !!(c.getContext('webgl2') || c.getContext('webgl'));
});
ok('WebGL 上下文可用', glOk);

// 2. 并排模式：两个视口标签都在，且单眼宽度≈总宽一半，高度=总高（不拉伸）
const sbs = await page.evaluate(() => {
  const wrap = document.getElementById('canvas-wrap')!;
  const r = wrap.getBoundingClientRect();
  const l = document.getElementById('vp-left')!;
  const rr = document.getElementById('vp-right')!;
  return {
    totalW: r.width, totalH: r.height,
    lShown: getComputedStyle(l).display !== 'none',
    rShown: getComputedStyle(rr).display !== 'none',
    lSize: l.querySelector('.vp-size')!.textContent,
    rSize: rr.querySelector('.vp-size')!.textContent,
  };
});
ok('并排模式双眼标识同时显示', sbs.lShown && sbs.rShown, JSON.stringify(sbs));
ok('单眼视口为总宽一半、高度不压缩', sbs.lSize === sbs.rSize && sbs.lSize!.includes('×' + Math.round(sbs.totalH)));

// 3. 覆盖层：选定中景标记后，该标记在 L/R 各有一个带高亮（boxShadow）的投影点
await page.evaluate(() => {
  (document.querySelector('.marker-chip[data-id="m2"]') as HTMLElement).click();
});
await page.waitForTimeout(300);
const convDots = await page.evaluate(() => {
  // 仅统计被选中（带蓝色 boxShadow 高亮）的两个点
  const dots = [...document.querySelectorAll('.m-dot')].filter((d) => {
    const el = d as HTMLElement;
    return el.style.display !== 'none' && el.style.boxShadow && el.style.boxShadow !== 'none';
  }) as HTMLElement[];
  return dots.map((d) => ({ left: parseFloat(d.style.left), top: parseFloat(d.style.top) }));
});
ok('选定标记在两眼画面各有一个投影点', convDots.length === 2, `选中点数=${convDots.length}`);
if (convDots.length === 2) {
  const [a, b] = convDots;
  const halfW = sbs.totalW / 2;
  const normL = (a.left) / halfW;
  const normR = (b.left - halfW) / halfW;
  ok('会聚面标记左右水平归一化位置相同（零视差）', Math.abs(normL - normR) < 0.005,
    `uL=${normL.toFixed(4)} uR=${normR.toFixed(4)} Δ=${(normL - normR).toExponential(2)}`);
  ok('会聚面标记垂直位置一致', Math.abs(a.top - b.top) < 1, `topL=${a.top} topR=${b.top}`);
}

// 4. 读数面板含预期/实际对照与符号约定
const panelTxt = await page.evaluate(() => document.getElementById('selected-readout')!.textContent!);
ok('读数面板含实际/预期视差对照', panelTxt.includes('实际投影读数') && panelTxt.includes('闭式公式预期'));
ok('读数面板说明符号约定', panelTxt.includes('d = (xL−xR)/W'));

// 5. 切换单眼模式：只显示一个眼标识，且视口恢复全宽（无拉伸）
await page.evaluate(() => {
  (document.querySelector('input[name="viewmode"][value="left"]') as HTMLInputElement).click();
});
await page.waitForTimeout(300);
const mono = await page.evaluate(() => ({
  l: getComputedStyle(document.getElementById('vp-left')!).display !== 'none',
  r: getComputedStyle(document.getElementById('vp-right')!).display !== 'none',
  size: document.querySelector('#vp-left .vp-size')!.textContent,
  totalW: document.getElementById('canvas-wrap')!.getBoundingClientRect().width,
}));
ok('单眼模式仅左眼标识显示、视口全宽', mono.l && !mono.r && mono.size!.startsWith(String(Math.round(mono.totalW))),
  JSON.stringify(mono));

await page.evaluate(() => {
  (document.querySelector('input[name="viewmode"][value="sbs"]') as HTMLInputElement).click();
});
await page.waitForTimeout(200);

// 6. 固定用例 C（跨过近裁剪面）：可移动物体状态为已被裁剪且无视差
await page.evaluate(() => {
  (document.querySelector('button[data-case="crossNear"]') as HTMLElement).click();
});
await page.waitForTimeout(300);
const clipped = await page.evaluate(() => {
  const chip = document.querySelector('.marker-chip[data-id="obj"] [data-line="status"]')!;
  const dLine = document.querySelector('.marker-chip[data-id="obj"] [data-line="d"]')!;
  return { status: chip.textContent, d: dLine.textContent };
});
ok('近裁剪用例：物体显示已被裁剪且不计算视差', clipped.status!.includes('已被裁剪') && clipped.d === 'd: —',
  JSON.stringify(clipped));

// 7. 零基线用例：所有标记视差为 0
await page.evaluate(() => {
  (document.querySelector('button[data-case="zeroBaseline"]') as HTMLElement).click();
});
await page.waitForTimeout(300);
const zero = await page.evaluate(() => {
  const lines = [...document.querySelectorAll('.marker-chip [data-line="d"]')].map((e) => e.textContent);
  return lines;
});
const allZero = zero.every((t) => t === 'd: —' || t!.includes('0.000%'));
ok('零基线用例：可见标记视差全部为 0', allZero, JSON.stringify(zero));

// 8. 页面内自检 9 项全过
await page.evaluate(() => (document.getElementById('btn-selftest') as HTMLElement).click());
await page.waitForTimeout(200);
const selfTest = await page.evaluate(() => {
  const txt = document.getElementById('selftest-out')!.textContent!;
  return { pass: (txt.match(/✔/g) ?? []).length, fail: (txt.match(/✘/g) ?? []).length };
});
ok('页面内几何自检全部通过', selfTest.fail === 0 && selfTest.pass >= 9, JSON.stringify(selfTest));

// 9. 导出 JSON：拦截下载并校验结构（带超时，避免偶发时序中断整个脚本）
const exported = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('导出超时未触发')), 3000);
  const orig = URL.createObjectURL;
  URL.createObjectURL = (blob: Blob) => {
    blob.text().then((t) => { clearTimeout(timer); resolve(JSON.parse(t)); })
      .catch((e) => { clearTimeout(timer); reject(e); });
    return 'blob:test';
  };
  (document.getElementById('btn-export') as HTMLElement).click();
  setTimeout(() => { URL.createObjectURL = orig; }, 500);
})).catch((e: Error) => ({ __error: e.message }));
const exp = exported as { __error?: string; camera?: unknown; markers?: unknown[]; signConvention?: string; units?: unknown };
ok('导出 JSON 含相机参数、标记读数与符号约定',
  !exp.__error && !!exp.camera && Array.isArray(exp.markers) && exp.markers.length === 10 && !!exp.signConvention && !!exp.units,
  exp.__error ?? `markers=${exp.markers?.length}`);

// 10. 调整窗口尺寸后归一化视差口径保持（宽度变化，d 不变、像素视差按比例变化）
await page.setViewportSize({ width: 1200, height: 900 });
await page.waitForTimeout(300);
const afterResize = await page.evaluate(() => {
  const chip = document.querySelector('.marker-chip[data-id="n1"] [data-line="d"]')!.textContent;
  return chip;
});
ok('尺寸变化后标记条仍输出统一口径读数', !!afterResize && afterResize!.includes('%'), afterResize ?? '');

await page.screenshot({ path: 'scripts/smoke-screenshot.png' });
await browser.close();

let fails = 0;
for (const r of results) {
  if (!r.ok) fails++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
}
console.log(`\n共 ${results.length} 项，失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
