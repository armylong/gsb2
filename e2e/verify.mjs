import { chromium } from 'playwright';

const URL = `http://127.0.0.1:${process.env.PORT || 5173}/`;
const SHOT = '/tmp/cam-shots';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readHud(page) {
  return page.$$eval('.hud-cell', (cells) => {
    const out = {};
    for (const c of cells) out[c.querySelector('.k').textContent.trim()] =
      c.querySelector('.v').textContent.trim();
    return out;
  });
}

async function constrainedVisible(page) {
  return page.$eval('#hud-warning', (el) => !el.hidden);
}

async function selectLevel(page, id) {
  await page.click(`[data-level="${id}"]`);
  await sleep(400);
}

async function hold(page, key, ms) {
  await page.keyboard.down(key);
  await sleep(ms);
  await page.keyboard.up(key);
  await sleep(200);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL);
await page.waitForSelector('#viewport canvas');
await sleep(800);

// ---------- 1. 初始开阔地：期望=实际 ----------
let hud = await readHud(page);
console.log('[初始]', JSON.stringify(hud));
const d0 = parseFloat(hud['期望距离']);
const a0 = parseFloat(hud['实际距离']);
console.assert(Math.abs(d0 - a0) < 0.05, '开阔地期望与实际应相等');

// ---------- 2. 墙角预设：W 冲向横墙，应缩近 ----------
await selectLevel(page, 'corner');
await hold(page, 'w', 2600);
hud = await readHud(page);
console.log('[墙前]', JSON.stringify(hud));
const nearWallActual = parseFloat(hud['实际距离']);
const nearWallClear = parseFloat(hud['实际最小净距']);
console.assert(nearWallActual < d0 - 0.3, '墙前应明显缩近');
console.assert(nearWallClear >= -0.02, '墙前净距不得为负(穿模)');
await page.screenshot({ path: `${SHOT}/01-wall-front.png` });

// ---------- 3. 倒退离开，应平滑恢复 ----------
await hold(page, 's', 2600);
hud = await readHud(page);
console.log('[离墙]', JSON.stringify(hud));
const restored = parseFloat(hud['实际距离']);
console.assert(restored > nearWallActual + 0.5, '离墙后实际距离应恢复');
console.assert(parseFloat(hud['实际最小净距']) >= -0.02, '恢复过程不穿模');

// ---------- 4. 快速转向后核查主画面不穿墙 ----------
await page.mouse.move(640, 400);
await page.mouse.down();
for (let i = 0; i < 8; i++) {
  await page.mouse.move(640 + (i + 1) * 60, 400);
  await sleep(16);
}
await page.mouse.up();
await sleep(300);
hud = await readHud(page);
console.log('[快转]', JSON.stringify(hud));
console.assert(parseFloat(hud['实际最小净距']) >= -0.02, '快速转向后不穿模');
await page.screenshot({ path: `${SHOT}/02-quick-turn.png` });

// ---------- 5. 低顶预设：走到门梁/顶板下，俯仰检查 ----------
await selectLevel(page, 'lowceiling');
await hold(page, 'w', 3200);
hud = await readHud(page);
console.log('[低顶]', JSON.stringify(hud));
console.assert(parseFloat(hud['实际最小净距']) >= -0.02, '低顶下相机不穿顶');
await page.screenshot({ path: `${SHOT}/03-low-ceiling.png` });
// 抬头（鼠标上拖，pitch 减小）再查
await page.mouse.move(640, 400);
await page.mouse.down();
await page.mouse.move(640, 200);
await page.mouse.up();
await sleep(300);
hud = await readHud(page);
console.log('[低顶抬头]', JSON.stringify(hud));
console.assert(parseFloat(hud['实际最小净距']) >= -0.02, '抬头近裁面不穿顶');
await page.screenshot({ path: `${SHOT}/04-low-ceiling-lookup.png` });

// ---------- 6. 狭道预设：用检查路线航点逐步推进，穿窄门应出现受限提示 ----------
await selectLevel(page, 'narrow');
// 连点“下一步”到第 6 个航点（穿窄门）
for (let i = 0; i < 5; i++) {
  await page.click('#btn-wp-next');
  await sleep(250);
}
hud = await readHud(page);
let constrained = await constrainedVisible(page);
console.log('[窄门航点]', JSON.stringify(hud), '受限提示=', constrained);
console.assert(constrained === true, '窄门航点应显示受限提示');
console.assert(parseFloat(hud['实际最小净距']) >= -0.02, '受限姿态仍不穿模');
await page.screenshot({ path: `${SHOT}/05-narrow-gate.png` });
// 再点到退出航点，应解除受限并恢复距离
await page.click('#btn-wp-next');
await sleep(500);
hud = await readHud(page);
constrained = await constrainedVisible(page);
console.log('[退出窄道]', JSON.stringify(hud), '受限提示=', constrained);
console.assert(constrained === false, '退出后受限解除');

// ---------- 6b. 低顶航点：跳到低矮顶板区段，平视也应被限制 ----------
await selectLevel(page, 'lowceiling');
for (let i = 0; i < 4; i++) {
  await page.click('#btn-wp-next');
  await sleep(250);
}
hud = await readHud(page);
console.log('[低顶航点]', JSON.stringify(hud));
const lowClear = parseFloat(hud['实际最小净距']);
// 无合法位姿时净距显示为状态文案（NaN），否则必须非负不穿顶
console.assert(Number.isNaN(lowClear) || lowClear >= -0.02, '低顶航点不穿顶或进入冻结安全姿态');
await page.screenshot({ path: `${SHOT}/07-low-ceiling-waypoint.png` });

// ---------- 7. 碰撞开关对照 ----------
await selectLevel(page, 'corner');
await hold(page, 'w', 2600);
await page.keyboard.press('c');
await sleep(400);
hud = await readHud(page);
console.log('[碰撞关]', JSON.stringify(hud));
const offActual = parseFloat(hud['实际距离']);
const offDesired = parseFloat(hud['期望距离']);
console.assert(Math.abs(offActual - offDesired) < 0.05, '关闭碰撞后实际=期望(允许穿)');
await page.keyboard.press('c');
await sleep(400);
hud = await readHud(page);
console.assert(parseFloat(hud['实际距离']) < offDesired - 0.2, '重新开启后恢复缩近');

// ---------- 8. 窗口变化 ----------
await page.setViewportSize({ width: 900, height: 600 });
await sleep(400);
hud = await readHud(page);
console.log('[缩放后]', JSON.stringify(hud));
await page.screenshot({ path: `${SHOT}/06-resized.png` });
console.assert(!isNaN(parseFloat(hud['帧率'])), '缩放后仍正常渲染');

// ---------- 9. 辅助图开关 ----------
const mmBefore = await page.$eval('#minimap', (el) => !el.hidden);
await page.keyboard.press('m');
const mmAfter = await page.$eval('#minimap', (el) => !el.hidden);
console.log('[辅助图]', mmBefore, '->', mmAfter);
console.assert(mmBefore === true && mmAfter === false, 'M 键切换辅助图');
await page.keyboard.press('m');

console.log('\n控制台错误:', errors.length ? errors : '无');
await browser.close();
console.log('E2E 完成');
