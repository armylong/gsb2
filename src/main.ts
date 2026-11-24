/**
 * 曲线排字检查器
 * - Catmull-Rom 样条曲线, 控制点可拖拽
 * - 按实际字宽沿弧长排字, 支持顺排 / 居中 / 反向
 * - 放不下的字、急弯处相互挤压的字对会被标出
 * - 点击画布上的字可定位回文本; 可导出透明 PNG 与摆位 JSON
 */

type Pt = { x: number; y: number };
type AlignMode = "start" | "center" | "reverse";

interface Glyph {
  ch: string;      // 字符(按码点切分)
  uStart: number;  // 在 textarea 中的码元下标(用于 selection)
  uLen: number;    // 码元长度(代理对为 2)
  width: number;   // 实际字宽
}

interface OBB {
  cx: number; cy: number;   // 中心
  tx: number; ty: number;   // 沿基线方向单位轴
  ux: number; uy: number;   // 垂直基线(指向字形上方)单位轴
  hx: number; hy: number;   // 两个方向的半长
}

interface Placement extends Glyph {
  fits: boolean;   // 基线区间内是否放得下
  sMid: number;    // 字中心在曲线上的弧长位置
  x: number; y: number; // 基线点坐标
  angle: number;   // 切线角
  box: OBB;
}

// ---------------------------------------------------------------- 曲线

/** Catmull-Rom 转三次贝塞尔分段 */
function catmullRomSegments(pts: Pt[]): { b0: Pt; b1: Pt; b2: Pt; b3: Pt }[] {
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    segs.push({
      b0: p1,
      b1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      b2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
      b3: p2,
    });
  }
  return segs;
}

function cubicAt(s: { b0: Pt; b1: Pt; b2: Pt; b3: Pt }, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * s.b0.x + b * s.b1.x + c * s.b2.x + d * s.b3.x,
    y: a * s.b0.y + b * s.b1.y + c * s.b2.y + d * s.b3.y,
  };
}

interface SampledCurve {
  pts: Pt[];
  cum: number[];   // 累计弧长, 与 pts 对齐
  total: number;
}

function sampleCurve(ctrl: Pt[], perSeg = 90): SampledCurve {
  const pts: Pt[] = [];
  for (const seg of catmullRomSegments(ctrl)) {
    for (let i = 0; i < perSeg; i++) pts.push(cubicAt(seg, i / perSeg));
  }
  pts.push({ ...ctrl[ctrl.length - 1] });
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return { pts, cum, total: cum[cum.length - 1] };
}

/** 弧长 s 处的点与切线角 */
function pointAt(curve: SampledCurve, s: number): { x: number; y: number; angle: number } {
  const { pts, cum, total } = curve;
  s = Math.max(0, Math.min(total, s));
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const span = cum[hi] - cum[lo] || 1e-9;
  const t = (s - cum[lo]) / span;
  const x = pts[lo].x + (pts[hi].x - pts[lo].x) * t;
  const y = pts[lo].y + (pts[hi].y - pts[lo].y) * t;
  const angle = Math.atan2(pts[hi].y - pts[lo].y, pts[hi].x - pts[lo].x);
  return { x, y, angle };
}

// ---------------------------------------------------------------- OBB 相交(SAT)

function obbPenetration(a: OBB, b: OBB): number {
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  const axes = [
    { x: a.tx, y: a.ty }, { x: a.ux, y: a.uy },
    { x: b.tx, y: b.ty }, { x: b.ux, y: b.uy },
  ];
  let minOverlap = Infinity;
  for (const ax of axes) {
    const dist = Math.abs(dx * ax.x + dy * ax.y);
    const ra = a.hx * Math.abs(a.tx * ax.x + a.ty * ax.y) + a.hy * Math.abs(a.ux * ax.x + a.uy * ax.y);
    const rb = b.hx * Math.abs(b.tx * ax.x + b.ty * ax.y) + b.hy * Math.abs(b.ux * ax.x + b.uy * ax.y);
    const overlap = ra + rb - dist;
    if (overlap <= 0) return 0;
    minOverlap = Math.min(minOverlap, overlap);
  }
  return minOverlap;
}

function pointInOBB(px: number, py: number, b: OBB): boolean {
  const dx = px - b.cx, dy = py - b.cy;
  return Math.abs(dx * b.tx + dy * b.ty) <= b.hx && Math.abs(dx * b.ux + dy * b.uy) <= b.hy;
}

