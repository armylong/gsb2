// 端到端冒烟：playwright-core 驱动本机 chromium，验证两个内置场景与封路交互。
// 用法：先 `npm run dev`，再 `SMOKE_URL=http://localhost:5173/ npm run smoke`
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const candidates = [
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) throw new Error('未找到可用的 chromium/chrome');

const BASE = process.env.SMOKE_URL ?? 'http://localhost:5199/';
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(BASE, { waitUntil: 'networkidle' });

async function pickScenario(id: string) {
  // 切场景时把策略重置为严格优先级，避免上一个场景的策略选择泄漏进来
  await page.selectOption('#strategy', 'strict');
  await page.selectOption('#scenario', id);
  await page.waitForTimeout(80);
}
async function autoRun(maxSeconds = 60) {
  const btn = '#autoBtn';
  // 幂等：只在按钮显示「自动推进」（即当前已停）时启动
  const state = await page.$eval(btn, (b) => b.textContent ?? '');
  if (state.includes('自动推进')) await page.click(btn);
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const tags = await page.$$eval('.car-row .tag', (t) => t.map((x) => x.textContent ?? ''));
    const running = tags.some((t) => t.includes('行进') || t.includes('等待'));
    if (!running && tags.length > 0) break;
  }
  // 仅在仍在自动推进时点暂停
  const btnText = await page.$eval(btn, (b) => b.textContent ?? '');
  if (btnText.includes('暂停')) await page.click(btn);
  await page.waitForTimeout(100);
}
const rowTexts = () => page.$$eval('.car-row', (rows) => rows.map((r) => r.textContent ?? ''));

// 场景一：全部到达
await pickScenario('opposite');
await autoRun();
let rows = await rowTexts();
if (!rows.every((t) => t.includes('已到达'))) throw new Error('场景一未全部到达: ' + rows.join(' | '));
const log1 = await page.$eval('#log', (el) => el.textContent ?? '');
if (!log1.includes('到达终点')) throw new Error('缺少到达事件日志');
console.log('✓ 场景一：两车先后通过，全部到达');

// 场景二严格优先级：W 饥饿失败，有失败原因
await pickScenario('starvation');
await autoRun(30);
rows = await rowTexts();
const wRow = rows.find((t) => t.includes('W 弱优先车'));
if (!wRow?.includes('失败') || !wRow.includes('弱车饥饿') || !wRow.includes('失败原因'))
  throw new Error('W 未按预期饥饿失败: ' + wRow);
console.log('✓ 场景二严格优先级：W 弱车饥饿失败并给出原因');

// 场景二老化：W 翻盘到达
await pickScenario('starvation');
await page.selectOption('#strategy', 'aging');
await page.waitForTimeout(50);
await autoRun(45);
rows = await rowTexts();
const wRow2 = rows.find((t) => t.includes('W 弱优先车'));
if (!wRow2?.includes('已到达')) throw new Error('老化策略下 W 未到达: ' + wRow2);
console.log('✓ 场景二优先级老化：W 翻盘到达');

// 封路：点击桥面中格 (5,3)，出现封路日志、预约重算，且未上桥的车改为等待
await pickScenario('opposite');
const box = await page.$('#canvas')!.then((c) => c!.boundingBox());
await page.mouse.click(box!.x + (box!.width * 5.5) / 11, box!.y + (box!.height * 3.5) / 7);
await page.waitForTimeout(80);
const log2 = await page.$eval('#log', (el) => el.textContent ?? '');
if (!log2.includes('封闭')) throw new Error('封路未写日志');
const rowsAfterClose = await rowTexts();
if (!rowsAfterClose.some((t) => t.includes('等待') || t.includes('失败')))
  throw new Error('封桥后应至少有车进入等待: ' + rowsAfterClose.join(' | '));
console.log('✓ 中途封路：日志记录、预约整体重算，受阻车进入等待');

// 解封后行程恢复：再次点击同一格解封，自动推进到全部到达
await page.mouse.click(box!.x + (box!.width * 5.5) / 11, box!.y + (box!.height * 3.5) / 7);
await page.waitForTimeout(80);
const log3 = await page.$eval('#log', (el) => el.textContent ?? '');
if (!log3.includes('解封')) throw new Error('解封未写日志');
await autoRun(60);
const rowsReopen = await rowTexts();
if (!rowsReopen.every((t) => t.includes('已到达')))
  throw new Error('解封后未全部到达: ' + rowsReopen.join(' | '));
console.log('✓ 解封后受影响行程恢复并全部到达');

if (errors.length) throw new Error('页面错误: ' + errors.join('; '));
await page.screenshot({ path: '/tmp/bridge-final.png' });
await browser.close();
console.log('SMOKE PASS');
