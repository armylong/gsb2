import * as THREE from 'three';
import {
  EyeId, PairRead, readPoint, StereoParams, StereoRig, VISIBILITY_TEXT, ViewMode, validateParams,
} from './stereo';
import { buildDefaultMarkers, GROUP_LABELS, MarkerId } from './markers';
import { LabScene, MarkerVisual } from './scene';
import { MarkerFrame, Overlay, ViewportRect } from './overlay';
import { SimpleOrbit } from './orbit';
import { runGeometryChecks } from './verify';

/* ------------------------------------------------------------------ */
/* 默认参数与姿态                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_PARAMS: StereoParams = {
  baseline: 0.24, convergence: 12, fov: 70, near: 0.5, far: 80,
};
/** 固定观察姿态：yaw/pitch（弧度），rig 恒在世界原点 */
const DEFAULT_POSE = { yaw: 0, pitch: 0 };
const DEFAULT_OBJECT = { x: 0, y: 0, z: 12 };

/* ------------------------------------------------------------------ */
/* DOM 与渲染器                                                        */
/* ------------------------------------------------------------------ */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('gl');
const wrap = $('canvas-wrap');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setScissorTest(true);

const rig = new StereoRig(DEFAULT_PARAMS);
const defs = buildDefaultMarkers();
const lab = new LabScene(rig, defs);
const overlay = new Overlay(
  $('overlay'), $('vp-left'), $('vp-right'),
  $('crosshair-left'), $('crosshair-right'), $('minimap'),
);

// 自包含轨道控制器：rig 恒在原点、只旋转，不触碰相机专属矩阵
const controls = new SimpleOrbit(rig.root, renderer.domElement);

/* ------------------------------------------------------------------ */
/* 应用状态                                                            */
/* ------------------------------------------------------------------ */

const state = {
  params: { ...DEFAULT_PARAMS },
  safePct: 3,
  viewMode: 'sbs' as ViewMode,
  selectedId: null as MarkerId | null,
  depthLock: false,
  object: { ...DEFAULT_OBJECT },
  showHelpers: true,
  lastError: '' as string,
};

let viewports: Record<EyeId, ViewportRect | null> = { left: null, right: null };
let eyeWidthPx = 1;
let frameSeq = 0;
const lastValidParams = { ...DEFAULT_PARAMS };
const savedFrames = new Map<MarkerId, PairRead>();
const msgBar = $('msg-bar');

function flash(msg: string, kind: '' | 'warn' | 'error' = '', ttl = 4000): void {
  msgBar.textContent = msg;
  msgBar.className = `msg-bar ${kind}`;
  if (ttl > 0) window.setTimeout(() => {
    if (msgBar.textContent === msg) { msgBar.textContent = ''; msgBar.className = 'msg-bar'; }
  }, ttl);
}

/* ------------------------------------------------------------------ */
/* 参数控件绑定（range + number 双向联动，非法值回退）                    */
/* ------------------------------------------------------------------ */

type NumericParam = keyof StereoParams | 'safePct' | 'objectZ';

function bindNumeric(selector: string, get: () => number, set: (v: number) => string | null): void {
  const host = document.querySelector<HTMLElement>(selector)!;
  const range = host.querySelector<HTMLInputElement>('input[type=range]')!;
  const num = host.querySelector<HTMLInputElement>('input[type=number]')!;
  const val = host.querySelector<HTMLElement>('.val')!;
  const sync = (v: number) => { range.value = String(v); num.value = String(v); val.textContent = String(v); };
  const commit = (raw: string): boolean => {
    const v = Number(raw);
    if (!Number.isFinite(v)) { host.classList.add('invalid'); return false; }
    const err = set(v);
    host.classList.toggle('invalid', err !== null);
    if (err) { flash(err, 'error'); return false; }
    host.classList.remove('invalid');
    sync(get());
    return true;
  };
  range.addEventListener('input', () => commit(range.value));
  num.addEventListener('input', () => commit(num.value));
  num.addEventListener('blur', () => { num.value = String(get()); host.classList.remove('invalid'); });
  host.dataset.bound = '1';
  sync(get());
}

