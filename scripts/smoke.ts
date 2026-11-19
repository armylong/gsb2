/**
 * 浏览器交互冒烟测试（puppeteer-core 驱动系统 Chrome，swiftshader 软渲染）：
 *
 *   npx tsx scripts/smoke.ts
 *
 * 覆盖：初始零误差参照 -> 执行简化 -> 读数/达标/着色 -> 换样例与边界 ->
 * LockBorder -> 叠加/线框 -> 点击拾取与空背景 -> 换样例清理检查点 -> 趋势表。
 * 任何页面错误或断言失败都以非零码退出。
 */
import puppeteer from 'puppeteer-core';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE_URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5175/';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--enable-unsafe-swiftshader',
      '--use-gl=swiftshader',
      '--window-size=1600,1000',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });

  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${(e as Error).message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
  });

  const text = async (sel: string) => (await page.$eval(sel, (el) => el.textContent ?? '')).trim();
  const waitIdle = async () => {
    await page.waitForSelector('#busy-overlay.hidden', { timeout: 20000 });
  };

  console.log('1. 初始加载（球面零误差参照）');
  await page.goto(BASE_URL, { waitUntil: 'load', timeout: 30000 });
  await waitIdle();
  await sleep(500);
  const origStats = await text('#original-stats');
  check('显示原始顶点/面数', origStats.includes('4,992') && origStats.includes('2,665'), origStats.replace(/\s+/g, ' '));
  const boundary = await text('#boundary-stats');
  check('球面显示闭合无边界', boundary.includes('0 条回路'), boundary);
  const max0 = await text('#metric-max');
  const rms0 = await text('#metric-rms');
  check('参照 max ≈ 0', Number(max0) < 1e-9, max0);
  check('参照 RMS ≈ 0', Number(rms0) < 1e-9, rms0);

  console.log('2. 执行 50% 简化');
  await page.click('#simplify-button');
  await waitIdle();
  await sleep(300);
  const status = await text('#simplify-status');
  check('状态框报告实际面数', status.includes('实际面数'), status.replace(/\s+/g, ' ').slice(0, 120));
  check('状态框报告达标', status.includes('达到目标'), '');
  const max1 = Number(await text('#metric-max'));
  const rms1 = Number(await text('#metric-rms'));
  check('简化后 max > 0', max1 > 1e-6, String(max1));
  check('简化后 RMS > 0 且 max >= RMS', rms1 > 1e-6 && max1 >= rms1, `max=${max1} rms=${rms1}`);
  // 色阶上限应等于当前 max
  const colorbarMax = Number((await text('#colorbar-max')));
  check('色阶上限 = 当前 max（颜色范围默认取 max）',
    Math.abs(colorbarMax - max1) / max1 < 1e-3,
    `${colorbarMax} vs ${max1}`);

  console.log('3. 颜色范围不改变读数');
  const rangeBefore = { max: await text('#metric-max'), rms: await text('#metric-rms') };
  await page.$eval('#range-slider', (el) => {
    const input = el as HTMLInputElement;
    input.value = '30';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);
  const rangeAfter = { max: await text('#metric-max'), rms: await text('#metric-rms') };
  check('拖动颜色范围后 max/RMS 读数不变',
    rangeBefore.max === rangeAfter.max && rangeBefore.rms === rangeAfter.rms,
    `${rangeBefore.max} -> ${rangeAfter.max}`);
  await page.$eval('#range-slider', (el) => {
    const input = el as HTMLInputElement;
    input.value = '100';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  console.log('4. 切换到弯曲片，检查边界统计与检查点清理前提');
  await page.click('button.sample[data-sample="sheet"]');
  await waitIdle();
  await sleep(500);
  const sheetBoundary = await text('#boundary-stats');
  check('弯曲片显示 2 条边界环', sheetBoundary.includes('2 条回路') && sheetBoundary.includes('330'),
    sheetBoundary);
  const sheetRefMax = Number(await text('#metric-max'));
  check('换样例后回到零误差参照', sheetRefMax < 1e-9, String(sheetRefMax));

  console.log('5. 弯曲片 35% 简化（不锁定边界）');
  await page.$eval('#ratio-slider', (el) => {
    const input = el as HTMLInputElement;
    input.value = '35';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#simplify-button');
  await waitIdle();
  const unlockedMax = Number(await text('#metric-max'));
  check('未锁定简化 max > 0', unlockedMax > 1e-6, String(unlockedMax));

  console.log('6. 开启 LockBorder 重新简化');
  await page.click('#lock-border');
  await waitIdle();
  await sleep(300);
  const lockedStatus = await text('#simplify-status');
  check('状态框说明边界锁定容差', lockedStatus.includes('LockBorder') && lockedStatus.includes('偏移为 0'),
    lockedStatus.replace(/\s+/g, ' ').slice(0, 100));
  const lockedMax = Number(await text('#metric-max'));
  check('锁定版本仍可计算且 max > 0（内部误差被边界约束改变）', lockedMax > 0, String(lockedMax));

  console.log('7. 叠加模式与线框切换');
  await page.click('#mode-overlay');
  await sleep(300);
  const overlayActive = await page.$eval('#mode-overlay', (el) => el.classList.contains('active'));
  check('叠加按钮激活', overlayActive);
  const labelsHidden = await page.$eval('#viewport-label-left', (el) => el.classList.contains('hidden'));
  check('叠加模式下并排标签隐藏', labelsHidden);
  await page.click('#wireframe-toggle');
  await sleep(200);
  const wireOn = await page.$eval('#wireframe-toggle', (el) => (el as HTMLInputElement).checked);
  check('线框开关已打开', wireOn);
  await page.click('#wireframe-toggle');
  await page.click('#mode-split');

  console.log('8. 点击右视口表面生成检查点');
  const canvas = await page.$('#viewer-container canvas');
  const box = await canvas!.boundingBox();
  // 右视口中央大概率命中弯曲片
  await page.mouse.click(box!.x + box!.width * 0.75, box!.y + box!.height * 0.5);
  await sleep(400);
  const inspection = await text('#inspection-readout');
  check('检查点显示命中点/最近点/距离', inspection.includes('连线距离') && inspection.includes('原表面最近点'),
    inspection.replace(/\s+/g, ' ').slice(0, 140));
  const pickedDistance = Number((inspection.match(/连线距离：\s*([0-9.e+-]+)/) ?? [])[1]);
  check('检查点距离为有限非负数', Number.isFinite(pickedDistance) && pickedDistance >= 0, String(pickedDistance));

  console.log('9. 点击空背景不生成新检查点（旧标记保留）');
  const beforeBg = await text('#inspection-readout');
  // 右视口右上角标签附近通常是背景
  await page.mouse.click(box!.x + box!.width * 0.985, box!.y + box!.height * 0.06);
  await sleep(300);
  const afterBg = await text('#inspection-readout');
  check('空背景点击后检查点内容不变', beforeBg === afterBg);

  console.log('10. 切换样例后旧检查点被清理');
  await page.click('button.sample[data-sample="building"]');
  await waitIdle();
  await sleep(400);
  const cleared = await text('#inspection-readout');
  check('检查点已清理为占位文案', cleared.includes('尚无检查点'), cleared);
  const buildingStats = await text('#original-stats');
  check('建筑样例面数显示（2,816）', buildingStats.includes('2,816'), buildingStats.replace(/\s+/g, ' '));
  const buildingBoundary = await text('#boundary-stats');
  check('建筑闭合无边界', buildingBoundary.includes('0 条回路'), buildingBoundary);

  console.log('11. 趋势图与表格');
  await sleep(800); // 趋势在样例加载后后台逐档计算
  await page.waitForFunction(
    () => document.querySelectorAll('.trend-table tbody tr').length >= 6,
    { timeout: 20000 },
  );
  const trendRows = await page.$$eval('.trend-table tbody tr', (rows) =>
    rows.map((r) => (r.textContent ?? '').replace(/\s+/g, ' ').trim()),
  );
  check('趋势表含 6 行（参照 + 5 档）', trendRows.length === 6, `${trendRows.length} 行`);
  check('首行为不简化零误差参照', trendRows[0].includes('不简化'), trendRows[0]);
  const refRowMax = Number(trendRows[0].split(/\s+/).find((t) => t.includes('e')) ?? 'NaN');
  check('参照行 max 为 0 量级', Number.isFinite(refRowMax) && refRowMax < 1e-9, String(refRowMax));

  console.log('12. 25% 极端比例与无法达标场景的 UI 容错');
  await page.$eval('#ratio-slider', (el) => {
    const input = el as HTMLInputElement;
    input.value = '25';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#simplify-button');
  await waitIdle();
  const status25 = await text('#simplify-status');
  check('25% 简化仍如实报告面数与达标情况',
    status25.includes('实际面数') && (status25.includes('达到目标') || status25.includes('未能达到目标')),
    status25.replace(/\s+/g, ' ').slice(0, 120));

  console.log('13. 页面错误检查');
  check('无页面错误/控制台错误', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));

  await page.screenshot({ path: '/tmp/chrome-test/smoke-final.png' });
  await browser.close();

  console.log(`\n${'='.repeat(56)}`);
  console.log(`冒烟测试：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('冒烟脚本异常：', err);
  process.exit(1);
});
