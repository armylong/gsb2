/* UV 贴图坐标检查工具 — 前端双视图
 * 零依赖：3D 视图为自写软件渲染器（透视投影 + 画家算法 + 平面着色 + 点选），
 * 2D 视图为 Canvas 贴图/UV 编辑器，两视图通过 face id 共享选面状态。
 */
"use strict";

/* ================================================================ 常量 */
const ISSUE_COLORS = {
  missing_uv:      "#e07a5f",
  out_of_range:    "#f4a261",
  overlap:         "#c792ea",
  stretch:         "#e0c16f",
  uv_degenerate:   "#ff6b6b",
  mesh_degenerate: "#8d99ae",
};
const ISSUE_ORDER = ["missing_uv", "uv_degenerate", "out_of_range", "overlap", "stretch", "mesh_degenerate"];
const SELECT_COLOR = "#ffd166";
const NORMAL_FACE = "#7f8ea3";
const GRID_COLOR = "rgba(147,160,178,0.28)";
const BORDER_COLOR = "#5aa7ff";

/* ================================================================ 状态 */
const state = {
  parse: null,          // 后端 parse payload
  analysis: null,       // 后端 analysis payload
  textureImage: null,
  textureName: "",
  lastObjText: "",      // 最近一次载入的 OBJ 原文，供调整阈值后重新检查
  selected: new Set(),  // 选中的三角面 id（两视图共享）
  cam3d: { yaw: -0.6, pitch: 0.35, dist: 0, panX: 0, panY: 0, fov: 50, fitted: false },
  view2d: { scale: 60, ox: 0, oy: 0, fitted: false },
  options: { labels: true, grid: true, texBounds: true, issues: true },
};

const $ = (id) => document.getElementById(id);
const canvas3d = $("view-3d");
const canvas2d = $("view-2d");
const ctx3d = canvas3d.getContext("2d");
const ctx2d = canvas2d.getContext("2d");

/* ================================================================ 工具 */
function setStatus(text) { $("status-text").textContent = text; }

function faceIssueKinds(fid) {
  if (!state.analysis) return [];
  return state.analysis.triangle_issues[String(fid)] || [];
}
function faceMetrics(fid) {
  if (!state.analysis) return null;
  return state.analysis.triangle_metrics[String(fid)] || null;
}
function issueColor(fid, alpha = 0.55) {
  const kinds = faceIssueKinds(fid);
  for (const k of ISSUE_ORDER) {
    if (kinds.includes(k)) {
      const c = ISSUE_COLORS[k];
      return hexToRgba(c, alpha);
    }
  }
  return null;
}
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function fitCanvas(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(50, Math.round(rect.width));
  const h = Math.max(50, Math.round(rect.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}
function download(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime || "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ================================================================ 数据载入 */
async function postObj(text, filename, threshold) {
  const form = new FormData();
  form.append("file", new File([text], filename || "uploaded.obj", { type: "text/plain" }));
  const res = await fetch("/api/analyze?threshold=" + encodeURIComponent(threshold), {
    method: "POST", body: form,
  });
  if (!res.ok) throw new Error("分析接口返回 " + res.status);
  return res.json();
}

function applyReport(report) {
  state.parse = report.parse;
  state.analysis = report.analysis;
  state.selected.clear();
  state.cam3d.fitted = false;
  state.view2d.fitted = false;
  renderMessages();
  renderIssues();
  renderSelection();
  renderLegends();
  renderAll();
  const s = state.parse.stats;
  setStatus(`已载入 ${state.parse.source}：${s.triangle_count} 个三角面，` +
    `${state.analysis.issues.length} 条问题（${s.error_count} 解析错误 / ${s.warning_count} 警告）`);
}

async function loadSample(name) {
  setStatus("正在载入样例 " + name + " ...");
  const [objRes, texRes] = await Promise.all([
    fetch("/samples/" + name).then((r) => { if (!r.ok) throw new Error("样例 OBJ 不可用"); return r.text(); }),
    fetch("/samples/sample_texture.png").then((r) => r.ok ? r.blob() : null),
  ]);
  state.lastObjText = objRes;
  const report = await postObj(objRes, name, $("threshold").value);
  applyReport(report);
  if (texRes) loadTextureFromBlob(texRes, "sample_texture.png");
}

function loadTextureFromBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    state.textureImage = img;
    state.textureName = name || "贴图";
    setStatus(`贴图 ${state.textureName} 已载入（${img.naturalWidth}×${img.naturalHeight}）`);
    renderAll();
  };
  img.onerror = () => setStatus("贴图无法解码，已使用棋盘格占位");
  img.src = url;
}

/* ================================================================ 3D 渲染器 */
function modelBounds() {
  const vs = state.parse.vertices;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of vs) {
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], v[i]); max[i] = Math.max(max[i], v[i]); }
  }
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.max(0.001, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  return { min, max, center, radius };
}

