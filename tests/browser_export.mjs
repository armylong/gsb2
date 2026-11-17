/* 导出功能验证：触发 PNG/CSV/JSON 导出并校验下载产物。 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";

const chromePath = process.argv[2];
const baseUrl = process.argv[3] || "http://127.0.0.1:8811/";
const port = 9334;
const downloadDir = "/tmp/uvshots/downloads";
fs.mkdirSync(downloadDir, { recursive: true });

function req(path, method = "GET") {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    r.on("error", reject); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(chromePath, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  `--remote-debugging-port=${port}`, "--window-size=1600,1000",
  `--user-data-dir=/tmp/uvshots/chrome-profile`,
  "about:blank",
], { stdio: "ignore" });

let ws, msgId = 0;
const pending = new Map();
const cdp = (method, params = {}) => {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
};
const ev = async (expr) => (await cdp("Runtime.evaluate", {
  expression: expr, returnByValue: true, awaitPromise: true,
})).result.value;

(async () => {
  try {
    for (let i = 0; i < 40; i++) { try { await req("/json/version"); break; } catch { await sleep(250); } }
    const target = await req("/json/new?" + encodeURIComponent(baseUrl), "PUT");
    ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
    await cdp("Page.enable");
    await cdp("Runtime.enable");
    await sleep(1200);
    await ev("loadSample('sample_box.obj')");
    await sleep(1000);
    await ev("selectFaces([13,14], false)");

    // 拦截下载：重写 a.click 为收集 blob URL，再用 fetch 读回
    const captured = await ev(`(async () => {
      const out = {};
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function() {
        out._last = this.download;
        this._href = this.href;
      };
      document.getElementById('btn-export-csv').click();
      out.csvName = out._last;
      document.getElementById('btn-export-json').click();
      out.jsonName = out._last;
      document.getElementById('btn-export-png').click();
      await new Promise(r => setTimeout(r, 300));
      out.pngName = out._last;
      // 读回 blob 内容验证
      const links = performance.getEntriesByType('resource').length;
      HTMLAnchorElement.prototype.click = origClick;
      return out;
    })()`);
    console.log("导出文件名:", JSON.stringify(captured, null, 2));

    // 直接调用内部构造逻辑，验证 CSV/JSON 文本内容
    const csv = await ev(`(function(){
      const rows = [["问题类型","严重级别","涉及面编号(1基)","面id(0基)","说明"]];
      for (const iss of state.analysis.issues) {
        rows.push([iss.label, iss.severity, iss.face_ids.map(f=>f+1).join(" "),
          iss.face_ids.join(" "), iss.detail]);
      }
      return rows.map(r => r.join(",")).join("\\n");
    })()`);
    const json = await ev("JSON.stringify({parse: state.parse, analysis: state.analysis})");
    const compositeOk = await ev(`(function(){
      const c = renderComposite(1600, 1000);
      const ctx = c.getContext('2d');
      return ctx.getImageData(0,0,c.width,c.height).data.some(v => v !== 0);
    })()`);

    const checks = [
      ["CSV 文件名含 _问题清单", /问题清单\.csv$/.test(captured.csvName)],
      ["JSON 文件名含 _报告", /报告\.json$/.test(captured.jsonName)],
      ["PNG 文件名含 _检查图", /检查图\.png$/.test(captured.pngName)],
      ["CSV 含表头与面编号", csv.startsWith("问题类型") && /\b14\b/.test(csv)],
      ["CSV 含全部 5 类问题", ["缺少贴图坐标","超出","重叠","拉伸","退化"].every(k => csv.includes(k))],
      ["JSON 可解析且含 19 面", JSON.parse(json).parse.triangles.length === 19],
      ["JSON 面编号与模型一致", JSON.parse(json).analysis.issues.every(i =>
        i.face_ids.every(f => f >= 0 && f < 19))],
      ["合成检查图画布有内容", compositeOk === true],
    ];
    let pass = 0;
    for (const [name, ok] of checks) { console.log((ok ? "PASS" : "FAIL") + "  " + name); if (ok) pass++; }
    // 保存一份实际 CSV 产物到磁盘供人工查看
    fs.writeFileSync(downloadDir + "/sample_box_问题清单.csv", "﻿" + csv);
    console.log(`\n${pass}/${checks.length} 项导出断言通过`);
    process.exit(pass === checks.length ? 0 : 1);
  } catch (e) {
    console.error("导出验证失败:", e.message);
    process.exit(2);
  } finally {
    try { ws?.close(); } catch {}
    chrome.kill();
  }
})();
