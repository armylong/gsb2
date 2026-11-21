import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { buildDiagnosticTexture, buildWeightsLUT } from './textures';
import { fragmentShader, vertexShader, VIEW_MODES, SPACE_MODES, DEFAULT_PARAMS } from './shaders';
import { GEOMETRY_FACTORIES, type GeometryName } from './geometry';
import { triplanarWeights, sampleCoordinates, AXIS_NAMES, type Vec3 } from './triplanar';

// ---------- 渲染器 / 场景 ----------
const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e12);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
camera.position.set(7, 6, 9);

const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;

// 参考网格 + 世界轴
scene.add(new THREE.GridHelper(20, 20, 0x33506e, 0x1c2b3a));
const worldAxes = new THREE.AxesHelper(2.5);
scene.add(worldAxes);

// ---------- 程序纹理 ----------
const texX = buildDiagnosticTexture('X');
const texY = buildDiagnosticTexture('Y');
const texZ = buildDiagnosticTexture('Z');
const weightLUT = buildWeightsLUT();

// ---------- ShaderMaterial ----------
const uniforms = {
  texX: { value: texX },
  texY: { value: texY },
  texZ: { value: texZ },
  weightLUT: { value: weightLUT },
  sharpness: { value: DEFAULT_PARAMS.sharpness },
  biases: { value: new THREE.Vector3(...DEFAULT_PARAMS.biases) },
  uvScale: { value: DEFAULT_PARAMS.uvScale },
  uvOffset: { value: new THREE.Vector2(...DEFAULT_PARAMS.uvOffset) },
  spaceMode: { value: DEFAULT_PARAMS.spaceMode },
  viewMode: { value: DEFAULT_PARAMS.viewMode },
  bandThreshold: { value: DEFAULT_PARAMS.bandThreshold },
  showBand: { value: DEFAULT_PARAMS.showBand },
  showBackface: { value: DEFAULT_PARAMS.showBackface },
  // 三轴轻微色偏，混合时仍能分辨来源轴
  tintX: { value: new THREE.Color(1.0, 0.86, 0.78) },
  tintY: { value: new THREE.Color(0.84, 1.0, 0.88) },
  tintZ: { value: new THREE.Color(0.78, 0.92, 1.0) },
};

const material = new THREE.ShaderMaterial({
  uniforms,
  vertexShader,
  fragmentShader,
  side: THREE.DoubleSide,
});

// ---------- 模型（带一个“反向法线演示”三角片）----------
let mesh: THREE.Mesh;
let backfacePatch: THREE.Mesh | null = null;

function buildMesh(name: GeometryName) {
  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
  }
  const geo = GEOMETRY_FACTORIES[name]();
  mesh = new THREE.Mesh(geo, material);
  scene.add(mesh);
  transform.attach(mesh);
  clearMarker();
}

function buildBackfacePatch() {
  if (backfacePatch) {
    scene.remove(backfacePatch);
    backfacePatch.geometry.dispose();
    backfacePatch = null;
  }
  const cb = document.getElementById('backfaceDemo') as HTMLInputElement | null;
  if (!cb) return;
  const on = cb.checked;
  if (!on) return;
  // 一块法线刻意朝下 (-Y) 的三角片，悬在墙角上方，用来观察红色斜纹
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        0.6, 1.4, 0.6,
        1.8, 1.4, 0.6,
        1.2, 1.4, 1.8,
      ],
      3,
    ),
  );
  g.computeVertexNormals(); // 朝上
  // 翻转索引 => 法线反向（从上方看即为背面）
  g.setIndex([0, 2, 1]);
  g.computeVertexNormals();
  backfacePatch = new THREE.Mesh(g, material);
  scene.add(backfacePatch);
}

// ---------- TransformControls ----------
// three 0.187 起 TransformControls 继承 Controls（非 Object3D），
// 可视 gizmo 通过 getHelper() 取得后再加入场景。
const transform = new TransformControls(camera, renderer.domElement);
transform.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !(e.value as boolean);
});
scene.add(transform.getHelper());

// ---------- 点选诊断 ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let marker: THREE.Group | null = null;
let downXY: [number, number] | null = null;

// 必须在 marker 声明之后构建（buildMesh 内部会调用 clearMarker）
buildMesh('ramp');
buildBackfacePatch();

function makeLabelSprite(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 96;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(10,14,20,0.85)';
  ctx.fillRect(0, 0, 256, 96);
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 250, 90);
  ctx.fillStyle = color;
  ctx.font = 'bold 56px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 50);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(0.9, 0.34, 1);
  return sp;
}

function clearMarker() {
  if (!marker) return;
  scene.remove(marker);
  marker = null;
}

const AXIS_COLORS = ['#ff8a5c', '#8ee6a0', '#5cd6ff'];