function applyStereoParams(next: Partial<StereoParams>): string | null {
  const candidate = { ...state.params, ...next };
  const err = validateParams(candidate);
  if (err) {
    state.lastError = err;
    return err;
  }
  state.params = candidate;
  Object.assign(lastValidParams, candidate);
  state.lastError = '';
  rig.params = state.params;
  rig.update();
  lab.updateConvergence();
  lab.updateFrustum();
  lab.updateEyeGizmos();
  return null;
}

bindNumeric('[data-param="baseline"]', () => state.params.baseline,
  (v) => applyStereoParams({ baseline: v }));
bindNumeric('[data-param="convergence"]', () => state.params.convergence,
  (v) => applyStereoParams({ convergence: v }));
bindNumeric('[data-param="fov"]', () => state.params.fov,
  (v) => applyStereoParams({ fov: v }));
bindNumeric('[data-param="near"]', () => state.params.near,
  (v) => applyStereoParams({ near: v }));
bindNumeric('[data-param="far"]', () => state.params.far,
  (v) => applyStereoParams({ far: v }));
bindNumeric('[data-param="safePct"]', () => state.safePct,
  (v) => { if (v <= 0 || v > 20) return '安全范围需在 0~20% 之间'; state.safePct = v; return null; });
bindNumeric('[data-param="objectZ"]', () => state.object.z,
  (v) => setObjectDepth(v));

function setObjectDepth(z: number): string | null {
  const clamped = THREE.MathUtils.clamp(z, 0.1, 60);
  state.object.z = clamped;
  lab.setMovableLocal(state.object.x, state.object.y, clamped);
  if (Math.abs(clamped - z) > 1e-9) return `深度已限制在 0.1~60m 内，当前 ${clamped.toFixed(1)}m`;
  return null;
}

/* ------------------------------------------------------------------ */
/* 显示模式 / 辅助开关 / 姿态                                           */
/* ------------------------------------------------------------------ */

document.querySelectorAll<HTMLInputElement>('input[name="viewmode"]').forEach((rb) => {
  rb.addEventListener('change', () => { state.viewMode = rb.value as ViewMode; resize(); });
});
$<HTMLInputElement>('show-helpers').addEventListener('change', (e) => {
  state.showHelpers = (e.target as HTMLInputElement).checked;
  lab.setHelpersVisible(state.showHelpers);
});

function applyDefaultPose(): void {
  controls.setView(DEFAULT_POSE.yaw, DEFAULT_POSE.pitch);
}
applyDefaultPose();

$('btn-pose-reset').addEventListener('click', () => { applyDefaultPose(); flash('已恢复固定观察姿态'); });
$('btn-pose-save').addEventListener('click', () => {
  localStorage.setItem('stereo-lab-pose', JSON.stringify(controls.getView()));
  flash('姿态已保存到浏览器本地存储');
});
$('btn-pose-load').addEventListener('click', () => {
  const raw = localStorage.getItem('stereo-lab-pose');
  if (!raw) { flash('还没有保存过姿态', 'warn'); return; }
  try {
    const v = JSON.parse(raw) as { yaw: number; pitch: number };
    controls.setView(v.yaw, v.pitch);
    flash('已恢复上次保存的姿态');
  } catch {
    flash('保存的姿态数据损坏，无法加载', 'error');
  }
});
// 启动时若存在已保存姿态则自动恢复，否则用固定姿态
{
  const raw = localStorage.getItem('stereo-lab-pose');
  if (raw) {
    try {
      const v = JSON.parse(raw) as { yaw: number; pitch: number };
      controls.setView(v.yaw, v.pitch);
    } catch { /* 损坏则保持默认姿态 */ }
  }
}

/* ------------------------------------------------------------------ */
/* 选择标记                                                            */
/* ------------------------------------------------------------------ */

function selectMarker(id: MarkerId | null): void {
  state.selectedId = id;
  lab.setSelected(id);
  for (const chip of document.querySelectorAll<HTMLElement>('.marker-chip')) {
    chip.classList.toggle('selected', chip.dataset.id === id);
  }
  updateSelectedPanel();
}

