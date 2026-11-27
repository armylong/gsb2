// 应用入口：状态管理、指针交互、相机、重算与导出。
// 关键不变量：起点与流线只存场景坐标；切换流速图 / 缩放都不改写这些坐标。
import { Camera } from './camera.js';
import { drawScene, RenderOptions, ProbeInfo } from './render.js';
import { createField, FIELD_DEFS, FieldId, WORLD } from '../core/fields.js';
import { traceStreamline, isSeedBlocked } from '../core/integrator.js';
import { autoSeeds, redistribute, Density, DENSITY_SPACING, DENSITY_LABEL } from '../core/seeding.js';
import { Seed, Vec2, VelocityField, TraceResult, len, angleDeg, REASON_TEXT } from '../core/types.js';
import { buildExportBundle, downloadJSON, downloadPNG, timestampSlug } from './exporter.js';
import { runChecks } from '../core/check.js';

interface AppState {
  fieldId: FieldId;
  field: VelocityField;
  seeds: Seed[];
  density: Density;
  rngSeed: number;
  selectedId: number | null;
  probe: ProbeInfo | null;
  tool: 'seed' | 'probe';
  options: RenderOptions;
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const $ = (id: string) => document.getElementById(id)!;

const fieldSelect = $('fieldSelect') as HTMLSelectElement;
const densitySelect = $('densitySelect') as HTMLSelectElement;
const toolSelect = $('toolSelect') as HTMLSelectElement;
const statusBar = $('statusBar') as HTMLDivElement;
const seedInfo = $('seedInfo') as HTMLDivElement;
const fieldDesc = $('fieldDesc') as HTMLParagraphElement;
const checkSummary = $('checkSummary') as HTMLDivElement;

// ---- 初始化流速图下拉（主场景 3 张 + 检查场 2 张，分组） ----
function populateFieldSelect(): void {
  const mainGroup = new Option('主场景流速图', '', true, false);
  mainGroup.disabled = true;
  const checkGroup = new Option('检查专用流速图', '', false, false);
  checkGroup.disabled = true;
  fieldSelect.add(mainGroup);
  (['vortex', 'converge', 'cylinder'] as FieldId[]).forEach((id) =>
    fieldSelect.add(new Option(FIELD_DEFS[id].label, id))
  );
  fieldSelect.add(checkGroup);
  (['uniform', 'rigid'] as FieldId[]).forEach((id) =>
    fieldSelect.add(new Option(FIELD_DEFS[id].label, id))
  );
}
populateFieldSelect();

function fitScale(w: number, h: number): number {
  return Math.min((w - 60) / (WORLD.xmax - WORLD.xmin), (h - 60) / (WORLD.ymax - WORLD.ymin));
}

const camera = new Camera({
  width: canvas.clientWidth,
  height: canvas.clientHeight,
  scale: 1,
  center: { x: 0, y: 0 }
});

let nextSeedId = 1;
const initialField = createField('vortex');
const initialRng = 20261127;
const state: AppState = {
  fieldId: 'vortex',
  field: initialField,
  seeds: autoSeeds(initialField, DENSITY_SPACING.normal, initialRng).map((s) => {
    s.id = nextSeedId++;
    return s;
  }),
  density: 'normal',
  rngSeed: initialRng,
  selectedId: null,
  probe: null,
  tool: 'seed',
  options: {
    showArrowGrid: true,
    showStreamArrows: true,
    showZones: true,
    showReference: false
  }
};
fieldSelect.value = 'vortex';
fieldDesc.textContent = FIELD_DEFS.vortex.desc;

// ---- 画布尺寸 / DPR ----
function resizeCanvas(): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  camera.resize(rect.width, rect.height);
  if (camera.scale === 1) camera.scale = fitScale(rect.width, rect.height);
  render();
}
window.addEventListener('resize', resizeCanvas);

function computeTraces(): TraceResult[] {
  return state.seeds.map((s) => traceStreamline(state.field, s.p));
}

let traces = computeTraces();

function render(): void {
  drawScene(ctx, {
    field: state.field,
    traces,
    seeds: state.seeds,
    camera,
    options: state.options,
    probe: state.probe,
    selectedSeedId: state.selectedId
  });
  updatePanels();
}

function updatePanels(): void {
  fieldDesc.textContent = state.field.desc;
  const blockedCount = state.seeds.filter((s) => isSeedBlocked(state.field, s.p)).length;
  const manual = state.seeds.filter((s) => s.manual).length;
  const locked = state.seeds.filter((s) => s.locked).length;
  statusBar.textContent =
    `${state.field.label} · 起点 ${state.seeds.length}（手动 ${manual} · 锁定 ${locked} · 被挡 ${blockedCount}）` +
    ` · 密度 ${DENSITY_LABEL[state.density]} · 缩放 ${(camera.scale / fitScale(camera.width, camera.height)).toFixed(2)}×`;
  updateSeedInfo();
}

