import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildIntersection } from './geometry/mesh';
import { BuildSuccess, IntersectionParams } from './geometry/types';
import { PRESETS, defaultParams } from './geometry/presets';
import { verifyBuild, CheckResult } from './geometry/verify';
import { serializeExport, verifyExportText } from './geometry/export';
import { LIMITS, branchLabel } from './geometry/validate';

type ViewMode = 'solid' | 'wire' | 'boundary';

let params: IntersectionParams = defaultParams();
let viewMode: ViewMode = 'solid';
let lastValid: BuildSuccess | null = null;
let lastValidParams: IntersectionParams | null = null;
let lastExportText: string | null = null;

// ---------- Three.js 场景 ----------
const wrap = document.getElementById('canvas-wrap')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
wrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x16181d);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
camera.position.set(26, 36, 26);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(20, 40, 10);
scene.add(dirLight);

const grid = new THREE.GridHelper(120, 60, 0x2c3038, 0x22262e);
grid.position.y = -0.02;
scene.add(grid);

const roadMat = new THREE.MeshStandardMaterial({ color: 0x3c4148, roughness: 0.95 });
const wireMat = new THREE.MeshBasicMaterial({ color: 0x9aa4b5, wireframe: true });
const faintMat = new THREE.MeshBasicMaterial({
  color: 0x3c4148,
  transparent: true,
  opacity: 0.15,
  depthWrite: false,
});
const centerLineMat = new THREE.MeshBasicMaterial({ color: 0xf2c94c });
const stopLineMat = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });
const boundaryMat = new THREE.LineBasicMaterial({ color: 0x36d1dc });
const vertexMat = new THREE.PointsMaterial({ color: 0xffb347, size: 0.22 });

let roadGroup: THREE.Group | null = null;

function disposeGroup(g: THREE.Group): void {
  g.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
}

function makeGeometry(data: { positions: Float32Array; indices: Uint32Array }): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geo.computeVertexNormals();
  return geo;
}

function updateScene(r: BuildSuccess): void {
  if (roadGroup) {
    scene.remove(roadGroup);
    disposeGroup(roadGroup);
  }
  roadGroup = new THREE.Group();

  const roadGeo = makeGeometry(r);
  const mat = viewMode === 'wire' ? wireMat : viewMode === 'boundary' ? faintMat : roadMat;
  roadGroup.add(new THREE.Mesh(roadGeo, mat));

  if (viewMode !== 'boundary') {
    roadGroup.add(new THREE.Mesh(makeGeometry(r.centerMarkings), centerLineMat));
    roadGroup.add(new THREE.Mesh(makeGeometry(r.stopMarkings), stopLineMat));
  }

  if (viewMode === 'boundary') {
    const pts = r.outline.map((p) => new THREE.Vector3(p.x, 0.04, p.y));
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    roadGroup.add(new THREE.LineLoop(lineGeo, boundaryMat));
    const ptGeo = new THREE.BufferGeometry().setFromPoints(pts);
    roadGroup.add(new THREE.Points(ptGeo, vertexMat));
  }

  scene.add(roadGroup);
}

function resize(): void {
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ---------- UI ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const statusEl = $('status');
const statsEl = $('stats');
const messagesGroup = $('messages-group');
const messagesEl = $('messages');
const verifyGroup = $('verify-group');
const verifyEl = $('verify');
const btnExport = $('btn-export') as HTMLButtonElement;
const btnAdd = $('btn-add') as HTMLButtonElement;

function setStatus(ok: boolean, text: string): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', !ok);
}

function renderStats(r: BuildSuccess): void {
  const s = r.stats;
  const lines = [
    `顶点 ${s.vertexCount} · 三角形 ${s.triangleCount}`,
    `范围 X [${s.bboxMin[0].toFixed(2)}, ${s.bboxMax[0].toFixed(2)}]`,
    `     Z [${s.bboxMin[2].toFixed(2)}, ${s.bboxMax[2].toFixed(2)}]`,
    `尺寸 ${(s.bboxMax[0] - s.bboxMin[0]).toFixed(2)} × ${(s.bboxMax[2] - s.bboxMin[2]).toFixed(2)}`,
  ];
  statsEl.textContent = lines.join('\n');
}

function renderMessages(errors: string[], warnings: string[]): void {
  const parts: string[] = [];
  for (const e of errors) parts.push(`<div class="err">✗ ${e}</div>`);
  for (const w of warnings) parts.push(`<div class="warn">! ${w}</div>`);
  messagesGroup.style.display = parts.length ? 'block' : 'none';
  messagesEl.innerHTML = parts.join('');
}

function updateBranchInfo(r: BuildSuccess | null): void {
  document.querySelectorAll<HTMLElement>('.branch-info').forEach((el) => {
    const id = el.dataset.branchId;
    const br = r?.branches.find((b) => b.id === id);
    el.textContent = br
      ? `路口边界 ${br.tClear.toFixed(2)} · 停止线 ${br.stopT.toFixed(2)} · 虚线 ${br.dashCount} 段`
      : '—';
  });
}

function rebuild(): void {
  const res = buildIntersection(params);
  if (res.ok) {
    lastValid = res;
    lastValidParams = structuredClone(params);
    updateScene(res);
    renderStats(res);
    renderMessages([], res.warnings);
    setStatus(true, '网格有效 — 当前显示与参数一致');
    updateBranchInfo(res);
  } else {
    renderMessages(res.errors, lastValid?.warnings ?? []);
    setStatus(false, `参数无效（${res.errors.length} 项）— 显示最后有效网格`);
    updateBranchInfo(null);
  }
  btnExport.disabled = !lastValid;
}

