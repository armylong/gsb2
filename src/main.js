import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EditorState } from './app/EditorState.js';
import { ChunkRenderer } from './render/ChunkRenderer.js';
import { MATERIALS, MATERIAL_IDS, materialLabel } from './voxel/materials.js';
import './styles.css';

const viewport = document.querySelector('#viewport');
const canvas = document.querySelector('#scene');

/* ---------------- Three.js 基础 ---------------- */

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x0a0e15, 1);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e15);
scene.fog = new THREE.Fog(0x0a0e15, 70, 150);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
const CAMERA_HOME = new THREE.Vector3(38, 34, 44);
const CAMERA_TARGET = new THREE.Vector3(12, 5, 12);
camera.position.copy(CAMERA_HOME);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(CAMERA_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 8;
controls.maxDistance = 160;
controls.maxPolarAngle = Math.PI * 0.495;
controls.screenSpacePanning = true;
controls.update();

const hemi = new THREE.HemisphereLight(0xdff1ff, 0x1b2331, 1.65);
scene.add(hemi);

const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
keyLight.position.set(30, 48, 22);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x88aaff, 0.75);
fillLight.position.set(-28, 18, -24);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xffe2b0, 0.45);
rimLight.position.set(-10, 30, 40);
scene.add(rimLight);

/* ---------------- 世界与渲染 ---------------- */

const state = new EditorState({ onChange: handleStateChange });
const chunkRenderer = new ChunkRenderer(state.world, scene);
chunkRenderer.rebuildAll();

/* 场景外框与地面网格，仅作空间参照，不参与拾取。 */
const worldOutline = createWorldOutline(state.world);
scene.add(worldOutline);

const grid = new THREE.GridHelper(48, 48, 0x1c2b3a, 0x141f2b);
grid.position.set(12, -0.02, 12);
grid.material.transparent = true;
grid.material.opacity = 0.5;
scene.add(grid);

/* 选中 / 悬停轮廓 */
const selectionBox = createOutlineBox(0x4fd1b5, 1.002);
selectionBox.visible = false;
scene.add(selectionBox);

const hoverBox = createOutlineBox(0xffd479, 1.004, 0.85);
hoverBox.visible = false;
scene.add(hoverBox);

/* ---------------- 界面状态 ---------------- */

const ui = {
  palette: document.querySelector('#palette'),
  modeSwitch: document.querySelector('#mode-switch'),
  wireframe: document.querySelector('#toggle-wireframe'),
  boundaries: document.querySelector('#toggle-boundaries'),
  selection: document.querySelector('#toggle-selection'),
  status: document.querySelector('#status'),
  reset: document.querySelector('#btn-reset'),
  clear: document.querySelector('#btn-clear'),
  camera: document.querySelector('#btn-camera'),
  check: document.querySelector('#btn-check'),
  statTotal: document.querySelector('#stat-total'),
  statSplit: document.querySelector('#stat-split'),
  statFaces: document.querySelector('#stat-faces'),
  statChunks: document.querySelector('#stat-chunks'),
  statPosition: document.querySelector('#stat-position'),
  statsVersion: document.querySelector('#stats-version'),
  badgeText: document.querySelector('#badge-text'),
};

let mode = 'add';
let showSelection = true;
let lastPick = null; // { x, y, z, normal:[x,y,z], place:{...}, hit:{...} }

buildPalette();
syncMaterialButtons();
syncModeButtons();
updateStats();
updatePositionDisplay();
ui.badgeText.textContent = `${state.world.sizeX} × ${state.world.sizeY} × ${state.world.sizeZ} · 块 ${state.world.chunkSize}`;

/* ---------------- 事件 ---------------- */

function handleStateChange(event) {
  if (event.type === 'edit' || event.type === 'reset' || event.type === 'clear') {
    chunkRenderer.rebuildDirty();
    updateStats();
    updatePositionDisplay();
    if (event.type === 'reset') {
      setStatus(`已恢复初始样例：${state.getStats().total} 个方块。`, 'ok');
    } else if (event.type === 'clear') {
      setStatus('场景已清空。按“恢复样例”或直接点击添加方块。', 'warn');
    }
  } else if (event.type === 'selection') {
    updatePositionDisplay();
  } else if (event.type === 'material') {
    syncMaterialButtons();
  }
  updateSelectionBoxes();
}