function updateSeedInfo(): void {
  const seed = state.seeds.find((s) => s.id === state.selectedId);
  if (!seed) {
    seedInfo.className = 'seed-info muted';
    seedInfo.textContent = '未选中';
    return;
  }
  const trace = traces.find(
    (t) => Math.abs(t.seed.x - seed.p.x) < 1e-9 && Math.abs(t.seed.y - seed.p.y) < 1e-9
  );
  const blocked = isSeedBlocked(state.field, seed.p);
  const v = blocked ? null : state.field.velocity(seed.p);
  const lines = [
    `#${seed.id} ${seed.manual ? '手动起点' : '自动起点'}${seed.locked ? ' · 已锁定' : ''}`,
    `场景坐标 (${seed.p.x.toFixed(2)}, ${seed.p.y.toFixed(2)})`,
    blocked
      ? '状态：被当前流速图挡住（静止区 / 零速 / 出界）'
      : `方向 ${v ? angleDeg(v).toFixed(1) : '--'}°  速度 ${v ? len(v).toFixed(2) : '--'}`,
    ''
  ];
  if (trace) {
    lines.push(
      `路径长度 ${trace.length.toFixed(1)} · 折点 ${trace.points.length} · ${trace.closed ? '已闭合' : '未闭合'}`,
      `顺流端：${REASON_TEXT[trace.forward.reason]} @(${trace.forward.point.x.toFixed(1)}, ${trace.forward.point.y.toFixed(1)})`,
      `逆流端：${REASON_TEXT[trace.backward.reason]} @(${trace.backward.point.x.toFixed(1)}, ${trace.backward.point.y.toFixed(1)})`
    );
  }
  seedInfo.className = 'seed-info';
  seedInfo.textContent = lines.join('\n');
}

function retrace(): void {
  traces = computeTraces();
  render();
}

// ---- 起点操作 ----
function addManualSeed(world: Vec2): void {
  if (!pointInWorld(world)) return;
  const blocked = isSeedBlocked(state.field, world);
  state.seeds.push({ id: nextSeedId++, p: { ...world }, manual: true, locked: false });
  state.selectedId = state.seeds[state.seeds.length - 1].id;
  if (blocked) {
    // 允许在被挡位置放点：会以灰色 + 警示环标出，不生成流线
  }
  retrace();
}

function pointInWorld(p: Vec2): boolean {
  return (
    p.x >= WORLD.xmin && p.x <= WORLD.xmax && p.y >= WORLD.ymin && p.y <= WORLD.ymax
  );
}

function pickSeed(world: Vec2): Seed | null {
  const pickR = 9 / camera.scale; // 屏幕 9px 的拾取半径
  let best: Seed | null = null;
  let bestD = pickR;
  for (const s of state.seeds) {
    const d = Math.hypot(s.p.x - world.x, s.p.y - world.y);
    if (d <= bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

function deleteSelected(): void {
  if (state.selectedId === null) return;
  const seed = state.seeds.find((s) => s.id === state.selectedId);
  if (seed?.locked) return;
  state.seeds = state.seeds.filter((s) => s.id !== state.selectedId);
  state.selectedId = null;
  retrace();
}

function toggleLockSelected(): void {
  const seed = state.seeds.find((s) => s.id === state.selectedId);
  if (!seed) return;
  seed.locked = !seed.locked;
  render();
}

// ---- 指针交互 ----
interface DragState {
  mode: 'pan' | 'click';
  startScreen: Vec2;
  moved: boolean;
}
let drag: DragState | null = null;

function eventPos(e: PointerEvent | WheelEvent | MouseEvent): Vec2 {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener('pointerdown', (e) => {
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // 合成事件可能没有活动指针，忽略即可
  }
  drag = { mode: 'pan', startScreen: eventPos(e), moved: false };
});

canvas.addEventListener('pointermove', (e) => {
  const sp = eventPos(e);
  if (drag) {
    const dx = sp.x - drag.startScreen.x;
    const dy = sp.y - drag.startScreen.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.moved) {
      camera.pan({ x: e.movementX, y: e.movementY });
      render();
    }
  }
  const wp = camera.screenToWorld(sp);
  statusBar.dataset.cursor = `(${wp.x.toFixed(1)}, ${wp.y.toFixed(1)})`;
});

canvas.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const wasClick = !drag.moved;
  drag = null;
  if (!wasClick) return;

  const sp = eventPos(e);
  const wp = camera.screenToWorld(sp);
  const probeMode = state.tool === 'probe' || e.altKey;

  if (probeMode) {
    placeProbe(wp);
    return;
  }
  const hit = pickSeed(wp);
  if (hit) {
    state.selectedId = hit.id;
    state.probe = null;
  } else {
    addManualSeed(wp);
  }
  render();
});

canvas.addEventListener('pointerleave', () => {
  // 拖拽由 pointer capture 接管，这里无需重绘
});

function placeProbe(world: Vec2): void {
  const blocked = isSeedBlocked(state.field, world) || !pointInWorld(world);
  if (blocked) {
    state.probe = {
      p: { ...world },
      velocity: { x: 0, y: 0 },
      speed: 0,
      angle: 0,
      blocked: true
    };
  } else {
    const v = state.field.velocity(world);
    state.probe = {
      p: { ...world },
      velocity: v,
      speed: len(v),
      angle: angleDeg(v),
      blocked: false
    };
  }
}

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    camera.zoomAt(eventPos(e), factor);
    render();
  },
  { passive: false }
);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT') deleteSelected();
  }
  if ((e.key === 'l' || e.key === 'L') && state.selectedId !== null) toggleLockSelected();
});

