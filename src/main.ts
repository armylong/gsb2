import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildTank, type SceneGroups } from './scene/tank';
import { visualizeTrace, visualizeSwing, type RayVisual } from './scene/rayView';
import { traceRay, REAL_IOR, type IORSet, type TraceResult } from './physics/tracer';
import { norm, sub, type V3 } from './physics/vector';
import { PLANES } from './physics/geometry';
import { renderIdle, renderResult } from './ui/resultPanel';
import './style.css';

// ---------- 渲染器 / 场景 ----------
const canvas = document.getElementById('gl') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const gl2 = renderer.getContext() as WebGL2RenderingContext;
const badge = document.getElementById('gl-badge')!;
if (gl2 instanceof WebGL2RenderingContext) {
  badge.textContent = 'WebGL2 已启用';
  badge.classList.add('ok');
} else {
  badge.textContent = '当前仅 WebGL1（建议使用现代浏览器）';
  badge.classList.add('bad');
}

const scene = new THREE.Scene();
const groups: SceneGroups = buildTank(scene);

const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 500);
const HOME_POS = new THREE.Vector3(0, 12, 62);
const HOME_TARGET = new THREE.Vector3(0, 7, 0);
camera.position.copy(HOME_POS);

const controls = new OrbitControls(camera, canvas);
controls.target.copy(HOME_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxDistance = 160;
controls.minDistance = 25;
controls.update();

// ---------- 状态 ----------
interface AppState {
  iors: IORSet;
  lastPick: { origin: V3; dir: V3 } | null;
  current: RayVisual | null;
  sweep: {
    active: boolean;
    paused: boolean;
    phi: number;
    height: number;
    target: V3;
    swing: boolean;
  };
}

const state: AppState = {
  iors: { ...REAL_IOR },
  lastPick: null,
  current: null,
  sweep: { active: false, paused: false, phi: 90, height: 12, target: { x: PLANES.rightInner + 0.5, y: 8, z: 0 }, swing: false },
};

const SWEEP_MIN = 34;
const SWEEP_MAX = 76;
const SWEEP_TIR_PHI = 43;
const SWEEP_R = 70;

const resultPanel = document.getElementById('panel-right')!.querySelector('section')! as HTMLElement;
const rayLayer = new THREE.Group();
rayLayer.name = '光线层';
scene.add(rayLayer);
renderIdle(resultPanel);

// ---------- 追踪与可视化 ----------
function clearRay(): void {
  state.current?.dispose();
  while (rayLayer.children.length) {
    const c = rayLayer.children.pop()!;
    rayLayer.remove(c);
  }
  state.current = null;
}

function runTrace(origin: V3, dir: V3): TraceResult {
  return traceRay(origin, dir, state.iors, true);
}

function showTrace(origin: V3, dir: V3): TraceResult {
  clearRay();
  const result = runTrace(origin, dir);
  const showCamera = (document.getElementById('show-camera-ray') as HTMLInputElement).checked;
  const showBaseline = (document.getElementById('compare-baseline') as HTMLInputElement).checked;

  const vis = visualizeTrace(result, { showCameraRay: showCamera });
  rayLayer.add(vis.group);

  if (showBaseline && result.baseline) {
    const baseVis = visualizeTrace(result.baseline, { isBaseline: true });
    rayLayer.add(baseVis.group);
    vis.children.push(baseVis);
  }
  state.current = vis;
  state.lastPick = { origin, dir };
  renderResult(resultPanel, result, state.iors);
  return result;
}

// ---------- 点击拾取 ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downPos: { x: number; y: number } | null = null;

canvas.addEventListener('pointerdown', (e) => {
  downPos = { x: e.clientX, y: e.clientY };
});

canvas.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  downPos = null;
  if (moved > 6 || state.sweep.active) return; // 拖拽旋转不算点选；扫查中由扫查逻辑接管
  pickAndTrace(e.clientX, e.clientY);
});

