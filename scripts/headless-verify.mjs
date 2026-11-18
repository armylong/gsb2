/**
 * 无头自动化验证（不需要外部账户/服务，不下载浏览器）：
 *  1. 自动启动本地 Vite dev server
 *  2. 优先使用系统已装的 Chrome / Playwright 缓存 headless shell（SwiftShader 软件 WebGL）
 *  3. 页面内运行 7 项固定观察点像素验证（控制台 SSAO_VERIFY）
 *  4. 额外校验：实际渲染尺寸、分屏两侧 UV 映射像素级一致、窗口 resize 后采样仍正确
 *  5. 截图输出到 tmp/verify/（已在 .gitignore）
 *
 * 用法：npm run verify
 */
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const PORT = 5199;
const OUT_DIR = join(ROOT, 'tmp', 'verify');

/** 在目录下找第一个名字以 prefix 开头的子项，返回完整路径 */
function findChild(dir, prefix) {
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).find((n) => n.startsWith(prefix));
  return name ? join(dir, name) : null;
}

function findBrowser() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

  const cacheRoot = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
    : join(homedir(), '.cache', 'ms-playwright');

  if (process.platform === 'darwin') {
    const shellDir = findChild(cacheRoot, 'chromium_headless_shell-');
    if (shellDir) {
      const binDir = findChild(shellDir, 'chrome-headless-shell-mac-');
      const bin = binDir && join(binDir, 'chrome-headless-shell');
      if (bin && existsSync(bin)) return bin;
    }
    const chromiumDir = findChild(cacheRoot, 'chromium-');
    if (chromiumDir) {
      const appDir = findChild(chromiumDir, 'chrome-mac-');
      const bin = appDir && join(appDir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
      if (bin && existsSync(bin)) return bin;
    }
    const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (existsSync(systemChrome)) return systemChrome;
  } else {
    const shellDir = findChild(cacheRoot, 'chromium_headless_shell-');
    if (shellDir) {
      const binDir = findChild(shellDir, 'chrome-headless-shell-linux-');
      const bin = binDir && join(binDir, 'chrome-headless-shell');
      if (bin && existsSync(bin)) return bin;
    }
    const chromiumDir = findChild(cacheRoot, 'chromium-');
    if (chromiumDir) {
      const bin = join(chromiumDir, 'chrome-linux', 'chrome');
      if (existsSync(bin)) return bin;
    }
    for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium-browser']) {
      if (existsSync(p)) return p;
    }
  }
  throw new Error('未找到可用浏览器，请设置环境变量 CHROME_PATH 指向 Chrome/Chromium 可执行文件');
}

