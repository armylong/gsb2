import * as THREE from 'three';
import { PRESETS, getModel, type ModelId } from './core/generators';
import { buildThickenedSolid } from './core/thickening';
import { inspectRegion } from './core/inspection';
import { growRegion } from './core/regions';
import { exportSolidToObj, inspectObjReadback } from './core/obj';
import { runZeroThicknessRegression } from './core/regression';
import { runPresetCheck } from './core/presets';
import { boundaryEdgeTrace, wallReport, type BoundaryEdgeTrace } from './core/diagnostics';
import { angleBetweenDeg } from './core/geometry';
import { cross, readVec3, sub } from './core/vec';
import type {
  RegionInspection,
  Side,
  SolidOptions,
  SurfaceModel,
  ThickenedSolid,
} from './core/types';
import type { ObjSceneData } from './core/types';
import { Viewport } from './render/viewport';
import { SolidView } from './render/solid-view';
import { OverlayView } from './render/overlay-view';
import {
  $, $button, $input, downloadText, escapeHtml, fmt, fmtVec, setStatus, setText,
} from './ui/dom';
import {
  renderIssueList,
  renderMetrics,
  renderObjReport,
  renderPresetCheck,
  renderRegionReport,
  renderRegression,
  renderValidationSummary,
} from './ui/report';

interface AppState {
  modelId: ModelId;
  compareMode: boolean;
  thickness: number;
  side: Side;
  regionSeeds: number[];
  regionRings: number;
  selectedSideTriangle: number | null;
  showProblemPoints: boolean;
  showRegion: boolean;
  readbackText: string | null;
}

const state: AppState = {
  modelId: 'bowl',
  compareMode: false,
  thickness: getModel('bowl').defaultThickness,
  side: 1,
  regionSeeds: [],
  regionRings: 3,
  selectedSideTriangle: null,
  showProblemPoints: true,
  showRegion: true,
  readbackText: null,
};

const viewport = new Viewport({ container: $('viewport') });
const solidView = new SolidView();
const overlay = new OverlayView();
viewport.content.add(solidView.root, overlay.root);

let model: SurfaceModel = getModel('bowl');
let solid: ThickenedSolid = buildThickenedSolid(model, options());
let region: RegionInspection | null = null;
let readbackScene: ObjSceneData | null = null;
let pendingBuild = 0;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function options(): SolidOptions {
  return { thickness: state.thickness, side: state.side };
}

function scheduleBuild(): void {
  if (pendingBuild) cancelAnimationFrame(pendingBuild);
  pendingBuild = requestAnimationFrame(() => {
    pendingBuild = 0;
    rebuild();
  });
}

function rebuild(): void {
  const started = performance.now();
  solid = buildThickenedSolid(model, options());
  solidView.setSolid(solid);
  solidView.setOptions({
    showSourceOverlay: $input('show-source-overlay').checked,
    isolateProblemWalls: $input('show-problem-only').checked,
    showProblemMarkers: $input('show-problem-points').checked,
    showSideWalls: $input('show-side-walls').checked,
    explodeSideWalls: Number($input('explode').value),
  });
  if (state.selectedSideTriangle !== null) {
    solidView.setSelectedSideTriangle(state.selectedSideTriangle);
    overlay.setBoundaryTrace(solid, state.selectedSideTriangle);
    renderTrace(boundaryEdgeTrace(solid, state.selectedSideTriangle));
  }
  refreshOverlays();
  refreshInspector();
  // 厚度或方向变化后, 已有选区要用新的实体重新测量, 避免报告停留在旧值
  if (state.regionSeeds.length > 0) {
    selectRegion(state.regionSeeds, state.regionRings);
  } else {
    refreshRegion();
  }
  if (state.readbackText) {
    // 导出过的 OBJ 对应当前实体; 重建后旧读回结果过期, 清掉以免误读
    state.readbackText = null;
    readbackScene = null;
    overlay.setObjGhost(null);
    if (state.compareMode) applyCompareMode(false);
    $('obj-report').innerHTML = '<p class="empty">实体已变化, 请重新导出后读回</p>';
  }
  const elapsed = performance.now() - started;
  setText('build-time', `构建 ${elapsed.toFixed(0)} ms`);
  setText('source-hash', `源网格 ${model.sourceHash}`);
  setStatus(
    solid.validation.valid
      ? '实体有效: 闭合、流形、无自相交'
      : `实体无效: ${solid.validation.messages[0] ?? '存在几何问题'}`,
    solid.validation.valid ? 'ok' : 'bad',
  );
}