/* ------------------------------------------------------------------ */
/* 尺寸布局：保证每只眼使用正方形像素、绝不拉伸                           */
/* ------------------------------------------------------------------ */

function resize(): void {
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  if (W === 0 || H === 0) return;
  renderer.setSize(W, H, false);

  const mode = state.viewMode;
  const halfW = Math.floor(W / 2);
  const eyeW = mode === 'sbs' ? halfW : W;
  eyeWidthPx = eyeW;
  const aspect = eyeW / Math.max(H, 1);
  rig.setAspect(aspect);
  rig.params = state.params;
  rig.update();
  lab.updateConvergence();
  lab.updateFrustum();
  lab.updateEyeGizmos();
  viewports = overlay.layout(mode, W, H);
}
new ResizeObserver(resize).observe(wrap);

/* ------------------------------------------------------------------ */
/* 固定用例                                                            */
/* ------------------------------------------------------------------ */

function resetPoseForCase(): void {
  applyDefaultPose();
  state.object = { ...DEFAULT_OBJECT };
}

function runCase(name: string): void {
  resetPoseForCase();
  let p: StereoParams;
  let z: number;
  switch (name) {
    case 'zeroBaseline':
      p = { ...DEFAULT_PARAMS, baseline: 0 };
      z = 8;
      flash('用例A：基线=0，两眼画面应完全一致、所有视差为 0');
      break;
    case 'onConvergence':
      p = { ...DEFAULT_PARAMS };
      z = p.convergence;
      flash('用例B：可移动物体位于会聚面，左右投影点重合（d=0）');
      break;
    case 'crossNear':
      p = { ...DEFAULT_PARAMS, near: 2 };
      z = 1.0; // near 之内 → clipped
      flash(`用例C：物体深度 ${z}m 小于近裁剪面 ${p.near}m，应显示“已被裁剪”且无视差`, 'warn');
      break;
    case 'crossFar':
      p = { ...DEFAULT_PARAMS, far: 18 };
      z = 24; // far 之外 → clipped
      flash(`用例D：物体深度 ${z}m 大于远裁剪面 ${p.far}m，应显示“已被裁剪”且无视差`, 'warn');
      break;
    default:
      return;
  }
  const err = applyStereoParams(p);
  if (err) { flash(`用例参数非法，已保留最近有效画面：${err}`, 'error'); }
  setObjectDepth(z);
  syncAllControls();
  resize();
}

document.querySelectorAll<HTMLButtonElement>('button[data-case]').forEach((b) =>
  b.addEventListener('click', () => runCase(b.dataset.case!)));

$('btn-restore-defaults').addEventListener('click', () => {
  state.safePct = 3;
  state.depthLock = false;
  $<HTMLInputElement>('depth-lock').checked = false;
  state.object = { ...DEFAULT_OBJECT };
  applyDefaultPose();
  applyStereoParams({ ...DEFAULT_PARAMS });
  lab.setMovableLocal(DEFAULT_OBJECT.x, DEFAULT_OBJECT.y, DEFAULT_OBJECT.z);
  syncAllControls();
  resize();
  flash('已恢复默认参数与姿态');
});

function syncAllControls(): void {
  document.querySelectorAll<HTMLElement>('.ctrl[data-param]').forEach((host) => {
    const key = host.dataset.param as NumericParam;
    const v = key === 'safePct' ? state.safePct
      : key === 'objectZ' ? state.object.z
      : state.params[key as keyof StereoParams];
    const range = host.querySelector<HTMLInputElement>('input[type=range]')!;
    const num = host.querySelector<HTMLInputElement>('input[type=number]')!;
    const val = host.querySelector<HTMLElement>('.val')!;
    range.value = String(v); num.value = String(v); val.textContent = String(v);
    host.classList.remove('invalid');
  });
}

/* ------------------------------------------------------------------ */
/* 深度锁定 / 快捷定位                                                  */
/* ------------------------------------------------------------------ */

