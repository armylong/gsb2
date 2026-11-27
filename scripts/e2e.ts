/**
 * 真实浏览器端到端验证（由 `node` 经 tsx 或 playwright 运行）：
 * 启动发声 → worklet 出数 → 切听法等电平 → 扫频 → 渲染选段 → 导出 WAV →
 * 回读分析 → 两种循环模式与接缝数据。
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173/';

const results: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1500, height: 1050 },
  acceptDownloads: true,
});
const page = await context.newPage();
const consoleErrors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(BASE);
await page.waitForSelector('#btn-start');

// 1. 开始发声，等待 worklet 块进入环形缓冲并画出波形
await page.click('#btn-start');
await page.waitForTimeout(1200);
const wavePainted = await page.evaluate(() => {
  const cv = document.getElementById('cv-wave') as HTMLCanvasElement;
  const ctx = cv.getContext('2d')!;
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let nonBg = 0;
  for (let i = 0; i < d.length; i += 400) if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) nonBg++;
  return nonBg > 30;
});
check('发声后波形画布有数据', wavePainted);

// 2. 电平表非零且左右接近（split 等幅，等功率路由）
const meters = await page.evaluate(() => {
  const dbg = (window as any).__beats;
  return dbg.engine.readMeters();
});
check('左右电平非零且接近（等功率）', meters[0] > 0.05 && Math.abs(meters[0] - meters[1]) / meters[0] < 0.05,
  `L=${meters[0].toFixed(4)} R=${meters[1].toFixed(4)}`);

// 3. 切到 mix，确认无报错且继续出数
await page.click('#mode-seg button[data-mode="mix"]');
await page.waitForTimeout(600);
const mixWave = await page.evaluate(() => {
  const cv = document.getElementById('cv-wave') as HTMLCanvasElement;
  const ctx = cv.getContext('2d')!;
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 400) if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) n++;
  return n;
});
check('混合模式下波形持续', mixWave > 30);
await page.click('#mode-seg button[data-mode="split"]');

// 4. 频率拖动（改 B 到 460），读数更新
await page.fill('#num-B', '460');
await page.dispatchEvent('#num-B', 'input');
await page.waitForTimeout(300);
const readB = await page.textContent('#read-fB');
check('频率拖动后读数连续更新', readB!.includes('460.00'), readB!);

// 5. 同频预设：拍动停止，包络应近似恒定。
// 只取最近 0.5 秒（避开切换瞬间的过渡），用真实 DSP 包络比较变异系数。
const envelopeCV = (): Promise<number> =>
  page.evaluate(() => {
    const env = (window as any).__beats.ring.snapshots()[6] as Float32Array;
    const recent = env.subarray(Math.max(0, env.length - 3000));
    const mean = recent.reduce((a: number, b: number) => a + b, 0) / recent.length;
    const variance = recent.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / recent.length;
    return Math.sqrt(variance) / (mean || 1e-9);
  });
await page.click('button[data-preset="small"]');
await page.waitForTimeout(1500);
const beatingCV = await envelopeCV();
await page.click('button[data-preset="same"]');
await page.waitForTimeout(1500);
const flatCV = await envelopeCV();
check(
  '同频时包络恒定（拍动停止）',
  flatCV < 0.05 && flatCV < beatingCV * 0.3,
  `同频变异系数 ${flatCV.toFixed(4)} vs 2Hz 拍 ${beatingCV.toFixed(4)}`,
);

// 6. 扫频预设执行
await page.click('button[data-preset="sweep"]');
await page.waitForSelector('#sweep-row:not(.hidden)');
await page.fill('#sweep-time', '2');
await page.click('#btn-sweep-go');
await page.waitForTimeout(2400);
const afterSweep = await page.textContent('#read-fB');
check('扫频结束 B 到达 448', Math.abs(parseFloat(afterSweep!) - 448) < 0.2, afterSweep!);

// 7. 渲染选段 + 接缝数据
await page.fill('#seg-dur', '1');
await page.fill('#seg-a0', '440');
await page.fill('#seg-a1', '440');
await page.fill('#seg-b0', '444');
await page.fill('#seg-b1', '444');
await page.click('#btn-render');
await page.waitForTimeout(500);
const seam1 = await page.textContent('#seam-data');
check('整周期段接缝相位连续', seam1!.includes('✓ 连续'), seam1!.split('\n').slice(3, 6).join(' | '));

// 非整周期
await page.fill('#seg-dur', '0.333');
await page.click('#btn-render');
await page.waitForTimeout(400);
const seam2 = await page.textContent('#seam-data');
check('非整周期段检出相位未接上', seam2!.includes('✗ 未接上'), seam2!.split('\n').find((l) => l.includes('跳变'))!);

// 8. 导出 WAV 并回读
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btn-export'),
]);
const path = await download.path();
check('WAV 文件已下载', !!path, download.suggestedFilename());

// 把下载的文件喂回文件输入
await page.on('filechooser', () => undefined);
await page.setInputFiles('#wav-file', path!);
await page.waitForFunction(() => !document.getElementById('readback')!.textContent!.includes('分析中'), null, {
  timeout: 8000,
});
const readback = await page.textContent('#readback');
check('回读判定 split 接线', readback!.includes('左右分送'), readback!.split('\n')[2] || '');
const beatLine = readback!.split('\n').find((l) => l.includes('期望拍频')) || '';
check('回读拍频与期望吻合（✓）', beatLine.includes('✓'), beatLine);

// 9. 两种循环模式
await page.click('#loop-seg button[data-loop="reset"]');
await page.click('#btn-loop');
await page.waitForTimeout(1200);
const segCanvasPlaying = await page.evaluate(() => {
  const cv = document.getElementById('cv-segment') as HTMLCanvasElement;
  const ctx = cv.getContext('2d')!;
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  // 白色播放头像素
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i + 1] > 230 && d[i + 2] > 230) n++;
  return n;
});
check('循环试听时段视图出现播放头', segCanvasPlaying > 5);
await page.click('#btn-rewind');
await page.waitForTimeout(400);
await page.click('#btn-loop-stop');
await page.click('#loop-seg button[data-loop="cont"]');
const seamCont = await page.textContent('#seam-data');
check('维持相位模式显示硬循环提示', seamCont!.includes('硬循环'), '');

// 10. 控制台无错误
check('浏览器控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await page.screenshot({ path: '/tmp/beats-app.png', fullPage: true });
await browser.close();

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
process.exit(failed ? 1 : 0);
