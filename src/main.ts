import * as THREE from 'three';
import { Portal, portalTransform, updatePortalTexture } from './portal';
import { buildWorld } from './world';
import { WalkControls } from './controls';
import { createUI } from './ui';

// ---------- 渲染器 / 场景 / 相机 ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101418);
scene.fog = new THREE.Fog(0x101418, 30, 90);

const EYE_HEIGHT = 1.6;
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, EYE_HEIGHT, 7);

buildWorld(scene);

const bufSize = renderer.getDrawingBufferSize(new THREE.Vector2());
const portalA = new Portal('A', 0xffa040, bufSize.x, bufSize.y);
const portalB = new Portal('B', 0x40c8ff, bufSize.x, bufSize.y);
scene.add(portalA.group, portalB.group);

const controls = new WalkControls(camera, renderer.domElement);

// ---------- 预设 ----------
interface Pose { x: number; z: number; ry: number }
interface Preset { a: Pose; b: Pose; cam: { x: number; z: number; yaw: number } }

const PRESETS: Record<string, Preset> = {
  // 正对：两门正面相对
  face: { a: { x: -4, z: 0, ry: 90 }, b: { x: 4, z: 0, ry: -90 }, cam: { x: 0, z: 7, yaw: 0 } },
  // 错位：两门朝向相同、位置错开
  offset: { a: { x: -4, z: -3, ry: 0 }, b: { x: 4, z: 3, ry: 0 }, cam: { x: -4, z: 3, yaw: 0 } },
  // 直角：两门互成 90°
  right: { a: { x: -4, z: 0, ry: 90 }, b: { x: 0, z: -4, ry: 0 }, cam: { x: 3, z: 4, yaw: 0.6 } },
};
let currentPreset = 'face';

function applyPreset(name: string): void {
  const p = PRESETS[name];
  if (!p) return;
  currentPreset = name;
  portalA.setPose(p.a.x, p.a.z, p.a.ry);
  portalB.setPose(p.b.x, p.b.z, p.b.ry);
  ui.setPose('A', p.a.x, p.a.z, p.a.ry);
  ui.setPose('B', p.b.x, p.b.z, p.b.ry);
  resetCamera();
}

function resetCamera(): void {
  const c = PRESETS[currentPreset].cam;
  camera.position.set(c.x, EYE_HEIGHT, c.z);
  controls.yaw = c.yaw;
  controls.pitch = 0;
  controls.apply();
  camera.updateMatrixWorld();
}

const ui = createUI({
  onPreset: applyPreset,
  onResetCamera: resetCamera,
  onPortalPose(id, x, z, ry) {
    (id === 'A' ? portalA : portalB).setPose(x, z, ry);
  },
});

// ---------- 传送 ----------
const prevPos = camera.position.clone();
let framesSinceTeleport = 999;
let lastTeleportText = '无';

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpRot = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();

/** 仅当相机从门户正面跨过平面且交点位于开口内时传送 */
function tryTeleport(): void {
  const pairs: [Portal, Portal][] = [[portalA, portalB], [portalB, portalA]];
  for (const [src, dst] of pairs) {
    const p0 = src.group.worldToLocal(tmpA.copy(prevPos));
    const p1 = src.group.worldToLocal(tmpB.copy(camera.position));
    // 正面(局部 z>0) → 背面(z<=0) 的跨越才有效；从背面接近、沿平面滑动均不触发
    if (p0.z <= 0 || p1.z > 0) continue;
    const t = p0.z / (p0.z - p1.z);
    const hx = p0.x + (p1.x - p0.x) * t;
    const hy = p0.y + (p1.y - p0.y) * t;
    if (Math.abs(hx) > src.width / 2 || hy < 0 || hy > src.height) continue;
    doTeleport(src, dst);
    return;
  }
}

