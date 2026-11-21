import './styles.css';
import {
  AmbientLight,
  DirectionalLight,
  GridHelper,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { CullController, CullFrame, CullMode, reasonText } from './culling/cullController';
import {
  FrameRecord,
  buildReport,
  createFrameRecord,
  downloadReport,
} from './report/report';
import { buildSampleScene, updateWorldBounds, SampleScene } from './scene/sampleScene';
import {
  TOTAL_FRAMES,
  applyCameraPath,
  applyObjectPath,
  cameraPathAt,
} from './scene/fixedPath';
import { createDebugView, DebugHandles, meshStatusOf } from './view/debugView';
import { createPanel } from './ui/panel';
import { LabelOverlay } from './ui/labels';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const stage = document.getElementById('stage') as HTMLDivElement;
const panelHost = document.getElementById('panel') as HTMLDivElement;
const labelsHost = document.getElementById('labels') as HTMLDivElement;
const insetFrame = document.getElementById('inset-frame') as HTMLDivElement;

const panel = createPanel();
panelHost.appendChild(panel.root);

// ---- 渲染器 ----
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.autoClear = false;
renderer.setClearColor(0x0f1420, 1);

// ---- 场景与灯光 ----
const scene = new Scene();
const sample: SampleScene = buildSampleScene();
scene.add(sample.root);

const ambient = new AmbientLight(0xffffff, 0.85);
ambient.layers.enable(1);
const key = new DirectionalLight(0xffffff, 1.4);
key.position.set(8, 14, 10);
key.layers.enable(1);
scene.add(ambient, key);

const grid = new GridHelper(60, 30, 0x3a4a6b, 0x232f47);
grid.layers.set(1);
scene.add(grid);

// ---- 观察相机（视锥可被调，摆件按它做剔除）----
const observeCamera = new PerspectiveCamera(52, 16 / 9, 0.5, 40);
observeCamera.position.set(0, 0, 0);
observeCamera.lookAt(0, 0, -16);
const observeTarget = new Vector3(0, 0, -16);

// ---- 总览相机（看观察视锥 + 包围体 + 剔除原因）----
const overviewCamera = new PerspectiveCamera(50, 1, 0.1, 200);
overviewCamera.position.set(26, 20, 30);
overviewCamera.layers.enable(1);
overviewCamera.layers.disable(0);
const overviewControls = new OrbitControls(overviewCamera, canvas);
overviewControls.target.set(0, 0, -16);
overviewControls.enableDamping = true;
overviewControls.dampingFactor = 0.08;

// ---- 变换 Gizmo（只在总览相机里显示，挂 layer 1）----
const transformControls = new TransformControls(overviewCamera, renderer.domElement);
transformControls.setMode('translate');
transformControls.setSize(0.85);
transformControls.layers.set(1);
scene.add(transformControls);

transformControls.addEventListener('dragging-changed', (event) => {
  overviewControls.enabled = !event.value;
});
transformControls.addEventListener('objectChange', () => {
  // 要求 4：拖动改变变换后立即重算包围体，边界交叉对象不漏判。
  updateWorldBounds(sample);
});

// ---- 调试视锥/包围体 ----
const debugView: DebugHandles = createDebugView(sample, observeCamera);
scene.add(debugView.group);

// ---- 标签与控制器 ----
const labelOverlay = new LabelOverlay(labelsHost, sample);
const cullController = new CullController(sample);

// ---- 运行状态 ----
let currentMode: CullMode = 'per-mesh';
let playing = false;
let currentFrame = 0;
let selectedId: string | null = null;
const records: FrameRecord[] = [];
const raycaster = new Raycaster();
const pointer = new Vector2();
let frameAccumulator = 0;
let recordPending = false;
const FRAME_MS = 60;

function resize(): void {
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  renderer.setSize(width, height, false);
  overviewCamera.aspect = width / height;
  overviewCamera.updateProjectionMatrix();
  updateInsetAspect();
}

function updateInsetAspect(): void {
  const rect = insetFrame.getBoundingClientRect();
  observeCamera.aspect = rect.width / Math.max(rect.height - 24, 1);
  observeCamera.updateProjectionMatrix();
}

window.addEventListener('resize', resize);

// ---- 观察相机参数滑杆 ----
function bindCameraSliders(): void {
  const sync = () => {
    observeCamera.fov = Number(panel.fovSlider.value);
    observeCamera.near = Number(panel.nearSlider.value);
    observeCamera.far = Number(panel.farSlider.value);
    observeCamera.updateProjectionMatrix();
    panel.fovValue.textContent = observeCamera.fov.toFixed(0);
    panel.nearValue.textContent = observeCamera.near.toFixed(1);
    panel.farValue.textContent = observeCamera.far.toFixed(0);
  };
  panel.fovSlider.addEventListener('input', sync);
  panel.nearSlider.addEventListener('input', sync);
  panel.farSlider.addEventListener('input', sync);
  sync();
}
bindCameraSliders();

panel.modeSelect.addEventListener('change', () => {
  currentMode = panel.modeSelect.value as CullMode;
  cullController.setMode(currentMode);
});

panel.showHelpers.addEventListener('change', () => {
  debugView.setVisible(panel.showHelpers.checked);
  labelOverlay.setVisible(panel.showHelpers.checked);
});
// showBoxes 的勾选状态在每帧 debugView.update 里直接读取，无需额外监听。

// ---- 固定路径控制 ----
function gotoFrame(frame: number): void {
  currentFrame = ((frame % TOTAL_FRAMES) + TOTAL_FRAMES) % TOTAL_FRAMES;
  applyObjectPath(sample, currentFrame);
  applyCameraPath(observeCamera, observeTarget, currentFrame);
  observeCamera.lookAt(observeTarget);
  updateWorldBounds(sample);
  const path = cameraPathAt(currentFrame);
  panel.fovSlider.value = String(path.fov);
  panel.nearSlider.value = String(path.near.toFixed(1));
  panel.farSlider.value = String(path.far.toFixed(0));
  panel.fovValue.textContent = path.fov.toFixed(0);
  panel.nearValue.textContent = path.near.toFixed(1);
  panel.farValue.textContent = path.far.toFixed(0);
}

panel.playButton.addEventListener('click', () => {
  if (!playing) {
    playing = true;
    records.length = 0;
    currentFrame = 0;
    gotoFrame(0);
    recordPending = true;
    panel.playButton.textContent = '停止记录';
  } else {
    playing = false;
    panel.playButton.textContent = '播放路径';
  }
});
panel.stepButton.addEventListener('click', () => {
  playing = false;
  panel.playButton.textContent = '播放路径';
  gotoFrame(currentFrame + 1);
});
panel.resetPathButton.addEventListener('click', () => {
  playing = false;
  panel.playButton.textContent = '播放路径';
  records.length = 0;
  gotoFrame(0);
});
panel.resetCameraButton.addEventListener('click', () => {
  observeCamera.position.set(0, 0, 0);
  observeTarget.set(0, 0, -16);
  observeCamera.lookAt(observeTarget);
  observeCamera.fov = 52;
  observeCamera.near = 0.5;
  observeCamera.far = 40;
  observeCamera.updateProjectionMatrix();
  panel.fovSlider.value = '52';
  panel.nearSlider.value = '0.5';
  panel.farSlider.value = '40';
  panel.fovValue.textContent = '52';
  panel.nearValue.textContent = '0.5';
  panel.farValue.textContent = '40';
});

panel.exportButton.addEventListener('click', () => {
  if (records.length === 0) {
    panel.recordHint.textContent = '请先播放完整路径再导出（点击播放路径，等待 180 帧跑完）';
    return;
  }
  const report = buildReport(sample.seed, records, 'browser', true);
  downloadReport(report);
  panel.recordHint.textContent = `已导出 ${records.length} 帧报告`;
});

// ---- 点击选中摆件 / 组 ----
canvas.addEventListener('pointerdown', (event) => {
  if (transformControls.dragging) return;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  // 总览相机只看 layer 1，射线检测也要覆盖 layer 0/1 两层才能命中摆件。
  raycaster.layers.set(0);
  raycaster.layers.enable(1);
  const pickables: Object3D[] = sample.groups.map((g) => g.group);
  const hits = raycaster.intersectObjects(pickables, true);
  if (hits.length === 0) {
    selectedId = null;
    transformControls.detach();
    return;
  }
  let object: Object3D | null = hits[0].object;
  while (object && !object.userData.entityId && object !== sample.root) {
    object = object.parent;
  }
  if (object && object.userData.entityId) {
    selectedId = object.userData.entityId as string;
    transformControls.attach(object);
  } else if (object && sample.groups.some((g) => g.group === object)) {
    selectedId = object.name;
    transformControls.attach(object);
  }
});

// ---- 统计表刷新 ----
function refreshTables(frame: CullFrame): void {
  panel.groupTableBody.innerHTML = '';
  for (const groupInfo of frame.groups) {
    const tr = document.createElement('tr');
    if (selectedId === groupInfo.groupEntity.id) tr.classList.add('row-selected');
    tr.innerHTML = `<td>${groupInfo.groupEntity.id}</td>
      <td><span class="dot dot-${groupInfo.result.status}"></span>${groupInfo.result.status}</td>
      <td>${reasonText(groupInfo.result)}</td>
      <td>${groupInfo.drawnCount}/${groupInfo.members.length}</td>`;
    tr.addEventListener('click', () => {
      selectedId = groupInfo.groupEntity.id;
      transformControls.attach(groupInfo.groupEntity.group);
    });
    panel.groupTableBody.appendChild(tr);
  }

  panel.meshTableBody.innerHTML = '';
  for (const groupInfo of frame.groups) {
    for (const member of groupInfo.members) {
      const status = meshStatusOf(member);
      const tr = document.createElement('tr');
      if (selectedId === member.entity.id) tr.classList.add('row-selected');
      tr.innerHTML = `<td>${member.entity.id}</td>
        <td>${groupInfo.groupEntity.id}</td>
        <td><span class="dot dot-${status}"></span>${status}</td>
        <td>${reasonText(member.result)}</td>
        <td>${member.drawn ? '是' : '否'}</td>`;
      tr.addEventListener('click', () => {
        selectedId = member.entity.id;
        transformControls.attach(member.entity.mesh);
      });
      panel.meshTableBody.appendChild(tr);
    }
  }
}

function refreshStats(frame: CullFrame, nativeDrawn: number): void {
  panel.totalMeshesValue.textContent = String(frame.totalMeshes);
  panel.perMeshValue.textContent = String(frame.perMeshDrawn);
  panel.perGroupValue.textContent = String(frame.perGroupDrawn);
  panel.nativeValue.textContent = String(nativeDrawn);
  panel.skippedValue.textContent = String(frame.skippedByGroupCount);
  const diff = frame.perMeshDrawn - frame.perGroupDrawn;
  panel.compareValue.textContent = diff === 0 ? '0（一致）' : `${diff}（应恒为 0，见下钻）`;
  panel.compareValue.className = diff === 0 ? 'value ok' : 'value bad';
  panel.frameValue.textContent = `${currentFrame}/${TOTAL_FRAMES - 1}`;
  panel.selectedValue.textContent = selectedId ?? '无';
}

// ---- 渲染：总览全幅 + 观察相机画中画（两次 pass：原生基线 / 当前策略）----
function renderPasses(): { nativeDrawn: number; modeDrawn: number } {
  const width = stage.clientWidth;
  const height = stage.clientHeight;

  // Pass 0：总览相机（layer 1），全幅。
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, width, height);
  renderer.setClearColor(0x0f1420, 1);
  renderer.clear(true, true, true);
  overviewControls.update();
  renderer.render(scene, overviewCamera);

  // 画中画矩形（CSS 像素 -> 绘图缓冲像素，WebGL 原点在左下）。
  const rect = insetFrame.getBoundingClientRect();
  const dpr = renderer.getPixelRatio();
  const pw = Math.max(1, Math.round(rect.width * dpr));
  const ph = Math.max(1, Math.round(rect.height * dpr));
  const pl = Math.round(rect.left * dpr);
  const pb = Math.round((height - rect.bottom) * dpr);

  // Pass 1：原生基线——恢复所有 mesh 的 layer 0，交给 Three.js 自身剔除。
  for (const entity of sample.meshes) {
    entity.mesh.layers.enable(0);
    entity.mesh.frustumCulled = true;
  }
  observeCamera.layers.enable(0);
  observeCamera.layers.disable(1);
  renderer.setScissorTest(true);
  renderer.setViewport(pl, pb, pw, ph);
  renderer.setScissor(pl, pb, pw, ph);
  // 先把画中画区域清成深色底，再清深度，确保上一帧总览画面不会透过来。
  renderer.setClearColor(0x05070c, 1);
  renderer.clear(true, true, true);
  renderer.render(scene, observeCamera);
  const nativeDrawn = renderer.info.render.calls;

  // Pass 2：当前策略——由 CullController 重新判定并设置 layer。
  cullController.setMode(currentMode);
  cullController.update(observeCamera);
  renderer.clear(true, true, true);
  renderer.render(scene, observeCamera);
  const modeDrawn = renderer.info.render.calls;

  renderer.setScissorTest(false);
  return { nativeDrawn, modeDrawn };
}