function fitCamera3d(w, h) {
  const { center, radius } = modelBounds();
  state.cam3d.center = center;
  const fovRad = (state.cam3d.fov * Math.PI) / 180;
  state.cam3d.dist = radius / Math.sin(fovRad / 2) * 1.12;
  state.cam3d.panX = 0;
  state.cam3d.panY = 0;
  state.cam3d.fitted = true;
}

function rotatePoint(p, yaw, pitch) {
  // 先绕 Y（yaw），再绕 X（pitch）
  let [x, y, z] = p;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = cy * x + sy * z;
  const z1 = -sy * x + cy * z;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y2 = cp * y - sp * z1;
  const z2 = sp * y + cp * z1;
  return [x1, y2, z2];
}

function project3d() {
  const cam = state.cam3d;
  const { w, h } = fitCanvas(canvas3d, ctx3d);
  if (!cam.fitted) fitCamera3d(w, h);
  const fovRad = (cam.fov * Math.PI) / 180;
  const focal = h / (2 * Math.tan(fovRad / 2));
  const cx = w / 2 + cam.panX;
  const cy = h / 2 + cam.panY;
  const center = cam.center || modelBounds().center;

  const projected = state.parse.vertices.map((v) => {
    const rel = [v[0] - center[0], v[1] - center[1], v[2] - center[2]];
    const r = rotatePoint(rel, cam.yaw, cam.pitch);
    const zc = r[2] + cam.dist;
    const k = zc > 1e-4 ? focal / zc : focal / 1e-4;
    return { x: cx + r[0] * k, y: cy - r[1] * k, z: zc, rx: r[0], ry: r[1], rz: r[2] };
  });
  return { projected, w, h, focal, cx, cy };
}

