/* CDP 真实 DOM 事件测试：点击墙开关复选框、切换质量、改颜色，验证 UI→重算链路 */
const { spawn } = require('node:child_process');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9223;
const URL = 'http://localhost:8123/index.html';
const USER_DIR = '/tmp/chrome-cdp-dom-' + process.pid;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleepMs(200);
  }
  throw new Error('no endpoint');
}
function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
}

(async () => {
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DIR}`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
  const fails = [];
  const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`); if (!c) fails.push(n); };
  try {
    const bws = new WebSocket(await getWsUrl());
    await new Promise((r) => (bws.onopen = r));
    const bs = cdp(bws);
    const { targetId } = await bs('Target.createTarget', { url: 'about:blank' });
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.id === targetId) || list.find((t) => t.type === 'page');
    bws.close();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    const send = cdp(ws);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: URL });
    await sleepMs(2500);
    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

    // 1. 点击墙列表里第一个复选框（top-1），验证 enabled 翻转且热图重算
    const before = await ev(`window.diffuseLab.getWorld().walls[0].enabled`);
    await ev(`document.querySelectorAll('#wall-list input[type=checkbox]')[0].click(); true`);
    await sleepMs(300);
    const after = await ev(`window.diffuseLab.getWorld().walls[0].enabled`);
    check('点击复选框翻转墙 enabled', before === true && after === false, `${before}→${after}`);

    // 2. 切换到密集取样，验证引擎档位与网格变密
    await ev(`document.querySelector('#quality-group button[data-quality=dense]').click(); true`);
    await sleepMs(1500);
    const dense = await ev(`({cells: window.diffuseLab.getHeat().cells.length, q: window.diffuseLab.getHeat().quality})`);
    check('切到密集取样网格变密 (>8000)', dense.cells > 8000 && dense.q === 'dense', JSON.stringify(dense));

    // 3. 切回快预览
    await ev(`document.querySelector('#quality-group button[data-quality=quick]').click(); true`);
    await sleepMs(800);
    const quick = await ev(`window.diffuseLab.getHeat().cells.length`);
    check('切回快预览网格变疏', quick < 3000, `cells=${quick}`);

    // 4. 修改红墙颜色输入，验证世界状态颜色更新
    await ev(`(() => {
      const inputs = document.querySelectorAll('#wall-list input[type=color]');
      const redPicker = inputs[8]; // 第 9 个是 wall-red
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(redPicker, '#2ecc71');
      redPicker.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleepMs(300);
    const colorChanged = await ev(`(() => {
      const c = window.diffuseLab.getWorld().walls.find(w=>w.id==='wall-red').color;
      return { g: c.g, r: c.r };
    })()`);
    check('改墙颜色更新反照率（绿通道变大）', colorChanged.g > colorChanged.r, JSON.stringify(colorChanged));

    // 5. 右视图模式切换
    await ev(`(() => { const s=document.getElementById('right-mode'); s.value='reflected'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleepMs(300);
    const title = await ev(`document.getElementById('right-title').textContent`);
    check('右视图切到仅反射模式', title.includes('仅一次'), title);

    ws.close();
  } catch (e) {
    fails.push(e.message);
    console.error(e);
  } finally {
    chrome.kill();
  }
  console.log(`\n${fails.length ? 'FAILED: ' + fails.join('; ') : 'ALL DOM EVENT TESTS PASSED'}`);
  process.exit(fails.length ? 1 : 0);
})();