// ---------------------------------------------------------------- 应用状态

const W = 960, H = 600;
const canvas = document.getElementById("cv") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const textarea = document.getElementById("txt") as HTMLTextAreaElement;
const fontSizeInput = document.getElementById("fontSize") as HTMLInputElement;
const fontSizeVal = document.getElementById("fontSizeVal")!;
const statusEl = document.getElementById("status")!;
const filterNote = document.getElementById("filterNote")!;

const state = {
  ctrl: [] as Pt[],
  align: "start" as AlignMode,
  fontSize: 28,
  text: "",
  curve: null as SampledCurve | null,
  placements: [] as Placement[],
  collisions: [] as [number, number][],   // placements 下标对
  selectedGlyph: -1,                      // placements 下标
  dragIndex: -1,
  mouseDownAt: null as Pt | null,
};

const PRESETS: Record<string, { ctrl: Pt[]; text: string; fontSize: number; align: AlignMode }> = {
  reset: {
    ctrl: [
      { x: 80, y: 320 }, { x: 280, y: 220 }, { x: 480, y: 300 },
      { x: 660, y: 180 }, { x: 880, y: 300 },
    ],
    text: "展柜曲面排字 Checker 2026",
    fontSize: 28,
    align: "start",
  },
  gentle: {
    ctrl: [
      { x: 80, y: 360 }, { x: 270, y: 240 }, { x: 480, y: 215 },
      { x: 690, y: 240 }, { x: 880, y: 360 },
    ],
    text: "平缓弧形招牌 AaBb 宽字符与 narrow 混排",
    fontSize: 30,
    align: "center",
  },
  tight: {
    ctrl: [
      { x: 120, y: 200 }, { x: 420, y: 160 }, { x: 560, y: 480 },
      { x: 700, y: 140 }, { x: 880, y: 420 },
    ],
    text: "急弯处字距挤压测试 Tight Bend ABCdef 123",
    fontSize: 34,
    align: "start",
  },
};