function faceNormal3d(tri) {
  const p = state.parse.vertices;
  const a = p[tri.verts[0]], b = p[tri.verts[1]], c = p[tri.verts[2]];
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [e1[1] * e2[2] - e1[2] * e2[1],
             e1[2] * e2[0] - e1[0] * e2[2],
             e1[0] * e2[1] - e1[1] * e2[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
}

function render3d() {
  if (!state.parse) { drawEmpty(ctx3d, fitCanvas(canvas3d, ctx3d), "导入 OBJ 后在此显示三维模型"); return; }
  const { projected, w, h } = project3d();
  ctx3d.fillStyle = "#0f1319";
  ctx3d.fillRect(0, 0, w, h);

  const cam = state.cam3d;
  const lightDir = (() => {
    const l = rotatePoint([-0.4, 0.6, 0.9], cam.yaw, cam.pitch);
    const len = Math.hypot(...l) || 1;
    return [l[0] / len, l[1] / len, l[2] / len];
  })();

  const items = state.parse.triangles.map((tri) => {
    const pts = tri.verts.map((vi) => projected[vi]);
    const depth = (pts[0].z + pts[1].z + pts[2].z) / 3;
    const n = faceNormal3d(tri);
    const rn = rotatePoint(n, cam.yaw, cam.pitch);
    const facing = rn[2]; // 相机朝 -z，>0 朝向相机
    const shade = 0.55 + 0.45 * Math.max(0, -(rn[0] * lightDir[0] + rn[1] * lightDir[1] + rn[2] * lightDir[2]));
    return { tri, pts, depth, facing, shade };
  });
  items.sort((a, b) => b.depth - a.depth); // 画家算法：远的先画

  for (const it of items) {
    const { tri, pts, facing, shade } = it;
    const isSel = state.selected.has(tri.id);
    const tint = state.options.issues ? issueColor(tri.id, 0.62) : null;

    ctx3d.beginPath();
    ctx3d.moveTo(pts[0].x, pts[0].y);
    ctx3d.lineTo(pts[1].x, pts[1].y);
    ctx3d.lineTo(pts[2].x, pts[2].y);
    ctx3d.closePath();

    let fill;
    if (isSel) {
      fill = hexToRgba(SELECT_COLOR, 0.92);
    } else if (tint) {
      fill = tint;
    } else {
      const base = facing > 0 ? [127, 142, 163] : [78, 90, 108];
      fill = `rgba(${Math.round(base[0] * shade)},${Math.round(base[1] * shade)},${Math.round(base[2] * shade)},0.92)`;
    }
    ctx3d.fillStyle = fill;
    ctx3d.fill();

    ctx3d.lineWidth = isSel ? 1.8 : 0.7;
    ctx3d.strokeStyle = isSel ? SELECT_COLOR : "rgba(10,13,18,0.75)";
    ctx3d.stroke();
  }

  // 面编号（覆盖在最上层，避免被遮挡时难以辨认 -> 只给朝向相机的面画）
  if (state.options.labels) {
    ctx3d.font = "10px ui-monospace, Menlo, monospace";
    ctx3d.textAlign = "center";
    ctx3d.textBaseline = "middle";
    for (const it of items) {
      if (it.facing <= 0.02) continue;
      const mx = (it.pts[0].x + it.pts[1].x + it.pts[2].x) / 3;
      const my = (it.pts[0].y + it.pts[1].y + it.pts[2].y) / 3;
      const isSel = state.selected.has(it.tri.id);
      ctx3d.fillStyle = isSel ? "#1a1a1a" : "rgba(230,235,242,0.9)";
      ctx3d.fillText(String(it.tri.id + 1), mx, my);
    }
  }
}

/* 3D 点选：屏幕坐标 -> 取投影后包含该点且最靠近相机的面 */
function pick3d(mx, my) {
  const { projected } = project3d();
  let best = null;
  for (const tri of state.parse.triangles) {
    const pts = tri.verts.map((vi) => projected[vi]);
    if (!pointInTriangle2d(mx, my, pts[0], pts[1], pts[2])) continue;
    const depth = (pts[0].z + pts[1].z + pts[2].z) / 3;
    if (best === null || depth < best.depth) best = { id: tri.id, depth };
  }
  return best ? best.id : null;
}

/* ================================================================ 2D UV 视图 */
function uvBounds() {
  const min = [0, 0], max = [1, 1]; // 至少包含贴图范围 [0,1]
  if (state.parse && state.parse.uvs.length) {
    for (const [u, v] of state.parse.uvs) {
      min[0] = Math.min(min[0], u); min[1] = Math.min(min[1], v);
      max[0] = Math.max(max[0], u); max[1] = Math.max(max[1], v);
    }
  }
  return { min, max, spanU: max[0] - min[0] || 1, spanV: max[1] - min[1] || 1 };
}

function fitView2d(w, h) {
  // 初始以贴图 [0,1] 正方形区域为主（占短边的 70%），
  // 越界 UV 仍可通过平移/缩放查看，但不会把正常贴图区域挤得过小。
  const target = Math.min(w, h) * 0.7;
  state.view2d.scale = target; // UV 单位长度对应的像素
  state.view2d.ox = w / 2 - 0.5 * state.view2d.scale;
  state.view2d.oy = h / 2 + 0.5 * state.view2d.scale;
  state.view2d.fitted = true;
}
const uvToScreen = (u, v) => ({
  x: state.view2d.ox + u * state.view2d.scale,
  y: state.view2d.oy - v * state.view2d.scale,
});
const screenToUv = (x, y) => ({
  u: (x - state.view2d.ox) / state.view2d.scale,
  v: (state.view2d.oy - y) / state.view2d.scale,
});

function drawCheckerPlaceholder(ctx, x, y, w, h) {
  const n = 8;
  const cw = w / n, ch = h / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      ctx.fillStyle = (i + j) % 2 ? "#2a3342" : "#222a37";
      ctx.fillRect(x + i * cw, y + j * ch, Math.ceil(cw), Math.ceil(ch));
    }
  }
}

