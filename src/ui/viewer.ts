import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { MeshData, Vec3 } from '../core/types';
import { edgeKey, type MeshGraph } from '../core/topology';
import { meshBounds } from '../core/mesh';

export interface OverlayState {
  boundaryEdges: string[];
  nonManifoldEdges: string[];
  orientationEdges: string[];
  /** 框选得到、尚未分配 */
  candidateEdges: string[];
  chainAEdges: string[];
  chainBEdges: string[];
  preservedEdges: string[];
  inspectedEdges: string[];
  /** 链 A / B 的顶点，用于小圆点标记 */
  chainAVertices: number[];
  chainBVertices: number[];
  /** 配对线段 [a,b] */
  pairSegments: [number, number][];
  /** 预览受影响的面 */
  previewFaces: number[];
}

const EMPTY_OVERLAY: OverlayState = {
  boundaryEdges: [],
  nonManifoldEdges: [],
  orientationEdges: [],
  candidateEdges: [],
  chainAEdges: [],
  chainBEdges: [],
  preservedEdges: [],
  inspectedEdges: [],
  chainAVertices: [],
  chainBVertices: [],
  pairSegments: [],
  previewFaces: [],
};

const COLORS = {
  boundary: 0xff5d5d,
  nonManifold: 0xd35bff,
  orientation: 0xffb020,
  candidate: 0x7f8b99,
  chainA: 0x35d6ff,
  chainB: 0xffe14d,
  preserved: 0x43e08b,
  inspected: 0xffffff,
  pair: 0x59ffa8,
  front: 0x9aa6b5,
  back: 0xff5470,
  preview: 0xffd166,
};

interface HitEdge {
  key: string;
  a: number;
  b: number;
}

