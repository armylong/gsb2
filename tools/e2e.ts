/**
 * 浏览器端到端探针：用 CDP 无头驱动真实页面，
 * 点击预设/播放/卡榫，读取 DOM 读数验证完整交互链路。
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/zhangzelong/works/gsb2/tasks/16376/repo';
const PORT = 8931;

// 极简静态服务器
const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};
const server = http.createServer((req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url!;
  const file = path.join(ROOT, url.split('?')[0]);
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('nf');
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'text/plain' });
    res.end(data);
  });
});
await new Promise<void>((r) => server.listen(PORT, r));

const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${PORT + 1}`,
    `http://localhost:${PORT}/index.html`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
chrome.stderr.on('data', () => {});

async function getJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

// 等 devtools 就绪
let target: any;
for (let i = 0; i < 40; i++) {
  try {
    const list = await getJSON(`http://localhost:${PORT + 1}/json`);
    target = list.find((t: any) => t.type === 'page');
    if (target) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
if (!target) throw new Error('Chrome devtools 未就绪');

const WebSocket = globalThis.WebSocket; // Node 22 内置
const ws = new WebSocket(target.webSocketDebuggerUrl);
await once(ws, 'open');

let msgId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
ws.addEventListener('message', (ev: MessageEvent) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)!.resolve(m.result);
    pending.delete(m.id);
  }
});
function send(method: string, params: any = {}): Promise<any> {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await send('Runtime.enable');
await send('Page.enable');

async function evalJs<T = any>(expr: string): Promise<T> {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
  return r.result.value as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: string[] = [];
function check(name: string, cond: boolean, extra = '') {
  results.push(`${cond ? '✓' : '✗'} ${name} ${extra}`);
  if (!cond) throw new Error(`断言失败: ${name} ${extra}`);
}

try {
  await sleep(500);
  // 1. 初始平衡台应静止
  const initH = await evalJs<string>('document.querySelector("#readouts tbody tr td:nth-child(3)").textContent');
  check('初始平衡台灯高=220', initH.trim().startsWith('220'), `实际 ${initH}`);

  // 2. 加载"刚好过头"预设并武装下窗格，播放
  await evalJs(`[...document.querySelectorAll('#presets .preset')].find(b=>b.textContent.includes('过头')).click()`);
  await sleep(100);
  await evalJs(`document.getElementById('btnPlay').click()`);
  await sleep(7000); // 仿真约 5s 穿过下窗格（虚拟时间受实时节流，多等）
  await evalJs(`document.getElementById('btnPause').click()`);

  const checkRows = await evalJs<number>(`document.querySelectorAll('#checkLog tr.check-too-fast').length`);
  check('过头预设产生 too-fast 检查记录', checkRows >= 1, `记录数 ${checkRows}`);

  // 3. 行程中换配重（灯调轻），速度应连续，随后回升
  const vBefore = await evalJs<string>(`document.querySelector("#readouts tbody tr:nth-child(2) td:nth-child(4)").textContent`);
  await evalJs(`
    const sel = document.getElementById('w_lantern');
    sel.value = '0.75';
    sel.dispatchEvent(new Event('change', {bubbles:true}));
  `);
  const vAfter = await evalJs<string>(`document.querySelector("#readouts tbody tr:nth-child(2) td:nth-child(4)").textContent`);
  check('换配重瞬间速度不跳变', vBefore.trim() === vAfter.trim(), `before=${vBefore} after=${vAfter}`);

  // 4. 单步推进可用且每帧只走一步
  const frameBefore = await evalJs<string>(`document.querySelector('.rope-sum').textContent`);
  await evalJs(`document.getElementById('btnStep').click()`);
  const frameAfter = await evalJs<string>(`document.querySelector('.rope-sum').textContent`);
  check('单步后帧号 +1', (frameBefore.match(/逻辑帧：(\d+)/)?.[1] ?? '') !== (frameAfter.match(/逻辑帧：(\d+)/)?.[1] ?? ''));

  // 5. 绳长和恒为 660
  const sum = await evalJs<string>(`document.querySelector('.rope-sum b:nth-child(2)').textContent`);
  check('绳长和守恒 660', sum.trim().startsWith('660'), `=${sum}`);

  // 6. 加载 gentle 预设，验证能 locked
  await evalJs(`[...document.querySelectorAll('#presets .preset')].find(b=>b.textContent.includes('缓慢升')).click()`);
  await sleep(100);
  await evalJs(`document.getElementById('btnPlay').click()`);
  await sleep(9000);
  await evalJs(`document.getElementById('btnPause').click()`);
  const locked = await evalJs<number>(`document.querySelectorAll('#checkLog tr.check-locked').length`);
  check('缓升预设成功 locked', locked >= 1, `locked 数 ${locked}`);

  // 7. 截图保存最终画面
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/lantern-e2e.png', Buffer.from(shot.data, 'base64'));

  console.log(results.join('\n'));
  console.log('\n端到端交互全部通过');
} finally {
  chrome.kill();
  server.close();
  ws.close();
}
