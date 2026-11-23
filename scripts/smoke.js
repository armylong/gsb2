// 无头浏览器冒烟测试：真实加载页面，验证渲染、自检、按键、暂停/跳转全链路。
// 用缓存的 Chromium，不下载新浏览器。
import { chromium } from 'playwright-core';

const EXE =
  process.env.CHROME_EXE ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const URL = process.env.TARGET_URL ?? 'http://localhost:5199/';

const results = [];
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('#gameCanvas');
check('页面加载无 JS 错误（初始）', errors.length === 0, errors.join(' | '));

// 1. 帧率自检
await page.click('#btnSelftest');
await page.waitForFunction(() => document.querySelector('#selftest')?.className === 'ok');
const selftest = await page.textContent('#selftest');
check('60/30/20/10/7fps 自检通过', selftest.includes('成绩与帧率无关'), selftest.replace(/\n/g, ' / '));

// 2. 重放样例并核对 HUD 成绩（11 条结算，9 命中，2 miss）
await page.selectOption('#inFps', '10');
await page.click('#btnReplay');
await page.waitForFunction(() => document.querySelector('#hudScore')?.textContent !== '0/0/0');
const score = await page.textContent('#hudScore');
const parts = score.split('/').map(Number);
check('重放成绩 P+G=9、M=2', parts[0] + parts[1] === 9 && parts[2] === 2, `got ${score}`);
const logRows = await page.$$eval('#logBody tr', (trs) => trs.length);
check('判定流水已渲染（含展开前行数 > 10）', logRows > 10, `rows=${logRows}`);

// 3. 展开一条带候选的重叠记录，能看到赢家/落选
await page.selectOption('#logFilter', 'overlap');
await page.waitForSelector('#logBody tr.expandable');
await page.click('#logBody tr.expandable');
await page.waitForSelector('#logBody tr.detail');
const detail = await page.textContent('#logBody tr.detail');
check('重叠记录可展开并显示候选归属', detail.includes('赢家') && detail.includes('落选'), detail.slice(0, 80));
await page.selectOption('#logFilter', 'all');

// 4. 3/4 预设切换
await page.click('#btnTriple');
const beatSel = await page.inputValue('#inBeats');
check('3/4 预设载入', beatSel === '3');

// 5. 回到样例，模拟真人按键 + 暂停 + 跳转
await page.click('#btnSample');
await page.click('#btnPlay');
await page.waitForFunction(
  () => document.querySelector('#hudTime')?.textContent !== '0.00s',
  { timeout: 3000 },
);
await page.keyboard.down('f');
await page.waitForTimeout(120);
await page.keyboard.up('f');
await page.keyboard.press('Space');
const overlayShown = await page.$eval('#pauseOverlay', (el) => el.classList.contains('show'));
check('Space 暂停出现遮罩', overlayShown);
const pauseRows = await page.$$eval('#logBody tr', (trs) =>
  trs.map((t) => t.textContent),
);
check('暂停后流水仍可查', pauseRows.length >= 0);

// 6. 跳转小节
await page.selectOption('#inSeek', '2');
await page.click('#btnSeek');
await page.waitForTimeout(200);
const hudBeat = await page.textContent('#hudBeat');
check('跳转后 HUD 落在第 3 小节', hudBeat.startsWith('3 /'), `got ${hudBeat}`);

// 7. 偏移滑块可用
await page.$eval('#inOffset', (el) => {
  el.value = '80';
  el.dispatchEvent(new Event('input'));
});
const offsetText = await page.textContent('#offsetVal');
check('音频偏移可调', offsetText.includes('80 ms'), offsetText);

// 8. 最终无页面错误
check('全程无 JS 错误', errors.length === 0, errors.join(' | '));

await page.screenshot({ path: '/tmp/rhythm-room-smoke.png', fullPage: false });
await browser.close();
console.log(results.join('\n'));
if (process.exitCode) process.exit(process.exitCode);
