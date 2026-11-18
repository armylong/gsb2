import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './style.css';
import { buildSceneObjects } from './scene';
import type { OutlineMode, SceneObject, LayoutName } from './types';
import { applyLayout, getLayoutCamera } from './layouts';
import { OutlinePipeline } from './outline';
import { runVerification } from './verify';

const canvas = document.getElementById('scene') as HTMLCanvasElement;

// ---------- 渲染器与场景 ----------
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  // 保留绘制缓冲，使 canvas 截图 / drawImage 回读可用于验证
  preserveDrawingBuffer: true,
});
renderer.setClearColor(0x14171c);
const DPR = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(DPR);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// 灯光：半球光 + 两盏方向光，保证曲面层次
scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x2a3038, 1.1));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
keyLight.position.set(5, 8, 7);
const fillLight = new THREE.DirectionalLight(0x9fc0ff, 0.6);
fillLight.position.set(-6, 3, -4);
scene.add(keyLight, fillLight);

// 地面参考网格（不参与拾取与描边）
const grid = new THREE.GridHelper(24, 24, 0x3a4351, 0x232a34);
grid.position.y = -1.75;
scene.add(grid);

// ---------- 对象 ----------
const { objects, occluder } = buildSceneObjects();
for (const obj of objects) scene.add(obj.group);
scene.add(occluder);

const pipeline = new OutlinePipeline(renderer, objects);

// 测试钩子：供自动化测试直接回读轮廓蒙版（不影响正常交互）
declare global {
  interface Window {
    __outlineDemo?: {
      pipeline: OutlinePipeline;
      getScene: () => THREE.Scene;
      getCamera: () => THREE.PerspectiveCamera;
      getObjects: () => SceneObject[];
      projectCss: (world: THREE.Vector3) => { x: number; y: number };
    };
  }
}
window.__outlineDemo = {
  pipeline,
  getScene: () => scene,
  getCamera: () => camera,
  getObjects: () => objects,
  // 测试用：投影辅助
  projectCss: (world: THREE.Vector3) => {
    const v = world.clone().project(camera);
    return {
      x: ((v.x + 1) / 2) * canvas.clientWidth,
      y: ((1 - v.y) / 2) * canvas.clientHeight,
    };
  },
};

// ---------- 应用状态 ----------
const state = {
  layout: 'occlusion' as LayoutName,
  mode: 'hidden' as OutlineMode,
  lineWidthCss: 2,
  selected: new Set<number>(),
};

function selectableObjects(): SceneObject[] {
  return objects.filter((o) => !o.hidden);
}

/** 隐藏/恢复：同时控制场景可见性与描边/拾取资格，恢复后对象身份（id、颜色）不变。 */
function setObjectHidden(obj: SceneObject, hidden: boolean): void {
  obj.hidden = hidden;
  obj.group.visible = !hidden;
}

function resetView(): void {
  const preset = getLayoutCamera(state.layout);
  camera.position.set(...preset.position);
  controls.target.set(...preset.target);
  camera.updateProjectionMatrix();
  controls.update();
}

function applyCurrentLayout(name: LayoutName): void {
  state.layout = name;
  applyLayout(name, objects, occluder);
  const slider = document.getElementById('occluder-slider') as HTMLInputElement;
  slider.value = String(occluder.position.z);
  document.getElementById('occluder-label')!.textContent = occluder.position.z.toFixed(2);
  resetView();
  syncLayoutButtons();
}

// ---------- 尺寸 ----------
function resize(): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pipeline.setSize(w * DPR, h * DPR);
}
window.addEventListener('resize', resize);

// ---------- 拾取 ----------
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const rect = canvas.getBoundingClientRect();
  const xCss = event.clientX - rect.left;
  const yCss = event.clientY - rect.top;
  const id = pipeline.pick(xCss * DPR, yCss * DPR, selectableObjects(), camera);
  if (id <= 0) {
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) state.selected.clear();
  } else if (event.shiftKey || event.ctrlKey || event.metaKey) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
  } else {
    state.selected.clear();
    state.selected.add(id);
  }
  syncList();
  syncStatus();
});

// ---------- UI：对象列表 ----------
const listEl = document.getElementById('object-list')!;
function buildList(): void {
  listEl.innerHTML = '';
  for (const obj of objects) {
    const li = document.createElement('li');
    li.dataset.id = String(obj.id);
    li.innerHTML = `<span class="dot" style="background:#${obj.color.getHexString()}"></span>
      <span class="obj-name"></span><span class="obj-state"></span>`;
    li.querySelector('.obj-name')!.textContent = obj.name;
    li.addEventListener('click', () => {
      if (obj.hidden) return;
      if (state.selected.has(obj.id)) state.selected.delete(obj.id);
      else state.selected.add(obj.id);
      syncList();
      syncStatus();
    });
    listEl.appendChild(li);
  }
}

