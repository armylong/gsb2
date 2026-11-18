import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MirrorRig } from './mirror';
import { buildScene } from './scene';
import { reflectPoint, reflectVector, signedDistance, type Plane } from './reflectMath';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (v: THREE.Vector3) => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;

// ---------- 渲染器 / 场景 / 相机 ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d22);
scene.fog = new THREE.Fog(0x1a1d22, 30, 90);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 1.8, 5.5);
camera.layers.enable(1); // layer 1：辅助线层（反射相机不可见）

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.2, 0);
controls.maxPolarAngle = Math.PI * 0.495;

scene.add(new THREE.HemisphereLight(0xffffff, 0x333a44, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(6, 10, 4);
scene.add(sun);

buildScene(scene);

// ---------- 镜子 ----------
const pr = renderer.getPixelRatio();
const mirror = new MirrorRig(window.innerWidth * pr, window.innerHeight * pr);
scene.add(mirror);

const mirrorState = { x: 0, z: -3, rot: 0 };
function applyMirrorPose(): void {
  mirror.setPose(mirrorState.x, mirrorState.z, mirrorState.rot);
  ($('m-x') as HTMLInputElement).value = String(mirrorState.x);
  ($('m-z') as HTMLInputElement).value = String(mirrorState.z);
  ($('m-rot') as HTMLInputElement).value = String(mirrorState.rot);
  $('m-x-v').textContent = mirrorState.x.toFixed(2);
  $('m-z-v').textContent = mirrorState.z.toFixed(2);
  $('m-rot-v').textContent = `${mirrorState.rot.toFixed(0)}°`;
}

// ---------- 辅助标记（layer 1，不会进入镜中倒影） ----------
function markOnHelperLayer<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => c.layers.set(1));
  return o;
}
// 反射（虚拟）相机位置 + 观察方向
const vcamMarker = markOnHelperLayer(new THREE.Mesh(
  new THREE.SphereGeometry(0.09, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0x35d0e0 })
));
scene.add(vcamMarker);
const vcamArrow = markOnHelperLayer(new THREE.ArrowHelper(
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1.0, 0x35d0e0, 0.18, 0.1
));
scene.add(vcamArrow);
// 参照点（layer 0：真实物体，镜中可见其倒影）
const refMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.07, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xff4444 })
);
scene.add(refMarker);
// 镜像点（layer 1：计算结果指示，不参与反射）
const imgMarker = markOnHelperLayer(new THREE.Mesh(
  new THREE.SphereGeometry(0.07, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0x44ff66, wireframe: true })
));
scene.add(imgMarker);

// ---------- 参照点 ----------
const refPoint = new THREE.Vector3(1, 1, 2);
function readRefPoint(): void {
  refPoint.set(
    parseFloat(($('rp-x') as HTMLInputElement).value) || 0,
    parseFloat(($('rp-y') as HTMLInputElement).value) || 0,
    parseFloat(($('rp-z') as HTMLInputElement).value) || 0
  );
}
(['rp-x', 'rp-y', 'rp-z'] as const).forEach((id) => $(id).addEventListener('input', readRefPoint));
readRefPoint();

// ---------- 日志 ----------
function log(lines: string[]): void {
  const el = $('log');
  const time = new Date().toLocaleTimeString();
  el.textContent = `[${time}]\n${lines.join('\n')}\n\n${el.textContent}`.slice(0, 6000);
}

// ---------- 现场预设 ----------
interface Preset { mirror: { x: number; z: number; rot: number }; cam: [number, number, number]; target: [number, number, number] }
const presets: Record<string, Preset> = {
  p1: { mirror: { x: 0, z: -3, rot: 0 }, cam: [0, 1.6, 4.5], target: [0, 1.3, -3] },
  p2: { mirror: { x: 1.5, z: -1, rot: 35 }, cam: [-2.5, 2.2, 4.5], target: [1.5, 1.3, -1] },
  p3: { mirror: { x: 0, z: 0.3, rot: 0 }, cam: [0, 1.5, 5.5], target: [0, 1.2, 0.3] },
};
function applyPreset(key: string): void {
  const p = presets[key];
  mirrorState.x = p.mirror.x; mirrorState.z = p.mirror.z; mirrorState.rot = p.mirror.rot;
  applyMirrorPose();
  camera.position.set(...p.cam);
  controls.target.set(...p.target);
  controls.update();
  log([`已恢复现场：${key === 'p1' ? '正对' : key === 'p2' ? '斜置' : '前后物体夹持镜面'}`]);
}
$('btn-p1').addEventListener('click', () => applyPreset('p1'));
$('btn-p2').addEventListener('click', () => applyPreset('p2'));
$('btn-p3').addEventListener('click', () => applyPreset('p3'));