function buildPalette() {
  ui.palette.innerHTML = '';
  MATERIAL_IDS.forEach((id, index) => {
    const material = MATERIALS[id];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `material${material.transparent ? ' transparent' : ''}`;
    button.dataset.material = id;
    button.setAttribute('role', 'option');
    button.title = `${material.label}（快捷键 ${index + 1}）`;
    button.innerHTML = `
      <span class="chip" style="background-color:${hexColor(material.color)}"></span>
      <span>${material.label}</span>
      <span class="key">${index + 1}</span>
    `;
    button.addEventListener('click', () => state.setMaterial(id));
    ui.palette.appendChild(button);
  });
}

function syncMaterialButtons() {
  for (const button of ui.palette.querySelectorAll('.material')) {
    const active = button.dataset.material === state.currentMaterial;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
}

function syncModeButtons() {
  for (const button of ui.modeSwitch.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.mode === mode);
  }
}

ui.modeSwitch.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-mode]');
  if (!button) return;
  setMode(button.dataset.mode);
});

function setMode(next) {
  mode = next;
  syncModeButtons();
  const hints = {
    add: '添加模式：点击方块表面，在其外侧放置方块。',
    delete: '删除模式：点击方块将其移除。',
    select: '选择模式：点击方块查看其坐标与材质。',
  };
  setStatus(hints[mode]);
  clearHover();
  updateSelectionBoxes();
}

ui.wireframe.addEventListener('change', () => {
  chunkRenderer.setWireframe(ui.wireframe.checked);
  setStatus(ui.wireframe.checked ? '线框模式已开启。' : '线框模式已关闭。');
});

ui.boundaries.addEventListener('change', () => {
  chunkRenderer.setBoundariesVisible(ui.boundaries.checked);
  setStatus(ui.boundaries.checked ? '分块边界已显示（青色框线）。' : '分块边界已隐藏。');
});

ui.selection.addEventListener('change', () => {
  showSelection = ui.selection.checked;
  updateSelectionBoxes();
});

ui.reset.addEventListener('click', () => state.reset());
ui.clear.addEventListener('click', () => state.clearAll());
ui.camera.addEventListener('click', resetCamera);
ui.check.addEventListener('click', runSelfCheck);

function resetCamera() {
  camera.position.copy(CAMERA_HOME);
  controls.target.copy(CAMERA_TARGET);
  controls.update();
  setStatus('视角已重置。');
}

function runSelfCheck() {
  const result = state.selfCheck();
  if (result.ok) {
    setStatus(
      `自检通过：${result.globalCount} 个可见面，分块结果与整世界完全一致。`,
      'ok',
    );
  } else {
    const parts = [];
    if (result.missing.length) parts.push(`缺面 ${result.missing.length}`);
    if (result.extra.length) parts.push(`多余面 ${result.extra.length}`);
    if (result.duplicated.length) parts.push(`重复面 ${result.duplicated.length}`);
    setStatus(
      `自检失败：${parts.join('，')}。整世界 ${result.globalCount} 面，分块 ${result.chunkedCount} 面。`,
      'error',
    );
  }
}

/* ---------------- 键盘 ---------------- */

window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();

  if (event.key >= '1' && event.key <= '8') {
    const id = MATERIAL_IDS[Number(event.key) - 1];
    if (id) state.setMaterial(id);
    return;
  }

  switch (key) {
    case 'v':
      setMode('add');
      break;
    case 'x':
      setMode('delete');
      break;
    case 'c':
      setMode('select');
      break;
    case 'b':
      ui.wireframe.checked = !ui.wireframe.checked;
      ui.wireframe.dispatchEvent(new Event('change'));
      break;
    case 'g':
      ui.boundaries.checked = !ui.boundaries.checked;
      ui.boundaries.dispatchEvent(new Event('change'));
      break;
    case 'h':
      ui.selection.checked = !ui.selection.checked;
      ui.selection.dispatchEvent(new Event('change'));
      break;
    case 'r':
      state.reset();
      break;
    case 'escape':
      state.select(null);
      break;
    default:
      break;
  }
});

/* ---------------- 指针拾取 ---------------- */

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDown = null;
let pointerInside = false;

renderer.domElement.addEventListener('pointerdown', (event) => {
  pointerInside = true;
  if (event.button !== 0) return;
  pointerDown = {
    x: event.clientX,
    y: event.clientY,
    time: performance.now(),
  };
});

