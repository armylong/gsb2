// 截一张标记模式 + 推断链的图，用于人工核对视觉表现
const { spawn } = await import('node:child_process');
import { writeFileSync } from 'node:fs';

const CHROME =
  process.env.HOME +
  '/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const PORT = 9224;
const chrome = spawn(CHROME, [
  '--headless', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, 'about:blank',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://localhost:5180/' });
await sleep(1200);

await send('Runtime.evaluate', {
  expression: `
    (async () => {
      const g = window.__snow.game;
      const route = g.scenario.routes.find(r => r.id === 1);
      for (const [x,y] of route.cells) {
        if (!g.isObserved(x,y))
          g.observations.set(g.key(x,y), {x,y,atTime:g.now,stepped:true,impressions:g.peek(x,y)});
      }
      // 圈出连续 6 格，并在中间插一次跳格演示虚线
      let n = 0, lastStep = null;
      for (let step=0; step<route.cells.length && n<6; step++) {
        const [x,y] = route.cells[step];
        const pick = g.getObservation(x,y).impressions.findIndex(v=>v.routeId===1);
        if (pick < 0) continue;
        if (n === 3) g.addGap();
        g.addObsEntry(x, y, pick);
        lastStep = step;
        n++;
      }
      document.getElementById('mode-mark').click();
      document.getElementById('btn-verify').click();
    })()
  `,
  awaitPromise: true,
});
await sleep(400);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/snow-mark.png', Buffer.from(shot.data, 'base64'));
ws.close();
chrome.kill();
console.log('done');
