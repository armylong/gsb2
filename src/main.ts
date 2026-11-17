import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { computeFrames } from './frames';
import { buildPipe, PipeData, PipeParams, ringVertex } from './pipe';
import { analyzePath, PathWarning } from './warnings';
import { runValidation } from './validate';
import { toOBJ } from './obj';
import { PRESETS, toVectors } from './presets';

// ---------------- 状态 ----------------
interface AppState {
  points: THREE.Vector3[];
  closed: boolean;
  params: PipeParams;
  wireframe: boolean;
  showMarker: boolean;
  showFrames: boolean;
}

const state: AppState = {
  points: toVectors(PRESETS[0]),
  closed: PRESETS[0].closed,
  params: { radius: 0.35, segments: 64, sides: 16, shape: 'circle', caps: true, closed: false },
  wireframe: false,
  showMarker: true,
  showFrames: true,
};

let pipeData: PipeData | null = null;
let warnings: PathWarning[] = [];
let seamGap = 0;
let effectiveClosed = false;
let selectedIndex = -1;

// ---------------- 场景 ----------------
const viewport = document.getElementById('viewport')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);

const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 500);
camera.position.set(8, 6, 10);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 0.8, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.45));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
dirLight.position.set(6, 10, 4);
scene.add(dirLight);
const grid = new THREE.GridHelper(20, 20, 0x333a44, 0x232830);
scene.add(grid);
scene.add(new THREE.AxesHelper(1.5));

// 管道网格（实体 + 线框叠加）
const pipeMat = new THREE.MeshStandardMaterial({
  color: 0x6fa8dc, roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide,
});
const wireMat = new THREE.MeshBasicMaterial({ color: 0x22303c, wireframe: true });
let pipeMesh: THREE.Mesh | null = null;
let wireMesh: THREE.Mesh | null = null;

// 中心线（按段着色，警告段红色）
const centerlineMat = new THREE.LineBasicMaterial({ vertexColors: true });
let centerline: THREE.LineSegments | null = null;

// 控制点连线
const ctrlLineMat = new THREE.LineDashedMaterial({ color: 0x555f6c, dashSize: 0.15, gapSize: 0.1 });
let ctrlLine: THREE.Line | null = null;

// 控制点球
const sphereGeo = new THREE.SphereGeometry(0.12, 16, 12);
const sphereMat = new THREE.MeshBasicMaterial({ color: 0xffb347 });
const sphereSelMat = new THREE.MeshBasicMaterial({ color: 0xff5533 });
let spheres: THREE.Mesh[] = [];

// 角标记（截面顶点 0 的连线）与接缝标记球
const markerMat = new THREE.LineBasicMaterial({ color: 0xff3333 });
let markerLine: THREE.Line | null = null;
const seamMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.09, 12, 8),
  new THREE.MeshBasicMaterial({ color: 0xffff00 }),
);

// 截面参考方向箭头
const arrowsGroup = new THREE.Group();

// 控制点拖拽
const tc = new TransformControls(camera, renderer.domElement);
tc.setSize(0.7);
scene.add(tc.getHelper());
tc.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });
tc.addEventListener('objectChange', () => {
  if (selectedIndex >= 0 && spheres[selectedIndex]) {
    state.points[selectedIndex].copy(spheres[selectedIndex].position);
    rebuild();
    refreshPointRowValues();
  }
});

// 点击选择控制点
const raycaster = new THREE.Raycaster();
let downPos: { x: number; y: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downPos = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  downPos = null;
  if (moved > 4 || tc.dragging) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(spheres, false);
  if (hits.length > 0) {
    selectPoint(spheres.indexOf(hits[0].object as THREE.Mesh));
  } else {
    selectPoint(-1);
  }
});

function selectPoint(i: number) {
  selectedIndex = i;
  spheres.forEach((s, k) => (s.material = k === i ? sphereSelMat : sphereMat));
  if (i >= 0) tc.attach(spheres[i]); else tc.detach();
  document.querySelectorAll('.pt-row .idx').forEach((el, k) => {
    el.classList.toggle('sel', k === i);
  });
}