// 常见中文 + 拉丁 + 数字 + 常用标点 + 空格
const ALLOWED = /[一-鿿　-〿＀-￯a-zA-Z0-9 .,!?;:'"()\-—…·《》「」、。,!?;:]/;

function filterText(raw: string): string {
  let out = "";
  for (const ch of raw) if (ALLOWED.test(ch)) out += ch;
  return out;
}

// ---------------------------------------------------------------- 排版

function splitGlyphs(text: string): Glyph[] {
  const glyphs: Glyph[] = [];
  let u = 0;
  ctx.font = fontFor(state.fontSize);
  for (const ch of text) {
    glyphs.push({ ch, uStart: u, uLen: ch.length, width: ctx.measureText(ch).width });
    u += ch.length;
  }
  return glyphs;
}

function fontFor(size: number): string {
  return `${size}px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif`;
}

function layout(): void {
  state.curve = sampleCurve(state.ctrl);
  const curve = state.curve;
  ctx.font = fontFor(state.fontSize);
  const metrics = ctx.measureText("汉Ag");
  const ascent = metrics.actualBoundingBoxAscent || state.fontSize * 0.8;
  const descent = metrics.actualBoundingBoxDescent || state.fontSize * 0.25;

  const glyphs = splitGlyphs(state.text);
  const total = glyphs.reduce((s, g) => s + g.width, 0);
  const offset = state.align === "center" ? (curve.total - total) / 2 : 0;
  const eps = 0.5;

  const placements: Placement[] = [];
  let acc = 0;
  for (const g of glyphs) {
    const s0 = offset + acc;
    const s1 = s0 + g.width;
    acc += g.width;
    const fits = s0 >= -eps && s1 <= curve.total + eps;
    let sMid = (s0 + s1) / 2;
    let angleFlip = 0;
    if (state.align === "reverse") {
      sMid = curve.total - sMid;
      angleFlip = Math.PI;
    }
    const p = pointAt(curve, sMid);
    const angle = p.angle + angleFlip;
    const tx = Math.cos(angle), ty = Math.sin(angle);
    const ux = Math.sin(angle), uy = -Math.cos(angle); // 指向字形上方
    const hx = g.width / 2, hy = (ascent + descent) / 2;
    const cx = p.x + ux * ((ascent - descent) / 2);
    const cy = p.y + uy * ((ascent - descent) / 2);
    placements.push({
      ...g, fits, sMid, x: p.x, y: p.y, angle,
      box: { cx, cy, tx, ty, ux, uy, hx, hy },
    });
  }
  state.placements = placements;

  // 相邻(已排入的)字对做 OBB 相交检测
  // 阈值随字号缩放: 缓弯处高盒子的角部轻微相触属正常, 不计入
  const collisions: [number, number][] = [];
  const threshold = Math.max(1, state.fontSize * 0.08);
  for (let i = 0; i < placements.length - 1; i++) {
    const a = placements[i], b = placements[i + 1];
    if (!a.fits || !b.fits) continue;
    if (obbPenetration(a.box, b.box) > threshold) collisions.push([i, i + 1]);
  }
  state.collisions = collisions;
  updateStatus();
}

// ---------------------------------------------------------------- 绘制

function drawCurvePath(c: CanvasRenderingContext2D, curve: SampledCurve): void {
  c.beginPath();
  c.moveTo(curve.pts[0].x, curve.pts[0].y);
  for (let i = 1; i < curve.pts.length; i++) c.lineTo(curve.pts[i].x, curve.pts[i].y);
}

function render(): void {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== W * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const curve = state.curve!;

  // 控制多边形(淡)
  ctx.strokeStyle = "#e3e3ea";
  ctx.lineWidth = 1;
  ctx.beginPath();
  state.ctrl.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();

  // 基线(曲线本体)
  ctx.strokeStyle = "#94a3b8";
  ctx.lineWidth = 1.5;
  drawCurvePath(ctx, curve);
  ctx.stroke();

  // 起点 / 终点标记
  const start = pointAt(curve, 0), end = pointAt(curve, curve.total);
  drawEndpoint(start, "#16a34a", "起");
  drawEndpoint(end, "#dc2626", "止");
  // 中段方向箭头
  const mid = pointAt(curve, curve.total / 2);
  ctx.save();
  ctx.translate(mid.x, mid.y);
  ctx.rotate(mid.angle);
  ctx.fillStyle = "#94a3b8";
  ctx.beginPath();
  ctx.moveTo(10, 0); ctx.lineTo(0, -5); ctx.lineTo(0, 5);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  // 碰撞字对集合(用于高亮)
  const inCollision = new Set<number>();
  for (const [i, j] of state.collisions) { inCollision.add(i); inCollision.add(j); }

  // 字形
  ctx.font = fontFor(state.fontSize);
  ctx.textBaseline = "alphabetic";
  state.placements.forEach((pl, idx) => {
    if (!pl.fits) return;
    if (inCollision.has(idx)) fillBox(pl.box, "rgba(220,38,38,0.14)");
    ctx.save();
    ctx.translate(pl.x, pl.y);
    ctx.rotate(pl.angle);
    ctx.fillStyle = inCollision.has(idx) ? "#b91c1c" : "#1f2937";
    ctx.fillText(pl.ch, -pl.width / 2, 0);
    ctx.restore();
    if (idx === state.selectedGlyph) drawBox(pl.box, "#2563eb", 1.5);
  });

  // 碰撞连线标记
  ctx.strokeStyle = "rgba(220,38,38,0.7)";
  ctx.lineWidth = 1;
  for (const [i, j] of state.collisions) {
    const a = state.placements[i].box, b = state.placements[j].box;
    ctx.beginPath();
    ctx.moveTo(a.cx, a.cy); ctx.lineTo(b.cx, b.cy);
    ctx.stroke();
  }

  // 控制点
  state.ctrl.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = i === state.dragIndex ? "#2563eb" : "#fff";
    ctx.fill();
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  // 未排入的字: 画布左下角红色陈列
  const overflow = state.placements.filter(p => !p.fits);
  if (overflow.length) {
    ctx.font = fontFor(Math.min(state.fontSize, 24));
    let ox = 16;
    const oy = H - 18;
    ctx.fillStyle = "#b91c1c";
    ctx.fillText("未排入:", ox, oy);
    ox += ctx.measureText("未排入:").width + 8;
    for (const g of overflow) {
      const w = ctx.measureText(g.ch).width;
      ctx.strokeStyle = "#dc2626";
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(ox - 3, oy - 24, w + 6, 30);
      ctx.setLineDash([]);
      ctx.fillStyle = "#b91c1c";
      ctx.fillText(g.ch, ox, oy);
      ox += w + 10;
    }
  }
}

function drawEndpoint(p: { x: number; y: number }, color: string, label: string): void {
  ctx.beginPath();
  ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.font = "12px sans-serif";
  ctx.fillStyle = color;
  ctx.fillText(label, p.x + 8, p.y - 8);
}

function boxCorners(b: OBB): Pt[] {
  return [
    { x: b.cx + b.tx * b.hx + b.ux * b.hy, y: b.cy + b.ty * b.hx + b.uy * b.hy },
    { x: b.cx - b.tx * b.hx + b.ux * b.hy, y: b.cy - b.ty * b.hx + b.uy * b.hy },
    { x: b.cx - b.tx * b.hx - b.ux * b.hy, y: b.cy - b.ty * b.hx - b.uy * b.hy },
    { x: b.cx + b.tx * b.hx - b.ux * b.hy, y: b.cy + b.ty * b.hx - b.uy * b.hy },
  ];
}

function fillBox(b: OBB, color: string): void {
  const cs = boxCorners(b);
  ctx.beginPath();
  ctx.moveTo(cs[0].x, cs[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(cs[i].x, cs[i].y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawBox(b: OBB, color: string, width: number): void {
  const cs = boxCorners(b);
  ctx.beginPath();
  ctx.moveTo(cs[0].x, cs[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(cs[i].x, cs[i].y);
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

// ---------------------------------------------------------------- 状态面板

function updateStatus(): void {
  const overflow = state.placements.filter(p => !p.fits);
  const parts: string[] = [];
  parts.push(`<div>曲线基线长 ${state.curve!.total.toFixed(0)} px · 文本总宽 ${
    state.placements.reduce((s, p) => s + p.width, 0).toFixed(0)} px</div>`);
  if (overflow.length) {
    parts.push(`<div class="warn">放不下的字(${overflow.length}):</div><ul class="stat">` +
      overflow.map(p => `<li>「${escapeHtml(p.ch)}」 文本第 ${p.uStart + 1} 字</li>`).join("") + "</ul>");
  } else {
    parts.push(`<div class="ok">全部字均可排入</div>`);
  }
  if (state.collisions.length) {
    parts.push(`<div class="warn">急弯处相互挤压的字对(${state.collisions.length}):</div><ul class="stat">` +
      state.collisions.map(([i, j]) => {
        const a = state.placements[i], b = state.placements[j];
        return `<li>「${escapeHtml(a.ch)}」#${a.uStart + 1} ↔ 「${escapeHtml(b.ch)}」#${b.uStart + 1}</li>`;
      }).join("") + "</ul>");
  } else {
    parts.push(`<div class="ok">无相互挤压的字对</div>`);
  }
  statusEl.innerHTML = parts.join("");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------- 交互

function canvasPos(e: MouseEvent): Pt {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
}

canvas.addEventListener("mousedown", e => {
  const p = canvasPos(e);
  state.mouseDownAt = p;
  state.dragIndex = state.ctrl.findIndex(c => Math.hypot(c.x - p.x, c.y - p.y) <= 10);
});

canvas.addEventListener("mousemove", e => {
  if (state.dragIndex < 0) return;
  const p = canvasPos(e);
  state.ctrl[state.dragIndex] = {
    x: Math.max(0, Math.min(W, p.x)),
    y: Math.max(0, Math.min(H, p.y)),
  };
  layout();
  render();
});

canvas.addEventListener("mouseup", e => {
  const p = canvasPos(e);
  const wasDrag = state.dragIndex >= 0 &&
    state.mouseDownAt !== null &&
    Math.hypot(p.x - state.mouseDownAt.x, p.y - state.mouseDownAt.y) > 4;
  const draggedControl = state.dragIndex >= 0;
  state.dragIndex = -1;
  // 单击(未拖动控制点): 命中字形则回定位文本
  if (!wasDrag && !draggedControl) {
    for (let i = state.placements.length - 1; i >= 0; i--) {
      const pl = state.placements[i];
      if (pl.fits && pointInOBB(p.x, p.y, pl.box)) {
        state.selectedGlyph = i;
        textarea.focus();
        textarea.setSelectionRange(pl.uStart, pl.uStart + pl.uLen);
        render();
        return;
      }
    }
    state.selectedGlyph = -1;
    render();
  }
});

textarea.addEventListener("input", () => {
  const caretBefore = textarea.selectionStart;
  const raw = textarea.value;
  const filtered = filterText(raw);
  if (filtered !== raw) {
    // 保留可用的选中位置: 统计光标前被保留的字符数
    let kept = 0, u = 0;
    for (const ch of raw) {
      if (u >= caretBefore) break;
      if (ALLOWED.test(ch)) kept += ch.length;
      u += ch.length;
    }
    textarea.value = filtered;
    textarea.setSelectionRange(kept, kept);
    filterNote.style.display = "block";
  } else {
    filterNote.style.display = "none";
  }
  state.text = textarea.value;
  // 编辑后选中字形若仍落在文本范围内则保留, 否则清除
  if (state.selectedGlyph >= 0) {
    const pl = state.placements[state.selectedGlyph];
    if (!pl || pl.uStart >= state.text.length) state.selectedGlyph = -1;
  }
  layout();
  render();
});

document.querySelectorAll<HTMLInputElement>('input[name="align"]').forEach(r => {
  r.addEventListener("change", () => {
    state.align = r.value as AlignMode;
    layout();
    render();
  });
});

fontSizeInput.addEventListener("input", () => {
  state.fontSize = Number(fontSizeInput.value);
  fontSizeVal.textContent = fontSizeInput.value;
  layout();
  render();
});

document.querySelectorAll<HTMLButtonElement>("button[data-preset]").forEach(btn => {
  btn.addEventListener("click", () => {
    const p = PRESETS[btn.dataset.preset!];
    state.ctrl = p.ctrl.map(c => ({ ...c }));
    state.text = p.text;
    state.fontSize = p.fontSize;
    state.align = p.align;
    state.selectedGlyph = -1;
    textarea.value = p.text;
    fontSizeInput.value = String(p.fontSize);
    fontSizeVal.textContent = String(p.fontSize);
    (document.querySelector(`input[name="align"][value="${p.align}"]`) as HTMLInputElement).checked = true;
    layout();
    render();
  });
});

// ---------------------------------------------------------------- 导出

document.getElementById("exportPng")!.addEventListener("click", () => {
  const off = document.createElement("canvas");
  off.width = W; off.height = H;
  const c = off.getContext("2d")!;
  // 透明背景: 只画基线与最终摆位
  c.strokeStyle = "rgba(100,116,139,0.6)";
  c.lineWidth = 1;
  drawCurvePath(c, state.curve!);
  c.stroke();
  c.font = fontFor(state.fontSize);
  c.textBaseline = "alphabetic";
  c.fillStyle = "#111";
  for (const pl of state.placements) {
    if (!pl.fits) continue;
    c.save();
    c.translate(pl.x, pl.y);
    c.rotate(pl.angle);
    c.fillText(pl.ch, -pl.width / 2, 0);
    c.restore();
  }
  const a = document.createElement("a");
  a.download = "curve-text.png";
  a.href = off.toDataURL("image/png");
  a.click();
});

document.getElementById("exportJson")!.addEventListener("click", () => {
  const data = {
    text: state.text,
    fontSize: state.fontSize,
    align: state.align,
    controlPoints: state.ctrl,
    curveLength: Number(state.curve!.total.toFixed(2)),
    placements: state.placements.map(p => ({
      char: p.ch,
      charIndex: p.uStart,
      width: Number(p.width.toFixed(2)),
      fits: p.fits,
      arcPos: Number(p.sMid.toFixed(2)),
      x: Number(p.x.toFixed(2)),
      y: Number(p.y.toFixed(2)),
      angle: Number(p.angle.toFixed(4)),
    })),
    collisions: state.collisions.map(([i, j]) => [
      state.placements[i].uStart, state.placements[j].uStart,
    ]),
    overflow: state.placements.filter(p => !p.fits).map(p => p.uStart),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.download = "curve-text-layout.json";
  a.href = URL.createObjectURL(blob);
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------------------------------------------------------------- 启动

(function init() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const p = PRESETS[hash.get("preset") || "reset"] || PRESETS.reset;
  state.ctrl = p.ctrl.map(c => ({ ...c }));
  state.text = hash.get("text") || p.text;
  state.fontSize = Number(hash.get("font")) || p.fontSize;
  state.align = (hash.get("align") as AlignMode) || p.align;
  textarea.value = state.text;
  fontSizeInput.value = String(state.fontSize);
  fontSizeVal.textContent = String(state.fontSize);
  (document.querySelector(`input[name="align"][value="${state.align}"]`) as HTMLInputElement).checked = true;
  layout();
  render();
})();
