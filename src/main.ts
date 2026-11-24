import "./style.css";
import {
  collectSharedEdges,
  FILL_RULE_LABEL,
  rasterize,
  sameCoverage,
  SAMPLE_PATTERNS,
  type RasterResult,
  type Triangle,
} from "./rasterizer.js";
import {
  applyOffset,
  createInitialState,
  GRID_H,
  GRID_W,
  moveVertex,
  resetScene,
  setOffset,
  type AppState,
} from "./state.js";
import { Renderer } from "./renderer.js";

interface ShiftLogEntry {
  offset: { x: number; y: number };
  covered: number;
  conflict: number;
  gap: number;
  degenerate: string[];
  rule: string;
  pattern: string;
  avgColor: [number, number, number];
}

const state = createInitialState();
let renderer: Renderer;
let lastResult: RasterResult;
let baselineResult: RasterResult; // 交换/翻转前的基准
let orderCheck: { ok: boolean; text: string } | null = null;
const shiftLog: ShiftLogEntry[] = [];

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function currentRaster(): RasterResult {
  return rasterize({
    gridW: GRID_W,
    gridH: GRID_H,
    verts: state.verts,
    triangles: state.triangles,
    pattern: SAMPLE_PATTERNS[state.patternKey],
    rule: state.rule,
  });
}

function frame(): void {
  lastResult = currentRaster();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.resize(dpr, state.cell);
  renderer.render({
    result: lastResult,
    verts: state.verts,
    triangles: state.triangles,
    cell: state.cell,
    showGrid: state.showGrid,
    showSamples: state.showSamples,
    showVerts: state.showVerts,
    selected: state.selected,
    selectedVertex: state.selectedVertex,
    sharedEdges: collectSharedEdges(state.verts, state.triangles),
  });
  updatePanels();
  updateVertexLabels();
}

function updateVertexLabels(): void {
  const host = $("vertexLabels");
  host.innerHTML = "";
  if (!state.showVerts) return;
  const canvasRect = renderer.canvas.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  for (const vert of state.verts) {
    // 拖出网格范围的顶点不显示标签，避免文字飘到画布外
    if (vert.x < -0.5 || vert.x > GRID_W + 0.5 || vert.y < -0.5 || vert.y > GRID_H + 0.5) {
      continue;
    }
    const el = document.createElement("span");
    el.className = "v-label";
    el.textContent = vert.name;
    // host 与 canvas 同位于 wrap 内，按两者在视口中的差值换算
    el.style.left = `${canvasRect.left - hostRect.left + vert.x * state.cell}px`;
    el.style.top = `${canvasRect.top - hostRect.top + vert.y * state.cell}px`;
    host.appendChild(el);
  }
}

function updatePanels(): void {
  // offset 回显
  $("offsetReadout").textContent =
    `当前 offset = (${fmt(state.offset.x)}, ${fmt(state.offset.y)}) px`;
  $("zoomReadout").textContent = `${state.cell}px/格`;

  updateValidation();
  updateExplainer();
  updatePixelDetail();
  renderVertexList();
  renderShiftLog();
}

function updateValidation(): void {
  const s = lastResult.stats;
  const items: Array<{ good: boolean; title: string; body: string }> = [];

  if (state.rule === "topleft") {
    const totalConflicts = countConflicts(lastResult);
    items.push({
      good: totalConflicts === 0,
      title: "公共边归属唯一",
      body:
        totalConflicts === 0
          ? "没有任何采样点被两个三角形同时占用，也没有公共边上的漏采样。"
          : `发现 ${totalConflicts} 个重复占用采样点。`,
    });
    items.push({
      good: s.gapPixels === 0,
      title: "填满区域无漏采样",
      body:
        s.gapPixels === 0
          ? "落在公共边上的采样点都有明确归属，没有漏掉的洞。"
          : `${s.gapPixels} 个像素在公共边上存在未覆盖采样点。`,
    });
  } else if (state.rule === "strict") {
    items.push({
      good: false,
      title: "严格规则：缺口可复现",
      body: `公共边上 ${s.gapPixels} 个像素出现漏采样——视觉上就是“被咬掉一块”。`,
    });
  } else {
    items.push({
      good: false,
      title: "全包含规则：亮边可复现",
      body: `${s.conflictPixels} 个像素存在重复占用，两个三角形的颜色在同一采样点叠加，公共边亮一道。`,
    });
  }

  items.push({
    good: s.degenerate.length === 0,
    title: "退化图形检查",
    body:
      s.degenerate.length === 0
        ? "当前没有退化三角形。把 T3 压成线段后，它不会点亮任何像素。"
        : `退化三角形 ${s.degenerate.join("、")} 已被跳过，覆盖采样点为 0。`,
  });

  if (orderCheck) {
    items.push({
      good: orderCheck.ok,
      title: "次序/绕序核对",
      body: orderCheck.text,
    });
  }

  items.push({
    good: true,
    title: "覆盖统计",
    body: `覆盖像素 <b>${s.coveredPixels}</b> · 冲突像素 <b>${s.conflictPixels}</b> · 缺口像素 <b>${s.gapPixels}</b>`,
  });

  $("validation").innerHTML = items
    .map(
      (it) => `<div class="v-item ${it.good ? "good" : "bad"}">
        <span class="mark">${it.good ? "✓" : "✗"}</span>
        <span class="body"><b>${it.title}</b><br/>${it.body}</span>
      </div>`,
    )
    .join("");
}