function syncList(): void {
  for (const li of Array.from(listEl.children) as HTMLLIElement[]) {
    const id = Number(li.dataset.id);
    const obj = objects[id - 1];
    li.classList.toggle('selected', state.selected.has(id));
    li.classList.toggle('hidden-item', obj.hidden);
    li.querySelector('.obj-state')!.textContent = obj.hidden
      ? '已隐藏'
      : state.selected.has(id)
        ? '已选中'
        : '';
  }
}

function syncStatus(): void {
  const names = [...state.selected].map((id) => objects[id - 1].name).join('、');
  document.getElementById('status-bar')!.textContent =
    `选中 ${state.selected.size} 个对象${names ? '：' + names : ''}｜模式：${
      state.mode === 'hidden' ? '可见+遮挡轮廓' : '仅可见轮廓'
    }｜宽度 ${state.lineWidthCss}px`;
}

function syncLayoutButtons(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-layout]')) {
    btn.classList.toggle('active', btn.dataset.layout === state.layout);
  }
}

function syncModeButtons(): void {
  document.getElementById('btn-visible')!.classList.toggle('active', state.mode === 'visible');
  document.getElementById('btn-hidden')!.classList.toggle('active', state.mode === 'hidden');
}

// ---------- UI 事件 ----------
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-layout]')) {
  btn.addEventListener('click', () => applyCurrentLayout(btn.dataset.layout as LayoutName));
}

document.getElementById('btn-visible')!.addEventListener('click', () => {
  state.mode = 'visible';
  syncModeButtons();
  syncStatus();
});
document.getElementById('btn-hidden')!.addEventListener('click', () => {
  state.mode = 'hidden';
  syncModeButtons();
  syncStatus();
});

const widthSlider = document.getElementById('width-slider') as HTMLInputElement;
widthSlider.addEventListener('input', () => {
  state.lineWidthCss = Number(widthSlider.value);
  document.getElementById('width-label')!.textContent = `${state.lineWidthCss} px`;
  syncStatus();
});

const occluderSlider = document.getElementById('occluder-slider') as HTMLInputElement;
occluderSlider.addEventListener('input', () => {
  occluder.position.z = Number(occluderSlider.value);
  document.getElementById('occluder-label')!.textContent = occluder.position.z.toFixed(2);
});

document.getElementById('btn-hide')!.addEventListener('click', () => {
  for (const id of state.selected) {
    setObjectHidden(objects[id - 1], true);
  }
  // 隐藏后从选择集合移除，立即停止描边
  state.selected.clear();
  syncList();
  syncStatus();
});

document.getElementById('btn-restore')!.addEventListener('click', () => {
  for (const obj of objects) setObjectHidden(obj, false);
  syncList();
  syncStatus();
});

document.getElementById('btn-clear')!.addEventListener('click', () => {
  state.selected.clear();
  syncList();
  syncStatus();
});

document.getElementById('btn-reset-view')!.addEventListener('click', resetView);

document.getElementById('btn-verify')!.addEventListener('click', () => {
  const out = document.getElementById('verify-results')!;
  out.textContent = '验证中……';
  // 让浏览器先刷新提示文本，再执行同步像素读取
  requestAnimationFrame(() => {
    try {
      const report = runVerification({
        renderer,
        scene,
        camera,
        pipeline,
        objects,
        occluder,
        widthCss: canvas.clientWidth,
        heightCss: canvas.clientHeight,
        dpr: DPR,
        selectedIds: [...state.selected],
        lineWidthCss: state.lineWidthCss,
      });
      out.textContent = report;
    } catch (err) {
      out.textContent = '验证执行失败：' + (err instanceof Error ? err.stack : String(err));
    }
    // 验证会改动布局与机位，恢复用户当前布局视角
    applyCurrentLayout(state.layout);
    syncList();
  });
});

// ---------- 主循环 ----------
function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  const selectedObjects = objects.filter((o) => state.selected.has(o.id) && !o.hidden);
  pipeline.render(
    scene,
    camera,
    selectedObjects,
    state.mode,
    state.lineWidthCss,
    DPR,
  );
}

// ---------- 启动 ----------
buildList();
widthSlider.value = String(state.lineWidthCss);
document.getElementById('width-label')!.textContent = `${state.lineWidthCss} px`;
applyCurrentLayout('occlusion');
resize();
syncModeButtons();
syncList();
syncStatus();
animate();