function placeMarker(point: THREE.Vector3, axis: number, isBackface: boolean) {
  clearMarker();
  marker = new THREE.Group();
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 20, 20),
    new THREE.MeshBasicMaterial({ color: isBackface ? 0xff4d4d : new THREE.Color(AXIS_COLORS[axis]) }),
  );
  marker.add(sphere);
  const label = makeLabelSprite(`${AXIS_NAMES[axis]}${isBackface ? ' 反向' : ''}`, isBackface ? '#ff6b6b' : AXIS_COLORS[axis]);
  label.position.y = 0.32;
  marker.add(label);
  marker.position.copy(point);
  scene.add(marker);
}

function updateReadout(
  hit: THREE.Intersection,
  pointWorld: Vec3,
  normalWorld: Vec3,
  pointLocal: Vec3,
  normalLocal: Vec3,
  isBackface: boolean,
) {
  const el = document.getElementById('readout')!;
  const worldSpace = uniforms.spaceMode.value === SPACE_MODES.WORLD;
  const p = worldSpace ? pointWorld : pointLocal;
  const n = worldSpace ? normalWorld : normalLocal;

  const result = triplanarWeights(p, n, {
    biases: uniforms.biases.value as unknown as Vec3,
    sharpness: uniforms.sharpness.value as number,
  });
  const scale = uniforms.uvScale.value as number;
  const offset = { x: (uniforms.uvOffset.value as THREE.Vector2).x, y: (uniforms.uvOffset.value as THREE.Vector2).y, z: 0 };

  const fmt = (v: number) => v.toFixed(3);
  const rows = result.axes
    .map((a, i) => {
      const suv = sampleCoordinates(a.uv, scale, offset);
      const cls = i === result.dominantAxis ? 'class="dominant"' : '';
      return `<tr ${cls}>
        <td>${AXIS_NAMES[i]} 轴 (n${a.sign < 0 ? '−' : '+'})</td>
        <td>w=${a.weight.toFixed(3)}</td>
        <td>uv=(${fmt(suv[0])}, ${fmt(suv[1])})</td>
      </tr>`;
    })
    .join('');

  const band = result.maxWeight < (uniforms.bandThreshold.value as number);
  el.innerHTML = `
    <table>
      <tr><td>附着空间</td><td colspan="2">${worldSpace ? '世界固定' : '物体固定'}</td></tr>
      <tr><td>采样点</td><td colspan="2">(${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)})</td></tr>
      <tr><td>法线</td><td colspan="2">(${fmt(n.x)}, ${fmt(n.y)}, ${fmt(n.z)})</td></tr>
      <tr><td>面索引</td><td colspan="2">${hit.faceIndex ?? '-'}</td></tr>
      ${rows}
      <tr><td>主导轴</td><td colspan="2"><b>${AXIS_NAMES[result.dominantAxis]}</b> (maxW=${result.maxWeight.toFixed(3)})</td></tr>
    </table>
    ${isBackface ? '<p class="backface-warning">⚠ 该面为反向法线（背面）</p>' : ''}
    ${band ? '<p class="band-warning">◈ 位于轴界面混合区内</p>' : '<p>◈ 位于单轴主导区</p>'}
  `;

  placeMarker(hit.point, result.dominantAxis, isBackface);
}

canvas.addEventListener('pointerdown', (e) => {
  downXY = [e.clientX, e.clientY];
});

canvas.addEventListener('pointerup', (e) => {
  if (!downXY) return;
  const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]);
  downXY = null;
  if (moved > 5 || transform.dragging) return; // 拖动而非点击

  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const targets = backfacePatch ? [mesh, backfacePatch] : [mesh];
  const hits = raycaster.intersectObjects(targets, false);
  if (!hits.length) return;
  const hit = hits[0];
  if (!hit.face) return;

  // 世界空间法线（考虑法线朝向：背面取反）
  const normalWorld = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  const worldMatrix = hit.object.matrixWorld;
  const pointWorld: Vec3 = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
  const normalWorldVec: Vec3 = { x: normalWorld.x, y: normalWorld.y, z: normalWorld.z };

  const inv = new THREE.Matrix4().copy(worldMatrix).invert();
  const localPt = hit.point.clone().applyMatrix4(inv);
  const localN = hit.face.normal.clone(); // 几何体自身法线
  const pointLocal: Vec3 = { x: localPt.x, y: localPt.y, z: localPt.z };
  const normalLocal: Vec3 = { x: localN.x, y: localN.y, z: localN.z };

  updateReadout(hit, pointWorld, normalWorldVec, pointLocal, normalLocal, !isFrontFacing(hit));
});

/** 与 GLSL gl_FrontFacing 等价的 CPU 判定：视线与面法线是否反向 */
function isFrontFacing(hit: THREE.Intersection): boolean {
  const n = hit.face!.normal.clone().transformDirection(hit.object.matrixWorld);
  const view = new THREE.Vector3().subVectors(camera.position, hit.point).normalize();
  return n.dot(view) > 0;
}

// ---------- UI 绑定 ----------
const $ = (id: string) => document.getElementById(id)!;

