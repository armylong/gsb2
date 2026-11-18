// 端到端冒烟测试：用系统 Chrome 无头模式驱动页面，验证交互与应用内固定机位像素检查。
// 运行方式：先启动 vite（npm run dev），再执行 `node tests/e2e-smoke.mjs`。
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5234';
const SHOT_DIR = fileURLToPath(new URL('../test-results/', import.meta.url));
await mkdir(SHOT_DIR, { recursive: true });
const shot = (name) => `${SHOT_DIR}${name}.png`;

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));

const failures = [];
function check(name, cond, extra = '') {
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures.push(name);
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#scene');
  await page.waitForTimeout(800); // 等首帧渲染

  check('页面加载且无控制台错误', consoleErrors.length === 0, consoleErrors.join(' | '));

  // 三种布局切换 + 截图
  for (const layout of ['separated', 'occlusion', 'touch']) {
    await page.click(`[data-layout="${layout}"]`);
    await page.waitForTimeout(300);
    const active = await page.getAttribute(`[data-layout="${layout}"]`, 'class');
    check(`布局 ${layout} 按钮激活`, active.includes('active'));
    await page.screenshot({ path: shot(`layout-${layout}`) });
  }

  // 通过列表面板选择两个对象（确定性，不依赖像素命中）
  const items = page.locator('#object-list li');
  const count = await items.count();
  check('场景内可选对象为 9 个（不超过 12）', count === 9, `实际 ${count}`);
  await items.nth(0).click();
  await items.nth(6).click(); // L 形（id=7）
  await page.waitForTimeout(200);
  const selectedCount = await page.locator('#object-list li.selected').count();
  check('可追加选择，列表与场景同步（2 个选中）', selectedCount === 2);
  await page.screenshot({ path: shot('selected-two') });

  // 取消选择
  await items.nth(0).click();
  check(
    '再次点击可取消选择',
    (await page.locator('#object-list li.selected').count()) === 1,
  );

  // 模式切换
  await page.click('#btn-visible');
  check(
    '仅可见轮廓模式激活',
    (await page.getAttribute('#btn-visible', 'class')).includes('active'),
  );
  check(
    '切换后遮挡模式按钮取消激活',
    !(await page.getAttribute('#btn-hidden', 'class')).includes('active'),
  );
  await page.click('#btn-hidden');
  check(
    '可见+遮挡轮廓模式激活',
    (await page.getAttribute('#btn-hidden', 'class')).includes('active'),
  );

  // 宽度滑块 1..6
  const widthSlider = page.locator('#width-slider');
  await widthSlider.fill('6');
  await widthSlider.dispatchEvent('input');
  check(
    '宽度可调到 6px',
    (await page.textContent('#width-label')) === '6 px',
  );
  await widthSlider.fill('1');
  await widthSlider.dispatchEvent('input');
  check('宽度可调到 1px', (await page.textContent('#width-label')) === '1 px');
  await widthSlider.fill('2');
  await widthSlider.dispatchEvent('input');

  // 挡板滑块
  const occSlider = page.locator('#occluder-slider');
  await occSlider.fill('-1.5');
  await occSlider.dispatchEvent('input');
  check(
    '挡板位置可调',
    (await page.textContent('#occluder-label')) === '-1.50',
  );
  await occSlider.fill('0');
  await occSlider.dispatchEvent('input');

  // 隐藏所选 -> 列表标记、清空选择；恢复全部
  await page.click('#btn-clear');
  await items.nth(6).click(); // 明确只选中 L 形
  await page.click('#btn-hide');
  check(
    '隐藏后选中被清空',
    (await page.locator('#object-list li.selected').count()) === 0,
  );
  check(
    '被隐藏对象显示已隐藏标记',
    (await page.locator('#object-list li.hidden-item').count()) >= 1,
  );
  await page.screenshot({ path: shot('hidden-one') });
  await page.click('#btn-restore');
  check(
    '恢复全部后无隐藏标记',
    (await page.locator('#object-list li.hidden-item').count()) === 0,
  );

  // 恢复视角
  await page.click('#btn-reset-view');
  check('恢复视角按钮可点击（无报错）', consoleErrors.length === 0);

  // 清空选择
  await items.nth(0).click();
  await page.click('#btn-clear');
  check(
    '清空选择立即移除全部高亮',
    (await page.locator('#object-list li.selected').count()) === 0,
  );

  // 应用内固定机位像素验证
  await page.click('#btn-verify');
  await page.waitForFunction(
    () => !document.getElementById('verify-results').textContent.startsWith('验证中'),
    { timeout: 15000 },
  );
  const report = await page.textContent('#verify-results');
  console.log('\n----- 应用内验证报告 -----\n' + report + '\n--------------------------\n');
  check('固定机位验证全部 PASS（5/5）', /5\/5 通过/.test(report) && !report.includes('FAIL'));
  await page.screenshot({ path: shot('after-verify') });

  check('全程无控制台错误', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (err) {
  failures.push('异常: ' + err.message);
  console.error(err);
  await page.screenshot({ path: shot('error') });
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} 项失败：\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\n全部冒烟检查通过。截图见 test-results/。');
