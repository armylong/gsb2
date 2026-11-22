/**
 * 交互冒烟测试 (不进 npm test, 仅手工/CI 可视化验证用):
 * 驱动真实 Chrome 验证场景切换、半径更新、剖切两种统计口径、点击选点。
 * 运行: node --experimental-strip-types scripts/smoke.ts
 */
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.VIEWER_URL ?? 'http://127.0.0.1:5173/';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readText = (sel: string): Promise<string> =>
  page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? 'MISSING', sel);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--disable-gpu', '--use-angle=swiftshader', '--no-sandbox', '--window-size=1400,900'],
});
const page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('CVDisplayLink')) errors.push(`console: ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'networkidle0' });
await sleep(800);
const results: Array<[string, boolean, string]> = [];
const check = (name: string, cond: boolean, detail: string) => results.push([name, cond, detail]);

// 1. 初始平面场景: 验证表有 F1
let f1 = await readText('#validation tr:nth-child(8) td:last-child');
check('初始场景 Otsu F1 已计算', /^0\.\d+$/.test(f1), `F1=${f1}`);

// 2. 切换到球壳场景
await page.evaluate(() => {
  const r = document.querySelector<HTMLInputElement>('input[name=scene][value=shell]')!;
  r.checked = true;
  r.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(300);
const shellDesc = await readText('#scene-desc');
check('切换球壳场景描述更新', shellDesc.includes('双层球壳'), shellDesc.slice(0, 20));
const shellRaw = await readText('#raw-count');
check('球壳点数已更新', parseInt(shellRaw, 10) > 2000, `raw=${shellRaw}`);

// 3. 改邻域半径 => 统计即时更新
const oldThr = await readText('#validation tr:nth-child(2) td:last-child');
await page.evaluate(() => {
  const el = document.getElementById('radius') as HTMLInputElement;
  el.value = '0.4';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
const newThr = await readText('#validation tr:nth-child(2) td:last-child');
check('改半径后阈值即时重算', oldThr !== newThr, `${oldThr} -> ${newThr}`);

// 4. 抽样比例变化保持可对比: 点数应近似等比
await page.evaluate(() => {
  const el = document.getElementById('ratio') as HTMLInputElement;
  el.value = '0.5';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
const sampled = parseInt(await readText('#sampled-count'), 10);
const raw = parseInt(await readText('#raw-count'), 10);
check('50% 抽样点数近似一半', Math.abs(sampled / raw - 0.5) < 0.08, `${sampled}/${raw}`);

// 5. 剖切: 排除模式
await page.evaluate(() => {
  const el = document.getElementById('clip-enable') as HTMLInputElement;
  el.checked = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(300);
const excludeStatus = await readText('#clip-status');
check('剖切排除模式文案正确', excludeStatus.includes('不参与') || excludeStatus.includes('既不显示'), excludeStatus);
const nExclude = parseInt((await readText('#validation tr:first-child td:last-child')).replace(/,/g, ''), 10);

// 6. 剖切: 仅隐藏模式 => 参与统计点数应变多
await page.evaluate(() => {
  const el = document.getElementById('clip-exclude') as HTMLInputElement;
  el.checked = false;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(300);
const keepStatus = await readText('#clip-status');
check('仅隐藏模式文案正确', keepStatus.includes('仍参与'), keepStatus);
const nKeep = parseInt((await readText('#validation tr:first-child td:last-child')).replace(/,/g, ''), 10);
check('仅隐藏模式参与点数 > 排除模式', nKeep > nExclude, `${nKeep} > ${nExclude}`);

// 7. 点击点 => 邻域信息出现 (在画布中心附近多点探测直到命中)
let pick = '尚未选择点';
const canvas = await page.$('#viewport canvas');
const box = await canvas!.boundingBox();
const cx = box!.x + box!.width / 2;
const cy = box!.y + box!.height / 2;
for (const [dx, dy] of [[0, 0], [-120, -60], [120, 60], [-60, 120], [60, -120], [180, 0], [-180, 0], [0, 140]]) {
  await page.mouse.click(cx + dx, cy + dy);
  await sleep(150);
  pick = await readText('#pick-info');
  if (pick.includes('邻域大小')) break;
}
check('点击后显示邻域大小与密度', pick.includes('邻域大小') && pick.includes('ppv'), pick.split('\n').slice(0, 2).join(' | '));
if (pick.includes('邻域大小')) {
  await page.screenshot({ path: '/tmp/viewer-pick.png' });
}

// 8. 投影重叠分析按钮
await page.evaluate(() => (document.getElementById('overlap-now') as HTMLButtonElement).click());
await sleep(300);
const note = await readText('#legend-note');
check('投影重叠分析输出占比', note.includes('重叠格') && note.includes('%'), note.slice(0, 40));

// 9. 深度着色模式
await page.evaluate(() => {
  const r = document.querySelector<HTMLInputElement>('input[name=colormode][value=depth]')!;
  r.checked = true;
  r.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(200);
const depthLegend = await readText('#legend-note');
check('深度着色图例切换', depthLegend.includes('深度'), depthLegend);

check('全程无页面/控制台错误', errors.length === 0, errors.join('; ') || 'clean');

let pass = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  [${detail}]`);
  if (ok) pass++;
}
console.log(`\n${pass}/${results.length} checks passed`);
await browser.close();
process.exit(pass === results.length ? 0 : 1);
