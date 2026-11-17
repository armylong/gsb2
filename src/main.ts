import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import {
  applySnapshot,
  snapshotTransform,
  validateProjector,
  type ProjectorParams,
} from './decalMath';
import { createDecalTexture } from './decalTexture';
import { DecalSystem } from './decalSystem';
import { PRESETS } from './presets';
import { ProjectorHelper } from './projector';
import { parseScene, serializeScene, type SceneRecord } from './sceneIO';
import { createTargetGeometry, TARGET_LABELS, type TargetType } from './targets';
import { runAllChecks } from './verify';

// ---------- 渲染基础 ----------
const viewport = document.getElementById('viewport')!;
const panel = document.getElementById('panel')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.position.set(4.5, 3.2, 6);
camera.layers.enable(1); // layer 1: 辅助线

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30363f, 1.1));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
dirLight.position.set(4, 6, 5);
scene.add(dirLight);

const grid = new THREE.GridHelper(12, 12, 0x39414d, 0x262c35);
grid.layers.set(1);
scene.add(grid);
const axes = new THREE.AxesHelper(1.2);
axes.layers.set(1);
scene.add(axes);

// ---------- 应用状态 ----------
interface AppState {
  targetType: TargetType;
  targetColor: string;
  decalColor: string;
  projector: ProjectorParams;
  firstSurfaceOnly: boolean;
}
const state: AppState = {
  targetType: 'box',
  targetColor: '#5a7a9e',
  decalColor: '#ff8c2a',
  projector: { position: [0.4, 0.9, 4], lookAt: [0.9, 0.4, 0], fovDeg: 32, near: 1, far: 9 },
  firstSurfaceOnly: true,
};

// ---------- 目标 ----------
const decalSystem = new DecalSystem(createDecalTexture());
let targetMesh: THREE.Mesh;

function rebuildTarget(): void {
  const old = targetMesh as THREE.Mesh | undefined;
  if (old) {
    transformControls.detach();
    scene.remove(old);
    old.geometry.dispose();
    (old.material as THREE.Material).dispose();
  }
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(state.targetColor),
    roughness: 0.75,
    metalness: 0.05,
    flatShading: true,
  });
  decalSystem.inject(mat);
  targetMesh = new THREE.Mesh(createTargetGeometry(state.targetType), mat);
  targetMesh.frustumCulled = false; // 深度通道用自定义相机,避免被主视锥剔除
  scene.add(targetMesh);
  transformControls.attach(targetMesh);
  decalSystem.clear();
  refreshDecalInfo();
}

// ---------- 投影机辅助线 ----------
const projectorHelper = new ProjectorHelper();
scene.add(projectorHelper);

// ---------- 目标变换手柄 ----------
const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
});
scene.add(transformControls.getHelper());
// 变换手柄只是辅助物:移到 layer 1,避免进入贴花深度通道遮挡首表面判定
transformControls.getHelper().traverse((o) => o.layers.set(1));

// ================= UI =================
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  parent: HTMLElement = panel,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  parent.appendChild(e);
  return e;
}

function section(title: string): HTMLElement {
  return el('h2', { text: title });
}

el('h1', { text: '三维透视贴花投射演示' });

// ---- 目标 ----
section('目标');
{
  const row = el('div', { class: 'row' });
  el('label', { text: '目标类型' }, row);
  const sel = el('select', {}, row);
  for (const [value, label] of Object.entries(TARGET_LABELS)) {
    const opt = el('option', { value, text: label }, sel);
    if (value === state.targetType) opt.selected = true;
  }
  sel.onchange = () => {
    state.targetType = sel.value as TargetType;
    rebuildTarget();
  };
  const row2 = el('div', { class: 'row' });
  el('label', { text: '目标颜色' }, row2);
  const color = el('input', { type: 'color', value: state.targetColor }, row2);
  color.oninput = () => {
    state.targetColor = color.value;
    (targetMesh.material as THREE.MeshStandardMaterial).color.set(color.value);
  };
  const row3 = el('div', { class: 'row' });
  el('label', { text: '目标变换' }, row3);
  for (const [mode, label] of [
    ['translate', '移动'],
    ['rotate', '旋转'],
    ['scale', '缩放'],
  ] as const) {
    const b = el('button', { text: label }, row3);
    b.onclick = () => transformControls.setMode(mode);
  }
}

// ---- 投影器 ----
section('投影器(实时预览)');
const projMsg = el('div', { class: 'msg' });
const projInputs: HTMLInputElement[] = [];

function vecRow(label: string, key: 'position' | 'lookAt'): void {
  const row = el('div', { class: 'row' });
  el('label', { text: label }, row);
  const vec = el('div', { class: 'vec' }, row);
  state.projector[key].forEach((v, i) => {
    const inp = el('input', { type: 'number', step: '0.1', value: String(v) }, vec);
    inp.dataset.key = key;
    inp.dataset.idx = String(i);
    projInputs.push(inp);
  });
}
vecRow('位置', 'position');
vecRow('朝向目标点', 'lookAt');