// ---------------- 重建 ----------------
function rebuild() {
  const pts = state.points;
  effectiveClosed = state.closed && pts.length >= 3;
  const params: PipeParams = { ...state.params, closed: effectiveClosed };

  const curve = new THREE.CatmullRomCurve3(pts, effectiveClosed, 'centripetal');
  const sampled = curve.getSpacedPoints(params.segments);
  seamGap = 0;
  if (effectiveClosed) {
    seamGap = sampled[0].distanceTo(sampled[sampled.length - 1]);
    sampled.pop(); // 末点与首点重合，去掉以避免重复环
  }

  const frames = computeFrames(sampled, effectiveClosed);
  pipeData = buildPipe(frames, params);
  warnings = analyzePath(frames, params, pts);

  // --- 管道网格 ---
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pipeData.positions, 3));
  geo.setIndex(pipeData.indices);
  geo.computeVertexNormals();
  if (!pipeMesh) {
    pipeMesh = new THREE.Mesh(geo, pipeMat);
    wireMesh = new THREE.Mesh(geo, wireMat);
    scene.add(pipeMesh, wireMesh);
  } else {
    pipeMesh.geometry.dispose();
    pipeMesh.geometry = geo;
    wireMesh!.geometry = geo;
  }
  wireMesh!.visible = state.wireframe;

  // --- 中心线（警告段标红） ---
  const warned = new Set(warnings.map((w) => w.segment));
  const n = sampled.length;
  const segCount = effectiveClosed ? n : n - 1;
  const clPos: number[] = [];
  const clCol: number[] = [];
  const okCol = new THREE.Color(0x37c8a0), badCol = new THREE.Color(0xff4444);
  for (let i = 0; i < segCount; i++) {
    const a = sampled[i], b = sampled[(i + 1) % n];
    clPos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    const c = warned.has(i) ? badCol : okCol;
    clCol.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }
  const clGeo = new THREE.BufferGeometry();
  clGeo.setAttribute('position', new THREE.Float32BufferAttribute(clPos, 3));
  clGeo.setAttribute('color', new THREE.Float32BufferAttribute(clCol, 3));
  if (!centerline) {
    centerline = new THREE.LineSegments(clGeo, centerlineMat);
    scene.add(centerline);
  } else {
    centerline.geometry.dispose();
    centerline.geometry = clGeo;
  }

  // --- 控制点连线 ---
  const cp = pts.map((p) => p.clone());
  if (effectiveClosed) cp.push(pts[0].clone());
  const cpGeo = new THREE.BufferGeometry().setFromPoints(cp);
  if (!ctrlLine) {
    ctrlLine = new THREE.Line(cpGeo, ctrlLineMat);
    ctrlLine.computeLineDistances();
    scene.add(ctrlLine);
  } else {
    ctrlLine.geometry.dispose();
    ctrlLine.geometry = cpGeo;
    ctrlLine.computeLineDistances();
  }

  // --- 控制点球（数量不变时复用，避免打断拖拽） ---
  if (spheres.length !== pts.length) {
    tc.detach();
    spheres.forEach((s) => scene.remove(s));
    spheres = pts.map(() => new THREE.Mesh(sphereGeo, sphereMat));
    spheres.forEach((s) => scene.add(s));
    if (selectedIndex >= pts.length) selectedIndex = -1;
    if (selectedIndex >= 0) tc.attach(spheres[selectedIndex]);
    selectPoint(selectedIndex);
  }
  spheres.forEach((s, i) => s.position.copy(pts[i]));

  // --- 角标记线（截面顶点 0） ---
  const markerPts: THREE.Vector3[] = [];
  for (let i = 0; i < pipeData.ringCount; i++) markerPts.push(ringVertex(pipeData, i, 0));
  if (effectiveClosed) markerPts.push(ringVertex(pipeData, 0, 0));
  const mkGeo = new THREE.BufferGeometry().setFromPoints(markerPts);
  if (!markerLine) {
    markerLine = new THREE.Line(mkGeo, markerMat);
    scene.add(markerLine, seamMarker);
  } else {
    markerLine.geometry.dispose();
    markerLine.geometry = mkGeo;
  }
  markerLine.visible = state.showMarker;
  seamMarker.visible = state.showMarker;
  seamMarker.position.copy(ringVertex(pipeData, 0, 0));

  // --- 截面参考方向箭头（5 处，法向） ---
  arrowsGroup.clear();
  if (state.showFrames) {
    const count = 5;
    for (let k = 0; k < count; k++) {
      const i = Math.floor((k / count) * (frames.points.length - (effectiveClosed ? 0 : 1)));
      const arrow = new THREE.ArrowHelper(
        frames.normals[i], frames.points[i],
        params.radius * 2.5, 0xffaa00, params.radius * 0.7, params.radius * 0.35,
      );
      arrowsGroup.add(arrow);
    }
  }
  if (!arrowsGroup.parent) scene.add(arrowsGroup);

  // --- 面板输出 ---
  updateStats();
  updateWarnings();
  updateValidation();
}

// ---------------- 面板 ----------------
const panel = document.getElementById('panel')!;

function el(tag: string, attrs: Record<string, string> = {}, parent: HTMLElement = panel): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent.appendChild(e);
  return e;
}