$<HTMLInputElement>('depth-lock').addEventListener('change', (e) => {
  state.depthLock = (e.target as HTMLInputElement).checked;
  flash(state.depthLock ? `深度已锁定在 ${state.object.z.toFixed(1)}m` : '已解除深度锁定');
});
$('btn-snap-conv').addEventListener('click', () => { setObjectDepth(state.params.convergence); syncAllControls(); });
$('btn-snap-near').addEventListener('click', () => { setObjectDepth(state.params.near); syncAllControls(); });
$('btn-snap-far').addEventListener('click', () => { setObjectDepth(state.params.far); syncAllControls(); });

/* ------------------------------------------------------------------ */
/* 拾取与拖动                                                          */
/* ------------------------------------------------------------------ */

const raycaster = new THREE.Raycaster();
let dragging = false;

function pointerToNDC(e: PointerEvent): { ndc: THREE.Vector2; eye: EyeId | null } {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  if (state.viewMode === 'sbs') {
    const eye: EyeId = px < rect.width / 2 ? 'left' : 'right';
    const vp = viewports[eye]!;
    return { ndc: new THREE.Vector2(2 * (px - vp.x) / vp.w - 1, 1 - 2 * py / vp.h), eye };
  }
  const eye: EyeId = state.viewMode;
  return { ndc: new THREE.Vector2(2 * px / rect.width - 1, 1 - 2 * py / rect.height), eye };
}

canvas.addEventListener('pointerdown', (e) => {
  const { ndc, eye } = pointerToNDC(e);
  if (!eye) return;
  raycaster.setFromCamera(ndc, rig.getEye(eye));
  const hits = raycaster.intersectObject(lab.movable.mesh, false);
  if (hits.length > 0 && !state.depthLock) {
    dragging = true;
    controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) {
    const { ndc, eye } = pointerToNDC(e);
    if (eye) {
      raycaster.setFromCamera(ndc, rig.getEye(eye));
      const onMovable = raycaster.intersectObject(lab.movable.mesh, false).length > 0;
      canvas.style.cursor = onMovable && !state.depthLock ? 'grab' : '';
    }
    return;
  }
  const { ndc, eye } = pointerToNDC(e);
  if (!eye) return;
  raycaster.setFromCamera(ndc, rig.getEye(eye));
  const hit = new THREE.Vector3(0, 0, 0);
  if (raycaster.ray.intersectPlane(lab.movableDragPlane(), hit)) {
    const local = rig.root.worldToLocal(hit.clone());
    // 前方为 −Z：深度取 −localZ 并限制范围
    const z = THREE.MathUtils.clamp(-local.z, 0.1, 60);
    setObjectDepth(z);
    state.object.x = local.x;
    state.object.y = local.y;
    syncAllControls();
  }
});

window.addEventListener('pointerup', () => {
  if (dragging) {
    dragging = false;
    controls.enabled = true;
    canvas.style.cursor = '';
  }
});