function numRow(label: string, key: 'fovDeg' | 'near' | 'far', step: string): void {
  const row = el('div', { class: 'row' });
  el('label', { text: label }, row);
  const inp = el('input', { type: 'number', step, value: String(state.projector[key]) }, row);
  inp.dataset.key = key;
  projInputs.push(inp);
}
numRow('张角 (°)', 'fovDeg', '1');
numRow('近端', 'near', '0.1');
numRow('远端', 'far', '0.1');

function readProjectorFromUI(): ProjectorParams {
  const p = structuredClone(state.projector);
  for (const inp of projInputs) {
    const v = parseFloat(inp.value);
    const key = inp.dataset.key!;
    if (key === 'position' || key === 'lookAt') {
      p[key][Number(inp.dataset.idx)] = v;
    } else {
      (p as unknown as Record<string, number>)[key] = v;
    }
  }
  return p;
}

function syncProjectorUI(): void {
  for (const inp of projInputs) {
    const key = inp.dataset.key!;
    const v =
      key === 'position' || key === 'lookAt'
        ? state.projector[key][Number(inp.dataset.idx)]
        : (state.projector as unknown as Record<string, number>)[key];
    inp.value = String(v);
    inp.classList.remove('invalid');
  }
  projMsg.textContent = '';
}

function applyProjectorFromUI(): void {
  const candidate = readProjectorFromUI();
  const errs = validateProjector(candidate);
  if (errs.length) {
    // 非法:提示并回退到当前生效值,保证参数与画面始终一致
    syncProjectorUI();
    projMsg.textContent = '参数非法:' + errs.join(';');
    return;
  }
  state.projector = candidate;
  projMsg.textContent = '';
  projectorHelper.update(state.projector);
}
for (const inp of projInputs) inp.onchange = applyProjectorFromUI;

// ---- 接收规则 ----
section('接收规则');
{
  const row = el('div', { class: 'row' });
  const cb = el('input', { type: 'checkbox' }, row);
  cb.checked = state.firstSurfaceOnly;
  el('label', { text: '仅保留沿投射方向首先遇到的表面(首表面规则)' }, row).style.flex = '1';
  cb.onchange = () => {
    state.firstSurfaceOnly = cb.checked;
    decalSystem.uniforms.uFirstSurfaceOnly.value = cb.checked ? 1 : 0;
  };
  el('div', { class: 'row', text: '表面朝向规则:仅接收朝向投影器的表面(视图空间法线 z > 0),背面与掠射面不接收,不会出现镜像图案。' });
}

// ---- 贴花 ----
section('贴花');
const decalInfo = el('div', { class: 'info' });
function refreshDecalInfo(): void {
  decalInfo.textContent = decalSystem.confirmedInfo();
}
{
  const row = el('div', { class: 'row' });
  el('label', { text: '贴花颜色' }, row);
  const color = el('input', { type: 'color', value: state.decalColor }, row);
  color.oninput = () => {
    state.decalColor = color.value;
    (decalSystem.uniforms.uPrevColor.value as THREE.Color).set(color.value);
    if (!decalSystem.confirmed) {
      (decalSystem.uniforms.uConfColor.value as THREE.Color).set(color.value);
    }
  };
  color.value = state.decalColor;
  const btns = el('div', { class: 'btnrow' });
  const confirmBtn = el('button', { text: '确认投射', class: 'primary' }, btns);
  confirmBtn.onclick = () => {
    decalSystem.confirm(targetMesh, state.targetType, state.projector, state.decalColor);
    refreshDecalInfo();
  };
  const clearBtn = el('button', { text: '清除贴花', class: 'warn' }, btns);
  clearBtn.onclick = () => {
    decalSystem.clear();
    refreshDecalInfo();
  };
  el('div', { text: '确认后贴花固定在目标上,可拖动/旋转/缩放目标验证;投影器只影响新的预览。' });
}
refreshDecalInfo();

// ---- 固定现场 ----
section('固定现场');
const presetDesc = el('div', { class: 'msg ok' });
{
  const btns = el('div', { class: 'btnrow' });
  for (const preset of PRESETS) {
    const b = el('button', { text: preset.label }, btns);
    b.title = preset.description;
    b.onclick = () => {
      state.targetType = preset.targetType;
      state.targetColor = preset.targetColor;
      state.decalColor = preset.decalColor;
      state.projector = structuredClone(preset.projector);
      state.firstSurfaceOnly = preset.firstSurfaceOnly;
      rebuildTarget();
      applySnapshot(targetMesh, preset.targetTransform);
      (targetMesh.material as THREE.MeshStandardMaterial).color.set(preset.targetColor);
      (decalSystem.uniforms.uPrevColor.value as THREE.Color).set(preset.decalColor);
      (decalSystem.uniforms.uConfColor.value as THREE.Color).set(preset.decalColor);
      decalSystem.uniforms.uFirstSurfaceOnly.value = preset.firstSurfaceOnly ? 1 : 0;
      // 同步 UI
      (panel.querySelector('select') as HTMLSelectElement).value = preset.targetType;
      const colorInputs = panel.querySelectorAll('input[type="color"]');
      (colorInputs[0] as HTMLInputElement).value = preset.targetColor;
      (colorInputs[1] as HTMLInputElement).value = preset.decalColor;
      (panel.querySelector('input[type="checkbox"]') as HTMLInputElement).checked =
        preset.firstSurfaceOnly;
      syncProjectorUI();
      projectorHelper.update(state.projector);
      refreshDecalInfo();
      presetDesc.textContent = preset.description;
    };
  }
}

