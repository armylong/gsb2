/**
 * 主控制器: 绑定 DOM、拖拽交互、渲染循环、面板、探针、导入导出。
 */
import { drawPattern, PATTERN_W, PATTERN_H } from './core/pattern.ts';
import {
  createInitialState,
  loadScenario,
  setBrightness,
  translateProjector,
  tryMoveCorner,
  type AppState,
  type ViewMode,
} from './ui/state.ts';
import { ScreenRenderer } from './ui/renderer.ts';
import { OutputPreview, refreshAllPreviews } from './ui/outputPreview.ts';
import { exportBundle, importBundle, type ImportResult } from './ui/io.ts';
import { bakeOutput, computeOverlap } from './core/blend.ts';
import { buildView } from './core/view.ts';
import { toSettingsFile } from './ui/state.ts';
import { SCENARIOS } from './core/scenarios.ts';
import { pt } from './core/geometry.ts';
import type { ProjectorView } from './core/blend.ts';
import type { Point } from './core/types.ts';

const state: AppState = createInitialState('normal');
let bitmapViews: Map<number, ProjectorView> | undefined;
let importInfo: ImportResult | null = null;
let previews: OutputPreview[] = [];

// ---------- DOM ----------
const screenCanvas = document.getElementById('screenCanvas') as HTMLCanvasElement;
const renderer = new ScreenRenderer(screenCanvas);

const invalidBanner = document.getElementById('invalidBanner') as HTMLDivElement;
const legend = document.getElementById('legend') as HTMLDivElement;
const probeBody = document.querySelector('#probeTable tbody') as HTMLTableSectionElement;

/** 画布客户坐标 -> 幕布坐标 */
function toScreen(e: PointerEvent): Point {
  const rect = screenCanvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * state.screenWidth,
    y: ((e.clientY - rect.top) / rect.height) * state.screenHeight,
  };
}

// ---------- 拖拽 ----------
interface Drag {
  kind: 'corner' | 'body';
  projectorId: number;
  corner?: number;
  last?: Point;
}
let drag: Drag | null = null;

screenCanvas.addEventListener('pointerdown', (e) => {
  const p = toScreen(e);
  const handle = renderer.hitHandle(p, state);
  if (handle) {
    drag = { kind: 'corner', projectorId: handle.projectorId, corner: handle.corner };
  } else {
    const bodyId = renderer.hitBody(p, state);
    if (bodyId !== null) drag = { kind: 'body', projectorId: bodyId, last: p };
  }
  if (drag) screenCanvas.setPointerCapture(e.pointerId);
});

screenCanvas.addEventListener('pointermove', (e) => {
  const p = toScreen(e);
  screenCanvas.style.cursor = renderer.hitHandle(p, state) ? 'grab' : renderer.hitBody(p, state) !== null ? 'move' : 'crosshair';
  if (!drag) return;
  if (drag.kind === 'corner' && drag.corner !== undefined) {
    tryMoveCorner(state, drag.projectorId, drag.corner, p);
  } else if (drag.kind === 'body' && drag.last) {
    translateProjector(state, drag.projectorId, p.x - drag.last.x, p.y - drag.last.y);
    drag.last = p;
  }
  // 手动改动后, 导入位图核对失效
  bitmapViews = undefined;
  importInfo = null;
  scheduleRender();
});

screenCanvas.addEventListener('pointerup', (e) => {
  drag = null;
  screenCanvas.releasePointerCapture(e.pointerId);
});

// 点击空白处加探针
screenCanvas.addEventListener('dblclick', (e: MouseEvent) => {
  const p = toScreen({ clientX: e.clientX, clientY: e.clientY } as PointerEvent);
  if (renderer.hitHandle(p, state) || renderer.hitBody(p, state) !== null) return;
  if (state.probes.length >= 8) state.probes.shift();
  state.probes.push(pt(Math.round(p.x), Math.round(p.y)));
  scheduleRender();
});

document.getElementById('clearProbes')!.addEventListener('click', () => {
  state.probes = [];
  scheduleRender();
});

// ---------- 顶部控件 ----------
const scenarioGroup = document.getElementById('scenarioGroup') as HTMLDivElement;
for (const s of SCENARIOS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = s.label;
  btn.dataset.id = s.id;
  btn.addEventListener('click', () => {
    loadScenario(state, s.id);
    bitmapViews = undefined;
    importInfo = null;
    syncControls();
    scheduleRender();
  });
  scenarioGroup.appendChild(btn);
}

