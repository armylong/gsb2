/**
 * 浏览器端冒烟验证(仅依赖 Chrome DevTools Protocol,无第三方库):
 * - 页面加载无错误、WebGL 正常渲染;
 * - 64 个块最终全部生成网格并收敛,收敛时在途任务为 0;
 * - 远景块网格三角形真实少于近景块;
 * - 慢任务往返后存在过期丢弃计数,且最终仍收敛到最新请求;
 * - 地形外查询返回 inside=false;换种子重建后全部块属于新地形代数。
 */
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5173';
const CDP_PORT = process.env.SMOKE_CDP_PORT ?? '9333';
const OVERALL_TIMEOUT_MS = 200_000;
const deadline = Date.now() + OVERALL_TIMEOUT_MS;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function assertTimeLeft() {
  if (Date.now() > deadline) throw new Error('overall timeout exceeded');
}

async function cdpJson(path) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`);
  return res.json();
}

function createClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (!msg.id) {
      for (const fn of listeners) fn(msg);
    }
  });
  return {
    ready: new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', reject);
    }),
    send(method, params = {}) {
      const mid = ++id;
      const promise = new Promise((resolve) => pending.set(mid, resolve));
      ws.send(JSON.stringify({ id: mid, method, params }));
      return promise;
    },
    on(fn) {
      listeners.push(fn);
    },
    close() {
      ws.close();
    },
  };
}

async function evalJs(client, expression) {
  const r = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(
      'JS exception: ' +
        JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text),
    );
  }
  // CDP 信封:{ id, result: { result: { type, value }, exceptionDetails? } }
  return r.result?.result?.value;
}

async function waitUntil(client, expression, interval = 300, label = expression) {
  for (;;) {
    assertTimeLeft();
    const v = await evalJs(client, expression);
    if (v) return v;
    await sleep(interval);
  }
}

async function waitUntilOrDiagnose(client, expression, label) {
  try {
    await waitUntil(client, expression, 400, label);
  } catch (e) {
    const diag = await evalJs(
      client,
      `(() => {
        const t = window.terrainDemo && window.terrainDemo.terrain;
        if (!t) return { demo: false };
        const info = t.chunkDisplayInfo();
        return {
          stats: { ...t.stats },
          queued: t.queuedCount,
          busy: t.workerBusyCount,
          withMesh: info.filter((c) => c.currentLod !== null).length,
          inFlight: info.filter((c) => c.inFlight).length,
          converged: t.isConverged(),
        };
      })()`,
    ).catch((err) => String(err));
    throw new Error(`等待 [${label}] 超时。页面异常: ${JSON.stringify(pageErrors)}; 现场: ${JSON.stringify(diag)}`);
  }
}

const failures = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
  if (!cond) failures.push(name);
}

const tabs = await cdpJson('/json/list');
const tab = tabs.find((t) => t.type === 'page');
if (!tab) throw new Error('no page target found');
const client = createClient(tab.webSocketDebuggerUrl);
await client.ready;
await client.send('Page.enable');
await client.send('Runtime.enable');

const pageErrors = [];
client.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
});

await client.send('Page.navigate', { url: BASE });
try {
  await waitUntilOrDiagnose(client, `document.readyState === 'complete'`, '页面加载');
} catch (e) {
  // 诊断时同时报告标签页 URL,区分"未导航"与"导航后卡住"
  const nav = await evalJs(client, `({ url: location.href, rs: document.readyState, title: document.title })`).catch((err) => String(err));
  throw new Error(`${e.message} | 导航现场: ${JSON.stringify(nav)}`);
}
await waitUntilOrDiagnose(client, `!!window.terrainDemo`, 'terrainDemo 挂载');
await sleep(2000);

// 1) 基础对象与 WebGL
const boot = await evalJs(
  client,
  `(() => {
    const d = window.terrainDemo;
    const c = document.querySelector('#scene');
    return {
      hasDemo: !!d,
      gl: !!(c.getContext('webgl2') || c.getContext('webgl')),
      chunks: d.terrain.chunkDisplayInfo().length,
    };
  })()`,
);
check('页面挂载地形演示对象与 WebGL canvas,共 64 块', boot.hasDemo && boot.gl && boot.chunks === 64, JSON.stringify(boot));

// 2) 等待收敛
await evalJs(client, `window.terrainDemo.terrain.setDelay(0)`);
await waitUntilOrDiagnose(client, `window.terrainDemo.terrain.isConverged()`, '初始收敛');
const stateAtConverge = await evalJs(
  client,
  `(() => {
    const t = window.terrainDemo.terrain;
    const info = t.chunkDisplayInfo();
    return {
      pending: t.stats.pending,
      queued: t.queuedCount,
      withMesh: info.filter((c) => c.currentLod !== null).length,
      hist: t.lodHistogram(),
    };
  })()`,
);
check(
  '64 块全部生成网格且任务收敛、在途/队列均为 0',
  stateAtConverge.withMesh === 64 && stateAtConverge.pending === 0 && stateAtConverge.queued === 0,
  JSON.stringify(stateAtConverge),
);

// 3) 远块三角形真实少于近块:按块当前 LOD 分组统计已上屏几何
const meshSizes = await evalJs(
  client,
  `(() => {
    const t = window.terrainDemo.terrain;
    const info = t.chunkDisplayInfo();
    const groups = t.group.children;
    const buckets = [[], [], []];
    info.forEach((c, i) => {
      if (c.currentLod === null) return;
      const mesh = groups[i].children.find((o) => o.isMesh);
      if (mesh && mesh.geometry) buckets[c.currentLod].push(mesh.geometry.getIndex().count / 3);
    });
    const avg = buckets.map((arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null));
    return { avg, counts: buckets.map((a) => a.length) };
  })()`,
);
check(
  '远块(LOD2)三角形真实少于近块(LOD0)',
  meshSizes.avg[0] > meshSizes.avg[1] && meshSizes.avg[1] > meshSizes.avg[2],
  `平均三角形 LOD0/1/2 = ${meshSizes.avg.join(' / ')}, 样本数 = ${meshSizes.counts.join('/')}`,
);

// 4) 接缝:x=0 公共边缘两侧块的顶点高度集合完全一致
const seam = await evalJs(
  client,
  `(() => {
    const t = window.terrainDemo.terrain;
    const line = new Map();
    let bad = 0;
    t.group.children.forEach((g) => {
      const mesh = g.children.find((o) => o.isMesh);
      if (!mesh) return;
      const p = mesh.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        if (Math.abs(x) >= 1e-4) continue;
        const key = p.getZ(i).toFixed(4);
        const y = p.getY(i);
        if (line.has(key) && Math.abs(line.get(key) - y) > 1e-5) bad++;
        line.set(key, y);
      }
    });
    return { bad, points: line.size };
  })()`,
);
check('x=0 公共边缘两侧块顶点高度完全一致(浏览器真实几何)', seam.bad === 0 && seam.points >= 33, JSON.stringify(seam));

// 5) 慢任务往返:高延迟下快速抖动请求,检查过期/取代计数与最终收敛
await evalJs(client, `window.terrainDemo.terrain.setDelay(400)`);
const staleBefore = await evalJs(
  client,
  `window.terrainDemo.terrain.stats.totalStale + window.terrainDemo.terrain.stats.totalSuperseded`,
);
await evalJs(
  client,
  `(async () => {
    const t = window.terrainDemo.terrain;
    // 通过管理器入口驱动(请求会真实进入 Worker 池),模拟相机快速往返的请求抖动
    for (let cycle = 0; cycle < 4; cycle++) {
      t.requestChunkNow(0, 0, cycle % 3);
      t.requestChunkNow(1, 1, (cycle + 1) % 3);
      await new Promise((r) => setTimeout(r, 60));
    }
  })()`,
);
await waitUntilOrDiagnose(client, `window.terrainDemo.terrain.stats.pending === 0`, '慢任务 pending 归零');
const finalConverged = await evalJs(client, `window.terrainDemo.terrain.isConverged()`);
const staleStats = await evalJs(
  client,
  `(() => { const s = window.terrainDemo.terrain.stats; return { stale: s.totalStale, superseded: s.totalSuperseded, pending: s.pending }; })()`,
);
const staleAfter = staleStats.stale + staleStats.superseded;
check(
  '慢任务往返产生过期/取代记录且最终重新收敛',
  staleAfter > staleBefore && finalConverged && staleStats.pending === 0,
  `过期+取代 ${staleBefore} -> ${staleAfter}`,
);

// 6) 地形外查询
const outside = await evalJs(
  client,
  `(() => ({ inside: window.terrainDemo.inside(200, 200), half: window.terrainDemo.half }))()`,
);
check('地形外坐标 inside=false(边界 ±160)', outside.inside === false && outside.half === 160);

// 7) 换种子重建:代数递增,最终所有块属于新代数
const rebuild = await evalJs(
  client,
  `(async () => {
    const t = window.terrainDemo.terrain;
    t.setDelay(300);
    const epochBefore = t.stats.terrainEpoch;
    t.rebuild(424242);
    const epochAfter = t.stats.terrainEpoch;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (t.isConverged()) break;
    }
    const info = t.chunkDisplayInfo();
    return {
      epochBefore,
      epochAfter,
      converged: t.isConverged(),
      allNewEpoch: info.every((c) => t.taskSystem.getChunk(c.cx, c.cz).currentEpoch === epochAfter),
      seed: t.taskSystem.currentSeed,
    };
  })()`,
);
check(
  '换种子重建后代数递增且全部块属于新代数',
  rebuild.epochAfter === rebuild.epochBefore + 1 && rebuild.converged && rebuild.allNewEpoch && rebuild.seed === 424242,
  JSON.stringify(rebuild),
);

check('页面无未捕获 JS 异常', pageErrors.length === 0, pageErrors.join('; '));

client.close();
console.log(`\n${failures.length === 0 ? 'ALL BROWSER SMOKE CHECKS PASSED' : failures.length + ' CHECK(S) FAILED'}`);
process.exit(failures.length === 0 ? 0 : 1);