function refreshOverlays(): void {
  if (!state.showProblemPoints) {
    overlay.setFolds([]);
    overlay.setIntersections([]);
    return;
  }
  // 反折的偏移三角形已被整片标红; 只有反折面积很小、看不清时才补点标记
  const problemOffsetVisible = solid.validation.problemSourceTriangles.size > 0;
  overlay.setFolds(problemOffsetVisible ? [] : solid.validation.foldedOffsetTriangles);
  overlay.setIntersections(solid.validation.intersections);
}

function refreshInspector(): void {
  $('validation-summary').innerHTML = renderValidationSummary(solid);
  $('metric-grid').innerHTML = renderMetrics(solid);
  $('issue-list').innerHTML = renderIssueList(solid, wallReport(solid));
}

function refreshRegion(): void {
  const box = $('region-report');
  if (!region) {
    box.innerHTML = '<p class="empty">尚未选择区域</p>';
    overlay.setRegion(null, null, null);
    return;
  }
  box.innerHTML = renderRegionReport(region);
  overlay.setRegion(
    state.showRegion ? model : null,
    solid,
    state.showRegion ? region : null,
  );
}

function selectRegion(seeds: number[], rings: number): void {
  const triangles = growRegion(model, seeds, rings);
  region = inspectRegion(model, solid, { triangles, side: state.side });
  refreshRegion();
}

function renderTrace(trace: BoundaryEdgeTrace | null): void {
  const box = $('wall-trace');
  if (!trace) {
    box.innerHTML = '<p class="empty">尚未选中侧壁</p>';
    overlay.setBoundaryTrace(null, null);
    return;
  }
  const { edge, wall } = trace;
  const loopName = edge.loopKind === 'outer' ? '外缘开口' : `原始孔 #${edge.loopId}`;
  const status = wall.problem
    ? `<span style="color:#f2545f">有问题: ${escapeHtml(wall.reasons.join('; '))}</span>`
    : '<span style="color:#4fc3a1">正常</span>';
  const rows: Array<[string, string]> = [
    ['侧壁三角形', `#${trace.sideTriangleIndex} (四边形第 ${solid.sideFaces[trace.sideTriangleIndex].quadTriangle + 1} 半)`],
    ['对应原始边', `边 #${edge.id} · ${loopName}`],
    ['原始顶点', `${edge.a} → ${edge.b}`],
    ['原始边长', fmt(trace.edgeLength, 4)],
    ['偏移后边长', fmt(trace.offsetEdgeLength, 4)],
    ['端点坐标', `${fmtVec(trace.endpoints[0])} → ${fmtVec(trace.endpoints[1])}`],
    ['偏移端点', `${fmtVec(trace.offsetEndpoints[0])} → ${fmtVec(trace.offsetEndpoints[1])}`],
    ['源三角形', `#${trace.sourceTriangle} (顶点 ${trace.sourceTriangleIndices.join(', ')})`],
    ['源三角形法线', fmtVec(trace.sourceTriangleNormal)],
    ['侧壁法线偏差', `${fmt(wall.normalDeviationDeg, 1)}°`],
    ['状态', status],
  ];
  box.innerHTML = `<dl class="kv">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

/**
 * 读回几何与主体完全重合, 同时显示会严重 Z-fighting。
 * 因此读回后默认单独显示读回几何, 便于直接观察读回的侧壁与穿插位置。
 */
function applyCompareMode(enabled: boolean): void {
  state.compareMode = enabled;
  if (enabled) {
    solidView.setOptions({ showOriginal: false, showOffset: false, showSideWalls: false, showSourceOverlay: false });
    solidView.setSelectedSideTriangle(null);
    overlay.setRegion(null, null, null);
  } else {
    solidView.setOptions({
      showOriginal: true,
      showOffset: true,
      showSideWalls: $input('show-side-walls').checked,
      showSourceOverlay: $input('show-source-overlay').checked,
    });
    if (state.selectedSideTriangle !== null) {
      solidView.setSelectedSideTriangle(state.selectedSideTriangle);
      overlay.setBoundaryTrace(solid, state.selectedSideTriangle);
    }
    refreshRegion();
  }
}

function clearTrace(): void {
  state.selectedSideTriangle = null;
  solidView.setSelectedSideTriangle(null);
  renderTrace(null);
}

/* ------------------------------ 交互 ------------------------------ */

function isVisible(object: THREE.Object3D): boolean {
  let node: THREE.Object3D | null = object;
  while (node) {
    if (!node.visible) return false;
    node = node.parent;
  }
  return true;
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const rect = viewport.renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, viewport.camera);

  // Raycaster 不看可见性, 这里手动过滤, 避免点到隐藏图层
  const pickables = (objects: THREE.Object3D[]): THREE.Intersection[] =>
    raycaster.intersectObjects(objects, false).filter((hit) => isVisible(hit.object));

  const regionMode = $input('region-pick-mode').checked;
  if (regionMode) {
    const hits = pickables(solidView.surfacePickables);
    if (hits.length > 0) {
      const triangle = solidView.surfaceTriangleAt(hits[0]);
      if (triangle !== null) {
        state.regionSeeds = [triangle];
        selectRegion(state.regionSeeds, state.regionRings);
        setStatus(`已选中源三角形 #${triangle}, 区域生长 ${state.regionRings} 圈`, 'ok');
      }
    }
    return;
  }

  const wallHits = pickables(solidView.wallPickables);
  if (wallHits.length === 0) {
    clearTrace();
    return;
  }
  const sideIndex = solidView.sideTriangleAt(wallHits[0]);
  if (sideIndex === null) return;
  state.selectedSideTriangle = sideIndex;
  solidView.setSelectedSideTriangle(sideIndex);
  const trace = boundaryEdgeTrace(solid, sideIndex);
  renderTrace(trace);
  overlay.setBoundaryTrace(solid, sideIndex);
  if (trace) {
    setStatus(
      `侧壁 #${sideIndex} ← 原始边 #${trace.edge.id} (${trace.edge.loopKind === 'outer' ? '外缘' : '孔'}), 源三角形 #${trace.sourceTriangle}`,
      trace.wall.problem ? 'bad' : 'ok',
    );
  }
}