const viewGroup = document.getElementById('viewGroup') as HTMLDivElement;
const modes: Array<{ id: ViewMode; label: string }> = [
  { id: 'blend', label: '融合' },
  { id: 'diff', label: '差值' },
  { id: 'coverage', label: '覆盖' },
];
for (const m of modes) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = m.label;
  btn.dataset.mode = m.id;
  btn.addEventListener('click', () => {
    state.viewMode = m.id;
    syncControls();
    scheduleRender();
  });
  viewGroup.appendChild(btn);
}

const blendInput = document.getElementById('blendWidth') as HTMLInputElement;
const blendValue = document.getElementById('blendWidthValue') as HTMLSpanElement;
blendInput.addEventListener('input', () => {
  state.blendRatio = Number(blendInput.value);
  blendValue.textContent = `${Math.round(state.blendRatio * 100)}%`;
  scheduleRender();
});

const scaleInput = document.getElementById('renderScale') as HTMLInputElement;
const scaleValue = document.getElementById('renderScaleValue') as HTMLSpanElement;
scaleInput.addEventListener('input', () => {
  state.renderScale = Number(scaleInput.value);
  scaleValue.textContent = `${state.renderScale.toFixed(2)}×`;
  scheduleRender();
});

// ---------- 侧栏投影面板(只构建一次, 渲染时复用 canvas) ----------
const panelRoot = document.getElementById('projectorPanels') as HTMLDivElement;
function buildProjectorPanels(): void {
  panelRoot.innerHTML = '';
  state.projectors.forEach((st, idx) => {
    const card = document.createElement('div');
    card.className = 'projector-card';
    card.style.borderColor = idx === 0 ? '#e5484d' : '#3b6fe0';
    card.innerHTML = `
      <h3 style="color:${idx === 0 ? '#e5484d' : '#3b6fe0'}">${st.name} 输出预览
        <span class="res">${st.outputWidth}×${st.outputHeight}</span></h3>
      <div class="preview-box"><canvas id="outCanvas${idx + 1}"></canvas></div>
      <label class="brightness-label">亮度增益
        <input type="range" min="0" max="1.5" step="0.01" value="${st.brightness}" data-id="${st.id}" class="brightness-input" />
        <span class="brightness-value" data-id="${st.id}">${st.brightness.toFixed(2)}</span>
      </label>
      <div class="quad-readout" data-id="${st.id}"></div>
    `;
    panelRoot.appendChild(card);
  });
  previews = state.projectors.map((_, i) => new OutputPreview(
    document.getElementById(`outCanvas${i + 1}`) as HTMLCanvasElement,
  ));
  // 亮度按投影 id 绑定, 切换场景后 id 不变, 无需重绑
  state.projectors.forEach((st) => {
    const input = document.querySelector(`.brightness-input[data-id="${st.id}"]`) as HTMLInputElement;
    input.addEventListener('input', () => {
      setBrightness(state, st.id, Number(input.value));
      (document.querySelector(`.brightness-value[data-id="${st.id}"]`) as HTMLSpanElement).textContent =
        Number(input.value).toFixed(2);
      bitmapViews = undefined;
      importInfo = null;
      scheduleRender();
    });
  });
}

function syncBrightnessControls(): void {
  state.projectors.forEach((st) => {
    const input = document.querySelector(`.brightness-input[data-id="${st.id}"]`) as HTMLInputElement | null;
    const label = document.querySelector(`.brightness-value[data-id="${st.id}"]`) as HTMLSpanElement | null;
    if (input) input.value = String(st.brightness);
    if (label) label.textContent = st.brightness.toFixed(2);
  });
}

function updateQuadReadouts(): void {
  state.projectors.forEach((st) => {
    const el = document.querySelector(`.quad-readout[data-id="${st.id}"]`);
    if (!el) return;
    const names = ['左上', '右上', '右下', '左下'];
    el.innerHTML = st.quad
      .map((p, i) => `${names[i]} (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`)
      .join(' · ');
  });
}

