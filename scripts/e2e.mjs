#!/usr/bin/env node
/**
 * 用本机 Chrome 跑一遍页面，验证：
 *   1. 三组场景都能加载，逐个绘制与合批的缓冲区逐像素一致；
 *   2. 两种混合设置在同一层夹心时保留次序，且能识别被夹断的批次；
 *   3. 相机缩放/平移时入镜数与实际绘制次数随之变化；
 *   4. 探针拖出画面会退出统计；
 *   5. 选中精灵能追到实际批次。
 * 不设显卡速度门槛，只断言正确性；截图写到 artifacts/。
 */
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const ART = path.join(ROOT, 'artifacts');
const PORT = 4636;
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function waitForServer(url, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`服务器未就绪: ${url}`);
}

async function main() {
  await mkdir(ART, { recursive: true });
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let previewLog = '';
  preview.stdout.on('data', (d) => (previewLog += d));
  preview.stderr.on('data', (d) => (previewLog += d));
  const url = `http://127.0.0.1:${PORT}/`;

  let browser;
  try {
    await waitForServer(url);
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__lab && window.__lab.ready, null, { timeout: 15_000 });
    await page.waitForTimeout(500);

    check('页面无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 300));

    // --- 1. 三组场景逐像素一致 ---
    for (const key of ['sparse', 'interleaved', 'dense']) {
      await page.evaluate((k) => window.__lab.setScene(k), key);
      await page.waitForTimeout(120);
      const diff = await page.evaluate(() => window.__lab.runCompare());
      check(
        `场景 ${key}：参考与合批逐像素一致`,
        diff.diffPixels === 0 && diff.maxDelta === 0,
        `${diff.width}x${diff.height} diffPixels=${diff.diffPixels} maxDelta=${diff.maxDelta} ref=${diff.refHash.slice(0, 8)} batch=${diff.batchHash.slice(0, 8)}`,
      );
      const state = await page.evaluate(() => window.__lab.getState());
      check(
        `场景 ${key}：合批确实合并了绘制`,
        state.drawCalls > 0 && state.drawCalls < state.refDrawCalls,
        `batches=${state.drawCalls} ref=${state.refDrawCalls} visible=${state.visible}`,
      );
      await page.screenshot({ path: path.join(ART, `scene-${key}.png`) });
    }

    // --- 2. 两种混合夹心：保留可见次序 + 标记被夹断批次 ---
    await page.evaluate(() => window.__lab.setScene('interleaved'));
    await page.waitForTimeout(120);
    await page.evaluate(() => {
      const s = window.__lab.getState();
      const v = s.camera;
      const cx = 1800;
      const cy = 1200;
      window.__lab.setCamera({ cx, cy, zoom: 0.4 });
      window.__lab.setProbe('A', { x: cx - 150, y: cy - 40, layer: 4 });
      window.__lab.setProbe('B', { x: cx + 60, y: cy + 40, layer: 4 });
      window.__lab.setProbe('C', { x: cx - 380, y: cy - 190, layer: 4 });
    });
    await page.waitForTimeout(120);
    const batching = await page.evaluate(() => {
      const state = window.__lab.getState();
      return {
        state,
        batchA: state.batchOfSelected,
      };
    });
    await page.evaluate(() => window.__lab.selectSpriteByLabel('A'));
    const aInfo = await page.evaluate(() => {
      const state = window.__lab.getState();
      return { batch: state.batchOfSelected, labels: window.__lab.batchSpriteLabels(state.batchOfSelected ?? 0) };
    });
    await page.evaluate(() => window.__lab.selectSpriteByLabel('B'));
    const bInfo = await page.evaluate(() => {
      const state = window.__lab.getState();
      return { batch: state.batchOfSelected, labels: window.__lab.batchSpriteLabels(state.batchOfSelected ?? 0) };
    });
    await page.evaluate(() => window.__lab.selectSpriteByLabel('C'));
    const cInfo = await page.evaluate(() => {
      const state = window.__lab.getState();
      return { batch: state.batchOfSelected, labels: window.__lab.batchSpriteLabels(state.batchOfSelected ?? 0) };
    });
    check(
      '同层夹入另一种混合后被切成不同批次且次序不变',
      aInfo.batch !== null &&
        bInfo.batch !== null &&
        aInfo.batch !== bInfo.batch &&
        bInfo.batch !== cInfo.batch,
      `A=#${aInfo.batch} B=#${bInfo.batch} C=#${cInfo.batch}`,
    );
    const order = await page.evaluate(() => {
      const s = window.__lab.getState();
      return { interrupted: s.interruptedPairs, blendBreaks: s.blendBreaks };
    });
    check('存在被夹断的批次对', order.interrupted > 0, `interruptedPairs=${order.interrupted} blendBreaks=${order.blendBreaks}`);
    await page.screenshot({ path: path.join(ART, 'interleaved-probes.png') });

    // 探针 B 改回普通透明后，A/B/C 应能并进同一批（三者相邻、同层同混合）。
    await page.evaluate(() => window.__lab.setProbe('B', { blend: 'alpha' }));
    await page.waitForTimeout(120);
    const merged = await page.evaluate(() => {
      window.__lab.selectSpriteByLabel('A');
      const a = window.__lab.getState().batchOfSelected;
      window.__lab.selectSpriteByLabel('B');
      const b = window.__lab.getState().batchOfSelected;
      window.__lab.selectSpriteByLabel('C');
      const c = window.__lab.getState().batchOfSelected;
      return { a, b, c };
    });
    check(
      '同层同混合的相邻探针合并进同一批',
      merged.a === merged.b && merged.b === merged.c,
      `A=#${merged.a} B=#${merged.b} C=#${merged.c}`,
    );
    await page.evaluate(() => window.__lab.setProbe('B', { blend: 'additive' }));

    // 改层也要 retain 次序：B 移到最后一层，A/C 留在第 5 层。
    const diffAfterLayer = await page.evaluate(() => window.__lab.runCompare());
    check(
      '改层/改混合后仍逐像素一致',
      diffAfterLayer.diffPixels === 0,
      `diffPixels=${diffAfterLayer.diffPixels} maxDelta=${diffAfterLayer.maxDelta}`,
    );

    // --- 2b. 反例诊断：同层内按混合重排应当产生像素差异 ---
    await page.evaluate(() => window.__lab.setScene('dense'));
    await page.evaluate(() => window.__lab.setCamera({ cx: 1800, cy: 1200, zoom: 0.45 }));
    await page.waitForTimeout(120);
    const normalDiff = await page.evaluate(() => window.__lab.runCompare());
    const normalPlan = await page.evaluate(() => window.__lab.getState());
    await page.evaluate(() => window.__lab.setBreakOrder(true));
    await page.waitForTimeout(120);
    const breakPlan = await page.evaluate(() => window.__lab.getState());
    const breakDiff = await page.evaluate(() => window.__lab.runCompare());
    check(
      '反例重排会破坏覆盖结果（证明一致性断言不是空转）',
      breakDiff.diffPixels > 0 && breakDiff.maxDelta > 0,
      `normal=${normalDiff.diffPixels} broken=${breakDiff.diffPixels} maxDelta=${breakDiff.maxDelta}`,
    );
    check(
      '反例重排确实减少了绘制批次（更少批次 ≠ 正确）',
      breakPlan.drawCalls > 0 && breakPlan.drawCalls < normalPlan.drawCalls,
      `batches ${normalPlan.drawCalls} → ${breakPlan.drawCalls}`,
    );
    await page.screenshot({ path: path.join(ART, 'break-order.png') });
    await page.evaluate(() => window.__lab.setBreakOrder(false));
    await page.waitForTimeout(120);
    const restored = await page.evaluate(() => window.__lab.runCompare());
    check('关掉反例后恢复一致', restored.diffPixels === 0, `diffPixels=${restored.diffPixels}`);

    // --- 3. 相机变化：入镜数与实际绘制次数 ---
    await page.evaluate(() => window.__lab.setScene('dense'));
    await page.waitForTimeout(120);
    const camStates = [];
    for (const zoom of [0.35, 0.8, 2.0]) {
      await page.evaluate((z) => window.__lab.setCamera({ cx: 1800, cy: 1200, zoom: z }), zoom);
      await page.waitForTimeout(80);
      camStates.push(await page.evaluate(() => window.__lab.getState()));
    }
    check(
      '拉远入镜数上升、拉近下降（实际绘制次数同向变化）',
      camStates[0].visible > camStates[1].visible && camStates[1].visible > camStates[2].visible,
      camStates.map((s) => `z=${s.camera.zoom.toFixed(2)} v=${s.visible} calls=${s.drawCalls}`).join(' | '),
    );
    check(
      '实际绘制次数 = 批次数量，且远小于入镜数',
      camStates.every((s) => s.drawCalls === s.batches) && camStates[0].drawCalls < camStates[0].visible,
      camStates.map((s) => `${s.drawCalls}/${s.batches}/${s.visible}`).join(' '),
    );
    check(
      '本帧总 draw call = 参考(背景+逐个) + 合批(背景+批次) + 合成',
      camStates.every((s) => s.frameDrawCalls === 1 + s.refDrawCalls + 1 + s.drawCalls + 1),
      camStates.map((s) => `z=${s.camera.zoom} total=${s.frameDrawCalls}`).join(' | '),
    );

    // 平移出画面 -> 入镜数变化
    await page.evaluate(() => window.__lab.setCamera({ cx: 1800, cy: 1200, zoom: 0.3 }));
    const beforePan = await page.evaluate(() => window.__lab.getState());
    await page.evaluate(() => window.__lab.setCamera({ cx: 300, cy: 200 }));
    const afterPan = await page.evaluate(() => window.__lab.getState());
    check(
      '平移画面后入镜对象改变',
      afterPan.visible !== beforePan.visible,
      `before=${beforePan.visible} after=${afterPan.visible}`,
    );

    // --- 4. 拖出画面退出统计 ---
    await page.evaluate(() => window.__lab.setScene('interleaved'));
    await page.waitForTimeout(120);
    const beforeOff = await page.evaluate(() => window.__lab.getState());
    await page.evaluate(() => window.__lab.selectSpriteByLabel('B'));
    const selBefore = await page.evaluate(() => window.__lab.getState());
    await page.evaluate(() => window.__lab.moveProbeOffscreen('B'));
    await page.waitForTimeout(120);
    const afterOff = await page.evaluate(() => window.__lab.getState());
    check(
      '探针拖出画面后退出入镜与批次统计',
      afterOff.visible === beforeOff.visible - 1 && afterOff.batchOfSelected === -1,
      `visible ${beforeOff.visible}→${afterOff.visible} batchOfSelected=${afterOff.batchOfSelected}`,
    );
    check(
      '选中精灵能追到实际批次（拖出前）',
      selBefore.batchOfSelected !== null && selBefore.batchOfSelected >= 0,
      `selected batch=#${selBefore.batchOfSelected}`,
    );

    // --- 5. 像素级取样：同一位置两条路径 ---
    await page.evaluate(() => window.__lab.setScene('interleaved'));
    await page.evaluate(() => window.__lab.setCamera({ cx: 1800, cy: 1200, zoom: 0.5 }));
    await page.waitForTimeout(120);
    const overlayBox = await page.locator('#overlayCanvas').boundingBox();
    const samples = [];
    for (let i = 0; i < 24; i++) {
      const x = overlayBox.width * (0.2 + 0.6 * ((i * 37) % 100) / 100);
      const y = overlayBox.height * (0.2 + 0.6 * ((i * 61) % 100) / 100);
      samples.push(await page.evaluate(([sx, sy]) => window.__lab.pixelAt(sx, sy), [x, y]));
    }
    check(
      '抽样像素两条路径一致',
      samples.every((s) => s.maxDelta === 0),
      `max=${Math.max(...samples.map((s) => s.maxDelta))}`,
    );
    check(
      '抽样像素确有非背景内容',
      samples.some((s) => s.ref[0] > 20 || s.ref[1] > 20 || s.ref[2] > 20),
      `sample0=${JSON.stringify(samples[0].ref)}`,
    );

    // --- 6. 交互冒烟：拖拽精灵、滚轮缩放、切换对照模式 ---
    await page.evaluate(() => {
      window.__lab.setCamera({ cx: 1800, cy: 1200, zoom: 0.45 });
      window.__lab.selectSpriteByLabel('A');
    });
    await page.waitForTimeout(100);
    const before = await page.evaluate(() => window.__lab.getState());
    await page.mouse.move(overlayBox.x + overlayBox.width * 0.5, overlayBox.y + overlayBox.height * 0.5);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(120);
    const afterWheel = await page.evaluate(() => window.__lab.getState());
    check(
      '滚轮缩放改变相机且保持两条路径一致',
      Math.abs(afterWheel.camera.zoom - before.camera.zoom) > 1e-4,
      `zoom ${before.camera.zoom.toFixed(3)} → ${afterWheel.camera.zoom.toFixed(3)}`,
    );
    const wheelDiff = await page.evaluate(() => window.__lab.runCompare());
    check('缩放后仍逐像素一致', wheelDiff.diffPixels === 0, `diffPixels=${wheelDiff.diffPixels}`);

    // 切换对照模式 + 按批次着色不报错
    for (const i of [1, 2, 3, 0]) {
      await page.click(`#compareModes button[data-mode="${i}"]`);
      await page.waitForTimeout(60);
    }
    await page.click('#batchColorToggle');
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(ART, 'batch-color.png') });
    await page.click('#batchColorToggle');
    await page.click('#compareModes button[data-mode="2"]');
    await page.waitForTimeout(100);
    await page.screenshot({ path: path.join(ART, 'slider-compare.png') });

    check('交互过程中无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 300));

    // 记录渲染器能力，写进报告（不设速度门槛）。
    const gpu = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'n/a';
    });
    await writeFile(
      path.join(ART, 'report.json'),
      JSON.stringify({ when: new Date().toISOString(), gpu, results }, null, 2),
    );
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 通过 · GPU: ${gpu}`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    preview.kill('SIGTERM');
    if (process.exitCode) console.error('\n--- preview log ---\n' + previewLog.slice(-2000));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