function render2d() {
  const { w, h } = fitCanvas(canvas2d, ctx2d);
  ctx2d.fillStyle = "#0f1319";
  ctx2d.fillRect(0, 0, w, h);
  if (!state.parse) { drawEmpty(ctx2d, { w, h }, "导入 OBJ 后在此显示贴图与 UV 区域"); return; }
  if (!state.view2d.fitted) fitView2d(w, h);

  const tl = uvToScreen(0, 1);
  const br = uvToScreen(1, 0);
  const texW = br.x - tl.x, texH = br.y - tl.y;

  // 贴图本体（没有贴图时画棋盘格占位）
  if (state.textureImage) {
    ctx2d.imageSmoothingEnabled = false;
    ctx2d.globalAlpha = 0.95;
    ctx2d.drawImage(state.textureImage, tl.x, tl.y, texW, texH);
    ctx2d.globalAlpha = 1;
  } else {
    drawCheckerPlaceholder(ctx2d, tl.x, tl.y, Math.max(2, texW), Math.max(2, texH));
    ctx2d.fillStyle = "rgba(147,160,178,0.75)";
    ctx2d.font = "12px sans-serif";
    ctx2d.textAlign = "center";
    ctx2d.fillText("未导入贴图（棋盘格占位）", tl.x + texW / 2, tl.y + 18);
  }

  // 坐标网格（按当前缩放自适应步长，1、0.5、0.25、0.125...）
  if (state.options.grid) {
    let step = 1;
    while (step * state.view2d.scale < 80) step /= 2;
    const showLabels = step * state.view2d.scale >= 48;
    ctx2d.lineWidth = 1;
    ctx2d.font = "9.5px ui-monospace, Menlo, monospace";
    ctx2d.textAlign = "left";
    ctx2d.textBaseline = "top";
    const viewMin = screenToUv(0, h), viewMax = screenToUv(w, 0);
    const fmt = (x) => x.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    const startU = Math.floor(viewMin.u / step) * step;
    for (let u = startU; u <= viewMax.u + 1e-9; u += step) {
      const p = uvToScreen(u, 0);
      const onBorder = Math.abs(u - Math.round(u)) < 1e-9;
      ctx2d.strokeStyle = onBorder ? "rgba(90,167,255,0.45)" : GRID_COLOR;
      ctx2d.beginPath(); ctx2d.moveTo(p.x, 0); ctx2d.lineTo(p.x, h); ctx2d.stroke();
      if (showLabels && p.x > 2 && p.x < w - 34) {
        ctx2d.fillStyle = "rgba(147,160,178,0.85)";
        ctx2d.fillText(fmt(u), p.x + 2, 4);
      }
    }
    const startV = Math.floor(viewMin.v / step) * step;
    for (let v = startV; v <= viewMax.v + 1e-9; v += step) {
      const p = uvToScreen(0, v);
      const onBorder = Math.abs(v - Math.round(v)) < 1e-9;
      ctx2d.strokeStyle = onBorder ? "rgba(90,167,255,0.45)" : GRID_COLOR;
      ctx2d.beginPath(); ctx2d.moveTo(0, p.y); ctx2d.lineTo(w, p.y); ctx2d.stroke();
      if (showLabels && p.y > 14 && p.y < h - 14) {
        ctx2d.fillStyle = "rgba(147,160,178,0.85)";
        ctx2d.fillText(fmt(v), 4, p.y + 2);
      }
    }
  }

  // 贴图边界 [0,1]
  if (state.options.texBounds) {
    ctx2d.strokeStyle = BORDER_COLOR;
    ctx2d.lineWidth = 2;
    ctx2d.strokeRect(tl.x, tl.y, texW, texH);
    ctx2d.fillStyle = BORDER_COLOR;
    ctx2d.font = "11px sans-serif";
    ctx2d.textAlign = "left";
    ctx2d.fillText("贴图区域 (0,0)→(1,1)", tl.x + 4, tl.y + 4);
  }

  // UV 三角形
  for (const tri of state.parse.triangles) {
    if (tri.uvs === null) continue; // 缺 UV 的面在二维视图无区域
    const pts = tri.uvs.map((ui) => {
      const [u, v] = state.parse.uvs[ui];
      return uvToScreen(u, v);
    });
    const isSel = state.selected.has(tri.id);
    const tint = state.options.issues ? issueColor(tri.id, 0.5) : null;
    ctx2d.beginPath();
    ctx2d.moveTo(pts[0].x, pts[0].y);
    ctx2d.lineTo(pts[1].x, pts[1].y);
    ctx2d.lineTo(pts[2].x, pts[2].y);
    ctx2d.closePath();
    ctx2d.fillStyle = isSel ? hexToRgba(SELECT_COLOR, 0.72) : (tint || "rgba(127,142,163,0.28)");
    ctx2d.fill();
    ctx2d.lineWidth = isSel ? 2 : 0.9;
    ctx2d.strokeStyle = isSel ? SELECT_COLOR : "rgba(230,235,242,0.55)";
    ctx2d.stroke();

    if (state.options.labels) {
      const mx = (pts[0].x + pts[1].x + pts[2].x) / 3;
      const my = (pts[0].y + pts[1].y + pts[2].y) / 3;
      ctx2d.font = "9.5px ui-monospace, Menlo, monospace";
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "middle";
      ctx2d.fillStyle = isSel ? "#1a1a1a" : "rgba(230,235,242,0.92)";
      ctx2d.fillText(String(tri.id + 1), mx, my);
    }
  }
}

