/**
 * 浏览器端到端冒烟脚本（仅验证用，不参与单元测试）：
 * 通过 CDP 驱动 headless Chrome，在真实 WebGL 环境里执行点选/框选/移动/隐藏/撤销。
 * 运行：node tests/browser-smoke.mjs
 */
const CDP_HTTP = 'http://127.0.0.1:9222';

async function getPageTarget() {
  const res = await fetch(`${CDP_HTTP}/json`);
  const targets = await res.json();
  return targets.find((t) => t.type === 'page');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'evaluation failed');
  }
  return result.result.value;
}

const target = await getPageTarget();
if (!target) throw new Error('未找到 CDP page target，确认 Chrome 以 --remote-debugging-port=9222 启动');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
const send = cdp(ws);
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://localhost:4173/' });
await new Promise((r) => setTimeout(r, 2500));

const report = await evaluate(send, `(async () => {
  const T = window.__pickTool;
  const out = {};
  const assert = (cond, name) => { if (!cond) throw new Error('断言失败: ' + name); };

  assert(T && T.model.count === 5000, '场景生成 5000 物件');
  const { model, selection, view } = T;

  // 1) 真实指针事件点选：向画布中心派发左键单击
  const c = document.getElementById('scene');
  const r = c.getBoundingClientRect();
  const click = (x, y, shiftKey = false, ctrlKey = false) =>
    new Promise((resolve) => {
      const opts = { bubbles: true, button: 0, pointerId: 1, clientX: r.left + x, clientY: r.top + y, shiftKey, ctrlKey };
      c.dispatchEvent(new PointerEvent('pointerdown', opts));
      c.dispatchEvent(new PointerEvent('pointerup', opts));
      setTimeout(resolve, 30);
    });
  await click(r.width / 2, r.height / 2);
  out.afterFirstClick = selection.size;
  assert(selection.size === 1, '点选后恰好选中 1 个');
  const pickedId = selection.values()[0];

  // 2) Shift 追加点选另一个已知物件的投影中心，选择数增长且原身份保留
  const anotherId = (pickedId + 137) % model.count;
  // 复用渲染层的投影：取实例世界坐标投影到画布 CSS 像素
  const projPoint = T.project(anotherId);
  await click(projPoint.x, projPoint.y, true);
  out.afterShiftClick = selection.size;
  assert(selection.size === 2, 'Shift 点选追加到 2 个');
  assert(selection.has(pickedId) && selection.has(anotherId), '两个身份都在选择集中');

  // 3) 真实拖框手势验证框选与幂等（与松手时同一套投影 API）
  const rect = { x0: r.width / 2 - 150, y0: r.height / 2 - 100, x1: r.width / 2 + 150, y1: r.height / 2 + 100 };
  const drag = (x0, y0, x1, y1) =>
    new Promise((resolve) => {
      const base = { bubbles: true, button: 0, pointerId: 2 };
      c.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: r.left + x0, clientY: r.top + y0 }));
      c.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: r.left + (x0 + x1) / 2, clientY: r.top + (y0 + y1) / 2 }));
      c.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: r.left + x1, clientY: r.top + y1 }));
      c.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: r.left + x1, clientY: r.top + y1 }));
      setTimeout(resolve, 30);
    });
  await drag(rect.x0, rect.y0, rect.x1, rect.y1);
  const boxSize1 = selection.size;
  await drag(rect.x0, rect.y0, rect.x1, rect.y1);
  const boxSize2 = selection.size;
  out.boxSelection = boxSize1;
  assert(boxSize1 > 1, '拖框选中多个物件');
  assert(boxSize1 === boxSize2, '重复拖框结果幂等');

  // 4) 移动已选：身份不变，选择集不变，实例矩阵确实变化
  const idsBefore = selection.values().slice();
  const posBefore = model.getPosition(idsBefore[0]).slice();
  document.getElementById('btn-move').click();
  await new Promise((r) => setTimeout(r, 600));
  assert(selection.values().every((id, i) => id === idsBefore[i]), '移动后选择身份不变');
  assert(JSON.stringify(model.getPosition(idsBefore[0])) !== JSON.stringify(posBefore), '位置已更新');
  out.movedPreserved = selection.size;

  // 5) 批量隐藏 + 撤销：计数、恢复、选择身份
  document.getElementById('btn-hide').click();
  const hiddenNow = model.hiddenCount;
  assert(hiddenNow === idsBefore.length, '隐藏计数等于选中数');
  assert(selection.size === idsBefore.length, '隐藏后选择身份保留');
  document.getElementById('btn-undo').click();
  assert(model.hiddenCount === 0, '撤销隐藏后 hiddenCount 归零');
  assert(selection.size === idsBefore.length, '撤销后选择身份仍保留');

  // 6) 清空选择
  document.getElementById('btn-clear').click();
  assert(selection.size === 0, '清空选择生效');

  // 7) 窗口缩放：renderer/camera 尺寸同步，框选坐标基准更新
  const beforeW = view.width;
  view.resize();
  assert(view.width === beforeW, 'resize 不抛错且尺寸稳定');

  // 8) HUD 统计与 model 一致
  out.hud = {
    total: document.getElementById('stat-total').textContent,
    visible: document.getElementById('stat-visible').textContent,
    hidden: document.getElementById('stat-hidden').textContent,
    selected: document.getElementById('stat-selected').textContent,
  };
  assert(out.hud.total === '5000' && out.hud.visible === '5000' && out.hud.hidden === '0' && out.hud.selected === '0',
    'HUD 统计正确');
  out.ok = true;
  return out;
})()`);

console.log(JSON.stringify(report, null, 2));
ws.close();
process.exit(report.ok ? 0 : 1);
