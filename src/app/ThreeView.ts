import {
  ACESFilmicToneMapping,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  GridHelper,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WireframeGeometry,
  LineSegments,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

import { SurfaceMesh } from '../core/SurfaceMesh';
import { RouteModel } from '../core/RouteModel';
import type { RouteSegment, RouteSnapshot } from '../core/RouteModel';
import type { SurfaceAnchor } from '../core/types';

export type ViewerMode = 'add' | 'select' | 'vertex';

export interface SurfaceHit {
  anchor: SurfaceAnchor;
  localPoint: Vector3;
  worldPoint: Vector3;
  tri: number;
}

export interface ViewerCallbacks {
  onSegmentClick?: (segmentId: string) => void;
  onWaypointClick?: (waypointId: string) => void;
  onSurfaceClick?: (hit: SurfaceHit) => void;
  onMissClick?: () => void;
  onVertexPick?: (vertexIndex: number) => void;
  onVertexDragged?: () => void;
  onError?: (message: string) => void;
}

interface SegmentVisual {
  group: Group;
  line?: Line2;
  dashed?: Line;
  label?: CSS2DObject;
  labelEl?: HTMLDivElement;
  revision: number;
}

interface MarkerVisual {
  mesh: Mesh;
  halo: Mesh;
  label: CSS2DObject;
  labelEl: HTMLDivElement;
}

const SURFACE_COLOR = 0x354050;
const ACCENT = 0x57d0a4;
const ACCENT_SELECTED = 0xffd166;
const FAILED_COLOR = 0xf5c76a;
const OFFSET = 0.02;

function makeLabel(className: string): { el: HTMLDivElement; object: CSS2DObject } {
  const el = document.createElement('div');
  el.className = className;
  const object = new CSS2DObject(el);
  return { el, object };
}

/**
 * 负责 Three.js 场景和所有“看得见的东西”。
 *
 * 所有标注（线 / 点 / 标签 / 测量面板）都挂在 modelRoot 下，
 * 因此旋转 modelRoot 时它们和曲面共享同一套坐标，永远贴着表面。
 */
export class ThreeView {
  readonly renderer: WebGLRenderer;
  readonly labelRenderer: CSS2DRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly modelRoot: Group;
  readonly transform: TransformControls;

  surface?: SurfaceMesh;
  route?: RouteModel;
  private surfaceMesh?: Mesh;
  private wireframe?: LineSegments;
  private highlightMesh?: Mesh;
  private vertexMarker?: Mesh;

  private segmentVisuals = new Map<string, SegmentVisual>();
  private markers = new Map<string, MarkerVisual>();
  private markerGeometry = new SphereGeometry(1, 18, 14);
  private haloGeometry = new SphereGeometry(1, 18, 14);
  private markerScale = 0.075;
  private measureCard: CSS2DObject | null = null;
  private measureEl: HTMLDivElement | null = null;

  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();

  private mode: ViewerMode = 'add';
  private selectedWaypointId: string | null = null;
  private selectedSegmentId: string | null = null;
  private showEmptyLinks = true;
  private showLabels = true;
  private showWireframe = false;
  private autoRotateModel = false;

  private vertexProxy = new Object3D();
  private vertexDrag:
    | {
        index: number;
        basePosition: Vector3;
        normal: Vector3;
        dragStart: Vector3;
      }
    | null = null;

  private frameHandlers = new Set<() => void>();
  private callbacks: ViewerCallbacks = {};
  private resizeObserver: ResizeObserver;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, callbacks: ViewerCallbacks) {
    this.callbacks = callbacks;

    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new Scene();
    this.scene.background = new Color(0x0e1116);

    const camera = new PerspectiveCamera(45, 1, 0.05, 200);
    camera.position.set(7.5, 6.4, 8.5);
    this.camera = camera;

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    Object.assign(this.labelRenderer.domElement.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      overflow: 'hidden',
    });
    canvas.parentElement?.appendChild(this.labelRenderer.domElement);

    this.controls = new OrbitControls(camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 40;
    this.controls.maxPolarAngle = Math.PI * 0.97;

    this.modelRoot = new Group();
    this.modelRoot.name = 'modelRoot';
    this.scene.add(this.modelRoot);

    this.setupLights();

    const grid = new GridHelper(24, 24, 0x1c2430, 0x161c25);
    grid.position.y = -3.4;
    (grid.material as LineBasicMaterial).transparent = true;
    (grid.material as LineBasicMaterial).opacity = 0.85;
    this.scene.add(grid);

    this.transform = new TransformControls(camera, canvas);
    this.transform.setSpace('local');
    this.transform.setMode('translate');
    this.transform.setSize(0.8);
    this.transform.enabled = false;
    this.scene.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', (event) => {
      const dragging = Boolean((event as unknown as { value: boolean }).value);
      this.controls.enabled = !dragging;
    });
    this.transform.addEventListener('objectChange', this.handleVertexGizmoChange);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    const parent = canvas.parentElement ?? document.body;
    this.resizeObserver.observe(parent);
    this.resize();

    const loop = (): void => {
      if (this.disposed) return;
      this.animate();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private setupLights(): void {
    const hemi = new HemisphereLight(0xbcd4ff, 0x1a2029, 1.15);
    this.scene.add(hemi);

    const key = new DirectionalLight(0xffffff, 2.1);
    key.position.set(6, 10, 7);
    this.scene.add(key);

    const rim = new DirectionalLight(0x7fc8ff, 1.0);
    rim.position.set(-7, 4, -6);
    this.scene.add(rim);

    const bounce = new DirectionalLight(0x57d0a4, 0.35);
    bounce.position.set(0, -6, 2);
    this.scene.add(bounce);
  }

  onFrame(handler: () => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  private animate(): void {
    if (this.autoRotateModel && !this.transform.dragging) {
      this.modelRoot.rotation.y += 0.0032;
    }
    this.controls.update();
    for (const handler of this.frameHandlers) handler();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  resize(): void {
    const parent = this.renderer.domElement.parentElement;
    const width = parent?.clientWidth ?? window.innerWidth;
    const height = parent?.clientHeight ?? window.innerHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.labelRenderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.updateLineResolution();
  }

  private updateLineResolution(): void {
    const width = this.renderer.domElement.clientWidth || 1;
    const height = this.renderer.domElement.clientHeight || 1;
    for (const visual of this.segmentVisuals.values()) {
      visual.line?.material.resolution.set(width, height);
    }
  }

  // ---------------------------------------------------------------- 场景装载

  mountSurface(surface: SurfaceMesh, route: RouteModel): void {
    this.clearSurface();
    this.surface = surface;
    this.route = route;

    const material = new MeshStandardMaterial({
      color: SURFACE_COLOR,
      roughness: 0.82,
      metalness: 0.06,
      side: DoubleSide,
      flatShading: false,
    });
    const mesh = new Mesh(surface.geometry, material);
    mesh.name = 'surface';
    this.surfaceMesh = mesh;
    this.modelRoot.add(mesh);

    const wire = new LineSegments(
      new WireframeGeometry(surface.geometry),
      new LineBasicMaterial({ color: 0x8fb7d6, transparent: true, opacity: 0.13 }),
    );
    wire.name = 'wireframe';
    wire.visible = this.showWireframe;
    this.wireframe = wire;
    this.modelRoot.add(wire);

    // 高亮被选中线段经过的三角形
    const highlight = new Mesh(
      new BufferGeometry(),
      new MeshBasicMaterial({
        color: ACCENT_SELECTED,
        transparent: true,
        opacity: 0.32,
        side: DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    );
    highlight.name = 'segment-highlight';
    highlight.visible = false;
    this.highlightMesh = highlight;
    this.modelRoot.add(highlight);

    const bounds = surface.geometry.boundingSphere;
    const radius = bounds ? bounds.radius : 6;
    this.markerScale = Math.max(0.045, radius * 0.014);
    this.controls.minDistance = radius * 0.35;
    this.controls.maxDistance = radius * 6;

    this.syncRoute(route.snapshot());
    this.frameCamera();
  }

  disposeSurfaceVisuals(): void {
    for (const [id, visual] of this.segmentVisuals) {
      this.disposeSegmentVisual(visual);
      this.segmentVisuals.delete(id);
    }
    for (const [id, marker] of this.markers) {
      this.modelRoot.remove(marker.mesh, marker.halo);
      marker.label.removeFromParent();
      (marker.mesh.material as MeshBasicMaterial).dispose();
      (marker.halo.material as MeshBasicMaterial).dispose();
      this.markers.delete(id);
    }
    this.detachVertexGizmo();
    if (this.highlightMesh) {
      this.highlightMesh.geometry.dispose();
      this.highlightMesh.removeFromParent();
      (this.highlightMesh.material as MeshBasicMaterial).dispose();
      this.highlightMesh = undefined;
    }
    if (this.wireframe) {
      this.wireframe.geometry.dispose();
      (this.wireframe.material as LineBasicMaterial).dispose();
      this.wireframe.removeFromParent();
      this.wireframe = undefined;
    }
    if (this.surfaceMesh) {
      const material = this.surfaceMesh.material as MeshStandardMaterial;
      material.dispose();
      this.surfaceMesh.removeFromParent();
      this.surfaceMesh = undefined;
    }
  }

  private clearSurface(): void {
    this.disposeSurfaceVisuals();
    this.surface = undefined;
    this.route = undefined;
    this.selectedSegmentId = null;
    this.selectedWaypointId = null;
  }

  dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.clearSurface();
    this.markerGeometry.dispose();
    this.haloGeometry.dispose();
    this.transform.dispose();
    this.renderer.dispose();
    this.labelRenderer.domElement.remove();
  }

  private frameCamera(): void {
    const sphere = this.surface?.geometry.boundingSphere;
    if (!sphere) return;
    const center = sphere.center;
    const radius = sphere.radius;
    const distance = radius * 1.9;
    const dir = new Vector3(0.62, 0.55, 0.75).normalize();
    this.camera.position.copy(center).addScaledVector(dir, distance);
    this.camera.near = Math.max(0.02, radius / 100);
    this.camera.far = distance * 8;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
  }

  // ---------------------------------------------------------------- 拾取

  private setPointer(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  pickSurface(event: PointerEvent): SurfaceHit | null {
    if (!this.surface || !this.surfaceMesh) return null;
    this.setPointer(event);
    const hits = this.raycaster.intersectObject(this.surfaceMesh, false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    if (hit.faceIndex === undefined || hit.faceIndex === null || !hit.barycoord) return null;
    const bary = hit.barycoord;
    const anchor: SurfaceAnchor = {
      tri: hit.faceIndex,
      bary: [bary.x, bary.y, bary.z],
    };
    const worldPoint = hit.point.clone();
    const localPoint = this.modelRoot.worldToLocal(worldPoint.clone());
    return { anchor, localPoint, worldPoint, tri: hit.faceIndex };
  }

  pickWaypoint(event: PointerEvent): string | null {
    this.setPointer(event);
    const meshes: { id: string; mesh: Mesh }[] = [];
    for (const [id, marker] of this.markers) meshes.push({ id, mesh: marker.mesh });
    const hits = this.raycaster.intersectObjects(
      meshes.map((m) => m.mesh),
      false,
    );
    if (hits.length === 0) return null;
    const hitObject = hits[0].object as Mesh;
    const found = meshes.find((m) => m.mesh === hitObject);
    return found?.id ?? null;
  }

  pickSegment(event: PointerEvent): string | null {
    this.setPointer(event);
    this.raycaster.params.Line2 = { threshold: 7 };
    try {
      const lines: Line2[] = [];
      const byLine = new Map<Line2, string>();
      for (const [id, visual] of this.segmentVisuals) {
        if (!visual.line || !visual.line.visible) continue;
        lines.push(visual.line);
        byLine.set(visual.line, id);
      }
      if (lines.length === 0) return null;
      const hits = this.raycaster.intersectObjects(lines, false);
      if (hits.length === 0) return null;
      return byLine.get(hits[0].object as Line2) ?? null;
    } finally {
      delete this.raycaster.params.Line2;
    }
  }

  pickVertex(event: PointerEvent): number | null {
    const hit = this.pickSurface(event);
    if (!hit || !this.surface) return null;
    const indices = this.surface.getTriangleVertexIndices(hit.tri);
    let best = indices[0];
    let bestDist = Infinity;
    const p = hit.localPoint;
    for (const vi of indices) {
      const v = this.surface.getVertexPosition(vi);
      const d = v.distanceToSquared(p);
      if (d < bestDist) {
        bestDist = d;
        best = vi;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- 交互入口

  setMode(mode: ViewerMode): void {
    this.mode = mode;
    if (mode !== 'vertex') this.detachVertexGizmo();
  }

  getMode(): ViewerMode {
    return this.mode;
  }

  setAutoRotateModel(value: boolean): void {
    this.autoRotateModel = value;
  }

  isAutoRotating(): boolean {
    return this.autoRotateModel;
  }

  setShowEmptyLinks(value: boolean): void {
    this.showEmptyLinks = value;
    this.applyVisibility();
  }

  setShowLabels(value: boolean): void {
    this.showLabels = value;
    this.applyVisibility();
  }

  setShowWireframe(value: boolean): void {
    this.showWireframe = value;
    if (this.wireframe) this.wireframe.visible = value;
  }

  selectWaypoint(id: string | null): void {
    this.selectedWaypointId = id;
    this.refreshMarkerStyles();
    this.syncSelectionUi();
  }

  getSelectedWaypoint(): string | null {
    return this.selectedWaypointId;
  }

  selectSegment(id: string | null): void {
    this.selectedSegmentId = id;
    this.refreshSegmentStyles();
    this.refreshHighlight();
  }

  getSelectedSegment(): string | null {
    return this.selectedSegmentId;
  }

  handleClick(event: PointerEvent): void {
    if (!this.surface || !this.route) return;

    if (this.mode === 'vertex') {
      const vertex = this.pickVertex(event);
      if (vertex === null) {
        this.callbacks.onMissClick?.();
        return;
      }
      this.attachVertexGizmo(vertex);
      this.callbacks.onVertexPick?.(vertex);
      return;
    }

    const wpId = this.pickWaypoint(event);
    if (wpId) {
      this.selectWaypoint(wpId);
      this.callbacks.onWaypointClick?.(wpId);
      return;
    }

    const segId = this.pickSegment(event);
    if (segId) {
      this.selectSegment(segId);
      this.selectWaypoint(null);
      this.callbacks.onSegmentClick?.(segId);
      return;
    }

    const hit = this.pickSurface(event);
    if (hit) {
      this.callbacks.onSurfaceClick?.(hit);
    } else {
      this.callbacks.onMissClick?.();
    }
  }

  // ---------------------------------------------------------------- 渲染同步

  syncRoute(snapshot: RouteSnapshot): void {
    if (!this.surface || !this.route) return;
    const liveSegmentIds = new Set<string>();

    for (const segment of snapshot.segments) {
      liveSegmentIds.add(segment.id);
      this.syncSegment(segment);
    }

    // 删掉已经不存在的段（不做增量隐藏，直接销毁，避免旧路径残留）
    for (const [id, visual] of this.segmentVisuals) {
      if (liveSegmentIds.has(id)) continue;
      this.disposeSegmentVisual(visual);
      this.segmentVisuals.delete(id);
      if (this.selectedSegmentId === id) this.selectedSegmentId = null;
    }

    this.syncMarkers(snapshot);
    this.applyVisibility();
    this.refreshSegmentStyles();
    this.refreshHighlight();
    this.updateLineResolution();
  }

  private syncSegment(segment: RouteSegment): void {
    if (!this.surface) return;
    let visual = this.segmentVisuals.get(segment.id);
    if (visual && visual.revision === segment.revision) {
      return;
    }
    if (!visual) {
      visual = this.createSegmentVisual(segment);
      this.segmentVisuals.set(segment.id, visual);
    }

    const group = visual.group;
    // 先移除旧对象，保证一条线段永远只有一份可视对象
    if (visual.line) {
      group.remove(visual.line);
      visual.line.geometry.dispose();
      (visual.line.material as LineMaterial).dispose();
      visual.line = undefined;
    }
    if (visual.dashed) {
      group.remove(visual.dashed);
      visual.dashed.geometry.dispose();
      (visual.dashed.material as LineDashedMaterial).dispose();
      visual.dashed = undefined;
    }

    if (segment.path.ok) {
      const points = this.offsetPathPoints(segment);
      const positions: number[] = [];
      for (const p of points) positions.push(p.x, p.y, p.z);
      const geometry = new LineGeometry();
      geometry.setPositions(positions);
      const material = new LineMaterial({
        color: ACCENT,
        linewidth: 4,
        worldUnits: false,
        alphaToCoverage: false,
        transparent: true,
        depthTest: true,
      });
      const width = this.renderer.domElement.clientWidth || 1;
      const height = this.renderer.domElement.clientHeight || 1;
      material.resolution.set(width, height);
      const line = new Line2(geometry, material);
      line.computeLineDistances();
      line.renderOrder = 3;
      group.add(line);
      visual.line = line;
      visual.dashed = undefined;

      const el = visual.labelEl!;
      el.className = 'pin-label';
      el.textContent = ` ${segment.path.length.toFixed(2)} `;
      el.title = `长度 ${segment.path.length.toFixed(3)} · ${segment.path.triangles.length} 个表面三角形`;
      const mid = points[Math.floor(points.length / 2)] ?? points[0];
      visual.label!.position.copy(mid);
      visual.label!.userData.midLocal = mid.clone();
      visual.label!.visible = true;
    } else {
      // 断开 / 无路：用虚线提示，并明确写“断开”，绝不假装是贴面路径
      const from = this.route!.getWaypoint(segment.fromId);
      const to = this.route!.getWaypoint(segment.toId);
      if (from && to) {
        const a = this.surface.anchorPosition(from.anchor);
        const b = this.surface.anchorPosition(to.anchor);
        const geometry = new BufferGeometry().setFromPoints([a, b]);
        const dashed = new Line(
          geometry,
          new LineDashedMaterial({
            color: FAILED_COLOR,
            dashSize: 0.16,
            gapSize: 0.12,
            transparent: true,
            opacity: 0.65,
          }),
        );
        dashed.computeLineDistances();
        group.add(dashed);
        visual.dashed = dashed;
        const el = visual.labelEl!;
        el.className = 'pin-label failed';
        el.textContent = segment.path.reason === 'disconnected' ? '断开' : '无通路';
        el.title =
          segment.path.reason === 'disconnected'
            ? '两个点位于互不相连的表面上，没有贴面路径'
            : '找不到贴面路径';
        visual.label!.position.copy(a).add(b).multiplyScalar(0.5);
        visual.label!.visible = true;
      }
    }

    visual.revision = segment.revision;
  }

  private offsetPathPoints(segment: RouteSegment): Vector3[] {
    if (!this.surface || !segment.path.ok) return [];
    const path = segment.path;
    const out: Vector3[] = [];
    for (let i = 0; i < path.points.length; i++) {
      const tri = path.pointTriangles[Math.min(i, path.pointTriangles.length - 1)];
      const p = path.points[i].clone();
      const n = this.surface.pointNormal(path.points[i], tri);
      out.push(p.addScaledVector(n, OFFSET));
    }
    return out;
  }

  private createSegmentVisual(segment: RouteSegment): SegmentVisual {
    const group = new Group();
    group.name = `segment:${segment.id}`;
    const { el, object } = makeLabel('pin-label');
    object.visible = false;
    group.add(object);
    this.modelRoot.add(group);
    return { group, label: object, labelEl: el, revision: -1 };
  }

  private disposeSegmentVisual(visual: SegmentVisual): void {
    if (visual.line) {
      visual.line.geometry.dispose();
      (visual.line.material as LineMaterial).dispose();
    }
    if (visual.dashed) {
      visual.dashed.geometry.dispose();
      (visual.dashed.material as LineDashedMaterial).dispose();
    }
    visual.label?.removeFromParent();
    visual.group.removeFromParent();
  }

  private syncMarkers(snapshot: RouteSnapshot): void {
    if (!this.surface) return;
    const live = new Set<string>();
    for (const wp of snapshot.waypoints) {
      live.add(wp.id);
      let marker = this.markers.get(wp.id);
      if (!marker) {
        marker = this.createMarker(wp.id, wp.name);
        this.markers.set(wp.id, marker);
      }
      const position = this.surface.anchorPosition(wp.anchor);
      const normal = this.surface.anchorNormal(wp.anchor);
      const lifted = position.clone().addScaledVector(normal, OFFSET * 1.6);
      marker.mesh.position.copy(lifted);
      marker.halo.position.copy(lifted);
      marker.label.position.copy(lifted).addScaledVector(normal, this.markerScale * 0.9);
      marker.mesh.scale.setScalar(this.markerScale);
      marker.halo.scale.setScalar(this.markerScale * 1.9);
      marker.labelEl.textContent = wp.name;
    }
    for (const [id, marker] of this.markers) {
      if (live.has(id)) continue;
      this.modelRoot.remove(marker.mesh, marker.halo);
      marker.label.removeFromParent();
      (marker.mesh.material as MeshBasicMaterial).dispose();
      (marker.halo.material as MeshBasicMaterial).dispose();
      this.markers.delete(id);
    }
    this.refreshMarkerStyles();
  }

  private createMarker(wpId: string, name: string): MarkerVisual {
    const mesh = new Mesh(
      this.markerGeometry,
      new MeshBasicMaterial({ color: ACCENT, toneMapped: false }),
    );
    mesh.name = `waypoint:${wpId}`;
    mesh.userData.waypointId = wpId;
    const halo = new Mesh(
      this.haloGeometry,
      new MeshBasicMaterial({
        color: ACCENT,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.modelRoot.add(mesh, halo);

    const { el, object } = makeLabel('pin-label dim');
    el.textContent = name;
    this.modelRoot.add(object);
    return { mesh, halo, label: object, labelEl: el };
  }

  private refreshMarkerStyles(): void {
    for (const [id, marker] of this.markers) {
      const selected = id === this.selectedWaypointId;
      (marker.mesh.material as MeshBasicMaterial).color.setHex(selected ? ACCENT_SELECTED : ACCENT);
      (marker.halo.material as MeshBasicMaterial).color.setHex(selected ? ACCENT_SELECTED : ACCENT);
      (marker.halo.material as MeshBasicMaterial).opacity = selected ? 0.28 : 0.14;
      marker.labelEl.classList.toggle('dim', !selected);
    }
    this.syncSelectionUi();
  }

  private refreshSegmentStyles(): void {
    for (const [id, visual] of this.segmentVisuals) {
      if (!visual.line) continue;
      const selected = id === this.selectedSegmentId;
      (visual.line.material as LineMaterial).color.setHex(selected ? ACCENT_SELECTED : ACCENT);
      (visual.line.material as LineMaterial).linewidth = selected ? 5.5 : 4;
    }
  }

  private syncSelectionUi(): void {
    for (const [id, marker] of this.markers) {
      marker.labelEl.classList.toggle('dim', id !== this.selectedWaypointId);
    }
  }

  private applyVisibility(): void {
    for (const visual of this.segmentVisuals.values()) {
      if (visual.dashed) visual.dashed.visible = this.showEmptyLinks;
      if (visual.label) {
        const failed = Boolean(visual.dashed);
        visual.label.visible = this.showLabels && (!failed || this.showEmptyLinks);
      }
    }
    for (const marker of this.markers.values()) {
      marker.label.visible = this.showLabels;
    }
  }

  private refreshHighlight(): void {
    if (!this.highlightMesh || !this.surface || !this.route) return;
    const segment = this.selectedSegmentId
      ? this.route.getSegment(this.selectedSegmentId)
      : undefined;
    if (!segment || !segment.path.ok || segment.path.triangles.length === 0) {
      this.highlightMesh.visible = false;
      this.updateMeasureCard();
      return;
    }
    const positions: number[] = [];
    const normals: number[] = [];
    for (const tri of segment.path.triangles) {
      const [a, b, c] = this.surface.getTrianglePoints(tri);
      const normal = this.surface.faceNormal(tri);
      for (const p of [a, b, c]) {
        positions.push(
          p.x + normal.x * OFFSET * 2.5,
          p.y + normal.y * OFFSET * 2.5,
          p.z + normal.z * OFFSET * 2.5,
        );
        normals.push(normal.x, normal.y, normal.z);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
    this.highlightMesh.geometry.dispose();
    this.highlightMesh.geometry = geometry;
    this.highlightMesh.visible = true;
    this.updateMeasureCard();
  }

  // ---------------------------------------------------------------- 测量卡片

  /** 选中线段时在模型上方浮出一张卡片：长度 + 经过的表面三角形 */
  private updateMeasureCard(): void {
    if (!this.surface || !this.route) return;
    const segment = this.selectedSegmentId
      ? this.route.getSegment(this.selectedSegmentId)
      : undefined;
    const visual = segment ? this.segmentVisuals.get(segment.id) : undefined;
    if (!segment || !visual) {
      this.measureCard?.removeFromParent();
      this.measureCard = null;
      this.measureEl = null;
      return;
    }

    if (!this.measureCard || !this.measureEl) {
      const el = document.createElement('div');
      el.className = 'measure-panel';
      const object = new CSS2DObject(el);
      object.center.set(0.5, 1.1);
      this.modelRoot.add(object);
      this.measureCard = object;
      this.measureEl = el;
    }

    const el = this.measureEl;
    if (segment.path.ok) {
      const midLocal = (visual.label?.userData.midLocal as Vector3 | undefined) ?? new Vector3();
      const normal = this.surface.pointNormal(
        midLocal.clone().addScaledVector(this.surface.faceNormal(segment.path.triangles[0]), 0),
        segment.path.triangles[0],
      );
      // 卡片浮在选中段中点上方：屏幕空间 CSS2D 不参与透视缩放，
      // 所以用小一点的偏移并把标签居中，避免遮住整条线
      this.measureCard.position.copy(midLocal).addScaledVector(normal, this.markerScale * 3.5);
      const tris = segment.path.triangles;
      const shown = tris.slice(0, 14).join(', ');
      el.innerHTML = `
        <div class="title">选中线段</div>
        <div class="length">${segment.path.length.toFixed(3)}<span class="unit"> 单位</span></div>
        <div class="tris">${tris.length} 个表面三角形 · ${shown}${tris.length > 14 ? ' …' : ''}</div>
      `;
      this.measureCard.visible = true;
    } else {
      const from = this.route.getWaypoint(segment.fromId);
      const to = this.route.getWaypoint(segment.toId);
      if (!from || !to) {
        this.measureCard.visible = false;
        return;
      }
      const a = this.surface.anchorPosition(from.anchor);
      const b = this.surface.anchorPosition(to.anchor);
      this.measureCard.position.lerpVectors(a, b, 0.5);
      el.innerHTML = `
        <div class="title">选中线段</div>
        <div class="failed">${segment.path.reason === 'disconnected' ? '表面断开：两个点不在同一块网格上' : '没有贴面通路'}</div>
      `;
      this.measureCard.visible = this.showLabels;
    }
  }

  // ---------------------------------------------------------------- 顶点编辑

  attachVertexGizmo(vertexIndex: number): void {
    if (!this.surface) return;
    const position = this.surface.getVertexPosition(vertexIndex);
    const normal = this.computeVertexNormal(vertexIndex);
    const proxy = this.vertexProxy;
    proxy.position.copy(position);
    proxy.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), normal);
    if (proxy.parent !== this.modelRoot) this.modelRoot.add(proxy);
    this.modelRoot.updateMatrixWorld(true);
    proxy.updateMatrixWorld(true);

    this.vertexDrag = {
      index: vertexIndex,
      basePosition: position.clone(),
      normal: normal.clone(),
      dragStart: position.clone(),
    };

    this.transform.attach(proxy);
    this.transform.setSpace('local');
    this.transform.showX = false;
    this.transform.showZ = false;
    this.transform.showY = true;
    this.transform.enabled = true;

    if (!this.vertexMarker) {
      this.vertexMarker = new Mesh(
        new SphereGeometry(1, 12, 10),
        new MeshBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true, opacity: 0.9 }),
      );
      this.vertexMarker.renderOrder = 6;
      this.modelRoot.add(this.vertexMarker);
    }
    this.vertexMarker.visible = true;
    this.vertexMarker.position.copy(position);
    this.vertexMarker.scale.setScalar(this.markerScale * 0.8);
  }

  detachVertexGizmo(): void {
    if (this.vertexDrag) {
      this.transform.detach();
      this.transform.enabled = false;
      this.vertexDrag = null;
    }
    if (this.vertexMarker) this.vertexMarker.visible = false;
  }

  getVertexGizmoState(): { enabled: boolean; attached: boolean; vertexIndex: number | null } {
    return {
      enabled: this.transform.enabled,
      attached: this.transform.object === this.vertexProxy,
      vertexIndex: this.vertexDrag?.index ?? null,
    };
  }

  /**
   * 模拟“拖动法线箭头”：只移动 proxy 并派发 objectChange，
   * 走的是和真实拖动完全相同的处理链路。
   */
  nudgeSelectedVertex(amount: number): boolean {
    const drag = this.vertexDrag;
    if (!drag) return false;
    this.vertexProxy.position.copy(drag.basePosition).addScaledVector(drag.normal, amount);
    // 更新基准点，让下一次 delta 从新位置算起
    drag.basePosition.copy(this.vertexProxy.position);
    this.transform.dispatchEvent({ type: 'objectChange' });
    return true;
  }

  private handleVertexGizmoChange = (): void => {
    const drag = this.vertexDrag;
    if (!drag || !this.surface || !this.route) return;
    const proxy = this.vertexProxy;
    const delta = proxy.position.clone().sub(drag.basePosition);
    // 只允许沿法线方向鼓包，避免把表面拖成尖刺
    const amount = delta.dot(drag.normal);
    const target = drag.basePosition.clone().addScaledVector(drag.normal, amount);
    proxy.position.copy(target);

    const affected = this.surface.moveVertex(drag.index, target.x, target.y, target.z);
    if (affected.length === 0) return;
    this.route.updateAfterVertexEdit(affected);
    this.vertexMarker?.position.copy(target);
    if (this.wireframe) this.refreshWireframe();
    this.callbacks.onVertexDragged?.();
  };

  private refreshWireframe(): void {
    if (!this.wireframe || !this.surface) return;
    const old = this.wireframe.geometry;
    const wire = new LineSegments(
      new WireframeGeometry(this.surface.geometry),
      this.wireframe.material as LineBasicMaterial,
    );
    wire.name = 'wireframe';
    wire.visible = this.showWireframe;
    this.modelRoot.add(wire);
    old.dispose();
    this.wireframe.removeFromParent();
    this.wireframe = wire;
  }

  private computeVertexNormal(vertexIndex: number): Vector3 {
    if (!this.surface) return new Vector3(0, 1, 0);
    const normal = new Vector3();
    for (const tri of this.surface.trianglesAdjacentToVertex(vertexIndex)) {
      normal.add(this.surface.faceNormal(tri));
    }
    if (normal.lengthSq() < 1e-9) normal.set(0, 1, 0);
    return normal.normalize();
  }

  // ---------------------------------------------------------------- 相机存档

  getCameraState(): { position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; fov: number } {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      target: this.controls.target.toArray() as [number, number, number],
      up: this.camera.up.toArray() as [number, number, number],
      fov: this.camera.fov,
    };
  }

  setCameraState(state: {
    position: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
    fov?: number;
  }): void {
    this.camera.position.fromArray(state.position);
    this.camera.up.fromArray(state.up).normalize();
    if (state.fov && Number.isFinite(state.fov)) this.camera.fov = state.fov;
    this.controls.target.fromArray(state.target);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** 让模型正对相机后返回，便于“旋转模型后线仍贴在原处”的验证 */
  rotateModelY(radians: number): void {
    this.modelRoot.rotation.y += radians;
  }

  getModelRotation(): [number, number, number] {
    return [this.modelRoot.rotation.x, this.modelRoot.rotation.y, this.modelRoot.rotation.z];
  }

  setModelRotation(rotation: [number, number, number]): void {
    this.modelRoot.rotation.set(rotation[0], rotation[1], rotation[2]);
    this.modelRoot.updateMatrixWorld(true);
  }

  getSurfaceMesh(): SurfaceMesh | undefined {
    return this.surface;
  }

  /** 当前场景中实际存在的线段可视对象数量（用于验证没有旧路径残留） */
  countSegmentVisuals(): number {
    return this.segmentVisuals.size;
  }

  getMarkerWorld(wpId: string): Vector3 | undefined {
    const marker = this.markers.get(wpId);
    return marker?.mesh.getWorldPosition(new Vector3());
  }
}