/* 2D 点选：命中屏幕点所在的、屏幕面积最小（最上层/最精确）的 UV 三角形 */
function pick2d(mx, my) {
  let best = null;
  for (const tri of state.parse.triangles) {
    if (tri.uvs === null) continue;
    const pts = tri.uvs.map((ui) => {
      const [u, v] = state.parse.uvs[ui];
      return uvToScreen(u, v);
    });
    if (!pointInTriangle2d(mx, my, pts[0], pts[1], pts[2])) continue;
    const area = Math.abs(
      (pts[1].x - pts[0].x) * (pts[2].y - pts[0].y) -
      (pts[2].x - pts[0].x) * (pts[1].y - pts[0].y));
    if (best === null || area < best.area) best = { id: tri.id, area };
  }
  return best ? best.id : null;
}

function pointInTriangle2d(px, py, a, b, c) {
  const d1 = (px - b.x) * (a.y - b.y) - (a.x - b.x) * (py - b.y);
  const d2 = (px - c.x) * (b.y - c.y) - (b.x - c.x) * (py - c.y);
  const d3 = (px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function drawEmpty(ctx, size, text) {
  ctx.fillStyle = "#0f1319";
  ctx.fillRect(0, 0, size.w, size.h);
  ctx.fillStyle = "#5c6878";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, size.w / 2, size.h / 2);
}

/* ================================================================ 面板渲染 */
function renderMessages() {
  const box = $("messages");
  if (!state.parse) { box.innerHTML = '<p class="placeholder">尚未载入模型</p>'; return; }
  const msgs = state.parse.messages;
  if (!msgs.length) { box.innerHTML = '<p class="placeholder">无解析问题 ✅</p>'; return; }
  box.innerHTML = msgs.map((m) => `
    <div class="msg-item ${m.level}">
      <div><b>${m.level === "error" ? "错误" : "警告"}</b>${m.line ? ` · 第 ${m.line} 行` : " · 文件级"}</div>
      <div class="msg-line">${esc(m.message)}</div>
    </div>`).join("");
}

function renderIssues() {
  const box = $("issues");
  const summary = $("issue-summary");
  if (!state.analysis) { box.innerHTML = '<p class="placeholder">尚未载入模型</p>'; summary.textContent = ""; return; }
  const issues = state.analysis.issues;
  const counts = state.analysis.counts;
  const totalFaces = new Set(issues.flatMap((i) => i.face_ids)).size;
  summary.textContent = `${issues.length} 条 / 涉及 ${totalFaces} 面`;
  if (!issues.length) { box.innerHTML = '<p class="placeholder">未发现 UV 问题 ✅</p>'; return; }

  // 按类型分组，类型内按面号
  const groups = {};
  for (const iss of issues) (groups[iss.type] ||= []).push(iss);
  const html = ISSUE_ORDER.filter((k) => groups[k]).map((kind) => {
    const list = groups[kind];
    const ids = [...new Set(list.flatMap((i) => i.face_ids))].sort((a, b) => a - b);
    const meta = state.analysis.issue_meta[kind];
    return `
      <div class="issue-group">
        <button class="issue-head" data-select='${JSON.stringify(ids)}'>
          <span>${esc(meta.label)}（${list.length} 条）</span>
          <span class="issue-badge ${meta.severity}">${meta.severity === "error" ? "错误" : "警告"}</span>
        </button>
        <div class="issue-detail">
          <div>${esc(list[0].detail)}${list.length > 1 ? " 等" : ""}</div>
          <div>${ids.map((f) => `<span class="face-chip" data-face="${f}">${f + 1}</span>`).join("")}</div>
        </div>
      </div>`;
  }).join("");
  box.innerHTML = html;

  box.querySelectorAll(".issue-head").forEach((btn) => {
    btn.addEventListener("click", () => selectFaces(JSON.parse(btn.dataset.select), true));
  });
  box.querySelectorAll(".face-chip").forEach((chip) => {
    chip.addEventListener("click", () => selectFaces([Number(chip.dataset.face)], true));
  });
}

function renderSelection() {
  const box = $("selection");
  if (!state.parse) { box.innerHTML = '<p class="placeholder">未选中任何面</p>'; return; }
  if (!state.selected.size) { box.innerHTML = '<p class="placeholder">未选中任何面</p>'; return; }
  const ids = [...state.selected].sort((a, b) => a - b);
  box.innerHTML = ids.map((fid) => {
    const tri = state.parse.triangles[fid];
    const kinds = faceIssueKinds(fid);
    const m = faceMetrics(fid);
    const uvText = tri.uvs === null
      ? "<b>无贴图坐标</b>"
      : tri.uvs.map((ui) => {
          const [u, v] = state.parse.uvs[ui];
          return `(${u.toFixed(4)}, ${v.toFixed(4)})`;
        }).join(" ");
    return `
      <div class="sel-row">
        <div class="sel-title">面 #${fid + 1} <span style="color:var(--muted);font-weight:400">（源 f 语句 #${tri.source_face + 1}）</span></div>
        <div class="kv">顶点索引: <b>${tri.verts.map((v) => v + 1).join(", ")}</b></div>
        <div class="kv">UV: ${uvText}</div>
        ${m ? `<div class="kv">三维面积: <b>${m.area_3d.toExponential(3)}</b> ·
          UV 面积: <b>${m.area_uv === null ? "—" : m.area_uv.toExponential(3)}</b>${
            m.anisotropy === null || m.anisotropy === undefined ? "" :
            ` · 各向异性: <b>${m.anisotropy.toFixed(2)}</b>`}</div>` : ""}
        ${kinds.length ? `<div class="kv">问题: ${kinds.map((k) =>
          `<span style="color:${ISSUE_COLORS[k]}">●</span> ${esc(state.analysis.issue_meta[k].label)}`).join("；")}</div>`
          : '<div class="kv">问题: 无</div>'}
      </div>`;
  }).join("");
}

function renderLegends() {
  const items = [
    ["#ffd166", "当前选中"],
    ...ISSUE_ORDER.map((k) => [ISSUE_COLORS[k], state.analysis ? state.analysis.issue_meta[k].label : k]),
    ["#7f8ea3", "正常面"],
  ];
  const html = items.map(([c, t]) =>
    `<span class="item"><span class="swatch" style="background:${c}"></span>${esc(t)}</span>`).join("");
  $("legend-3d").innerHTML = html;
  $("legend-2d").innerHTML = html;
}

/* ================================================================ 联动选择 */
function selectFaces(ids, reveal) {
  state.selected = new Set(ids);
  renderSelection();
  renderAll();
  if (reveal) {
    setStatus(`已定位面 ${[...state.selected].map((i) => i + 1).join(", ")}（双视图同步高亮）`);
  }
}

/* ================================================================ 交互：3D */
let drag3d = null;
canvas3d.addEventListener("mousedown", (e) => {
  if (!state.parse) return;
  canvas3d.setPointerCapture(e.pointerId);
  drag3d = { x: e.clientX, y: e.clientY, button: e.button, moved: false };
});
canvas3d.addEventListener("mousemove", (e) => {
  if (!drag3d) return;
  const dx = e.clientX - drag3d.x, dy = e.clientY - drag3d.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag3d.moved = true;
  if (drag3d.button === 2) {
    state.cam3d.panX += dx; state.cam3d.panY += dy;
  } else {
    state.cam3d.yaw += dx * 0.008;
    state.cam3d.pitch = Math.max(-1.55, Math.min(1.55, state.cam3d.pitch + dy * 0.008));
  }
  drag3d.x = e.clientX; drag3d.y = e.clientY;
  render3d();
});
canvas3d.addEventListener("mouseup", (e) => {
  if (!drag3d) return;
  const wasClick = !drag3d.moved;
  drag3d = null;
  if (!state.parse || !wasClick) return;
  const rect = canvas3d.getBoundingClientRect();
  const id = pick3d(e.clientX - rect.left, e.clientY - rect.top);
  if (id === null) {
    if (!e.shiftKey) selectFaces([], false);
  } else if (e.shiftKey) {
    const next = new Set(state.selected);
    next.has(id) ? next.delete(id) : next.add(id);
    selectFaces([...next], false);
  } else {
    selectFaces([id], true);
  }
});
canvas3d.addEventListener("contextmenu", (e) => e.preventDefault());
canvas3d.addEventListener("wheel", (e) => {
  if (!state.parse) return;
  e.preventDefault();
  const factor = e.deltaY > 0 ? 1.1 : 0.9;
  state.cam3d.dist = Math.max(1e-3, state.cam3d.dist * factor);
  render3d();
}, { passive: false });
canvas3d.addEventListener("dblclick", () => {
  if (!state.parse) return;
  state.cam3d.fitted = false;
  render3d();
});

/* ================================================================ 交互：2D */
let drag2d = null;
canvas2d.addEventListener("mousedown", (e) => {
  if (!state.parse) return;
  canvas2d.setPointerCapture(e.pointerId);
  drag2d = { x: e.clientX, y: e.clientY, ox: state.view2d.ox, oy: state.view2d.oy, moved: false };
});
canvas2d.addEventListener("mousemove", (e) => {
  if (!drag2d) return;
  const dx = e.clientX - drag2d.x, dy = e.clientY - drag2d.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag2d.moved = true;
  state.view2d.ox = drag2d.ox + dx;
  state.view2d.oy = drag2d.oy + dy;
  render2d();
});
canvas2d.addEventListener("mouseup", (e) => {
  if (!drag2d) return;
  const wasClick = !drag2d.moved;
  drag2d = null;
  if (!state.parse || !wasClick) return;
  const rect = canvas2d.getBoundingClientRect();
  const id = pick2d(e.clientX - rect.left, e.clientY - rect.top);
  if (id === null) {
    if (!e.shiftKey) selectFaces([], false);
  } else if (e.shiftKey) {
    const next = new Set(state.selected);
    next.has(id) ? next.delete(id) : next.add(id);
    selectFaces([...next], false);
  } else {
    selectFaces([id], true);
  }
});
canvas2d.addEventListener("wheel", (e) => {
  if (!state.parse) return;
  e.preventDefault();
  const rect = canvas2d.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const before = screenToUv(mx, my);
  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  state.view2d.scale = Math.max(2, state.view2d.scale * factor);
  // 以鼠标位置为缩放中心
  state.view2d.ox = mx - before.u * state.view2d.scale;
  state.view2d.oy = my + before.v * state.view2d.scale;
  render2d();
}, { passive: false });
canvas2d.addEventListener("dblclick", () => {
  if (!state.parse) return;
  state.view2d.fitted = false;
  render2d();
});

/* ================================================================ 控件 */
$("btn-sample-box").addEventListener("click", () => loadSample("sample_box.obj").catch((e) => setStatus("载入失败: " + e.message)));
$("btn-sample-broken").addEventListener("click", () => loadSample("sample_broken.obj").catch((e) => setStatus("载入失败: " + e.message)));

$("file-obj").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    state.lastObjText = text;
    const report = await postObj(text, file.name, $("threshold").value);
    applyReport(report);
  } catch (err) {
    setStatus("OBJ 导入失败: " + err.message);
  }
  e.target.value = "";
});
$("file-tex").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) loadTextureFromBlob(file, file.name);
  e.target.value = "";
});

