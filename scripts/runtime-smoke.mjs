// 运行时冒烟(非单测):用 Chrome DevTools Protocol 驱动页面里的 __debugScene,
// 验证真实 WebGL/three.js 环境下:蒙皮变形、权重归一、笔刷锁定、绑定姿态复位、存档往返、预设差异。
// 用法: node scripts/runtime-smoke.mjs  (需先启动 dev server,默认 http://localhost:5173)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.SMOKE_URL ?? 'http://localhost:5173/';
const PORT = 9222;
const PROFILE = join(os.tmpdir(), 'skinning-smoke-profile');
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    `--user-data-dir=${PROFILE}`,
    '--headless=new',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    URL,
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const pages = await res.json();
      const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 等 Chrome 起来 */
    }
    await delay(250);
  }
  throw new Error('连不上 Chrome DevTools 端口');
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((resolve) => ws.addEventListener('open', () => resolve(), { once: true }));

let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});

function cdp(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value;
}

const endVertexExpr = `window.__debugScene.getVertexWorldPositionArray(window.__debugScene.vertexCount - 1)`;

const cleanup = () => {
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  try {
    rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* 临时目录,系统会回收 */
  }
};

try {
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await delay(2500);

  const checks = [];
  const assert = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    if (!ok) throw new Error(`${name} 失败 ${detail}`);
  };

  // 1. 三骨骼带状网格(48×2 分段 = 49×3 = 147 顶点)
  const meta = await evalJs(`(() => {
    const s = window.__debugScene;
    return { bones: s.boneCount, verts: s.vertexCount, poses: s.getPoses().length };
  })()`);
  assert('三骨骼带状网格生成', meta.bones === 3 && meta.verts === 147 && meta.poses === 3, JSON.stringify(meta));

  // 2. 初始权重逐顶点归一、范围合法
  const initialOk = await evalJs(`(() => {
    const s = window.__debugScene;
    for (let v = 0; v < s.vertexCount; v++) {
      const w = s.getVertexWeights(v);
      if (w.some((x) => x < 0 || x > 1)) return false;
      if (Math.abs(w.reduce((a, b) => a + b, 0) - 1) > 1e-6) return false;
    }
    return true;
  })()`);
  assert('初始权重逐顶点归一', initialOk);

  // 3. 旋转肘部骨骼 -> 末端蒙皮顶点真实位移
  const before = await evalJs(endVertexExpr);
  await evalJs(`window.__debugScene.setPose([{rotY:0,rotZ:0},{rotY:60,rotZ:0},{rotY:0,rotZ:0}])`);
  await delay(400);
  const after = await evalJs(endVertexExpr);
  const moved = Math.hypot(...after.map((x, i) => x - before[i]));
  assert('旋转骨骼驱动蒙皮变形', moved > 0.3, `末端位移=${moved.toFixed(3)}`);

  // 4. 回绑定姿态 -> 网格复位且权重不变(需求 4)
  const wAt73 = await evalJs(`JSON.stringify(window.__debugScene.getVertexWeights(73))`);
  await evalJs(`window.__debugScene.resetPose()`);
  await delay(300);
  const back = await evalJs(endVertexExpr);
  const residual = Math.hypot(...back.map((x, i) => x - before[i]));
  assert('绑定姿态使网格回到初始位置', residual < 1e-4, `残差=${residual}`);
  const wAt73After = await evalJs(`JSON.stringify(window.__debugScene.getVertexWeights(73))`);
  assert('复位后权重编辑仍在', wAt73 === wAt73After);

  // 5. 锁定 + 笔刷:锁定骨骼不动,其余再分配且归一(需求 3)
  const brush = await evalJs(`(() => {
    const s = window.__debugScene;
    s.setBoneLocked(1, true);
    const lockedBefore = s.getVertexWeights(73)[1];
    for (let i = 0; i < 30; i++) {
      s.model.paintVertex(73, { bone: 0, delta: 0.05, locked: s.getLocked() });
    }
    const w = s.getVertexWeights(73);
    return {
      lockedKept: Math.abs(w[1] - lockedBefore) < 1e-9,
      normalized: Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-6,
      w,
    };
  })()`);
  assert('笔刷修改:锁定权重不变且其余权重归一', brush.lockedKept && brush.normalized, JSON.stringify(brush.w));

  // 6. 保存/恢复权重+姿态(需求 5)
  const storageOk = await evalJs(`(() => {
    const s = window.__debugScene;
    const w0 = JSON.stringify(s.getVertexWeights(10));
    const p0 = JSON.stringify(s.getPoses());
    document.getElementById('save').click();
    s.applyPreset('tail');
    s.setPose([{rotY:9,rotZ:0},{rotY:11,rotZ:0},{rotY:0,rotZ:7}]);
    document.getElementById('restore').click();
    return JSON.stringify(s.getVertexWeights(10)) === w0 && JSON.stringify(s.getPoses()) === p0;
  })()`);
  assert('保存并恢复权重和姿态', storageOk);

  // 7. 肘部 vs 尾部过渡示例(需求 5):关节1(x=2)外侧同一顶点(ix=18, x≈2.25),
  //    肘部过渡带窄已基本倒向骨骼1;尾部过渡带宽,骨骼0仍有明显占比。
  //    先解除上一步留下的锁定,保证预设不被锁定状态干扰。
  const presetOk = await evalJs(`(() => {
    const s = window.__debugScene;
    for (let b = 0; b < 3; b++) s.setBoneLocked(b, false);
    const v = 18 * 3;
    s.applyPreset('elbow');
    const elbow = s.getVertexWeights(v);
    s.applyPreset('tail');
    const tail = s.getVertexWeights(v);
    return elbow[1] > tail[1] && tail[0] > elbow[0];
  })()`);
  assert('肘部/尾部过渡示例存在差异', presetOk);

  // 8. 画布确实在出图(WebGL 上下文存活且渲染尺寸非零)
  const canvasOk = await evalJs(`(() => {
    const c = document.querySelector('#viewport canvas');
    return !!c && c.width > 0 && c.height > 0;
  })()`);
  assert('WebGL 画布持续渲染', canvasOk);

  console.log('\n运行时冒烟结果:');
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  ' + c.detail : ''}`);
  console.log(`\n全部 ${checks.length} 项通过`);
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('\n冒烟失败:', err.message);
  cleanup();
  process.exit(1);
}
