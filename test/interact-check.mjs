/**
 * 真实指针/键盘交互验证(CDP Input 事件), 通过 window.__vmp 读运行态断言。
 */
const BASE = 'http://127.0.0.1:52173';
const browser = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const ws = new WebSocket(browser.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const consoleErrors = [];
let currentSession = null;
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method && msg.sessionId === currentSession && msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? 'exception');
  }
});
const call = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params, sessionId }));
  });
const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
currentSession = sessionId;
const s = (m, p = {}) => call(m, p, sessionId);
await s('Runtime.enable');
await s('Page.enable');
await s('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 2200));

const ev = async (expression) => {
  const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
};
const mouse = (type, x, y) =>
  s('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1 });

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures += 1;
    console.error(`  ✖ ${name} ${detail}`);
  }
};

// 1. 真实拖动 A 枢轴(外层 CDP 事件): A 与 B 的屏幕位移都应等于指针位移(嵌套跟随端到端)
// 统一使用 canvas CSS 坐标, 发 CDP 事件时再加 rect.left/top
const rect0 = await ev(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { left: r.left, top: r.top }; })()`);
const css0 = await ev(`(() => {
  const v = window.__vmp;
  const h = v.renderer.handles(v.controller.renderState());
  const pick = (layer) => h.find(x => x.layer === layer && x.kind === 'pivot').screen;
  return { A: pick('A'), B: pick('B') };
})()`);
await mouse('mouseMoved', rect0.left + css0.A.x, rect0.top + css0.A.y);
await mouse('mousePressed', rect0.left + css0.A.x, rect0.top + css0.A.y);
for (let i = 1; i <= 10; i++) await mouse('mouseMoved', rect0.left + css0.A.x + i * 4, rect0.top + css0.A.y + i * 3);
await mouse('mouseReleased', rect0.left + css0.A.x + 40, rect0.top + css0.A.y + 30);
await new Promise((r) => setTimeout(r, 100));

const css1 = await ev(`(() => {
  const v = window.__vmp;
  const h = v.renderer.handles(v.controller.renderState());
  const pick = (layer) => h.find(x => x.layer === layer && x.kind === 'pivot').screen;
  return { A: pick('A'), B: pick('B') };
})()`);
const aMovedX = css1.A.x - css0.A.x;
const aMovedY = css1.A.y - css0.A.y;
const bMovedX = css1.B.x - css0.B.x;
const bMovedY = css1.B.y - css0.B.y;
check('A 枢轴屏幕位移等于指针位移(40,30)', Math.abs(aMovedX - 40) < 1.5 && Math.abs(aMovedY - 30) < 1.5, `实际(${aMovedX.toFixed(1)},${aMovedY.toFixed(1)})`);
check('子层 B 与父层 A 位移完全一致', Math.abs(bMovedX - aMovedX) < 0.5 && Math.abs(bMovedY - aMovedY) < 0.5, `A(${aMovedX.toFixed(1)},${aMovedY.toFixed(1)}) B(${bMovedX.toFixed(1)},${bMovedY.toFixed(1)})`);

// 2. 真实点击: 找一个最终可见点, 点击后命中面板应报告可见
const clickInfo = await ev(`(async () => {
  const v = window.__vmp;
  const hitMod = await import('/src/core/hitTest.ts');
  const mat = await import('/src/core/geometry/matrix.ts');
  const rect = document.getElementById('stage').getBoundingClientRect();
  // 网格搜索一个 visible 点
  for (let yy = 60; yy < rect.height - 60; yy += 10) {
    for (let xx = 60; xx < rect.width - 60; xx += 10) {
      const root = mat.apply(mat.invert(v.controller.view), { x: xx, y: yy });
      const hit = hitMod.hitTest(v.scene, root);
      if (hit.visible) return { cssX: xx, cssY: yy, label: hit.visibleShape.label };
    }
  }
  return null;
})()`);
check('找到可见点击点', clickInfo !== null);
if (clickInfo) {
  const rect = await ev(`document.getElementById('stage').getBoundingClientRect().toJSON()`);
  const cx = rect.left + clickInfo.cssX;
  const cy = rect.top + clickInfo.cssY;
  await mouse('mouseMoved', cx, cy);
  await mouse('mousePressed', cx, cy);
  await mouse('mouseReleased', cx, cy);
  await new Promise((r) => setTimeout(r, 150));
  const panel = await ev(`(() => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('点击核对'));
    return card ? card.textContent.replace(/\\s+/g, ' ') : null;
  })()`);
  check('命中面板出现且报告可见', !!panel && panel.includes('实际可见'), panel?.slice(0, 120));
  check('面板点名了可见图形', panel?.includes(clickInfo.label), `期望 ${clickInfo.label}`);
}

// 3. 点击遮罩孔区域: 应报告被裁掉
const holeInfo = await ev(`(async () => {
  const v = window.__vmp;
  const mat = await import('/src/core/geometry/matrix.ts');
  const rect = document.getElementById('stage').getBoundingClientRect();
  // A 的方孔中心
  const root = mat.apply(v.scene.masks.A.matrix, { x: -120, y: -60 });
  const screen = mat.apply(v.controller.view, root);
  return { cssX: screen.x, cssY: screen.y, inViewport: screen.x > 0 && screen.y > 0 && screen.x < rect.width && screen.y < rect.height };
})()`);
if (holeInfo.inViewport) {
  const rect = await ev(`document.getElementById('stage').getBoundingClientRect().toJSON()`);
  const cx = rect.left + holeInfo.cssX;
  const cy = rect.top + holeInfo.cssY;
  await mouse('mousePressed', cx, cy);
  await mouse('mouseReleased', cx, cy);
  await new Promise((r) => setTimeout(r, 150));
  const panel = await ev(`(() => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('点击核对'));
    return card ? card.textContent.replace(/\\s+/g, ' ') : null;
  })()`);
  check('孔内点击显示遮罩裁定', !!panel && (panel.includes('裁掉') || panel.includes('未命中')), panel?.slice(0, 120));
} else {
  check('孔内点击显示遮罩裁定(取景外, 跳过)', true);
}

// 4. 键盘: Alt+方向键旋转活动层, 验证矩阵角度变化
const angleBefore = await ev(`Math.atan2(window.__vmp.scene.masks.A.matrix.b, window.__vmp.scene.masks.A.matrix.a)`);
await ev(`window.__vmp.controller.setActive('A')`);
await s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, modifiers: 1 });
await s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, modifiers: 1 });
const angleAfter = await ev(`Math.atan2(window.__vmp.scene.masks.A.matrix.b, window.__vmp.scene.masks.A.matrix.a)`);
check('Alt+方向键旋转 A', Math.abs(angleAfter - angleBefore) > 0.01, `Δ=${(angleAfter - angleBefore).toFixed(4)}`);

check('交互过程无未捕获异常', consoleErrors.length === 0, consoleErrors.join(' | '));

// 5. 四种视图 + 陷阱样例截图
const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync('tmp', { recursive: true });
for (const mode of ['outline', 'maskA', 'maskB', 'final']) {
  await ev(`[...document.querySelectorAll('.seg-btn')].find(b => b.dataset.mode === '${mode}').click()`);
  await new Promise((r) => setTimeout(r, 180));
  const shot = await s('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`tmp/view-${mode}.png`, Buffer.from(shot.data, 'base64'));
}
await ev(`[...document.querySelectorAll('.tool-btn')].find(b => b.textContent.includes('陷阱')).click()`);
await new Promise((r) => setTimeout(r, 180));
const trapShot = await s('Page.captureScreenshot', { format: 'png' });
writeFileSync('tmp/view-trap.png', Buffer.from(trapShot.data, 'base64'));

ws.close();
if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n交互验证全部通过, 截图已写入 tmp/view-*.png');