function focusOnTarget(point: [number, number, number], distance: number): void {
  const target = new THREE.Vector3(...point);
  const direction = new THREE.Vector3().subVectors(viewport.camera.position, target);
  if (direction.lengthSq() < 1e-8) direction.set(1.4, -1.7, 1.25);
  direction.normalize();
  viewport.controls.target.copy(target);
  viewport.camera.position.copy(target.clone().add(direction.multiplyScalar(distance)));
  viewport.controls.update();
}

function focusWall(edgeId: number): void {
  const wallIndex = solid.sideFaces.findIndex((face) => face.edgeId === edgeId);
  if (wallIndex < 0) return;
  state.selectedSideTriangle = wallIndex;
  solidView.setSelectedSideTriangle(wallIndex);
  renderTrace(boundaryEdgeTrace(solid, wallIndex));
  overlay.setBoundaryTrace(solid, wallIndex);
  const modelEdge = model.boundaryEdges[edgeId];
  if (modelEdge) {
    const a = model.positions.subarray(modelEdge.a * 3, modelEdge.a * 3 + 3);
    const b = model.positions.subarray(modelEdge.b * 3, modelEdge.b * 3 + 3);
    focusOnTarget([
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2,
      (a[2] + b[2]) / 2,
    ], Math.max(1.1, model.bounds.radius * 2.0));
  }
  // 面板可能已滚到下方问题列表, 把反查结果滚进视野
  $('wall-trace').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setStatus(`定位到问题侧壁: 原始边 #${edgeId}`, 'bad');
}

