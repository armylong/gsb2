/* 阈值调整 + 重新检查链路的浏览器验证。
 * 启动结构与 browser_e2e.mjs 保持一致（已验证稳定），仅使用独立端口。
 * 用法：node tests/browser_reanalyze.mjs <chromePath> <baseUrl>
 */
import { spawn } from "node:child_process";
import http from "node:http";

const chromePath = process.argv[2];
const baseUrl = process.argv[3] || "http://127.0.0.1:8811/";
const port = 9336;

function getJson(path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(chromePath, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  `--remote-debugging-port=${port}`, "--window-size=1600,1000",
  "about:blank",
], { stdio: "ignore" });

let ws;
let msgId = 0;
const pending = new Map();

function cdp(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalInPage(expression) {
  const r = await cdp("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error("页面异常: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

(async () => {
  try {
    for (let i = 0; i < 40; i++) {
      try { await getJson("/json/version"); break; } catch { await sleep(250); }
    }
    const target = await getJson("/json/new?" + encodeURIComponent(baseUrl), "PUT");
    ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };

    await cdp("Page.enable");
    await cdp("Runtime.enable");
    await sleep(1500);

    await evalInPage("loadSample('sample_box.obj')");
    await sleep(1200);
    const before = await evalInPage("state.analysis.counts.stretch");

    await evalInPage("document.getElementById('threshold').value = '100'");
    await evalInPage("document.getElementById('btn-reanalyze').click()");
    await sleep(1200);
    const after = await evalInPage("state.analysis.counts.stretch");
    const th = await evalInPage("state.analysis.thresholds.stretch_anisotropy");
    const selReset = await evalInPage("state.selected.size === 0");

    console.log(`拉伸问题数: 阈值3 -> ${before} | 阈值100 -> ${after} | 报告阈值=${th}`);
    const ok = before > 0 && after === 0 && th === 100 && selReset;
    console.log(ok ? "PASS  重新检查阈值链路（含选中状态重置）" : "FAIL  重新检查阈值链路");
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error("阈值链路验证失败:", e.message);
    process.exit(2);
  } finally {
    try { ws?.close(); } catch {}
    chrome.kill();
  }
})();
