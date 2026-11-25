/* 浏览器端到端冒烟：node scripts/smoke.mjs （需先 npm run build 并启动 preview） */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.SMOKE_URL || 'http://127.0.0.1:4321/';
mkdirSync('tmp/shots', { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--allow-file-access-from-files'],
  defaultViewport: { width: 1360, height: 940, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text());
});
page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure()?.errorText || '')));

try {
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 20000 });
  await sleep(500);
  check('页面标题正确', (await page.title()).includes('滚方块盖印'));
  check('Canvas 已挂载', !!(await page.$('#game-canvas')));
  await page.screenshot({ path: 'tmp/shots/01-load.png' });

  // 初始进度 0/2，撤销禁用
  check('L1 初始进度 0/2', (await page.$eval('#progress-count', (e) => e.textContent)) === '0/2');
  check('初始撤销按钮禁用', await page.$eval('#btn-undo', (e) => e.disabled));

  // 撞西墙（起点 1,1，西边是 #）
  await page.keyboard.press('ArrowLeft');
  await sleep(120);
  await page.screenshot({ path: 'tmp/shots/02-wall-block.png' });
  const posAfterWall = await page.evaluate(() => {
    const raw = localStorage.getItem('rolling-stamp-puzzle:store:v1');
    const store = JSON.parse(raw);
    const save = store.slots[store.active];
    return save.frames[save.index].state.x + ',' + save.frames[save.index].state.y;
  });
  check('撞墙后位置仍为 1,1 且未产生新帧', posAfterWall === '1,1', posAfterWall);

  // 用「提示 → 执行」循环打通 L1
  async function hintToWin(maxSteps = 40, shotPrefix = 'x') {
    let acted = 0;
    for (let i = 0; i < maxSteps; i++) {
      if (await page.$eval('#win-overlay', (e) => !e.hidden).catch(() => false)) return acted;
      await page.click('#btn-hint');
      await sleep(40);
      const exec = await page.$('#hint-actions .btn.primary');
      const back = await page.$('#hint-actions .btn.accent');
      if (exec) {
        await exec.click();
        acted++;
        await sleep(250);
      } else if (back) {
        await back.click();
        await sleep(120);
      } else {
        await sleep(100);
      }
      if (acted === 3 && shotPrefix !== 'x') await page.screenshot({ path: `tmp/shots/${shotPrefix}-mid.png` });
    }
    await sleep(800);
    return acted;
  }

  const steps1 = await hintToWin(30, '03-l1');
  await sleep(800);
  const winVisible1 = await page.$eval('#win-overlay', (e) => !e.hidden);
  check('L1 提示执行后出现通关浮层', winVisible1, `执行 ${steps1} 个提示动作`);
  check('L1 进度 2/2', (await page.$eval('#progress-count', (e) => e.textContent)) === '2/2');
  await page.screenshot({ path: 'tmp/shots/04-l1-win.png' });

  // 刷新：存档恢复，印记仍 2/2，撤销可用
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(500);
  check('刷新后印记进度仍为 2/2', (await page.$eval('#progress-count', (e) => e.textContent)) === '2/2');
  check('刷新后撤销栈仍在（撤销可点）', !(await page.$eval('#btn-undo', (e) => e.disabled)));
  const storedIndex = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('rolling-stamp-puzzle:store:v1'));
    const sv = s.slots[s.active];
    return { index: sv.index, frames: sv.frames.length, stamps: Object.keys(sv.frames[sv.index].state.stamps).length };
  });
  check('存档含 2 枚印记与完整帧栈', storedIndex.stamps === 2 && storedIndex.index > 0, JSON.stringify(storedIndex));
  await page.screenshot({ path: 'tmp/shots/05-reloaded.png' });

  // 一路撤销到禁用 -> 回到撤销起点（初始帧）
  for (let i = 0; i < 30; i++) {
    const disabled = await page.$eval('#btn-undo', (e) => e.disabled);
    if (disabled) break;
    await page.click('#btn-undo');
    await sleep(60);
  }
  check('全部撤销后进度回到 0/2', (await page.$eval('#progress-count', (e) => e.textContent)) === '0/2');
  check('撤销到起点后按钮禁用', await page.$eval('#btn-undo', (e) => e.disabled));
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(400);
  check('再打开仍停在撤销起点 0/2', (await page.$eval('#progress-count', (e) => e.textContent)) === '0/2');
  check('再打开撤销按钮仍禁用（起点一致）', await page.$eval('#btn-undo', (e) => e.disabled));

  // 切到分歧关
  const tabs = await page.$$('.level-tab');
  await tabs[2].click();
  await sleep(400);
  check('分歧关显示两个朝向按钮', (await page.$$eval('.variant-btn', (bs) => bs.length)) === 2);

  // 朝向 A 提示通关，记录结局坐标
  await page.click('.variant-btn:nth-child(1)');
  await sleep(300);
  await hintToWin(40);
  await sleep(800);
  const endA = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('rolling-stamp-puzzle:store:v1'));
    const slot = s.slots[Object.keys(s.slots).find((k) => k.startsWith('two-fates#pose-a'))];
    const st = slot.frames[slot.index].state;
    return `${st.x},${st.y}`;
  });
  check('朝向 A 通关且终点为右上封口 (4,1)', endA === '4,1', endA);
  await page.screenshot({ path: 'tmp/shots/06-fork-a-win.png' });

  // 朝向 B（独立槽，新局）
  await page.click('.variant-btn:nth-child(2)');
  await sleep(400);
  check('切到 B 后是新局 0/4', (await page.$eval('#progress-count', (e) => e.textContent)) === '0/4');
  await hintToWin(40, '07-fork-b');
  await sleep(800);
  const endB = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('rolling-stamp-puzzle:store:v1'));
    const slot = s.slots[Object.keys(s.slots).find((k) => k.startsWith('two-fates#pose-b'))];
    const st = slot.frames[slot.index].state;
    return `${st.x},${st.y}`;
  });
  check('朝向 B 通关且终点为右下封口 (4,3)', endB === '4,3', endB);
  check('两种朝向结局格不同', endA !== endB, `${endA} vs ${endB}`);
  await page.screenshot({ path: 'tmp/shots/08-fork-b-win.png' });
} catch (e) {
  check('冒烟脚本异常: ' + e.message, false);
}

