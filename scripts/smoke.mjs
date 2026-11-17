// 浏览器端冒烟验证：真实 WebGL 渲染、交互联动、对比模式、响应式
// 运行：node scripts/smoke.mjs <url>
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:5175/';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// 1. WebGL canvas 存在且非空白
const canvasInfo = await page.evaluate(() => {
  const c = document.querySelector('#stage-a canvas');
  if (!c) return { found: false };
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  return { found: true, w: c.width, h: c.height, hasGL: !!gl };
});
check('场景 canvas 已创建并获得 WebGL 上下文', canvasInfo.found && canvasInfo.hasGL,
  `${canvasInfo.w}x${canvasInfo.h}`);

// 2. 初始诊断：基线应出现 all-ok，无 error 卡片
const initialFindings = await page.$$eval('.finding-title', (els) => els.map((e) => e.textContent));
check('基线诊断渲染且无 error 级问题',
  initialFindings.some((t) => t.includes('合理区间')) &&
  !(await page.$('.finding.sev-error')),
  initialFindings.join(' | '));

// 3. 物体状态表 10 行
const stateRows = await page.$$eval('.state-row', (els) => els.length);
check('物体状态表包含全部 10 个物体', stateRows === 10, `${stateRows} 行`);

// 4. 覆盖不足预设：出现 error 诊断 + 红色 HUD 标签
await page.click('[data-preset="smallcover"]');
await page.waitForTimeout(600);
const smallCoverError = await page.$('.finding.sev-error .finding-title');
const smallCoverText = smallCoverError ? await smallCoverError.textContent() : '';
const hudCount1 = await page.$$eval('.hud-label', (els) => els.length);
check('覆盖不足预设触发 error 级“覆盖范围不足”诊断', smallCoverText.includes('覆盖范围不足'), smallCoverText);
check('场景内出现未覆盖物体 HUD 标注', hudCount1 > 0, `${hudCount1} 个标签`);

// 5. 远裁剪预设：诊断归类为远平面而非偏移
await page.click('[data-preset="farclip"]');
await page.waitForTimeout(500);
const farText = await page.$$eval('.finding-title', (els) => els.map((e) => e.textContent).join('|'));
check('far 预设报告“远平面过近”', farText.includes('远平面过近'), farText);
check('远裁剪不被误诊为偏移问题', !farText.includes('条纹') && !farText.includes('脱离'));

// 6. 条纹预设
await page.click('[data-preset="acne"]');
await page.waitForTimeout(500);
const acneText = await page.$$eval('.finding-title', (els) => els.map((e) => e.textContent).join('|'));
check('条纹预设报告“阴影条纹”', acneText.includes('阴影条纹'), acneText);

// 7. 脱离预设
await page.click('[data-preset="peter"]');
await page.waitForTimeout(500);
const peterText = await page.$$eval('.finding-title', (els) => els.map((e) => e.textContent).join('|'));
check('脱离预设报告“阴影脱离”', peterText.includes('阴影脱离'), peterText);

// 8. 低清预设
await page.click('[data-preset="lowres"]');
await page.waitForTimeout(500);
const lowText = await page.$$eval('.finding-title', (els) => els.map((e) => e.textContent).join('|'));
check('低清预设报告“清晰度”问题', lowText.includes('清晰度'), lowText);

