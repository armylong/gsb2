import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { generateFurTexture } from './furTexture';
import { computeClothField, computeSphereField } from './furField';
import { createSharedUniforms, createFurMaterial } from './furMaterial';

// ---------------------------------------------------------------- 参数

const params = {
  // 毛发
  furLength: 0.16,
  density: 0.65,
  layers: 16,
  uvScale: 24,
  rootColor: '#3d2c1e',
  tipColor: '#caa26b',
  // 梳向(毛被压向的方向)
  combAzimuth: 35,
  combTilt: 0.35,
  // 布片压痕
  pressX: 0.45,
  pressY: 0.3,
  pressRadius: 0.55,
  pressStrength: 0.9,
  // 球体压痕(位置固定在物体空间,旋转球体可见压痕跟随表面)
  spherePressStrength: 0.9,
  sphereAutoRotate: true,
  sphereRotSpeed: 0.4,
  // 显示
  viewMode: '合成' as '合成' | '仅底材' | '仅毛层',
  // 灯光
  lightAzimuth: 45,
  lightElevation: 55,
};

const QUALITY_PRESETS: Record<string, { layers: number; texSize: number; density: number; uvScale: number }> = {
  '低 (8层/256)': { layers: 8, texSize: 256, density: 0.45, uvScale: 24 },
  '中 (16层/512)': { layers: 16, texSize: 512, density: 0.65, uvScale: 24 },
  '高 (32层/512)': { layers: 32, texSize: 512, density: 0.85, uvScale: 28 },
};
let texSize = 512;

// ---------------------------------------------------------------- 场景

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.getElementById('app')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x23262b);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// 底材光照(毛层在 shader 里用同一方向)
const dirLight = new THREE.DirectionalLight(0xffffff, 2.2);
scene.add(dirLight);
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x3a2f26, 0.5));

// 参考地面
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(6, 48).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x2c2f35, roughness: 1 }),
);
ground.position.y = -0.001;
scene.add(ground);

// ---------------------------------------------------------------- 几何体

const CLOTH_POS = new THREE.Vector3(-1.3, 0, 0);
const SPHERE_POS = new THREE.Vector3(1.3, 0.72, 0);
const SPHERE_PRESS_DIR = new THREE.Vector3(0.25, 0.75, 0.62).normalize();

const clothGeo = new THREE.PlaneGeometry(2.4, 2.4, 128, 128);
const sphereGeo = new THREE.SphereGeometry(0.72, 96, 64);

const shared = createSharedUniforms();

function makeBaseMesh(geo: THREE.BufferGeometry, color: number) {
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.95 }));
}

// 布片: 底材 + 壳层组
const clothBase = makeBaseMesh(clothGeo, 0x4a3828);
const clothShells = new THREE.Group();
const clothGroup = new THREE.Group();
clothGroup.add(clothBase, clothShells);
clothGroup.position.copy(CLOTH_POS);
clothGroup.rotation.x = -Math.PI / 2;
scene.add(clothGroup);

// 球: 底材 + 壳层组(整组旋转,压痕在物体空间 → 跟着表面走)
const sphereBase = makeBaseMesh(sphereGeo, 0x4a3828);
const sphereShells = new THREE.Group();
const sphereGroup = new THREE.Group();
sphereGroup.add(sphereBase, sphereShells);
sphereGroup.position.copy(SPHERE_POS);
scene.add(sphereGroup);

// ---------------------------------------------------------------- 构建/更新

let hairCount = 0;

function regenTexture() {
  const { texture, hairCount: hc } = generateFurTexture(texSize, params.density);
  shared.uFurTex.value?.dispose();
  shared.uFurTex.value = texture;
  hairCount = hc;
}

function rebuildShells() {
  for (const group of [clothShells, sphereShells]) {
    for (const m of [...group.children]) {
      ((m as THREE.Mesh).material as THREE.Material).dispose();
      group.remove(m);
    }
  }
  for (let i = 0; i < params.layers; i++) {
    const t = (i + 1) / params.layers;
    clothShells.add(new THREE.Mesh(clothGeo, createFurMaterial(shared, params.uvScale, t)));
    sphereShells.add(new THREE.Mesh(sphereGeo, createFurMaterial(shared, params.uvScale, t)));
  }
  applyViewMode();
}

function updateFields() {
  computeClothField(clothGeo, { azimuthDeg: params.combAzimuth, tilt: params.combTilt }, {
    x: params.pressX, y: params.pressY, radius: params.pressRadius, strength: params.pressStrength,
  });
  computeSphereField(sphereGeo, { azimuthDeg: params.combAzimuth, tilt: params.combTilt }, {
    dir: SPHERE_PRESS_DIR, angleDeg: 50, strength: params.spherePressStrength,
  });
}

function applyViewMode() {
  const showBase = params.viewMode !== '仅毛层';
  const showFur = params.viewMode !== '仅底材';
  clothBase.visible = sphereBase.visible = showBase;
  clothShells.visible = sphereShells.visible = showFur;
  ground.visible = showBase;
}

function updateLight() {
  const az = (params.lightAzimuth * Math.PI) / 180;
  const el = (params.lightElevation * Math.PI) / 180;
  const d = new THREE.Vector3(
    Math.cos(el) * Math.cos(az),
    Math.sin(el),
    Math.cos(el) * Math.sin(az),
  );
  shared.uLightDir.value.copy(d);
  dirLight.position.copy(d.clone().multiplyScalar(6));
}

function updateColors() {
  shared.uRootColor.value.set(params.rootColor);
  shared.uTipColor.value.set(params.tipColor);
}

// ---------------------------------------------------------------- 相机预设