function countConflicts(result: RasterResult): number {
  let n = 0;
  for (const p of result.pixels) n += p.conflictSamples;
  return n;
}

function updateExplainer(): void {
  const el = $("explainer");
  if (state.rule === "topleft") {
    el.innerHTML =
      "<b>左上规则</b>：边函数 e(p)=0 的采样点，仅当该边是顶边/左边时算在内。" +
      "共享这条边的两个三角形绕向相反，一边把它当顶/左边、另一边当普通边，" +
      "因此边上的采样点<b>恰好归属一个三角形</b>——既不亮一道，也不缺一块。";
  } else if (state.rule === "strict") {
    el.innerHTML =
      "<b>严格 e&gt;0</b>：所有边上的采样点都被排除。两个三角形各自丢掉公共边上的点，" +
      "于是斜边沿线出现连续未覆盖采样，放大后像<b>被咬掉一块</b>。";
  } else {
    el.innerHTML =
      "<b>全部 e&gt;=0</b>：公共边上的采样点同时属于两个三角形，" +
      "半透明混色后沿斜边<b>亮一道</b>，统计面板里的冲突像素即这些位置。";
  }
}

function updatePixelDetail(): void {
  const el = $("pixelDetail");
  if (!state.selected) {
    el.innerHTML = "未选中像素（在画面上单击一格）";
    return;
  }
  const pix = lastResult.pixels.find(
    (p) => p.px === state.selected!.px && p.py === state.selected!.py,
  );
  if (!pix) return;
  const [r, g, b] = pix.rgba;
  const chips = pix.samples
    .map((smp) => {
      const ownerText =
        smp.owners.length === 0
          ? "未覆盖"
          : smp.owners.length > 1
            ? `冲突: ${smp.owners.join("+")}`
            : smp.owners[0];
      let swatch = "#9fa7b8";
      if (smp.owners.length === 1) {
        const t = state.triangles.find((q) => q.id === smp.owners[0]);
        if (t) swatch = rgbCss(t);
      } else if (smp.owners.length > 1) {
        swatch = "#ff1ae0";
      }
      return `<span class="sample-chip"><span class="swatch" style="background:${swatch}"></span>` +
        `(${smp.dx.toFixed(3)}, ${smp.dy.toFixed(3)}) ${ownerText}</span>`;
    })
    .join("");
  el.innerHTML =
    `像素 <b>(${pix.px}, ${pix.py})</b> · 规则 <b>${FILL_RULE_LABEL[pix.rule].split("（")[0]}</b> · ` +
    `覆盖率 <b>${(pix.coverage * 100).toFixed(1)}%</b> · ` +
    `最终颜色 rgb(${r},${g},${b}) · 冲突采样 ${pix.conflictSamples} · 缺口采样 ${pix.gapSamples}` +
    `<div class="samples">${chips}</div>`;
}

function rgbCss(t: Triangle): string {
  return `rgb(${Math.round(t.color.r * 255)},${Math.round(t.color.g * 255)},${Math.round(
    t.color.b * 255,
  )})`;
}

function renderVertexList(): void {
  const host = $("vertexList");
  host.innerHTML = "";
  state.verts.forEach((vert, i) => {
    const row = document.createElement("div");
    row.className = "vertex-row" + (state.selectedVertex === i ? " selected" : "");
    row.innerHTML = `
      <span class="name">${vert.name}</span>
      <span class="coord">x ${fmt(vert.x)}<br/>y ${fmt(vert.y)}</span>
      <span class="nudge-btns">
        <button data-i="${i}" data-dx="-0.125" data-dy="0">◂</button>
        <button data-i="${i}" data-dx="0.125" data-dy="0">▸</button><br/>
        <button data-i="${i}" data-dx="0" data-dy="-0.125">▴</button>
        <button data-i="${i}" data-dx="0" data-dy="0.125">▾</button>
      </span>`;
    host.appendChild(row);
  });
  host.querySelectorAll<HTMLButtonElement>("button[data-i]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.i);
      state.selectedVertex = i;
      nudgeVertex(i, Number(btn.dataset.dx), Number(btn.dataset.dy));
    });
  });
}

