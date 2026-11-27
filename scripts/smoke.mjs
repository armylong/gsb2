/**
 * 本地短验证（冒烟）：用系统 Chrome headless 加载页面，
 * 检查图表绘制、例子切换、WAV 导出与回读闭环，并截图。
 * 运行：node scripts/smoke.mjs
 */
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';

mkdirSync('tmp', { recursive: true });

const BASE = process.env.SMOKE_URL ?? 'http://localhost:5173/';
const errors = [];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#spectrum-canvas');
await page.waitForTimeout(300);

// 1) 两张 canvas 都有非空白像素
const blankCheck = await page.evaluate(() => {
  const result = {};
  for (const id of ['spectrum-canvas', 'timeline-canvas']) {
    const cv = document.getElementById(id);
    const ctx = cv.getContext('2d');
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let nonBlank = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonBlank++;
    result[id] = { width: cv.width, height: cv.height, nonBlank };
  }
  return result;
});
console.log('canvas 绘制像素：', JSON.stringify(blankCheck));
if (blankCheck['spectrum-canvas'].nonBlank < 500 || blankCheck['timeline-canvas'].nonBlank < 200) {
  throw new Error('canvas 似乎是空白的');
}

// 2) 三个例子依次切换，警告区与提示应有更新
for (const [btnId, name] of [['ex-static', '静止'], ['ex-glide', '渐变'], ['ex-breathy', '气音']]) {
  await page.click(`#${btnId}`);
  await page.waitForTimeout(200);
  const hint = await page.textContent('#vowel-hint');
  if (!hint || hint.length < 4) throw new Error(`例子 ${name} 的提示未更新`);
  console.log(`例子 ${name} OK：${hint.slice(0, 40)}…`);
}

// 3) 频谱图点击（峰归属提示）
const box = await page.locator('#spectrum-canvas').boundingBox();
await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
await page.waitForTimeout(150);
const tipVisible = await page.evaluate(() => !document.getElementById('spectrum-tip').classList.contains('hidden'));
if (!tipVisible) throw new Error('点击频谱后没有出现峰归属提示');
console.log('频谱点击提示 OK');

// 4) 导出 WAV：拦截下载并校验 RIFF 头，同时检查回读报告渲染
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#export'),
]);
const dlPath = await download.path();
const bytes = readFileSync(dlPath);
const riff = bytes.subarray(0, 4).toString('ascii');
const wave = bytes.subarray(8, 12).toString('ascii');
if (riff !== 'RIFF' || wave !== 'WAVE') throw new Error('下载文件不是合法 WAV');
console.log(`WAV 导出 OK：${download.suggestedFilename()}，${bytes.length} 字节，RIFF/WAVE 头正确`);

await page.waitForTimeout(300);
const reportText = await page.textContent('#readback');
if (!reportText.includes('回读结果') || !reportText.includes('基频')) throw new Error('回读报告未渲染');
if (!reportText.includes('F1') || !reportText.includes('F3')) throw new Error('回读报告缺少共振区行');
console.log('回读报告 OK：', reportText.replace(/\s+/g, ' ').slice(0, 80) + '…');

// 5) 切到气音例子再导出一次，验证弱峰/无峰路径不报页面错误
await page.click('#ex-breathy');
await page.waitForTimeout(200);
await Promise.all([page.waitForEvent('download'), page.click('#export')]);
await page.waitForTimeout(200);

// 6) 截图（明/暗）
await page.screenshot({ path: 'tmp/smoke-light.png', fullPage: true });
await page.click('#theme-toggle');
await page.waitForTimeout(200);
await page.screenshot({ path: 'tmp/smoke-dark.png', fullPage: true });

// 7) 控制台零错误
if (errors.length) {
  console.error('页面错误：', errors);
  process.exitCode = 1;
} else {
  console.log('控制台零错误 ✓');
}
await browser.close();
