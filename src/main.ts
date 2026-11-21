import './style.css';
import { Triangle, Vector3 } from 'three';
import { SAMPLE_METAS, createSampleMesh, defaultAnchors } from './core/samples';
import type { SampleId } from './core/samples';
import { RouteModel } from './core/RouteModel';
import type { RouteSnapshot, RouteSegment, RouteSummary } from './core/RouteModel';
import type { SurfaceAnchor } from './core/types';
import { createSave, deserializeSave, serializeSave } from './core/persistence';
import type { CameraState, SavedAnnotation } from './core/persistence';
import { ThreeView } from './app/ThreeView';
import type { SurfaceHit, ViewerMode } from './app/ThreeView';

const $ = <T extends HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`缺少 DOM 节点: ${selector}`);
  return el;
};

const canvas = $<HTMLCanvasElement>('#view');
const sampleSelect = $<HTMLSelectElement>('#sample');
const sampleDesc = $<HTMLParagraphElement>('#sample-desc');
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('#mode button')];
const statsEl = $<HTMLElement>('#stats');
const listEl = $<HTMLOListElement>('#waypoint-list');
const clearButton = $<HTMLButtonElement>('#clear');
const saveButton = $<HTMLButtonElement>('#save');
const loadButton = $<HTMLButtonElement>('#load');
const loadFile = $<HTMLInputElement>('#load-file');
const ioStatus = $<HTMLParagraphElement>('#io-status');
const toastEl = $<HTMLDivElement>('#toast');
const toggleEmpties = $<HTMLInputElement>('#show-empties');
const toggleLabels = $<HTMLInputElement>('#show-labels');
const toggleWire = $<HTMLInputElement>('#show-wire');
const autoRotateButton = $<HTMLButtonElement>('#auto-rotate');

for (const meta of SAMPLE_METAS) {
  const option = document.createElement('option');
  option.value = meta.id;
  option.textContent = meta.name;
  sampleSelect.appendChild(option);
}

let toastTimer = 0;
function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  toastEl.textContent = message;
  toastEl.className = `show${kind === 'error' ? ' error' : ''}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.className = '';
  }, 2800);
}

let currentSampleId: SampleId = 'curved-holey';
let route: RouteModel | null = null;

const view = new ThreeView(canvas, {
  onSurfaceClick: (hit) => addWaypointAtHit(hit),
  onWaypointClick: () => {
    renderList();
    renderStats();
  },
  onSegmentClick: () => {
    renderStats();
    renderList();
  },
  onMissClick: () => {
    view.selectWaypoint(null);
    view.selectSegment(null);
    renderStats();
    renderList();
  },
  onVertexPick: (index) => {
    const vertex = view.getSurfaceMesh()?.getVertexPosition(index);
    if (vertex) {
      toast(
        `已选中网格顶点 #${index}（${vertex.x.toFixed(2)}, ${vertex.y.toFixed(2)}, ${vertex.z.toFixed(2)}）；拖动箭头沿法线鼓包`,
      );
    }
  },
  onVertexDragged: () => {
    renderStats();
  },
  onError: (message) => toast(message, 'error'),
});

// ------------------------------------------------------------------ 路线同步

function handleSnapshot(snapshot: RouteSnapshot): void {
  view.syncRoute(snapshot);
  renderList();
  renderStats();
}

function bindRoute(next: RouteModel): void {
  route = next;
  next.subscribe(handleSnapshot);
  handleSnapshot(next.snapshot());
}

function loadSample(sampleId: SampleId, options?: { seed?: boolean }): void {
  currentSampleId = sampleId;
  sampleSelect.value = sampleId;
  const meta = SAMPLE_METAS.find((m) => m.id === sampleId)!;
  sampleDesc.textContent = meta.description;

  const mesh = createSampleMesh(sampleId);
  const nextRoute = new RouteModel(mesh);
  view.mountSurface(mesh, nextRoute);
  bindRoute(nextRoute);

  if (options?.seed !== false) {
    // 双岛样例里第 3 个点刻意落在另一座岛上，用来展示“断开”
    for (const anchor of defaultAnchors(sampleId, mesh)) nextRoute.addWaypoint(anchor);
  }

  view.setMode('add');
  syncModeButtons();
  ioStatus.textContent = '存档包含相机姿态、路线点与网格顶点偏移。';
}