function bindSlider(id: string, valueId: string, apply: (v: number) => void, fmt: (v: number) => string) {
  const input = $(id) as HTMLInputElement;
  const label = $(valueId);
  const update = () => {
    const v = parseFloat(input.value);
    label.textContent = fmt(v);
    apply(v);
  };
  input.addEventListener('input', update);
}

bindSlider('sharpness', 'sharpnessVal', (v) => (uniforms.sharpness.value = v), (v) => v.toFixed(1));
bindSlider('biasX', 'biasXVal', (v) => ((uniforms.biases.value as THREE.Vector3).x = v), (v) => v.toFixed(2));
bindSlider('biasY', 'biasYVal', (v) => ((uniforms.biases.value as THREE.Vector3).y = v), (v) => v.toFixed(2));
bindSlider('biasZ', 'biasZVal', (v) => ((uniforms.biases.value as THREE.Vector3).z = v), (v) => v.toFixed(2));
bindSlider('bandThreshold', 'bandVal', (v) => (uniforms.bandThreshold.value = v), (v) => v.toFixed(2));
bindSlider('uvScale', 'scaleVal', (v) => (uniforms.uvScale.value = v), (v) => v.toFixed(2));
bindSlider(
  'offsetU',
  'offsetUVal',
  (v) => ((uniforms.uvOffset.value as THREE.Vector2).x = v),
  (v) => v.toFixed(2),
);
bindSlider(
  'offsetV',
  'offsetVVal',
  (v) => ((uniforms.uvOffset.value as THREE.Vector2).y = v),
  (v) => v.toFixed(2),
);

document.querySelectorAll<HTMLButtonElement>('.mode').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    uniforms.viewMode.value = parseInt(btn.dataset.mode!, 10);
  });
});

document.querySelectorAll<HTMLButtonElement>('#spaceSeg button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#spaceSeg button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    uniforms.spaceMode.value = parseInt(btn.dataset.space!, 10);
  });
});

document.querySelectorAll<HTMLButtonElement>('#transformSeg button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#transformSeg button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const mode = btn.dataset.tmode!;
    if (mode === 'none') transform.detach();
    else {
      transform.attach(mesh);
      transform.setMode(mode as 'translate' | 'rotate');
    }
  });
});

($('showBand') as HTMLInputElement).addEventListener('change', (e) => {
  uniforms.showBand.value = (e.target as HTMLInputElement).checked;
});
($('showBackface') as HTMLInputElement).addEventListener('change', (e) => {
  uniforms.showBackface.value = (e.target as HTMLInputElement).checked;
});
($('backfaceDemo') as HTMLInputElement).addEventListener('change', () => buildBackfacePatch());

($('geoSelect') as HTMLSelectElement).addEventListener('change', (e) => {
  buildMesh((e.target as HTMLSelectElement).value as GeometryName);
});

$('resetBtn').addEventListener('click', () => {
  mesh.position.set(0, 0, 0);
  mesh.rotation.set(0, 0, 0);
  mesh.scale.set(1, 1, 1);
  resetUniforms();
  resetSliders();
});

function resetUniforms() {
  uniforms.sharpness.value = DEFAULT_PARAMS.sharpness;
  (uniforms.biases.value as THREE.Vector3).set(...DEFAULT_PARAMS.biases);
  uniforms.uvScale.value = DEFAULT_PARAMS.uvScale;
  (uniforms.uvOffset.value as THREE.Vector2).set(...DEFAULT_PARAMS.uvOffset);
  uniforms.bandThreshold.value = DEFAULT_PARAMS.bandThreshold;
  uniforms.spaceMode.value = DEFAULT_PARAMS.spaceMode;
  uniforms.viewMode.value = DEFAULT_PARAMS.viewMode;
  uniforms.showBand.value = DEFAULT_PARAMS.showBand;
  uniforms.showBackface.value = DEFAULT_PARAMS.showBackface;
}

function resetSliders() {
  const values: Record<string, string> = {
    sharpness: '1',
    biasX: '1',
    biasY: '1',
    biasZ: '1',
    bandThreshold: '0.8',
    uvScale: '1',
    offsetU: '0',
    offsetV: '0',
  };
  for (const [id, v] of Object.entries(values)) {
    const input = $(id) as HTMLInputElement;
    input.value = v;
    input.dispatchEvent(new Event('input'));
  }
  ($('showBand') as HTMLInputElement).checked = true;
  ($('showBackface') as HTMLInputElement).checked = true;
  document.querySelectorAll<HTMLButtonElement>('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === '0'));
  document.querySelectorAll<HTMLButtonElement>('#spaceSeg button').forEach((b) =>
    b.classList.toggle('active', b.dataset.space === '0'),
  );
}

// ---------- 自适应与渲染循环 ----------
function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

renderer.setAnimationLoop(() => {
  orbit.update();
  renderer.render(scene, camera);
});

// 供控制台/调试使用
export { triplanarWeights, VIEW_MODES, SPACE_MODES };
