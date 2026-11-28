import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

const geo = await page.evaluate(() => {
  const c = document.querySelector('.board-canvas');
  const r = c.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, wrap: document.querySelector('.board-wrap').clientWidth };
});
// derive metrics via canvas CSS size & known 6 cols + 2.3 margin cells
const dims = await page.evaluate(() => {
  const c = document.querySelector('.board-canvas');
  return {
    cell: Number(c.dataset.cell),
    margin: Number(c.dataset.margin),
    cols: Number(c.dataset.cols),
    cssWidth: parseFloat(c.style.width),
  };
});
const { cell, margin } = dims;
const scale = geo.width / dims.cssWidth;
const cc = (x, y) => ({ x: geo.left + (margin + x * cell + cell / 2) * scale, y: geo.top + (margin + y * cell + cell / 2) * scale });
const clickCell = async (x, y) => { const p = cc(x, y); await page.mouse.move(p.x, p.y); await page.mouse.click(p.x, p.y); await page.waitForTimeout(120); };
const status = async () => (await page.locator('.status-chip').first().textContent()) ?? '';

// 键盘定位 + 回车盖印
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowUp');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
check('方向键定位 + 回车盖印', (await page.locator('.history-row').count()) === 1, await status());

// 撤回 Z
await page.keyboard.press('z');
await page.waitForTimeout(150);
check('Z 撤回', (await page.locator('.history-row').count()) === 0);

// R/F 改变朝向并反映在标签
const before = await page.locator('.orient-label').textContent();
await page.keyboard.press('r');
await page.keyboard.press('f');
await page.waitForTimeout(120);
const after = await page.locator('.orient-label').textContent();
check('R/F 改变朝向标签', before !== after && (after ?? '').includes('翻面'), `${before} -> ${after}`);

// 出界孔不计费：十字模板定位到左上角，只有 3 个孔在纸内
await page.locator('.stencil-row', { hasText: '十字五格' }).click();
for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowLeft');
for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowUp');
await page.waitForTimeout(120);
const previewText = (await page.locator('.preview-strip').textContent()) ?? '';
check('出界孔不计费', previewText.includes('3 格') && previewText.includes('出界 2'), previewText);
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
const newRow = (await page.locator('.history-row').last().textContent()) ?? '';
check('出界盖印只结算纸内格', newRow.includes('3 格') && newRow.includes('出界 2'), newRow);

// 验证抽屉关闭后演示仍在继续/暂停
const playerRowsBeforeDemo = await page.locator('.history-row').count();
await page.getByRole('button', { name: '操作串验证' }).click();
await page.waitForTimeout(200);
await page.locator('.drawer-footer .btn.primary').first().click();
await page.waitForTimeout(400);
check('演示时抽屉自动关闭', (await page.locator('.drawer.open').count()) === 0);
const playLabel = await page.locator('.demo-bar .btn.tiny.primary').textContent();
await page.locator('.demo-bar .btn.tiny.primary').click();
await page.waitForTimeout(200);
const pausedLabel = await page.locator('.demo-bar .btn.tiny.primary').textContent();
check('演示可暂停', playLabel !== pausedLabel, `${playLabel} -> ${pausedLabel}`);
await page.locator('.demo-bar .btn.tiny.primary').click();
await page.waitForTimeout(300);
check('演示可继续', (await page.locator('.demo-bar .btn.tiny.primary').textContent()) !== pausedLabel);
await page.locator('.demo-bar .btn.tiny').last().click();
await page.waitForTimeout(250);
const rowsAfterDemo = await page.locator('.history-row').count();
const barHidden = await page.locator('.demo-bar').isHidden();
check(
  '退出演示恢复玩家状态',
  rowsAfterDemo === playerRowsBeforeDemo && barHidden,
  `行数 ${rowsAfterDemo}/${playerRowsBeforeDemo} · 演示条隐藏 ${barHidden}`,
);

// 演示推进时墨量面板跟着变化
await page.getByRole('button', { name: '操作串验证' }).click();
await page.waitForTimeout(200);
await page.locator('.drawer-footer .btn').nth(1).click(); // 直接看最终结果
await page.waitForTimeout(300);
const demoRust = (await page.locator('.ink-row', { hasText: '铁锈红' }).textContent()) ?? '';
check('演示结果反映在墨量面板', demoRust.replace(/\s/g, '').includes('0/16'), demoRust);
await page.locator('.demo-bar .btn.tiny').last().click();
await page.waitForTimeout(200);

// 演示中键盘不能盖印
await page.getByRole('button', { name: '操作串验证' }).click();
await page.waitForTimeout(200);
await page.locator('.drawer-footer .btn').nth(1).click(); // 直接看最终结果
await page.waitForTimeout(300);
const demoStatus = await status();
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
check('演示中回车不写回进度', (await page.locator('.drawer.open').count()) === 0 && (await status()) === demoStatus, demoStatus);
await page.locator('.demo-bar .btn.tiny').last().click();
await page.waitForTimeout(200);

// 切换到第二关后键盘仍可用
await page.locator('[data-level="guarded-heart"]').click();
await page.waitForTimeout(250);
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
check('第二关可用键盘盖印', (await page.locator('.history-row').count()) === 1, await status());

console.log(JSON.stringify({ errors, results, passed: results.every((r) => r.pass) && errors.length === 0 }, null, 2));
await browser.close();
process.exit(results.every((r) => r.pass) && errors.length === 0 ? 0 : 1);