// 单击选择标记（拖动结束的同一点击不会误触发：通过位移阈值区分）
let downPos = { x: 0, y: 0 };
canvas.addEventListener('pointerdown', (e) => { downPos = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('click', (e) => {
  if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 5) return;
  const { ndc, eye } = pointerToNDC(e);
  if (!eye) return;
  const id = lab.pick(ndc.x, ndc.y, rig.getEye(eye));
  if (id) selectMarker(id);
});

/* ------------------------------------------------------------------ */
/* 标记条                                                              */
/* ------------------------------------------------------------------ */

const strip = $('marker-strip');
const chipMap = new Map<MarkerId, HTMLElement>();
function buildMarkerChips(): void {
  for (const def of defs) {
    const chip = document.createElement('div');
    chip.className = 'marker-chip';
    chip.dataset.id = def.id;
    chip.innerHTML =
      `<div><span class="dot" style="background:#${def.color.toString(16).padStart(6, '0')}"></span>${def.label}</div>` +
      `<div class="meta">${GROUP_LABELS[def.group]}</div>` +
      `<div class="meta" data-line="status">—</div>` +
      `<div class="meta" data-line="d">—</div>`;
    chip.addEventListener('click', () => selectMarker(def.id));
    strip.appendChild(chip);
    chipMap.set(def.id, chip);
  }
}
buildMarkerChips();

/* ------------------------------------------------------------------ */
/* 读数面板                                                            */
/* ------------------------------------------------------------------ */

function fmt(v: number | null, digits = 4): string {
  return v === null ? '—' : v.toFixed(digits);
}

function statusTag(read: PairRead): string {
  if (read.visibility !== 'both') {
    const cls = read.visibility === 'clipped' || read.visibility === 'behind' ? 'bad' : 'warn';
    return `<span class="tag ${cls}">${VISIBILITY_TEXT[read.visibility]}</span>`;
  }
  if (read.unsafe) return `<span class="tag warn">超安全范围</span>`;
  return `<span class="tag ok">${VISIBILITY_TEXT.both}</span>`;
}

function eyeCoordTable(read: PairRead): string {
  const row = (name: string, er: PairRead['left']) =>
    `<tr><td>${name}</td>` +
    `<td class="num">${er.cam.x.toFixed(3)}</td><td class="num">${er.cam.y.toFixed(3)}</td>` +
    `<td class="num">${er.cam.z.toFixed(3)}</td>` +
    `<td class="num">${er.u === null ? '—' : er.u.toFixed(5)}</td>` +
    `<td class="num">${er.v === null ? '—' : er.v.toFixed(5)}</td></tr>`;
  return `<table class="readouts"><tr><th>眼</th><th>camX</th><th>camY</th><th>camZ(m)</th><th>u[0,1]</th><th>v[0,1]</th></tr>` +
    row('左 L', read.left) + row('右 R', read.right) + `</table>`;
}

function updateSelectedPanel(): void {
  const host = $('selected-readout');
  const id = state.selectedId;
  if (!id) { host.innerHTML = '点击场景中的彩色标记或下方列表选择标记。'; return; }
  const read = savedFrames.get(id);
  const def = defs.find((d) => d.id === id)!;
  if (!read) return;

  const d = read.disparity;
  const px = read.pixelDisparity;
  const exp = read.expectedDisparity;
  const signTxt = d === null ? '—（不可见，不计算视差）'
    : d > 0 ? '正：比会聚面近（交叉视差）'
      : d < 0 ? '负：比会聚面远（非交叉视差）'
        : '零：位于会聚面';

  host.innerHTML =
    `<div class="section-title">${def.label} · 世界坐标 (m，前方为 −Z)</div>` +
    `<div class="grid2"><span class="k">X / Y / Z(世界)</span><span class="v">${def.position.x.toFixed(3)} / ${def.position.y.toFixed(3)} / ${def.position.z.toFixed(3)}</span></div>` +
    `<div class="grid2"><span class="k">相对相机深度 −localZ</span><span class="v">${read.depth.toFixed(3)} m</span></div>` +
    `<div class="section-title">状态</div><div>${statusTag(read)}</div>` +
    `<div class="section-title">两眼相机坐标与归一化画面位置</div>${eyeCoordTable(read)}` +
    `<div class="section-title">视差读数（口径：单眼视口宽 W=${Math.round(eyeWidthPx)}px）</div>` +
    `<table class="readouts">` +
    `<tr><th>项目</th><th>归一化 d</th><th>百分比</th><th>像素 (px)</th></tr>` +
    `<tr><td>实际投影读数</td><td class="num">${fmt(d, 6)}</td><td class="num">${d === null ? '—' : (d * 100).toFixed(3) + '%'}</td><td class="num">${fmt(px, 2)}</td></tr>` +
    `<tr><td>闭式公式预期</td><td class="num">${fmt(exp, 6)}</td><td class="num">${exp === null ? '—' : (exp * 100).toFixed(3) + '%'}</td><td class="num">${exp === null ? '—' : (exp * eyeWidthPx).toFixed(2)}</td></tr>` +
    `<tr><td>误差 |实际−预期|</td><td class="num" colspan="3">${read.formulaError === null ? '—' : read.formulaError.toExponential(2)}（容差 1e-7）</td></tr>` +
    `</table>` +
    `<div class="grid2"><span class="k">垂直视差 (vL−vR)</span><span class="v">${fmt(read.verticalDisparity, 6)}</span></div>` +
    `<p class="hint">符号：d = (xL−xR)/W。${signTxt}。安全范围 ±${state.safePct}%。</p>`;
}

function updateMarkerChips(frames: MarkerFrame[]): void {
  for (const f of frames) {
    const chip = chipMap.get(f.def.id);
    if (!chip) continue;
    const r = f.read;
    const statusLine = chip.querySelector('[data-line="status"]')!;
    const dLine = chip.querySelector('[data-line="d"]')!;
    statusLine.innerHTML = `${statusTag(r)} <span style="color:var(--muted)">z=${r.depth.toFixed(2)}m</span>`;
    if (r.disparity === null) {
      dLine.textContent = 'd: —';
      dLine.className = 'meta status-bad';
    } else {
      dLine.textContent = `d: ${(r.disparity * 100).toFixed(3)}% · ${r.pixelDisparity!.toFixed(1)}px`;
      dLine.className = `meta ${r.unsafe ? 'status-warn' : 'status-ok'}`;
    }
  }
}

/* ------------------------------------------------------------------ */
/* HUD / 姿态读数                                                      */
/* ------------------------------------------------------------------ */

function updateHud(): void {
  const p = state.params;
  const pos = rig.root.position;
  const fwd = rig.forward();
  const euler = new THREE.Euler().setFromQuaternion(rig.root.quaternion, 'YXZ');
  $('hud').innerHTML =
    `<span>rig 位置 <b>(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})m</b></span>` +
    `<span>朝向 <b>(${fwd.x.toFixed(2)}, ${fwd.y.toFixed(2)}, ${fwd.z.toFixed(2)})</b></span>` +
    `<span>偏航/俯仰 <b>${THREE.MathUtils.radToDeg(euler.y).toFixed(1)}° / ${THREE.MathUtils.radToDeg(euler.x).toFixed(1)}°</b></span>` +
    `<span>b=<b>${p.baseline}m</b> zc=<b>${p.convergence}m</b> HFOV=<b>${p.fov}°</b></span>`;

  const eyes = rig.eyeWorldPositions();
  $('pose-readout').innerHTML =
    `rig 位置: (${pos.x.toFixed(3)}, ${pos.y.toFixed(3)}, ${pos.z.toFixed(3)}) m<br>` +
    `偏航 yaw: ${THREE.MathUtils.radToDeg(euler.y).toFixed(2)}°　俯仰 pitch: ${THREE.MathUtils.radToDeg(euler.x).toFixed(2)}°<br>` +
    `左眼世界: (${eyes.left.x.toFixed(3)}, ${eyes.left.y.toFixed(3)}, ${eyes.left.z.toFixed(3)}) m<br>` +
    `右眼世界: (${eyes.right.x.toFixed(3)}, ${eyes.right.y.toFixed(3)}, ${eyes.right.z.toFixed(3)}) m<br>` +
    `观察目标: (${controls.target.x.toFixed(2)}, ${controls.target.y.toFixed(2)}, ${controls.target.z.toFixed(2)}) m`;
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

$('btn-export').addEventListener('click', () => {
  const eyes = rig.eyeWorldPositions();
  const euler = new THREE.Euler().setFromQuaternion(rig.root.quaternion, 'YXZ');
  const payload = {
    exportedAt: new Date().toISOString(),
    units: { length: 'meter', angle: 'degree', disparity: 'normalized fraction of single-eye viewport width' },
    signConvention: 'd = (xL_px - xR_px) / W; d>0 nearer than convergence (crossed), d<0 farther (uncrossed)',
    viewMode: state.viewMode,
    singleEyeViewportCssPx: { width: Math.round(eyeWidthPx), height: Math.round(wrap.clientHeight) },
    camera: {
      params: state.params,
      safeRangePct: state.safePct,
      rigPosition: rig.root.position.toArray(),
      yawDeg: THREE.MathUtils.radToDeg(euler.y),
      pitchDeg: THREE.MathUtils.radToDeg(euler.x),
      target: controls.target.toArray(),
      leftEyeWorld: eyes.left.toArray(),
      rightEyeWorld: eyes.right.toArray(),
    },
    movable: { rigLocal: state.object, world: lab.movable.mesh.position.toArray() },
    markers: defs.map((d) => {
      const r = savedFrames.get(d.id);
      return r ? {
        id: d.id, label: d.label, group: d.group,
        worldPosition: d.position.toArray(),
        depth: Number(r.depth.toFixed(6)),
        visibility: r.visibility,
        disparity: r.disparity === null ? null : Number(r.disparity.toFixed(8)),
        disparityPct: r.disparity === null ? null : Number((r.disparity * 100).toFixed(5)),
        pixelDisparity: r.pixelDisparity === null ? null : Number(r.pixelDisparity.toFixed(3)),
        expectedDisparity: r.expectedDisparity === null ? null : Number(r.expectedDisparity.toFixed(8)),
        formulaError: r.formulaError === null ? null : Number(r.formulaError.toExponential(3)),
        unsafe: r.unsafe,
        left: { cam: r.left.cam.toArray(), u: r.left.u, v: r.left.v, visible: r.left.visible, reason: r.left.reason },
        right: { cam: r.right.cam.toArray(), u: r.right.u, v: r.right.v, visible: r.right.visible, reason: r.right.reason },
      } : { id: d.id, label: d.label, group: d.group, error: 'no reading yet' };
    }),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `stereo-parallax-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  flash('已导出当前相机参数与全部标记读数 JSON');
});

/* ------------------------------------------------------------------ */
/* 页面内自检                                                          */
/* ------------------------------------------------------------------ */

$('btn-selftest').addEventListener('click', () => {
  const results = runGeometryChecks();
  const host = $('selftest-out');
  host.innerHTML = results.map((r) =>
    `<div class="${r.pass ? 'pass' : 'fail'}">${r.pass ? '✔' : '✘'} ${r.name}</div>` +
    `<div style="color:var(--muted)">　${r.detail.replace(/</g, '&lt;')}</div>`).join('');
  const fails = results.filter((r) => !r.pass).length;
  flash(fails === 0 ? `自检通过：${results.length} 项全部满足` : `自检发现 ${fails} 项失败`, fails ? 'error' : 'warn');
});

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */

// 灯光
lab.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const dir = new THREE.DirectionalLight(0xffffff, 1.1);
dir.position.set(4, 10, 6);
lab.scene.add(dir);

// 可移动物体初始位置
lab.setMovableLocal(DEFAULT_OBJECT.x, DEFAULT_OBJECT.y, DEFAULT_OBJECT.z);
lab.updateConvergence();
lab.updateEyeGizmos();
lab.updateFrustum();
resize();

function renderEye(eye: EyeId, rect: ViewportRect | null): void {
  if (!rect) return;
  const cam = rig.getEye(eye);
  renderer.setViewport(rect.x, rect.y, rect.w, rect.h);
  renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
  renderer.setClearColor(0x070a10, 1);
  renderer.clear();
  renderer.render(lab.scene, cam);
}

function tick(): void {
  requestAnimationFrame(tick);
  try {
    controls.update();
    rig.update();

    const frames: MarkerFrame[] = lab.allVisuals().map((vis: MarkerVisual) => {
      const read = readPoint(rig, vis.mesh.position, eyeWidthPx, state.safePct);
      savedFrames.set(vis.def.id, read);
      return { def: vis.def, read, selected: vis.def.id === state.selectedId };
    });

    overlay.updateDots(frames, viewports);
    overlay.drawMinimap(rig, frames);

    renderEye('left', viewports.left);
    renderEye('right', viewports.right);

    // 标记条每帧更新（内容轻量），HUD/详情面板降频
    updateMarkerChips(frames);
    frameSeq++;
    if (frameSeq % 6 === 0) {
      updateHud();
      updateSelectedPanel();
    }
  } catch (err) {
    console.error('tick 渲染循环错误:', err);
  }
}

tick();

flash('拖动画面旋转视角；拖动紫色球改变深度；点击彩色标记查看读数', '', 6000);
