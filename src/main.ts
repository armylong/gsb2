/**
 * 检查页入口：场景、交互、面板。
 * 所有核心数学来自 src/core/*（与 scripts/verify.ts 共用）。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { buildMirroredPlane, frameAtPoint, type MirroredPlaneData } from './core/geometry';
import { runAxisValidation, v3, type Vec3 } from './core/tangentSpace';
import { samplePipeline, sampleDiffuse, DEFAULT_SAMPLE_OPTIONS, type FixMode, type SampleOptions } from './core/sampler';
import type { GreenConvention } from './core/heightfield';
import { vertexShader, fragmentShader } from './shaders';
import { makeNormalMapTexture } from './texture';

// ---------- 状态 ----------
const opts: SampleOptions & {
  bumpScale: number;
  showGrid: boolean;
  showDegenerate: boolean;
  degenerateBand: boolean;
  light: { x: number; y: number; z: number };
} = {
  ...DEFAULT_SAMPLE_OPTIONS,
  bumpScale: 1.0,
  showGrid: false,
  showDegenerate: true,
  degenerateBand: true,
  light: { x: 1.5, y: 1.5, z: 2.5 },
};

let geoData: MirroredPlaneData = buildMirroredPlane({ degenerateBand: opts.degenerateBand });
let picked: { x: number; y: number } | null = null;

// ---------- 场景 ----------
const viewport = document.getElementById('viewport')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, -0.6, 4.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const uniforms = {
  normalMap: { value: makeNormalMapTexture(512) },
  lightPos: { value: new THREE.Vector3(opts.light.x, opts.light.y, opts.light.z) },
  bumpScale: { value: opts.bumpScale },
  texRotDeg: { value: opts.rotationDeg },
  greenFlip: { value: 0 },
  fixMode: { value: 0 },
  showDegenerate: { value: 1 },
  showGrid: { value: 0 },
};

const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms });
let mesh: THREE.Mesh;

function buildThreeGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(geoData.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(geoData.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(geoData.uvs, 2));
  g.setAttribute('tangent', new THREE.BufferAttribute(geoData.tangents, 3));
  g.setAttribute('handedness', new THREE.BufferAttribute(geoData.handedness, 1));
  g.setAttribute('degenerate', new THREE.BufferAttribute(geoData.degenerate, 1));
  g.setAttribute('region', new THREE.BufferAttribute(geoData.region, 1));
  g.setIndex(new THREE.BufferAttribute(geoData.indices, 1));
  return g;
}

function rebuildMesh(): void {
  geoData = buildMirroredPlane({ degenerateBand: opts.degenerateBand });
  const g = buildThreeGeometry();
  if (mesh) {
    mesh.geometry.dispose();
    mesh.geometry = g;
  } else {
    mesh = new THREE.Mesh(g, material);
    scene.add(mesh);
  }
}
rebuildMesh();

// 灯光（小球 + 辅助线）
const lightBall = new THREE.Mesh(
  new THREE.SphereGeometry(0.06, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xffe9a0 }),
);
scene.add(lightBall);
scene.add(new THREE.AmbientLight(0xffffff, 0.0)); // 光照全在自定义 shader 里

// 选中点箭头：N 蓝 / T 红 / B 绿
const arrowN = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 0.5, 0x4d9fff, 0.1, 0.05);
const arrowT = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.5, 0xff5a5a, 0.1, 0.05);
const arrowB = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.5, 0x5aff7a, 0.1, 0.05);
for (const a of [arrowN, arrowT, arrowB]) { a.visible = false; scene.add(a); }

// ---------- 面板 ----------
const pickedEl = document.getElementById('picked')!;
const samplesEl = document.getElementById('samples')!;
const axisEl = document.getElementById('axisResult')!;

const fmt = (v: Vec3 | number[]): string => `(${v.map((x) => x.toFixed(3)).join(', ')})`;

function currentLightDir(from: Vec3): Vec3 {
  return v3.normalize([opts.light.x - from[0], opts.light.y - from[1], opts.light.z - from[2]]);
}

function updatePickedPanel(): void {
  if (!picked) return;
  const hit = frameAtPoint(geoData, picked.x, picked.y);
  const s = samplePipeline(hit.frame, hit.uv, hit.region, opts);
  const pos: Vec3 = [picked.x, picked.y, 0];
  const L = currentLightDir(pos);
  const ndl = Math.max(0, v3.dot(s.worldNormal, L));

  pickedEl.textContent = [
    `位置: (${picked.x.toFixed(3)}, ${picked.y.toFixed(3)})  区域: ${hit.region === 0 ? '左(正常UV)' : '右(镜像UV)'}`,
    `UV: (${hit.uv[0].toFixed(3)}, ${hit.uv[1].toFixed(3)})  旋转后: (${s.rotatedUV[0].toFixed(3)}, ${s.rotatedUV[1].toFixed(3)})`,
    `手性 w = ${s.handedness > 0 ? '+1' : '-1'}  当前处理: ${s.usedHandedness ? '使用w(正确)' : '强制+1(错误)'}${hit.degenerate ? '  ⚠ 退化坐标' : ''}`,
    `切线空间法线: ${fmt(s.tsNormal)}`,
    `世界法线 N: ${fmt(s.worldNormal)}  (蓝箭头)`,
    `切线 T: ${fmt(v3.normalize(hit.frame.T))}  (红箭头)`,
    `副切线 B: ${fmt(v3.normalize(v3.scale(v3.cross(hit.frame.N, v3.normalize(hit.frame.T)), s.usedHandedness ? hit.frame.w : 1)))}  (绿箭头)`,
    `灯光方向: ${fmt(L)}   N·L = ${ndl.toFixed(4)}`,
  ].join('\n');

  const origin = new THREE.Vector3(picked.x, picked.y, 0.01);
  arrowN.position.copy(origin);
  arrowT.position.copy(origin);
  arrowB.position.copy(origin);
  arrowN.setDirection(new THREE.Vector3(...s.worldNormal));
  arrowT.setDirection(new THREE.Vector3(...v3.normalize(hit.frame.T)));
  const B = v3.scale(v3.cross(hit.frame.N, v3.normalize(hit.frame.T)), s.usedHandedness ? hit.frame.w : 1);
  arrowB.setDirection(new THREE.Vector3(...v3.normalize(B)));
  for (const a of [arrowN, arrowT, arrowB]) a.visible = true;
}

// ---------- 采样记录（修改前后对比） ----------
interface SampleRecord {
  mode: FixMode;
  convention: GreenConvention;
  rotationDeg: number;
  point: { x: number; y: number };
  region: 0 | 1;
  tsNormal: Vec3;
  worldNormal: Vec3;
  ndl: number;
}
const records: SampleRecord[] = [];

function recordSample(): void {
  if (!picked) { samplesEl.textContent = '请先点击平面选一个点'; return; }
  const hit = frameAtPoint(geoData, picked.x, picked.y);
  const s = samplePipeline(hit.frame, hit.uv, hit.region, opts);
  const ndl = Math.max(0, v3.dot(s.worldNormal, currentLightDir([picked.x, picked.y, 0])));
  records.push({
    mode: opts.fixMode, convention: opts.convention, rotationDeg: opts.rotationDeg,
    point: { ...picked }, region: hit.region, tsNormal: s.tsNormal, worldNormal: s.worldNormal, ndl,
  });
  renderRecords();
}

function renderRecords(): void {
  if (records.length === 0) { samplesEl.textContent = '（在选定点处，切换「手性处理」前后各记录一次）'; return; }
  const lines: string[] = [];
  records.forEach((r, i) => {
    lines.push(
      `#${i + 1} [${r.mode}/${r.convention}/rot${r.rotationDeg}°] 点(${r.point.x.toFixed(2)}, ${r.point.y.toFixed(2)}) ${r.region === 0 ? '左区' : '右区'}`,
      `   ts=${fmt(r.tsNormal)}  worldN=${fmt(r.worldNormal)}  N·L=${r.ndl.toFixed(4)}`,
    );
    const prev = records[i - 1];
    if (prev && Math.abs(prev.point.x - r.point.x) < 1e-6 && Math.abs(prev.point.y - r.point.y) < 1e-6) {
      const d = r.ndl - prev.ndl;
      lines.push(`   → 同一点 Δ(N·L) = ${d >= 0 ? '+' : ''}${d.toFixed(4)} ${Math.abs(d) > 0.01 ? '⚠ 亮暗发生变化' : '✓ 一致'}`);
    }
  });
  samplesEl.textContent = lines.join('\n');
}

// ---------- 轴向灯光验证 ----------
function runAxisCheck(): void {
  const rows = runAxisValidation((region, lightDir) => {
    const p = region === 'left' ? { x: -1, y: 0 } : { x: 1, y: 0 };
    const hit = frameAtPoint(geoData, p.x, p.y);
    return sampleDiffuse(hit.frame, hit.uv, hit.region, opts, lightDir);
  });
  const maxDelta = Math.max(...rows.map((r) => Math.abs(r.delta)));
  const pass = maxDelta < 1e-3;
  axisEl.innerHTML = [
    `模式: ${opts.fixMode} / ${opts.convention} / 旋转 ${opts.rotationDeg}°`,
    ...rows.map((r) => `  光 ${r.axis}: 左=${r.left.toFixed(4)} 右(镜像光)=${r.right.toFixed(4)}  Δ=${r.delta.toFixed(4)}`),
    `max|Δ| = ${maxDelta.toFixed(4)}  →  <span class="${pass ? 'ok' : 'bad'}">${pass ? 'PASS：左右互为镜像，手性正确' : 'FAIL：左右亮暗不一致（手性未修正）'}</span>`,
  ].join('\n');
}

// ---------- 交互 ----------
const raycaster = new THREE.Raycaster();
renderer.domElement.addEventListener('pointerdown', (e) => {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(mesh)[0];
  if (hit) {
    picked = { x: hit.point.x, y: hit.point.y };
    updatePickedPanel();
  }
});

document.getElementById('recordBtn')!.addEventListener('click', recordSample);
document.getElementById('clearBtn')!.addEventListener('click', () => { records.length = 0; renderRecords(); });
document.getElementById('axisBtn')!.addEventListener('click', runAxisCheck);

// ---------- GUI ----------
const gui = new GUI({ container: document.getElementById('gui')!, title: '控制' });
const fixModeNames = { '全部正确 (用w)': 'correct', '全部错误 (强制w=1, 复现bug)': 'wrong', '对照 (左错右对)': 'split' };
gui.add(opts, 'fixMode', fixModeNames).name('手性处理').onChange(syncUniforms);
gui.add(opts, 'convention', { 'OpenGL (G+向上)': 'opengl', 'DirectX (G+向下)': 'directx' }).name('纵向编码约定').onChange(syncUniforms);
gui.add(opts, 'rotationDeg', 0, 360, 1).name('纹理旋转°').onChange(syncUniforms);
gui.add(opts, 'bumpScale', 0, 3, 0.05).name('凹凸强度').onChange(syncUniforms);
gui.add(opts, 'degenerateBand').name('插入退化UV条带').onChange(() => { rebuildMesh(); updatePickedPanel(); });
gui.add(opts, 'showDegenerate').name('标出退化区域').onChange(syncUniforms);
gui.add(opts, 'showGrid').name('显示UV网格').onChange(syncUniforms);
const lightFolder = gui.addFolder('灯光位置');
lightFolder.add(opts.light, 'x', -4, 4, 0.05).onChange(syncUniforms);
lightFolder.add(opts.light, 'y', -4, 4, 0.05).onChange(syncUniforms);
lightFolder.add(opts.light, 'z', 0.2, 6, 0.05).onChange(syncUniforms);
const axisPresets: Record<string, Vec3> = {
  '+X': [3, 0, 1.2], '-X': [-3, 0, 1.2], '+Y': [0, 3, 1.2],
  '-Y': [0, -3, 1.2], '+Z': [0, 0, 4], '-Z(背光)': [0, 0, 0.3],
};
const lightActions: Record<string, () => void> = {};
for (const [name, p] of Object.entries(axisPresets)) {
  lightActions[`灯光→${name}`] = () => {
    opts.light.x = p[0]; opts.light.y = p[1]; opts.light.z = p[2];
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    syncUniforms();
  };
}
lightFolder.add(lightActions, '灯光→+X');
lightFolder.add(lightActions, '灯光→-X');
lightFolder.add(lightActions, '灯光→+Y');
lightFolder.add(lightActions, '灯光→-Y');
lightFolder.add(lightActions, '灯光→+Z');
lightFolder.add(lightActions, '灯光→-Z(背光)');

function syncUniforms(): void {
  uniforms.lightPos.value.set(opts.light.x, opts.light.y, opts.light.z);
  lightBall.position.set(opts.light.x, opts.light.y, opts.light.z);
  uniforms.bumpScale.value = opts.bumpScale;
  uniforms.texRotDeg.value = opts.rotationDeg;
  uniforms.greenFlip.value = opts.convention === 'directx' ? 1 : 0;
  uniforms.fixMode.value = opts.fixMode === 'correct' ? 0 : opts.fixMode === 'wrong' ? 1 : 2;
  uniforms.showDegenerate.value = opts.showDegenerate ? 1 : 0;
  uniforms.showGrid.value = opts.showGrid ? 1 : 0;
  updatePickedPanel();
}
syncUniforms();

// ---------- 主循环 ----------
function resize(): void {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
