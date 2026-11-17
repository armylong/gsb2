/**
 * 单个二维视图：three.js 正交相机 + 自定义缩放/平移。
 * 几何全部在世界坐标（场景单位）中构建，缩放只改相机 zoom，
 * 因此笔画/端帽/转角/虚线在任何缩放下保持相同比例，不会重新分段。
 */
import * as THREE from 'three';
import { Vec2 } from '../core/math2d';
import { StrokeMeshData } from '../core/mesh';
import { PolyPath } from '../core/path';

export interface ViewDisplay {
  showFill: boolean;
  showWire: boolean;
  showCenter: boolean;
  showVertices: boolean;
}

export interface ViewCallbacks {
  /** 命中顶点：返回该顶点在 points 中的下标，未命中返回 -1 */
  pickVertex: (world: Vec2) => number;
  onAddPoint: (world: Vec2) => void;
  onMoveVertex: (index: number, world: Vec2) => void;
  onDeleteVertex: (index: number) => void;
  onDragStateChange: (dragging: boolean) => void;
}

export class StrokeView2D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  private container: HTMLElement;
  private cb: ViewCallbacks;

  private gridObj: THREE.LineSegments | null = null;
  private fillMesh: THREE.Mesh | null = null;
  private wireObj: THREE.LineSegments | null = null;
  private centerLine: THREE.Line | null = null;
  private vertexGroup = new THREE.Group();

  private viewHeight = 12;
  private dragging: null | { kind: 'pan' | 'vertex' | 'idle'; index: number; startX: number; startY: number; camX: number; camY: number } = null;
  private downPos: { x: number; y: number; world: Vec2 } | null = null;
  private moved = false;
  private resizeObs: ResizeObserver;
  private vertexRingGeo: THREE.RingGeometry;
  private firstVertexGeo: THREE.RingGeometry;
  onCameraChange?: () => void;

  constructor(container: HTMLElement, cb: ViewCallbacks) {
    this.container = container;
    this.cb = cb;
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x10131a, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';

    const aspect = w / h;
    this.camera = new THREE.OrthographicCamera(
      (-this.viewHeight * aspect) / 2, (this.viewHeight * aspect) / 2,
      this.viewHeight / 2, -this.viewHeight / 2, -100, 100,
    );
    this.camera.position.set(0, 0, 10);
    this.camera.zoom = 1;

    this.scene.add(this.vertexGroup);
    this.vertexRingGeo = new THREE.RingGeometry(0.11, 0.17, 24);
    this.firstVertexGeo = new THREE.RingGeometry(0.16, 0.22, 24);

    this.bindEvents();
    this.rebuildGrid();

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
  }

  // ---------- 坐标换算 ----------
  screenToWorld(clientX: number, clientY: number): Vec2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
    return {
      x: (ndcX * this.camera.right) / this.camera.zoom + this.camera.position.x,
      y: (ndcY * this.camera.top) / this.camera.zoom + this.camera.position.y,
    };
  }

  /** 屏幕像素对应的世界长度（用于拾取容差，随缩放自适应） */
  pixelsToWorld(px: number): number {
    return (px * this.viewHeight) / (this.container.clientHeight * this.camera.zoom);
  }

  get zoomLevel(): number {
    return this.camera.zoom;
  }

  // ---------- 相机 ----------
  fitTo(points: Vec2[], padding = 2): void {
    if (points.length === 0) { this.camera.zoom = 1; this.camera.position.set(0, 0, 10); this.update(); return; }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const w = Math.max(maxX - minX, 1) + padding * 2;
    const h = Math.max(maxY - minY, 1) + padding * 2;
    const aspect = this.container.clientWidth / this.container.clientHeight;
    this.viewHeight = Math.max(h, w / aspect);
    this.camera.position.set((minX + maxX) / 2, (minY + maxY) / 2, 10);
    this.camera.zoom = 1;
    this.applyFrustum();
  }

  setCameraState(x: number, y: number, zoom: number, viewHeight: number): void {
    this.camera.position.set(x, y, 10);
    this.camera.zoom = zoom;
    this.viewHeight = viewHeight;
    this.applyFrustum();
  }

  getCameraState() {
    return { x: this.camera.position.x, y: this.camera.position.y, zoom: this.camera.zoom, viewHeight: this.viewHeight };
  }

  private applyFrustum(): void {
    const aspect = this.container.clientWidth / this.container.clientHeight;
    const halfH = this.viewHeight / 2;
    this.camera.left = -halfH * aspect;
    this.camera.right = halfH * aspect;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
    this.rebuildGrid();
    this.onCameraChange?.();
  }

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.applyFrustum();
    this.update();
  }

  private rebuildGrid(): void {
    if (this.gridObj) {
      this.scene.remove(this.gridObj);
      this.gridObj.geometry.dispose();
      (this.gridObj.material as THREE.Material).dispose();
    }
    const halfW = (this.camera.right - this.camera.left) / (2 * this.camera.zoom);
    const halfH = (this.camera.top - this.camera.bottom) / (2 * this.camera.zoom);
    const cx = this.camera.position.x;
    const cy = this.camera.position.y;
    const x0 = Math.floor(cx - halfW - 1);
    const x1 = Math.ceil(cx + halfW + 1);
    const y0 = Math.floor(cy - halfH - 1);
    const y1 = Math.ceil(cy + halfH + 1);
    const positions: number[] = [];
    const colors: number[] = [];
    const cMinor = new THREE.Color(0x1d2433);
    const cMajor = new THREE.Color(0x2c3850);
    for (let x = x0; x <= x1; x++) {
      positions.push(x, y0, -5, x, y1, -5);
      const c = x % 5 === 0 ? cMajor : cMinor;
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    for (let y = y0; y <= y1; y++) {
      positions.push(x0, y, -5, x1, y, -5);
      const c = y % 5 === 0 ? cMajor : cMinor;
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.gridObj = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
    this.scene.add(this.gridObj);
  }

  // ---------- 内容更新 ----------
  setStroke(mesh: StrokeMeshData | null, display: ViewDisplay): void {
    if (this.fillMesh) {
      this.scene.remove(this.fillMesh);
      this.fillMesh.geometry.dispose();
      (this.fillMesh.material as THREE.Material).dispose();
      this.fillMesh = null;
    }
    if (this.wireObj) {
      this.scene.remove(this.wireObj);
      this.wireObj.geometry.dispose();
      (this.wireObj.material as THREE.Material).dispose();
      this.wireObj = null;
    }
    if (!mesh) { this.update(); return; }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geo.computeVertexNormals();

    this.fillMesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0x4ea1ff, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
    );
    this.fillMesh.visible = display.showFill;
    this.scene.add(this.fillMesh);

    // 直接由三角形索引生成边，保证看到的是真实三角形剖分而不是多边形轮廓
    const edges = this.collectTriangleEdges(mesh.indices);
    const wirePos: number[] = [];
    for (const [a, b] of edges) {
      wirePos.push(mesh.positions[a * 3], mesh.positions[a * 3 + 1], 0.01);
      wirePos.push(mesh.positions[b * 3], mesh.positions[b * 3 + 1], 0.01);
    }
    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(wirePos, 3));
    this.wireObj = new THREE.LineSegments(
      wireGeo,
      new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.95 }),
    );
    this.wireObj.visible = display.showWire;
    this.scene.add(this.wireObj);
    this.update();
  }

  private collectTriangleEdges(indices: Uint32Array): [number, number][] {
    const set = new Set<number>();
    const out: [number, number][] = [];
    const key = (a: number, b: number) => (a < b ? a * 1000003 + b : b * 1000003 + a);
    for (let i = 0; i < indices.length; i += 3) {
      const tri = [indices[i], indices[i + 1], indices[i + 2]];
      for (let e = 0; e < 3; e++) {
        const a = tri[e];
        const b = tri[(e + 1) % 3];
        const k = key(a, b);
        if (!set.has(k)) { set.add(k); out.push([a, b]); }
      }
    }
    return out;
  }

  setCenterline(path: PolyPath, visible: boolean): void {
    if (this.centerLine) {
      this.scene.remove(this.centerLine);
      this.centerLine.geometry.dispose();
      (this.centerLine.material as THREE.Material).dispose();
    }
    const pos: number[] = [];
    for (const p of path.points) pos.push(p.x, p.y, 0.02);
    if (path.closed && path.points.length > 2) {
      pos.push(path.points[0].x, path.points[0].y, 0.02);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.centerLine = new THREE.Line(
      geo,
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.25, gapSize: 0.15, transparent: true, opacity: 0.75 }),
    );
    this.centerLine.computeLineDistances();
    this.centerLine.visible = visible;
    this.scene.add(this.centerLine);
    this.update();
  }

  setVertices(points: Vec2[], visible: boolean, closed: boolean): void {
    this.vertexGroup.clear();
    this.vertexGroup.visible = visible;
    points.forEach((p, i) => {
      const isFirst = i === 0;
      const mat = new THREE.MeshBasicMaterial({
        color: isFirst ? 0xff7a59 : 0x9ad8ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.95,
      });
      const ring = new THREE.Mesh(isFirst ? this.firstVertexGeo : this.vertexRingGeo, mat);
      ring.position.set(p.x, p.y, 0.05);
      ring.userData.vertexIndex = i;
      this.vertexGroup.add(ring);
      if (closed && i === points.length - 1) {
        // 末点在闭合时与首点同角色，用同色小环提示
      }
    });
    this.update();
  }

  setDisplay(display: ViewDisplay): void {
    if (this.fillMesh) this.fillMesh.visible = display.showFill;
    if (this.wireObj) this.wireObj.visible = display.showWire;
    if (this.centerLine) this.centerLine.visible = display.showCenter;
    this.vertexGroup.visible = display.showVertices;
    this.update();
  }

  // ---------- 交互 ----------
  private bindEvents(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    el.addEventListener('dblclick', (e) => {
      const world = this.screenToWorld(e.clientX, e.clientY);
      const idx = this.cb.pickVertex(world);
      if (idx >= 0) this.cb.onDeleteVertex(idx);
    });
    el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onPointerDown(e: PointerEvent): void {
    this.renderer.domElement.setPointerCapture?.(e.pointerId);
    const world = this.screenToWorld(e.clientX, e.clientY);
    this.downPos = { x: e.clientX, y: e.clientY, world };
    this.moved = false;
    if (e.button === 1 || e.button === 2) {
      this.dragging = { kind: 'pan', index: -1, startX: e.clientX, startY: e.clientY, camX: this.camera.position.x, camY: this.camera.position.y };
      return;
    }
    if (e.button === 0) {
      const idx = this.cb.pickVertex(world);
      if (idx >= 0) {
        this.dragging = { kind: 'vertex', index: idx, startX: e.clientX, startY: e.clientY, camX: 0, camY: 0 };
        this.cb.onDragStateChange(true);
      } else {
        // 空白按下：记录为 idle，抬起时若未移动则在此处添加顶点
        this.dragging = { kind: 'idle', index: -1, startX: e.clientX, startY: e.clientY, camX: 0, camY: 0 };
      }
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragging) return;
    const dxPx = e.clientX - (this.downPos?.x ?? e.clientX);
    const dyPx = e.clientY - (this.downPos?.y ?? e.clientY);
    if (Math.hypot(dxPx, dyPx) > 3) this.moved = true;

    if (this.dragging.kind === 'pan') {
      const rect = this.renderer.domElement.getBoundingClientRect();
      const wx = (dxPx * this.viewHeight) / (rect.height * this.camera.zoom);
      const wy = -(dyPx * this.viewHeight) / (rect.height * this.camera.zoom);
      this.camera.position.set(this.dragging.camX - wx, this.dragging.camY - wy, 10);
      this.applyFrustum();
    } else if (this.dragging.kind === 'vertex') {
      const world = this.screenToWorld(e.clientX, e.clientY);
      this.cb.onMoveVertex(this.dragging.index, world);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.dragging) { this.downPos = null; return; }
    const wasDrag = this.dragging;
    this.dragging = null;
    if (wasDrag.kind === 'vertex') {
      this.cb.onDragStateChange(false);
    } else if (wasDrag.kind === 'idle' && !this.moved && this.downPos) {
      // 空白处单击（未拖动）：添加顶点
      const idx = this.cb.pickVertex(this.downPos.world);
      if (idx < 0) this.cb.onAddPoint(this.downPos.world);
    }
    this.downPos = null;
    void e;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const before = this.screenToWorld(e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * 0.0012);
    this.camera.zoom = Math.min(200, Math.max(0.05, this.camera.zoom * factor));
    this.camera.updateProjectionMatrix();
    const after = this.screenToWorld(e.clientX, e.clientY);
    this.camera.position.x += before.x - after.x;
    this.camera.position.y += before.y - after.y;
    this.applyFrustum();
  }

  update(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.resizeObs.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