// ---- 控件绑定 ----
fieldSelect.addEventListener('change', () => {
  const id = fieldSelect.value as FieldId;
  switchField(id);
});

function switchField(id: FieldId): void {
  state.fieldId = id;
  state.field = createField(id);
  state.probe = null;
  // 起点全部保留（场景坐标不变）；被新场挡住的点由渲染层标红、不产生流线
  state.selectedId = null;
  retrace();
}

densitySelect.addEventListener('change', () => {
  state.density = densitySelect.value as Density;
  state.rngSeed = (state.rngSeed + 7919) >>> 0;
  state.seeds = redistribute(state.field, state.seeds, state.density, state.rngSeed);
  state.selectedId = null;
  retrace();
});

toolSelect.addEventListener('change', () => {
  state.tool = toolSelect.value as 'seed' | 'probe';
  canvas.style.cursor = state.tool === 'probe' ? 'help' : 'crosshair';
});

$('btnRedistribute').addEventListener('click', () => {
  state.rngSeed = (state.rngSeed + 7919) >>> 0;
  state.seeds = redistribute(state.field, state.seeds, state.density, state.rngSeed);
  state.selectedId = null;
  retrace();
});

$('btnClearAuto').addEventListener('click', () => {
  state.seeds = state.seeds.filter((s) => s.locked);
  state.selectedId = null;
  retrace();
});

$('btnLock').addEventListener('click', toggleLockSelected);
$('btnDelete').addEventListener('click', deleteSelected);

$('chkArrowGrid').addEventListener('change', (e) => {
  state.options.showArrowGrid = (e.target as HTMLInputElement).checked;
  render();
});
$('chkStreamArrows').addEventListener('change', (e) => {
  state.options.showStreamArrows = (e.target as HTMLInputElement).checked;
  render();
});
$('chkZones').addEventListener('change', (e) => {
  state.options.showZones = (e.target as HTMLInputElement).checked;
  render();
});
$('chkReference').addEventListener('change', (e) => {
  state.options.showReference = (e.target as HTMLInputElement).checked;
  render();
});

function zoomByButton(factor: number): void {
  camera.zoomAt({ x: camera.width / 2, y: camera.height / 2 }, factor);
  render();
}
$('btnZoomIn').addEventListener('click', () => zoomByButton(1.2));
$('btnZoomOut').addEventListener('click', () => zoomByButton(1 / 1.2));
$('btnResetView').addEventListener('click', () => {
  camera.center = { x: 0, y: 0 };
  camera.scale = fitScale(camera.width, camera.height);
  render();
});

// ---- 导出 ----
$('btnExportJSON').addEventListener('click', () => {
  const bundle = buildExportBundle(state.field, camera, state.seeds, traces);
  downloadJSON(bundle, `streamlines-${state.fieldId}-${timestampSlug()}.json`);
});

$('btnExportPNG').addEventListener('click', () => {
  render();
  downloadPNG(canvas, `streamlines-${state.fieldId}-${timestampSlug()}.png`);
});

$('btnRunCheck').addEventListener('click', () => {
  const report = runChecks();
  checkSummary.hidden = false;
  checkSummary.innerHTML = report.results
    .map(
      (r) => `<div class="${r.pass ? 'pass' : 'fail'}">[${r.pass ? 'PASS' : 'FAIL'}] ${r.label}
  最大偏离 ${r.maxDeviation.toFixed(3)} · 停止误差 ${r.stopError.toFixed(3)}
  顺流 ${r.forwardReason} / 逆流 ${r.backwardReason}${r.closed ? ' · 闭合' : ''}</div>`
    )
    .join('');
  const head = document.createElement('div');
  head.style.marginTop = '6px';
  head.textContent = report.allPass ? '全部通过 ✔ 详细数据见 npm run check（tmp/check/）' : '存在失败项';
  checkSummary.appendChild(head);
});

// ---- 启动 ----
// 可选 URL 参数，便于自动化验证：?field=cylinder&density=sparse&ref=1
(function applyUrlParams(): void {
  const params = new URLSearchParams(window.location.search);
  const f = params.get('field');
  if (f && f in FIELD_DEFS) {
    fieldSelect.value = f;
    switchField(f as FieldId);
  }
  const d = params.get('density');
  if (d === 'sparse' || d === 'normal' || d === 'dense') {
    densitySelect.value = d;
    state.density = d;
    state.seeds = redistribute(state.field, state.seeds.filter((s) => s.locked), d, state.rngSeed);
  }
  if (params.get('ref') === '1') {
    state.options.showReference = true;
    (document.getElementById('chkReference') as HTMLInputElement).checked = true;
  }
})();

resizeCanvas();
camera.scale = fitScale(camera.width, camera.height);
render();