// ---- 主循环 ----
let lastTime = performance.now();

/** 执行一帧剔除/渲染并返回当前计数快照（rAF 与无头自检共用）。 */
function runFrame(): CullFrame {
  const frame = cullController.update(observeCamera);
  debugView.update(frame, panel.showBoxes.checked);
  const { nativeDrawn } = renderPasses();
  lastNativeDrawn = nativeDrawn;
  labelOverlay.update(frame, overviewCamera, stage.clientWidth, stage.clientHeight);
  refreshStats(frame, nativeDrawn);
  refreshTables(frame);
  return frame;
}

let lastNativeDrawn = 0;

function tick(now: number): void {
  requestAnimationFrame(tick);
  const dt = now - lastTime;
  lastTime = now;

  if (playing) {
    frameAccumulator += dt;
    if (frameAccumulator >= FRAME_MS) {
      frameAccumulator = 0;
      if (currentFrame >= TOTAL_FRAMES - 1) {
        // 跑完一轮 0..179 自动停。
        playing = false;
        panel.playButton.textContent = '播放路径';
      } else {
        gotoFrame(currentFrame + 1);
        recordPending = true;
      }
    }
  }

  // 变换（含 gizmo 拖动）后包围体始终是新的。
  const frame = runFrame();

  if (playing && recordPending) {
    recordPending = false;
    const order = sample.meshes.map((m) => m.id);
    records.push(createFrameRecord(frame, currentFrame, lastNativeDrawn, order, order));
  }
}