function row(label: string): HTMLElement {
  const r = el('div', { class: 'row' });
  const l = el('label') as HTMLLabelElement;
  l.textContent = label;
  r.appendChild(l);
  return r;
}

function numberInput(value: number, min: number, max: number, step: number, onChange: (v: number) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min); input.max = String(max); input.step = String(step);
  input.value = String(value);
  input.addEventListener('change', () => {
    let v = parseFloat(input.value);
    if (!isFinite(v)) v = value;
    v = Math.min(max, Math.max(min, v));
    input.value = String(v);
    onChange(v);
  });
  return input;
}

function checkbox(value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

// --- 样例 ---
el('h2').textContent = '样例路径';
const presetRow = el('div', { class: 'row' });
PRESETS.forEach((p, i) => {
  const b = document.createElement('button');
  b.textContent = p.name;
  b.addEventListener('click', () => {
    state.points = toVectors(p);
    state.closed = p.closed;
    closedCheckbox.checked = p.closed;
    selectedIndex = -1;
    tc.detach();
    buildPointRows();
    rebuild();
    presetRow.querySelectorAll('button').forEach((x, k) => x.classList.toggle('active', k === i));
  });
  if (i === 0) b.classList.add('active');
  presetRow.appendChild(b);
});

// --- 路径 ---
el('h2').textContent = '路径控制点';
const closedRow = row('闭环路径');
const closedCheckbox = checkbox(state.closed, (v) => { state.closed = v; rebuild(); });
closedRow.appendChild(closedCheckbox);
const closedNote = el('div', { class: 'hint' });
closedNote.textContent = '闭环至少需要 3 个控制点；点击列表序号或场景中的球可选中并拖拽。';

const ptList = el('div');
const addBtnRow = el('div', { class: 'row' });
const addBtn = document.createElement('button');
addBtn.textContent = '＋ 添加控制点';
addBtn.addEventListener('click', () => {
  const last = state.points[state.points.length - 1];
  state.points.push(last.clone().add(new THREE.Vector3(1, 0.5, 0.5)));
  buildPointRows();
  rebuild();
});
addBtnRow.appendChild(addBtn);

const ptInputs: HTMLInputElement[][] = [];

function buildPointRows() {
  ptList.innerHTML = '';
  ptInputs.length = 0;
  state.points.forEach((p, i) => {
    const r = document.createElement('div');
    r.className = 'pt-row';
    const idx = document.createElement('span');
    idx.className = 'idx' + (i === selectedIndex ? ' sel' : '');
    idx.textContent = `P${i}`;
    idx.title = '点击选中（场景中可拖拽）';
    idx.addEventListener('click', () => selectPoint(i));
    r.appendChild(idx);
    const coords: HTMLInputElement[] = [];
    (['x', 'y', 'z'] as const).forEach((axis) => {
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.1';
      input.value = p[axis].toFixed(2);
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (isFinite(v)) {
          state.points[i][axis] = v;
          rebuild();
        }
        input.value = state.points[i][axis].toFixed(2);
      });
      r.appendChild(input);
      coords.push(input);
    });
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = '删除该点';
    del.addEventListener('click', () => {
      if (state.points.length <= 2) return;
      state.points.splice(i, 1);
      if (selectedIndex === i) { selectedIndex = -1; tc.detach(); }
      buildPointRows();
      rebuild();
    });
    r.appendChild(del);
    ptList.appendChild(r);
    ptInputs.push(coords);
  });
}

function refreshPointRowValues() {
  state.points.forEach((p, i) => {
    const coords = ptInputs[i];
    if (!coords) return;
    coords[0].value = p.x.toFixed(2);
    coords[1].value = p.y.toFixed(2);
    coords[2].value = p.z.toFixed(2);
  });
}

// --- 管道参数 ---
el('h2').textContent = '管道参数';
const radiusRow = row('半径');
radiusRow.appendChild(numberInput(state.params.radius, 0.02, 5, 0.05, (v) => { state.params.radius = v; rebuild(); }));
const segRow = row('路径分段数');
segRow.appendChild(numberInput(state.params.segments, 4, 512, 1, (v) => { state.params.segments = Math.round(v); rebuild(); }));
const sidesRow = row('截面边数');
const sidesInput = numberInput(state.params.sides, 3, 64, 1, (v) => { state.params.sides = Math.round(v); rebuild(); });
sidesRow.appendChild(sidesInput);