$("btn-reanalyze").addEventListener("click", async () => {
  if (!state.parse) { setStatus("请先导入 OBJ"); return; }
  if (!state.lastObjText) { setStatus("缺少原始 OBJ 文本，请重新导入后再检查"); return; }
  try {
    const report = await postObj(state.lastObjText, state.parse.source, $("threshold").value);
    applyReport(report);
    setStatus(`已按阈值 ${$("threshold").value} 重新检查`);
  } catch (err) {
    setStatus("重新检查失败: " + err.message);
  }
});

for (const [id, key] of [["chk-labels", "labels"], ["chk-grid", "grid"],
                         ["chk-texbounds", "texBounds"], ["chk-issues", "issues"]]) {
  $(id).addEventListener("change", () => {
    state.options[key] = $(id).checked;
    renderAll();
  });
}
$("btn-fit").addEventListener("click", () => {
  if (!state.parse) return;
  state.cam3d.fitted = false;
  state.view2d.fitted = false;
  renderAll();
});

/* ================================================================ 导出 */
function renderComposite(width, height) {
  const off = document.createElement("canvas");
  off.width = width; off.height = height;
  const c = off.getContext("2d");
  c.fillStyle = "#14181f";
  c.fillRect(0, 0, width, height);
  const pad = 16, headH = 30;
  const paneW = (width - pad * 3) / 2;
  const paneH = height - pad * 2 - headH - 150;

  // 复用渲染：把两个视图临时画到离屏画布，再拷贝
  for (const [title, src, x] of [["三维模型视图", canvas3d, pad], ["二维贴图 / UV 视图", canvas2d, pad * 2 + paneW]]) {
    c.fillStyle = "#1c222c";
    c.fillRect(x, pad, paneW, paneH + headH);
    c.fillStyle = "#e6ebf2";
    c.font = "bold 14px sans-serif";
    c.textAlign = "left";
    c.fillText(title, x + 12, pad + 20);
    c.drawImage(src, x, pad + headH, paneW, paneH);
  }

  // 底部问题摘要
  const y0 = pad * 2 + headH + paneH;
  c.fillStyle = "#1c222c";
  c.fillRect(pad, y0, width - pad * 2, 140);
  c.fillStyle = "#e6ebf2";
  c.font = "bold 13px sans-serif";
  c.fillText(`模型: ${state.parse.source} · 三角面 ${state.parse.stats.triangle_count} · ` +
    `问题 ${state.analysis.issues.length} 条 · 拉伸阈值 ${state.analysis.thresholds.stretch_anisotropy}`,
    pad + 12, y0 + 22);
  c.font = "12px sans-serif";
  let yy = y0 + 44;
  const counts = state.analysis.counts;
  c.fillStyle = "#93a0b2";
  c.fillText(Object.entries(counts).filter(([, n]) => n).map(([k, n]) =>
    `${state.analysis.issue_meta[k].label}: ${n}`).join("    ") || "无问题", pad + 12, yy);
  yy += 22;
  for (const iss of state.analysis.issues.slice(0, 3)) {
    c.fillStyle = iss.severity === "error" ? "#e07a5f" : "#e0c16f";
    const line = `[${iss.label}] 面 ${iss.face_ids.map((f) => f + 1).join(",")} — ${iss.detail}`;
    c.fillText(line.length > 130 ? line.slice(0, 128) + "…" : line, pad + 12, yy);
    yy += 20;
  }
  return off;
}

