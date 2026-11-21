/**
 * 真实浏览器冒烟测试:通过 CDP 驱动 headless Chrome。
 * 验证三个现场加载、逐步走路线、手动移动撞门、编辑失效重算、保存/恢复。
 * 运行:node tools/cdp-smoke.mjs
 */
const BASE = process.env.LDC_URL ?? 'http://localhost:5180/';

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const pageTarget = targets.find((t) => t.type === 'page');
if (!pageTarget) throw new Error('没有可用的页面 target');
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  }
});
await new Promise((r) => (ws.onopen = r));

function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
}
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickBtn = async (sel) => evalJs(`document.querySelector(${JSON.stringify(sel)}).click()`);
const badge = () => evalJs(`document.querySelector('#statusBody .badge').textContent`);
const screenshot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`/tmp/ldc-${name}.png`, Buffer.from(r.data, 'base64'));
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
// 等首屏渲染完成
for (let i = 0; i < 50; i++) {
  const ok = await evalJs(`!!document.querySelector('#statusBody .badge')`);
  if (ok) break;
  await sleep(100);
}

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra: String(extra ?? '') });
  if (!cond) console.error(`FAIL: ${name} ${extra}`);
};

// 1. 首屏默认生成的布局可解
check('首屏布局可解', (await badge()).includes('可解'), await badge());

// 2. 现场二:钥匙自锁
await clickBtn('[data-scene="selflock"]');
await sleep(150);
const selfBadge = await badge();
const selfReason = await evalJs(`document.querySelector('#statusBody').innerText`);
check('现场二判为不可达', selfBadge.includes('不可达'), selfBadge);
check('现场二病因是钥匙自锁', selfReason.includes('钥匙自锁'));
check('现场二列出阻塞门', (await evalJs(`document.querySelectorAll('#statusBody .blocker-list li').length`)) > 0);
check('现场二列出相关房间', selfReason.includes('相关房间'));
await screenshot('selflock');

// 3. 现场三:通道断裂
await clickBtn('[data-scene="broken"]');
await sleep(150);
const brokenText = await evalJs(`document.querySelector('#statusBody').innerText`);
check('现场三判为不可达', (await badge()).includes('不可达'));
check('现场三病因是地形断开', brokenText.includes('地形断开'));
check('现场三标出断开房间', brokenText.includes('断开分量'));
await screenshot('broken');

// 4. 现场一:返程开门,播放路线
await clickBtn('[data-scene="roundtrip"]');
await sleep(150);
check('现场一可解', (await badge()).includes('可解'));
const eventsBefore = await evalJs(`document.querySelectorAll('#routeEvents .ev').length`);
check('现场一有路线事件', eventsBefore > 0, eventsBefore);
// 播放完整路线(轮询等待,最多 45 秒;220ms/步,长路线约 120 步)
await clickBtn('#routePlayBtn');
let playerText = '';
for (let i = 0; i < 450; i++) {
  playerText = await evalJs(`document.querySelector('#playerState').innerText`);
  if (playerText.includes('已在出口')) break;
  await sleep(100);
}
check('路线播放结束后标记到达出口', playerText.includes('已在出口'), playerText);
const eventCount = await evalJs(`document.querySelectorAll('#routeEvents .ev').length`);
check('播放过程产生了拾钥匙/开门事件', eventCount >= 2, eventCount);
await screenshot('roundtrip-played');

// 5. 手动控制:重置后用方向键移动,撞墙/撞锁会被记录
await clickBtn('#routeResetBtn');
await sleep(50);
// 先持续向右走 12 步,验证 Player 状态机在真实页面工作
const moved = await evalJs(`(async () => {
  for (let i = 0; i < 12; i++) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise(r => setTimeout(r, 10));
  }
  return document.querySelector('#playerState').innerText;
})()`);
check('手动控制后标记离开起点并产生步数', /步数 [1-9]/.test(moved), moved);

// 6. 编辑失效:解析阻塞门坐标,用门改色工具点击,确认结果立即重算
await clickBtn('[data-scene="selflock"]');
await sleep(150);
const beforeEdit = await badge();
const blockerText = await evalJs(`document.querySelector('#statusBody .blocker-list li').innerText`);
const m = blockerText.match(/\((\d+),(\d+)\)/);
check('阻塞门坐标可从面板解析', !!m, blockerText);
if (m) {
  const [, gx, gy] = m;
  await evalJs(`(() => {
    const c = document.getElementById('mapCanvas');
    const r = c.getBoundingClientRect();
    const cx = ((+${gx} + 0.5) / 72) * r.width + r.left;
    const cy = ((+${gy} + 0.5) / 48) * r.height + r.top;
    document.querySelector('[data-tool="door"]').click();
    c.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true }));
  })()`);
  await sleep(150);
  const afterEdit = await badge();
  const logCount = await evalJs(`document.querySelectorAll('#editLog li').length`);
  check('门改色后产生修改记录', logCount >= 1);
  check('编辑后检查结果立即变化(旧结论失效)', beforeEdit !== afterEdit, `${beforeEdit} -> ${afterEdit}`);
  // 撤销
  await clickBtn('#undoEditBtn');
  await sleep(100);
  check('撤销后恢复原结论', (await badge()) === beforeEdit);
}

// 7. 保存/恢复(localStorage 往返)
await clickBtn('#saveBtn');
await sleep(100);
const saved = await evalJs(`localStorage.getItem('ldc-save-v1')`);
check('存档写入 localStorage', !!saved && saved.includes('lockdown-dungeon-save'));
// 改参数生成新图,再恢复
await evalJs(`document.getElementById('seedInput').value='another-seed'`);
await clickBtn('#generateBtn');
await sleep(150);
const midBadge = await badge();
await clickBtn('#loadBtn');
await sleep(200);
const restoredBadge = await badge();
const restoredSeed = await evalJs(`document.querySelector('#statusBody').innerText`);
check('恢复存档后回到保存时的现场结论', restoredBadge.includes('不可达'), restoredBadge);
check('恢复内容含自锁诊断', restoredSeed.includes('钥匙自锁'));
void midBadge;
await screenshot('restored');

// 8. 控制台无错误
check('浏览器控制台无 JS 错误', consoleErrors.length === 0, consoleErrors.join(' | '));
check('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));

ws.close();
const failed = results.filter((r) => !r.ok);
console.log('\n==== CDP 冒烟测试结果 ====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  [${r.extra}]`}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