const pad = (s) => String(s).padEnd(6);
let extraFailures = 0;
const extraLog = [];
function check(name, ok, detail = '') {
  extraLog.push(`${pad(ok ? 'PASS' : 'FAIL')} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) extraFailures++;
}

const viteServer = await createServer({
  root: ROOT,
  configFile: join(ROOT, 'vite.config.ts'),
  server: { port: PORT, host: '127.0.0.1', strictPort: true },
  logLevel: 'warn',
}).then((s) => s.listen());

const browserPath = findBrowser();
console.log(`浏览器: ${browserPath}`);
const browser = await chromium.launch({
  headless: true,
  executablePath: browserPath,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--window-size=1400,900',
  ],
});

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const consoleLines = [];
  const verifyPayloads = [];
  const isNoise = (t) =>
    t.includes('GL_CLOSE_PATH_NV') ||
    t.includes('Framebuffer is incomplete') ||
    t.includes('INVALID_VALUE') ||
    t.includes('INVALID_ENUM') ||
    t.includes('texImage2D') ||
    t.includes('glTexStorage2D') ||
    t.includes('glRenderbufferStorage') ||
    t.includes('too many errors');
  page.on('console', (msg) => {
    const text = msg.text();
    if (!isNoise(text)) consoleLines.push(text);
    if (text.startsWith('SSAO_VERIFY')) {
      verifyPayloads.push(JSON.parse(text.slice('SSAO_VERIFY'.length).trim()));
    }
  });
  page.on('pageerror', (err) => {
    if (!isNoise(err.message)) consoleLines.push('PAGEERROR: ' + err.message);
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__ssaoDebug !== undefined, null, { timeout: 15000 });

  // ---- E1 实际渲染尺寸（面板宽 320，舞台 = 1400-320 = 1080；dpr 1）----
  const size1 = await page.evaluate(() => window.__ssaoDebug.getDrawingSize());
  check('初始实际渲染尺寸 = 1080x900', size1.width === 1080 && size1.height === 900, JSON.stringify(size1));
  // ---- E2 分屏 UV 映射：左右两半分别与对应单画面模式逐像素一致 ----
  // 50% 分屏时，源纹理 uv=u 在左半屏 NDC.x=2u-1、右半屏 NDC.x=2u+1；
  // 单画面时同一源点 NDC.x=2u-1。取 u=0.25/0.75，对应 NDC -0.5/0.5，
  // 均落在各自半屏中心，避开分界线 NDC=0 的取整边界。
  const sampleYs = [-0.55, -0.2, 0.15];
  const leftNdcX = -0.5; // 源 uv=0.25
  const rightNdcX = 0.5; // 源 uv=0.75

  const readAt = (x, y) => page.evaluate(([px, py]) => window.__ssaoDebug.readPixel(px, py), [x, y]);

  // 单画面 off / on 基准
  await page.check('input[name="view"][value="off"]');
  await page.waitForTimeout(120);
  const offAt = {};
  for (const y of sampleYs) {
    offAt[`L:${y}`] = await readAt(leftNdcX, y);
    offAt[`R:${y}`] = await readAt(rightNdcX, y);
  }

  await page.check('input[name="view"][value="on"]');
  await page.waitForTimeout(120);
  const onAt = {};
  for (const y of sampleYs) {
    onAt[`L:${y}`] = await readAt(leftNdcX, y);
    onAt[`R:${y}`] = await readAt(rightNdcX, y);
  }

  // 分屏：左=off，右=on
  await page.check('input[name="view"][value="split"]');
  await page.selectOption('#leftMode', 'off');
  await page.selectOption('#rightMode', 'on');
  await page.waitForTimeout(150);

  let splitMismatch = 0;
  const splitDetails = [];
  // 分屏与单画面采样同一源纹理像素，仅允许量化级误差（每通道 <=2）
  const channelDist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  for (const y of sampleYs) {
    const leftPx = await readAt(leftNdcX, y); // 左半屏中心（源 uv=0.25）
    const rightPx = await readAt(rightNdcX, y); // 右半屏中心（源 uv=0.75）
    const lErr = channelDist(leftPx, offAt[`L:${y}`]);
    const rErr = channelDist(rightPx, onAt[`R:${y}`]);
    if (lErr > 2) {
      splitMismatch++;
      splitDetails.push(`y=${y} 左半 ${JSON.stringify(leftPx)} vs 单画面off ${JSON.stringify(offAt[`L:${y}`])}`);
    }
    if (rErr > 2) {
      splitMismatch++;
      splitDetails.push(`y=${y} 右半 ${JSON.stringify(rightPx)} vs 单画面on ${JSON.stringify(onAt[`R:${y}`])}`);
    }
  }
  check('分屏两侧与对应单画面模式一致（UV 映射/透视不变，容差≤2）', splitMismatch === 0, splitDetails.join('；') || '6/6 一致');

  // ---- E3 容器尺寸变化：渲染尺寸跟随，readPixels 仍可采样 ----
  // 直接缩放舞台高度（宽度由 flex 保持 1080），等价于窗口/布局高度变化
  const expectedW = 1080;
  const targetH = 700;
  await page.evaluate((h) => {
    const stage = document.getElementById('stage');
    stage.style.height = `${h}px`;
    stage.style.alignSelf = 'flex-start';
  }, targetH);
  await page.waitForTimeout(300);
  const size2 = await page.evaluate(() => window.__ssaoDebug.getDrawingSize());
  let resizeOk = size2.width === expectedW && size2.height === targetH;
  let sampleAfterResize = null;
  try {
    // 取画面中心附近的场景像素（避开角点），确认缩放后采样链路仍然有效
    sampleAfterResize = await readAt(0.1, -0.1);
    resizeOk = resizeOk && Array.isArray(sampleAfterResize) && sampleAfterResize.length === 4 && sampleAfterResize[3] === 255;
  } catch {
    resizeOk = false;
  }
  check(`容器缩放后渲染尺寸与采样正确（${expectedW}x${targetH}）`, resizeOk, `${JSON.stringify(size2)} px=${JSON.stringify(sampleAfterResize)}`);
  await page.evaluate(() => {
    const stage = document.getElementById('stage');
    stage.style.height = '';
    stage.style.alignSelf = '';
  });
  await page.waitForTimeout(250);

  // ---- E4 切换单画面/分屏后控件与尺寸恢复 ----
  const size3 = await page.evaluate(() => window.__ssaoDebug.getDrawingSize());
  check('切回原窗口后尺寸恢复 1080x900', size3.width === 1080 && size3.height === 900, JSON.stringify(size3));

  // ---- 截图：分屏（off | on）与灰度图 ----
  mkdirSync(OUT_DIR, { recursive: true });
  await page.check('input[name="view"][value="split"]');
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(OUT_DIR, 'split-off-vs-on.png') });
  await page.check('input[name="view"][value="gray"]');
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(OUT_DIR, 'gray-ao.png') });

  // ---- 页面内置 7 项固定观察点验证 ----
  await page.click('#verifyBtn');
  await page.waitForEvent('console', (m) => m.text().startsWith('SSAO_VERIFY'), { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT_DIR, 'verify-result.png') });

  const payload = verifyPayloads.at(-1);
  console.log('\n================ 固定观察点像素验证（7 项）================');
  if (!payload) {
    console.log('未捕获 SSAO_VERIFY 输出，页面控制台：');
    console.log(consoleLines.filter((l) => l.includes('ERROR') || l.includes('PAGEERROR') || l.includes('SSAO')).join('\n'));
    process.exitCode = 1;
  } else {
    let pass = 0;
    for (const r of payload) {
      if (r.pass) pass++;
      console.log(`${pad(r.pass ? 'PASS' : 'FAIL')} ${r.id}  ${r.name}`);
      console.log(`       ${r.detail}`);
    }
    console.log(`\n内置验证: ${pass}/${payload.length} 通过`);
    if (pass !== payload.length) process.exitCode = 1;
  }

  console.log('\n================ 工程级额外检查 ================');
  console.log(extraLog.join('\n'));
  if (extraFailures > 0) process.exitCode = 1;

  const pageErrors = consoleLines.filter((l) => l.startsWith('PAGEERROR') || l.includes('WebGL'));
  if (pageErrors.length > 0) {
    console.log('\n页面错误/告警:');
    console.log(pageErrors.join('\n'));
  }
  console.log(`\n截图已写入: ${OUT_DIR}`);
} finally {
  await browser.close();
  await viteServer.close();
}