function nudgeVertex(i: number, dx: number, dy: number): void {
  const v = state.verts[i];
  moveVertex(state, i, v.x + dx, v.y + dy);
  frame();
}

function renderShiftLog(): void {
  const host = $("shiftLog");
  host.innerHTML = "";
  shiftLog.forEach((entry, idx) => {
    const div = document.createElement("div");
    div.className =
      "log-entry" +
      (entry.offset.x === state.offset.x && entry.offset.y === state.offset.y
        ? " current"
        : "");
    div.innerHTML = `<span class="off">(${fmt(entry.offset.x)}, ${fmt(entry.offset.y)})</span>
      <span class="meta">
        <i class="log-swatch" style="background:rgb(${entry.avgColor.join(",")})"></i>
        覆盖 ${entry.covered} 像素 · 冲突 ${entry.conflict} · 缺口 ${entry.gap}
        ${entry.degenerate.length ? ` · 退化 ${entry.degenerate.join(",")}` : ""}
      </span>`;
    div.addEventListener("click", () => {
      setOffset(state, entry.offset.x, entry.offset.y);
      frame();
    });
    host.appendChild(div);
    void idx;
  });
}

function pushLog(): void {
  const s = lastResult.stats;
  shiftLog.push({
    offset: { ...state.offset },
    covered: s.coveredPixels,
    conflict: s.conflictPixels,
    gap: s.gapPixels,
    degenerate: [...s.degenerate],
    rule: state.rule,
    pattern: state.patternKey,
    avgColor: [...s.averageColor] as [number, number, number],
  });
}

function shiftBy(dx: number, dy: number): void {
  setOffset(state, state.offset.x + dx, state.offset.y + dy);
  frame();
  pushLog();
}

// ---------------- 几何操作 ----------------

function swapOrder(): void {
  baselineResult = currentRaster();
  const copy = [...state.triangles];
  state.triangles = copy.reverse();
  frame();
  const ok = sameCoverage(baselineResult, lastResult);
  orderCheck = {
    ok,
    text: ok
      ? `交换绘制次序后覆盖指纹完全一致（${FILL_RULE_LABEL[state.rule]}与次序无关）。`
      : "交换次序后覆盖发生变化——当前规则存在次序相关行为。",
  };
  frame();
}

function flipWinding(): void {
  baselineResult = currentRaster();
  state.triangles = state.triangles.map((t) => ({
    ...t,
    v: [t.v[0], t.v[2], t.v[1]] as [number, number, number],
  }));
  frame();
  const ok = sameCoverage(baselineResult, lastResult);
  orderCheck = {
    ok,
    text: ok
      ? "翻转全部三角形顶点顺序后覆盖不变：边函数按绕序归一化，内部恒为 e≥0。"
      : "翻转绕序后覆盖发生变化，归一化逻辑存在问题。",
  };
  frame();
}

function restoreOrder(): void {
  resetScene(state);
  orderCheck = null;
  $<HTMLButtonElement>("btnDegenerate").textContent = "退化 T3 为线段";
  frame();
}

function toggleDegenerate(): void {
  const thin = state.triangles.find((t) => t.id === "T3")!;
  const btn = $<HTMLButtonElement>("btnDegenerate");
  if (state.thinBackup === null) {
    // 把 F 点压到 E 点上，T3 退化为线段 EG
    state.thinBackup = { ...state.verts[thin.v[1]] };
    moveVertex(state, thin.v[1], state.verts[thin.v[0]].x, state.verts[thin.v[0]].y);
    btn.textContent = "恢复 T3 三角形";
  } else {
    moveVertex(state, thin.v[1], state.thinBackup.x, state.thinBackup.y);
    state.thinBackup = null;
    btn.textContent = "退化 T3 为线段";
  }
  frame();
}

// ---------------- 指针交互 ----------------