// ---------- 反射开关 ----------
$('btn-toggle').addEventListener('click', () => {
  const on = !mirror.isReflectionEnabled();
  mirror.setReflectionEnabled(on);
  const btn = $('btn-toggle');
  btn.textContent = `反射：${on ? '开' : '关'}`;
  btn.classList.toggle('active', !on);
  log([`反射已${on ? '开启（Reflector 实时渲染）' : '关闭（替换为哑光面板，用于对照）'}`]);
});

// ---------- 自检 ----------
$('btn-check').addEventListener('click', () => {
  const lines: string[] = [];
  const ok = (b: boolean) => (b ? '✓' : '✗ 失败');

  // 1) 已知点核对（手算期望值）：镜面 z=-3、法线 +Z，P(1,1,2) → P'(1,1,-8)
  const fixedPlane: Plane = { point: new THREE.Vector3(0, 0, -3), normal: new THREE.Vector3(0, 0, 1) };
  const p0 = new THREE.Vector3(1, 1, 2);
  const p0i = reflectPoint(p0, fixedPlane);
  const expect = new THREE.Vector3(1, 1, -8);
  lines.push(`[1] 已知点核对：P(1,1,2) 关于镜面 z=-3`);
  lines.push(`    计算 ${fmt(p0i)}  期望 (1.000, 1.000, -8.000)  ${ok(p0i.distanceTo(expect) < 1e-9)}`);

  // 2) 当前镜面下两次反射还原
  const plane = mirror.getPlane();
  const p1 = reflectPoint(refPoint, plane);
  const p2 = reflectPoint(p1, plane);
  const err2 = p2.distanceTo(refPoint);
  lines.push(`[2] 两次反射还原（当前镜面）：P=${fmt(refPoint)} → P'=${fmt(p1)} → P''=${fmt(p2)}`);
  lines.push(`    |P''-P| = ${err2.toExponential(3)}  ${ok(err2 < 1e-6)}`);

  // 3) 反射相机：与主相机关于镜面对称（到镜面距离互为相反数）
  const vc = reflectPoint(camera.position, plane);
  const dCam = signedDistance(camera.position, plane);
  const dVc = signedDistance(vc, plane);
  lines.push(`[3] 反射相机位置 ${fmt(vc)}；主相机到镜面有符号距离 ${dCam.toFixed(4)}，虚相机 ${dVc.toFixed(4)}，和 ${(dCam + dVc).toExponential(2)}  ${ok(Math.abs(dCam + dVc) < 1e-6)}`);

  // 4) 与 Reflector 内部虚拟相机交叉核对（若该版本暴露了 camera）
  const internal = (mirror.reflector as unknown as { camera?: THREE.PerspectiveCamera }).camera;
  if (internal) {
    const d = internal.position.distanceTo(vc);
    lines.push(`[4] Reflector 内部虚拟相机 ${fmt(internal.position)}，与解析值偏差 ${d.toExponential(2)}  ${ok(d < 1e-4)}`);
  } else {
    lines.push(`[4] 当前 three 版本未暴露 Reflector 内部相机，跳过交叉核对（[3] 解析式与 Reflector 同源）`);
  }

  // 5) 镜像保距：P 与 P' 到镜面距离相等、中点在镜面上
  const mid = refPoint.clone().add(p1).multiplyScalar(0.5);
  const dMid = signedDistance(mid, plane);
  lines.push(`[5] 保距性：|d(P)|=${Math.abs(signedDistance(refPoint, plane)).toFixed(4)}，|d(P')|=${Math.abs(signedDistance(p1, plane)).toFixed(4)}；PP' 中点到镜面距离 ${dMid.toExponential(2)}  ${ok(Math.abs(dMid) < 1e-6)}`);

  lines.push(`画面依据：镜中文字板应左右反转（"FRONT→" 箭头指向镜内左方）；现场3 中蓝色柱（镜后）不得出现在镜中，绿色柱（镜前）应遮挡镜面下缘。`);
  log(lines);
});

