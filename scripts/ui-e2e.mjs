// CDP 驱动真实 Chrome 验证主页面交互(不依赖第三方包, 用 Node 22 内置 WebSocket).
const BASE = 'http://localhost:8123/index.html';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getPageWsUrl(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有页面 target');
  return page.webSocketDebuggerUrl;
}

function cdpSend(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.removeEventListener('message', onMsg);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function cdpEval(ws, expression) {
  return cdpSend(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
}

async function main() {
  const { spawn } = await import('node:child_process');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const port = 9333;
  const proc = spawn(chrome, [
    '--headless', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${port}`,
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try { wsUrl = await getPageWsUrl(port); break; } catch { await sleep(250); }
  }
  if (!wsUrl) throw new Error('Chrome DevTools 未就绪');
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  await cdpSend(ws, 'Runtime.enable');
  await cdpSend(ws, 'Page.enable');
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      console.log('页面异常:', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  });
  await cdpSend(ws, 'Page.navigate', { url: BASE });
  await sleep(2000);

  // 1) 播放: 点击处理是异步的, 在页面内 await 后再返回
  await cdpEval(ws, "(async () => { document.getElementById('btn-play').click(); await new Promise(r => setTimeout(r, 800)); })()");
  let playingText = '';
  for (let i = 0; i < 20; i++) {
    playingText = (await cdpEval(ws, "document.getElementById('hud-playing').textContent")).result.value;
    if (playingText === '播放中') break;
    await sleep(250);
  }
  console.log('播放状态:', playingText);

  // 2) 运行示例 A(连点覆盖): 内部 reset 后自动 start, 在页面内等待播放就绪
  await cdpEval(ws, "(async () => { document.getElementById('scn-0').click(); await new Promise(r => setTimeout(r, 1200)); })()");
  for (let i = 0; i < 20; i++) {
    const t = (await cdpEval(ws, "document.getElementById('hud-playing').textContent")).result.value;
    if (t === '播放中') break;
    await sleep(250);
  }
  await sleep(6500); // 示例 A: 0.6s + 1.4s 两次点击, 再留时间观察

  const logRows = await cdpEval(ws, `[...document.querySelectorAll('#log-body tr')].map(tr =>
    [...tr.querySelectorAll('td')].slice(0, 7).map(td => td.textContent.trim()).join(' | '))`);
  console.log('\n请求日志(示例 A 跑完后):');
  for (const row of logRows.result.value) console.log('  ' + row);

  const kinds = await cdpEval(ws, `[...document.querySelectorAll('#timeline .bar-cell')].map(e => e.textContent.replace(/\\s+/g, ' ').trim())`);
  console.log('\n时间线:', kinds.result.value.join('  ||  '));

  const hasSuperseded = logRows.result.value.some((r) => r.includes('已覆盖'));
  const hasNoCancelledFill = !kinds.result.value.some((k) => k.includes('过门: 静→闹'));
  console.log('\n断言:');
  console.log('  存在「已覆盖」请求:', hasSuperseded ? 'PASS' : 'FAIL');
  console.log('  被取消的过门不出现在播放图:', hasNoCancelledFill ? 'PASS' : 'FAIL');

  // 3) 暂停/恢复拍位保持: HUD 每 100ms 刷新, 显示值有一帧粒度误差,
  //    关键断言是「暂停状态标志翻转」+「冻结期间拍位不持续上涨」
  await cdpEval(ws, "document.getElementById('btn-pause').click()");
  await sleep(300);
  const pausedFlag = (await cdpEval(ws, "document.getElementById('hud-playing').textContent")).result.value;
  const beatFrozen1 = (await cdpEval(ws, "parseFloat(document.getElementById('hud-beat').textContent)")).result.value;
  await sleep(600);
  const beatFrozen2 = (await cdpEval(ws, "parseFloat(document.getElementById('hud-beat').textContent)")).result.value;
  await cdpEval(ws, "document.getElementById('btn-resume').click()");
  await sleep(400);
  const beat2 = (await cdpEval(ws, "parseFloat(document.getElementById('hud-beat').textContent)")).result.value;
  console.log('  暂停状态标志翻转:', pausedFlag === '已暂停/未开始' ? 'PASS' : `FAIL (${pausedFlag})`);
  console.log('  暂停期间拍位冻结(两次读数一致):', Math.abs(beatFrozen1 - beatFrozen2) < 0.15 ? `PASS (${beatFrozen1} ≈ ${beatFrozen2})` : `FAIL (${beatFrozen1} vs ${beatFrozen2})`);
  console.log('  恢复后继续而非归零:', beat2 > beatFrozen2 ? `PASS (${beatFrozen2} → ${beat2})` : `FAIL (${beat2} <= ${beatFrozen2})`);

  ws.close();
  proc.kill();
  const ok = hasSuperseded && hasNoCancelledFill && pausedFlag === '已暂停/未开始' &&
    Math.abs(beatFrozen1 - beatFrozen2) < 0.15 && beat2 > beatFrozen2;
  console.log(ok ? '\nUI E2E OK' : '\nUI E2E FAILED');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