function setupPointer(): void {
  const canvas = renderer.canvas;
  let dragging: number | null = null;

  const toGrid = (ev: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left) / state.cell,
      y: (ev.clientY - rect.top) / state.cell,
    };
  };

  const hitVertex = (p: { x: number; y: number }): number | null => {
    const radius = 0.55;
    let best: number | null = null;
    let bestD = radius;
    state.verts.forEach((vert, i) => {
      const d = Math.hypot(vert.x - p.x, vert.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  canvas.addEventListener("pointerdown", (ev) => {
    const p = toGrid(ev);
    const hit = hitVertex(p);
    if (hit !== null) {
      dragging = hit;
      state.selectedVertex = hit;
      canvas.setPointerCapture(ev.pointerId);
      frame();
    } else {
      const px = Math.floor(p.x);
      const py = Math.floor(p.y);
      if (px >= 0 && px < GRID_W && py >= 0 && py < GRID_H) {
        state.selected = { px, py };
        frame();
      }
    }
  });

  canvas.addEventListener("pointermove", (ev) => {
    if (dragging === null) return;
    const p = toGrid(ev);
    const cx = Math.max(0, Math.min(GRID_W, p.x));
    const cy = Math.max(0, Math.min(GRID_H, p.y));
    moveVertex(state, dragging, cx, cy);
    frame();
  });

  const end = (ev: PointerEvent): void => {
    if (dragging !== null) {
      dragging = null;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
    }
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const next = Math.max(10, Math.min(96, state.cell + (ev.deltaY < 0 ? 4 : -4)));
      state.cell = next;
      frame();
    },
    { passive: false },
  );
}

// ---------------- 控件绑定 ----------------

function bindControls(): void {
  document.querySelectorAll<HTMLButtonElement>("#patternRow button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.patternKey = btn.dataset.pattern! as keyof typeof SAMPLE_PATTERNS;
      document
        .querySelectorAll("#patternRow button")
        .forEach((b) => b.classList.toggle("active", b === btn));
      frame();
    });
  });

  $<HTMLSelectElement>("ruleSelect").addEventListener("change", (ev) => {
    state.rule = (ev.target as HTMLSelectElement).value as AppState["rule"];
    frame();
  });

  $("btnSwap").addEventListener("click", swapOrder);
  $("btnFlip").addEventListener("click", flipWinding);
  $("btnRestoreOrder").addEventListener("click", restoreOrder);
  $("btnDegenerate").addEventListener("click", toggleDegenerate);

  $<HTMLInputElement>("chkVerts").addEventListener("change", (ev) => {
    state.showVerts = (ev.target as HTMLInputElement).checked;
    frame();
  });
  $<HTMLInputElement>("chkGrid").addEventListener("change", (ev) => {
    state.showGrid = (ev.target as HTMLInputElement).checked;
    frame();
  });
  $<HTMLInputElement>("chkSamples").addEventListener("change", (ev) => {
    state.showSamples = (ev.target as HTMLInputElement).checked;
    frame();
  });

  $("btnShiftLeft").addEventListener("click", () => shiftBy(-0.25, 0));
  $("btnShiftRight").addEventListener("click", () => shiftBy(0.25, 0));
  $("btnShiftUp").addEventListener("click", () => shiftBy(0, -0.25));
  $("btnShiftDown").addEventListener("click", () => shiftBy(0, 0.25));
  $("btnHalfPx").addEventListener("click", () => shiftBy(0.5, 0));
  $("btnResetOffset").addEventListener("click", () => {
    setOffset(state, 0, 0);
    frame();
  });

  $("btnZoomIn").addEventListener("click", () => {
    state.cell = Math.min(96, state.cell + 6);
    frame();
  });
  $("btnZoomOut").addEventListener("click", () => {
    state.cell = Math.max(10, state.cell - 6);
    frame();
  });
  $("btnResetScene").addEventListener("click", () => {
    resetScene(state);
    shiftLog.length = 0;
    orderCheck = null;
    $<HTMLButtonElement>("btnDegenerate").textContent = "退化 T3 为线段";
    frame();
    pushLog(); // 重置后的初始场景重新作为第 0 条记录
    frame();
  });

  window.addEventListener("keydown", (ev) => {
    if (state.selectedVertex === null) return;
    const map: Record<string, [number, number]> = {
      ArrowLeft: [-0.125, 0],
      ArrowRight: [0.125, 0],
      ArrowUp: [0, -0.125],
      ArrowDown: [0, 0.125],
    };
    const d = map[ev.key];
    if (d) {
      ev.preventDefault();
      nudgeVertex(state.selectedVertex, d[0], d[1]);
    }
  });
}

function fmt(n: number): string {
  return n.toFixed(4).replace(/\.?0+$/, "");
}

// ---------------- 启动 ----------------

function main(): void {
  const canvas = $<HTMLCanvasElement>("gl");
  renderer = new Renderer(canvas);
  bindControls();
  setupPointer();
  applyOffset(state);
  frame();
  // 首帧渲染完成后再记录初始场景，确保日志面板已挂载
  pushLog();
  frame();
}

main();
