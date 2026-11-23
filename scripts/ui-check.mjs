/**
 * 界面自检: 用 puppeteer-core 驱动真实页面, 覆盖
 *   1. 两种曲面片的初始状态
 *   2. 厚度/方向切换后的有效性
 *   3. 画布点选侧壁 -> 反查原始边
 *   4. 画布点选曲面 -> 区域检查
 *   5. 问题侧壁隔离、侧壁外移、问题点定位
 *   6. 导出 + 读回、非法 OBJ 读回
 *   7. 内置预设与厚度归零回归
 * 用法: npm run dev 另开终端, 然后 node scripts/ui-check.mjs
 */
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.URL ?? 'http://localhost:5173/';
const OUT = process.env.OUT ?? '/tmp/ui';
const steps = [];

function record(name, ok, detail) {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('favicon')) pageErrors.push(message.text());
});

const wait = (ms = 450) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (selector) => page.$eval(selector, (element) => element.innerText);
const shot = (name) => page.screenshot({ path: `${OUT}-${name}.png` });
const solid = () => page.evaluate(() => {
  const model = window.__inspector.getSolid();
  return {
    id: model.model.id,
    valid: model.validation.valid,
    closed: model.validation.topology.closed,
    manifold: model.validation.topology.manifold,
    folds: model.validation.foldedOffsetTriangles.length,
    intersections: model.validation.intersectionTotal,
    problemWalls: model.sideWalls.filter((wall) => wall.problem).length,
    walls: model.sideWalls.length,
    messages: model.validation.messages,
  };
});
const clickWorld = async (point) => {
  const screen = await page.evaluate((worldPoint) => {
    const canvas = document.querySelector('canvas');
    return window.__debugProject(worldPoint, canvas.getBoundingClientRect());
  }, point);
  await page.mouse.click(screen.x, screen.y);
  await wait(400);
  return screen;
};

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__inspector?.getSolid());
await wait(500);

// 1. 初始碗形片
let state = await solid();
record('碗形片默认有效', state.valid && state.closed && state.manifold && state.intersections === 0);
record('碗形片两条边界都生成侧壁', state.walls === 168, `sideWalls=${state.walls}`);
await shot('01-bowl');

// 2. 画布点选侧壁
const outerWall = await page.evaluate(() => {
  const app = window.__inspector;
  const current = app.getSolid();
  const model = app.getModel();
  const wall = current.sideWalls.find((item) => item.loopKind === 'outer');
  const base = model.positions.length / 3;
  const ids = [wall.a, wall.b, wall.a + base, wall.b + base];
  const mid = [0, 1, 2].map((axis) => ids.reduce((sum, id) => sum + current.positions[id * 3 + axis], 0) / 4);
  return { edgeId: wall.edgeId, mid };
});
await clickWorld(outerWall.mid);
const traceText = await text('#wall-trace');
record(
  '点选外缘侧壁反查到原始边',
  traceText.includes(`边 #${outerWall.edgeId}`) && traceText.includes('源三角形') && traceText.includes('端点坐标'),
  traceText.split('\n').slice(0, 2).join(' '),
);
await shot('02-side-trace');

// 3. 切折片 -> 默认有效
await page.click('#model-switch button[data-model="flap"]');
await wait(700);
state = await solid();
record('折片默认有效', state.valid && state.walls === 174);
await shot('03-flap');

// 4. 凹角过厚
await page.click('#preset-buttons button:nth-child(2)');
await wait(900);
state = await solid();
record(
  '凹角过厚判为无效',
  !state.valid && state.folds > 0 && state.intersections > 0 && state.problemWalls > 0,
  `反折=${state.folds} 穿插=${state.intersections} 问题侧壁=${state.problemWalls}`,
);
await shot('04-flap-thick');

// 5. 隔离问题侧壁
await page.click('#show-problem-only');
await wait(500);
await shot('05-isolate-problem');
await page.click('#show-problem-only');
await wait(300);

// 6. 侧壁外移
await page.evaluate(() => {
  const slider = document.getElementById('explode');
  slider.value = '0.18';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
});
await wait(400);
await shot('06-explode');
await page.evaluate(() => {
  const slider = document.getElementById('explode');
  slider.value = '0';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
});
await wait(300);

// 7. 定位问题三角形
const foldButton = await page.$('[data-focus-fold]');
await foldButton.click();
await wait(700);
record(
  '定位反折三角形并自动选中区域',
  (await text('#view-status')).includes('定位到源三角形') && (await text('#region-report')).includes('实测间隙'),
);
await shot('07-focus-fold');

// 8. 画布点选区域 (薄折片)
await page.evaluate(() => {
  const slider = document.getElementById('thickness');
  slider.value = '0.045';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
});
await wait(800);
await page.click('#region-pick-mode');
await wait(200);
const regionPoint = await page.evaluate(() => {
  const app = window.__inspector;
  const model = app.getModel();
  const current = app.getSolid();
  const triangle = 300;
  const ids = [0, 1, 2].map((k) => model.indices[triangle * 3 + k]);
  return [0, 1, 2].map((axis) => ids.reduce((sum, id) => sum + current.positions[id * 3 + axis], 0) / 3);
});
await clickWorld(regionPoint);
const thinRegion = await text('#region-report');
record(
  '画布点选曲面得到区域报告, 薄壳厚度吻合',
  thinRegion.includes('名义厚度') && thinRegion.includes('0.045') && thinRegion.includes('翻转三角形'),
  thinRegion.split('\n').slice(0, 4).join(' '),
);
await shot('08-region-pick');
await page.click('#region-pick-mode');

// 9. 导出 + 读回 (有效几何)
await page.click('#model-switch button[data-model="bowl"]');
await wait(800);
await page.click('#export-obj');
await wait(500);
await page.click('#readback-obj');
await wait(1000);
const validReadback = await text('#obj-report');
record(
  '有效实体导出一读回复核通过',
  validReadback.includes('读回复核: 通过') && validReadback.includes('自相交'),
  validReadback.split('\n').slice(0, 2).join(' '),
);
await shot('09-readback-valid');

// 10. 非法 OBJ 文件读回
const badPath = `${OUT}-bad.obj`;
writeFileSync(badPath, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
const fileInput = await page.$('#obj-file');
await fileInput.uploadFile(badPath);
await wait(900);
const badReadback = await text('#obj-report');
record(
  '非法 OBJ 给出明确未闭合提示',
  badReadback.includes('未通过') && badReadback.includes('未闭合'),
  badReadback.split('\n').slice(0, 2).join(' '),
);

// 11. 内置验证参数
await page.click('#run-presets');
await wait(1500);
const presetReport = await text('#preset-report');
record('内置验证参数全部符合预期', presetReport.includes('全部符合预期'), presetReport.split('\n')[1]);

// 12. 厚度归零回归
await page.click('#run-regression');
await wait(1500);
const regression = await text('#regression-report');
record('厚度归零回不改动源网格', regression.includes('回归: 通过'), regression.split('\n')[1]);

record('页面无运行时错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = steps.filter((step) => !step.ok);
console.log(`\n${steps.length - failed.length}/${steps.length} 项通过`);
if (failed.length > 0) process.exit(1);
