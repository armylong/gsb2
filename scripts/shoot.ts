/**
 * 用 CDP 对三个布局与验证面板逐一截图, 输出到 scripts/shots/。
 * 运行: SMOKE_URL=http://127.0.0.1:5189/ npx vite-node scripts/shoot.ts
 */
import { spawn, ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';

const TARGET = process.env.SMOKE_URL ?? 'http://127.0.0.1:5189/';
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9334;

class Cdp {
  private id = 0;
  private pending = new Map<number, (r: unknown) => void>();
  readonly ready: Promise<void>;
  constructor(private ws: WebSocket) {
    this.ready = new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws fail'));
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const resolve = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        resolve(msg.result);
      }
    };
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression: string): Promise<void> {
    await this.send('Runtime.evaluate', { expression, awaitPromise: true });
  }
  async shoot(path: string): Promise<void> {
    const r = (await this.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    writeFileSync(path, Buffer.from(r.data, 'base64'));
  }
}

async function getWsUrl(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(TARGET)}`, { method: 'PUT' });
  return ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
}

async function main(): Promise<void> {
  const chrome: ChildProcess = spawn(
    CHROME,
    [`--remote-debugging-port=${PORT}`, '--headless', '--disable-gpu', '--no-sandbox',
      '--window-size=1400,950', 'about:blank'],
    { stdio: 'ignore' },
  );
  try {
    let wsUrl = '';
    for (let i = 0; i < 40; i++) {
      try { wsUrl = await getWsUrl(); break; } catch { await sleep(250); }
    }
    const cdp = new Cdp(new WebSocket(wsUrl));
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: TARGET });
    await sleep(2000);

    mkdirSync('scripts/shots', { recursive: true });
    const layouts = ['dual-channel', 'narrow-door', 'enclosed-goal'];
    for (const id of layouts) {
      await cdp.eval(`[...document.querySelectorAll('[data-layout]')].find(b=>b.dataset.layout==='${id}').click()`);
      await sleep(700);
      await cdp.shoot(`scripts/shots/${id}.png`);
      console.log('saved', id);
    }

    // 验证面板: 点四个按钮后截全页面
    await cdp.eval(`[...document.querySelectorAll('#validationButtons button')].forEach(b=>b.click())`);
    await sleep(1500);
    await cdp.shoot('scripts/shots/validation.png');
    console.log('saved validation');
  } finally {
    chrome.kill();
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
