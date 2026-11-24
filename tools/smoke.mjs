// CDP 交互冒烟：加载页面 → 键盘移动到有足迹的区域 → 扫雪 → 截图 + 读取侧栏状态
const { spawn } = await import('node:child_process');
import { writeFileSync } from 'node:fs';

const CHROME =
  process.env.HOME +
  '/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const PORT = 9222;

const chrome = spawn(CHROME, [
  '--headless',
  '--disable-gpu',
  '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  'about:blank',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
};
function send(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

const errors = [];
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push('EXCEPTION: ' + msg.params.exceptionDetails.text);
  }
});

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://localhost:5180/' });
await sleep(1500);

// 玩家起点 (0,11)；路线 R1 在 y=6。持续按 d 移动到 x=3，再 w 五次到 (3,6)，沿途应观察到脚印
async function key(keyChar, times) {
  for (let i = 0; i < times; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyChar });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyChar });
    await sleep(60);
  }
}
await key('d', 3);
await key('w', 5);
await key(' ', 1); // 扫雪
await sleep(300);

const state = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    clock: document.getElementById('clock').textContent,
    obsItems: document.querySelectorAll('#observation-list .obs-item').length,
    obsText: document.getElementById('observation-list').innerText.slice(0, 400),
    chainEmpty: document.getElementById('chain-list').className,
  })`,
  returnByValue: true,
});
console.log(state.result.value);
console.log('CONSOLE_ERRORS:', errors.length ? errors.join(' | ') : 'none');

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/snow-interact.png', Buffer.from(shot.data, 'base64'));

ws.close();
chrome.kill();
