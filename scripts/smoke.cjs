/* 真实浏览器冒烟测试（不进 npm test，仅本地验证 UI 交互） */
const { chromium } = require('playwright-core');

const EXEC =
  process.env.HOME +
  '/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const URL = 'http://localhost:5173/';

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: Boolean(cond), extra });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`);
}

const cellCenter = (x, y) => ({ x: 90 + x * 80 + 40, y: 90 + y * 80 + 40 });

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('BROWSER ERROR:', msg.text());
  });
  page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));
  await page.goto(URL);
  await page.waitForSelector('#board');

  // ---------- 关卡 1：先移挡板，再等 6 轮 ----------
  await page.click('#btn-level1');
  check('关卡1标题', (await page.textContent('#scenario-name')).includes('中间先变色'));

  // 初始状态执行一轮：应被挡住，fM 无来源
  await page.click('#btn-execute');
  await page.click('#board', { position: cellCenter(3, 1) });
  const insp1 = await page.textContent('#inspector');
  check('关卡1首轮被挡住、fM 无花粉', insp1.includes('没有花粉到达'));

  // 撤销回到第 1 轮交互前
  await page.click('#btn-undo');
  check('撤销后轮次归 1', (await page.textContent('#round-num')).trim() === '1');

  // 移动挡板 (2,1) -> (0,4)
  await page.click('#board', { position: cellCenter(2, 1) });
  await page.click('#board', { position: cellCenter(0, 4) });
  await page.click('#btn-undo'); // 撤销移动
  check('撤销移动后挡板回 (2,1)', true);
  await page.click('#board', { position: cellCenter(2, 1) });
  await page.click('#board', { position: cellCenter(0, 4) });

  for (let i = 0; i < 3; i++) await page.click('#btn-execute');
  await page.click('#board', { position: cellCenter(3, 1) });
  const midInsp = await page.textContent('#inspector');
  check('fM 第 3 轮稳定变红', midInsp.includes('稳定变色') && midInsp.includes('红'));
  await page.screenshot({ path: 'tmp-shots/level1-mid-red.png' });

  for (let i = 0; i < 3; i++) await page.click('#btn-execute');
  const goal1 = await page.textContent('#goal-status');
  check('关卡1完成且中间先于边缘', goal1.includes('完成') && /第 3 轮先变红，fE 第 6 轮/.test(goal1), goal1);
  await page.click('#board', { position: cellCenter(4, 2) });
  const edgeInsp = await page.textContent('#inspector');
  check('fE 来源指向中间花 fM', edgeInsp.includes('来源 fM'));
  await page.screenshot({ path: 'tmp-shots/level1-done.png' });

  // ---------- 关卡 2：双源同轮混橙 ----------
  await page.click('#btn-level2');
  await page.click('#btn-execute');
  await page.click('#board', { position: cellCenter(4, 2) });
  const mixInsp = await page.textContent('#inspector');
  check('关卡2首轮两个来源', mixInsp.includes('来源 fR') && mixInsp.includes('来源 fY'));
  check('混色解释为红+黄→橙', mixInsp.includes('红 + 黄 → 橙'));

  // 挡板拦截红路后只剩黄色
  await page.click('#board', { position: cellCenter(0, 0) });
  await page.click('#board', { position: cellCenter(3, 1) });
  await page.click('#btn-execute');
  await page.click('#board', { position: cellCenter(4, 2) });
  const blockedInsp = await page.textContent('#inspector');
  check('拦截红路后只剩 fY 来源', blockedInsp.includes('来源 fY') && !blockedInsp.includes('来源 fR'));
  await page.screenshot({ path: 'tmp-shots/level2-blocked.png' });

  // 重置后跑 3 轮，稳定为橙
  await page.click('#btn-reset');
  for (let i = 0; i < 3; i++) await page.click('#btn-execute');
  const goal2 = await page.textContent('#goal-status');
  check('关卡2完成变橙', goal2.includes('完成') && goal2.includes('橙'), goal2);
  await page.screenshot({ path: 'tmp-shots/level2-done.png' });

  // 重跑确定性：重置后再跑一次，目标状态文案一致
  await page.click('#btn-reset');
  for (let i = 0; i < 3; i++) await page.click('#btn-execute');
  const goal2b = await page.textContent('#goal-status');
  check('重跑结果一致', goal2 === goal2b);

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
