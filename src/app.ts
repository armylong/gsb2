// app.ts — Canvas 交互界面：编辑闭合三次曲线、调偏移距离与精度、
// 显示原轮廓 / 原始偏移 / 自交点 / 清理后有效轮廓 / 可抽查法线及误差。

import {
  Vec, Sample, OffsetResult, PolylineIndex,
  add, mul, dist, rightNormal, leftNormal, signedArea, sampleSpline, cleanOffset, raySegT,
} from "./geom.js";
import { Node, toSegs, circleNodes, hourglassNodes } from "./presets.js";

const cv = document.getElementById("cv") as HTMLCanvasElement;
const ctx = cv.getContext("2d")!;
const statsEl = document.getElementById("stats") as HTMLDivElement;

const state = {
  nodes: hourglassNodes() as Node[],
  d: 40,
  tol: 0.25,
  normalCount: 24,
  showOriginal: true,
  showCtrl: true,
  showRaw: true,
  showClean: true,
  showInts: true,
  showNormals: true,
  circleR: 0, // >0 表示当前仍是未修改的圆形预设（可做解析误差对比）
};

// ---------------------------------------------------------------- 计算

interface NormalCheck {
  from: Vec;
  to: Vec;        // 原始偏移终点
  hit: Vec | null; // 与有效轮廓的交点（被裁剪则为 null）
  measured: number | null;
}

interface Computed {
  samples: Sample[];
  origPts: Vec[];
  raw: Vec[];
  result: OffsetResult;
  maxDev: number;       // 有效轮廓到原轮廓距离与 |d| 的最大偏差
  normals: NormalCheck[];
  circleErr: number | null;
}

let comp: Computed;

function outwardNormal(orient: number, tan: Vec): Vec {
  return orient > 0 ? rightNormal(tan) : leftNormal(tan);
}

function recompute(): void {
  const segs = toSegs(state.nodes);
  const samples = sampleSpline(segs, state.tol);
  const origPts = samples.map((s) => s.p);
  const orient = Math.sign(signedArea(origPts)) || 1;
  const raw = samples.map((s) => add(s.p, mul(outwardNormal(orient, s.tan), state.d)));
  const result = cleanOffset(raw, origPts, state.d, state.tol, orient);

  const index = new PolylineIndex(origPts);
  let maxDev = 0;
  for (const loop of result.loops) {
    for (const p of loop) {
      maxDev = Math.max(maxDev, Math.abs(index.dist(p) - Math.abs(state.d)));
    }
  }

  // 抽查法线：从原轮廓沿法线发出，量到“清理后的有效轮廓”的实测距离
  const normals: NormalCheck[] = [];
  if (state.d !== 0 && state.normalCount > 0) {
    const ad = Math.abs(state.d);
    const maxT = ad + Math.max(4 * state.tol, 3);
    for (let k = 0; k < state.normalCount; k++) {
      const s = samples[Math.floor((k * samples.length) / state.normalCount)];
      const n = outwardNormal(orient, s.tan);
      const dir = mul(n, Math.sign(state.d));
      const to = add(s.p, mul(n, state.d));
      let best: number | null = null;
      for (const loop of result.loops) {
        for (let i = 0; i < loop.length; i++) {
          const t = raySegT(s.p, dir, loop[i], loop[(i + 1) % loop.length]);
          if (t !== null && t > 1e-6 && t <= maxT && (best === null || t < best)) best = t;
        }
      }
      normals.push({
        from: s.p,
        to,
        hit: best === null ? null : add(s.p, mul(dir, best)),
        measured: best,
      });
    }
  }

  let circleErr: number | null = null;
  if (state.circleR > 0 && result.loops.length > 0) {
    const expected = state.circleR + state.d;
    if (expected > 0) {
      let e = 0;
      for (const loop of result.loops) {
        for (const p of loop) e = Math.max(e, Math.abs(Math.hypot(p.x, p.y) - expected));
      }
      circleErr = e;
    }
  }

  comp = { samples, origPts, raw, result, maxDev, normals, circleErr };
  updateStats();
}