// 仅供 ?selfcheck=1 无头探针使用的调试句柄（不参与正常渲染逻辑）。
declare global {
  interface Window {
    __LAB__?: {
      TOTAL_FRAMES: number;
      gotoFrame(frame: number): void;
      tickOnce(): void;
      setMode(mode: CullMode): void;
      snapshot(): {
        frame: number;
        totalMeshes: number;
        perMeshDrawn: number;
        perGroupDrawn: number;
        nativeDrawn: number;
      };
    };
  }
}

window.__LAB__ = {
  TOTAL_FRAMES,
  gotoFrame: (frame: number) => gotoFrame(frame),
  tickOnce: () => runFrame(),
  setMode: (mode: CullMode) => {
    currentMode = mode;
    panel.modeSelect.value = mode;
    cullController.setMode(mode);
  },
  snapshot: () => {
    const current = cullController.update(observeCamera);
    return {
      frame: currentFrame,
      totalMeshes: current.totalMeshes,
      perMeshDrawn: current.perMeshDrawn,
      perGroupDrawn: current.perGroupDrawn,
      nativeDrawn: lastNativeDrawn,
    };
  },
};

gotoFrame(0);
resize();
requestAnimationFrame(tick);

// 无头浏览器自检探针（仅 ?selfcheck=1 时工作），放在最后引入以拿到完整句柄。
import './selfcheck';
