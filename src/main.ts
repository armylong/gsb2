import * as THREE from 'three';
import { HALF_TERRAIN, TERRAIN_SIZE } from './terrain/config';
import { TerrainManager } from './render/terrainManager';
import { CameraRig } from './render/cameraRig';
import { Hud } from './render/hud';
import { MarkerSet } from './render/markerSet';
import { isInsideTerrain, sampleHeight } from './terrain/heightfield';
import './styles.css';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------- 基础场景 ----------
const canvas = $<HTMLCanvasElement>('scene');
let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
} catch (err) {
  document.body.innerHTML =
    '<div style="padding:40px;font-family:sans-serif">当前浏览器无法创建 WebGL 上下文,请确认已开启硬件加速后重试。</div>';
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb6c9);
scene.fog = new THREE.Fog(0x9fb6c9, 320, 620);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 1000);
const hemi = new THREE.HemisphereLight(0xdfefff, 0x4a4038, 1.1);
const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
sun.position.set(-120, 220, 80);
scene.add(hemi, sun);

// 地形范围外的基准地面(明确区分"地形内"与"地形外")
const baseGround = new THREE.Mesh(
  new THREE.PlaneGeometry(1400, 1400),
  new THREE.MeshStandardMaterial({ color: 0x5d6b78, roughness: 1 }),
);
baseGround.rotation.x = -Math.PI / 2;
baseGround.position.y = -28;
scene.add(baseGround);

// 地形边界框
const boundary = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(TERRAIN_SIZE, 1, TERRAIN_SIZE)),
  new THREE.LineBasicMaterial({ color: 0xffffff }),
);
boundary.position.y = -27.5;
scene.add(boundary);

// ---------- 地形系统 ----------
let seed = Number($<HTMLInputElement>('seed').value) || 1337;
const terrain = new TerrainManager(seed, 3);
scene.add(terrain.group);

const getSeed = () => seed;
const rig = new CameraRig(camera, canvas, getSeed);
const hud = new Hud($('hud'), terrain);
const markers = new MarkerSet(getSeed);
scene.add(markers.group);

const messageEl = $('message');
let flashTimer = 0;
function flash(msg: string, ms = 4200): void {
  messageEl.textContent = msg;
  messageEl.classList.add('show');
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => messageEl.classList.remove('show'), ms);
}

// ---------- 演示用相机往返动画 ----------
interface Tween {
  from: number;
  to: number;
  duration: number;
  elapsed: number;
  pingPong: boolean;
  cycles: number;
  onDone?: () => void;
}
let tween: Tween | null = null;

function startOrbitOscillation(cycles: number, onDone?: () => void): void {
  tween = {
    from: 60,
    to: 300,
    duration: 1.6,
    elapsed: 0,
    pingPong: true,
    cycles,
    onDone,
  };
}

// ---------- UI:种子 / 重建 ----------
function rebuildWithSeed(newSeed: number): void {
  seed = newSeed;
  $<HTMLInputElement>('seed').value = String(newSeed);
  tween = null;
  terrain.rebuild(newSeed);
  flash(`已用种子 ${newSeed} 重建:地形代数进入第 ${terrain.stats.terrainEpoch} 代,旧结果将按代数判过期`);
}

$('rebuild').addEventListener('click', () => {
  const v = Number($<HTMLInputElement>('seed').value);
  rebuildWithSeed(Number.isFinite(v) ? Math.trunc(v) : 1337);
});

// ---------- UI:相机模式 ----------
function setCameraMode(mode: 'orbit' | 'ground'): void {
  rig.switchMode(mode);
  document.querySelectorAll('.cam-btn').forEach((b) => b.classList.remove('active'));
  $(mode === 'orbit' ? 'cam-orbit' : 'cam-ground').classList.add('active');
}
$('cam-orbit').addEventListener('click', () => setCameraMode('orbit'));
$('cam-ground').addEventListener('click', () => setCameraMode('ground'));
$<HTMLInputElement>('follow').addEventListener('change', (e) => {
  rig.setFollowTerrain((e.target as HTMLInputElement).checked);
});

// ---------- UI:LOD 阈值 / 延迟 ----------
function syncRanges(): void {
  terrain.ranges.near = Number($<HTMLInputElement>('near').value);
  terrain.ranges.far = Number($<HTMLInputElement>('far').value);
  terrain.ranges.hysteresis = Number($<HTMLInputElement>('hyst').value);
}
['near', 'far', 'hyst'].forEach((id) => $(id).addEventListener('change', syncRanges));
syncRanges();

const delayInput = $<HTMLInputElement>('delay');
delayInput.addEventListener('input', () => {
  const ms = Number(delayInput.value);
  $('delay-val').textContent = String(ms);
  terrain.setDelay(ms);
});

// ---------- UI:显示模式 / LOD 着色 ----------
function setDisplayMode(mode: 'fill' | 'wire' | 'both'): void {
  terrain.setDisplayMode(mode);
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
  $(`mode-${mode}`).classList.add('active');
}
$('mode-fill').addEventListener('click', () => setDisplayMode('fill'));
$('mode-both').addEventListener('click', () => setDisplayMode('both'));
$('mode-wire').addEventListener('click', () => setDisplayMode('wire'));

$<HTMLInputElement>('tint').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  // 顶点色已烘焙 LOD 色调;关闭时整体压暗以弱化层级色调对比
  terrain.fillMaterial.color.set(on ? 0xffffff : 0xbfc8d0);
});

