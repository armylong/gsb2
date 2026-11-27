/**
 * 无头浏览器端到端冒烟：通过 CDP 驱动真实页面，
 * 验证点选、搬箱、回合累计、撤销、重置、切关、交替门提示与通关横幅隐藏。
 * 用法：先启动 vite（5200）与带 --remote-debugging-port=9222 的 Chrome。
 */
const BASE = 'http://localhost:5200';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => (ws.onopen = res));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.error ? { error: msg.error } : msg.result);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ready, send, close: () => ws.close() };
}

async function main() {
  // 直接新建一个 page target，拿到它专属的调试 WebSocket
  const page = await fetch(`http://localhost:9222/json/new?${encodeURIComponent(BASE)}`, {
    method: 'PUT',
  }).then((r) => r.json());
  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await sleep(1300);

  const evalJs = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.error) throw new Error('CDP 错误: ' + JSON.stringify(r.error));
    if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails.text));
    return r.result?.value;
  };
  const assert = (cond, name) => {
    if (!cond) throw new Error('断言失败：' + name);
    console.log('  ✓ ' + name);
  };
  const clickButton = async (id) => {
    await evalJs(`document.getElementById(${JSON.stringify(id)}).click()`);
    await sleep(140);
  };

  assert((await evalJs(`document.getElementById('hud-turn').textContent`)) === '0', '初始回合 0');
  assert((await evalJs(`document.getElementById('hud-budget').textContent`)) === '11', '第 1 关预算 11');
  assert((await evalJs(`document.getElementById('win-banner').hidden`)) === true, '通关横幅初始隐藏');

  // 画布点选 P：先读 Canvas 的包围盒，把内部坐标换算成 CSS 像素
  const box = await evalJs(`
    (() => { const c=document.getElementById('stage'); const r=c.getBoundingClientRect();
      return { left:r.left, top:r.top, sx:r.width/c.width, sy:r.height/c.height }; })()
  `);
  const clickCanvas = async (ix, iy) => {
    const x = box.left + ix * box.sx;
    const y = box.top + iy * box.sy;
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(140);
  };
  // P 在 1F 右站台靠门，内部坐标约 (660, 495)
  await clickCanvas(660, 495);
  assert((await evalJs(`document.getElementById('selection-info').textContent`)).includes('P'), '点选 P 成功');

  const destText = await evalJs(`
    (() => { const b=[...document.querySelectorAll('#dest-hints .btn')].find(x=>!x.disabled); if(b){b.click();return b.textContent;} return null; })()
  `);
  assert(!!destText, '存在可用搬运目标：' + destText);
  await sleep(320);
  assert((await evalJs(`document.getElementById('hud-turn').textContent`)) === '1', '搬箱后回合变为 1');
  assert((await evalJs(`document.getElementById('review').textContent`)).includes('轿厢'), '回看记录了搬箱动作');

  await clickButton('btn-undo');
  assert((await evalJs(`document.getElementById('hud-turn').textContent`)) === '0', '撤销回到回合 0');
  await clickButton('btn-reset');
  assert((await evalJs(`document.getElementById('hud-turn').textContent`)) === '0', '重置后回合 0');

  await clickButton('btn-level2');
  assert((await evalJs(`document.getElementById('hud-budget').textContent`)) === '18', '切到第 2 关预算 18');
  assert((await evalJs(`document.getElementById('hud-alt').textContent`)).includes('交替门'), 'HUD 显示交替门与下一次开门');
  await clickButton('btn-wait');
  assert((await evalJs(`document.getElementById('hud-turn').textContent`)) === '1', '等待花费 1 回合');
  // 等待后交替门提示应翻转
  assert((await evalJs(`document.getElementById('hud-alt').textContent`)).includes('下一次'), '等待后仍显示下一次开门侧');

  await clickButton('btn-level1');
  // 非法动作：在 1 层直接尝试移动到 1 层（楼层按钮应禁用），验证不会崩溃
  const disabled = await evalJs(`[...document.querySelectorAll('.floor-btn')].some(b=>b.disabled)`);
  assert(disabled === true, '当前层楼层按钮禁用');

  console.log('\n端到端冒烟全部通过');
  c.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
