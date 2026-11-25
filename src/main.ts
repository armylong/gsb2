import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  DISK_RADIUS,
  FIXED_DT,
  HOME_POSITION,
  MagneticSimulation,
  PERCH_POSITION,
  SIDE_VIEW_RIGHT,
  SIDE_VIEW_UP,
  type Panel,
} from './sim.ts';
import { pilotInput, runAllChecks, type CheckResult } from './checks.ts';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <canvas id="scene"></canvas>

  <section id="hud" class="panel">
    <h1>磁吸面板 · 外角调换试验</h1>
    <p class="subtitle">
      圆盘沿直角吸附面运动；公共边会换面并旋转世界空间速度。WASD / 方向键按当前镜头投影到接触面。
    </p>

    <div class="row" style="margin-bottom:10px">
      <span id="statusBadge" class="badge attached"><span class="dot"></span><span id="statusText">吸附中</span></span>
    </div>

    <div class="row">
      <button id="resetBtn" class="secondary">重置 R</button>
      <button id="pauseBtn" class="secondary">暂停 P</button>
      <button id="detachBtn" class="danger">主动脱离 Space</button>
      <button id="attachBtn" class="good">重新吸附 F</button>
    </div>

    <h2>内置验证</h2>
    <div class="row">
      <button id="routeBtn">播放外角路线</button>
      <button id="dropBtn">演示脱离回落</button>
      <button id="checkBtn" class="good">运行确定性自检</button>
    </div>
    <div id="checkResults" style="margin-top:8px">
      <div class="muted" style="font-size:12px">尚未运行自检。自检会验证两个外角、速度旋转、抖动稳定性和回落起点。</div>
    </div>

    <h2>镜头参照</h2>
    <div class="row">
      <button data-view="perspective">透视 1</button>
      <button data-view="top">顶面 2</button>
      <button data-view="side">侧面 3</button>
    </div>

    <h2>操作</h2>
    <div class="keys">
      <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><span>相对镜头/接触面移动</span>
      <span><kbd>Space</kbd></span><span>关闭磁吸并脱离</span>
      <span><kbd>F</kbd></span><span>尝试吸附到稳定候选面</span>
      <span><kbd>P</kbd></span><span>暂停 / 继续，暂停时可环绕检查</span>
      <span><kbd>R</kbd></span><span>重置到起点</span>
      <span><kbd>鼠标</kbd></span><span>拖拽环绕、滚轮缩放</span>
    </div>
  </section>

  <aside id="inspector" class="panel">
    <h2 style="margin-top:0">暂停检查器</h2>
    <div class="stat-grid">
      <div class="k">接触面</div><div class="v" id="statPanel">—</div>
      <div class="k">稳定候选</div><div class="v" id="statStable">—</div>
      <div class="k">位置</div><div class="v" id="statPos">—</div>
      <div class="k">速度</div><div class="v" id="statVel">—</div>
      <div class="k">速率</div><div class="v" id="statSpeed">—</div>
      <div class="k">朝向</div><div class="v" id="statHeading">—</div>
      <div class="k">法向</div><div class="v" id="statNormal">—</div>
      <div class="k">面内坐标</div><div class="v" id="statLocal">—</div>
      <div class="k">换面锁定</div><div class="v" id="statCooldown">—</div>
    </div>

    <h2>最近换面前后速度</h2>
    <div id="switchInfo" class="muted" style="font-size:12px;line-height:1.5">尚未换面。</div>

    <h2>事件记录</h2>
    <div id="eventLog" class="event-log"></div>
  </aside>

  <div id="pauseOverlay" class="hidden">已暂停</div>
