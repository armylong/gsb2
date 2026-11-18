/**
 * 零依赖浏览器冒烟测试: 通过 Chrome DevTools Protocol 驱动页面,
 * 验证布局切换、关门、播放与验证按钮的真实运行结果。
 * 运行: CHROME_BIN=... npx vite-node scripts/browser-smoke.ts
 */
import { spawn, ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const TARGET = process.env.SMOKE_URL ?? 'http://127.0.0.1:5174/';
const CHROME =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

async function getWsUrl(): Promise<string> {
  // 新版 Chrome 要求 PUT 调用 /json/new
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(TARGET)}`, {
    method: 'PUT',
  });
  const body = (await res.json()) as { webSocketDebuggerUrl: string };
  return body.webSocketDebuggerUrl;
}

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private events: { method: string; params: Record<string, unknown> }[] = [];
  readonly ready: Promise<void>;
  constructor(private ws: WebSocket) {
    this.ready = new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('WebSocket 连接失败'));
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    };
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval<T>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value: T; exceptionDetails?: unknown } };
    if (r.result.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails));
    return r.result.value;
  }
}

async function main(): Promise<void> {
  const chrome: ChildProcess = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--window-size=1400,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  try {
    let wsUrl = '';
    for (let i = 0; i < 40; i++) {
      try {
        wsUrl = await getWsUrl();
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!wsUrl) throw new Error('Chrome CDP 未就绪');
    const cdp = new Cdp(new WebSocket(wsUrl));
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: TARGET });
    await sleep(2500);

    const results: Record<string, unknown> = {};

    // 1. 初始状态
    results.initial = await cdp.eval(
      `({status: document.getElementById('statusPill').textContent, repath: document.getElementById('statRepath').textContent, pos: document.getElementById('statPos').textContent})`,
    );

    // 2. 切到窄门布局, 大半径 -> 应不可达
    await cdp.eval(`[...document.querySelectorAll('[data-layout]')].find(b=>b.dataset.layout==='narrow-door').click()`);
    await sleep(300);
    await cdp.eval(`const r=document.getElementById('radiusRange'); r.value='0.8'; r.dispatchEvent(new Event('input'))`);
    await sleep(300);
    results.bigRadiusNarrow = await cdp.eval(
      `({status: document.getElementById('statusPill').textContent, detail: document.getElementById('statusDetail').textContent})`,
    );

    // 3. 半径调回 0.2 -> 恢复
    await cdp.eval(`const r2=document.getElementById('radiusRange'); r2.value='0.2'; r2.dispatchEvent(new Event('input'))`);
    await sleep(300);
    results.smallRadiusNarrow = await cdp.eval(`document.getElementById('statusPill').textContent`);

    // 4. 切到围住布局, 关两扇门 -> 不可达
    await cdp.eval(`[...document.querySelectorAll('[data-layout]')].find(b=>b.dataset.layout==='enclosed-goal').click()`);
    await sleep(300);
    await cdp.eval(`[...document.querySelectorAll('#doorButtons button')].forEach(b=>b.click())`);
    await sleep(400);
    results.bothDoorsClosed = await cdp.eval(
      `({status: document.getElementById('statusPill').textContent, routeActive: document.getElementById('statRemain').textContent})`,
    );

    // 5. 点四个验证按钮, 读取报告通过率
    await cdp.eval(`[...document.querySelectorAll('#validationButtons button')].forEach(b=>b.click())`);
    await sleep(1500);
    results.validationReports = await cdp.eval(
      `[...document.querySelectorAll('.report')].map(r=>({title: r.querySelector('.report-header span').textContent, summary: r.querySelector('.report-header span:last-child').textContent, checks: r.querySelectorAll('.check.pass').length + '/' + r.querySelectorAll('.check').length}))`,
    );

    // 6. 播放按钮在 ready 状态下应让角色移动
    await cdp.eval(`[...document.querySelectorAll('[data-layout]')].find(b=>b.dataset.layout==='dual-channel').click()`);
    await sleep(300);
    const posBefore = await cdp.eval<string>(`document.getElementById('statPos').textContent`);
    await cdp.eval(`document.getElementById('btnPlay').click()`);
    await sleep(1200);
    const posAfter = await cdp.eval<string>(`document.getElementById('statPos').textContent`);
    results.movement = { posBefore, posAfter, moved: posBefore !== posAfter };

    console.log(JSON.stringify(results, null, 2));

    const reports = results.validationReports as { checks: string }[];
    const allReportsPass = reports.every((r) => {
      const [passed, total] = r.checks.split('/').map(Number);
      return passed === total;
    });
    const cond = {
      bigRadiusBlocked: (results.bigRadiusNarrow as { status: string }).status.includes('无可达'),
      smallRadiusOk: (results.smallRadiusNarrow as string).includes('就绪'),
      doorsBlock: (results.bothDoorsClosed as { status: string }).status.includes('无可达'),
      moved: (results.movement as { moved: boolean }).moved,
      fourReports: reports.length === 4,
      allReportsPass,
    };
    console.log('判定明细:', JSON.stringify(cond));
    const ok = Object.values(cond).every(Boolean);
    console.log(ok ? '\n浏览器冒烟测试: 全部通过' : '\n浏览器冒烟测试: 存在失败');
    if (!ok) process.exitCode = 1;
  } finally {
    chrome.kill();
  }
}

main().then(
  () => {
    clearTimeout(guard);
    // Chrome 子进程可能让事件循环保持存活, 显式退出
    process.exit(process.exitCode ?? 0);
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

// 整体兜底超时, 避免 CDP 异常时永久挂起
const guard = setTimeout(() => {
  console.error('冒烟测试超过 60 秒未完成, 强制退出');
  process.exit(2);
}, 60_000);
guard.unref();