$("btn-export-png").addEventListener("click", () => {
  if (!state.parse) { setStatus("没有可导出的模型"); return; }
  const off = renderComposite(1600, 1000);
  off.toBlob((blob) => {
    const base = state.parse.source.replace(/\.[^.]+$/, "") || "uvcheck";
    download(base + "_检查图.png", blob, "image/png");
    setStatus("检查图已导出（面编号与当前模型一致）");
  }, "image/png");
});

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

$("btn-export-csv").addEventListener("click", () => {
  if (!state.parse) { setStatus("没有可导出的模型"); return; }
  const rows = [["问题类型", "严重级别", "涉及面编号(1基)", "面id(0基)", "说明"]];
  for (const iss of state.analysis.issues) {
    rows.push([
      iss.label,
      iss.severity === "error" ? "错误" : "警告",
      iss.face_ids.map((f) => f + 1).join(" "),
      iss.face_ids.join(" "),
      iss.detail,
    ]);
  }
  // 附带解析消息
  for (const m of state.parse.messages) {
    rows.push(["解析" + (m.level === "error" ? "错误" : "警告"),
      m.level === "error" ? "错误" : "警告", "", "",
      (m.line ? `第${m.line}行: ` : "") + m.message]);
  }
  const csv = "﻿" + rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
  const base = state.parse.source.replace(/\.[^.]+$/, "") || "uvcheck";
  download(base + "_问题清单.csv", csv, "text/csv;charset=utf-8");
  setStatus("问题清单 CSV 已导出");
});

$("btn-export-json").addEventListener("click", () => {
  if (!state.parse) { setStatus("没有可导出的模型"); return; }
  const payload = {
    exported_at: new Date().toISOString(),
    parse: state.parse,
    analysis: state.analysis,
    texture: state.textureName || null,
  };
  const base = state.parse.source.replace(/\.[^.]+$/, "") || "uvcheck";
  download(base + "_报告.json", JSON.stringify(payload, null, 2), "application/json");
  setStatus("JSON 报告已导出");
});

/* ================================================================ 渲染调度 */
function renderAll() {
  render3d();
  render2d();
}
window.addEventListener("resize", renderAll);

// 初始空视图 + 图例骨架
renderLegends();
renderAll();
