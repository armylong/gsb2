import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const outDir = process.argv[3] ?? 'tmp/shots';
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const desktop = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 2 });
const page = await desktop.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.screenshot({ path: `${outDir}/01-desktop.png` });

// 悬停到棋盘中央，显示预览
const canvas = page.locator('.board-canvas');
const box = await canvas.boundingBox();
if (box) {
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.5);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${outDir}/02-preview.png` });
}

// 打开验证抽屉
await page.getByRole('button', { name: '操作串验证' }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${outDir}/03-drawer.png` });
await page.locator('.drawer-footer .btn.primary').first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${outDir}/04-demo.png` });
await page.locator('.demo-bar .btn.tiny').last().click();
await page.waitForTimeout(400);
if (await page.locator('.drawer.open').count()) await page.locator('.close-drawer').click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${outDir}/05-after-demo.png` });

// 帮助
await page.getByRole('button', { name: '玩法' }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${outDir}/06-help.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// 第二关
await page.locator('[data-level="guarded-heart"]').click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${outDir}/07-level2.png` });

// 失败状态 + 查看器
async function cellCenter(x, y) {
  const geo = await page.evaluate(() => {
    const c = document.querySelector('.board-canvas');
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, wrap: document.querySelector('.board-wrap').clientWidth };
  });
  const cell = Number(await page.evaluate(() => document.querySelector('.board-canvas').dataset.cell));
  const margin = Number(await page.evaluate(() => document.querySelector('.board-canvas').dataset.margin));
  const cssW = cell * 6 + margin * 2;
  const scale = geo.width / cssW;
  return { x: geo.left + (margin + x * cell + cell / 2) * scale, y: geo.top + (margin + y * cell + cell / 2) * scale };
}
async function clickCell(x, y) {
  const p = await cellCenter(x, y);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(120);
}
await page.locator('[data-level="four-corner-flower"]').click();
await page.waitForTimeout(300);
await page.locator('.stencil-row', { hasText: '肘三格' }).click();
await clickCell(1, 1);
await page.waitForTimeout(300);
await page.screenshot({ path: `${outDir}/09-failed.png` });
await page.locator('.seg', { hasText: '查看' }).click();
await clickCell(1, 1);
await page.waitForTimeout(250);
await page.screenshot({ path: `${outDir}/10-inspect.png` });

// 挡墨纸
await page.locator('.btn', { hasText: '重置' }).click();
await page.waitForTimeout(100);
await page.locator('.btn', { hasText: '确认重置' }).click();
await page.waitForTimeout(150);
await page.locator('.seg', { hasText: '挡墨纸' }).click();
await clickCell(1, 1);
await clickCell(2, 2);
await clickCell(3, 3);
await page.waitForTimeout(250);
await page.screenshot({ path: `${outDir}/11-mask.png` });

// 定格预演
await page.locator('.seg', { hasText: '盖印' }).click();
await page.locator('.stencil-row', { hasText: '十字五格' }).click();
await page.waitForTimeout(120);
const cp = await cellCenter(2, 2);
await page.mouse.move(cp.x, cp.y);
await page.waitForTimeout(120);
await page.locator('.btn', { hasText: '定格预演' }).click();
await page.waitForTimeout(250);
await page.mouse.move(30, 30);
await page.waitForTimeout(200);
await page.screenshot({ path: `${outDir}/12-pinned.png` });

// 移动端
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mpage = await mobile.newPage();
mpage.on('pageerror', (err) => errors.push(String(err)));
await mpage.goto(url, { waitUntil: 'networkidle' });
await mpage.waitForTimeout(700);
await mpage.screenshot({ path: `${outDir}/08-mobile.png` });

console.log(JSON.stringify({ errors }, null, 2));
await browser.close();