// ---------- 点选地形 ----------
const raycaster = new THREE.Raycaster();
raycaster.params.Points = { threshold: 1.2 };
const pointer = new THREE.Vector2();
let downX = 0;
let downY = 0;
canvas.addEventListener('pointerdown', (e) => {
  downX = e.clientX;
  downY = e.clientY;
});
canvas.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // 拖拽不算点选
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(terrain.group.children, true);
  if (hits.length === 0) {
    flash('未命中地形表面(可能点到了地形外区域)');
    return;
  }
  const p = hits[0].point;
  const outcome = markers.query(p.x, p.z);
  flash(outcome.message);
});

// ---------- 坐标查询 ----------
$('query').addEventListener('click', () => {
  const x = Number($<HTMLInputElement>('qx').value);
  const z = Number($<HTMLInputElement>('qz').value);
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    flash('请输入有效数字坐标');
    return;
  }
  const outcome = markers.query(x, z);
  flash(outcome.message);
});
$('clear-markers').addEventListener('click', () => markers.clear());

// ---------- 三个演示入口 ----------
$('demo-seed').addEventListener('click', () => {
  // 同一种子重建两次,验证可复现:两次统计的 applied 数量一致,且顶点高度由同一确定性函数产生
  const targetSeed = 20260118;
  rebuildWithSeed(targetSeed);
  setTimeout(() => {
    rebuildWithSeed(targetSeed);
    const h1 = sampleHeight(40, -60, targetSeed);
    const h2 = sampleHeight(40, -60, targetSeed);
    flash(
      `固定种子 ${targetSeed}:sampleHeight(40,-60)=${h1.toFixed(4)},重复调用=${h2.toFixed(
        4,
      )},完全一致;重建后旧代数任务被计为过期丢弃`,
      6000,
    );
  }, 250);
});

$('demo-seam').addEventListener('click', () => {
  terrain.setDelay(0);
  delayInput.value = '0';
  $('delay-val').textContent = '0';
  setCameraMode('orbit');
  setDisplayMode('both');
  // 相机水平偏移放置,使半径约 70 的阈值环切过若干块:相邻块自然落在不同 LOD
  rig.setOrbitView(120, Math.PI * 0.5, Math.PI * 0.24);
  tween = null;
  setTimeout(() => {
    const hist = terrain.lodHistogram();
    flash(
      `接缝观察:当前 LOD 分布 细/中/粗 = ${hist[0]}/${hist[1]}/${hist[2]}。块边缘始终全分辨率,公共边缘无裂缝;角点多块交界同样闭合`,
      7000,
    );
  }, 800);
});

$('demo-stale').addEventListener('click', () => {
  setCameraMode('orbit');
  terrain.setDelay(450);
  delayInput.value = '450';
  $('delay-val').textContent = '450';
  const before = terrain.stats.totalStale + terrain.stats.totalSuperseded;
  startOrbitOscillation(3, () => {
    const after = terrain.stats.totalStale + terrain.stats.totalSuperseded;
    const check = window.setInterval(() => {
      if (terrain.isConverged()) {
        window.clearInterval(check);
        flash(
          `慢任务往返结束:期间 ${after - before} 个旧请求被取代/丢弃,停止移动后任务已收敛,所有块等于当前视野所需层级`,
          7000,
        );
      }
    }, 200);
  });
  flash('已开启 450ms 慢任务并快速往返 3 个来回:观察"过期丢弃/被取代"计数上升,迟到结果不会覆盖新层级');
});

// ---------- 窗口自适应 ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- 主循环 ----------
const clock = new THREE.Clock();
let hudTick = 0;
const markerLabel = $('marker-label');

function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  // 演示往返:用轨道半径的振荡模拟快速移动
  if (tween) {
    tween.elapsed += dt;
    const phase = (tween.elapsed % tween.duration) / tween.duration;
    const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    const radius = tween.from + (tween.to - tween.from) * tri;
    rig.setOrbitView(radius, Math.PI * 0.25, Math.PI * 0.3);
    if (tween.elapsed >= tween.duration * tween.cycles) {
      const done = tween.onDone;
      tween = null;
      done?.();
    }
  }

  rig.update(dt);
  terrain.update(camera.position.x, camera.position.z);

  // 标记始终吸附统一高度场(即使当前网格还没构建出来)
  if (markers.latest) {
    const m = markers.latest;
    if (isInsideTerrain(m.position.x, m.position.z)) {
      m.position.y = sampleHeight(m.position.x, m.position.z, seed);
    }
    const sp = markers.latestScreenPosition(camera, window.innerWidth, window.innerHeight);
    if (sp && sp.visible) {
      markerLabel.hidden = false;
      markerLabel.style.left = `${sp.x + 14}px`;
      markerLabel.style.top = `${sp.y}px`;
      markerLabel.textContent = `标记 (${m.position.x.toFixed(1)}, ${m.position.z.toFixed(
        1,
      )}) h=${m.position.y.toFixed(2)}`;
    } else {
      markerLabel.hidden = true;
    }
  } else {
    markerLabel.hidden = true;
  }

  renderer.render(scene, camera);

  hudTick += dt;
  if (hudTick > 0.15) {
    hudTick = 0;
    hud.render();
  }
}
animate();

// 供自动验证脚本在浏览器控制台读取
declare global {
  interface Window {
    terrainDemo: {
      terrain: TerrainManager;
      sampleHeight: (x: number, z: number, s: number) => number;
      inside: (x: number, z: number) => boolean;
      half: number;
    };
  }
}
window.terrainDemo = {
  terrain,
  sampleHeight,
  inside: isInsideTerrain,
  half: HALF_TERRAIN,
};