function focusSourceTriangle(triangle: number): void {
  if (triangle < 0 || triangle * 3 + 2 >= model.indices.length) return;
  state.regionSeeds = [triangle];
  selectRegion([triangle], Math.max(2, state.regionRings));
  const ia = model.indices[triangle * 3];
  const ib = model.indices[triangle * 3 + 1];
  const ic = model.indices[triangle * 3 + 2];
  const points = [ia, ib, ic].map((v) => [
    model.positions[v * 3],
    model.positions[v * 3 + 1],
    model.positions[v * 3 + 2],
  ]);
  const center: [number, number, number] = [
    (points[0][0] + points[1][0] + points[2][0]) / 3,
    (points[0][1] + points[1][1] + points[2][1]) / 3,
    (points[0][2] + points[1][2] + points[2][2]) / 3,
  ];
  focusOnTarget(center, Math.max(0.9, model.bounds.radius * 1.3));
  setStatus(`定位到源三角形 #${triangle} (区域已选中)`, 'bad');
}

function worstRegionSeeds(): number[] {
  const folds = solid.validation.foldedOffsetTriangles;
  if (folds.length > 0) {
    // 取反折列表中部的一项, 比端点更能代表整片失效区
    return [folds[Math.floor(folds.length / 2)].sourceTriangle];
  }
  // 没有反折时, 找偏移层相对源三角形法线偏转最大的那一块
  const base = model.positions.length / 3;
  let worst = 0;
  let worstAngle = -1;
  for (let t = 0; t < model.indices.length; t += 3) {
    const corners = [0, 1, 2].map((k) => readVec3(model.positions, model.indices[t + k]));
    const offsetCorners = [0, 1, 2].map((k) => readVec3(solid.positions, model.indices[t + k] + base));
    const sourceNormal = cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
    const offsetNormal = cross(sub(offsetCorners[1], offsetCorners[0]), sub(offsetCorners[2], offsetCorners[0]));
    const angle = angleBetweenDeg(sourceNormal, offsetNormal);
    if (angle > worstAngle) {
      worstAngle = angle;
      worst = t / 3;
    }
  }
  return [worst];
}

function frameModel(): void {
  const center = new THREE.Vector3(...model.bounds.center);
  const radius = Math.max(model.bounds.radius, 0.4);
  viewport.controls.target.copy(center);
  viewport.camera.position.copy(center.clone().add(new THREE.Vector3(1.4, -1.7, 1.25).normalize().multiplyScalar(radius * 2.6)));
  viewport.camera.near = Math.max(0.005, radius / 200);
  viewport.camera.far = radius * 60;
  viewport.camera.updateProjectionMatrix();
  viewport.controls.update();
}

function switchModel(modelId: ModelId): void {
  state.modelId = modelId;
  model = getModel(modelId);
  state.thickness = model.defaultThickness;
  state.regionSeeds = [];
  region = null;
  clearTrace();
  $input('thickness').max = String(model.maxThickness);
  $input('thickness').value = String(state.thickness);
  setText('thickness-value', state.thickness.toFixed(3));
  setText('model-subtitle', model.subtitle);
  $('model-notes').innerHTML = model.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('');
  for (const button of document.querySelectorAll<HTMLButtonElement>('#model-switch button')) {
    button.classList.toggle('active', button.dataset.model === modelId);
  }
  refreshPresets();
  frameModel();
  rebuild();
}

