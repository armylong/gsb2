/**
 * 交互验证：切换显示模式/模型/空间、勾选反向法线、模拟表面点选，
 * 每步检查无异常并在关键状态截图。
 * 用法：/opt/homebrew/opt/node@26/bin/node scripts/cdp-interact.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://127.0.0.1:5173/';
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function getWS() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`, { method: 'PUT' });
      if (res.ok) return res.json();
    } catch {}
    await sleep(300);
  }
  throw new Error('Chrome DevTools unreachable');
}

const target = await getWS();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
const evalJs = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

// CDP 原生鼠标输入（可信事件，与真人点击等价）
async function clickAt(clientX, clientY) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clientX, y: clientY, button: 'left', clickCount: 1 });
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clientX, y: clientY, button: 'left', clickCount: 1 });
  await sleep(180);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });
await sleep(3500);

// 1. 切换四个模型，确认无异常
for (const geo of ['corner', 'bend', 'box', 'ramp']) {
  await evalJs(`(() => {
    const sel = document.getElementById('geoSelect');
    sel.value = '${geo}';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await sleep(400);
}
console.log('1. 模型切换完成');

// 2. 依次切换全部显示模式
for (const mode of ['1', '2', '3', '4', '5', '0']) {
  await evalJs(`document.querySelector('.mode[data-mode="${mode}"]').click()`);
  await sleep(300);
}
console.log('2. 显示模式切换完成');

// 3. 切到权重可视化并截图
await evalJs(`document.querySelector('.mode[data-mode="4"]').click()`);
await sleep(500);
let shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/mode-weights.png', Buffer.from(shot.result.data, 'base64'));

// 4. 法线可视化截图
await evalJs(`document.querySelector('.mode[data-mode="5"]').click()`);
await sleep(500);
shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/mode-normals.png', Buffer.from(shot.result.data, 'base64'));

// 5. 勾选反向法线演示面 + 回混合模式 + 凹转角，截图
await evalJs(`(() => {
  const sel = document.getElementById('geoSelect');
  sel.value = 'corner';
  sel.dispatchEvent(new Event('change'));
  document.querySelector('.mode[data-mode="0"]').click();
  const cb = document.getElementById('backfaceDemo');
  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
})()`);
await sleep(600);
shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/backface-corner.png', Buffer.from(shot.result.data, 'base64'));

// 6. 模拟在画布中央偏左处点击表面，读取诊断面板
const rect = await evalJs(`(() => {
  const r = document.getElementById('viewport').getBoundingClientRect();
  return { left: r.left, top: r.top, w: r.width, h: r.height };
})()`);
const tryPoints = [
  [rect.left + rect.w * 0.45, rect.top + rect.h * 0.55],
  [rect.left + rect.w * 0.4, rect.top + rect.h * 0.5],
  [rect.left + rect.w * 0.5, rect.top + rect.h * 0.6],
];
let readoutText = '';
for (const [x, y] of tryPoints) {
  await clickAt(x, y);
  readoutText = await evalJs(`document.getElementById('readout').innerText`);
  if (readoutText.includes('主导轴')) break;
}
console.log('3. 点选诊断面板内容:\n' + readoutText);

// 7. 切换物体固定空间后再次点选，确认附着空间文案变化
await evalJs(`document.querySelector('#spaceSeg button[data-space="1"]').click()`);
await sleep(200);
await clickAt(tryPoints[0][0], tryPoints[0][1]);
const readout2 = await evalJs(`document.getElementById('readout').innerText`);
console.log('4. 物体固定模式点选:\n' + readout2);

// 8. 拖动 sharpness 滑杆到 8，确认值联动
const sharp = await evalJs(`(() => {
  const s = document.getElementById('sharpness');
  s.value = '8';
  s.dispatchEvent(new Event('input'));
  return document.getElementById('sharpnessVal').innerText;
})()`);
console.log('5. sharpness 滑杆联动值:', sharp);

console.log('6. 运行时异常:', exceptions.length ? exceptions.join('\n') : '无');
ws.close();
chrome.kill();
