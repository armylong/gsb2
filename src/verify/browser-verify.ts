// 浏览器端到端验证(顶层 await 需 ESM 模块标记)
export {};

/**
 * 浏览器端验证(通过 CDP 驱动无头 Chrome):
 *  - 自交四边形必须被拒绝且保留旧投影
 *  - 三个场景的导出 PNG -> 导入反演, 采样点灰度/覆盖一致
 * 前置: 无头 Chrome 已带 --remote-debugging-port=9222 启动, dev server 在 5174。
 */
const BASE = 'http://localhost:5174';

const list = await (await fetch('http://localhost:9222/json/new?' + encodeURIComponent(BASE + '/'), {
  method: 'PUT',
})).json();
const ws = new WebSocket(list.webSocketDebuggerUrl);
let id = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

await new Promise<void>((resolve, reject) => {
  ws.addEventListener('open', () => resolve());
  ws.addEventListener('error', reject);
});
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  }
});

await send('Page.enable');
await send('Runtime.enable');
await new Promise((r) => setTimeout(r, 2000));

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

async function evalJs<T>(expr: string): Promise<T> {
  const res = (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })) as {
    result?: { value?: T; exceptionDetails?: unknown };
  };
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
  return res.result!.value!;
}

// 1. 自交保护
const st = await evalJs<{ accepted: boolean; invalidReason: string | null; quadChanged: boolean }>(
  'window.edgeBlendSelfTest.attemptSelfIntersect()',
);
check('自交拖动被拒绝', st.accepted === false, JSON.stringify(st));
check('自交时保留上次有效投影', st.quadChanged === false);
check('给出异常原因', st.invalidReason !== null && st.invalidReason.includes('自交'));

// 2. 三个场景的导出/导入往返
type RoundTrip = {
  warnings: string[];
  bitmapCount: number;
  before: Array<{ id: number; gray: number | null; cover: string }>;
  after: Array<{ id: number; gray: number | null; cover: string }>;
};

for (const scenario of ['normal', 'diagonal', 'gap']) {
  // 切换场景
  await evalJs(`window.edgeBlendSelfTest.setScenario('${scenario}')`);
  // 直接调用状态层切换(路由仅启动时解析), 再跑往返
  const r = await evalJs<RoundTrip>(
    `(async () => {
       window.__rt = await window.edgeBlendSelfTest.roundTrip();
       return window.__rt;
     })()`,
  );
  check(`${scenario}: 导入两张位图`, r.bitmapCount === 2, `count=${r.bitmapCount}`);
  check(`${scenario}: 无导入警告`, r.warnings.length === 0, r.warnings.join(';'));
  r.before.forEach((b, i) => {
    const a = r.after[i];
    check(`${scenario}: 探针${i + 1} 覆盖状态一致(${b.cover})`, b.cover === a.cover);
    if (b.gray === null) {
      check(`${scenario}: 探针${i + 1} 缝隙保持无输出`, a.gray === null);
    } else {
      // 内部平滑点容差 6(二次重采样滤波); 重叠区放宽到 12
      const tol = b.cover === 'overlap' ? 12 : 6;
      check(`${scenario}: 探针${i + 1} 灰度往返一致(容差${tol})`, Math.abs(b.gray - (a.gray ?? NaN)) <= tol,
        `before=${b.gray?.toFixed(1)} after=${a.gray?.toFixed(1)} cover=${b.cover}`);
    }
  });
}

// gap 场景专属: 缝隙中点必须无覆盖, 缝两侧独占区有覆盖
{
  await evalJs(`window.edgeBlendSelfTest.setScenario('gap')`);
  // 缝在主平面 u∈[0.47,0.55], 中点 u=0.51; 幕布 x=120+1360u, y 取中部
  await evalJs(`(
    () => {
      const s = window.edgeBlendSelfTest.state();
      s.probes.length = 0;
      [0.51, 0.42, 0.60].forEach(u => s.probes.push({ x: 120 + 1360 * u, y: 340 }));
      window.edgeBlendSelfTest.refresh();
    })()`);
  const covers = await evalJs<Array<{ cover: string; gray: number | null }>>(`(
    () => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const rows = [...document.querySelectorAll('#probeTable tbody tr')].map(tr => {
          const td = tr.querySelectorAll('td');
          return { cover: td[3].textContent.trim(), gray: td[5].textContent.trim() === '—' ? null : Number(td[5].textContent) };
        });
        resolve(rows);
      }));
    }))()`);
  check('gap: 缝隙中点无覆盖', covers[0]?.cover === '未覆盖', JSON.stringify(covers[0]));
  check('gap: 缝隙中点无灰度输出', covers[0]?.gray === null);
  check('gap: 缝左侧仅投影1', covers[1]?.cover === '仅投影1', JSON.stringify(covers[1]));
  check('gap: 缝右侧仅投影2', covers[2]?.cover === '仅投影2', JSON.stringify(covers[2]));
}
const badSettings = {
  version: 1,
  exportedAt: new Date().toISOString(),
  screenWidth: 1600,
  screenHeight: 720,
  patternWidth: 1600,
  patternHeight: 600,
  blendWidth: 160,
  projectors: [
    {
      id: 1, name: 'bad', outputWidth: 960, outputHeight: 600,
      quad: [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 }],
      brightness: 1, patternU0: 0, patternU1: 0.5, patternV0: 0, patternV1: 1, imageFile: 'x.png',
    },
    {
      id: 2, name: 'bad2', outputWidth: 960, outputHeight: 600,
      quad: [{ x: 200, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 200 }, { x: 200, y: 200 }],
      brightness: 1, patternU0: 0.5, patternU1: 1, patternV0: 0, patternV1: 1, imageFile: 'y.png',
    },
  ],
};
const warn = await evalJs<string[]>(
  `(async () => {
     const f = new File([${JSON.stringify(JSON.stringify(badSettings))}], 's.json', {type:'application/json'});
     const r = await (await import('/src/ui/io.ts')).importBundle([f], window.edgeBlendSelfTest.state());
     return r.warnings;
   })()`,
);
check('导入文件中的自交四边形产生警告并被拒绝', warn.some((w) => w.includes('非法')), JSON.stringify(warn));

console.log(`\n浏览器验证结果: ${passes} 通过, ${failures} 失败`);
ws.close();
process.exit(failures === 0 ? 0 : 1);
