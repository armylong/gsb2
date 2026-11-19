/**
 * e2e.mjs — 无头 Chromium 真实页面验证（playwright-core 复用系统缓存浏览器）
 *
 * 覆盖：
 *  1. 页面加载无控制台错误，WebGL 引擎初始化成功
 *  2. 页面内「独立核对」全部通过（解析 vs 256 条光线）
 *  3. 检查点读数：解析值、采样值、GPU 像素反推值三方一致
 *  4. 模拟拖动光源与挡板，状态与画面实时更新且无异常
 *  5. 非法位置（光源拖入挡板）被拒绝并出现错误状态
 *  6. 三组预设均可切换；r=0 时点光源对照视图为硬阴影
 *  7. 窗口缩放后读数仍与画面一致
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const port = 4178;

// 极简静态服务器，直接服务 dist/（先 npm run build）
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };
const server = createServer((req, res) => {
  let path = req.url.split('?')[0];
  if (path === '/') path = '/index.html';
  const file = join(root, 'dist', path);
  if (!existsSync(file)) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  res.setHeader('Content-Type', mime[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream');
  res.end(readFileSync(file));
});

await new Promise((r) => server.listen(port, '127.0.0.1', r));
const url = `http://127.0.0.1:${port}/`;

const candidates = [
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const exe = candidates.find((p) => existsSync(p));
if (!exe) throw new Error('未找到可用的 Chromium/Chrome，请安装 playwright 或 Google Chrome');
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

const fail = (msg) => {
  console.error('✗ ' + msg);
  process.exitCode = 1;
};
const ok = (msg) => console.log('✓ ' + msg);

// 1. 加载
await page.goto(url);
await page.waitForSelector('#engineBadge');
await page.waitForTimeout(500);
const badge = await page.textContent('#engineBadge');
if (badge.includes('WebGL')) ok('WebGL 引擎初始化：' + badge.trim());
else fail('引擎未走 WebGL：' + badge);

// 2. 运行页面内核对
await page.click('#verifyBtn');
await page.waitForTimeout(300);
const failRows = await page.$$eval('#verifyTable tbody tr', (trs) =>
  trs.filter((tr) => tr.querySelector('.fail')).map((tr) => tr.textContent),
);
const rowCount = await page.$$eval('#verifyTable tbody tr', (trs) => trs.length);
if (rowCount >= 6 && failRows.length === 0) ok(`页面内独立核对 ${rowCount} 项全部通过`);
else fail(`核对存在失败行：${JSON.stringify(failRows)}`);
const summary = await page.textContent('#verifySummary');
console.log('  ' + summary.trim().slice(0, 110));

// 3. 检查点三方读数一致性（范围外时像素行显示“仅环境光”，不参与比对）
const readout = await page.textContent('#readout');
const m1 = readout.match(/可见比例（解析）[^%\d]*([\d.]+)%/);
const m2 = readout.match(/64 条光线采样[^%\d]*([\d.]+)%/);
const m3 = readout.match(/画面像素反推可见度[^%\d]*([\d.]+)%/);
if (m1 && m2 && m3) {
  const a = Number(m1[1]);
  const s = Number(m2[1]);
  const g = Number(m3[1]);
  const ds = Math.abs(a - s);
  const dg = Math.abs(a - g);
  if (ds <= 4 && dg <= 6) ok(`检查点读数三方一致：解析 ${a}% / 采样 ${s}% / 像素 ${g}%（偏差 ${ds}, ${dg}）`);
  else fail(`读数偏差过大：解析 ${a} 采样 ${s} 像素 ${g}`);
} else if (m1 && m2 && readout.includes('仅环境光')) {
  ok(`范围外检查点：解析 ${m1[1]}% / 采样 ${m2[1]}%，画面仅环境光（规则一致）`);
} else fail('读数字段缺失：' + readout.replace(/\s+/g, ' '));

// 4. 拖动光源：先暂停自动移动，切到半影检查点（对光源位置敏感），用页面内精确坐标映射
await page.evaluate(() => window.__softShadow.pause());
const cpButtons = await page.$$('#checkpointRow button');
await cpButtons[2].click(); // C3 半影边缘
await page.waitForTimeout(200);
const before = await page.textContent('#readout');
const box = await page.$('#areaBox');
const bb = await box.boundingBox();
async function drag(from, to) {
  await page.mouse.move(bb.x + from[0], bb.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(bb.x + to[0], bb.y + to[1], { steps: 8 });
  await page.mouse.up();
}
const w2s = async (x, y) => {
  const p = await page.evaluate((q) => window.__softShadow.worldToCss(q, 'area'), { x, y });
  return [p.x, p.y];
};

const light0 = await page.evaluate(() => window.__softShadow.getState().light);
const s0 = await w2s(light0.c.x, light0.c.y);
const s1 = await w2s(150, 100);
await drag(s0, s1);
await page.waitForTimeout(300);
const movedLight = await page.evaluate(() => window.__softShadow.getState().light);
const moved = Math.hypot(movedLight.c.x - 150, movedLight.c.y - 100) < 12;
const readChanged = (await page.textContent('#readout')) !== before;
if (moved && readChanged) {
  ok('拖动光源后位置与半影检查点读数实时更新');
} else fail(`拖动光源未生效 moved=${moved} readChanged=${readChanged}`);

// 5. 非法位置：把光源拖到单挡板 rect(400,210,70,180) 中心 (435,300)
const si = await w2s(435, 300);
await drag(s1, si);
await page.waitForTimeout(300);
const status = await page.textContent('#statusMsg');
const statusClass = await page.getAttribute('#statusMsg', 'class');
const ghost = await page.evaluate(() => window.__softShadow.getState().ghost);
if (statusClass.includes('err') && status.includes('挡板') && ghost) {
  ok('光源进入挡板被拒绝并显示虚像：' + status.trim());
} else fail('未触发非法位置状态：' + status);

// 有效光源应停在非法路径上最后一个合法点，未被终点 (435,300) 覆盖
const stillValid = await page.evaluate(() => window.__softShadow.getState().light);
const polyRect = { x0: 400, y0: 210, x1: 470, y1: 390 };
const insideBlocker =
  stillValid.c.x + stillValid.r > polyRect.x0 &&
  stillValid.c.x - stillValid.r < polyRect.x1 &&
  stillValid.c.y + stillValid.r > polyRect.y0 &&
  stillValid.c.y - stillValid.r < polyRect.y1;
if (!insideBlocker) ok('非法位置未污染上次有效光照（有效光停在挡板外）');
else fail('有效光源被非法位置覆盖到挡板内部');

// 拖回合法位置应恢复
const sBack = await w2s(220, 150);
await drag(si, sBack);
await page.waitForTimeout(300);
const status2 = await page.getAttribute('#statusMsg', 'class');
if (status2.includes('ok')) ok('拖回合法区域后状态恢复正常');
else fail('合法位置未恢复：' + await page.textContent('#statusMsg'));

// 6. 挡板拖动：单挡板中心 (435,300) → (560,300)
const p0 = await w2s(435, 300);
const p1 = await w2s(560, 300);
await drag(p0, p1);
await page.waitForTimeout(300);
const polyNow = await page.evaluate(() => window.__softShadow.getState().polys[0].verts);
const cx = polyNow.reduce((a, q) => a + q.x, 0) / polyNow.length;
if ((await page.getAttribute('#statusMsg', 'class')).includes('ok') && Math.abs(cx - 560) < 8) {
  ok('挡板拖动成功，轮廓实时更新');
} else fail('挡板拖动异常：' + await page.textContent('#statusMsg'));

// 7. 切换三组预设
for (const name of ['双挡板重叠', '靠墙']) {
  await page.click(`#presetRow button:has-text("${name}")`);
  await page.waitForTimeout(250);
  const desc = await page.textContent('#presetDesc');
  if (desc.length > 5) ok(`预设「${name}」切换成功`);
  else fail(`预设「${name}」切换异常`);
}

// 8. r=0 点光源硬阴影：右侧对照视图读数应为 0% 或 100%
const pointRead = await page.textContent('#readout');
if (pointRead.includes('0%（硬阴影）') || pointRead.includes('100%（亮）')) ok('点光源对照为 0/1 硬值');
else fail('点光源对照不是硬值：' + pointRead.replace(/\s+/g, ' '));

// 9. 窗口缩放后读数一致（范围外时按“仅环境光”规则同样成立）
await page.setViewportSize({ width: 1100, height: 800 });
await page.waitForTimeout(400);
const ro2 = await page.textContent('#readout');
const g2 = ro2.match(/画面像素反推可见度[^%\d]*([\d.]+)%/);
const a2 = ro2.match(/可见比例（解析）[^%\d]*([\d.]+)%/);
const resizeOk = ro2.includes('仅环境光') || (g2 && a2 && Math.abs(Number(g2[1]) - Number(a2[1])) <= 6);
if (resizeOk) ok('窗口缩放后像素读数与解析仍一致（或同为范围外环境光）');
else fail('缩放后读数不一致');

// 截图留档
await page.setViewportSize({ width: 1440, height: 1000 });
await page.click('#presetRow button:has-text("单挡板")');
await page.waitForTimeout(400);
await page.screenshot({ path: join(root, 'tmp', 'shot-single.png') });
await page.click('#presetRow button:has-text("双挡板重叠")');
await page.waitForTimeout(400);
await page.screenshot({ path: join(root, 'tmp', 'shot-double.png') });

if (errors.length === 0) ok('全程无控制台错误');
else fail('控制台错误：' + errors.join(' | '));

await browser.close();
server.close();
console.log(process.exitCode ? '\nE2E 存在失败项' : '\nE2E 全部通过');