const CAMERA_PRESETS: Record<string, { pos: [number, number, number]; tgt: [number, number, number] }> = {
  '正面全景': { pos: [0, 1.8, 4.6], tgt: [0, 0.5, 0] },
  '掠射轮廓(球)': { pos: [3.3, 0.78, 0.9], tgt: [1.3, 0.7, 0] },
  '薄边特写(布缘)': { pos: [-2.45, 0.06, 1.5], tgt: [-2.45, 0.03, -0.6] },
  '压痕特写(布)': { pos: [-0.85, 0.85, 0.55], tgt: [-0.85, 0.02, -0.3] },
  '压痕特写(球)': { pos: [1.75, 1.6, 1.6], tgt: [1.3, 0.85, 0.35] },
};

function applyCameraPreset(name: string) {
  const p = CAMERA_PRESETS[name];
  camera.position.set(...p.pos);
  controls.target.set(...p.tgt);
  controls.update();
}

// ---------------------------------------------------------------- GUI

const gui = new GUI({ title: '毛绒预览' });

const fFur = gui.addFolder('毛发');
fFur.add(params, 'furLength', 0.02, 0.5, 0.005).name('毛长').onChange((v: number) => (shared.uFurLength.value = v));
fFur.add(params, 'density', 0.05, 1, 0.01).name('密度').onChange(regenTexture);
fFur.add(params, 'layers', 4, 48, 1).name('壳层层数').onChange(rebuildShells);
fFur.add(params, 'uvScale', 8, 48, 1).name('毛纹缩放').onChange(rebuildShells);
fFur.addColor(params, 'rootColor').name('毛根色').onChange(updateColors);
fFur.addColor(params, 'tipColor').name('毛尖色').onChange(updateColors);

const fComb = gui.addFolder('梳向 / 压痕');
fComb.add(params, 'combAzimuth', 0, 360, 1).name('梳向方位角').onChange(updateFields);
fComb.add(params, 'combTilt', 0, 1, 0.01).name('压倒程度').onChange(updateFields);
fComb.add(params, 'pressX', -1.2, 1.2, 0.01).name('布压痕中心X').onChange(updateFields);
fComb.add(params, 'pressY', -1.2, 1.2, 0.01).name('布压痕中心Y').onChange(updateFields);
fComb.add(params, 'pressRadius', 0.1, 1.2, 0.01).name('布压痕半径').onChange(updateFields);
fComb.add(params, 'pressStrength', 0, 1, 0.01).name('布压痕强度').onChange(updateFields);
fComb.add(params, 'spherePressStrength', 0, 1, 0.01).name('球压痕强度').onChange(updateFields);
fComb.add(params, 'sphereAutoRotate').name('球自动旋转');
fComb.add(params, 'sphereRotSpeed', 0, 2, 0.05).name('旋转速度');

const fView = gui.addFolder('显示 / 灯光');
fView.add(params, 'viewMode', ['合成', '仅底材', '仅毛层']).name('视图模式').onChange(applyViewMode);
fView.add(params, 'lightAzimuth', 0, 360, 1).name('灯光方位角').onChange(updateLight);
fView.add(params, 'lightElevation', 5, 90, 1).name('灯光仰角').onChange(updateLight);

const fQuality = gui.addFolder('质量预设(开销对照)');
for (const name of Object.keys(QUALITY_PRESETS)) {
  fQuality.add({ apply() {
    const q = QUALITY_PRESETS[name];
    params.layers = q.layers;
    params.density = q.density;
    params.uvScale = q.uvScale;
    texSize = q.texSize;
    regenTexture();
    rebuildShells();
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  } }, 'apply').name(name);
}

const fCam = gui.addFolder('相机预设');
for (const name of Object.keys(CAMERA_PRESETS)) {
  fCam.add({ apply: () => applyCameraPreset(name) }, 'apply').name(name);
}

// ---------------------------------------------------------------- HUD

const hud = document.getElementById('hud')!;
let frames = 0, fps = 0, lastFpsT = performance.now();

function updateHud() {
  const info = renderer.info.render;
  hud.textContent =
    `FPS ${fps}  |  壳层 ${params.layers} ×2物体  |  毛发/纹理 ${hairCount.toLocaleString()}\n` +
    `DrawCalls ${info.calls}  |  三角形 ${(info.triangles / 1e6).toFixed(2)}M  |  纹理 ${texSize}²`;
}

// ---------------------------------------------------------------- 主循环

const clock = new THREE.Clock();

function tick() {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();

  if (params.sphereAutoRotate) sphereGroup.rotation.y += params.sphereRotSpeed * dt;

  controls.update();
  renderer.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - lastFpsT > 500) {
    fps = Math.round((frames * 1000) / (now - lastFpsT));
    frames = 0;
    lastFpsT = now;
    updateHud();
  }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- 启动

// 支持 URL 参数直达检查位, 例如:
//   /#cam=薄边特写(布缘)&mode=仅毛层&layers=8&lightAz=120
function applyHashParams() {
  const h = new URLSearchParams(location.hash.slice(1));
  const cam = h.get('cam');
  if (cam && CAMERA_PRESETS[cam]) applyCameraPreset(cam);
  const mode = h.get('mode');
  if (mode === '合成' || mode === '仅底材' || mode === '仅毛层') {
    params.viewMode = mode;
    applyViewMode();
  }
  if (h.get('layers')) { params.layers = +h.get('layers')!; rebuildShells(); }
  if (h.get('lightAz')) { params.lightAzimuth = +h.get('lightAz')!; updateLight(); }
  if (h.get('lightEl')) { params.lightElevation = +h.get('lightEl')!; updateLight(); }
  if (h.get('norotate')) params.sphereAutoRotate = false;
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
}

regenTexture();
updateFields();
rebuildShells();
updateLight();
updateColors();
applyCameraPreset('正面全景');
applyHashParams();
tick();
