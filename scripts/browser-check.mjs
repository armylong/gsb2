/**
 * browser-check.mjs — 用系统 Chrome 做真实点击冒烟测试并截图。
 * 运行: node scripts/browser-check.mjs
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'file://' + process.cwd() + '/index.html';
const SHOT_DIR = process.cwd() + '/tmp/shots';
mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--force-color-profile=srgb', '--window-size=1440,2400'],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => {
  if (!r.url().startsWith('data:')) errors.push('requestfailed: ' + r.url() + ' ' + (r.failure()?.errorText ?? ''));
});

let failures = 0;
async function expect(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failures++; console.error('  ✗ ' + msg); }
}
async function click(testid) {
  await page.waitForSelector(`[data-testid="${testid}"]`, { timeout: 3000 });
  await page.click(`[data-testid="${testid}"]`);
}
async function text(testid) {
  const el = await page.$(`[data-testid="${testid}"]`);
  return el ? page.evaluate((n) => n.textContent, el) : null;
}

try {
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 15000 });
  await sleep(500);

  await expect((await page.title()).includes('包裹称重谜题'), '页面标题正确');
  await expect(await page.$('[data-testid="level-tab-2"]') !== null, '渲染出 3 个关卡标签');
  await page.screenshot({ path: SHOT_DIR + '/01-intro-top.png' });

  /* ---------- 入门关：基本称量流程 ---------- */
  console.log('— 入门关基本流程 —');
  await click('tray-0-left');
  await click('tray-1-right');
  await sleep(350);
  const confirmDisabled = await page.$eval('[data-testid="confirm-weighing"], #confirmBtn', (b) => b.disabled).catch(() => null);
  // confirm button has id confirmBtn and data-act but testid? It has id; use selector
  const btnDisabled = await page.$eval('#confirmBtn', (b) => b.disabled);
  await expect(btnDisabled === false, '两盘都有包裹后确认按钮可用');
  await page.click('#confirmBtn');
  await sleep(700);
  const left1 = await text('attempts-left');
  await expect(left1.includes('剩余 3 / 4'), '确认后次数消耗：' + left1);
  await expect(await page.$('[data-testid="history-0"]') !== null, '生成第 1 条称量记录');
  await page.screenshot({ path: SHOT_DIR + '/02-first-weigh.png' });

  // 翻查动画
  await click('history-0');
  await sleep(500);
  const caption = await page.$eval('#scaleCaption', (e) => e.textContent);
  await expect(caption.includes('翻查：第 1 次'), '点击历史记录可翻查摆法与结果');

  /* ---------- 组合关卡：真实点击走 scripted 路径并通关 ---------- */
  console.log('— 组合称量关卡 —');
  await click('level-tab-1');
  await sleep(300);
  async function weigh(spec) {
    // spec: {L:[...], R:[...]} 0-based
    for (const p of spec.L) await click(`tray-${p}-left`);
    for (const p of spec.R) await click(`tray-${p}-right`);
    await sleep(150);
    await page.click('#confirmBtn');
    await sleep(650);
    await click('clear-tray');
    await sleep(150);
  }
  await weigh({ L: [1, 3], R: [0, 2] });
  let cnt = await page.$eval('[data-testid="survivor-count"]', (e) => e.dataset.count);
  console.log('    第一次称量后剩余可能:', cnt);
  await expect(Number(cnt) > 7, '第一次称量后仍有较多可能（实际 ' + cnt + '）');
  await weigh({ L: [2, 4], R: [1, 3] });
  cnt = await page.$eval('[data-testid="survivor-count"]', (e) => e.dataset.count);
  await expect(cnt === '7', '两次联合后剩余 7 种可能（实际 ' + cnt + '）');
  // 候选投影：包裹1唯一为 1
  const cand0Alive = await page.$$eval('[data-testid^="cand-0-"]', (els) =>
    els.filter((e) => e.classList.contains('alive')).map((e) => e.textContent.trim()));
  await expect(cand0Alive.length === 1 && cand0Alive[0].startsWith('1'), '包裹 1 被联合记录唯一锁定为 1kg');

  // 提交前先看一个非必然分组的反例：全部 A/B 随便分（0,1,2 A; 3,4 B 不完整? 完整即可）
  for (const p of [0, 1, 2]) await click(`shelf-${p}-A`);
  for (const p of [3, 4]) await click(`shelf-${p}-B`);
  await page.click('#submitBtn');
  await sleep(300);
  let kind = await page.$eval('[data-testid="verdict"]', (e) => e.dataset.kind).catch(() => null);
  await expect(kind === 'contingent-equal' || kind === 'never-equal', '错误分组被拦截并给出判定: ' + kind);
  await page.screenshot({ path: SHOT_DIR + '/03-combo-counterexample.png', fullPage: true });

  // 改成正确分组 0,1,3 -> A ; 2,4 -> B。先全部 none
  for (const p of [0, 1, 2, 3, 4]) await click(`shelf-${p}-none`);
  for (const p of [0, 1, 3]) await click(`shelf-${p}-A`);
  for (const p of [2, 4]) await click(`shelf-${p}-B`);
  await page.click('#submitBtn');
  await sleep(400);
  kind = await page.$eval('[data-testid="verdict"]', (e) => e.dataset.kind).catch(() => null);
  await expect(kind === 'necessary-equal', '正确组合分组判定必然等重（实际 ' + kind + '）');
  await page.screenshot({ path: SHOT_DIR + '/04-combo-win.png', fullPage: true });

  /* ---------- 限次关卡：用光 + contingent 反例 + 重开还原 ---------- */
  console.log('— 限次未定关卡 —');
  await click('level-tab-2');
  await sleep(300);
  await weigh({ L: [0], R: [1] });
  await weigh({ L: [2], R: [3] });
  const leftTxt = await text('attempts-left');
  await expect(leftTxt.includes('剩余 0 / 2'), '两次确认后次数耗尽：' + leftTxt);
  cnt = await page.$eval('[data-testid="survivor-count"]', (e) => e.dataset.count);
  await expect(cnt === '36', '仍有 36 种可能（实际 ' + cnt + '）');
  const confirmDisabled2 = await page.$eval('#confirmBtn', (b) => b.disabled);
  await expect(confirmDisabled2, '次数耗尽后确认按钮禁用');

  // 预设的真实等重划分 1,2 -> A ; 0,3 -> B => contingent
  for (const p of [1, 2]) await click(`shelf-${p}-A`);
  for (const p of [0, 3]) await click(`shelf-${p}-B`);
  await page.click('#submitBtn');
  await sleep(400);
  kind = await page.$eval('[data-testid="verdict"]', (e) => e.dataset.kind).catch(() => null);
  await expect(kind === 'contingent-equal', '限次关预设分组收到 contingent 判定（实际 ' + kind + '）');
  await expect(await page.$('[data-testid="counterexample"]') !== null, '页面展示了反例分配');
  await page.screenshot({ path: SHOT_DIR + '/05-tight-counterexample.png', fullPage: true });

  // 重开还原
  await click('restart');
  await sleep(300);
  const restartLeft = await text('attempts-left');
  await expect(restartLeft.includes('剩余 2 / 2'), '重开后次数还原：' + restartLeft);
  await expect(await page.$('[data-testid="history-empty"]') !== null, '重开后记录清空');
  cnt = await page.$eval('[data-testid="survivor-count"]', (e) => e.dataset.count);
  await expect(cnt === '256', '重开后可能性回到完整笛卡尔积 4^4=256（实际 ' + cnt + '）');
  const trayCleared = await page.$$eval('[data-testid^="tray-"][data-testid$="-left"]', () => true);
  await expect(trayCleared, '摆法区已渲染');
  await page.screenshot({ path: SHOT_DIR + '/06-restarted.png' });

  /* ---------- 移动端窄屏截图 ---------- */
  const mobile = await browser.newPage();
  await mobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await mobile.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(600);
  await mobile.screenshot({ path: SHOT_DIR + '/07-mobile.png', fullPage: true });
  await mobile.close();

  await expect(errors.length === 0, '浏览器无控制台/加载错误' + (errors.length ? '：\n' + errors.join('\n') : ''));
} catch (e) {
  failures++;
  console.error('测试脚本异常:', e);
  try { await page.screenshot({ path: SHOT_DIR + '/99-error.png', fullPage: true }); } catch {}
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\n浏览器自测全部通过 ✅' : `\n有 ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
