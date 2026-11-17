/**
 * 主界面：three.js 场景 + 控制面板 + 切片视图 + 后台提取调度。
 *
 * 数据流：UI 参数 → Worker(采样+提取) → LatestGate 过滤过期结果 →
 * 更新网格/统计/切片/导出状态。坐标系全程统一（见 field.ts 头部注释）。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SAMPLES, getSample, sampleTrilinear, UNITS, type Grid } from './field';
import type { Mesh } from './marchingTets';
import { LatestGate } from './requests';
import { meshToSTL, buildMeta } from './stl';
import { intersectMeshPlane, type Axis } from './sliceIntersect';
import { marchingSquares } from './marchingSquares';
import { fieldColor } from './colormap';
import type { ExtractRequest, ExtractResponse, ExtractSuccess } from './worker';

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sampleSel = $<HTMLSelectElement>('sample');
const sampleInfo = $('sampleInfo');
const truncBadge = $('truncBadge');
const isoInput = $<HTMLInputElement>('iso');
const isoVal = $('isoVal');
const resInput = $<HTMLInputElement>('res');
const resVal = $('resVal');
const statusEl = $('status');
const meshStats = $('meshStats');
const errorScale = $('errorScale');
const exportBtn = $<HTMLButtonElement>('exportBtn');
const exportHint = $('exportHint');
const requestLog = $('requestLog');
const retryBtn = $<HTMLButtonElement>('retryBtn');
const sliceInputs: Record<Axis, HTMLInputElement> = {
  x: $<HTMLInputElement>('sliceX'),
  y: $<HTMLInputElement>('sliceY'),
  z: $<HTMLInputElement>('sliceZ'),
};
const sliceVals: Record<Axis, HTMLElement> = {
  x: $('sliceXVal'),
  y: $('sliceYVal'),
  z: $('sliceZVal'),
};
const sliceCanvases: Record<string, HTMLCanvasElement> = {
  z: $<HTMLCanvasElement>('sliceXY'),
  y: $<HTMLCanvasElement>('sliceXZ'),
  x: $<HTMLCanvasElement>('sliceYZ'),
};

for (const s of SAMPLES) {
  const opt = document.createElement('option');
  opt.value = s.id;
  opt.textContent = s.label;
  sampleSel.appendChild(opt);
}
sampleSel.value = 'single';

// ---------- 状态 ----------
interface DisplayedResult {
  sig: string;
  mesh: Mesh;
  grid: Grid;
  fieldMin: number;
  fieldMax: number;
  elapsedMs: number;
  requestId: number;
}

let displayed: DisplayedResult | null = null;
let computing = false;
let discardedCount = 0;
let lastError: string | null = null;

const gate = new LatestGate();
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

function currentParams() {
  return {
    sampleId: sampleSel.value,
    iso: parseFloat(isoInput.value),
    resolution: parseInt(resInput.value, 10),
  };
}
function sigOf(p: { sampleId: string; iso: number; resolution: number }): string {
  return `${p.sampleId}|${p.iso.toFixed(4)}|${p.resolution}`;
}

// ---------- 状态显示 ----------
function setStatus(kind: 'idle' | 'busy' | 'done' | 'error', text: string) {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = text;
}

function updateRequestLog(extra = '') {
  const lines = [
    `最新请求: #${gate.latest}`,
    displayed ? `当前显示: #${displayed.requestId}（${displayed.elapsedMs.toFixed(0)} ms）` : '当前显示: 无',
    `已丢弃过期结果: ${discardedCount}`,
  ];
  if (lastError) lines.push(`错误: ${lastError}`);
  if (extra) lines.push(extra);
  requestLog.textContent = lines.join('\n');
}

function updateExportState() {
  const ok = displayed !== null && !computing && displayed.sig === sigOf(currentParams()) && displayed.mesh.triangleCount > 0;
  exportBtn.disabled = !ok;
  exportHint.textContent = ok
    ? '导出内容与画面当前网格一致（STL + JSON 元数据）。'
    : computing
      ? '计算中：不可导出，防止旧网格冒充当前参数结果。'
      : displayed && displayed.mesh.triangleCount === 0
        ? '当前为空结果，无网格可导出。'
        : '参数已变化，等待新结果就绪后可导出。';
}

// ---------- 提取调度 ----------
function requestExtraction() {
  const p = currentParams();
  const id = gate.next();
  computing = true;
  lastError = null;
  retryBtn.disabled = true;
  setStatus('busy', `请求 #${id} 计算中…`);
  updateRequestLog();
  updateExportState();
  const req: ExtractRequest = { id, ...p };
  worker.postMessage(req);
}

worker.onmessage = (ev: MessageEvent<ExtractResponse>) => {
  const res = ev.data;
  if (!gate.isLatest(res.id)) {
    // 过期结果：即使晚完成也不覆盖新结果
    discardedCount++;
    updateRequestLog(`已丢弃过期结果 #${res.id}`);
    return;
  }
  computing = false;
  if (!res.ok) {
    lastError = res.error;
    setStatus('error', `请求 #${res.id} 失败`);
    retryBtn.disabled = false;
    updateRequestLog();
    updateExportState();
    return;
  }
  applyResult(res);
  setStatus('done', `请求 #${res.id} 完成`);
  updateRequestLog();
  updateExportState();
};

worker.onerror = (e) => {
  computing = false;
  lastError = e.message ?? 'worker error';
  setStatus('error', '后台计算出错');
  retryBtn.disabled = false;
  updateRequestLog();
  updateExportState();
};

retryBtn.addEventListener('click', requestExtraction);

// ---------- three.js 场景 ----------
const glCanvas = $<HTMLCanvasElement>('gl');
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
camera.position.set(20, 15, 24);
const controls = new OrbitControls(camera, glCanvas);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.45));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
dirLight.position.set(15, 25, 20);
scene.add(dirLight);
const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.5);
dirLight2.position.set(-18, -10, -15);
scene.add(dirLight2);

// 采样边界框 + 坐标轴
const boxHelper = new THREE.Box3Helper(
  new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10)),
  new THREE.Color(0x6b7684),
);
scene.add(boxHelper);
const axesHelper = new THREE.AxesHelper(13);
scene.add(axesHelper);

// 提取网格
const meshMaterial = new THREE.MeshStandardMaterial({
  color: 0x4fa3ff,
  metalness: 0.05,
  roughness: 0.55,
  side: THREE.DoubleSide,
});
let meshObj: THREE.Mesh | null = null;

// 切片平面（3D 参考）
const slicePlaneMat = new THREE.MeshBasicMaterial({
  color: 0x9aa7b5, transparent: true, opacity: 0.10, side: THREE.DoubleSide, depthWrite: false,
});
const slicePlanes: Record<Axis, THREE.Mesh> = {
  x: new THREE.Mesh(new THREE.PlaneGeometry(20, 20), slicePlaneMat),
  y: new THREE.Mesh(new THREE.PlaneGeometry(20, 20), slicePlaneMat),
  z: new THREE.Mesh(new THREE.PlaneGeometry(20, 20), slicePlaneMat),
};
slicePlanes.x.rotation.y = Math.PI / 2;
slicePlanes.y.rotation.x = Math.PI / 2;
for (const ax of ['x', 'y', 'z'] as Axis[]) scene.add(slicePlanes[ax]);

// 网格与切片交线（3D，品红）
const sliceLineMat = new THREE.LineBasicMaterial({ color: 0xff4fd8 });
const sliceLines: Record<Axis, THREE.LineSegments> = {
  x: new THREE.LineSegments(new THREE.BufferGeometry(), sliceLineMat),
  y: new THREE.LineSegments(new THREE.BufferGeometry(), sliceLineMat),
  z: new THREE.LineSegments(new THREE.BufferGeometry(), sliceLineMat),
};
for (const ax of ['x', 'y', 'z'] as Axis[]) scene.add(sliceLines[ax]);

function slicePos(axis: Axis): number {
  return parseFloat(sliceInputs[axis].value);
}

function updateSlicePlanes() {
  slicePlanes.x.position.set(slicePos('x'), 0, 0);
  slicePlanes.y.position.set(0, slicePos('y'), 0);
  slicePlanes.z.position.set(0, 0, slicePos('z'));
}

function updateSliceLines() {
  for (const ax of ['x', 'y', 'z'] as Axis[]) {
    const geo = sliceLines[ax].geometry;
    geo.dispose();
    const newGeo = new THREE.BufferGeometry();
    if (displayed && displayed.mesh.triangleCount > 0) {
      const segs = intersectMeshPlane(displayed.mesh, ax, slicePos(ax));
      const arr = new Float32Array(segs.length * 6);
      segs.forEach((s, i) => {
        arr[i * 6] = s.ax; arr[i * 6 + 1] = s.ay; arr[i * 6 + 2] = s.az;
        arr[i * 6 + 3] = s.bx; arr[i * 6 + 4] = s.by; arr[i * 6 + 5] = s.bz;
      });
      newGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    }
    sliceLines[ax].geometry = newGeo;
  }
}

function applyViewMode() {
  const mode = (document.querySelector('input[name="view"]:checked') as HTMLInputElement).value;
  meshMaterial.wireframe = mode === 'wireframe';
  meshMaterial.transparent = mode === 'transparent';
  meshMaterial.opacity = mode === 'transparent' ? 0.35 : 1;
  meshMaterial.depthWrite = mode !== 'transparent';
  meshMaterial.needsUpdate = true;
}
document.querySelectorAll('input[name="view"]').forEach((el) => el.addEventListener('change', applyViewMode));

// ---------- 应用提取结果 ----------
function applyResult(res: ExtractSuccess) {
  const p = currentParams();
  const mesh: Mesh = {
    positions: res.positions,
    normals: res.normals,
    indices: res.indices,
    triangleCount: res.triangleCount,
    vertexCount: res.vertexCount,
    boundsMin: res.boundsMin,
    boundsMax: res.boundsMax,
  };
  const grid: Grid = {
    n: res.gridN,
    min: [-10, -10, -10],
    max: [10, 10, 10],
    h: res.gridSpacing,
    values: res.gridValues,
    minValue: res.fieldMin,
    maxValue: res.fieldMax,
  };
  displayed = {
    sig: sigOf(p),
    mesh,
    grid,
    fieldMin: res.fieldMin,
    fieldMax: res.fieldMax,
    elapsedMs: res.elapsedMs,
    requestId: res.id,
  };

  // 更新 3D 网格（空结果时移除旧网格，不残留）
  if (meshObj) {
    scene.remove(meshObj);
    meshObj.geometry.dispose();
    meshObj = null;
  }
  if (mesh.triangleCount > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    meshObj = new THREE.Mesh(geo, meshMaterial);
    scene.add(meshObj);
  }

  // 统计信息
  const fmt = (v: number) => v.toFixed(3);
  const b = (mn: number[], mx: number[]) =>
    `[${mn.map(fmt).join(', ')}] ~ [${mx.map(fmt).join(', ')}]`;
  meshStats.textContent = mesh.triangleCount > 0
    ? [
        `三角形: ${mesh.triangleCount}   顶点: ${mesh.vertexCount}`,
        `网格边界: ${b(mesh.boundsMin, mesh.boundsMax)} ${UNITS}`,
        `场值范围: [${fmt(res.fieldMin)}, ${fmt(res.fieldMax)}] ${UNITS}`,
      ].join('\n')
    : [
        `空结果：当前阈值下无等值面（三角形 0）`,
        `场值范围: [${fmt(res.fieldMin)}, ${fmt(res.fieldMax)}] ${UNITS}`,
        `提示: 阈值需落在场值范围内才有表面`,
      ].join('\n');
  errorScale.textContent =
    `采样间距 h = 20/(${res.gridN}-1) ≈ ${res.gridSpacing.toFixed(4)} ${UNITS}。` +
    `提取表面与真实等值面的位置偏差一般不超过一个网格间距 h；` +
    `切片上绿色截线（场值等值线）与品红交线（网格）的偏差也应在 h 量级以内。`;

  updateSlicePlanes();
  updateSliceLines();
  renderAllSlices();
}

// ---------- 切片视图 ----------
const SLICE_RES = 112;

function renderSlice(axis: Axis) {
  const canvas = sliceCanvases[axis];
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!displayed) return;

  const grid = displayed.grid;
  const pos = slicePos(axis);
  const uMin = -10, uMax = 10, vMin = -10, vMax = 10;
  // axis → (u,v) 世界坐标映射
  const toWorld = (u: number, v: number): [number, number, number] =>
    axis === 'z' ? [u, v, pos] : axis === 'y' ? [u, pos, v] : [pos, u, v];

  // 场值采样（与提取同一份网格数据，三线性插值）
  const vals = new Float32Array(SLICE_RES * SLICE_RES);
  for (let r = 0; r < SLICE_RES; r++) {
    const v = vMax - ((r + 0.5) / SLICE_RES) * (vMax - vMin); // 画布行向下 = v 减小
    for (let c = 0; c < SLICE_RES; c++) {
      const u = uMin + ((c + 0.5) / SLICE_RES) * (uMax - uMin);
      const [x, y, z] = toWorld(u, v);
      vals[c + SLICE_RES * r] = sampleTrilinear(grid, x, y, z);
    }
  }

  // 底色：场值色标
  const off = document.createElement('canvas');
  off.width = SLICE_RES;
  off.height = SLICE_RES;
  const offCtx = off.getContext('2d')!;
  const img = offCtx.createImageData(SLICE_RES, SLICE_RES);
  for (let i = 0; i < vals.length; i++) {
    const [rr, gg, bb] = fieldColor(vals[i], displayed.fieldMin, displayed.fieldMax);
    img.data[i * 4] = rr;
    img.data[i * 4 + 1] = gg;
    img.data[i * 4 + 2] = bb;
    img.data[i * 4 + 3] = 255;
  }
  offCtx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, W, H);

  const toPx = (u: number, v: number): [number, number] => [
    ((u - uMin) / (uMax - uMin)) * W,
    (1 - (v - vMin) / (vMax - vMin)) * H,
  ];

  // 阈值截线（场值等值线，绿色）
  const iso = parseFloat(isoInput.value);
  const contour = marchingSquares(vals, SLICE_RES, SLICE_RES, uMin, uMax, vMin, vMax, iso);
  ctx.strokeStyle = '#3dff7a';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (const s of contour) {
    const [ax, ay] = toPx(s.au, s.av);
    const [bx, by] = toPx(s.bu, s.bv);
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();

  // 网格与切片交线（品红）
  if (displayed.mesh.triangleCount > 0) {
    const segs = intersectMeshPlane(displayed.mesh, axis, pos);
    ctx.strokeStyle = '#ff4fd8';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const s of segs) {
      // 世界 → (u,v)
      const auv: [number, number] =
        axis === 'z' ? [s.ax, s.ay] : axis === 'y' ? [s.ax, s.az] : [s.ay, s.az];
      const buv: [number, number] =
        axis === 'z' ? [s.bx, s.by] : axis === 'y' ? [s.bx, s.bz] : [s.by, s.bz];
      const [ax2, ay2] = toPx(auv[0], auv[1]);
      const [bx2, by2] = toPx(buv[0], buv[1]);
      ctx.moveTo(ax2, ay2);
      ctx.lineTo(bx2, by2);
    }
    ctx.stroke();
  }

  // 坐标标注
  ctx.fillStyle = '#cfd8e3';
  ctx.font = '10px ui-monospace, monospace';
  const uName = axis === 'x' ? 'y' : 'x';
  const vName = axis === 'z' ? 'y' : 'z';
  ctx.fillText(`${uName}=${uMin}`, 3, H - 4);
  ctx.fillText(`${uName}=${uMax}`, W - 34, H - 4);
  ctx.fillText(`${vName}=${vMax}`, 3, 10);
  ctx.fillText(`${vName}=${vMin}`, 3, H - 14);
  ctx.fillText(`${axis}=${pos.toFixed(1)}`, W - 52, 10);
}

function renderAllSlices() {
  renderSlice('x');
  renderSlice('y');
  renderSlice('z');
}

// ---------- 样例信息 ----------
function updateSampleInfo() {
  const s = getSample(sampleSel.value);
  const lines = s.spheres.map(
    (sp, i) =>
      `球${i + 1}: 球心 (${sp.center.join(', ')}), 半径 ${sp.radius} ${UNITS}`,
  );
  lines.push(`采样范围: [${s.rangeMin}, ${s.rangeMax}]³ ${UNITS}`);
  lines.push(`场值: 球面=0, 内部<0, 外部>0（SDF 并集）`);
  sampleInfo.textContent = lines.join('\n');
  truncBadge.textContent = s.truncated
    ? '⚠ 边界截断样例：有球体伸出采样边界，表面在边界处开口截断'
    : '✓ 完整闭合样例：全部表面位于采样范围内';
  truncBadge.className = `badge ${s.truncated ? 'trunc' : 'closed'}`;
}

// ---------- 导出 ----------
exportBtn.addEventListener('click', () => {
  if (!displayed || displayed.sig !== sigOf(currentParams()) || computing) return;
  const p = currentParams();
  const sample = getSample(p.sampleId);
  const stl = meshToSTL(displayed.mesh);
  const meta = buildMeta(displayed.mesh, {
    sampleId: sample.id,
    sampleLabel: sample.label,
    iso: p.iso,
    resolution: p.resolution,
    units: UNITS,
    rangeMin: sample.rangeMin,
    rangeMax: sample.rangeMax,
    gridSpacing: displayed.grid.h,
  });
  download(new Blob([stl], { type: 'model/stl' }), `isosurface_${sample.id}_iso${p.iso}_n${p.resolution}.stl`);
  download(new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }), `isosurface_${sample.id}_iso${p.iso}_n${p.resolution}.json`);
});

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- 事件 ----------
sampleSel.addEventListener('change', () => {
  updateSampleInfo();
  requestExtraction();
});
isoInput.addEventListener('input', () => {
  isoVal.textContent = parseFloat(isoInput.value).toFixed(2);
  requestExtraction();
});
resInput.addEventListener('input', () => {
  resVal.textContent = resInput.value;
  requestExtraction();
});
for (const ax of ['x', 'y', 'z'] as Axis[]) {
  sliceInputs[ax].addEventListener('input', () => {
    sliceVals[ax].textContent = parseFloat(sliceInputs[ax].value).toFixed(1);
    updateSlicePlanes();
    updateSliceLines();
    renderSlice(ax);
  });
}

// 参数变化时立即使导出失效（新结果未就绪前不允许导出）
for (const el of [isoInput, resInput, sampleSel]) {
  el.addEventListener('input', updateExportState);
}

// ---------- 渲染循环 ----------
function resize() {
  const parent = glCanvas.parentElement!;
  const w = parent.clientWidth;
  const h = parent.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(glCanvas.parentElement!);
resize();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ---------- 启动 ----------
updateSampleInfo();
applyViewMode();
updateSlicePlanes();
requestExtraction();