function pickAndTrace(clientX: number, clientY: number): void {
  pointer.x = (clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(groups.root.children, true);
  const origin: V3 = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
  let dir: V3;
  if (hits.length > 0) {
    const p = hits[0].point;
    dir = norm(sub({ x: p.x, y: p.y, z: p.z }, origin));
  } else {
    // 点到空白处：沿视线取远处一点作为方向，让追踪器自己判断超范围
    const far = new THREE.Vector3();
    raycaster.ray.at(120, far);
    dir = norm(sub({ x: far.x, y: far.y, z: far.z }, origin));
  }
  showTrace(origin, dir);
}

// ---------- 折射率控件 ----------
const sliders = {
  air: document.getElementById('ior-air') as HTMLInputElement,
  glass: document.getElementById('ior-glass') as HTMLInputElement,
  water: document.getElementById('ior-water') as HTMLInputElement,
};
const labels = {
  air: document.getElementById('ior-air-val')!,
  glass: document.getElementById('ior-glass-val')!,
  water: document.getElementById('ior-water-val')!,
};

function syncIorUI(): void {
  sliders.air.value = String(state.iors.air);
  sliders.glass.value = String(state.iors.glass);
  sliders.water.value = String(state.iors.water);
  labels.air.textContent = state.iors.air.toFixed(3);
  labels.glass.textContent = state.iors.glass.toFixed(3);
  labels.water.textContent = state.iors.water.toFixed(3);
}

function onIorChange(): void {
  state.iors = {
    air: parseFloat(sliders.air.value),
    glass: parseFloat(sliders.glass.value),
    water: parseFloat(sliders.water.value),
  };
  syncIorUI();
  retraceCurrent();
}
(Object.keys(sliders) as (keyof typeof sliders)[]).forEach((k) => sliders[k].addEventListener('input', onIorChange));

function retraceCurrent(): void {
  if (!state.lastPick) return;
  if (state.sweep.active) {
    updateSweepTrace();
  } else {
    showTrace(state.lastPick.origin, state.lastPick.dir);
  }
}

function setIors(iors: IORSet): void {
  state.iors = { ...iors };
  syncIorUI();
  retraceCurrent();
}

document.getElementById('preset-real')!.addEventListener('click', () => setIors({ ...REAL_IOR }));
document.getElementById('preset-equal-all')!.addEventListener('click', () =>
  setIors({ air: 1, glass: 1, water: 1 }),
);
document.getElementById('preset-equal-wg')!.addEventListener('click', () =>
  setIors({ air: 1, glass: 1.45, water: 1.45 }),
);

// ---------- 固定样例 ----------
function applyCamera(pos: THREE.Vector3, target: THREE.Vector3): void {
  camera.position.copy(pos);
  controls.target.copy(target);
  controls.update();
}

function samplePreset(camPos: V3, pick: V3): void {
  stopSweep();
  applyCamera(new THREE.Vector3(camPos.x, camPos.y, camPos.z), new THREE.Vector3(pick.x, pick.y, pick.z));
  const dir = norm(sub(pick, camPos));
  showTrace(camPos, dir);
}

document.getElementById('sample-front')!.addEventListener('click', () =>
  samplePreset(
    { x: 0, y: 10, z: 60 },
    { x: 8, y: 6, z: PLANES.frontOuter },
  ),
);
document.getElementById('sample-oblique')!.addEventListener('click', () =>
  samplePreset(
    { x: 35, y: 12, z: 42 },
    { x: -4, y: 6, z: PLANES.frontOuter },
  ),
);

// ---------- 侧扫：折射 → 全反射 ----------
const sweepSlider = document.getElementById('sweep-angle') as HTMLInputElement;
const sweepAngleVal = document.getElementById('sweep-angle-val')!;
const sweepHeight = document.getElementById('sweep-height') as HTMLInputElement;
const sweepHeightVal = document.getElementById('sweep-height-val')!;
const btnSweepStart = document.getElementById('sweep-start') as HTMLButtonElement;
const btnSweepPause = document.getElementById('sweep-pause') as HTMLButtonElement;
const btnSweepTir = document.getElementById('sweep-tir') as HTMLButtonElement;
const swingCheck = document.getElementById('compare-swing') as HTMLInputElement;

function sweepCamera(phi: number, height: number): V3 {
  const r = (phi * Math.PI) / 180;
  return { x: SWEEP_R * Math.sin(r), y: height, z: SWEEP_R * Math.cos(r) };
}

function startSweep(): void {
  state.sweep.active = true;
  state.sweep.paused = false;
  state.sweep.phi = SWEEP_MIN;
  controls.enabled = false;
  sweepSlider.disabled = false;
  btnSweepStart.textContent = '扫查中…';
  btnSweepStart.disabled = true;
  updateSweepTrace();
}

function stopSweep(): void {
  state.sweep.active = false;
  state.sweep.paused = false;
  controls.enabled = true;
  sweepSlider.disabled = true;
  btnSweepStart.textContent = '开始侧扫';
  btnSweepStart.disabled = false;
}

function updateSweepTrace(): void {
  const { phi, height, target, swing } = state.sweep;
  const cam = sweepCamera(phi, height);
  applyCamera(new THREE.Vector3(cam.x, cam.y, cam.z), new THREE.Vector3(target.x, target.y, target.z));
  const dir = norm(sub(target, cam));
  const result = showTrace(cam, dir);

  // 暂停且勾选对比：叠加 φ±1.5° 两条路径
  if (state.sweep.paused && swing) {
    for (const [delta, color] of [
      [-1.5, 0xffcc80],
      [1.5, 0x90caf9],
    ] as const) {
      const phi2 = THREE.MathUtils.clamp(phi + delta, SWEEP_MIN, SWEEP_MAX);
      const cam2 = sweepCamera(phi2, height);
      const dir2 = norm(sub(target, cam2));
      const r2 = runTrace(cam2, dir2);
      const v2 = visualizeSwing(r2, color);
      rayLayer.add(v2.group);
      state.current?.children.push(v2);
    }
  }

  sweepSlider.value = String(phi);
  sweepAngleVal.textContent = `${phi.toFixed(1)}°`;
  const hasTir = result.events.some((e) => e.kind === 'tir');
  sweepAngleVal.style.color = hasTir ? '#ce93d8' : '';
}

btnSweepStart.addEventListener('click', startSweep);
btnSweepPause.addEventListener('click', () => {
  if (!state.sweep.active) return;
  state.sweep.paused = !state.sweep.paused;
  btnSweepPause.textContent = state.sweep.paused ? '继续' : '暂停';
  updateSweepTrace();
});
btnSweepTir.addEventListener('click', () => {
  if (!state.sweep.active) startSweep();
  state.sweep.paused = true;
  state.sweep.phi = SWEEP_TIR_PHI;
  btnSweepPause.textContent = '继续';
  updateSweepTrace();
});
sweepSlider.addEventListener('input', () => {
  state.sweep.phi = parseFloat(sweepSlider.value);
  state.sweep.paused = true;
  btnSweepPause.textContent = '继续';
  updateSweepTrace();
});
sweepHeight.addEventListener('input', () => {
  state.sweep.height = parseFloat(sweepHeight.value);
  sweepHeightVal.textContent = `${state.sweep.height.toFixed(1)} cm`;
  if (state.sweep.active) updateSweepTrace();
});
swingCheck.addEventListener('change', () => {
  state.sweep.swing = swingCheck.checked;
  if (state.sweep.active && state.sweep.paused) updateSweepTrace();
});

// ---------- 显示开关 ----------
(document.getElementById('toggle-grid') as HTMLInputElement).addEventListener('change', (e) =>
  (groups.rulerGroup.visible = (e.target as HTMLInputElement).checked));
(document.getElementById('toggle-blocks') as HTMLInputElement).addEventListener('change', (e) =>
  (groups.blockGroup.visible = (e.target as HTMLInputElement).checked));
(document.getElementById('toggle-frame') as HTMLInputElement).addEventListener('change', (e) =>
  (groups.frameGroup.visible = (e.target as HTMLInputElement).checked));
(document.getElementById('compare-baseline') as HTMLInputElement).addEventListener('change', () => retraceCurrent());
(document.getElementById('show-camera-ray') as HTMLInputElement).addEventListener('change', () => retraceCurrent());

// ---------- 渲染循环 ----------
const clock = new THREE.Clock();
function animate(): void {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const elapsed = clock.elapsedTime;
  if (state.sweep.active && !state.sweep.paused) {
    // 40 秒扫完全程，到末端自动停
    const speed = (SWEEP_MAX - SWEEP_MIN) / 40;
    state.sweep.phi = Math.min(SWEEP_MAX, state.sweep.phi + dt * speed);
    updateSweepTrace();
    if (state.sweep.phi >= SWEEP_MAX) {
      state.sweep.paused = true;
      btnSweepPause.textContent = '继续';
    }
  }
  controls.update();
  updatePulseMarkers(elapsed);
  renderer.render(scene, camera);
}

/** 超范围红环：始终面向相机 + 呼吸脉冲 */
function updatePulseMarkers(t: number): void {
  rayLayer.traverse((obj) => {
    const ring = obj as THREE.Mesh;
    if (ring.userData?.billboard) {
      ring.quaternion.copy(camera.quaternion);
      const s = 1 + 0.18 * Math.sin(t * 4);
      ring.scale.setScalar(s);
      const m = ring.material as THREE.MeshBasicMaterial;
      m.opacity = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t * 4));
    }
  });
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// 启动后自动跑一次正视样例，画面不空
window.setTimeout(() => (document.getElementById('sample-front') as HTMLButtonElement).click(), 250);