renderer.domElement.addEventListener('pointermove', (event) => {
  pointerInside = true;
  updatePointer(event);
  const picked = pick();
  lastPick = picked;

  if (picked) {
    if (mode === 'add') {
      state.setHovered(picked.place);
      showHoverAt(picked.place, picked.placeInBounds);
    } else {
      state.setHovered({ x: picked.x, y: picked.y, z: picked.z });
      showHoverAt({ x: picked.x, y: picked.y, z: picked.z }, true);
    }
  } else {
    state.setHovered(null);
    clearHover();
  }
  updatePositionDisplay();
});

renderer.domElement.addEventListener('pointerleave', () => {
  pointerInside = false;
  pointerDown = null;
  state.setHovered(null);
  clearHover();
  updatePositionDisplay();
});

renderer.domElement.addEventListener('pointerup', (event) => {
  if (event.button !== 0 || !pointerDown) return;
  const moved =
    Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5;
  const elapsed = performance.now() - pointerDown.time;
  pointerDown = null;
  if (moved || elapsed > 700) return;

  updatePointer(event);
  const picked = pick();
  if (!picked) {
    if (mode === 'select') state.select(null);
    // 点击空白处不应误删/误加，保持当前场景不变。
    return;
  }
  applyPick(picked);
});

// 右键接住上下文菜单，避免误触浏览器菜单；右键拖拽仍用于平移。
renderer.domElement.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});

function updatePointer(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

/**
 * 射线拾取并解析出“被点中的方块”与“要放置方块的位置”。
 *
 * 不直接依赖命中面的法线朝向来决定方向，而是检查面两侧哪个格子是实心：
 * 透明材质是双面的，从玻璃箱内部或水面下方看时，几何法线可能指向方块内部。
 * 用两侧实心判定可以始终得到正确的内侧方块与外向方向。
 */
function pick() {
  raycaster.setFromCamera(pointer, camera);
  const meshes = chunkRenderer.getPickMeshes();
  const intersections = raycaster.intersectObjects(meshes, false);
  if (intersections.length === 0) return null;

  const hit = intersections[0];
  const normal = hit.face.normal
    .clone()
    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
    .round();
  if (normal.lengthSq() === 0) return null;

  const world = state.world;
  const point = hit.point;
  const sideA = {
    x: Math.floor(point.x - normal.x * 0.5),
    y: Math.floor(point.y - normal.y * 0.5),
    z: Math.floor(point.z - normal.z * 0.5),
  };
  const sideB = {
    x: Math.floor(point.x + normal.x * 0.5),
    y: Math.floor(point.y + normal.y * 0.5),
    z: Math.floor(point.z + normal.z * 0.5),
  };

  const solidA = world.hasBlock(sideA.x, sideA.y, sideA.z);
  const solidB = world.hasBlock(sideB.x, sideB.y, sideB.z);

  let inside = sideA;
  let outward = normal;
  if (!solidA && solidB) {
    inside = sideB;
    outward = normal.clone().negate();
  }

  const place = {
    x: inside.x + outward.x,
    y: inside.y + outward.y,
    z: inside.z + outward.z,
  };

  return {
    ...inside,
    normal: [outward.x, outward.y, outward.z],
    place,
    placeInBounds: world.inBounds(place.x, place.y, place.z),
    inside,
  };
}

function applyPick(picked) {
  if (mode === 'add') {
    if (!picked.placeInBounds) {
      setStatus('该面位于场景边界之外，无法继续放置方块。', 'warn');
      return;
    }
    const placed = state.placeBlock(picked.place);
    if (placed) {
      setStatus(
        `已放置 ${materialLabel(state.currentMaterial)} 于 (${picked.place.x}, ${picked.place.y}, ${picked.place.z})。点击右键或按 X 切换删除。`,
        'ok',
      );
    } else {
      setStatus('目标位置已被占用，未覆盖原有方块。', 'warn');
    }
    return;
  }

  if (mode === 'delete') {
    const removed = state.deleteBlock(picked.inside);
    if (removed) {
      setStatus(
        `已删除 (${picked.inside.x}, ${picked.inside.y}, ${picked.inside.z}) 处的方块。`,
        'ok',
      );
    } else {
      setStatus('该位置没有可删除的方块。', 'warn');
    }
    return;
  }

  state.select(picked.inside);
  setStatus(
    `已选择 (${picked.inside.x}, ${picked.inside.y}, ${picked.inside.z})：${materialLabel(state.world.get(picked.inside.x, picked.inside.y, picked.inside.z))}。`,
  );
}

/* ---------------- 高亮 ---------------- */

function showHoverAt(position, inBounds) {
  if (!inBounds || !position) {
    clearHover();
    return;
  }
  hoverBox.position.set(position.x + 0.5, position.y + 0.5, position.z + 0.5);
  hoverBox.visible = true;
  hoverBox.material.color.setHex(mode === 'delete' ? 0xef7d7d : 0xffd479);
}

function clearHover() {
  hoverBox.visible = false;
}

function updateSelectionBoxes() {
  if (showSelection && state.selected) {
    selectionBox.position.set(
      state.selected.x + 0.5,
      state.selected.y + 0.5,
      state.selected.z + 0.5,
    );
    selectionBox.visible = true;
  } else {
    selectionBox.visible = false;
  }
}

function createOutlineBox(color, scale, opacity = 1) {
  const geometry = new THREE.BoxGeometry(scale, scale, scale);
  const edges = new THREE.EdgesGeometry(geometry);
  geometry.dispose();
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthTest: false,
  });
  const box = new THREE.LineSegments(edges, material);
  box.renderOrder = 20;
  return box;
}

