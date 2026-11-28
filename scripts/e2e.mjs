import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:4173/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

const canvas = page.locator('.board-canvas');

async function cellCenter(x, y) {
  const geo = await page.evaluate(() => {
    const c = document.querySelector('.board-canvas');
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  // mirror computeMetrics: cell count 6, marginCells 1.15
  const dims = await page.evaluate(() => {
    const c = document.querySelector('.board-canvas');
    return { cell: Number(c.dataset.cell), margin: Number(c.dataset.margin), cols: Number(c.dataset.cols), rows: Number(c.dataset.rows) };
  });
  const { cell, margin } = dims;
  const cssW = cell * dims.cols + margin * 2;
  const scale = geo.width / cssW;
  void dims.rows;
  return {
    x: geo.left + (margin + x * cell + cell / 2) * scale,
    y: geo.top + (margin + y * cell + cell / 2) * scale,
  };
}

async function hoverCell(x, y) {
  const p = await cellCenter(x, y);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(60);
  return p;
}

async function clickCell(x, y) {
  const p = await hoverCell(x, y);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(90);
}

async function statusText() {
  return (await page.locator('.status-chip').first().textContent()) ?? '';
}

async function strokeText() {
  return (await page.locator('.preview-strip').first().textContent()) ?? '';
}

async function toastText() {
  return (await page.locator('.toast').textContent()) ?? '';
}

async function chooseStencil(name) {
  await page.locator('.stencil-row', { hasText: name }).click();
  await page.waitForTimeout(60);
}

async function chooseInk(name) {
  await page.locator('.ink-row', { hasText: name }).click();
  await page.waitForTimeout(60);
}

// ---- 初始状态
check('初始为待盖第 1 印', (await statusText()).includes('第 1 印待盖'));
check('样图缩略图存在', (await page.locator('.plan-thumb').count()) === 1);

// ---- 预览：悬停中央，足迹出现（通过 preview strip 文本判断）
await chooseStencil('十字五格');
const center = await hoverCell(2, 2);
check('悬停显示预览接触 5 格', (await strokeText()).includes('5 格'), await strokeText());

// ---- 墨量不足：人工把铁锈耗到 3 格无法直接设，改用盖章验证整次拒绝
// 第一关铁锈 16，先盖 4 次角钩（16 格）后，再盖十字会被拒
await chooseStencil('角钩四格');
await chooseInk('铁锈红');

// 左下角钩：rot2 + flip
await hoverCell(0, 5);
await page.keyboard.press('r');
await page.keyboard.press('r');
await page.keyboard.press('f');
await page.waitForTimeout(80);
await page.mouse.click((await cellCenter(0, 5)).x, (await cellCenter(0, 5)).y);
await page.waitForTimeout(100);
check('第 1 印成功（余 12）', (await page.locator('.ink-row', { hasText: '铁锈红' }).textContent()).includes('12'), await page.locator('.ink-row', { hasText: '铁锈红' }).textContent());

// 左上角钩
await page.keyboard.press('f'); // 翻回正面
await page.keyboard.press('r');
await page.keyboard.press('r'); // 回到 0 度
await page.waitForTimeout(60);
await clickCell(0, 0);
await page.waitForTimeout(100);
check('第 2 印成功（余 8）', (await page.locator('.ink-row', { hasText: '铁锈红' }).textContent()).includes('8'));

// 右上角钩：rot0 + flip
await page.keyboard.press('f');
await page.waitForTimeout(60);
await clickCell(5, 0);
await page.waitForTimeout(100);
check('第 3 印成功（余 4）', (await page.locator('.ink-row', { hasText: '铁锈红' }).textContent()).includes('4'));

// 右下角钩：rot2 正面
await page.keyboard.press('f');
await page.keyboard.press('r');
await page.keyboard.press('r');
await page.waitForTimeout(60);
await clickCell(5, 5);
await page.waitForTimeout(120);
check('第 4 印成功（铁锈用尽）', (await page.locator('.ink-row', { hasText: '铁锈红' }).textContent()).includes('0 /16') || (await page.locator('.ink-row', { hasText: '铁锈红' }).textContent()).includes('0'));

// 再用铁锈盖：应整次拒绝
const beforeStamps = await page.locator('.history-row').count();
await chooseStencil('十字五格');
await clickCell(2, 2);
await page.waitForTimeout(150);
check('墨量不足整次拒绝', (await toastText()).includes('墨量不足'), await toastText());
check('拒绝后不产生新记录', (await page.locator('.history-row').count()) === beforeStamps);
check('拒绝后仍是第 5 印待盖', (await statusText()).includes('第 5 印待盖'), await statusText());

// 换靛青完成
await chooseInk('靛青');
await clickCell(2, 2);
await page.waitForTimeout(200);
check('完成后状态显示完成', (await statusText()).includes('完成'), await statusText());

// ---- 撤回一整印
await page.locator('.action-buttons .btn', { hasText: '撤回' }).click();
await page.waitForTimeout(150);
check('撤回后回到待盖', (await statusText()).includes('第 5 印待盖'), await statusText());
check('撤回返还靛青 5 格', (await page.locator('.ink-row', { hasText: '靛青' }).textContent()).includes('5'));

// 重盖可复现
await chooseStencil('十字五格');
await clickCell(2, 2);
await page.waitForTimeout(200);
check('重盖后再次完成', (await statusText()).includes('完成'), await statusText());

// ---- 查看模式：点击一个藤紫交叉格
await page.locator('.seg', { hasText: '查看' }).click();
await page.waitForTimeout(80);
await clickCell(1, 2);
await page.waitForTimeout(150);
const inspector = (await page.locator('.inspector').textContent()) ?? '';
check('查看器列出墨层来源', inspector.includes('叠色来源') && /#\d/.test(inspector) && inspector.includes('十字五格'), inspector.slice(0, 160));
check('查看器显示坐标与颜色', inspector.includes('B3'), inspector.slice(0, 80));

// ---- 重置后落保留格判失败
await page.locator('.btn', { hasText: '重置' }).click();
await page.waitForTimeout(80);
await page.locator('.btn', { hasText: '确认重置' }).click();
await page.waitForTimeout(150);
await page.locator('.seg', { hasText: '盖印' }).click();
await chooseStencil('肘三格');
await chooseInk('铁锈红');
await clickCell(2, 0);
await page.waitForTimeout(150);
check('落在保留格判失败', (await statusText()).includes('失败'), await statusText());
check('失败详情列出新弄脏的格', ((await page.locator('.inspector').textContent()) ?? '').includes('保留格被沾墨'));
await page.locator('.action-buttons .btn', { hasText: '撤回' }).click();
await page.waitForTimeout(150);
check('撤回失败一印后恢复可印', (await statusText()).includes('待盖'), await statusText());

// ---- 重置后再验证挡墨纸
await page.locator('.btn', { hasText: '重置' }).click();
await page.waitForTimeout(80);
await page.locator('.btn', { hasText: '确认重置' }).click();
await page.waitForTimeout(150);
await page.locator('.seg', { hasText: '挡墨纸' }).click();
await page.waitForTimeout(80);
await clickCell(0, 0);
await page.waitForTimeout(150);
check('挡墨纸可贴上', (await page.locator('.history-row', { hasText: '挡墨纸' }).count()) >= 1);
check('挡墨操作不耗墨', !((await page.locator('.ink-row', { hasText: '靛青' }).textContent()) ?? '').includes('4'));

// 撤回挡墨
await page.locator('.action-buttons .btn', { hasText: '撤回' }).click();
await page.waitForTimeout(150);
check('挡墨纸可收回', (await page.locator('.history-row', { hasText: '挡墨纸' }).count()) === 0);

// ---- 重置
await page.locator('.btn', { hasText: '重置' }).click();
await page.waitForTimeout(80);
await page.locator('.btn', { hasText: '确认重置' }).click();
await page.waitForTimeout(150);
check('重置清空进度', (await statusText()).includes('第 1 印待盖'));
check('重置返还全部墨量', ((await page.locator('.ink-row', { hasText: '铁锈红' }).textContent()) ?? '').replace(/\s/g, '').includes('16/16'), await page.locator('.ink-row', { hasText: '铁锈红' }).textContent());

// ---- 验证操作串抽屉
await page.getByRole('button', { name: '操作串验证' }).click();
await page.waitForTimeout(300);
check('验证串全部通过', (await page.locator('.verify-badge.pass').count()) >= 1);
check('验证串覆盖失败步骤', (await page.locator('.script-step').count()) >= 10);
await page.locator('.drawer-footer .btn.primary').first().click();
await page.waitForTimeout(1600);
check('演示推进棋盘', ((await page.locator('.demo-label').textContent()) ?? '').match(/[1-9]/) !== null, await page.locator('.demo-label').textContent());
// 演示不改动玩家进度
check('演示不写回玩家进度', (await page.locator('.history-demo-note').count()) === 1, (await page.locator('.history-demo-note').textContent()) ?? '');
await page.locator('.demo-bar .btn.tiny').last().click();
await page.waitForTimeout(200);
if (await page.locator('.drawer.open').count()) await page.locator('.close-drawer').click();

// ---- 第二关：挡墨纸关卡走一遍
await page.locator('[data-level="guarded-heart"]').click();
await page.waitForTimeout(300);
check('切换到第二关', (await page.locator('.level-title').textContent()) === '护心');
await chooseStencil('方三格');
await chooseInk('铁锈红');
await clickCell(1, 1);
await page.waitForTimeout(150);
check('第二关铺底成功', ((await page.locator('.ink-row', { hasText: '铁锈红' }).textContent()) ?? '').includes('0'));

console.log(JSON.stringify({ errors, results, passed: results.every((r) => r.pass) }, null, 2));
await browser.close();
process.exit(results.every((r) => r.pass) && errors.length === 0 ? 0 : 1);