// 错印 -> 退回提示（注册 dialog 自动确认；清空存档重开，避免前面进度干扰）
page.on('dialog', async (d) => {
  await d.accept();
});
try {
  // 切回第一关（其存档此前已撤销回初始帧），直接在起点盖错印
  const tabs2 = await page.$$('.level-tab');
  await tabs2[0].click();
  await sleep(300);
  check('回到 L1 且为初始 0/2', (await page.$eval('#progress-count', (e) => e.textContent)) === '0/2');
  await page.keyboard.press('Space'); // 起点地板，贴地紫 -> 污渍
  await sleep(200);
  await page.click('#btn-hint');
  await sleep(100);
  const backBtn = await page.$('#hint-actions .btn.accent');
  check('盖错后提示给出“回退 N 步”按钮', !!backBtn);
  await page.screenshot({ path: 'tmp/shots/09-undo-hint.png' });
  if (backBtn) {
    await backBtn.click();
    await sleep(200);
    const execAfterBack = await page.$('#hint-actions .btn.primary');
    check('一键回退后立刻给出可行下一步', !!execAfterBack);
  }
} catch (e) {
  check('错印退回流程异常: ' + e.message, false);
}

check('浏览器无 JS / 资源错误', errors.length === 0, errors.slice(0, 5).join(' || '));
if (errors.length) console.log('\nCONSOLE ERRORS:\n' + errors.join('\n'));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? '✅ 浏览器冒烟全部通过' : `❌ ${failed} 项失败`}`);
process.exit(failed ? 1 : 0);