// ---------- 探针表 ----------
function refreshProbeTable(): void {
  probeBody.innerHTML = '';
  state.probes.forEach((p, idx) => {
    const s = renderer.probeAt(state, p, bitmapViews);
    const tr = document.createElement('tr');
    const cover = s.in1 && s.in2 ? '重叠' : s.in1 ? '仅投影1' : s.in2 ? '仅投影2' : '未覆盖';
    const gray = (c: number[] | null) =>
      c === null ? '—' : (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]).toFixed(1);
    const diff = s.delta === null ? '—' : (s.delta > 0 ? '+' : '') + s.delta.toFixed(1);
    const diffCls = s.delta === null ? '' : Math.abs(s.delta) <= 3 ? 'ok' : s.delta > 0 ? 'hot' : 'dim';
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>(${p.x}, ${p.y})</td>
      <td>${s.patternPoint ? `(${s.patternPoint.x.toFixed(0)}, ${s.patternPoint.y.toFixed(0)})` : '—'}</td>
      <td>${cover}</td>
      <td>${s.w1.toFixed(2)} / ${s.w2.toFixed(2)}</td>
      <td>${gray(s.composite)}</td>
      <td>${gray(s.reference)}</td>
      <td class="${diffCls}">${diff}</td>`;
    probeBody.appendChild(tr);
  });
}

// ---------- 图例/横幅 ----------
function refreshChrome(): void {
  if (state.invalid) {
    invalidBanner.hidden = false;
    invalidBanner.textContent =
      `⚠ 投影${state.invalid.projectorId} 四边形异常: ${state.invalid.reason} —— 已保留上次有效投影`;
  } else {
    invalidBanner.hidden = true;
  }
  if (state.viewMode === 'diff') {
    legend.innerHTML =
      '<span class="swatch hot">红</span> 比参考图偏亮　<span class="swatch dim">蓝</span> 偏暗　<span class="swatch neutral">灰</span> 一致';
  } else if (state.viewMode === 'coverage') {
    legend.innerHTML =
      '<span class="swatch p1">红</span> 仅投影1　<span class="swatch p2">蓝</span> 仅投影2　<span class="swatch overlap">紫</span> 重叠';
  } else {
    legend.innerHTML = importInfo
      ? `导入核对模式: ${importInfo.imageNames.size} 张位图已参与反演合成`
      : '融合视图: 重叠带内两机权重互补(和=1), 独占区满功率';
  }
}

// ---------- 导入/导出 ----------
document.getElementById('btnExport')!.addEventListener('click', async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await exportBundle(state, stamp);
});

document.getElementById('importFiles')!.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  if (!input.files || input.files.length === 0) return;
  const result = await importBundle(Array.from(input.files), state);
  importInfo = result;
  bitmapViews = result.bitmapViews.size > 0 ? result.bitmapViews : undefined;
  const status = document.getElementById('importStatus') as HTMLDivElement;
  status.textContent =
    result.warnings.length > 0 ? '导入完成, 警告: ' + result.warnings.join('; ') : '导入成功, 已用导出图反演核对';
  status.className = 'io-row import-status ' + (result.warnings.length ? 'warn' : 'ok');
  syncControls();
  scheduleRender();
  input.value = '';
});

// ---------- 控件状态同步 ----------
function syncControls(): void {
  scenarioGroup.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', (b as HTMLElement).dataset.id === state.scenarioId),
  );
  viewGroup.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', (b as HTMLElement).dataset.mode === state.viewMode),
  );
  blendInput.value = state.blendRatio.toFixed(2);
  blendValue.textContent = `${Math.round(state.blendRatio * 100)}%`;
  scaleInput.value = String(state.renderScale);
  scaleValue.textContent = `${state.renderScale.toFixed(2)}×`;
  syncBrightnessControls();
}

// ---------- URL hash 路由: #scenario/diagonal, #mode/diff 等 ----------
function applyHashRoute(): void {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const sc = params.get('scenario');
  if (sc && SCENARIOS.some((s) => s.id === sc)) {
    loadScenario(state, sc);
    bitmapViews = undefined;
    importInfo = null;
  }
  const mode = params.get('mode') as ViewMode | null;
  if (mode === 'blend' || mode === 'diff' || mode === 'coverage') state.viewMode = mode;
  const br = params.get('brightness1');
  if (br !== null) setBrightness(state, 1, Number(br));
  if (params.get('selftest') === '1') {
    // 等首帧渲染后再做自交尝试, 结果写入 <title> 供无头测试读取
    requestAnimationFrame(() => {
      const r = selfTest.attemptSelfIntersect();
      document.title = `SELFTEST ${JSON.stringify(r)}`;
    });
  }
  if (params.get('roundtrip') === '1') {
    requestAnimationFrame(() => {
      selfTest.roundTrip().then((r) => {
        const maxDelta = Math.max(
          ...r.before.map((b, i) => Math.abs((b.gray ?? NaN) - (r.after[i]?.gray ?? NaN))),
        );
        document.title = `ROUNDTRIP bitmaps=${r.bitmapCount} maxGrayDelta=${maxDelta.toFixed(2)} warnings=${r.warnings.length}`;
      }).catch((err) => {
        document.title = `ROUNDTRIP_ERROR ${String(err)}`;
      });
    });
  }
  const px = params.get('probe');
  if (px) {
    const [x, y] = px.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) state.probes.push(pt(x, y));
  }
}

// ---------- 内建自检: 挂到 window 供无头测试/控制台调用 ----------
async function roundTripBundle(): Promise<{
  warnings: string[];
  bitmapCount: number;
  before: Array<{ id: number; gray: number | null }>;
  after: Array<{ id: number; gray: number | null }>;
}> {
  // 1. 在内存中烘焙两台 PNG(复用 io 的编码路径, 但拦截下载)
  const files: File[] = [];
  const stamp = 'selftest';
  const imageFiles: Record<number, string> = {};
  for (let i = 0; i < state.projectors.length; i++) {
    const st = state.projectors[i];
    const other = state.projectors[1 - i];
    const view = buildView(st);
    const overlap = computeOverlap(st.quad, other.quad);
    const rgba = bakeOutput(
      { ...view, brightness: 1 },
      view.forwardH,
      other.quad,
      st.outputWidth,
      st.outputHeight,
      state.blendRatio,
      overlap,
    );
    const canvas = document.createElement('canvas');
    canvas.width = st.outputWidth;
    canvas.height = st.outputHeight;
    canvas.getContext('2d')!.putImageData(
      new ImageData(new Uint8ClampedArray(rgba), st.outputWidth, st.outputHeight), 0, 0,
    );
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    const name = `${stamp}-projector-${st.id}.png`;
    imageFiles[st.id] = name;
    files.push(new File([blob!], name, { type: 'image/png' }));
  }
  const settings = toSettingsFile(state, imageFiles);
  files.push(new File([JSON.stringify(settings)], `${stamp}-settings.json`, { type: 'application/json' }));

  // 2. 记录三个幕布采样点(独占1/重叠/独占2)的灰度与覆盖状态, 选点远离投影边缘
  const probePoints = [
    pt(state.screenWidth * 0.25, state.screenHeight * 0.5),
    pt(state.screenWidth * 0.5, state.screenHeight * 0.5),
    pt(state.screenWidth * 0.75, state.screenHeight * 0.5),
  ];
  const measure = (p: Point): { gray: number | null; cover: string } => {
    const s = renderer.probeAt(state, p, bitmapViews);
    const cover = s.in1 && s.in2 ? 'overlap' : s.in1 ? 'p1' : s.in2 ? 'p2' : 'none';
    if (!s.composite) return { gray: null, cover };
    return {
      gray: 0.2126 * s.composite[0] + 0.7152 * s.composite[1] + 0.0722 * s.composite[2],
      cover,
    };
  };
  const before = probePoints.map((p, i) => ({ id: i, ...measure(p) }));

  // 3. 走真实导入流程
  const result = await importBundle(files, state);
  bitmapViews = result.bitmapViews.size > 0 ? result.bitmapViews : undefined;
  importInfo = result;
  scheduleRender();
  await new Promise((r) => setTimeout(r, 100));
  const after = probePoints.map((p, i) => ({ id: i, ...measure(p) }));
  return { warnings: result.warnings, bitmapCount: result.bitmapViews.size, before, after };
}

const selfTest = {
  /** 尝试把投影1的右上角(角点1)拖到左下角(角点3)的左上方, 构成蝴蝶结自交, 期望被拒绝 */
  attemptSelfIntersect(): { accepted: boolean; invalidReason: string | null; quadChanged: boolean } {
    const before = state.projectors[0].quad.map((p) => ({ ...p }));
    const bl = state.projectors[0].quad[3]; // 左下
    const target = { x: bl.x - 40, y: bl.y - 40 };
    const accepted = tryMoveCorner(state, 1, 1, target);
    const after = state.projectors[0].quad;
    const quadChanged = before.some((p, i) => p.x !== after[i].x || p.y !== after[i].y);
    return { accepted, invalidReason: state.invalid?.reason ?? null, quadChanged };
  },
  roundTrip: roundTripBundle,
  refresh: () => scheduleRender(),
  setScenario: (id: string) => {
    loadScenario(state, id);
    bitmapViews = undefined;
    importInfo = null;
    syncControls();
    scheduleRender();
  },
  state: () => state,
  addProbe: (x: number, y: number) => {
    state.probes.push(pt(x, y));
    scheduleRender();
  },
};
declare global {
  interface Window { edgeBlendSelfTest: typeof selfTest; }
}
window.edgeBlendSelfTest = selfTest;

// ---------- 渲染调度(合并同一帧多次请求) ----------
let raf = 0;
function scheduleRender(): void {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    renderAll();
  });
}

function renderAll(): void {
  renderer.render(state, bitmapViews);
  refreshAllPreviews(state, previews);
  updateQuadReadouts();
  refreshProbeTable();
  refreshChrome();
}

// ---------- 启动: 先画一次测试图到离屏 canvas(供调试/确认) ----------
const patternCanvas = document.createElement('canvas');
patternCanvas.width = PATTERN_W;
patternCanvas.height = PATTERN_H;
drawPattern(patternCanvas.getContext('2d')!);
void patternCanvas;

syncControls();
buildProjectorPanels();
applyHashRoute();
syncControls();
scheduleRender();
