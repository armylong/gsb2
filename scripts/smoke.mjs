// CDP 无头冒烟：驱动真实页面跑通关流程、栏杆截停、重来复原。
// 用法：node scripts/smoke.mjs <chrome-headless-shell 路径> <页面 URL>
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const bin = process.argv[2];
const url = process.argv[3];
const port = 9222 + Math.floor(Math.random() * 100);

const chrome = spawn(bin, [
  '--headless',
  '--disable-gpu',
  '--no-sandbox',
  `--remote-debugging-port=${port}`,
  '--window-size=900,620',
  'about:blank',
]);

const errors = [];
try {
  // 等调试端口就绪
  let version;
  for (let i = 0; i < 50; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!version) throw new Error('CDP 端口未就绪');

  // 新开标签页，拿到页面级 WebSocket（浏览器级端点不支持 Runtime/Page 域）
  const tab = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  ).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });

  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Runtime.addBinding', { name: 'smokeDone' });

  send('Runtime.consoleAPICalled', {}).catch(() => {});
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(msg.params.entry.text);
    }
  });

  const evalJs = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error('页面执行异常: ' + JSON.stringify(res.exceptionDetails));
    }
    return res.result.value;
  };

  const press = async (key) =>
    send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });

  await send('Page.navigate', { url });
  for (let i = 0; i < 50; i++) {
    const ready = await evalJs(
      `!!(document.getElementById('game') && document.getElementById('status').textContent)`,
    ).catch(() => false);
    if (ready) break;
    await sleep(100);
  }
  await sleep(300);

  // canvas 在页面中有头部/工具栏偏移，所有点击先取它的包围盒
  const rect = await evalJs(
    `(() => { const r = document.getElementById('game').getBoundingClientRect();
       return { left: r.left, top: r.top }; })()`,
  );
  const clickCanvas = async (tileX, tileY, button = 'left') => {
    const x = rect.left + (tileX + 0.5) * 56;
    const y = rect.top + (tileY + 0.5) * 56;
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button, clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button, clickCount: 1,
    });
  };

  const status = async () => evalJs(`document.getElementById('status').textContent`);
  const banner = async () => evalJs(`document.getElementById('banner').textContent`);

  // ---- 房间 1 通关：上 A -> 转 A -> 走到东端口 -> 转 B -> 一路向东 ----
  await press('d'); await sleep(180);
  await press('d'); await sleep(180);
  // 用鼠标点手柄 A（顺时针）：手柄 A 在格 (3,7)
  await clickCanvas(3, 7);
  await sleep(800);
  await press('d'); await sleep(180); // 板内到东端口 (4,4)
  // 手柄 B 在格 (7,7)
  await clickCanvas(7, 7);
  await sleep(800);
  for (let i = 0; i < 6; i++) { await press('d'); await sleep(160); }
  const s1 = await status();
  const b1 = await banner();
  console.log('房间1 结束状态:', s1);
  console.log('房间1 横幅:', b1);
  if (!s1.includes('(11,4)')) throw new Error('房间 1 未走到出口: ' + s1);

  // ---- 重来 + 切到房间 2：A 被栏杆截停，状态不变 ----
  await press('r'); await sleep(300);
  await press('2'); await sleep(400);
  const s2before = await status();
  // 玩家出生在 A 上 (3,4)；点手柄 A 顺时针，应被挡
  await clickCanvas(3, 7);
  await sleep(500);
  const s2after = await status();
  const b2 = await banner();
  console.log('房间2 转动前:', s2before);
  console.log('房间2 转动后:', s2after);
  console.log('房间2 横幅:', b2);
  if (s2before !== s2after) throw new Error('被挡后状态发生了变化');
  if (!/截停/.test(b2)) throw new Error('缺少截停提示: ' + b2);

  // ---- 再来一次 R，确认完全复原 ----
  await press('r'); await sleep(300);
  const s3 = await status();
  if (s3 !== s2before) throw new Error('重来未复原: ' + s3);

  if (errors.length) throw new Error('页面报错: ' + errors.join(' | '));
  console.log('\n冒烟全部通过，无页面错误');
  ws.close();
} finally {
  chrome.kill();
}