// ---- 现场导出 / 载入 ----
section('现场记录(导出 / 载入)');
const ioArea = el('textarea', { placeholder: '点击「导出现场」生成 JSON;粘贴 JSON 后点「载入现场」恢复' });
const ioMsg = el('div', { class: 'msg' });
{
  const btns = el('div', { class: 'btnrow' });
  const exportBtn = el('button', { text: '导出现场' }, btns);
  exportBtn.onclick = () => {
    const c = decalSystem.confirmed;
    const rec: SceneRecord = {
      version: 1,
      target: {
        type: state.targetType,
        color: state.targetColor,
        transform: snapshotTransform(targetMesh),
      },
      projector: structuredClone(state.projector),
      decalColor: state.decalColor,
      firstSurfaceOnly: state.firstSurfaceOnly,
      confirmed: c
        ? {
            targetType: c.targetType,
            decalColor: c.decalColor,
            projector: structuredClone(c.projector),
            targetTransform: structuredClone(c.targetTransform),
          }
        : null,
    };
    ioArea.value = serializeScene(rec);
    ioMsg.textContent = '';
    ioMsg.className = 'msg ok';
    ioMsg.textContent = '已生成现场记录,可复制保存';
  };
  const importBtn = el('button', { text: '载入现场' }, btns);
  importBtn.onclick = () => {
    try {
      const rec = parseScene(ioArea.value);
      state.targetType = rec.target.type;
      state.targetColor = rec.target.color;
      state.decalColor = rec.decalColor;
      state.projector = rec.projector;
      state.firstSurfaceOnly = rec.firstSurfaceOnly;
      rebuildTarget();
      applySnapshot(targetMesh, rec.target.transform);
      (targetMesh.material as THREE.MeshStandardMaterial).color.set(rec.target.color);
      (decalSystem.uniforms.uPrevColor.value as THREE.Color).set(rec.decalColor);
      decalSystem.uniforms.uFirstSurfaceOnly.value = rec.firstSurfaceOnly ? 1 : 0;
      if (rec.confirmed) {
        decalSystem.restoreConfirmed(rec.confirmed);
        (decalSystem.uniforms.uConfColor.value as THREE.Color).set(rec.confirmed.decalColor);
      }
      (panel.querySelector('select') as HTMLSelectElement).value = rec.target.type;
      const colorInputs = panel.querySelectorAll('input[type="color"]');
      (colorInputs[0] as HTMLInputElement).value = rec.target.color;
      (colorInputs[1] as HTMLInputElement).value = rec.decalColor;
      (panel.querySelector('input[type="checkbox"]') as HTMLInputElement).checked =
        rec.firstSurfaceOnly;
      syncProjectorUI();
      projectorHelper.update(state.projector);
      refreshDecalInfo();
      ioMsg.className = 'msg ok';
      ioMsg.textContent = '现场已恢复';
    } catch (err) {
      ioMsg.className = 'msg';
      ioMsg.textContent = '载入失败:' + (err as Error).message;
    }
  };
}

// ---- 验证 ----
section('几何与状态验证');
const verifyResults = el('div', { id: 'verify-results' });
{
  const btns = el('div', { class: 'btnrow' });
  const runBtn = el('button', { text: '运行验证', class: 'primary' }, btns);
  runBtn.onclick = () => {
    verifyResults.innerHTML = '';
    for (const r of runAllChecks()) {
      const line = document.createElement('div');
      line.className = r.pass ? 'check-pass' : 'check-fail';
      line.textContent = `${r.pass ? '✓' : '✗'} ${r.name} — ${r.detail}`;
      const tol = document.createElement('div');
      tol.className = 'tol';
      tol.textContent = `容许误差:${r.tolerance}`;
      verifyResults.appendChild(line);
      verifyResults.appendChild(tol);
    }
  };
  el('div', { text: '同一套检查也可在命令行用 npm run test 运行。' });
}

// ---------- 初始化 ----------
rebuildTarget();
projectorHelper.update(state.projector);
(decalSystem.uniforms.uPrevColor.value as THREE.Color).set(state.decalColor);

// ---------- 主循环 ----------
function resize(): void {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

renderer.setAnimationLoop(() => {
  orbit.update();
  targetMesh.updateMatrixWorld();
  decalSystem.update(renderer, scene, targetMesh, state.projector);
  renderer.render(scene, camera);
});

// 调试/自动化测试句柄
(window as unknown as Record<string, unknown>).__app = {
  camera,
  orbit,
  state,
  decalSystem,
  transformControls,
  get target() {
    return targetMesh;
  },
};