// 9. 滑块联动：手动改 orthoSize 后指标变化
const texelBefore = await page.$eval('.metric b', (el) => el.textContent);
await page.evaluate(() => {
  const input = document.querySelector('[data-param="orthoSize"]');
  input.value = 12;
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(400);
const texelAfter = await page.$eval('.metric b', (el) => el.textContent);
check('滑块调整实时反映到指标条', texelBefore !== texelAfter, `${texelBefore} -> ${texelAfter}`);

// 10. 视角切换后诊断更新（覆盖率/视野内外标记变化）
await page.click('[data-preset="smallcover"]');
await page.waitForTimeout(300);
const viewMarksBefore = await page.$$eval('.state-view', (els) => els.map((e) => e.textContent).join(','));
await page.click('[data-view="far"]');
await page.waitForTimeout(500);
const viewMarksAfter = await page.$$eval('.state-view', (els) => els.map((e) => e.textContent).join(','));
check('切换视角后物体视野内/外标记重新计算', viewMarksBefore !== viewMarksAfter);

// 11. 恢复初始状态
await page.click('#reset-scene');
await page.click('#reset-params');
await page.waitForTimeout(500);
const resetFindings = await page.$$eval('.finding-title', (els) => els.map((e) => e.textContent));
check('重置后回到基线诊断（无 error）',
  resetFindings.some((t) => t.includes('合理区间')) && !(await page.$('.finding.sev-error')));

// 12. 物体拖动：开启拖动模式 -> 选中物体 -> 在 gizmo 上拖拽 -> 位置与诊断更新
await page.click('#reset-view'); // 前面切过远眺视角，先回到透视全景确保物体在屏内
await page.check('#move-toggle');
await page.click('[data-object="box"]');
await page.waitForTimeout(400);
const gizmo = await page.evaluate(() => {
  const app = window.__shadowBench;
  const mesh = app.benchA.meshes.get('box');
  const v = mesh.position.clone().project(app.benchA.camera);
  return { x: (v.x + 1) / 2, y: (1 - v.y) / 2, z: v.z };
});
const canvasRect = await page.locator('#stage-a canvas').boundingBox();
const boxBefore = await page.evaluate(() =>
  window.__shadowBench.benchA.objectDefs.find((d) => d.id === 'box').position.map((v) => +v.toFixed(3)).join(','));
let boxAfter = boxBefore;
// TransformControls 的拾取有阈值，gizmo 轴可能偏离原点几个像素，做有限重试
for (const [ox, oy] of [[0, 0], [8, 0], [-8, 0], [0, 8]]) {
  const gx = canvasRect.x + gizmo.x * canvasRect.width + ox;
  const gy = canvasRect.y + gizmo.y * canvasRect.height + oy;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(gx + i * 10, gy);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
  boxAfter = await page.evaluate(() =>
    window.__shadowBench.benchA.objectDefs.find((d) => d.id === 'box').position.map((v) => +v.toFixed(3)).join(','));
  if (boxAfter !== boxBefore) break;
}
check('拖动物体后位置发生变化（TransformControls 生效）', boxBefore !== boxAfter, `${boxBefore} → ${boxAfter}`);

// 经应用接口把物体移到覆盖区外，验证诊断联动（与拖动回调同一条刷新链路）
const movedOut = await page.evaluate(() => {
  const app = window.__shadowBench;
  const def = app.benchA.objectDefs.find((d) => d.id === 'box');
  def.position = [26, 1, 4];
  app.benchA.meshes.get('box').position.set(26, 1, 4);
  app.benchA.statusRings.get('box').position.set(26, 1, 4);
  app.refresh('A');
  const titles = [...document.querySelectorAll('.finding-title')].map((e) => e.textContent);
  const row = [...document.querySelectorAll('.state-row')].find((r) => r.textContent.includes('立方体'));
  return {
    stateText: row.textContent.replace(/\s+/g, ' ').trim(),
    hasCoverageFinding: titles.some((t) => t.includes('覆盖范围不足')),
  };
});
check('物体移出覆盖区后状态表与覆盖诊断联动更新',
  movedOut.stateText.includes('超出正交范围') && movedOut.hasCoverageFinding,
  movedOut.stateText);

// 13. A/B 对比模式
await page.click('#reset-scene');
await page.waitForTimeout(400);
await page.click('#mode-compare');
await page.waitForTimeout(900);
const twoCanvases = await page.$$eval('.stage canvas', (els) => els.length);
check('对比模式出现两个场景 canvas', twoCanvases === 2, `${twoCanvases} 个`);
const diffEntries = await page.$$eval('.diff-entry, .diff-empty', (els) => els.length);
check('对比模式渲染差异面板', diffEntries >= 1, `${diffEntries} 条`);

// B 组改参数后差异出现
await page.check('input[name="active-side"][value="B"]');
await page.waitForTimeout(200);
await page.click('[data-preset="smallcover"]');
await page.waitForTimeout(700);
const diffWorse = await page.$$eval('.diff-entry', (els) =>
  els.some((e) => e.textContent.includes('覆盖范围不足')));
check('B 组改坏后差异面板出现覆盖问题条目', diffWorse);

// 14. 窗口尺寸变化
await page.setViewportSize({ width: 800, height: 1100 });
await page.waitForTimeout(500);
const narrowCanvas = await page.evaluate(() => {
  const c = document.querySelector('#stage-a canvas');
  return { w: c.clientWidth, h: c.clientHeight };
});
check('窄窗口下场景仍有有效尺寸', narrowCanvas.w > 200 && narrowCanvas.h > 200,
  `${narrowCanvas.w}x${narrowCanvas.h}`);
await page.setViewportSize({ width: 480, height: 900 });
await page.waitForTimeout(500);
const phoneCanvas = await page.evaluate(() => {
  const c = document.querySelector('#stage-a canvas');
  return { w: c.clientWidth, h: c.clientHeight };
});
check('手机宽度下场景与控件仍可用', phoneCanvas.w > 200 && phoneCanvas.h > 150,
  `${phoneCanvas.w}x${phoneCanvas.h}`);

// 15. 全程无 JS 错误
check('运行期间无未捕获 JS/控制台错误', errors.length === 0, errors.slice(0, 3).join(' || '));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
await browser.close();
process.exit(failed ? 1 : 0);
