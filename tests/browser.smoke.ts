// 浏览器端冒烟：真实 DOM + Canvas 交互，验证折叠、选层、部分打孔、展开、通关、撤销。
// 运行：node tests/browser.smoke.ts（由 npm 脚本经 tsx 加载）
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const EXE = path.join(
  process.env.HOME ?? process.cwd(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell',
);

const errors: string[] = [];
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

await page.goto(pathToFileURL(path.resolve('index.html')).href);
await page.waitForSelector('#mainCanvas');

async function statusText(): Promise<string> {
  return (await page.locator('#status').innerText()).trim();
}
async function counters(): Promise<string> {
  return (await page.locator('#counters').innerText()).trim();
}

// --- 第 1 关：执行折叠，默认选项即 竖线 x=1、大坐标侧 ---
await page.click('#foldApply');
await page.waitForTimeout(60);
if (!((await counters()).startsWith('折叠 1/1'))) throw new Error('折叠计数未更新');

// 进入打孔模式，打穿 2 层
await page.check('#modePunch');
await page.selectOption('#punchDepth', '2');
const box = await page.locator('#mainCanvas').boundingBox();
if (!box) throw new Error('主画布无布局尺寸');
// (0,1) 格中心：相机 minX=minY=-1，CELL=64 -> 屏幕 (1.5,2.5)*64
await page.mouse.click(box.x + 1.5 * 64, box.y + 2.5 * 64);
await page.waitForTimeout(60);
if (!((await counters()).includes('打孔 1/1'))) throw new Error('打孔计数未更新');

// 逐层小图应出现两层
const layerText = await page.locator('#layerCanvas').evaluate((c) => {
  // canvas 无文本节点，改测其被分配了非零高度
  return (c as HTMLCanvasElement).height;
});
if (!(layerText > 60)) throw new Error('逐层小图未渲染叠层');

// 展开最近一次折叠 -> 通关
await page.click('#unfoldBtn');
await page.waitForTimeout(60);
if (!((await statusText()).includes('已对上星图'))) {
  throw new Error(`展开后未通关：${await statusText()}`);
}

// 撤销三步：展开、打孔、折叠，全部回到初始
await page.click('#undoBtn');
await page.click('#undoBtn');
await page.click('#undoBtn');
await page.waitForTimeout(60);
if ((await counters()) !== '折叠 0/1 ｜ 打孔 0/1 ｜ 厚度上限 2 层') {
  throw new Error(`撤销后计数未归零：${await counters()}`);
}
if (!((await statusText()).includes('缺孔 2'))) throw new Error('撤销后目标状态未还原');

// --- 越界动作：在没有纸的位置打孔应被拒绝且计数不变 ---
await page.check('#modePunch');
await page.mouse.click(box.x + 5 * 64, box.y + 0.5 * 64); // 远离纸面
await page.waitForTimeout(60);
if ((await counters()).includes('打孔 1/1')) throw new Error('空处打孔被错误结算');

// --- 切到第 4 关（横折后竖折），自动播放示例并确认通关 ---
await page.selectOption('#levelSelect', '4');
await page.click('#demoBtn');
await page.waitForSelector('#stopDemoBtn', { state: 'hidden', timeout: 8000 });
await page.waitForTimeout(200);
if (!((await statusText()).includes('已对上星图'))) {
  throw new Error(`第 4 关示例未通关：${await statusText()}`);
}

// --- 第 5 关：负坐标落点示例同样通关 ---
await page.selectOption('#levelSelect', '5');
await page.click('#demoBtn');
await page.waitForSelector('#stopDemoBtn', { state: 'hidden', timeout: 8000 });
await page.waitForTimeout(200);
if (!((await statusText()).includes('已对上星图'))) {
  throw new Error(`第 5 关示例未通关：${await statusText()}`);
}

await page.screenshot({ path: 'tmp/browser-final.png', fullPage: false });
await browser.close();

if (errors.length) throw new Error('浏览器报错：\n' + errors.join('\n'));
console.log('browser smoke OK: 折叠/部分打穿/展开通关/撤销/越界拒绝/示例播放 全部通过');
