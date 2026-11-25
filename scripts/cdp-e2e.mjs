// 通过 CDP 驱动 headless Chrome 跑 e2e/harness.html：
//   node scripts/cdp-e2e.mjs
// 打开页面、收集控制台异常，轮询 window.__testDone，最后打印 #result 文本并退出。
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 9333;
// E2E_PAGE=/index.html E2E_SHOT=/tmp/main.png node scripts/cdp-e2e.mjs 可给正式页面截图
const PAGE_PATH = process.env.E2E_PAGE ?? '/e2e/harness.html';
const SHOT_PATH = process.env.E2E_SHOT ?? '/tmp/e2e-shot.png';
const URL = `http://localhost:5217${PAGE_PATH}`;
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const proc = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/chrome-cdp-15448',
    '--window-size=1700,820',
    URL,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);
proc.stderr.on('data', () => {});

function wsSend(ws, id, method, params) {
  ws.send(JSON.stringify({ id, method, params: params ?? {} }));
}

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await delay(250);
  }
  throw new Error('连不上 Chrome CDP');
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const consoleLogs = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    consoleErrors.push(
      `${d.text}: ${d.exception?.description ?? d.exception?.value ?? ''}`
    );
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const line = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (msg.params.type === 'error') consoleErrors.push(line);
    else consoleLogs.push(line);
  }
});
function cdp(method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    wsSend(ws, id, method, params);
  });
}

await cdp('Runtime.enable');
await cdp('Page.enable');

async function evalJs(expression) {
  const r = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败');
  }
  return r.result.value;
}

// 轮询测试完成标志（harness 全流程约 10~15 秒）；截图模式下没有该标志，等 3 秒即继续
const screenshotOnly = process.env.E2E_SHOT_ONLY === '1';
let done = false;
if (screenshotOnly) {
  await delay(3000);
} else {
  for (let i = 0; i < 240; i++) {
    await delay(250);
    done = await evalJs('!!window.__testDone');
    if (done) break;
  }
}

const title = await evalJs('document.title');
const text = screenshotOnly
  ? '(截图模式)'
  : await evalJs('document.getElementById("result").textContent');
const passed = screenshotOnly ? true : await evalJs('!!window.__testPassed');

// 截图
const shot = await cdp('Page.captureScreenshot', { format: 'png' });
await writeFile(SHOT_PATH, Buffer.from(shot.data, 'base64'));

console.log(text);
if (consoleLogs.length) {
  console.log('\n=== 页面 console ===');
  console.log(consoleLogs.join('\n'));
}
if (consoleErrors.length) {
  console.log('\n=== 控制台异常 ===');
  console.log(consoleErrors.join('\n'));
}
console.log(`\ntitle=${title}`);

proc.kill();
ws.close();
process.exitCode = passed && done ? 0 : 1;
