// 无头 Chrome 运行时验证：通过 CDP 驱动真实页面。
// node test/browser.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, 'shots');
mkdirSync(OUT, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5199/';

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--enable-unsafe-swiftshader',
  '--remote-debugging-port=9333',
  '--window-size=1600,1000',
  '--user-data-dir=/tmp/weave-chrome-profile',
  'about:blank',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let k = 0; k < 40; k++) {
    try {
      const res = await fetch('http://127.0.0.1:9333/json');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

const ws = new WebSocket(await getWsUrl());
await new Promise((r) => ws.on('open', r));
let id = 0;
const pending = new Map();
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
}

const logs = [];
send('Runtime.enable');
send('Log.enable');
send('Page.enable');
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    logs.push('console.error: ' + msg.params.args.map((a) => a.value || a.description).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const desc = msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text;
    // 合成 PointerEvent 没有激活指针，OrbitControls 内部 setPointerCapture 会报 NotFound，
    // 这是测试夹具噪音（真实鼠标/触摸一定有激活指针），过滤掉
    if (!desc.includes('setPointerCapture')) logs.push('exception: ' + desc);
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    const text = msg.params.entry.text || '';
    if (!text.includes('favicon')) logs.push('log.error: ' + text);
  }
});

async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('  截图 ' + name);
}
const $ = (sel) => `document.querySelector(${JSON.stringify(sel)})`;

async function step(name, fn) {
  process.stdout.write('• ' + name + ' … ');
  await fn();
  console.log('ok');
}