function refreshPresets(): void {
  const container = $('preset-buttons');
  container.innerHTML = '';
  for (const preset of PRESETS) {
    if (preset.modelId !== state.modelId) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = preset.label;
    button.title = preset.blurb;
    button.dataset.preset = preset.label;
    button.classList.toggle(
      'active',
      Math.abs(preset.thickness - state.thickness) < 1e-6 && preset.side === state.side,
    );
    button.addEventListener('click', () => {
      state.thickness = preset.thickness;
      state.side = preset.side;
      $input('thickness').value = String(preset.thickness);
      setText('thickness-value', preset.thickness.toFixed(3));
      for (const sideButton of document.querySelectorAll<HTMLButtonElement>('#side-switch button')) {
        sideButton.classList.toggle('active', Number(sideButton.dataset.side) === preset.side);
      }
      refreshPresets();
      rebuild();
    });
    container.appendChild(button);
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bindEvents(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('#model-switch button')) {
    button.addEventListener('click', () => switchModel(button.dataset.model as ModelId));
  }

  $input('thickness').addEventListener('input', (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    state.thickness = value;
    setText('thickness-value', value.toFixed(3));
    refreshPresets();
    scheduleBuild();
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('#side-switch button')) {
    button.addEventListener('click', () => {
      state.side = Number(button.dataset.side) as Side;
      for (const sideButton of document.querySelectorAll<HTMLButtonElement>('#side-switch button')) {
        sideButton.classList.toggle('active', sideButton === button);
      }
      refreshPresets();
      rebuild();
    });
  }

  $input('show-problem-only').addEventListener('change', () => {
    const isolate = $input('show-problem-only').checked;
    solidView.setOptions({ isolateProblemWalls: isolate });
    const problemWalls = solid.validation.problemSideEdges.size;
    if (isolate && problemWalls === 0) {
      setStatus('当前实体没有标记为问题的侧壁, 隔离视图为空。取消勾选可恢复显示。', 'ok');
    } else if (isolate) {
      setStatus(`隔离显示: 仅显示 ${problemWalls} 条问题侧壁对应的段`, 'bad');
    } else {
      setStatus('已恢复显示正常侧壁与主体', 'neutral');
    }
  });
  $input('show-side-walls').addEventListener('change', () => {
    solidView.setOptions({ showSideWalls: $input('show-side-walls').checked });
  });
  $input('show-source-overlay').addEventListener('change', () => {
    solidView.setOptions({ showSourceOverlay: $input('show-source-overlay').checked });
  });
  $input('show-problem-points').addEventListener('change', () => {
    state.showProblemPoints = $input('show-problem-points').checked;
    solidView.setOptions({ showProblemMarkers: state.showProblemPoints });
    refreshOverlays();
  });
  $input('explode').addEventListener('input', () => {
    const value = Number($input('explode').value);
    setText('explode-value', fmt(value, 2));
    solidView.setOptions({ explodeSideWalls: value });
  });
  $input('region-rings').addEventListener('input', () => {
    state.regionRings = Number($input('region-rings').value);
    setText('region-rings-value', String(state.regionRings));
    if (state.regionSeeds.length > 0) selectRegion(state.regionSeeds, state.regionRings);
  });
  $input('show-region').addEventListener('change', () => {
    state.showRegion = $input('show-region').checked;
    refreshRegion();
  });
  $button('region-clear').addEventListener('click', () => {
    state.regionSeeds = [];
    region = null;
    refreshRegion();
    setStatus('已清除区域选择', 'neutral');
  });
  $button('region-high-risk').addEventListener('click', () => {
    const seeds = worstRegionSeeds();
    state.regionSeeds = seeds;
    selectRegion(seeds, Math.max(3, state.regionRings));
    setStatus(`已选中风险最高的源三角形 #${seeds[0]}`, 'bad');
  });

  $('issue-list').addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const wallButton = target.closest<HTMLElement>('[data-focus-wall]');
    if (wallButton?.dataset.focusWall) {
      focusWall(Number(wallButton.dataset.focusWall));
      return;
    }
    const foldButton = target.closest<HTMLElement>('[data-focus-fold]');
    if (foldButton?.dataset.focusFold) {
      focusSourceTriangle(Number(foldButton.dataset.focusFold));
    }
  });

  $button('export-obj').addEventListener('click', () => {
    const text = exportSolidToObj(solid, `${model.id}_t${state.thickness.toFixed(3)}_s${state.side}`);
    state.readbackText = text;
    downloadText(`${model.id}_t${state.thickness.toFixed(3)}.obj`, text, 'text/plain');
    $('obj-report').innerHTML = `<p class="empty">已导出 ${fmt(text.length / 1024, 1)} KB OBJ, 可点击"读回并复核"。</p>`;
    setStatus('已导出 OBJ', 'ok');
  });

  $button('readback-obj').addEventListener('click', () => {
    const text = state.readbackText ?? exportSolidToObj(solid, `${model.id}_solid`);
    state.readbackText = text;
    try {
      const { scene, report } = inspectObjReadback(text);
      if ($input('compare-mode').checked) applyCompareMode(true);
      readbackScene = scene;
      overlay.setObjGhost(scene, $input('compare-mode').checked);
      $('obj-report').innerHTML = renderObjReport(report);
      setStatus(
        report.valid ? '读回复核通过' : '读回复核发现问题, 详见报告',
        report.valid ? 'ok' : 'bad',
      );
    } catch (error) {
      $('obj-report').innerHTML = `<div class="validation-summary bad"><strong>读回失败</strong><ul><li>${escapeHtml(String(error instanceof Error ? error.message : error))}</li></ul></div>`;
      setStatus(`读回失败: ${error instanceof Error ? error.message : String(error)}`, 'bad');
    }
  });

  $input('obj-file').addEventListener('change', async () => {
    const file = $input('obj-file').files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      state.readbackText = text;
      const { scene, report } = inspectObjReadback(text);
      if ($input('compare-mode').checked) applyCompareMode(true);
      readbackScene = scene;
      overlay.setObjGhost(scene, $input('compare-mode').checked);
      $('obj-report').innerHTML = renderObjReport(report);
      setStatus(
        `${file.name}: ${report.valid ? '读回复核通过' : '读回复核发现问题'}`,
        report.valid ? 'ok' : 'bad',
      );
    } catch (error) {
      $('obj-report').innerHTML = `<div class="validation-summary bad"><strong>读回失败</strong><ul><li>${escapeHtml(String(error instanceof Error ? error.message : error))}</li></ul></div>`;
      setStatus(`读回失败: ${error instanceof Error ? error.message : String(error)}`, 'bad');
    } finally {
      $input('obj-file').value = '';
    }
  });

  $input('compare-mode').addEventListener('change', () => {
    const enabled = $input('compare-mode').checked;
    applyCompareMode(enabled);
    if (readbackScene) overlay.setObjGhost(readbackScene, enabled);
  });

  $button('run-presets').addEventListener('click', () => {
    const report = runPresetCheck();
    $('preset-report').innerHTML = renderPresetCheck(report);
    setStatus(report.pass ? '内置验证参数全部符合预期' : '内置验证参数存在偏差', report.pass ? 'ok' : 'bad');
  });

  $button('run-regression').addEventListener('click', () => {
    const report = runZeroThicknessRegression(model, options());
    $('regression-report').innerHTML = renderRegression(report);
    setStatus(report.pass ? '厚度归零回归通过' : '厚度归零回归失败', report.pass ? 'ok' : 'bad');
  });

  viewport.renderer.domElement.addEventListener('pointerdown', onPointerDown);
}

