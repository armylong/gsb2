/**
 * 无头浏览器验证(CDP, 无第三方依赖)。
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
  } else if (msg.method && msg.sessionId === currentSession) {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? 'exception');
    }
  }
});
const call = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params, sessionId }));
  });

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures += 1;
    console.error(`  ✖ ${name} ${detail}`);
  }
};

const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
currentSession = sessionId;
const s = (method, params = {}) => call(method, params, sessionId);

await s('Runtime.enable');
await s('Page.enable');
await s('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 2500));

const evalInPage = async (expression) => {
  const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
};

// 1. 页面健康
const badge = await evalInPage(`document.getElementById('selftest-badge').textContent`);
check('自检徽标全绿', badge.includes('全部通过'), badge);
check('控制台无错误', consoleErrors.length === 0, consoleErrors.join(' | '));

// 2. 像素级填充规则(陷阱样例): 直接渲染路径本身, 不依赖取景位置
const centerPixel = await evalInPage(`(async () => {
  const paths = await import('/src/core/samples/paths.ts');
  const { toPath2D } = await import('/src/core/geometry/path.ts');
  const probe = (rule) => {
    const c = document.createElement('canvas');
    c.width = c.height = 240;
    const ctx = c.getContext('2d');
    ctx.translate(120, 120);
    ctx.fillStyle = '#000';
    ctx.fill(toPath2D(paths.holedSquarePath(true)), rule);
    // 局部原点(内孔中心) -> 画布 (120,120)
    return Array.from(ctx.getImageData(120, 120, 1, 1).data);
  };
  return { nonzero: probe('nonzero'), evenodd: probe('evenodd') };
})()`);
check('陷阱·nonzero 填平内孔(不透明)', centerPixel.nonzero[3] > 200, JSON.stringify(centerPixel.nonzero));
check('陷阱·evenodd 内孔镂空(透明)', centerPixel.evenodd[3] === 0, JSON.stringify(centerPixel.evenodd));

// 3. 命中测试 vs 导出像素逐点一致(忽略抗锯齿边缘: 只比对 alpha=0 与 alpha>=250 的确定像素)
const strict = await evalInPage(`(async () => {
  const exp = await import('/src/render/exporter.ts');
  const sceneMod = await import('/src/core/scene/scene.ts');
  const hitMod = await import('/src/core/hitTest.ts');
  const { sceneBounds } = await import('/src/render/renderer.ts');
  const mat = await import('/src/core/geometry/matrix.ts');
  const scene = sceneMod.defaultScene();
  const size = 520, margin = 40;
  const c = exp.buildExportCanvas(scene, { width: size, height: size, margin });
  const ctx = c.getContext('2d');
  const b = sceneBounds(scene);
  const sceneW = b.maxX - b.minX, sceneH = b.maxY - b.minY;
  const scale = Math.min((size - margin * 2) / sceneW, (size - margin * 2) / sceneH);
  // 与 exporter 完全相同的 view 构造, 再用其逆矩阵反算, 避免公式漂移
  const view = mat.multiply(
    mat.translation(size / 2 - ((b.minX + b.maxX) / 2) * scale, size / 2 - ((b.minY + b.maxY) / 2) * scale),
    { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 },
  );
  const invView = mat.invert(view);
  let bad = 0, checked = 0, visibleHit = 0, skipped = 0;
  for (let py = 8; py < size - 8; py += 6) {
    for (let px = 8; px < size - 8; px += 6) {
      const a = ctx.getImageData(px, py, 1, 1).data[3];
      if (a > 0 && a < 250) { skipped += 1; continue; } // 抗锯齿边缘, 跳过
      const root = mat.apply(invView, { x: px, y: py });
      const hit = hitMod.hitTest(scene, root);
      checked += 1;
      if (hit.visible) visibleHit += 1;
      if (hit.visible !== (a === 255)) bad += 1;
    }
  }
  return { checked, bad, visibleHit, skipped };
})()`);
check('命中测试与导出像素逐点一致(确定像素)', strict.bad === 0, `${strict.bad}/${strict.checked} 不一致`);
check('扫描中存在足量可见命中点', strict.visibleHit > 100, `visible=${strict.visibleHit}`);
check('抗锯齿边缘占比合理', strict.skipped < strict.checked, `skipped=${strict.skipped}`);

// 4. 父层移动, 子层跟随
const follow = await evalInPage(`(async () => {
  const sceneMod = await import('/src/core/scene/scene.ts');
  const mat = await import('/src/core/geometry/matrix.ts');
  const scene = sceneMod.defaultScene();
  const before = mat.apply(mat.multiply(scene.masks.A.matrix, scene.masks.B.matrix), { x: 0, y: 0 });
  scene.masks.A.matrix = mat.translatedBy(scene.masks.A.matrix, 37, -19);
  const after = mat.apply(mat.multiply(scene.masks.A.matrix, scene.masks.B.matrix), { x: 0, y: 0 });
  return { dx: after.x - before.x, dy: after.y - before.y };
})()`);
check('移动父层 A 时 B 跟随(+37,-19)', Math.abs(follow.dx - 37) < 1e-9 && Math.abs(follow.dy + 19) < 1e-9, JSON.stringify(follow));

// 5. 父层孔中不可见(与关系)
const andRule = await evalInPage(`(async () => {
  const sceneMod = await import('/src/core/scene/scene.ts');
  const hitMod = await import('/src/core/hitTest.ts');
  const mat = await import('/src/core/geometry/matrix.ts');
  const scene = sceneMod.defaultScene();
  // A 的方孔中心在 A 局部 (-120,-60), 转到根坐标
  const rootPt = mat.apply(scene.masks.A.matrix, { x: -120, y: -60 });
  const hit = hitMod.hitTest(scene, rootPt);
  return { aPasses: hit.masks.A.passes, visible: hit.visible };
})()`);
check('父层孔中 A 不放行且整体不可见', andRule.aPasses === false && andRule.visible === false, JSON.stringify(andRule));

// 6. 导出 PNG
const png = await evalInPage(`(async () => {
  const exp = await import('/src/render/exporter.ts');
  const sceneMod = await import('/src/core/scene/scene.ts');
  const c = exp.buildExportCanvas(sceneMod.defaultScene(), { width: 800, height: 600 });
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] === 0) transparent += 1;
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const sig = new Uint8Array(await blob.arrayBuffer()).slice(0, 4);
  return { width: c.width, height: c.height, transparent, blobSize: blob.size, sig: Array.from(sig) };
})()`);
check('导出尺寸 800x600', png.width === 800 && png.height === 600);
check('PNG 魔数正确', png.sig.join(',') === '137,80,78,71', JSON.stringify(png.sig));
check('导出含透明像素', png.transparent > 0, `transparent=${png.transparent}`);
check('PNG 非空', png.blobSize > 1000, `size=${png.blobSize}`);

// 7. 四种视图切换
const modes = await evalInPage(`(async () => {
  const out = [];
  for (const b of document.querySelectorAll('.seg-btn')) {
    b.click();
    await new Promise(r => setTimeout(r, 80));
    out.push(b.dataset.mode);
  }
  return out;
})()`);
check('四种视图可切换', modes.length === 4 && modes.includes('final'), JSON.stringify(modes));
check('全程控制台无错误', consoleErrors.length === 0, consoleErrors.join(' | '));

// 8. 截图存证(切回最终视图)
await evalInPage(`[...document.querySelectorAll('.seg-btn')].find(b => b.dataset.mode === 'final').click()`);
await new Promise((r) => setTimeout(r, 300));
const shot = await s('Page.captureScreenshot', { format: 'png' });
const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync('tmp', { recursive: true });
writeFileSync('tmp/final-view.png', Buffer.from(shot.data, 'base64'));

ws.close();
if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n浏览器验证全部通过, 截图: tmp/final-view.png');
