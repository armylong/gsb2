// CDP 驱动脚本(顶层 await 需 ESM 模块标记)
export {};

/**
 * 无头浏览器 CDP 驱动: 加载应用页面, 执行内建自检并读取结果。
 * 用法: node cdp-driver.ts <pageUrl> <selftest|roundtrip>
 */
const pageUrl = process.argv[2];
const mode = process.argv[3] ?? 'selftest';

const list = await (await fetch('http://localhost:9222/json/new?' + encodeURIComponent(pageUrl), {
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
  ws.addEventListener('error', (e) => reject(e));
});
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
});

await send('Page.enable');
await send('Runtime.enable');
await new Promise((r) => setTimeout(r, 2500)); // 等模块加载与首帧

const expr =
  mode === 'roundtrip'
    ? `window.edgeBlendSelfTest.roundTrip().then(r => JSON.stringify(r))`
    : `Promise.resolve(JSON.stringify(window.edgeBlendSelfTest.attemptSelfIntersect()))`;
const res = (await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
})) as { result?: { value?: string; exceptionDetails?: unknown } };

console.log(res.result?.value ?? JSON.stringify(res));
ws.close();
process.exit(0);