function init(): void {
  bindEvents();
  setText('model-subtitle', model.subtitle);
  $('model-notes').innerHTML = model.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('');
  for (const button of document.querySelectorAll<HTMLButtonElement>('#model-switch button')) {
    button.classList.toggle('active', button.dataset.model === state.modelId);
  }
  const concave = model.concaveSide;
  const sideButtons = document.querySelectorAll<HTMLButtonElement>('#side-switch button');
  for (const button of sideButtons) {
    const side = Number(button.dataset.side) as Side;
    button.textContent = side === concave
      ? `沿法线${side > 0 ? '正' : '负'}侧 (凹侧)`
      : `沿法线${side > 0 ? '正' : '负'}侧 (凸侧)`;
    button.classList.toggle('active', side === state.side);
  }
  $input('thickness').max = String(model.maxThickness);
  $input('thickness').value = String(state.thickness);
  setText('thickness-value', state.thickness.toFixed(3));
  setText('explode-value', '0');
  setText('region-rings-value', String(state.regionRings));
  refreshPresets();
  frameModel();
  rebuild();
}

init();

// 便于调试与自动化检查
declare global {
  interface Window {
    __inspector?: {
      state: AppState;
      getSolid: () => ThickenedSolid;
      getModel: () => SurfaceModel;
      getRegion: () => RegionInspection | null;
      selectRegion: typeof selectRegion;
      focusWall: typeof focusWall;
      focusSourceTriangle: typeof focusSourceTriangle;
      rebuild: typeof rebuild;
    };
  }
}

// 仅供自动化截图/点选检查: 世界坐标 -> 画布像素
function projectToScreen(point: [number, number, number], rect: DOMRect): { x: number; y: number } | null {
  const vector = new THREE.Vector3(point[0], point[1], point[2]).project(viewport.camera);
  return {
    x: rect.left + ((vector.x + 1) / 2) * rect.width,
    y: rect.top + ((1 - vector.y) / 2) * rect.height,
  };
}

(window as unknown as Record<string, unknown>).__debugProject = projectToScreen;

window.__inspector = {
  state,
  getSolid: () => solid,
  getModel: () => model,
  getRegion: () => region,
  selectRegion,
  focusWall,
  focusSourceTriangle,
  rebuild,
};