function createWorldOutline(world) {
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(world.sizeX, world.sizeY, world.sizeZ);
  const edges = new THREE.EdgesGeometry(geometry);
  geometry.dispose();
  const material = new THREE.LineBasicMaterial({
    color: 0x2b4055,
    transparent: true,
    opacity: 0.7,
    depthTest: false,
  });
  const box = new THREE.LineSegments(edges, material);
  box.position.set(world.sizeX / 2, world.sizeY / 2, world.sizeZ / 2);
  box.renderOrder = 1;
  group.add(box);
  return group;
}

/* ---------------- 统计与状态 ---------------- */

function updateStats() {
  const stats = state.getStats();
  ui.statTotal.textContent = stats.total.toLocaleString('zh-CN');
  ui.statSplit.textContent = `${stats.opaque.toLocaleString('zh-CN')} / ${stats.transparent.toLocaleString('zh-CN')}`;
  ui.statFaces.textContent = chunkRenderer.visibleFaceCount.toLocaleString('zh-CN');
  ui.statChunks.textContent = `${stats.chunks} 块 · ${stats.chunkSize}³`;
  ui.statsVersion.textContent = `v${state.world.version}`;
}

function updatePositionDisplay() {
  const target = state.hovered ?? state.selected;
  if (!target) {
    ui.statPosition.textContent = '—';
    return;
  }
  const material = state.world.get(target.x, target.y, target.z);
  const chunk = state.world.chunkKeyAt(target.x, target.y, target.z);
  const suffix = material ? materialLabel(material) : '空气';
  ui.statPosition.textContent = `(${target.x}, ${target.y}, ${target.z}) · ${suffix} · 块 ${chunk}`;
}

function setStatus(message, kind = '') {
  ui.status.textContent = message;
  ui.status.className = `status${kind ? ` ${kind}` : ''}`;
}

function hexColor(value) {
  return `#${value.toString(16).padStart(6, '0')}`;
}

/* ---------------- 自适应与渲染循环 ---------------- */

function resize() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (width === 0 || height === 0) return;
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(viewport);
window.addEventListener('resize', resize);
resize();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  // 相机移动后重排透明三角形，保证透明交界的前后顺序正确。
  chunkRenderer.updateTransparentSort(camera.position);
  renderer.render(scene, camera);
  if (!pointerInside) {
    // 鼠标离开视口后，悬停框不跟随相机变化而错位。
    clearHover();
  }
}
animate();

// 暴露少量调试入口，便于在控制台检查场景与自检结果。
window.__voxelLab = {
  state,
  chunkRenderer,
  scene,
  camera,
  controls,
  pick,
  selfCheck: () => state.selfCheck(),
  /** 按视口坐标拾取，返回命中点、面法线与所属块，用于定位渲染问题。 */
  probe(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(chunkRenderer.getPickMeshes(), false);
    return hits.slice(0, 3).map((hit) => ({
      point: [hit.point.x, hit.point.y, hit.point.z],
      normal: [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z],
      object: hit.object.name,
      material: hit.object.userData.material ?? 'opaque',
      distance: hit.distance,
    }));
  },
};
