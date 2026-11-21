/**
 * 轻量 CDP 诊断脚本（无第三方依赖）：
 * 启动 headless Chrome → 打开页面 → 在页面上下文执行 JS → 输出结果/截图。
 * 用法：node scripts/cdp-check.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://127.0.0.1:5173/';
const PORT = 9333;

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--window-size=1600,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWS() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`, { method: 'PUT' });
      if (res.ok) return res.json();
    } catch {}
    await sleep(300);
  }
  throw new Error('Chrome DevTools endpoint unreachable');
}

const target = await getWS();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
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

const logs = [];
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Runtime.exceptionThrown') {
    logs.push(JSON.stringify(msg.params));
  }
});

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });
await sleep(4000);

const diag = await send('Runtime.evaluate', {
  expression: `(() => {
    const canvas = document.getElementById('viewport');
    const panel = document.getElementById('panel');
    const pr = panel.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return JSON.stringify({
      canvasCss: [cr.width, cr.height],
      canvasAttr: [canvas.width, canvas.height],
      panel: [pr.width, pr.height, pr.left],
      webgl: !!gl,
      renderer: gl ? gl.getParameter(gl.RENDERER) : null,
      bodyScroll: [document.body.scrollWidth, document.body.scrollHeight],
    });
  })()`,
  returnByValue: true,
});
console.log('DIAG:', diag.result?.result?.value ?? diag.result);
console.log('CONSOLE:', logs.length ? logs.join('\n') : '(no console errors)');

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/triplanar-cdp.png', Buffer.from(shot.result.data, 'base64'));
console.log('screenshot -> /tmp/triplanar-cdp.png');

ws.close();
chrome.kill();
