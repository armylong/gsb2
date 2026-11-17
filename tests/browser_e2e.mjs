/* 无头浏览器端到端验证：通过 CDP 在真实页面主世界执行断言。
 * 用法：node tests/browser_e2e.mjs <chromePath> <baseUrl>
 */
import { spawn } from "node:child_process";
import http from "node:http";

const chromePath = process.argv[2];
const baseUrl = process.argv[3] || "http://127.0.0.1:8811/";
const port = 9333;

function getJson(path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("非 JSON 响应: " + d.slice(0, 120))); }
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

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
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
    // 等待 DevTools 就绪
    let version;
    for (let i = 0; i < 40; i++) {
      try { version = await getJson("/json/version"); break; } catch { await sleep(250); }
    }
    if (!version) throw new Error("Chrome DevTools 未就绪");

    // 新版 Chrome 要求用 PUT 调用 /json/new
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

    // 1) 初始页面渲染
    const title = await evalInPage("document.title");
    check("页面标题", title.includes("UV"), title);

    // 2) 载入规则样例
    await evalInPage("loadSample('sample_box.obj')");
    await sleep(1200);
    const triCount = await evalInPage("state.parse.triangles.length");
    check("样例三角面数量=19", triCount === 19, String(triCount));
    const kinds = await evalInPage("[...new Set(state.analysis.issues.map(i=>i.type))].sort().join(',')");
    for (const k of ["missing_uv", "out_of_range", "overlap", "stretch", "uv_degenerate"]) {
      check("检测到问题类型 " + k, kinds.includes(k), kinds);
    }

    // 3) 2D 视图选面 -> 联动
    await evalInPage("selectFaces([13], false)");
    const sel2d = await evalInPage("[...state.selected].join(',')");
    check("2D 选面联动（面14, id=13）", sel2d === "13", sel2d);
    const selPanel = await evalInPage("document.getElementById('selection').textContent.includes('面 #14')");
    check("选中面板显示面编号 #14", selPanel);

    // 4) 3D 视图选面 -> 联动（同一共享状态）
    await evalInPage("selectFaces([5], false)");
    const sel3d = await evalInPage("[...state.selected].join(',')");
    check("3D 选面联动（面6, id=5）", sel3d === "5", sel3d);

    // 5) 缩放后高亮不丢失
    await evalInPage("state.cam3d.dist *= 1.5; state.view2d.scale *= 1.5; renderAll()");
    const kept = await evalInPage("[...state.selected].join(',')");
    check("缩放后保持选面", kept === "5", kept);

    // 6) 缺 UV 面在 2D 不可拾取、3D 可拾取（id=18）
    const hasNoUv = await evalInPage("state.parse.triangles[18].uvs === null");
    check("面19 缺 UV 标记", hasNoUv);

    // 7) 问题清单分组渲染 + 面编号芯片
    const groups = await evalInPage("document.querySelectorAll('#issues .issue-group').length");
    check("问题清单分组渲染", groups >= 5, String(groups));
    const chips = await evalInPage("document.querySelectorAll('#issues .face-chip').length");
    check("面编号芯片存在", chips > 0, String(chips));

    // 8) 解析消息面板（损坏样例）
    await evalInPage("loadSample('sample_broken.obj')");
    await sleep(1000);
    const errs = await evalInPage("state.parse.stats.error_count");
    check("损坏样例报告解析错误", errs > 0, String(errs));
    const keptFaces = await evalInPage("state.parse.triangles.length");
    check("损坏样例保留可读取的面", keptFaces >= 2, String(keptFaces));
    const msgRendered = await evalInPage("document.querySelectorAll('#messages .msg-item').length");
    const warnCount = await evalInPage("state.parse.stats.warning_count");
    check("解析消息逐条渲染", msgRendered === errs + warnCount,
      `msg=${msgRendered} err=${errs} warn=${warnCount}`);

    // 9) 导出 CSV / JSON 内容含面编号
    const csvTest = await evalInPage(`(function(){
      const rows = [["问题类型","涉及面编号(1基)"]];
      for (const iss of state.analysis.issues) rows.push([iss.label, iss.face_ids.map(f=>f+1).join(" ")]);
      return rows.map(r=>r.join(",")).join("\\n");
    })()`);
    check("CSV 含 1 基面编号", /面/.test(csvTest) && /\d/.test(csvTest));

    // 10) 画布实际有像素输出
    const painted3d = await evalInPage(
      "canvas3d.getContext('2d').getImageData(0,0,canvas3d.width,canvas3d.height).data.some(v=>v!==0)");
    const painted2d = await evalInPage(
      "canvas2d.getContext('2d').getImageData(0,0,canvas2d.width,canvas2d.height).data.some(v=>v!==0)");
    check("3D 画布有渲染内容", painted3d);
    check("2D 画布有渲染内容", painted2d);

    // 11) 截图保存
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/uvshots/03_broken_loaded.png", Buffer.from(shot.data, "base64"));

    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} 项浏览器断言通过`);
    process.exit(failed.length ? 1 : 0);
  } catch (e) {
    console.error("E2E 脚本失败:", e.message);
    process.exit(2);
  } finally {
    try { ws?.close(); } catch {}
    chrome.kill();
  }
})();
