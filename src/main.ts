import * as THREE from 'three';
import { Autopilot } from './autopilot';
import { CameraRig } from './camera';
import { Disc } from './disc';
import { Hud } from './hud';
import { InputState } from './input';
import { PANELS } from './panels';
import { buildWorld } from './world';

const FIXED_DT = 1 / 120;
const CAM_LABEL: Record<string, string> = {
  follow: '跟随（斜后方）',
  top: '顶面俯视',
  side: '侧面正视',
};

const container = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = false;
container.appendChild(renderer.domElement);

// 启动自检：邻接公共边必须几何重合
const adjErrors = Disc.validateAdjacencies();
if (adjErrors.length) console.error('[adjacency]', adjErrors);

const world = buildWorld();
const cameraRig = new CameraRig(window.innerWidth / window.innerHeight);
// 支持通过 URL hash 直接指定初始镜头：#top / #side / #follow
const hashMode = location.hash.replace('#', '') as 'top' | 'side' | 'follow';
if (hashMode === 'top' || hashMode === 'side' || hashMode === 'follow') cameraRig.setMode(hashMode);
const input = new InputState();
input.attach();
const disc = new Disc();
disc.reset();
const hud = new Hud();
const autopilot = new Autopilot();
autopilot.onVerdict = (text, ok) => hud.showVerdict(text, ok);

let paused = false;
let accumulator = 0;
let lastTime = performance.now();
const clock = new THREE.Clock();

// ---------------- 键盘事件 ----------------
window.addEventListener('keydown', (e) => {
  switch (e.code) {
    case 'KeyR':
      autopilot.stop();
      input.injected = null;
      disc.reset();
      hud.clearVerdict();
      break;
    case 'KeyP':
      paused = !paused;
      break;
    case 'KeyC':
      cameraRig.cycle();
      break;
    case 'KeyT':
      autopilot.start('route', disc);
      hud.clearVerdict();
      break;
    case 'KeyL':
      autopilot.start('landing', disc);
      hud.clearVerdict();
      break;
    case 'KeyG':
      autopilot.start('wiggle', disc);
      hud.clearVerdict();
      break;
  }
});

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  cameraRig.resize(window.innerWidth / window.innerHeight);
});

// ---------------- 固定步长模拟 ----------------
function step() {
  const panel = disc.mode === 'attached' ? disc.panel : null;
  const { intent, screenUpOnFace, screenRightOnFace } = input.worldIntent(
    cameraRig.camera,
    panel,
    cameraRig.mode,
  );

  const autoIntent = autopilot.update(FIXED_DT, disc);
  const finalIntent = autoIntent ?? intent;
  input.injected = autoIntent;

  disc.update(FIXED_DT, finalIntent);
  lastFrameInputUp.copy(screenUpOnFace);
  lastFrameInputRight.copy(screenRightOnFace);
}

const lastFrameInputUp = new THREE.Vector3(0, 0, -1);
const lastFrameInputRight = new THREE.Vector3(1, 0, 0);

// ---------------- 渲染同步 ----------------
const tmpMat = new THREE.Matrix4();
const contactQuat = new THREE.Quaternion();

function syncView() {
  const snap = disc.snapshot();

  // 圆盘外观
  world.discGroup.position.copy(snap.position).addScaledVector(snap.normal, 0);
  if (disc.mode === 'attached') {
    world.discGroup.quaternion.copy(disc.orientation);
  } else {
    // 自由飞行时保持水平，靠速度方向旋转
    tmpMat.lookAt(new THREE.Vector3(), snap.velocity.lengthSq() > 0.05 ? snap.velocity : snap.heading, new THREE.Vector3(0, 1, 0));
    world.discGroup.quaternion.setFromRotationMatrix(tmpMat);
  }

  // 接触面标记环
  world.contactMarker.visible = disc.mode === 'attached';
  if (disc.mode === 'attached') {
    world.contactMarker.position.copy(snap.contactPoint).addScaledVector(snap.normal, 0.02);
    tmpMat.makeBasis(disc.panel.uAxis, disc.panel.vAxis, disc.panel.normal);
    contactQuat.setFromRotationMatrix(tmpMat);
    world.contactMarker.quaternion.copy(contactQuat);
  }

  // 输入参照箭头（屏幕上/右 在当前面上的投影）
  if (disc.mode === 'attached') {
    world.inputFrame.visible = true;
    world.inputFrame.position.copy(snap.contactPoint).addScaledVector(snap.normal, 0.35);
    const up = world.inputFrame.getObjectByName('screenUp') as THREE.ArrowHelper;
    const right = world.inputFrame.getObjectByName('screenRight') as THREE.ArrowHelper;
    up.setDirection(lastFrameInputUp);
    right.setDirection(lastFrameInputRight);
  } else {
    world.inputFrame.visible = false;
  }

  cameraRig.update(clock.getDelta(), snap.position);
  hud.render(snap, paused, CAM_LABEL[cameraRig.mode], disc.lastSwitch, disc.events);
}

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  let frameDt = (now - lastTime) / 1000;
  lastTime = now;
  frameDt = Math.min(frameDt, 0.1);

  if (!paused) {
    accumulator += frameDt;
    let guard = 0;
    while (accumulator >= FIXED_DT && guard < 8) {
      step();
      accumulator -= FIXED_DT;
      guard++;
    }
    if (guard === 8) accumulator = 0;
  }

  syncView();
  renderer.render(world.scene, cameraRig.camera);
}

loop();

// 供控制台调试
declare global {
  interface Window {
    lab: { disc: Disc; autopilot: Autopilot; panels: typeof PANELS };
  }
}
window.lab = { disc, autopilot, panels: PANELS };
