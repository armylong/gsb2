import * as THREE from 'three';
import './style.css';
import { createEnvironment } from './environment';
import { CameraRig, POSES } from './cameraRig';
import { createSigns } from './signs';
import { Picker } from './picking';
import { ReferenceRig } from './references';
import { LabUI } from './ui';
import type { Sign } from './Sign';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const env = createEnvironment();
const rig = new CameraRig(canvas);
const signs = createSigns(env.shelf, env.scene);
const picker = new Picker();
const refs = new ReferenceRig();
env.scene.add(refs.group);

let shelfAnim = true;
const ui = new LabUI(
  POSES,
  {
    onFaceMode: (id, mode) => signs.find((s) => s.id === id)?.setFaceMode(mode),
    onSizeMode: (id, mode) => signs.find((s) => s.id === id)?.setSizeMode(mode),
    onCameraKind: (kind) => rig.switchKind(kind),
    onPose: (pose) => rig.applyPose(pose),
    onToggleReferences: (on) => {
      refs.setVisible(on);
      signs.forEach((s) => s.setReferenceVisible(on));
    },
    onToggleShelf: (on) => {
      shelfAnim = on;
    },
  },
  true,
  true,
);
signs.forEach((s) => s.setReferenceVisible(true));

// ---- 点选与悬停（同一套射线，遮挡结果由 Picker 保证） ----
let hovered: string | null = null;
let selectedId: string | null = null;

function pickAt(clientX: number, clientY: number) {
  return picker.pick(clientX, clientY, rig.active, signs, env.occluders);
}

canvas.addEventListener('pointermove', (e) => {
  const hit = pickAt(e.clientX, e.clientY);
  const hitId = hit?.id ?? null;
  if (hitId !== hovered) {
    signs.find((s) => s.id === hovered)?.setHighlight(false);
    hovered = hitId;
    const h = signs.find((s) => s.id === hovered);
    h?.setHighlight(true);
    canvas.style.cursor = h ? 'pointer' : '';
  }
});

canvas.addEventListener('click', (e) => {
  const hit = pickAt(e.clientX, e.clientY);
  selectedId = hit?.id ?? null;
  ui.setSelected(selectedId);
});

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  rig.resize();
});

// ---- 渲染循环 ----
const clock = new THREE.Clock();
const anchorOut = new THREE.Vector3();

function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const elapsed = clock.elapsedTime;

  rig.update();
  if (shelfAnim) env.update(elapsed);
  env.scene.updateMatrixWorld();

  for (const sign of signs) sign.update(rig.active, dt);

  const selected = signs.find((s) => s.id === selectedId) ?? null;
  refs.update(
    rig.active,
    selected ? selected.group.getWorldPosition(anchorOut) : null,
  );

  ui.refresh(signs, rig.kind);
  renderer.render(env.scene, rig.active);
}

// 调试 / 端到端钩子：只读暴露运行态，测试脚本通过它断言
declare global {
  interface Window {
    __lab: {
      signs: typeof signs;
      rig: typeof rig;
      occluders: THREE.Object3D[];
      pickAt: (x: number, y: number) => string | null;
      pickIgnoringOccluders: (x: number, y: number) => string | null;
      setFace: (id: string, mode: Parameters<Sign['setFaceMode']>[0]) => void;
      setShelfAnim: (on: boolean) => void;
    };
  }
}
window.__lab = {
  signs,
  rig,
  occluders: env.occluders,
  pickAt: (x, y) => pickAt(x, y)?.id ?? null,
  pickIgnoringOccluders: (x, y) =>
    picker.pickIgnoringOccluders(x, y, rig.active, signs)?.id ?? null,
  setFace: (id, mode) => signs.find((s) => s.id === id)?.setFaceMode(mode),
  setShelfAnim: (on: boolean) => {
    shelfAnim = on;
  },
};

animate();