// ---------- 分支编辑控件 ----------
function fieldRow(
  label: string,
  min: number,
  max: number,
  step: number,
  get: () => number,
  set: (v: number) => void
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field';
  const lab = document.createElement('span');
  lab.textContent = label;
  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(min);
  range.max = String(max);
  range.step = String(step);
  range.value = String(get());
  const num = document.createElement('input');
  num.type = 'number';
  num.min = String(min);
  num.max = String(max);
  num.step = String(step);
  num.value = String(get());
  range.addEventListener('input', () => {
    set(parseFloat(range.value));
    num.value = range.value;
    rebuild();
  });
  num.addEventListener('input', () => {
    const v = parseFloat(num.value);
    if (Number.isFinite(v)) {
      set(v);
      range.value = String(v);
      rebuild();
    }
  });
  row.append(lab, range, num);
  return row;
}

function renderBranchEditors(): void {
  const list = $('branch-list');
  list.innerHTML = '';
  params.branches.forEach((b, i) => {
    const box = document.createElement('div');
    box.className = 'branch';
    const head = document.createElement('div');
    head.className = 'branch-head';
    const title = document.createElement('b');
    title.textContent = `分支${branchLabel(i)}`;
    head.appendChild(title);
    if (params.branches.length > LIMITS.minBranches) {
      const del = document.createElement('button');
      del.textContent = '删除';
      del.addEventListener('click', () => {
        params.branches.splice(i, 1);
        renderBranchEditors();
        rebuild();
      });
      head.appendChild(del);
    }
    box.appendChild(head);
    box.appendChild(
      fieldRow('方向°', 0, 359, 1, () => b.angleDeg, (v) => (b.angleDeg = v))
    );
    box.appendChild(
      fieldRow('宽度', LIMITS.widthMin, LIMITS.widthMax, 0.1, () => b.width, (v) => (b.width = v))
    );
    box.appendChild(
      fieldRow('长度', LIMITS.lengthMin, LIMITS.lengthMax, 0.5, () => b.length, (v) => (b.length = v))
    );
    const info = document.createElement('div');
    info.className = 'branch-info';
    info.dataset.branchId = b.id;
    box.appendChild(info);
    list.appendChild(box);
  });
  btnAdd.disabled = params.branches.length >= LIMITS.maxBranches;
  updateBranchInfo(lastValid);
}

btnAdd.addEventListener('click', () => {
  if (params.branches.length >= LIMITS.maxBranches) return;
  // 放在最大角度空档的角平分方向
  const angles = params.branches.map((b) => b.angleDeg).sort((a, b2) => a - b2);
  let bestGap = -1;
  let bestAngle = 0;
  for (let i = 0; i < angles.length; i++) {
    const next = angles[(i + 1) % angles.length];
    const gap = ((next - angles[i] + 360) % 360) || 360;
    if (gap > bestGap) {
      bestGap = gap;
      bestAngle = (angles[i] + gap / 2) % 360;
    }
  }
  params.branches.push({
    id: `b${Date.now()}`,
    angleDeg: Math.round(bestAngle),
    width: 3,
    length: 15,
  });
  renderBranchEditors();
  rebuild();
});

// ---------- 预设 / 重置 ----------
const presetRow = $('preset-row');
for (const key of Object.keys(PRESETS)) {
  const preset = PRESETS[key];
  const btn = document.createElement('button');
  btn.textContent = preset.name;
  btn.title = preset.description;
  btn.className = 'secondary';
  btn.addEventListener('click', () => {
    params = structuredClone(preset.params);
    radiusInput.value = String(params.cornerRadius);
    radiusVal.textContent = params.cornerRadius.toFixed(1);
    renderBranchEditors();
    rebuild();
  });
  presetRow.appendChild(btn);
}

$('btn-reset').addEventListener('click', () => {
  params = defaultParams();
  radiusInput.value = String(params.cornerRadius);
  radiusVal.textContent = params.cornerRadius.toFixed(1);
  renderBranchEditors();
  rebuild();
});

// ---------- 转角半径 ----------
const radiusInput = $('radius') as HTMLInputElement;
const radiusVal = $('radius-val');
radiusInput.value = String(params.cornerRadius);
radiusVal.textContent = params.cornerRadius.toFixed(1);
radiusInput.addEventListener('input', () => {
  params.cornerRadius = parseFloat(radiusInput.value);
  radiusVal.textContent = params.cornerRadius.toFixed(1);
  rebuild();
});

// ---------- 视图切换 ----------
document.querySelectorAll<HTMLInputElement>('input[name="view"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    viewMode = radio.value as ViewMode;
    if (lastValid) updateScene(lastValid);
  });
});

// ---------- 导出 / 验证 ----------
btnExport.addEventListener('click', () => {
  if (!lastValid || !lastValidParams) return;
  const text = serializeExport(lastValidParams, lastValid);
  lastExportText = text;
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'intersection-export.json';
  a.click();
  URL.revokeObjectURL(url);
});

function renderChecks(checks: CheckResult[]): void {
  verifyGroup.style.display = 'block';
  verifyEl.innerHTML = checks
    .map(
      (c) =>
        `<div class="check"><span class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'}</span> ` +
        `<b>${c.name}</b><br/><span class="mono">${c.detail}</span></div>`
    )
    .join('');
}

$('btn-verify').addEventListener('click', () => {
  if (!lastValid) {
    renderChecks([{ name: '构建', ok: false, detail: '当前无有效网格可验证' }]);
    return;
  }
  const checks = verifyBuild(lastValid);
  if (lastExportText) {
    checks.push(...verifyExportText(lastExportText));
  } else {
    checks.push({ name: '导出回读核对', ok: true, detail: '尚未导出，点击“导出网格与参数”后自动核对' });
  }
  renderChecks(checks);
});

// ---------- 启动 ----------
renderBranchEditors();
rebuild();