const shapeRow = row('截面形状');
const shapeSel = document.createElement('select');
[['circle', '圆形'], ['square', '方形']].forEach(([v, label]) => {
  const o = document.createElement('option');
  o.value = v; o.textContent = label;
  shapeSel.appendChild(o);
});
shapeSel.value = state.params.shape;
shapeSel.addEventListener('change', () => {
  state.params.shape = shapeSel.value as 'circle' | 'square';
  sidesInput.disabled = state.params.shape === 'square';
  rebuild();
});
shapeRow.appendChild(shapeSel);

const capsRow = row('封闭两端');
const capsCheckbox = checkbox(state.params.caps, (v) => { state.params.caps = v; rebuild(); });
capsRow.appendChild(capsCheckbox);
const wireRow = row('线框显示');
wireRow.appendChild(checkbox(state.wireframe, (v) => { state.wireframe = v; rebuild(); }));

// --- 显示 ---
el('h2').textContent = '朝向观察';
const markerRow = row('角标记线');
markerRow.appendChild(checkbox(state.showMarker, (v) => { state.showMarker = v; rebuild(); }));
const framesRow = row('截面参考方向');
framesRow.appendChild(checkbox(state.showFrames, (v) => { state.showFrames = v; rebuild(); }));
const seamRow = el('div', { class: 'row' });
const seamBtn = document.createElement('button');
seamBtn.textContent = '定位到接缝 / 起点';
seamBtn.addEventListener('click', () => {
  if (!pipeData) return;
  const p = pipeData.frames.points[0];
  orbit.target.copy(p);
  camera.position.copy(p).add(new THREE.Vector3(2.2, 1.6, 2.2));
  orbit.update();
});
seamRow.appendChild(seamBtn);
el('div', { class: 'hint' }).textContent =
  '红色线为截面同一角（顶点 0）的连线，黄色球在接缝处；橙色箭头为几处截面的参考方向。用方形截面观察扭转最直观。';

// --- 统计 ---
el('h2').textContent = '网格统计';
const statsLine = el('div', { id: 'stats-line' });
function updateStats() {
  if (!pipeData) return;
  statsLine.textContent =
    `顶点 ${pipeData.vertexCount} · 三角形 ${pipeData.triangleCount}` +
    ` · ${pipeData.ringCount} 环 × ${pipeData.sides} 边` +
    (effectiveClosed ? ' · 闭环无端盖' : state.params.caps ? ' · 含端盖' : '');
}

// --- 警告 ---
el('h2').textContent = '急弯 / 过近警告';
const warningsBox = el('div', { id: 'warnings' });
function updateWarnings() {
  warningsBox.textContent = warnings.map((w) => `⚠ ${w.message}`).join('\n');
}

// --- 验证 ---
el('h2').textContent = '数值验证';
const valTableBox = el('div');
function updateValidation() {
  if (!pipeData) return;
  const results = runValidation({
    samplePoints: pipeData.frames.points,
    params: { ...state.params, closed: effectiveClosed },
    pipe: pipeData,
    seamGap,
  });
  valTableBox.innerHTML = '';
  const table = document.createElement('table');
  const head = document.createElement('tr');
  ['检查项', '预期 / 容差', '实测', '结果'].forEach((t) => {
    const th = document.createElement('th');
    th.textContent = t;
    head.appendChild(th);
  });
  table.appendChild(head);
  for (const r of results) {
    const tr = document.createElement('tr');
    [r.name, r.expected, r.measured].forEach((t) => {
      const td = document.createElement('td');
      td.textContent = t;
      tr.appendChild(td);
    });
    const td = document.createElement('td');
    td.textContent = r.pass ? '✓ 通过' : '✗ 失败';
    td.className = r.pass ? 'pass' : 'fail';
    tr.appendChild(td);
    table.appendChild(tr);
  }
  valTableBox.appendChild(table);
}

// --- 导出 ---
el('h2').textContent = '导出 OBJ';
const exportRow = el('div', { class: 'row' });
const exportBtn = document.createElement('button');
exportBtn.textContent = '导出当前管道 .obj';
exportRow.appendChild(exportBtn);
const exportInfo = el('div', { id: 'export-info' });
exportBtn.addEventListener('click', () => {
  if (!pipeData) return;
  const obj = toOBJ(pipeData);
  const blob = new Blob([obj], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'pipe.obj';
  a.click();
  URL.revokeObjectURL(a.href);
  exportInfo.textContent =
    `已导出 pipe.obj：顶点 ${pipeData.vertexCount} · 三角形 ${pipeData.triangleCount}` +
    ` · 文件 ${(obj.length / 1024).toFixed(1)} KB（仅管道网格，不含辅助线）`;
});

// ---------------- 启动 ----------------
buildPointRows();
rebuild();

function onResize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);
onResize();

renderer.setAnimationLoop(() => {
  orbit.update();
  renderer.render(scene, camera);
});