// ---------- 镜子拖拽 / 旋转 ----------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let dragging = false;
const dragOffset = new THREE.Vector3();

function groundHit(e: PointerEvent): THREE.Vector3 | null {
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  if (raycaster.intersectObject(mirror, true).length > 0) {
    const p = groundHit(e);
    if (p) {
      dragging = true;
      controls.enabled = false;
      dragOffset.copy(mirror.position).sub(p);
      renderer.domElement.setPointerCapture(e.pointerId);
    }
  }
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const p = groundHit(e);
  if (p) {
    mirrorState.x = THREE.MathUtils.clamp(p.x + dragOffset.x, -8, 8);
    mirrorState.z = THREE.MathUtils.clamp(p.z + dragOffset.z, -8, 8);
    applyMirrorPose();
  }
});
renderer.domElement.addEventListener('pointerup', () => {
  dragging = false;
  controls.enabled = true;
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'q' || e.key === 'Q') { mirrorState.rot = (mirrorState.rot + 4 + 180) % 360 - 180; applyMirrorPose(); }
  if (e.key === 'e' || e.key === 'E') { mirrorState.rot = (mirrorState.rot - 4 + 180) % 360 - 180; applyMirrorPose(); }
});

// ---------- 滑条 ----------
($('m-x') as HTMLInputElement).addEventListener('input', (e) => { mirrorState.x = parseFloat((e.target as HTMLInputElement).value); applyMirrorPose(); });
($('m-z') as HTMLInputElement).addEventListener('input', (e) => { mirrorState.z = parseFloat((e.target as HTMLInputElement).value); applyMirrorPose(); });
($('m-rot') as HTMLInputElement).addEventListener('input', (e) => { mirrorState.rot = parseFloat((e.target as HTMLInputElement).value); applyMirrorPose(); });

// ---------- 窗口变化：相机与反射分辨率同步，镜内图像不拉伸 ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  const ratio = renderer.getPixelRatio();
  mirror.setTextureSize(window.innerWidth * ratio, window.innerHeight * ratio);
});

// ---------- 无效观察位置提示 ----------
const hintEl = $('hint');
function updateHint(plane: Plane): void {
  const d = signedDistance(camera.position, plane);
  const viewDir = camera.getWorldDirection(new THREE.Vector3());
  const grazing = Math.abs(viewDir.dot(plane.normal));
  let msg = '';
  if (d < 0) msg = '相机位于镜子背面：只能看到封闭背板，镜面反射不可见（无效观察位置）';
  else if (d < 0.25) msg = '相机非常接近镜面：反射视角接近极限，注意近裁剪';
  else if (grazing < 0.04) msg = '视线几乎与镜面平行：可见反射区域极窄';
  hintEl.style.display = msg ? 'block' : 'none';
  hintEl.textContent = msg;
}

// ---------- 主循环 ----------
const roEl = $('ro');
function animate(): void {
  requestAnimationFrame(animate);
  controls.update();

  const plane = mirror.getPlane();
  const vcamPos = reflectPoint(camera.position, plane);
  const vdir = reflectVector(camera.getWorldDirection(new THREE.Vector3()), plane.normal).normalize();
  const imgPoint = reflectPoint(refPoint, plane);
  const imgPoint2 = reflectPoint(imgPoint, plane);

  vcamMarker.position.copy(vcamPos);
  vcamArrow.position.copy(vcamPos);
  vcamArrow.setDirection(vdir);
  refMarker.position.copy(refPoint);
  imgMarker.position.copy(imgPoint);

  roEl.textContent =
    `镜面法线 n   ${fmt(plane.normal)}\n` +
    `镜面中心 P0  ${fmt(plane.point)}\n` +
    `主相机位置   ${fmt(camera.position)}\n` +
    `反射相机位置 ${fmt(vcamPos)}\n` +
    `反射观察方向 ${fmt(vdir)}\n` +
    `参照点 P     ${fmt(refPoint)}\n` +
    `镜像 P'      ${fmt(imgPoint)}\n` +
    `二次镜像 P'' ${fmt(imgPoint2)}（应等于 P）`;

  updateHint(plane);
  renderer.render(scene, camera);
}

applyMirrorPose();
applyPreset('p1');
animate();