export class Viewer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  private readonly container: HTMLElement;
  private meshObject: THREE.Mesh | null = null;
  private backObject: THREE.Mesh | null = null;
  /** 前后两个 Mesh 共用同一份几何；只在这里持有并释放一次 */
  private baseGeometry: THREE.BufferGeometry | null = null;
  private graph: MeshGraph | null = null;
  private pickEdges: HitEdge[] = [];
  private overlayGeometry: BufferGeometrySet | null = null;
  private previewObject: THREE.Mesh | null = null;
  private pointsA: THREE.Points | null = null;
  private pointsB: THREE.Points | null = null;
  private readonly resizeObserver: ResizeObserver;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private disposed = false;
  private frameId = 0;
  private overlay: OverlayState = EMPTY_OVERLAY;
  private readonly lineMaterials: LineMaterial[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(0x14181e, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x14181e);
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.001, 5000);
    this.camera.position.set(2.4, 2.2, 3.0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.target.set(0, 0, 0);

    const hemi = new THREE.HemisphereLight(0xdbe7ff, 0x2b3038, 1.35);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(3, 6, 4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.7);
    fill.position.set(-4, -2, -3);
    this.scene.add(fill);

    const grid = new THREE.GridHelper(10, 20, 0x2c3440, 0x222830);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    this.scene.add(grid);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.animate();
  }

  private animate = () => {
    if (this.disposed) return;
    this.frameId = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.baseGeometry?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    for (const m of this.lineMaterials) m.resolution.set(width, height);
  }

  setMesh(mesh: MeshData, graph: MeshGraph, fit = false): void {
    this.clearMesh();
    this.graph = graph;
    this.overlay = { ...EMPTY_OVERLAY };
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
    geometry.setIndex(mesh.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    this.baseGeometry = geometry;

    const front = new THREE.MeshStandardMaterial({
      color: COLORS.front,
      metalness: 0.05,
      roughness: 0.82,
      flatShading: true,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const back = new THREE.MeshStandardMaterial({
      color: COLORS.back,
      metalness: 0,
      roughness: 0.95,
      flatShading: true,
      side: THREE.BackSide,
    });
    const meshObject = new THREE.Mesh(geometry, front);
    meshObject.name = 'base-front';
    const backObject = new THREE.Mesh(geometry, back);
    backObject.name = 'base-back';
    backObject.renderOrder = -1;
    this.scene.add(meshObject);
    this.scene.add(backObject);
    this.meshObject = meshObject;
    this.backObject = backObject;

    this.rebuildPickEdges(graph);
    this.ensureOverlayLayers();
    this.applyOverlay();
    if (fit) this.fitCamera(mesh);
  }

  /**
   * 缓存所有边用于屏幕空间拾取。
   * 本工具面向小网格；上限只是防止误导入超大模型时卡死交互。
   */
  private rebuildPickEdges(graph: MeshGraph): void {
    this.pickEdges = [];
    const max = 60000;
    for (const e of graph.edges.values()) {
      this.pickEdges.push({ key: edgeKey(e.a, e.b), a: e.a, b: e.b });
      if (this.pickEdges.length >= max) break;
    }
  }

  clearMesh(): void {
    // 基础网格前后两个 Mesh 共用 baseGeometry，只在下面统一释放一次
    for (const obj of [this.meshObject, this.backObject]) {
      if (!obj) continue;
      this.scene.remove(obj);
      const mat = obj.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
    for (const obj of [this.previewObject, this.pointsA, this.pointsB]) {
      if (!obj) continue;
      this.scene.remove(obj);
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
    this.meshObject = null;
    this.backObject = null;
    this.previewObject = null;
    this.pointsA = null;
    this.pointsB = null;
    this.baseGeometry?.dispose();
    this.baseGeometry = null;
    if (this.overlayGeometry) {
      this.overlayGeometry.disposeAll();
      this.overlayGeometry = null;
    }
  }

  private ensureOverlayLayers(): void {
    if (this.overlayGeometry) return;
    const res = new THREE.Vector2(this.container.clientWidth, this.container.clientHeight);
    const mk = (color: number, opacity = 1): LineMaterial => {
      const m = new LineMaterial({
        color,
        linewidth: 2.5,
        transparent: opacity < 1,
        opacity,
        depthTest: false,
      });
      m.resolution.copy(res);
      this.lineMaterials.push(m);
      return m;
    };
    const entries: [keyof Omit<BufferGeometrySet, 'disposeAll'>, LineMaterial, number][] = [
      ['boundary', mk(COLORS.boundary), 5],
      ['nonManifold', mk(COLORS.nonManifold), 6],
      ['orientation', mk(COLORS.orientation), 7],
      ['candidate', mk(COLORS.candidate, 0.85), 3],
      ['preserved', mk(COLORS.preserved, 0.9), 4],
      ['chainA', mk(COLORS.chainA), 9],
      ['chainB', mk(COLORS.chainB), 9],
      ['inspected', mk(COLORS.inspected), 10],
      ['pair', mk(COLORS.pair), 8],
    ];
    const layers = {} as BufferGeometrySet;
    for (const [name, material, order] of entries) {
      layers[name] = this.makeLineLayer(material, order);
    }
    layers.disposeAll = () => {
      for (const [name] of entries) {
        const line = layers[name];
        this.scene.remove(line);
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      }
      // 材质已释放，引用也要清掉，避免分辨率更新时触碰已释放对象
      this.lineMaterials.length = 0;
    };
    this.overlayGeometry = layers;
  }

  private makeLineLayer(material: LineMaterial, renderOrder: number): LineSegments2 {
    const geo = new LineSegmentsGeometry();
    const line = new LineSegments2(geo, material);
    line.renderOrder = renderOrder;
    line.frustumCulled = false;
    (line as unknown as { raycast: () => void }).raycast = () => {
      // 边拾取由屏幕空间距离实现，不参与 raycaster
    };
    this.scene.add(line);
    return line;
  }

  setOverlay(partial: Partial<OverlayState>): void {
    this.overlay = { ...this.overlay, ...partial };
    this.applyOverlay();
  }

  resetOverlay(): void {
    this.overlay = { ...EMPTY_OVERLAY };
    this.applyOverlay();
  }

  private applyOverlay(): void {
    if (!this.overlayGeometry || !this.graph) return;
    const g = this.graph;
    const lines = (keys: string[]): Float32Array => {
      const out: number[] = [];
      for (const k of keys) {
        const [a, b] = k.split('_').map(Number);
        const pa = g.points[a];
        const pb = g.points[b];
        if (!pa || !pb) continue;
        out.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
      }
      return new Float32Array(out);
    };
    const layer = (line: LineSegments2, keys: string[]) => {
      const arr = lines(keys);
      if (arr.length === 0) {
        line.visible = false;
        return;
      }
      line.visible = true;
      line.geometry.setPositions(arr);
      line.geometry.computeBoundingSphere();
    };
    layer(this.overlayGeometry.boundary, this.overlay.boundaryEdges);
    layer(this.overlayGeometry.nonManifold, this.overlay.nonManifoldEdges);
    layer(this.overlayGeometry.orientation, this.overlay.orientationEdges);
    layer(this.overlayGeometry.candidate, this.overlay.candidateEdges);
    layer(this.overlayGeometry.preserved, this.overlay.preservedEdges);
    layer(this.overlayGeometry.chainA, this.overlay.chainAEdges);
    layer(this.overlayGeometry.chainB, this.overlay.chainBEdges);
    layer(this.overlayGeometry.inspected, this.overlay.inspectedEdges);
    const pairPositions: number[] = [];
    for (const [a, b] of this.overlay.pairSegments) {
      const pa = g.points[a];
      const pb = g.points[b];
      if (!pa || !pb) continue;
      pairPositions.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
    }
    if (pairPositions.length) {
      this.overlayGeometry.pair.visible = true;
      this.overlayGeometry.pair.geometry.setPositions(new Float32Array(pairPositions));
      this.overlayGeometry.pair.geometry.computeBoundingSphere();
    } else {
      this.overlayGeometry.pair.visible = false;
    }

    this.updatePointLayer('A', this.overlay.chainAVertices, 0x35d6ff);
    this.updatePointLayer('B', this.overlay.chainBVertices, 0xffe14d);
    this.updatePreviewFaces(this.overlay.previewFaces);
  }

  private updatePointLayer(which: 'A' | 'B', vertices: number[], color: number): void {
    const g = this.graph;
    if (!g) return;
    let obj = which === 'A' ? this.pointsA : this.pointsB;
    if (obj) {
      this.scene.remove(obj);
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
      obj = null;
    }
    if (vertices.length === 0) {
      if (which === 'A') this.pointsA = null;
      else this.pointsB = null;
      return;
    }
    const arr = new Float32Array(vertices.length * 3);
    vertices.forEach((v, i) => {
      const p = g.points[v];
      arr[i * 3] = p.x;
      arr[i * 3 + 1] = p.y;
      arr[i * 3 + 2] = p.z;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const material = new THREE.PointsMaterial({
      color,
      size: 9,
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    const points = new THREE.Points(geometry, material);
    points.renderOrder = 11;
    points.frustumCulled = false;
    this.scene.add(points);
    if (which === 'A') this.pointsA = points;
    else this.pointsB = points;
  }

  private updatePreviewFaces(faces: number[]): void {
    if (this.previewObject) {
      this.scene.remove(this.previewObject);
      this.previewObject.geometry.dispose();
      (this.previewObject.material as THREE.Material).dispose();
      this.previewObject = null;
    }
    const g = this.graph;
    if (!g || faces.length === 0) return;
    const positions: number[] = [];
    for (const f of faces) {
      const a = g.points[g.indices[f * 3]];
      const b = g.points[g.indices[f * 3 + 1]];
      const c = g.points[g.indices[f * 3 + 2]];
      if (!a || !b || !c) continue;
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
    if (positions.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshBasicMaterial({
      color: COLORS.preview,
      transparent: true,
      opacity: 0.24,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 12;
    this.scene.add(mesh);
    this.previewObject = mesh;
  }

  /**
   * 屏幕坐标拾取最近的边，返回 key 与屏幕距离。
   * 屏幕距离相近时优先选择更靠近相机的边，避免点到背面的重合投影。
   */
  pickEdge(clientX: number, clientY: number, maxPx = 8): { key: string; distance: number; depth: number } | null {
    const g = this.graph;
    if (!g) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let best: { key: string; distance: number; depth: number } | null = null;
    const tmp = new THREE.Vector3();
    const a2 = new THREE.Vector2();
    const b2 = new THREE.Vector2();
    for (const e of this.pickEdges) {
      const pa = g.points[e.a];
      const pb = g.points[e.b];
      if (!pa || !pb) continue;
      tmp.set(pa.x, pa.y, pa.z).project(this.camera);
      if (tmp.z < -1 || tmp.z > 1) continue;
      const depthA = tmp.z;
      a2.set(((tmp.x + 1) / 2) * rect.width, ((1 - tmp.y) / 2) * rect.height);
      tmp.set(pb.x, pb.y, pb.z).project(this.camera);
      if (tmp.z < -1 || tmp.z > 1) continue;
      const depth = (depthA + tmp.z) / 2;
      b2.set(((tmp.x + 1) / 2) * rect.width, ((1 - tmp.y) / 2) * rect.height);
      const d = distanceToSegment(px, py, a2.x, a2.y, b2.x, b2.y);
      if (d > maxPx) continue;
      if (
        !best ||
        d < best.distance - 1.5 ||
        (Math.abs(d - best.distance) <= 1.5 && depth < best.depth)
      ) {
        best = { key: e.key, distance: d, depth };
      }
    }
    return best;
  }

  /** 屏幕矩形内的边：两个端点都投影在矩形内。 */
  edgesInScreenRect(left: number, top: number, right: number, bottom: number): string[] {
    const g = this.graph;
    if (!g) return [];
    const rect = this.renderer.domElement.getBoundingClientRect();
    const l = Math.min(left, right) - rect.left;
    const r = Math.max(left, right) - rect.left;
    const t = Math.min(top, bottom) - rect.top;
    const b = Math.max(top, bottom) - rect.top;
    const tmp = new THREE.Vector3();
    const inside = (v: number): boolean => {
      const p = g.points[v];
      if (!p) return false;
      tmp.set(p.x, p.y, p.z).project(this.camera);
      if (tmp.z < -1 || tmp.z > 1) return false;
      const sx = ((tmp.x + 1) / 2) * rect.width;
      const sy = ((1 - tmp.y) / 2) * rect.height;
      return sx >= l && sx <= r && sy >= t && sy <= b;
    };
    const out: string[] = [];
    for (const e of this.pickEdges) {
      if (inside(e.a) && inside(e.b)) out.push(e.key);
    }
    return out;
  }

  /** 用于框选后区分层级：把每个顶点投影到屏幕，返回屏幕矩形内的边界链顶点。 */
  projectVertex(v: number): { x: number; y: number } | null {
    const g = this.graph;
    if (!g) return null;
    const p = g.points[v];
    if (!p) return null;
    const tmp = new THREE.Vector3(p.x, p.y, p.z).project(this.camera);
    if (tmp.z < -1 || tmp.z > 1) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: ((tmp.x + 1) / 2) * rect.width + rect.left,
      y: ((1 - tmp.y) / 2) * rect.height + rect.top,
    };
  }

  pickFace(clientX: number, clientY: number): { face: number } | null {
    if (!this.meshObject) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.meshObject, false);
    if (hits.length === 0 || hits[0].faceIndex === undefined || hits[0].faceIndex === null) return null;
    return { face: hits[0].faceIndex };
  }

  fitCamera(mesh: MeshData): void {
    const b = meshBounds(mesh);
    const radius = Math.max(b.radius, 0.05);
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 1.15;
    const dir = new THREE.Vector3(0.85, 0.65, 1).normalize();
    this.camera.position.copy(new THREE.Vector3(b.center.x, b.center.y, b.center.z).addScaledVector(dir, dist));
    this.camera.near = Math.max(dist / 1000, 0.0005);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(b.center.x, b.center.y, b.center.z);
    this.controls.update();
  }

  focusOn(points: Vec3[]): void {
    if (points.length === 0) return;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of points) {
      cx += p.x;
      cy += p.y;
      cz += p.z;
    }
    cx /= points.length;
    cy /= points.length;
    cz /= points.length;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = Math.max(this.camera.position.distanceTo(this.controls.target) * 0.55, 0.08);
    this.controls.target.set(cx, cy, cz);
    this.camera.position.copy(new THREE.Vector3(cx, cy, cz).addScaledVector(dir, dist));
    this.controls.update();
  }

  /** 框选模式下关闭旋转，避免拖拽同时转动相机。 */
  setRotateEnabled(enabled: boolean): void {
    this.controls.enableRotate = enabled;
  }

  getResolution(): { width: number; height: number } {
    return { width: this.container.clientWidth, height: this.container.clientHeight };
  }
}

interface BufferGeometrySet {
  boundary: LineSegments2;
  nonManifold: LineSegments2;
  orientation: LineSegments2;
  candidate: LineSegments2;
  preserved: LineSegments2;
  chainA: LineSegments2;
  chainB: LineSegments2;
  inspected: LineSegments2;
  pair: LineSegments2;
  disposeAll(): void;
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
