/**
 * 浏览器端到端冒烟（不在 npm test 内，需先 npm run build 并启动 vite preview）。
 * 用法：node tests/e2e/browser-smoke.mjs
 */
import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
import { existsSync, statSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const chrome =
  process.env.CHROME_BIN ||
  resolve(
    process.env.HOME,
    'Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );

const BASE = process.env.APP_URL || 'http://127.0.0.1:4317';
const shots = resolve(here, 'shots');
rmSync(shots, { recursive: true, force: true });

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1320, height: 1500 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

const step = (name) => console.log(`• ${name}`);

// 1. 页面加载，首次自动测量完成
step('加载页面并等待首次离线测量');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(
  () => document.querySelector('#measure-stat')?.textContent?.includes('模式'),
  { timeout: 15000 },
);
const stat0 = await page.textContent('#measure-stat');
assert.ok(stat0.includes('折叠') || stat0.includes('多出'), `首测状态异常: ${stat0}`);

// 画布非空
const canvasPainted = await page.evaluate(() => {
  const c = document.getElementById('measured-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});
assert.ok(canvasPainted > 500, `实测画布几乎空白，非透明像素 ${canvasPainted}`);

// 2. 运行全部 8 项本地检查
step('运行浏览器内 8 项本地检查');
await page.click('#btn-run-checks');
await page.waitForFunction(
  () => {
    const items = [...document.querySelectorAll('#check-list li')];
    return items.length === 8 && items.every((li) => /pass|fail/.test(li.className));
  },
  { timeout: 30000 },
);
const checkSummary = await page.$$eval('#check-list li', (lis) =>
  lis.map((li) => ({ cls: li.className, title: li.querySelector('span:nth-child(2)').textContent })),
);
const failed = checkSummary.filter((c) => c.cls.includes('fail'));
for (const c of checkSummary) console.log(`   ${c.cls.includes('pass') ? '✓' : '✗'} ${c.title}`);
assert.equal(failed.length, 0, `有检查未通过: ${failed.map((f) => f.title).join('; ')}`);

// 3. 正弦预设：不应出现“多出的真峰”
step('切到正弦预设，验证没有假谐波');
await page.click('[data-preset="sine"]');
await page.waitForTimeout(500);
const extraText = await page.textContent('#extra-list');
assert.ok(extraText.includes('没有'), `正弦例出现多余成分: ${extraText}`);

// 4. 高音 G6 + A 模式：必须出现折叠分量（先切回尖锯齿，正弦本就无高次谐波）
step('高音 G6 + A 直接循环，验证折叠低响被测到');
await page.click('[data-preset="sharp-saw"]');
await page.waitForTimeout(400);
await page.click('.note-btn[data-midi="91"]');
await page.selectOption('#measure-mode', 'naive');
await page.click('#btn-measure');
await page.waitForFunction(
  () => {
    const t = document.querySelector('#measure-stat')?.textContent || '';
    const m = t.match(/折叠 (\d+)/);
    return t.includes('dBFS') && m !== null && Number(m[1]) > 0;
  },
  { timeout: 15000 },
);
const statHigh = await page.textContent('#measure-stat');
console.log(`   ${statHigh.trim()}`);
assert.match(statHigh, /折叠 [1-9]\d*/);

// 5. 切 B 模式：折叠归零
step('同音符切 B 限带，折叠应消失');
await page.selectOption('#measure-mode', 'bandlimited');
await page.click('#btn-measure');
await page.waitForFunction(
  () => {
    const t = document.querySelector('#measure-stat')?.textContent || '';
    const m = t.match(/折叠 (\d+)/);
    return t.includes('dBFS') && m !== null && Number(m[1]) === 0;
  },
  { timeout: 15000 },
);

// 6. A/B 推子与扫频控件存在且可动
step('操作 A/B 混合推子与扫频推子');
await page.fill('#ab-fader', '500');
assert.equal(await page.textContent('#ab-fader-stat'), 'A 50% / B 50%');
await page.fill('#pitch-fader', '12');
assert.match(await page.textContent('#pitch-stat'), /\+12\.0/);

// 7. 实时发音链路（AudioWorklet 真出声路径，headless 下验证无报错即可）
step('触发实时发音与持续开关');
await page.click('#btn-sustain');
await page.waitForTimeout(800);
const engineStat = await page.textContent('#engine-stat');
assert.ok(engineStat.includes('采样率'), `引擎状态异常: ${engineStat}`);
await page.click('#btn-sustain'); // 关

// 8. WAV 导出下载
step('导出当前音色 WAV（A/B 立体声）');
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 10000 }),
  page.click('#btn-export-tone'),
]);
const wavPath = resolve(shots, 'tone.wav');
await download.saveAs(wavPath);
assert.ok(existsSync(wavPath));
assert.ok(statSync(wavPath).size > 44 + 1000, 'WAV 文件过小');
console.log(`   WAV ${statSync(wavPath).size} 字节`);

// 9. 设置导出/导入往返
step('导出并重新导入设置 JSON');
const [dl2] = await Promise.all([
  page.waitForEvent('download', { timeout: 10000 }),
  page.click('#btn-export-settings'),
]);
const settingsPath = resolve(shots, 'settings.json');
await dl2.saveAs(settingsPath);
// 导出时的实际预设（可能是 custom），导入后应原样恢复
const { readFileSync } = await import('node:fs');
const exportedPreset = JSON.parse(readFileSync(settingsPath, 'utf8')).presetId;
// 先切到别的预设制造状态差异，再导入应恢复
await page.click('[data-preset="notched"]');
await page.waitForTimeout(300);
await page.setInputFiles('#import-settings', settingsPath);
await page.waitForTimeout(400);
if (exportedPreset === 'custom') {
  // custom 没有专属按钮：三个预设按钮都不应高亮
  const anyActive = await page.$$eval('[data-preset]', (bs) => bs.some((b) => b.classList.contains('active')));
  assert.ok(!anyActive, '导入 custom 设置后不应有预设按钮高亮');
} else {
  const presetActive = await page.$eval(
    `[data-preset="${exportedPreset}"]`,
    (b) => b.classList.contains('active'),
  );
  assert.ok(presetActive, `导入设置后预设 ${exportedPreset} 未恢复`);
}
console.log(`   预设 "${exportedPreset}" 往返恢复成功`);

await page.screenshot({ path: resolve(shots, 'full-page.png'), fullPage: true });

assert.equal(errors.length, 0, `浏览器报错:\n${errors.join('\n')}`);
await browser.close();
console.log('\n全部浏览器端到端检查通过 ✓ 截图与产物在 tests/e2e/shots/');