function doTeleport(src: Portal, dst: Portal): void {
  const beforePos = camera.position.clone();
  const beforeQuat = camera.quaternion.clone();

  // 位置与朝向整体经 M 映射，保留相对位姿与继续移动的方向
  portalTransform(src, dst, tmpM);
  camera.position.applyMatrix4(tmpM);
  tmpRot.extractRotation(tmpM);
  tmpQ.setFromRotationMatrix(tmpRot);
  camera.quaternion.premultiply(tmpQ);
  camera.updateMatrixWorld();
  controls.syncFromCamera();
  prevPos.copy(camera.position); // 关键：同步 prevPos，下一帧不会立即传送回来

  // 连续性校验：穿越前后视线在各自门户局部系下应满足 (x,y,z)→(-x,y,-z)
  const srcInvQ = src.group.quaternion.clone().invert();
  const dstInvQ = dst.group.quaternion.clone().invert();
  const d0 = new THREE.Vector3(0, 0, -1).applyQuaternion(beforeQuat).applyQuaternion(srcInvQ);
  const d1 = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).applyQuaternion(dstInvQ);
  const expect = new THREE.Vector3(-d0.x, d0.y, -d0.z);
  const dirErr = THREE.MathUtils.radToDeg(d1.angleTo(expect));
  const posErr = beforePos.clone().applyMatrix4(tmpM).distanceTo(camera.position);

  framesSinceTeleport = 0;
  lastTeleportText = [
    `门户${src.label} → 门户${dst.label}`,
    `  穿越前 pos ${fmtV(beforePos)}  视线(src局部) ${fmtV(d0)}`,
    `  穿越后 pos ${fmtV(camera.position)}  视线(dst局部) ${fmtV(d1)}`,
    `  位置还原误差 ${(posErr * 1000).toFixed(3)} mm   视线连续误差 ${dirErr.toFixed(5)}°`,
  ].join('\n');
}

// ---------- 调试信息 ----------
const dbgM_AB = new THREE.Matrix4();
const dbgM_BA = new THREE.Matrix4();
const dbgE = new THREE.Matrix4();
const dbgV = new THREE.Vector3();
const dbgEuler = new THREE.Euler();

function fmtV(v: THREE.Vector3): string {
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
}

function yawOf(q: THREE.Quaternion): string {
  dbgEuler.setFromQuaternion(q, 'YXZ');
  return `${THREE.MathUtils.radToDeg(dbgEuler.y).toFixed(1)}°`;
}

function portalState(p: Portal): string {
  const lp = p.group.worldToLocal(dbgV.copy(camera.position));
  const side = lp.z > 0 ? '正面侧' : '背面侧';
  const inOpening = Math.abs(lp.x) <= p.width / 2 && lp.y >= 0 && lp.y <= p.height;
  return (
    `门户${p.label}  ${side}  局部${fmtV(lp)}  开口内:${inOpening ? '是' : '否'}` +
    `  位姿 x=${p.pose.x.toFixed(1)} z=${p.pose.z.toFixed(1)} 旋转=${p.pose.ry.toFixed(0)}°`
  );
}

function buildDebugText(): string {
  // 映射还原误差：M_BA · M_AB 应为单位阵，用它变换当前相机姿态检查误差
  portalTransform(portalA, portalB, dbgM_AB);
  portalTransform(portalB, portalA, dbgM_BA);
  dbgE.multiplyMatrices(dbgM_BA, dbgM_AB);
  const posErr = dbgV.copy(camera.position).applyMatrix4(dbgE).distanceTo(camera.position);
  tmpRot.extractRotation(dbgE);
  tmpQ.setFromRotationMatrix(tmpRot);
  const rotErr = THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(tmpQ.w))));

  return [
    '== 相机 ==',
    `主相机   pos ${fmtV(camera.position)}  yaw ${yawOf(camera.quaternion)}`,
    `映射相机A pos ${fmtV(portalA.virtualCamera.position)}  yaw ${yawOf(portalA.virtualCamera.quaternion)}  (经B口向外看)`,
    `映射相机B pos ${fmtV(portalB.virtualCamera.position)}  yaw ${yawOf(portalB.virtualCamera.quaternion)}  (经A口向外看)`,
    '',
    '== 门户触发状态 ==',
    portalState(portalA),
    portalState(portalB),
    `距上次穿越: ${framesSinceTeleport} 帧`,
    '',
    '== 相互映射还原误差 (A→B→A) ==',
    `位置误差 ${(posErr * 1000).toFixed(4)} mm   姿态误差 ${rotErr.toFixed(6)}°`,
    '',
    '== 最近穿越 ==',
    lastTeleportText,
  ].join('\n');
}

// ---------- 主循环 ----------
const clock = new THREE.Clock();

function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  prevPos.copy(camera.position);
  controls.update(dt);
  camera.updateMatrixWorld();
  tryTeleport();
  framesSinceTeleport++;
  camera.updateMatrixWorld();
  scene.updateMatrixWorld();

  // 两个门户各自渲染另一端的画面（单层）
  updatePortalTexture(renderer, scene, camera, portalA, portalB);
  updatePortalTexture(renderer, scene, camera, portalB, portalA);

  ui.setDebug(buildDebugText());
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  const s = renderer.getDrawingBufferSize(new THREE.Vector2());
  portalA.resize(s.x, s.y);
  portalB.resize(s.x, s.y);
});

applyPreset('face');
animate();
