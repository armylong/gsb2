// 端到端流程冒烟：通过页面上的真实按钮 + 调试钩子，
// 验证 标记入链 / 跳格 / 三类验证结论 / 同种子重开复现。
// 用法：node tools/e2e.mjs [scenarioId] [routeId]
const { spawn } = await import('node:child_process');

const SCENARIO = process.argv[2] ?? 'wind-buried';
const ROUTE_ID = Number(process.argv[3] ?? 2);

const CHROME =
  process.env.HOME +
  '/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const PORT = 9223;
const chrome = spawn(CHROME, [
  '--headless',
  '--disable-gpu',
  '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  'about:blank',
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
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
const evalJs = async (expression) =>
  (
    await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
  ).result.value;

const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown')
    errors.push('EXCEPTION: ' + m.params.exceptionDetails.text);
});
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://localhost:5180/' });
await sleep(1200);

await evalJs(`
  const sel = document.getElementById('scenario-select');
  sel.value = '${SCENARIO}';
  sel.dispatchEvent(new Event('change'));
`);
await sleep(300);

const result = await evalJs(`
(async () => {
  const out = [];
  const RID = ${ROUTE_ID};
  const g = window.__snow.game;
  const route = g.scenario.routes.find(r => r.id === RID);
  // 自动找两条路线共用的路口格
  const other = g.scenario.routes.find(r => r.id !== RID);
  const junction = route.cells.find(([x,y]) =>
    other.cells.some(([x2,y2]) => x2 === x && y2 === y));
  for (const [x,y] of route.cells) {
    if (!g.isObserved(x,y))
      g.observations.set(g.key(x,y), {x,y,atTime:g.now,stepped:true,impressions:g.peek(x,y)});
  }
  let lastStep = null;
  let gaps = 0;
  for (let step=0; step<route.cells.length; step++) {
    const [x,y] = route.cells[step];
    const pick = g.getObservation(x,y).impressions.findIndex(v => v.routeId === RID);
    if (pick < 0) continue;
    if (lastStep !== null && step - lastStep === 2) { g.addGap(); gaps++; }
    const r = g.addObsEntry(x, y, pick);
    if (!r.ok) return 'ADD_FAIL:' + r.reason;
    lastStep = step;
  }
  document.getElementById('btn-verify').click();
  out.push('支持链(' + g.chain.length + '条,跳' + gaps + ')=' +
    document.getElementById('verify-result').className.replace('verify ',''));

  // 矛盾：取该路线前三个可见格，翻转第二格方向 180°
  g.clearChain();
  const picked = [];
  for (const [x,y] of route.cells) {
    const pick = g.getObservation(x,y).impressions.findIndex(v => v.routeId === RID);
    if (pick >= 0) picked.push([x,y,pick]);
    if (picked.length === 3) break;
  }
  const [cx, cy, cpick] = picked[1];
  const cobs = g.getObservation(cx, cy);
  cobs.impressions = cobs.impressions.map((v, i) =>
    i === cpick && v.dir !== null ? { ...v, dir: (v.dir + 2) % 4 } : v);
  for (const [x,y,pick] of picked) g.addObsEntry(x, y, pick);
  document.getElementById('btn-verify').click();
  out.push('翻转方向=' + document.getElementById('verify-result').className.replace('verify ',''));

  // 线索不够：只圈路口一格
  g.clearChain();
  const [jx, jy] = junction;
  const jpick = g.peek(jx,jy).length ? 0 : 0;
  g.addObsEntry(jx, jy, jpick);
  document.getElementById('btn-verify').click();
  out.push('路口单格=' + document.getElementById('verify-result').className.replace('verify ',''));

  // 同种子重开复现
  const before = JSON.stringify(g.peek(jx,jy).map(v=>[v.routeId,v.dir,v.depth,v.visibility]));
  const beforeNow = g.now;
  document.getElementById('btn-restart').click();
  await new Promise(r=>setTimeout(r,200));
  const g2 = window.__snow.game;
  const after = JSON.stringify(g2.peek(jx,jy).map(v=>[v.routeId,v.dir,v.depth,v.visibility]));
  out.push('重开复现=' + (before === after && g2.now === beforeNow ? '一致' : '不一致'));
  out.push('重开后链清空=' + (g2.chain.length === 0));
  return out.join(' | ');
})()
`);
console.log(`[${SCENARIO} R${ROUTE_ID}]`, result);
console.log('EXCEPTIONS:', errors.length ? errors.join(' | ') : 'none');
ws.close();
chrome.kill();