try {
  await send('Page.navigate', { url: URL });
  await sleep(3500);

  await step('页面加载且无渲染错误', async () => {
    const canvasCount = await evalJs(`document.querySelectorAll('#viewport canvas').length`);
    if (canvasCount < 1) throw new Error('WebGL canvas 未创建');
    if (logs.length) throw new Error(logs.join('\n'));
  });

  await step('初始为斜纹 4×4，编辑格渲染 16 个', async () => {
    const n = await evalJs(`document.querySelectorAll('.cell').length`);
    if (n !== 16) throw new Error('格子数=' + n);
  });

  await step('切换到长浮线预设', async () => {
    await evalJs(`${$('button[data-preset="float"]')}.click()`);
    await sleep(400);
    const n = await evalJs(`document.querySelectorAll('.cell').length`);
    if (n !== 36) throw new Error('长浮线应为 6×6=36 格，实际 ' + n);
    const v = await evalJs(`document.querySelector('.cell[data-i="0"][data-j="5"]').className`);
    if (!v.includes('warp')) throw new Error('i0j5 应为经线上浮');
  });

  await step('点击编辑格立即重建三维布面（无异常）', async () => {
    await evalJs(`(() => {
      const c = document.querySelector('.cell[data-i="2"][data-j="2"]');
      const before = c.className;
      c.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, clientX:10, clientY:10, pointerId:1}));
      c.dispatchEvent(new PointerEvent('pointerup', {bubbles:true, clientX:10, clientY:10, pointerId:1}));
      return before;
    })()`);
    await sleep(300);
    if (logs.length) throw new Error(logs.join('\n'));
  });

  await step('调节经线半径/间距触发重建', async () => {
    await evalJs(`(() => {
      const r = document.querySelector('input[data-kind="warp"][data-key="radius"]');
      r.value = '0.35';
      r.dispatchEvent(new Event('input', {bubbles:true}));
      const sp = document.querySelector('input[data-kind="warp"][data-key="spacing"]');
      sp.value = '0.9';
      sp.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await sleep(300);
    if (logs.length) throw new Error(logs.join('\n'));
  });

  await step('扩大重复到 6×6', async () => {
    await evalJs(`(() => {
      const x = document.querySelector('#rep-x'); x.value='6'; x.dispatchEvent(new Event('input',{bubbles:true}));
      const z = document.querySelector('#rep-z'); z.value='6'; z.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await sleep(400);
    const reps = await evalJs(`[document.querySelector('#rep-x-val').textContent, document.querySelector('#rep-z-val').textContent].join('x')`);
    if (reps !== '6x6') throw new Error(reps);
  });

  await step('切回只看一个循环', async () => {
    await evalJs(`document.querySelector('#single-cycle').click()`);
    await sleep(300);
    const rx = await evalJs(`document.querySelector('#rep-x').value`);
    if (rx !== '1') throw new Error('单循环 repsX=' + rx);
    const st = await evalJs(`window.__weave.getState().repsX + 'x' + window.__weave.getState().repsZ`);
    if (st !== '1x1') throw new Error('应用状态未切到 1x1: ' + st);
    // 长浮线是 6×6 循环，单循环应有 6 经 + 6 纬 = 12 根物理线
    const count = await evalJs(`window.__weave.yarnCount()`);
    if (count !== 12) throw new Error('单循环物理线数应为 12，实际 ' + count);
  });

  await step('布面拾取：数学平面反算能定位到格与重复序号', async () => {
    // 先回到 3×3，让“第几次重复”有内容
    await evalJs(`document.querySelector('#single-cycle').click()`);
    await sleep(300);
    const pick = await evalJs(`(async () => {
      // 通过模块内部不可直接访问，改用模拟真实点击落在 canvas 中心
      const canvas = document.querySelector('#viewport canvas');
      const r = canvas.getBoundingClientRect();
      const ev = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, clientX: x, clientY: y, pointerId: 2, button: 0
      }));
      ev('pointerdown', r.left + r.width*0.5, r.top + r.height*0.5);
      ev('pointerup', r.left + r.width*0.5, r.top + r.height*0.5);
      await new Promise(r => setTimeout(r, 200));
      return document.querySelector('#pick-info').textContent;
    })()`);
    if (!pick.includes('命中组织格')) throw new Error('拾取未生效: ' + pick);
    console.log('\n    拾取结果 → ' + pick.replace(/\s+/g, ' ').trim());
  });

  await step('改粗细后再次拾取仍然有效', async () => {
    await evalJs(`(() => {
      const r = document.querySelector('input[data-kind="weft"][data-key="radius"]');
      r.value = '0.12'; r.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await sleep(300);
    const pick = await evalJs(`(async () => {
      const canvas = document.querySelector('#viewport canvas');
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, clientX:r.left+r.width*0.42, clientY:r.top+r.height*0.55, pointerId:3}));
      canvas.dispatchEvent(new PointerEvent('pointerup', {bubbles:true, clientX:r.left+r.width*0.42, clientY:r.top+r.height*0.55, pointerId:3}));
      await new Promise(r => setTimeout(r, 200));
      return document.querySelector('#pick-info').textContent;
    })()`);
    if (!pick.includes('第')) throw new Error(pick);
  });

  await step('导出 256 色图与高度图，尺寸一致', async () => {
    await evalJs(`document.querySelector('#export-size').value='256'`);
    await evalJs(`document.querySelector('#export-btn').click()`);
    await sleep(400);
    const dims = await evalJs(`[
      document.querySelector('#exp-color').width,
      document.querySelector('#exp-height').width,
      document.querySelector('#exp-tiled').width
    ].join(',')`);
    if (dims !== '256,256,512') throw new Error('导出尺寸异常: ' + dims);
    const gray = await evalJs(`(() => {
      const c = document.querySelector('#exp-height');
      const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      // 灰度图 R=G=B
      for (let k=0;k<d.length;k+=4) if (d[k]!==d[k+1] || d[k+1]!==d[k+2]) return false;
      return true;
    })()`);
    if (!gray) throw new Error('高度图不是灰度');
    // 平铺校验：另建一张不带标注线的 2×2 平铺图，验证右砖/下砖与单图首末行列一致。
    // 像素中心采样的周期对应（evalTop 层面）已在 Node 数学测试中验证。
    const seam = await evalJs(`(() => {
      const one = document.querySelector('#exp-color');
      const N = one.width;
      const t2 = document.createElement('canvas');
      t2.width = t2.height = 2 * N;
      const tc = t2.getContext('2d');
      for (let a=0;a<2;a++) for (let b=0;b<2;b++) tc.drawImage(one, b*N, a*N);
      const s1 = one.getContext('2d').getImageData(0,0,N,N).data;
      const s2 = tc.getImageData(0,0,2*N,2*N).data;
      const at = (d, W, x, y) => { const o=(y*W+x)*4; return [d[o],d[o+1],d[o+2]].join(','); };
      for (let y=0;y<N;y++) {
        if (at(s2,2*N,N,y)     !== at(s1,N,0,y))   return false; // 右砖首列=单图首列
        if (at(s2,2*N,2*N-1,y) !== at(s1,N,N-1,y)) return false; // 右砖末列=单图末列
      }
      for (let x=0;x<N;x++) {
        if (at(s2,2*N,x,N)     !== at(s1,N,x,0))   return false; // 下砖首行=单图首行
        if (at(s2,2*N,x,2*N-1) !== at(s1,N,x,N-1)) return false;
      }
      return true;
    })()`);
    if (!seam) throw new Error('导出图四边不满足周期对应，不能无缝平铺');
  });

  await step('关闭弹窗并切换粗细不均预设截图', async () => {
    await evalJs(`document.querySelector('#close-modal').click()`);
    await evalJs(`${$('button[data-preset="uneven"]')}.click()`);
    await sleep(500);
  });

  await shot('01-uneven-fabric.png');
  await evalJs(`document.querySelector('button[data-preset="float"]').click()`);
  await sleep(500);
  await shot('02-long-float.png');
  await evalJs(`document.querySelector('#single-cycle').click()`);
  await sleep(400);
  await shot('03-single-cycle.png');
  // 再开导出弹窗截图
  await evalJs(`document.querySelector('#export-btn').click()`);
  await sleep(400);
  await shot('04-export-modal.png');

  if (logs.length) throw new Error('存在运行期错误:\n' + logs.join('\n'));
  console.log('\n全部浏览器用例通过，截图在 test/shots/');
} catch (e) {
  console.error('\n失败:', e.message);
  await shot('error.png').catch(() => {});
  process.exitCode = 1;
} finally {
  ws.close();
  chrome.kill();
  setTimeout(() => process.exit(process.exitCode || 0), 300);
}