// ---------------------------------------------------------------- 绘制

let CW = 0, CH = 0;

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  CW = cv.clientWidth;
  CH = cv.clientHeight;
  cv.width = Math.round(CW * dpr);
  cv.height = Math.round(CH * dpr);
  draw();
}

function polyline(pts: Vec[], close: boolean): void {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (close) ctx.closePath();
}

function draw(): void {
  if (!comp) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, CW, CH);
  ctx.save();
  ctx.translate(CW / 2, CH / 2);

  // 有效轮廓填充（垫底）
  if (state.showClean) {
    for (const loop of comp.result.loops) {
      if (loop.length < 3) continue;
      polyline(loop, true);
      ctx.fillStyle = "rgba(125,255,154,0.08)";
      ctx.fill();
    }
  }

  // 原轮廓（真实贝塞尔，非采样折线）
  if (state.showOriginal) {
    const nd = state.nodes;
    ctx.beginPath();
    ctx.moveTo(nd[0].a.x, nd[0].a.y);
    for (let i = 0; i < nd.length; i++) {
      const nx = nd[(i + 1) % nd.length];
      ctx.bezierCurveTo(nd[i].out.x, nd[i].out.y, nx.inn.x, nx.inn.y, nx.a.x, nx.a.y);
    }
    ctx.closePath();
    ctx.strokeStyle = "#9ecbff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 原始偏移（未清理，可能自交）
  if (state.showRaw && state.d !== 0 && comp.raw.length > 2) {
    polyline(comp.raw, true);
    ctx.strokeStyle = "rgba(255,90,90,0.55)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 清理后的有效轮廓
  if (state.showClean) {
    for (const loop of comp.result.loops) {
      if (loop.length < 3) continue;
      polyline(loop, true);
      ctx.strokeStyle = "#7dff9a";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  // 抽查法线
  if (state.showNormals) {
    ctx.font = "10px ui-monospace, monospace";
    for (const nm of comp.normals) {
      if (nm.hit && nm.measured !== null) {
        const dev = Math.abs(nm.measured - Math.abs(state.d));
        const ok = dev <= Math.max(2 * state.tol, 1);
        ctx.strokeStyle = ok ? "rgba(180,180,180,0.8)" : "#ffb347";
        ctx.beginPath();
        ctx.moveTo(nm.from.x, nm.from.y);
        ctx.lineTo(nm.hit.x, nm.hit.y);
        ctx.stroke();
        ctx.fillStyle = ok ? "#bbb" : "#ffb347";
        ctx.fillText(nm.measured.toFixed(1), nm.hit.x + 3, nm.hit.y - 3);
      } else {
        ctx.strokeStyle = "rgba(255,80,80,0.8)";
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(nm.from.x, nm.from.y);
        ctx.lineTo(nm.to.x, nm.to.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#ff6666";
        ctx.fillText("已裁剪", nm.to.x + 3, nm.to.y - 3);
      }
    }
  }

  // 自交点
  if (state.showInts) {
    for (const it of comp.result.ints) {
      ctx.beginPath();
      ctx.arc(it.p.x, it.p.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#ff4444";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // 控制多边形与控制点
  if (state.showCtrl) {
    ctx.strokeStyle = "rgba(140,140,140,0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (const nd of state.nodes) {
      ctx.beginPath();
      ctx.moveTo(nd.inn.x, nd.inn.y);
      ctx.lineTo(nd.a.x, nd.a.y);
      ctx.lineTo(nd.out.x, nd.out.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const nd of state.nodes) {
      for (const h of [nd.inn, nd.out]) {
        ctx.beginPath();
        ctx.arc(h.x, h.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffcc00";
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(nd.a.x, nd.a.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#ff8c00";
      ctx.fill();
      ctx.strokeStyle = "#1e1f24";
      ctx.stroke();
    }
  }

  ctx.restore();
}

// ---------------------------------------------------------------- 统计面板

function updateStats(): void {
  const r = comp.result;
  const lines: string[] = [];
  lines.push(`采样点数：${comp.samples.length}（容差 ${state.tol}）`);
  lines.push(`自交点：${r.ints.length} 处`);
  lines.push(`有效轮廓：${r.loops.length} 条`);
  if (state.d !== 0 && r.loops.length > 0) {
    lines.push(`最大法向偏差：${comp.maxDev.toFixed(3)} px`);
  }
  if (comp.circleErr !== null) {
    lines.push(`圆形解析误差：${comp.circleErr.toFixed(3)} px（期望半径 ${(state.circleR + state.d).toFixed(1)}）`);
  }
  lines.push("");
  if (state.d === 0) {
    lines.push("偏移距离为 0");
  } else if (r.loops.length === 0) {
    lines.push("⚠ 空结果：轮廓在向内偏移中完全消失");
  } else if (r.loops.length > 1) {
    lines.push(`⚠ 局部消失：已分裂为 ${r.loops.length} 条有效轮廓`);
  } else if (r.ints.length > 0) {
    lines.push("凹处偏移发生自交，已标出并清理");
  } else {
    lines.push("无自交，偏移直接有效");
  }
  statsEl.textContent = lines.join("\n");
}

// ---------------------------------------------------------------- 交互

function toWorld(e: MouseEvent): Vec {
  const rect = cv.getBoundingClientRect();
  return { x: e.clientX - rect.left - CW / 2, y: e.clientY - rect.top - CH / 2 };
}

let drag: { node: Node; part: "a" | "out" | "inn" } | null = null;

cv.addEventListener("mousedown", (e) => {
  const m = toWorld(e);
  for (const nd of state.nodes) {
    for (const part of ["a", "out", "inn"] as const) {
      if (dist(m, nd[part]) < (part === "a" ? 9 : 7)) {
        drag = { node: nd, part };
        return;
      }
    }
  }
});
window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  drag.node[drag.part] = toWorld(e);
  state.circleR = 0; // 形状被修改，不再是解析圆
  recompute();
  draw();
});
window.addEventListener("mouseup", () => (drag = null));

// ---------------------------------------------------------------- 控件绑定

function bindRange(id: string, valId: string, get: (v: number) => void): void {
  const el = document.getElementById(id) as HTMLInputElement;
  const val = document.getElementById(valId) as HTMLSpanElement;
  const update = () => {
    val.textContent = el.value;
    get(parseFloat(el.value));
    recompute();
    draw();
  };
  el.addEventListener("input", update);
  update();
}

function bindCheck(id: string, get: (v: boolean) => void): void {
  const el = document.getElementById(id) as HTMLInputElement;
  el.addEventListener("change", () => {
    get(el.checked);
    recompute();
    draw();
  });
  get(el.checked);
}

bindRange("offset", "offsetVal", (v) => (state.d = v));
bindRange("tol", "tolVal", (v) => (state.tol = v));
bindRange("normals", "normalsVal", (v) => (state.normalCount = Math.round(v)));
bindCheck("cbOriginal", (v) => (state.showOriginal = v));
bindCheck("cbCtrl", (v) => (state.showCtrl = v));
bindCheck("cbRaw", (v) => (state.showRaw = v));
bindCheck("cbClean", (v) => (state.showClean = v));
bindCheck("cbInts", (v) => (state.showInts = v));
bindCheck("cbNormals", (v) => (state.showNormals = v));

document.getElementById("presetCircle")!.addEventListener("click", () => {
  state.nodes = circleNodes(110);
  state.circleR = 110;
  recompute();
  draw();
});
document.getElementById("presetHour")!.addEventListener("click", () => {
  state.nodes = hourglassNodes();
  state.circleR = 0;
  recompute();
  draw();
});

window.addEventListener("resize", resize);
resize();
