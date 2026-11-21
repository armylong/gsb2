import * as THREE from 'three';
import './style.css';
import { CameraRig } from './controls/cameraRig';
import { createDefaultParams, FOG_PRESETS, sunDirection } from './fog/fog';
import { FogPass } from './fog/FogPass';
import { Picker } from './picker/picker';
import { createGui } from './ui/gui';
import { Hud } from './ui/hud';
import { buildWorld } from './world/world';

// ---------------------------------------------------------------------------
// 渲染器 / 场景 / 相机
// ---------------------------------------------------------------------------
const app = document.querySelector<HTMLDivElement>('#app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.autoClear = false;
renderer.outputColorSpace = THREE.SRGBColorSpace; // 雾 pass 末尾用 colorspace_fragment 做线性→sRGB
renderer.toneMapping = THREE.NoToneMapping;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x20262f); // 空背景也要能看出被雾染亮

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 120);
camera.position.set(0, 2.2, 11.5);

// ---------------------------------------------------------------------------
// 雾参数、场景、后处理、控制、点选、UI
// ---------------------------------------------------------------------------
const params = createDefaultParams();
const world = buildWorld(params);
scene.add(world.group);

const fogPass = new FogPass(1, 1); // 尺寸由下面 resize() 按 DPR 统一设置
const rig = new CameraRig(camera, renderer.domElement);
const picker = new Picker(scene);
const hud = new Hud();

// 平行光位置/目标跟随参数（场景物体本身的明暗也由这盏灯给出）
function syncSunLight(): void {
  const dir = sunDirection(params.sunAzimuth, params.sunElevation, new THREE.Vector3());
  world.sun.color.copy(params.sunColor);
  world.sun.intensity = params.sunIntensity;
  world.sun.position.copy(dir).multiplyScalar(14);
  world.sun.target.position.set(0, 1.2, 0);
  world.sun.target.updateMatrixWorld();
}
syncSunLight();

function onFogBoxChanged(): void {
  world.updateFogBox(params);
  refreshPickReadout();
}

function refreshPickReadout(): void {
  const result = picker.refresh(
    camera,
    world.pickables,
    params,
    camera.far,
    renderer.domElement.getBoundingClientRect(),
    lastPickClient,
  );
  if (result) hud.showPick(result);
}

const { updateDisplay } = createGui(params, rig, camera, {
  onFogBoxChanged,
  onDensityChanged: refreshPickReadout,
  onLightChanged: () => {
    syncSunLight();
    refreshPickReadout();
  },
  applyPreset: (index) => applyFogPreset(index),
  refreshPick: refreshPickReadout,
});

function applyFogPreset(index: number): void {
  const p = FOG_PRESETS[index];
  params.boxCenter.set(...p.center);
  params.boxSize.set(...p.size);
  params.density = p.density;
  params.falloff = p.falloff;
  world.updateFogBox(params);
  updateDisplay();
  refreshPickReadout();
}

// ---------------------------------------------------------------------------
// 点选（只在轨道模式响应，避免和指针锁定冲突）
// ---------------------------------------------------------------------------
let lastPickClient: { x: number; y: number } | null = null;
let downPos: { x: number; y: number } | null = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  downPos = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (rig.mode !== 'orbit' || !downPos) return;
  const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  downPos = null;
  if (moved > 5) return; // 拖拽旋转不触发点选
  const rect = renderer.domElement.getBoundingClientRect();
  lastPickClient = { x: e.clientX, y: e.clientY };
  const result = picker.pick(e.clientX, e.clientY, rect, camera, world.pickables, params, camera.far);
  hud.showPick(result);
});

// F 键雾开关对照
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyF' && !(e.target instanceof HTMLInputElement)) {
    params.fogEnabled = !params.fogEnabled;
    updateDisplay();
  }
});

// ---------------------------------------------------------------------------
// 窗口尺寸：RT、深度纹理、相机一起换，深度/雾/原画面始终对齐
// ---------------------------------------------------------------------------
function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fogPass.resize(Math.floor(w * dpr), Math.floor(h * dpr));
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
const sunDirTmp = new THREE.Vector3();
const pendingPixelRequests: Array<{
  ndcX: number;
  ndcY: number;
  resolve: (v: number[]) => void;
}> = [];

function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  rig.update(dt);

  // 方向读数：视线与平行光夹角 + 当前相位值
  sunDirection(params.sunAzimuth, params.sunElevation, sunDirTmp);
  const phase = Picker.sunPhase(camera, sunDirTmp, params.anisotropy);
  const transTip = params.fogEnabled ? '' : '（雾已关闭，显示原画面）';
  hud.setPhaseInfo(
    `视线与平行光夹角 ${phase.angle.toFixed(1)}° · HG 相位 ${phase.phase.toFixed(4)} · g=${params.anisotropy.toFixed(2)}${transTip}`,
  );
  hud.setMode(rig.mode, rig.autoWalk);

  fogPass.render(renderer, scene, camera, params);

  // 合成完成、默认帧缓冲仍绑定时立刻抓像素
  if (pendingPixelRequests.length > 0) {
    const gl = renderer.getContext();
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    const buf = new Uint8Array(4);
    for (const req of pendingPixelRequests.splice(0)) {
      const px = Math.round((req.ndcX * 0.5 + 0.5) * w);
      const py = Math.round((1 - (req.ndcY * 0.5 + 0.5)) * h);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      req.resolve(Array.from(buf));
    }
  }
}
animate();

// 调试/自动化钩子：无头浏览器通过 window.__FOG_DEBUG__ 驱动场景并读取内部状态
;(window as unknown as { __FOG_DEBUG__: unknown }).__FOG_DEBUG__ = {
  params,
  picker,
  rig,
  camera,
  pickAt: (clientX: number, clientY: number) => {
    const rect = renderer.domElement.getBoundingClientRect();
    return picker.pick(clientX, clientY, rect, camera, world.pickables, params, camera.far);
  },
  // 供自动化验证：按当前 canvas 实际视口的中心射线点选，避免硬编码像素落在画面外
  pickCenter: () => {
    const rect = renderer.domElement.getBoundingClientRect();
    return picker.pick(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      rect,
      camera,
      world.pickables,
      params,
      camera.far,
    );
  },
  setCamera: (x: number, y: number, z: number, lookX = 0, lookY = 1.6, lookZ = 0) => {
    rig.setCameraExternal(x, y, z, lookX, lookY, lookZ);
  },
  // 供自动化验证方向对称性：给定方位角返回视线-光夹角余弦与 HG 相位
  phaseFor: (azimuthDeg: number) => {
    const dir = sunDirection(azimuthDeg, params.sunElevation, new THREE.Vector3());
    return Picker.sunPhase(camera, dir, params.anisotropy);
  },
  // 供自动化验证：读取当前机位、视线方向、视口尺寸
  getView: () => {
    const viewDir = new THREE.Vector3();
    camera.getWorldDirection(viewDir);
    const rect = renderer.domElement.getBoundingClientRect();
    return {
      position: camera.position.toArray(),
      viewDir: viewDir.toArray(),
      fov: camera.fov,
      aspect: camera.aspect,
      cssWidth: rect.width,
      cssHeight: rect.height,
    };
  },
  // 供自动化验证：请求下一帧合成完成后读取 NDC 处上屏像素（默认帧缓冲）
  readPixelNextFrame: (ndcX: number, ndcY: number): Promise<number[]> => {
    return new Promise((resolve) => {
      pendingPixelRequests.push({ ndcX, ndcY, resolve });
    });
  },
};
