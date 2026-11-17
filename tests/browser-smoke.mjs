// browser-smoke.mjs
// 基于 Chrome DevTools Protocol 的真实页面冒烟测试（无需第三方依赖，
// 使用 Node 22 内置 WebSocket）。验证 UI 接线：播放/暂停/单步/跳转/
// 回到开始/参数变更/比较模式/窗口自适应，并捕获页面异常。
// 运行：先启动静态服务器，再 node tests/browser-smoke.mjs <url>

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL = process.argv[2] || 'http://localhost:8391/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9311;

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--user-data-dir=/tmp/particle-smoke-profile',
  `--remote-debugging-port=${PORT}`,
  'about:blank',
], { stdio: 'ignore' });

const errors = [];
let msgId = 0;
const pending = new Map();
let ws;

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

const checks = [];
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

try {
  // 等待 DevTools 端口就绪
  let listUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) { listUrl = page.webSocketDebuggerUrl; break; }
    } catch { /* 重试 */ }
    await sleep(100);
  }
  if (!listUrl) throw new Error('DevTools 端口未就绪');

  ws = new WebSocket(listUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(JSON.stringify(msg.params.exceptionDetails));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(JSON.stringify(msg.params.entry));
    }
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(800); // 等模块加载与首帧渲染

  // 1. 初始状态
  check('初始暂停且时间为 0',
    (await evalJs(`document.getElementById('stat-state').textContent`)).includes('暂停') &&
    (await evalJs(`document.getElementById('stat-time').textContent`)).startsWith('0.000'));
  check('两个画布已分配位图',
    await evalJs(`document.getElementById('canvas-a').width > 0 && document.getElementById('canvas-b').width > 0`));

  // 2. 播放后时间推进、粒子产生
  await evalJs(`document.getElementById('btn-play').click()`);
  await sleep(700);
  const playingTime = parseFloat((await evalJs(
    `document.getElementById('stat-time').textContent`)).match(/[\d.]+/)[0]);
  const countA = await evalJs(`parseInt(document.getElementById('stat-count-a').textContent)`);
  check('播放后时间推进', playingTime > 0.5, `time=${playingTime}`);
  check('播放后产生粒子', countA > 0, `countA=${countA}`);

  // 3. 暂停后时间冻结
  await evalJs(`document.getElementById('btn-play').click()`);
  const frozenTime = parseFloat((await evalJs(
    `document.getElementById('stat-time').textContent`)).match(/[\d.]+/)[0]);
  await sleep(300);
  const stillFrozen = parseFloat((await evalJs(
    `document.getElementById('stat-time').textContent`)).match(/[\d.]+/)[0]);
  check('暂停后时间冻结', frozenTime === stillFrozen, `${frozenTime} === ${stillFrozen}`);

  // 4. 单步前进 1/60 秒
  await evalJs(`document.getElementById('btn-step').click()`);
  const afterStep = parseFloat((await evalJs(
    `document.getElementById('stat-time').textContent`)).match(/[\d.]+/)[0]);
  check('单步前进约 1/60 秒', Math.abs((afterStep - frozenTime) - 1 / 60) < 0.002,
    `delta=${(afterStep - frozenTime).toFixed(4)}`);

  // 5. 跳到指定时间
  await evalJs(`
    const n = document.getElementById('seek-number');
    n.value = '1.5';
    n.dispatchEvent(new Event('change', { bubbles: true }));
  `);
  await sleep(100);
  const seekTime = parseFloat((await evalJs(
    `document.getElementById('stat-time').textContent`)).match(/[\d.]+/)[0]);
  check('跳转到 1.5 秒', Math.abs(seekTime - 1.5) < 0.002, `time=${seekTime}`);

  // 6. 回到开始
  await evalJs(`document.getElementById('btn-restart').click()`);
  const restartedTime = parseFloat((await evalJs(
    `document.getElementById('stat-time').textContent`)).match(/[\d.]+/)[0]);
  const restartedCount = await evalJs(`parseInt(document.getElementById('stat-count-a').textContent)`);
  check('回到开始：时间归零且粒子清空', restartedTime === 0 && restartedCount === 0,
    `time=${restartedTime}, count=${restartedCount}`);

  // 7. 参数修改生效并反映到摘要
  await evalJs(`
    const s = document.getElementById('A-emissionRate');
    s.value = '200';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  `);
  const summary = await evalJs(`document.getElementById('summary-a').textContent`);
  check('参数修改反映到当前参数显示', summary.includes('"emissionRate": 200'));

  // 8. 参数重置按钮
  await evalJs(`document.querySelector('#panel-a .btn-reset').click()`);
  const summaryAfterReset = await evalJs(`document.getElementById('summary-a').textContent`);
  check('参数重置恢复默认（60/s）', summaryAfterReset.includes('"emissionRate": 60'));

  // 9. 并排比较模式：两个画布都显示且时间一致
  await evalJs(`document.querySelector('input[name="mode"][value="split"]').click()`);
  await sleep(200);
  const bothVisible = await evalJs(`
    getComputedStyle(document.getElementById('slot-a')).display !== 'none' &&
    getComputedStyle(document.getElementById('slot-b')).display !== 'none'
  `);
  check('并排模式显示两个场景', bothVisible);
  await evalJs(`document.getElementById('btn-play').click()`);
  await sleep(400);
  await evalJs(`document.getElementById('btn-play').click()`);
  const timeText = await evalJs(`document.getElementById('stat-time').textContent`);
  check('比较模式时间显示正常', parseFloat(timeText) > 0, timeText);

  // 10. 窗口调整后画布仍正常（设备模拟改尺寸）
  await send('Emulation.setDeviceMetricsOverride', {
    width: 480, height: 360, deviceScaleFactor: 2, mobile: false,
  });
  await sleep(300);
  const resizedOk = await evalJs(`
    const c = document.getElementById('canvas-a');
    c.width > 0 && c.height > 0 && c.width <= 480 * 2 + 2
  `);
  check('窗口缩小后画布自适应（含 DPR）', resizedOk,
    await evalJs(`document.getElementById('canvas-a').width + 'x' + document.getElementById('canvas-a').height`));
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);

  // 11. 粒子数量上限：把 A 频率拉满播放，存活数不得超过 400
  await evalJs(`
    const r = document.getElementById('A-emissionRate');
    r.value = '240'; r.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('btn-restart').click();
    document.getElementById('btn-play').click();
  `);
  await sleep(2200); // 寿命默认 2.2s，足够达到上限
  const capText = await evalJs(`document.getElementById('stat-count-a').textContent`);
  const alive = parseInt(capText);
  const total = parseInt(capText.match(/累计 (\d+)/)[1]);
  check('粒子数不超上限且累计统计持续增长', alive <= 400 && total > 400,
    `alive=${alive}, total=${total}`);

  // 截图留档
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('/tmp/particle-smoke.png', Buffer.from(shot.data, 'base64'));

  check('页面无 JS 异常/错误日志', errors.length === 0, errors.join(' | '));
} catch (err) {
  console.error('冒烟脚本失败:', err);
  process.exitCode = 1;
} finally {
  chrome.kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
if (failed.length) process.exitCode = 1;