// ------------------------------------------------------------------ 加点

function addWaypointAtHit(hit: SurfaceHit): void {
  if (!route) return;
  try {
    const selectedSegmentId = view.getSelectedSegment();
    if (selectedSegmentId && route.getSegment(selectedSegmentId)) {
      const wp = route.insertWaypointOnSegment(selectedSegmentId, hit.anchor);
      view.selectWaypoint(wp.id);
      view.selectSegment(null);
      toast(`已在线段中插入 ${wp.name}`);
    } else {
      const wp = route.addWaypoint(hit.anchor);
      view.selectWaypoint(wp.id);
      toast(`已添加 ${wp.name}`);
    }
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

// ------------------------------------------------------------------ 面板

function describeFailure(segment: RouteSegment): string {
  if (segment.path.ok) return '';
  return segment.path.reason === 'disconnected'
    ? '表面断开：两个点位于互不相连的网格块上'
    : '没有可用的贴面通路';
}

function renderStats(): void {
  if (!route) return;
  const summary: RouteSummary = route.summary();
  const selectedSegmentId = view.getSelectedSegment();
  const selectedSegment = selectedSegmentId ? route.getSegment(selectedSegmentId) : undefined;

  const parts: string[] = [];
  parts.push(`
    <div class="stat">
      <span class="stat-label">路线总长</span>
      <span class="value">${summary.totalLength.toFixed(2)}</span>
    </div>
    <div class="stat">
      <span class="stat-label">线段 / 表面三角形</span>
      <span class="value">${summary.segmentCount} / ${summary.triangleCount}</span>
    </div>
    <div class="stat wide">
      <span class="stat-label">连通情况</span>
      <span class="value ${summary.failedCount > 0 ? 'warn' : ''}">
        ${summary.connectedCount} 段连通${summary.failedCount > 0 ? ` · ${summary.failedCount} 段断开` : ''}
      </span>
    </div>
  `);

  if (selectedSegment) {
    if (selectedSegment.path.ok) {
      const tris = selectedSegment.path.triangles;
      parts.push(`
        <div class="stat wide measure">
          <span class="stat-label">选中线段长度</span>
          <span class="value">${selectedSegment.path.length.toFixed(3)}</span>
        </div>
        <div class="stat wide">
          <span class="stat-label">表面三角形 (${tris.length})</span>
          <span class="tri-list">${tris.join(', ')}</span>
        </div>
      `);
    } else {
      parts.push(`
        <div class="stat wide">
          <span class="stat-label">选中线段</span>
          <span class="value warn">${describeFailure(selectedSegment)}</span>
        </div>
      `);
    }
  }

  statsEl.innerHTML = parts.join('');
}

function renderList(): void {
  if (!route) return;
  const waypoints = route.getWaypoints();
  const selectedId = view.getSelectedWaypoint();
  listEl.innerHTML = '';

  if (waypoints.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '还没有路线点：在表面上点一下即可添加';
    listEl.appendChild(li);
    return;
  }

  waypoints.forEach((wp, index) => {
    const li = document.createElement('li');
    li.className = wp.id === selectedId ? 'selected' : '';
    li.dataset.id = wp.id;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${index + 1}. ${wp.name}`;

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `△${wp.anchor.tri}`;

    const del = document.createElement('button');
    del.className = 'delete';
    del.textContent = '×';
    del.title = '删除这个点';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!route) return;
      route.deleteWaypoint(wp.id);
      if (view.getSelectedWaypoint() === wp.id) view.selectWaypoint(null);
      toast(`已删除 ${wp.name}`);
    });

    li.append(name, meta, del);
    li.addEventListener('click', () => {
      view.selectWaypoint(wp.id);
      view.selectSegment(null);
      renderList();
      renderStats();
    });
    listEl.appendChild(li);
  });
}

// ------------------------------------------------------------------ 模式

function setMode(mode: ViewerMode): void {
  view.setMode(mode);
  syncModeButtons();
  if (mode !== 'select') view.selectWaypoint(null);
  renderList();
  renderStats();
}

function syncModeButtons(): void {
  for (const button of modeButtons) {
    button.classList.toggle('active', button.dataset.mode === view.getMode());
  }
  canvas.style.cursor = view.getMode() === 'add' ? 'crosshair' : 'default';
}

for (const button of modeButtons) {
  button.addEventListener('click', () => setMode(button.dataset.mode as ViewerMode));
}

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  switch (event.key.toLowerCase()) {
    case 'a':
      setMode('add');
      break;
    case 'v':
      setMode('select');
      break;
    case 'e':
      setMode('vertex');
      break;
    case 'delete':
    case 'backspace': {
      const id = view.getSelectedWaypoint();
      if (id && route) {
        route.deleteWaypoint(id);
        view.selectWaypoint(null);
        toast('已删除选中的路线点');
      }
      break;
    }
    default:
      break;
  }
});

// ------------------------------------------------------------------ 指针

let pointerDown: { x: number; y: number; time: number } | null = null;
let draggingWaypointId: string | null = null;
let suppressClick = false;

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  pointerDown = { x: event.clientX, y: event.clientY, time: performance.now() };
  suppressClick = false;

  if (view.getMode() === 'vertex' && view.transform.enabled && view.transform.axis) {
    suppressClick = true;
    return;
  }

  if (view.getMode() !== 'select') return;
  const wpId = view.pickWaypoint(event);
  if (!wpId) return;
  draggingWaypointId = wpId;
  view.selectWaypoint(wpId);
  view.selectSegment(null);
  view.controls.enabled = false;
  canvas.setPointerCapture(event.pointerId);
  renderList();
  renderStats();
});

canvas.addEventListener('pointermove', (event) => {
  if (!draggingWaypointId || !route) return;
  const hit = view.pickSurface(event);
  if (!hit) return;
  route.moveWaypoint(draggingWaypointId, hit.anchor);
});

canvas.addEventListener('pointerup', (event) => {
  const down = pointerDown;
  pointerDown = null;

  if (draggingWaypointId) {
    draggingWaypointId = null;
    view.controls.enabled = true;
    suppressClick = true;
    renderStats();
    return;
  }

  if (!down) return;
  const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
  const elapsed = performance.now() - down.time;
  if (moved > 6 || elapsed > 700 || suppressClick) {
    suppressClick = false;
    return;
  }
  view.handleClick(event);
  renderStats();
});

canvas.addEventListener('pointercancel', () => {
  draggingWaypointId = null;
  view.controls.enabled = true;
});

// ------------------------------------------------------------------ 开关

toggleEmpties.addEventListener('change', () => view.setShowEmptyLinks(toggleEmpties.checked));
toggleLabels.addEventListener('change', () => view.setShowLabels(toggleLabels.checked));
toggleWire.addEventListener('change', () => view.setShowWireframe(toggleWire.checked));

autoRotateButton.addEventListener('click', () => {
  const next = !view.isAutoRotating();
  view.setAutoRotateModel(next);
  autoRotateButton.classList.toggle('active', next);
  autoRotateButton.textContent = next ? '停止旋转' : '自动旋转模型';
});

// ------------------------------------------------------------------ 存档

function buildSave(): SavedAnnotation {
  if (!route || !view.getSurfaceMesh()) throw new Error('场景尚未就绪');
  return createSave({
    sampleId: currentSampleId,
    camera: view.getCameraState(),
    waypoints: route.getWaypoints().map((wp) => ({
      id: wp.id,
      name: wp.name,
      anchor: { tri: wp.anchor.tri, bary: [...wp.anchor.bary] as [number, number, number] },
    })),
    vertexOffsets: view.getSurfaceMesh()!.collectVertexOffsets(),
    modelRotation: view.getModelRotation(),
    selectedWaypointId: view.getSelectedWaypoint(),
  });
}

function applySave(annotation: SavedAnnotation): void {
  loadSample(annotation.sampleId, { seed: false });
  const mesh = view.getSurfaceMesh();
  if (!mesh) throw new Error('场景尚未就绪');

  const offsets = new Map<number, [number, number, number]>();
  for (const [key, value] of Object.entries(annotation.vertexOffsets)) {
    offsets.set(Number(key), value);
  }
  mesh.applyVertexOffsets(offsets);

  if (!route) throw new Error('路线模型尚未就绪');
  route.restore(annotation.waypoints);
  view.setModelRotation(annotation.modelRotation);
  view.setCameraState(annotation.camera);
  if (annotation.selectedWaypointId) view.selectWaypoint(annotation.selectedWaypointId);
  ioStatus.textContent = `已恢复 ${annotation.waypoints.length} 个标注点与相机视角。`;
}

saveButton.addEventListener('click', () => {
  try {
    const annotation = buildSave();
    const blob = new Blob([serializeSave(annotation)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `route-${annotation.sampleId}-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    ioStatus.textContent = `已保存 ${annotation.waypoints.length} 个标注点（含相机与网格偏移）。`;
    toast('存档已下载');
  } catch (err) {
    toast((err as Error).message, 'error');
  }
});

loadButton.addEventListener('click', () => loadFile.click());

loadFile.addEventListener('change', async () => {
  const file = loadFile.files?.[0];
  if (!file) return;
  const text = await file.text();
  const result = deserializeSave(text);
  if (!result.ok || !result.value) {
    toast(result.errors[0] ?? '存档无效', 'error');
    ioStatus.textContent = result.errors.join('；');
    return;
  }
  try {
    applySave(result.value);
    toast(result.droppedWaypoints > 0 ? `已恢复，丢弃 ${result.droppedWaypoints} 个坏点` : '存档已恢复');
  } catch (err) {
    toast((err as Error).message, 'error');
  } finally {
    loadFile.value = '';
  }
});

sampleSelect.addEventListener('change', () => {
  loadSample(sampleSelect.value as SampleId);
});

clearButton.addEventListener('click', () => {
  route?.clear();
  view.selectWaypoint(null);
  view.selectSegment(null);
  toast('已清空路线');
});

// ------------------------------------------------------------------ 自动化入口

export interface DebugApi {
  ready: boolean;
  getSummary(): RouteSummary;
  getWaypoints(): { id: string; name: string; anchor: SurfaceAnchor }[];
  getSegments(): {
    id: string;
    fromId: string;
    toId: string;
    ok: boolean;
    reason?: string;
    length: number;
    triangles: number[];
    revision: number;
  }[];
  addWaypointAt(x: number, y: number, z: number): string | null;
  moveWaypoint(id: string, x: number, y: number, z: number): boolean;
  getMarkerGlue(): { id: string; markerToSurface: number; surfacePoint: [number, number, number] }[];
  getSegmentWorldPoints(): { segmentId: string; points: [number, number, number][] }[];
  selectSegment(id: string | null): void;
  editVertexNear(
    x: number,
    y: number,
    z: number,
    amount: number,
  ): { vertexIndex: number; affectedTriangles: number; updatedSegments: string[] } | null;
  rotateModelY(radians: number): void;
  getCamera(): CameraState;
  setCamera(camera: CameraState): void;
  getRaycastSurfacePoint(clientX: number, clientY: number): SurfaceHit | null;
  getWaypointScreenPosition(id: string): { x: number; y: number } | null;
  getSurfaceScreenPosition(x: number, y: number, z: number): { x: number; y: number; inside: boolean };
  save(): SavedAnnotation;
  restore(annotation: SavedAnnotation | string): void;
  loadSample(id: SampleId): void;
  getMode(): ViewerMode;
  setMode(mode: ViewerMode): void;
  getSampleId(): SampleId;
  getRenderInfo(): { triangles: number; drawCalls: number };
  isLineOnSurface(segmentId: string, tolerance?: number): { ok: boolean; maxDeviation: number };
  maxPathDeviation(): { maxPlaneDeviation: number; maxBaryOvershoot: number };
  getHoleCircles(): { center: [number, number]; radius: number }[];
  getVertexGizmoState(): { enabled: boolean; attached: boolean; vertexIndex: number | null };
  nudgeSelectedVertex(amount: number): boolean;
  getTriangleCentroids(tris: number[]): [number, number, number][];
  countSegmentVisuals(): number;
}

const debugApi: DebugApi = {
  ready: true,
  getSummary: () => route!.summary(),
  getWaypoints: () => route!.getWaypoints().map((wp) => ({ id: wp.id, name: wp.name, anchor: wp.anchor })),
  getSegments: () =>
    route!.getSegments().map((seg) => ({
      id: seg.id,
      fromId: seg.fromId,
      toId: seg.toId,
      ok: seg.path.ok,
      reason: seg.path.ok ? undefined : seg.path.reason,
      length: seg.path.length,
      triangles: seg.path.ok ? [...seg.path.triangles] : [],
      revision: seg.revision,
    })),
  addWaypointAt: (x, y, z) => {
    const mesh = view.getSurfaceMesh();
    if (!mesh) return null;
    const hit = mesh.closestPoint(new Vector3(x, y, z));
    if (!hit) return null;
    const wp = route!.addWaypoint({ tri: hit.tri, bary: hit.bary });
    view.selectWaypoint(wp.id);
    return wp.id;
  },
  moveWaypoint: (id, x, y, z) => {
    const mesh = view.getSurfaceMesh();
    if (!mesh) return false;
    const hit = mesh.closestPoint(new Vector3(x, y, z));
    if (!hit) return false;
    route!.moveWaypoint(id, { tri: hit.tri, bary: hit.bary });
    return true;
  },
  getMarkerGlue: () => {
    const mesh = view.getSurfaceMesh();
    if (!mesh) return [];
    const result: { id: string; markerToSurface: number; surfacePoint: [number, number, number] }[] = [];
    for (const wp of route!.getWaypoints()) {
      const surfaceWorld = view.modelRoot.localToWorld(mesh.anchorPosition(wp.anchor));
      const marker = view.getMarkerWorld(wp.id);
      if (!marker) continue;
      result.push({
        id: wp.id,
        markerToSurface: marker.distanceTo(surfaceWorld),
        surfacePoint: surfaceWorld.toArray() as [number, number, number],
      });
    }
    return result;
  },
  getSegmentWorldPoints: () =>
    route!.getSegments()
      .filter((seg) => seg.path.ok)
      .map((seg) => ({
        segmentId: seg.id,
        points: seg.path.points.map(
          (p) => view.modelRoot.localToWorld(p.clone()).toArray() as [number, number, number],
        ),
      })),
  selectSegment: (id) => {
    view.selectSegment(id);
    renderStats();
  },
  editVertexNear: (x, y, z, amount) => {
    const mesh = view.getSurfaceMesh();
    if (!mesh || !route) return null;
    const hit = mesh.closestPoint(new Vector3(x, y, z));
    if (!hit) return null;
    const indices = mesh.getTriangleVertexIndices(hit.tri);
    let best = indices[0];
    let bestDist = Infinity;
    for (const vi of indices) {
      const d = mesh.getVertexPosition(vi).distanceToSquared(hit.point);
      if (d < bestDist) {
        bestDist = d;
        best = vi;
      }
    }
    const p = mesh.getVertexPosition(best);
    const normal = mesh.pointNormal(p, hit.tri);
    const affected = mesh.moveVertex(
      best,
      p.x + normal.x * amount,
      p.y + normal.y * amount,
      p.z + normal.z * amount,
    );
    const change = route.updateAfterVertexEdit(affected);
    return { vertexIndex: best, affectedTriangles: affected.length, updatedSegments: change.updatedSegments };
  },
  rotateModelY: (radians) => view.rotateModelY(radians),
  getCamera: () => view.getCameraState(),
  setCamera: (camera) => view.setCameraState(camera),
  getRaycastSurfacePoint: (clientX, clientY) => {
    const event = { clientX, clientY } as PointerEvent;
    return view.pickSurface(event);
  },
  getSurfaceScreenPosition: (x, y, z) => {
    const world = new Vector3(x, y, z);
    const projected = world.clone().project(view.camera);
    const rect = view.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((projected.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - projected.y) / 2) * rect.height,
      inside: Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && projected.z <= 1,
    };
  },
  getWaypointScreenPosition: (id) => {
    const world = view.getMarkerWorld(id);
    if (!world) return null;
    const projected = world.clone().project(view.camera);
    const rect = view.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((projected.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - projected.y) / 2) * rect.height,
    };
  },
  save: () => buildSave(),
  restore: (annotation) => {
    const parsed =
      typeof annotation === 'string'
        ? deserializeSave(annotation)
        : { ok: true as const, value: annotation, errors: [], droppedWaypoints: 0 };
    if (!parsed.ok || !parsed.value) throw new Error(parsed.errors.join('; '));
    applySave(parsed.value);
  },
  loadSample: (id) => loadSample(id),
  getMode: () => view.getMode(),
  setMode: (mode) => setMode(mode),
  getSampleId: () => currentSampleId,
  getRenderInfo: () => ({
    triangles: view.getSurfaceMesh()?.triangleCount ?? 0,
    drawCalls: view.renderer.info.render.calls,
  }),
  isLineOnSurface: (segmentId, tolerance = 1e-3) => {
    // 逐段检查：路径点必须落在它声明所属三角形所在的平面上
    const mesh = view.getSurfaceMesh();
    const seg = route!.getSegment(segmentId);
    if (!mesh || !seg || !seg.path.ok) return { ok: false, maxDeviation: Number.POSITIVE_INFINITY };
    let maxDeviation = 0;
    for (let i = 0; i < seg.path.points.length - 1; i++) {
      const tri = seg.path.pointTriangles[i];
      const normal = mesh.faceNormal(tri);
      const origin = mesh.getTrianglePoints(tri)[0];
      for (const t of [0, 0.5, 1]) {
        const p = new Vector3().lerpVectors(seg.path.points[i], seg.path.points[i + 1], t);
        maxDeviation = Math.max(maxDeviation, Math.abs(p.clone().sub(origin).dot(normal)));
      }
    }
    return { ok: maxDeviation <= tolerance, maxDeviation };
  },
  /** 在模型局部坐标里逐点检查：折线必须落在所属三角形平面上、且不越出三角形范围 */
  maxPathDeviation(): { maxPlaneDeviation: number; maxBaryOvershoot: number } {
    const mesh = view.getSurfaceMesh();
    if (!mesh) return { maxPlaneDeviation: Infinity, maxBaryOvershoot: Infinity };
    let maxPlaneDeviation = 0;
    let maxBaryOvershoot = 0;
    const bary = new Vector3();
    for (const seg of route!.getSegments()) {
      if (!seg.path.ok) continue;
      for (let i = 0; i < seg.path.points.length - 1; i++) {
        const tri = seg.path.pointTriangles[i];
        const pts = mesh.getTrianglePoints(tri);
        const normal = mesh.faceNormal(tri);
        const origin = pts[0];
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
          const p = new Vector3().lerpVectors(seg.path.points[i], seg.path.points[i + 1], t);
          maxPlaneDeviation = Math.max(maxPlaneDeviation, Math.abs(p.clone().sub(origin).dot(normal)));
          if (Triangle.getBarycoord(p, pts[0], pts[1], pts[2], bary)) {
            maxBaryOvershoot = Math.max(maxBaryOvershoot, Math.max(-bary.x, -bary.y, -bary.z, 0));
          }
        }
      }
    }
    return { maxPlaneDeviation, maxBaryOvershoot };
  },
  getVertexGizmoState: () => view.getVertexGizmoState(),
  nudgeSelectedVertex: (amount) => view.nudgeSelectedVertex(amount),
  getHoleCircles: () => view.getSurfaceMesh()?.holes.map((h) => ({ center: [...h.center] as [number, number], radius: h.radius })) ?? [],
  getTriangleCentroids: (tris) => {
    const mesh = view.getSurfaceMesh();
    if (!mesh) return [];
    return tris.map((t) => mesh.centroid(t).toArray() as [number, number, number]);
  },
  countSegmentVisuals: () => view.countSegmentVisuals(),
};

declare global {
  interface Window {
    __routeApp?: DebugApi & { view: ThreeView };
  }
}
window.__routeApp = Object.assign(debugApi, { view });

// ------------------------------------------------------------------ 启动

loadSample('curved-holey');
