/**
 * Three.js 场景装配与走带循环。
 * 几何重建策略：buildBelt 失败时保留上一次有效带路（带子、滚轮、标记全部不动），
 * 仅叠加失效位置的虚线提示与冲突信息；成功后整体重建并按相对位置重映射标记。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildBelt, sampleAt, type BeltPath, type Conflict, type Pulley } from '../math/belt';
import { generateMarkers, remapMarkers, selectMarker, selectedDistanceToSeam, type MarkerSet } from '../math/markers';
import { makeBeltTexture } from './textures';
import { buildRibbon, buildPulley, buildContactArc, BELT_WIDTH } from './beltMesh';
import { buildMarkerObjects, buildSeamObject, type MarkerObjects } from './markers3D';
import { DEFAULT_SPACING } from '../state/presets';

export interface SceneStatus {
  ok: boolean;
  conflicts: Conflict[];
  length: number;
  spacing: number;
  distanceToSeam: number | null;
  selectedLabel: number | null;
  phase: number;
  speed: number;
  contacts: { pulley: number; wrapDeg: number }[];
}

export class BeltScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  private beltRoot = new THREE.Group();
  private pulleyRoot = new THREE.Group();
  private ghostRoot = new THREE.Group();

  private path: BeltPath | null = null;
  private markerSet: MarkerSet | null = null;
  private markerObjects: MarkerObjects | null = null;
  private seamUpdate: ((phase: number) => void) | null = null;
  private beltTexture: THREE.CanvasTexture | null = null;
  private pulleyGroups: THREE.Group[] = [];

  private spacing = DEFAULT_SPACING;
  private phase = 0;
  private speed = 1.2;
  private running = true;
  private direction = 1;
  private clock = new THREE.Clock();
  private raf = 0;
  private disposed = false;

  readonly onStatus: (s: SceneStatus) => void;
  private conflict: Conflict[] = [];

  constructor(container: HTMLElement, onStatus: (s: SceneStatus) => void) {
    this.onStatus = onStatus;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setClearColor(0x14171d);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 200);
    // 3/4 视角：既看得到整圈带路轮廓，也看得到带的宽度与外表面纹理
    this.camera.position.set(0, -11, 15);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0.4, 0);

    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(6, -8, 12);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.6);
    rim.position.set(-6, 6, -8);
    this.scene.add(ambient, key, rim);

    const grid = new THREE.GridHelper(24, 24, 0x39404d, 0x232833);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -BELT_WIDTH * 0.7;
    this.scene.add(grid);

    this.scene.add(this.beltRoot, this.pulleyRoot, this.ghostRoot);

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('resize', this.onResize);
    this.loop();
  }

  /** 几何变更入口：成功则重建，失败则保留上次有效结果 */
  rebuild(pulleys: Pulley[]): void {
    const result = buildBelt(pulleys);

    if (!result.ok || !result.path) {
      this.conflict = result.conflicts;
      this.updateGhost(pulleys);
      this.emitStatus();
      return;
    }

    this.conflict = [];
    this.clearGhost();

    const prevLength = this.path?.length ?? null;
    const prevSet = this.markerSet;
    this.path = result.path;

    if (prevSet && prevLength !== null) {
      this.markerSet = remapMarkers(prevSet, this.path.length, this.spacing);
    } else {
      this.markerSet = generateMarkers(this.path.length, this.spacing, 0);
    }

    this.clearBeltObjects();
    this.buildSceneObjects(this.path, this.markerSet);
    this.emitStatus();
  }

  private buildSceneObjects(path: BeltPath, set: MarkerSet) {
    this.beltTexture?.dispose();
    this.beltTexture = makeBeltTexture(path.length, this.spacing);
    this.beltTexture.offset.x = -this.phase / path.length;

    const ribbon = buildRibbon(path, this.beltTexture);
    this.beltRoot.add(ribbon);

    this.markerObjects?.dispose();
    this.markerObjects = buildMarkerObjects(path, set);
    this.beltRoot.add(this.markerObjects.group);

    const seam = buildSeamObject(path);
    this.seamUpdate = seam.update;
    this.beltRoot.add(seam.mesh);

    this.pulleyRoot.clear();
    this.pulleyGroups = path.pulleys.map((p, i) => buildPulley(p, i));
    for (const g of this.pulleyGroups) this.pulleyRoot.add(g);

    this.beltRoot.add(buildContactArc(path));
  }

  private clearBeltObjects() {
    this.markerObjects?.dispose();
    this.markerObjects = null;
    for (const root of [this.beltRoot, this.pulleyRoot]) {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
    }
    this.beltRoot.clear();
    this.pulleyRoot.clear();
    this.pulleyGroups = [];
    this.seamUpdate = null;
  }

  private updateGhost(pulleys: Pulley[]) {
    this.clearGhost();
    // 当前（失效）位置：红色圆，关闭深度测试保证被旧几何遮挡时仍可见
    const bad = pulleys[1];
    if (bad) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(bad.radius * 0.94, bad.radius, 72),
        new THREE.MeshBasicMaterial({
          color: 0xff4d4d,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.95,
          depthTest: false,
        }),
      );
      ring.position.set(bad.center.x, bad.center.y, 0);
      ring.renderOrder = 999;
      this.ghostRoot.add(ring);
    }
    // 上次有效位置：黄色虚线整圆（提到轮面之前）
    if (this.path) {
      const good = this.path.pulleys[1];
      const pts: THREE.Vector3[] = [];
      const n = 96;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        pts.push(
          new THREE.Vector3(
            good.center.x + good.radius * Math.cos(a),
            good.center.y + good.radius * Math.sin(a),
            BELT_WIDTH * 0.66,
          ),
        );
      }
      const line = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineDashedMaterial({
          color: 0xffd23f,
          dashSize: 0.22,
          gapSize: 0.14,
          depthTest: false,
        }),
      );
      line.computeLineDistances();
      line.renderOrder = 999;
      this.ghostRoot.add(line);
    }
  }

  private clearGhost() {
    this.ghostRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | undefined;
      mat?.dispose();
    });
    this.ghostRoot.clear();
  }

  // ---------- 走带控制 ----------

  setRunning(r: boolean) {
    this.running = r;
    this.emitStatus();
  }
  isRunning() {
    return this.running;
  }
  setDirection(d: 1 | -1) {
    this.direction = d;
    this.emitStatus();
  }
  getDirection() {
    return this.direction;
  }
  setSpeed(v: number) {
    this.speed = v;
    this.emitStatus();
  }
  getSpeed() {
    return this.speed;
  }
  getPhase() {
    return this.phase;
  }

  /** 单步走一个小距离（单位：世界弧长），方向取当前方向 */
  step(distance: number) {
    this.advance(this.direction * distance);
  }

  setSpacing(v: number) {
    if (!this.path || !this.markerSet) return;
    this.spacing = v;
    this.markerSet = generateMarkers(this.path.length, v, this.markerSet.selectedLabel);
    this.clearBeltObjects();
    this.buildSceneObjects(this.path, this.markerSet);
    this.emitStatus();
  }

  getSpacing() {
    return this.spacing;
  }

  selectByLabel(label: number | null) {
    if (!this.markerSet || !this.path) return;
    this.markerSet = selectMarker(this.markerSet, label);
    this.clearBeltObjects();
    this.buildSceneObjects(this.path, this.markerSet);
    this.emitStatus();
  }

  getSelectedLabel() {
    return this.markerSet?.selectedLabel ?? null;
  }

  /** 镜头平滑转到选中刻度；找不到选中项时返回 false */
  focusSelected(): boolean {
    if (!this.path || !this.markerSet || this.markerSet.selectedLabel === null) return false;
    const sel = this.markerSet.markers.find((m) => m.selected);
    if (!sel) return false;
    const L = this.path.length;
    const ws = (((sel.s + this.phase) % L) + L) % L;
    const smp = sampleAt(this.path, ws);
    const target = new THREE.Vector3(smp.p.x, smp.p.y, 0);
    this.animateCameraTarget(target);
    return true;
  }

  private cameraAnim: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
  private animateCameraTarget(to: THREE.Vector3) {
    this.cameraAnim = { from: this.controls.target.clone(), to, t: 0 };
  }

  private advance(ds: number) {
    if (!this.path || !this.beltTexture || !this.markerObjects) return;
    const L = this.path.length;
    this.phase = (((this.phase + ds) % L) + L) % L;
    this.beltTexture.offset.x = -this.phase / L;
    this.markerObjects.update(this.phase);
    this.seamUpdate?.(this.phase);
    this.updatePulleyRotation(ds);
    this.emitStatus();
  }

  private updatePulleyRotation(ds: number) {
    if (!this.path) return;
    for (const g of this.pulleyGroups) {
      const r = g.userData.radius as number;
      // 带沿外轮廓移动 ds，轮面线速度同向：顺时针转角为 ds / r
      g.rotation.z -= ds / r;
    }
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.running && this.path) {
      this.advance(this.direction * this.speed * dt);
    }
    if (this.cameraAnim) {
      this.cameraAnim.t = Math.min(1, this.cameraAnim.t + dt * 2.2);
      const k = easeInOut(this.cameraAnim.t);
      this.controls.target.lerpVectors(this.cameraAnim.from, this.cameraAnim.to, k);
      if (this.cameraAnim.t >= 1) this.cameraAnim = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  // ---------- 拾取 ----------

  private onPointerDown = (e: PointerEvent) => {
    if (!this.markerObjects || e.button !== 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.markerObjects.pickables, false);
    if (hits.length > 0) {
      const label = hits[0].object.userData.label as number;
      this.selectByLabel(label);
    }
  };

  private onResize = () => {
    const container = this.renderer.domElement.parentElement;
    if (!container) return;
    this.camera.aspect = container.clientWidth / container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(container.clientWidth, container.clientHeight);
  };

  private emitStatus() {
    const distance = this.path && this.markerSet ? selectedDistanceToSeam(this.markerSet, this.phase) : null;
    this.onStatus({
      ok: this.conflict.length === 0 && !!this.path,
      conflicts: this.conflict,
      length: this.path?.length ?? 0,
      spacing: this.spacing,
      distanceToSeam: distance,
      selectedLabel: this.markerSet?.selectedLabel ?? null,
      phase: this.phase,
      speed: this.speed,
      contacts:
        this.path?.contacts.map((c) => ({ pulley: c.pulley, wrapDeg: (c.wrap * 180) / Math.PI })) ?? [],
    });
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('resize', this.onResize);
    this.clearBeltObjects();
    this.clearGhost();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}
