/**
 * 端到端冒烟测试（Playwright + 系统缓存的 Chromium）。
 *
 * 覆盖：
 *  - worklet 脚本以 JS 资源加载（非 data URL / 非 404）；
 *  - 离线渲染非空且结尾完全释放；
 *  - 5 个内置示例（含零时长段、弱长音接强短音）切换无崩溃；
 *  - 回放/暂停/点击跳转、实时手动按键；
 *  - 包络拖拽改曲线；
 *  - WAV 导出下载 + 回读对照全部通过；
 *  - 全程无 console / page 错误。
 *
 * 运行：npm run e2e（需要先 npm run dev）
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.E2E_BASE ?? 'http://localhost:5199';

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(String(e)));

const workletResponses = [];
page.on('response', (r) => {
  if (r.url().includes('envelope-worklet')) workletResponses.push({ url: r.url(), status: r.status() });
});

const debug = () => page.evaluate(() => window.__envelopeDebug);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });

  // 1. 图表渲染
  await page.waitForSelector('svg.chart path.env-line');
  const envPath = await page.locator('svg.chart path.env-line').first().getAttribute('d');
  assert.ok(envPath && envPath.length > 50, '包络曲线路径应非空');

  // 2. 初始离线渲染合理
  let d = await debug();
  assert.ok(d.render.pcm.length > 1000, 'PCM 应有足够长度');
  assert.ok(d.render.amplitude.some((v) => v > 0.1), '振幅应存在明显非零段');
  assert.equal(d.render.amplitude.at(-1), 0, '渲染结尾振幅必须为 0（release 完整）');
  assert.equal(d.render.eventSamples.length, 2, '初始序列有两个事件');

  // 3. worklet 尚未加载（懒加载，首次发声才加载）——先触发一次实时按键
  const holdBtn = page.locator('button:has-text("按住发声")').first();
  const hb0 = await holdBtn.boundingBox();
  await page.mouse.move(hb0.x + hb0.width / 2, hb0.y + hb0.height / 2);
  await page.mouse.down();
  await sleep(250);
  await page.mouse.up();
  await sleep(150);
  assert.ok(workletResponses.length >= 1, '发声时应请求 worklet 脚本');
  for (const r of workletResponses) {
    assert.equal(r.status, 200, `worklet 加载应成功：${r.url}`);
    assert.ok(!r.url.startsWith('data:'), 'worklet 应是同源脚本而非 data URL');
  }
  d = await debug();
  assert.equal(d.ctxState, 'running', 'AudioContext 应处于 running');

  // 4. 五个内置示例
  const presetCount = await page.locator('.preset-list button').count();
  assert.equal(presetCount, 5, '应有 5 个内置示例');
  const eventCounts = [];
  for (let i = 0; i < presetCount; i++) {
    await page.locator('.preset-list button').nth(i).click();
    await sleep(120);
    d = await debug();
    assert.ok(d.render.pcm.length > 0, `示例 ${i} 渲染非空`);
    assert.equal(d.render.amplitude.at(-1), 0, `示例 ${i} 结尾完全释放`);
    eventCounts.push(d.render.eventSamples.length);
  }
  // 零时长示例有 4 个事件，弱长音接强短音也有 4 个
  assert.deepEqual(eventCounts, [2, 2, 4, 4, 4]);

  // 5. 回放 → 暂停 → 再回放（确定性：两次渲染字节一致由单测保证，这里验交互）
  await page.locator('button:has-text("回放序列")').first().click();
  await sleep(400);
  const headDuring = await page.getByTestId('playhead').textContent();
  assert.match(headDuring, /播放头 0\.[1-9]/, '播放头应已前进');
  await page.locator('button:has-text("暂停")').click();
  const headPaused = await page.getByTestId('playhead').textContent();
  const pausedAt = Number(headPaused.match(/播放头 ([\d.]+)/)[1]);
  assert.ok(pausedAt > 0, '暂停点应大于 0');

  // 暂停后再点回放：从暂停点继续，而不是回到 0
  await page.locator('button:has-text("回放序列")').first().click();
  await sleep(150);
  const headResume = await page.getByTestId('playhead').textContent();
  const resumedAt = Number(headResume.match(/播放头 ([\d.]+)/)[1]);
  assert.ok(resumedAt >= pausedAt - 0.05, `恢复点 ${resumedAt} 不应早于暂停点 ${pausedAt}`);
  await page.locator('button:has-text("暂停")').click();
  await sleep(50);

  // 点击曲线跳转
  const box = await page.locator('svg.chart').last().boundingBox();
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.5);
  await sleep(100);
  const headSeek = await page.getByTestId('playhead').textContent();
  assert.match(headSeek, /播放头/, '跳转后播放头文本仍存在');

  // 停止后归零
  await page.locator('button:has-text("停止")').click();
  await sleep(100);
  const headStop = await page.getByTestId('playhead').textContent();
  assert.match(headStop, /播放头 0\.000/, '停止后播放头归零');

  // 6. 包络拖拽：拖 S 手柄改保持电平
  const before = await debug();
  const handle = page.locator('svg.chart circle.handle').nth(2); // S
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y - 60, { steps: 6 });
  await page.mouse.up();
  await sleep(150);
  const after = await debug();
  assert.notDeepEqual(
    Array.from(after.render.amplitude),
    Array.from(before.render.amplitude),
    '拖拽 S 手柄后振幅曲线应变化',
  );

  // 7. 切到 live 模式，拖滑块并实时发声，验证无跳变错误（无 pageerror 即过）
  await page.locator('.segmented button:has-text("当前声音过渡")').click();
  await page.locator('input[type="range"]').nth(2).evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '0.9');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const holdBtn2 = page.locator('button:has-text("按住发声")').first();
  const hb2 = await holdBtn2.boundingBox();
  await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
  await page.mouse.down();
  await sleep(300);
  await page.mouse.up();
  await sleep(200);

  // 8. WAV 导出 + 回读对照
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('button:has-text("导出 WAV")').click(),
  ]);
  const path = await download.path();
  const bytes = await download.createReadStream().then(
    (s) =>
      new Promise((resolve, reject) => {
        const chunks = [];
        s.on('data', (c) => chunks.push(c));
        s.on('end', () => resolve(Buffer.concat(chunks)));
        s.on('error', reject);
      }),
  );
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF', 'WAV 头应为 RIFF');
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WAVE', 'WAV 头应为 WAVE');
  assert.ok(bytes.length > 44, 'WAV 应有数据体');
  assert.ok(path, '下载应落盘');

  await page.locator('button:has-text("直接校验刚导出的文件")').click();
  await page.waitForSelector('.verify-item');
  await sleep(200);
  const badCount = await page.locator('.verify-item.bad').count();
  const okCount = await page.locator('.verify-item.ok').count();
  assert.equal(badCount, 0, '回读对照不应有失败项');
  assert.ok(okCount >= 6, `对照项应齐全，实际 ${okCount}`);

  // 9. 零时长示例的特殊验证：切换后渲染不卡死、事件数正确
  await page.locator('.preset-list button:has-text("零时长")').click();
  await sleep(150);
  d = await debug();
  assert.ok(d.render.duration > 0, '零时长示例仍有正常时长');
  assert.equal(d.render.amplitude.at(-1), 0);

  assert.equal(pageErrors.length, 0, `页面异常：${pageErrors.join(' | ')}`);
  assert.equal(consoleErrors.length, 0, `console 错误：${consoleErrors.join(' | ')}`);

  console.log('✓ E2E 全部通过');
  console.log(`  - worklet 同源加载：${workletResponses[0].url.split('/').pop()}`);
  console.log(`  - 示例事件数：${eventCounts.join(', ')}`);
  console.log(`  - WAV 大小：${bytes.length} 字节，对照 ${okCount} 项全过`);
} finally {
  await browser.close();
}