`;

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const statusBadge = document.querySelector<HTMLSpanElement>('#statusBadge')!;
const statusText = document.querySelector<HTMLSpanElement>('#statusText')!;
const pauseOverlay = document.querySelector<HTMLDivElement>('#pauseOverlay')!;
const checkResults = document.querySelector<HTMLDivElement>('#checkResults')!;

const statPanel = document.querySelector<HTMLDivElement>('#statPanel')!;
const statStable = document.querySelector<HTMLDivElement>('#statStable')!;
const statPos = document.querySelector<HTMLDivElement>('#statPos')!;
const statVel = document.querySelector<HTMLDivElement>('#statVel')!;
const statSpeed = document.querySelector<HTMLDivElement>('#statSpeed')!;
const statHeading = document.querySelector<HTMLDivElement>('#statHeading')!;
const statNormal = document.querySelector<HTMLDivElement>('#statNormal')!;
const statLocal = document.querySelector<HTMLDivElement>('#statLocal')!;
const statCooldown = document.querySelector<HTMLDivElement>('#statCooldown')!;
const switchInfo = document.querySelector<HTMLDivElement>('#switchInfo')!;
const eventLog = document.querySelector<HTMLDivElement>('#eventLog')!;

const sim = new MagneticSimulation();

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07111f);
scene.fog = new THREE.Fog(0x07111f, 15, 34);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(-8.2, 6.4, 10.2);

const controls = new OrbitControls(camera, canvas);
controls.target.set(-2.1, 2.05, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxDistance = 24;
controls.minDistance = 3;
controls.update();

scene.add(new THREE.HemisphereLight(0xbae6fd, 0x0f172a, 1.45));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-5, 10, 7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -10;
sun.shadow.camera.right = 8;
sun.shadow.camera.top = 9;
sun.shadow.camera.bottom = -4;
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 28;
scene.add(sun);

const base = new THREE.Mesh(
  new THREE.PlaneGeometry(24, 16),
  new THREE.MeshStandardMaterial({ color: 0x081827, roughness: 0.95 }),
);
base.rotation.x = -Math.PI / 2;
base.position.set(-2, -0.035, 0);
base.receiveShadow = true;
scene.add(base);

const grid = new THREE.GridHelper(22, 22, 0x1d5d7a, 0x12324a);
grid.position.set(-2, -0.025, 0);
scene.add(grid);

const axes = new THREE.AxesHelper(1.35);
axes.position.set(-7.55, 0.04, 2.55);
scene.add(axes);
const axisLabelX = makeLabel('X', '#fca5a5');
axisLabelX.scale.set(0.42, 0.28, 1);
axisLabelX.position.set(-6.05, 0.08, 2.55);
scene.add(axisLabelX);
const axisLabelY = makeLabel('Y', '#86efac');
axisLabelY.scale.set(0.42, 0.28, 1);
axisLabelY.position.set(-7.55, 1.55, 2.55);
scene.add(axisLabelY);
const axisLabelZ = makeLabel('Z', '#93c5fd');
axisLabelZ.scale.set(0.42, 0.28, 1);
axisLabelZ.position.set(-7.55, 0.08, 4.05);
scene.add(axisLabelZ);

function makeLabel(text: string, color = '#dff7ff'): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(6, 18, 34, 0.82)';
  ctx.fillRect(8, 18, canvas.width - 16, canvas.height - 36);
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.42)';
  ctx.lineWidth = 4;
  ctx.strokeRect(8, 18, canvas.width - 16, canvas.height - 36);
  ctx.font = '700 46px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(3.05, 0.68, 1);
  sprite.renderOrder = 20;
  return sprite;
}

const panelMaterials = new Map<string, THREE.MeshStandardMaterial>();

function addPanelMesh(p: Panel): THREE.Sprite {
  const geometry = new THREE.BoxGeometry(p.halfU * 2, p.halfV * 2, 0.12);
  const material = new THREE.MeshStandardMaterial({
    color: p.color,
    roughness: 0.56,
    metalness: 0.12,
    transparent: true,
    opacity: 0.86,
    emissive: p.color,
    emissiveIntensity: 0.08,
  });
  panelMaterials.set(p.id, material);
  const mesh = new THREE.Mesh(geometry, material);
  const basis = new THREE.Matrix4().makeBasis(p.u, p.v, p.n);
  mesh.quaternion.setFromRotationMatrix(basis);
  mesh.position.copy(p.center).addScaledVector(p.n, -0.06);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0xe0f2fe, transparent: true, opacity: 0.38 }),
  );
  mesh.add(edges);
  scene.add(mesh);

  const label = makeLabel(`${p.name} · 吸力 ${Math.round(p.suction * 100)}`);
  label.position.copy(p.center).addScaledVector(p.n, 0.62);
  scene.add(label);
  return label;
}

const panelLabels = new Map<string, THREE.Sprite>();
sim.panels.forEach((p) => panelLabels.set(p.id, addPanelMesh(p)));
panelLabels.get('floor')!.position.set(-2.2, 0.22, 2.48);
panelLabels.get('floor')!.scale.set(2.7, 0.6, 1);

const blockerMaterial = new THREE.MeshStandardMaterial({
  color: sim.blocker.color,
  roughness: 0.62,
  metalness: 0.08,
  transparent: true,
  opacity: 0.88,
  emissive: 0x7f1d1d,
  emissiveIntensity: 0.35,
});
const blockerMesh = new THREE.Mesh(
  new THREE.BoxGeometry(sim.blocker.size.x, sim.blocker.size.y, sim.blocker.size.z),
  blockerMaterial,
);
blockerMesh.position.copy(sim.blocker.center);
blockerMesh.castShadow = true;
blockerMesh.receiveShadow = true;
blockerMesh.add(
  new THREE.LineSegments(
    new THREE.EdgesGeometry(blockerMesh.geometry),
    new THREE.LineBasicMaterial({ color: 0xfecaca, transparent: true, opacity: 0.7 }),
  ),
);
scene.add(blockerMesh);
const blockerLabel = makeLabel('禁止吸附隔板', '#fecaca');
blockerLabel.position.copy(sim.blocker.center).add(new THREE.Vector3(0, 1.05, 0));
scene.add(blockerLabel);

// Dashed missing face placeholder on the lower w1 segment.
const missingBasis = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(1, 0, 0),
);
const missingGeo = new THREE.BoxGeometry(1.4, 3, 0.05);
const missingMat = new THREE.MeshStandardMaterial({
  color: 0xef4444,
  transparent: true,
  opacity: 0.13,
  roughness: 0.8,
  depthWrite: false,
  emissive: 0xef4444,
  emissiveIntensity: 0.25,
});
const missingMesh = new THREE.Mesh(missingGeo, missingMat);
missingMesh.position.set(1, 0.7, 0);
missingMesh.quaternion.setFromRotationMatrix(missingBasis);
const missingEdges = new THREE.LineSegments(
  new THREE.EdgesGeometry(missingGeo),
  new THREE.LineDashedMaterial({ color: 0xfca5a5, dashSize: 0.16, gapSize: 0.1 }),
);
missingEdges.computeLineDistances();
missingMesh.add(missingEdges);
const crossGeometry = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(-0.7, -1.5, 0.04),
  new THREE.Vector3(0.7, 1.5, 0.04),
  new THREE.Vector3(0.7, -1.5, 0.04),
  new THREE.Vector3(-0.7, 1.5, 0.04),
]);
missingMesh.add(
  new THREE.LineSegments(
    crossGeometry,
    new THREE.LineBasicMaterial({ color: 0xf87171, transparent: true, opacity: 0.9 }),
  ),
);
scene.add(missingMesh);
const missingLabel = makeLabel('缺面：不会吸附', '#fecaca');
missingLabel.position.set(1.65, 0.72, 0);
scene.add(missingLabel);

function addRingMarker(position: THREE.Vector3, normal: THREE.Vector3, color: number): THREE.Mesh {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.32, 0.46, 64),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }),
  );
  ring.position.copy(position);
  ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());
  scene.add(ring);
  return ring;
}

const homeRing = addRingMarker(
  new THREE.Vector3(HOME_POSITION.x, 0.035, HOME_POSITION.z),
  new THREE.Vector3(0, 1, 0),
  0x4ade80,
);
homeRing.rotation.x = -Math.PI / 2;
const homeLabel = makeLabel('起点 / 回落区', '#bbf7d0');
homeLabel.position.set(HOME_POSITION.x, 0.42, -0.72);
scene.add(homeLabel);

const w0 = sim.panelById.get('w0')!;
addRingMarker(
  PERCH_POSITION.clone().addScaledVector(w0.n, -DISK_RADIUS + 0.035),
  w0.n,
  0x22d3ee,
);
const perchLabel = makeLabel('脱离回落点', '#a5f3fc');
perchLabel.position.copy(PERCH_POSITION).add(new THREE.Vector3(-0.72, 0.42, 0));
scene.add(perchLabel);

const dropLineGeometry = new THREE.BufferGeometry().setFromPoints([
  PERCH_POSITION.clone().addScaledVector(w0.n, -DISK_RADIUS + 0.05),
  new THREE.Vector3(HOME_POSITION.x, 0.08, HOME_POSITION.z),
]);
const dropLine = new THREE.Line(
  dropLineGeometry,
  new THREE.LineDashedMaterial({ color: 0x4ade80, dashSize: 0.16, gapSize: 0.11 }),
);
dropLine.computeLineDistances();
scene.add(dropLine);

const routePoints = [
  new THREE.Vector3(HOME_POSITION.x, 0.34, 0),
  new THREE.Vector3(-5.28, 2.25, 0),
  new THREE.Vector3(-5.28, 3.72, 0),
  new THREE.Vector3(-5, 4.34, 0),
  new THREE.Vector3(1, 4.34, 0),
  new THREE.Vector3(1.28, 3.72, 0),
  new THREE.Vector3(1.28, 2.75, 0),
];
const routeLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints(routePoints),
  new THREE.LineDashedMaterial({ color: 0xfde047, dashSize: 0.2, gapSize: 0.13, transparent: true, opacity: 0.8 }),
);
routeLine.computeLineDistances();
scene.add(routeLine);

for (const [position, text] of [
  [new THREE.Vector3(-5.35, 4.45, 0), '外角 1'],
  [new THREE.Vector3(1.38, 4.45, 0), '外角 2'],
] as const) {
  const diamond = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.14),
    new THREE.MeshStandardMaterial({ color: 0xfacc15, emissive: 0xca8a04, emissiveIntensity: 0.7 }),
  );
  diamond.position.copy(position);
  scene.add(diamond);
  const label = makeLabel(text, '#fef08a');
  label.scale.set(1.55, 0.38, 1);
  label.position.copy(position).add(new THREE.Vector3(0, 0.34, 0));
  scene.add(label);
}

// Disk: logical origin is the sphere-radius contact offset; the thin puck body sits just above the plane.
const disk = new THREE.Group();
scene.add(disk);
const body = new THREE.Mesh(
  new THREE.CylinderGeometry(0.31, 0.31, 0.14, 56),
  new THREE.MeshStandardMaterial({
    color: 0xf8fafc,
    metalness: 0.58,
    roughness: 0.2,
    emissive: 0x0284c7,
    emissiveIntensity: 0.2,
  }),
);
body.position.y = -0.21;
body.castShadow = true;
disk.add(body);

const rim = new THREE.Mesh(
  new THREE.TorusGeometry(0.31, 0.026, 12, 64),
  new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0284c7, emissiveIntensity: 0.45 }),
);
rim.rotation.x = Math.PI / 2;
rim.position.y = -0.137;
disk.add(rim);

const stripe = new THREE.Mesh(
  new THREE.BoxGeometry(0.34, 0.026, 0.09),
  new THREE.MeshStandardMaterial({ color: 0xfb923c, emissive: 0xc2410c, emissiveIntensity: 0.5 }),
);
stripe.position.set(0.12, -0.126, 0);
disk.add(stripe);

const nose = new THREE.Mesh(
  new THREE.ConeGeometry(0.065, 0.18, 24),
  new THREE.MeshStandardMaterial({ color: 0xfdba74, emissive: 0xc2410c, emissiveIntensity: 0.35 }),
);
nose.rotation.z = -Math.PI / 2;
nose.position.set(0.34, -0.126, 0);
disk.add(nose);

const contactMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.06, 20, 12),
  new THREE.MeshBasicMaterial({ color: 0xfde047 }),
);
scene.add(contactMarker);

const velocityArrow = new THREE.ArrowHelper(
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(),
  1,
  0xfde047,
  0.2,
  0.11,
);
scene.add(velocityArrow);

const inputArrow = new THREE.ArrowHelper(
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(),
  0.8,
  0x22d3ee,
  0.17,
  0.09,
);
scene.add(inputArrow);

const normalArrow = new THREE.ArrowHelper(
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(),
  0.85,
  0xf472b6,
  0.16,
  0.09,
);
scene.add(normalArrow);

const trailGeometry = new THREE.BufferGeometry();
const trail = new THREE.Line(
  trailGeometry,
  new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.88 }),
);
scene.add(trail);
let trailPoints: THREE.Vector3[] = [];
function clearTrail(): void {
  trailPoints = [];
  trail.geometry.setFromPoints([]);
}
function pushTrail(): void {
  trailPoints.push(sim.position.clone());
  if (trailPoints.length > 210) trailPoints.shift();
  trail.geometry.setFromPoints(trailPoints);
}

type ViewId = 'perspective' | 'top' | 'side';
const viewPresets: Record<ViewId, { position: THREE.Vector3; target: THREE.Vector3 }> = {
  perspective: { position: new THREE.Vector3(-8.2, 6.4, 10.2), target: new THREE.Vector3(-2.1, 2.05, 0) },
  top: { position: new THREE.Vector3(-2.1, 12.5, 0.01), target: new THREE.Vector3(-2.1, 2, 0) },
  side: { position: new THREE.Vector3(-2.1, 2.35, 12.5), target: new THREE.Vector3(-2.1, 2.05, 0) },
};
let cameraTween: { elapsed: number; fromPosition: THREE.Vector3; fromTarget: THREE.Vector3; id: ViewId } | null = null;

function setView(id: ViewId): void {
  cameraTween = {
    elapsed: 0,
    fromPosition: camera.position.clone(),
    fromTarget: controls.target.clone(),
    id,
  };
}

document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.view as ViewId));
});

let paused = false;
let autopilot: 'route' | 'drop' | null = null;

function setPaused(value: boolean): void {
  paused = value;
  pauseOverlay.classList.toggle('hidden', !paused);
  document.querySelector<HTMLButtonElement>('#pauseBtn')!.textContent = paused ? '继续 P' : '暂停 P';
}

function resetSimulation(): void {
  sim.reset('home');
  autopilot = null;
  clearTrail();
  setPaused(false);
}

document.querySelector<HTMLButtonElement>('#resetBtn')!.addEventListener('click', resetSimulation);
document.querySelector<HTMLButtonElement>('#pauseBtn')!.addEventListener('click', () => setPaused(!paused));
document.querySelector<HTMLButtonElement>('#detachBtn')!.addEventListener('click', () => sim.detach('按钮：主动脱离'));
document.querySelector<HTMLButtonElement>('#attachBtn')!.addEventListener('click', () => sim.tryAttach());
document.querySelector<HTMLButtonElement>('#routeBtn')!.addEventListener('click', () => {
  sim.reset('home');
  clearTrail();
  setPaused(false);
  autopilot = 'route';
  setView('side');
});
document.querySelector<HTMLButtonElement>('#dropBtn')!.addEventListener('click', () => {
  sim.reset('home');
  clearTrail();
  setPaused(false);
  autopilot = 'drop';
  setView('side');
});
document.querySelector<HTMLButtonElement>('#checkBtn')!.addEventListener('click', () => {
  renderChecks(runAllChecks());
});

function renderChecks(results: CheckResult[]): void {
  checkResults.innerHTML = results
    .map(
      (r) => `
      <div class="check ${r.pass ? '' : 'fail'}">
        <div class="check-title">${r.pass ? '✅' : '❌'} ${r.label}</div>
        <div>${r.detail}</div>
      </div>`,
    )
    .join('');
}

const pressed = new Set<string>();
function readInput() {
  return {
    x: (pressed.has('KeyD') || pressed.has('ArrowRight') ? 1 : 0) -
      (pressed.has('KeyA') || pressed.has('ArrowLeft') ? 1 : 0),
    y: (pressed.has('KeyW') || pressed.has('ArrowUp') ? 1 : 0) -
      (pressed.has('KeyS') || pressed.has('ArrowDown') ? 1 : 0),
  };
}

window.addEventListener('keydown', (event) => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) event.preventDefault();
  if (!event.repeat) {
    if (event.code === 'Space') sim.detach('Space：主动脱离');
    if (event.code === 'KeyR') resetSimulation();
    if (event.code === 'KeyP') setPaused(!paused);
    if (event.code === 'KeyF') sim.tryAttach();
    if (event.code === 'Digit1') setView('perspective');
    if (event.code === 'Digit2') setView('top');
    if (event.code === 'Digit3') setView('side');
  }
  if (event.code.startsWith('Key') || event.code.startsWith('Arrow')) autopilot = null;
  pressed.add(event.code);
});
window.addEventListener('keyup', (event) => pressed.delete(event.code));
window.addEventListener('blur', () => pressed.clear());

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

function formatVector(v: THREE.Vector3): string {
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
}

let uiAccumulator = 0;
const visualNormal = new THREE.Vector3(0, 1, 0);
const basisMatrix = new THREE.Matrix4();
const zBasis = new THREE.Vector3();

function currentTargetNormal(): THREE.Vector3 {
  if (sim.mode === 'switching' && sim.transition) {
    const rule = sim.transition.rule;
    const from = sim.panelById.get(rule.fromPanelId)!;
    const to = sim.panelById.get(rule.toPanelId)!;
    const t = THREE.MathUtils.clamp(sim.transition.elapsed / sim.transition.duration, 0, 1);
    return from.n.clone().lerp(to.n, t).normalize();
  }
  const p = sim.panel();
  if (p) return p.n.clone();
  const lastPanelId = sim.lastDetach?.panelId;
  return (lastPanelId ? sim.panelById.get(lastPanelId)?.n : null)?.clone() ?? visualNormal.clone();
}

function updateDiskVisual(frameDt: number): void {
  const targetNormal = currentTargetNormal();
  visualNormal.lerp(targetNormal, 1 - Math.exp(-20 * frameDt)).normalize();
  const heading = sim.heading.clone();
  if (heading.lengthSq() < 1e-6) heading.set(1, 0, 0);
  heading.normalize();
  zBasis.crossVectors(heading, visualNormal).normalize();
  if (zBasis.lengthSq() < 1e-6) zBasis.set(0, 0, 1);
  basisMatrix.makeBasis(heading, visualNormal, zBasis);
  disk.quaternion.setFromRotationMatrix(basisMatrix);
  disk.position.copy(sim.position);

  const contact = sim.position.clone().addScaledVector(visualNormal, -DISK_RADIUS);
  contactMarker.position.copy(contact);
  normalArrow.position.copy(contact);
  normalArrow.setDirection(visualNormal);

  const speed = sim.velocity.length();
  velocityArrow.visible = speed > 0.06;
  if (velocityArrow.visible) {
    velocityArrow.position.copy(sim.position);
    velocityArrow.setDirection(sim.velocity.clone().normalize());
    velocityArrow.setLength(0.32 + Math.min(speed, 4) * 0.22, 0.2, 0.11);
  }

  const showInput = sim.mode === 'attached' && sim.inputDirection.lengthSq() > 0.02;
  inputArrow.visible = showInput;
  if (showInput) {
    inputArrow.position.copy(sim.position).addScaledVector(visualNormal, 0.08);
    inputArrow.setDirection(sim.inputDirection.clone().normalize());
    inputArrow.setLength(0.82, 0.17, 0.09);
  }

  panelMaterials.forEach((material, id) => {
    material.emissiveIntensity = id === sim.panelId ? 0.58 : id === sim.stableFaceId ? 0.28 : 0.08;
  });
}

function updateInspector(): void {
  const p = sim.panel();
  const modeLabel = sim.mode === 'attached' ? '吸附移动' : sim.mode === 'switching' ? '换面中' : '脱离/重力';
  statusText.textContent = modeLabel;
  statusBadge.className = `badge ${sim.mode}`;

  statPanel.textContent = p ? `${p.name}（${p.id}）` : sim.transition ? '换面过渡中' : '无接触面（自由）';
  statStable.textContent = sim.stableFaceId
    ? `${sim.stableFaceId}${sim.stableCandidateId ? `；候选 ${sim.stableCandidateId} 稳定计时 ${sim.stableTimer.toFixed(2)}s` : '；无摇摆候选'}`
    : '无';
  statPos.textContent = formatVector(sim.position);
  statVel.textContent = formatVector(sim.velocity);
  statSpeed.textContent = `${sim.velocity.length().toFixed(3)} m/s`;
  statHeading.textContent = formatVector(sim.heading);
  statNormal.textContent = p ? formatVector(p.n) : formatVector(visualNormal);
  statLocal.textContent = p ? `U=${sim.localU.toFixed(2)} / ±${p.halfU}，V=${sim.localV.toFixed(2)} / ±${p.halfV}` : '—';
  statCooldown.textContent = sim.switchCooldown > 0 ? `${sim.switchCooldown.toFixed(2)} s 防回切` : '可换面';

  if (sim.lastSwitch) {
    const r = sim.lastSwitch;
    switchInfo.innerHTML = `
      <div style="color:#fde68a;font-weight:700">${r.outer ? '外角' : '直角'}：${r.label}</div>
      <div>前：${formatVector(r.before)}，|v|=${r.beforeSpeed.toFixed(3)}</div>
      <div>后：${formatVector(r.after)}，|v|=${r.afterSpeed.toFixed(3)}</div>
      <div>速度模长变化：${Math.abs(r.afterSpeed - r.beforeSpeed).toExponential(2)}（理想换面为 0）</div>
    `;
  }

  eventLog.innerHTML = sim.events
    .slice(-14)
    .reverse()
    .map((e) => `<div class="event ${e.type}">[${e.time.toFixed(2)}s] ${e.message}</div>`)
    .join('');
}

const clock = new THREE.Clock();
const frameRight = new THREE.Vector3();
const frameUp = new THREE.Vector3();
let accumulator = 0;

function animate(): void {
  requestAnimationFrame(animate);
  const frameDt = Math.min(clock.getDelta(), 0.1);

  if (cameraTween) {
    cameraTween.elapsed += frameDt;
    const preset = viewPresets[cameraTween.id];
    const t = Math.min(1, cameraTween.elapsed / 0.65);
    const eased = t * t * (3 - 2 * t);
    camera.position.lerpVectors(cameraTween.fromPosition, preset.position, eased);
    controls.target.lerpVectors(cameraTween.fromTarget, preset.target, eased);
    if (t >= 1) cameraTween = null;
  }

  controls.update();
  camera.updateMatrixWorld();
  frameRight.setFromMatrixColumn(camera.matrixWorld, 0);
  frameUp.setFromMatrixColumn(camera.matrixWorld, 1);

  if (!paused) {
    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < 8) {
      let input = readInput();
      // Scripted verification uses the side/cross-section reference even if the user
      // moves the inspection camera to a top view. Manual input always uses the camera.
      const inputRight = autopilot ? SIDE_VIEW_RIGHT : frameRight;
      const inputUp = autopilot ? SIDE_VIEW_UP : frameUp;
      if (autopilot) input = pilotInput(sim);

      if (
        autopilot === 'drop' &&
        sim.panelId === 'w0' &&
        sim.mode === 'attached' &&
        sim.position.y >= 2.18
      ) {
        sim.velocity.set(0, 0, 0);
        sim.detach('自动演示：起点正上方脱离', 0);
        autopilot = null;
        input = { x: 0, y: 0 };
      }

      sim.step(FIXED_DT, input, inputRight, inputUp);
      pushTrail();
      accumulator -= FIXED_DT;
      steps += 1;
    }
    if (steps >= 8) accumulator = 0;
  }

  updateDiskVisual(frameDt);
  uiAccumulator += frameDt;
  if (uiAccumulator > 0.08) {
    updateInspector();
    uiAccumulator = 0;
  }

  renderer.render(scene, camera);
}

updateInspector();
animate();
