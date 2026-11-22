import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { LightRig, PointRig } from './lightRig';
import { MaterialPair } from './materials';
import { cloneParams, type ParamSet } from './params';
import { probe, type ProbeResult, type SurfaceKind, type SurfacePoint } from './probe';

RectAreaLightUniformsLib.init();

export type Side = 'A' | 'B';

interface Hit {
  sp: SurfacePoint;
}

const CYL_RADIUS = 0.35;
const CYL_HEIGHT = 1.1;
const PLATE_SIZE = 5;

export class SceneLab {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly orbit: OrbitControls;
  private readonly xform: TransformControls;
  private readonly xformHelper: THREE.Object3D;
  private readonly mats = new MaterialPair();
  private readonly cylinder: THREE.Mesh;
  private readonly plate: THREE.Mesh;
  private readonly ambient: THREE.AmbientLight;

  private readonly rigA = new LightRig();
  private readonly rigB = new LightRig();
  private readonly pointA = new PointRig();
  private readonly pointB = new PointRig();

  private paramsA: ParamSet;
  private paramsB: ParamSet;
  private activeSide: Side = 'A';
  private split = false;
  private cameraLocked = false;
  private exposure = 1;

  private marker: THREE.Group;
  private hit: Hit | null = null;
  private onProbeChange: (() => void) | null = null;
  private onTransformEnd: (() => void) | null = null;

  private readonly raycaster = new THREE.Raycaster();
  private pointerDownAt: [number, number] | null = null;
  private resizeObs: ResizeObserver;

  constructor(container: HTMLElement, params: ParamSet) {
    this.paramsA = cloneParams(params);
    this.paramsB = cloneParams(params);
    this.paramsB.width = 1.6; // 默认 B 侧给宽灯，方便直接对比

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.exposure;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      42,
      container.clientWidth / container.clientHeight,
      0.02,
      100,
    );
    this.camera.position.set(2.6, 2.0, 3.2);

    this.scene.background = new THREE.Color(0x101216);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.target.set(0, 0.45, 0);
    this.orbit.minDistance = 0.4;
    this.orbit.maxDistance = 12;
    // 镜头移动后探针的反射方向(wo)变了，需要刷新读数
    this.orbit.addEventListener('change', () => this.notifyProbe());

    // 被测物：左圆柱（粗糙金属）、右大平板（哑光）
    this.cylinder = new THREE.Mesh(
      new THREE.CylinderGeometry(CYL_RADIUS, CYL_RADIUS, CYL_HEIGHT, 64),
      this.mats.metal,
    );
    this.cylinder.position.set(-1.05, CYL_HEIGHT / 2, 0);
    this.cylinder.userData.kind = 'metal';

    this.plate = new THREE.Mesh(
      new THREE.BoxGeometry(PLATE_SIZE, 0.06, PLATE_SIZE),
      this.mats.plate,
    );
    this.plate.position.y = -0.03;
    this.plate.userData.kind = 'plate';

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.065;

    this.ambient = new THREE.AmbientLight(0xffffff, 0.06);

    this.scene.add(this.cylinder, this.plate, floor, this.ambient);
    this.scene.add(this.rigA.group, this.rigB.group);
    // 点光源独立挂在场景下，使用世界坐标，不随灯板组变换
    this.scene.add(this.pointA.light, this.pointB.light);

    // 探针标记：小圆球 + 法线环
    this.marker = new THREE.Group();
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.018, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff5d5d }),
    );
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.035, 0.045, 32),
      new THREE.MeshBasicMaterial({ color: 0xff5d5d, side: THREE.DoubleSide }),
    );
    this.marker.add(dot, ring);
    this.marker.visible = false;
    this.scene.add(this.marker);

    // 变换手柄：拖动灯板位置 / 旋转
    this.xform = new TransformControls(this.camera, this.renderer.domElement);
    this.xform.setSize(0.8);
    this.xform.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value && !this.cameraLocked;
      if (!e.value) this.onTransformEnd?.();
    });
    this.xform.addEventListener('objectChange', () => {
      const rig = this.activeRig();
      rig.writeBack(this.activeParams());
      this.notifyProbe();
    });
    this.xformHelper = this.xform.getHelper
      ? this.xform.getHelper()
      : (this.xform as unknown as THREE.Object3D);
    this.scene.add(this.xformHelper);
    this.attachXform();

    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => {
      this.pointerDownAt = [e.clientX, e.clientY];
    });
    dom.addEventListener('pointerup', (e) => {
      if (!this.pointerDownAt) return;
      const dx = e.clientX - this.pointerDownAt[0];
      const dy = e.clientY - this.pointerDownAt[1];
      this.pointerDownAt = null;
      if (dx * dx + dy * dy < 25 && !this.xform.dragging) this.pick(e);
    });

    this.resizeObs = new ResizeObserver(() => this.resize(container));
    this.resizeObs.observe(container);

    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------- 外部接口 ----------

  setProbeListener(fn: () => void): void {
    this.onProbeChange = fn;
  }

  setTransformEndListener(fn: () => void): void {
    this.onTransformEnd = fn;
  }

  getParams(side: Side): ParamSet {
    return side === 'A' ? this.paramsA : this.paramsB;
  }

  get active(): Side {
    return this.activeSide;
  }

  setActiveSide(side: Side): void {
    this.activeSide = side;
    this.attachXform();
    this.notifyProbe();
  }

  /** UI 推参数变更 */
  updateParams(side: Side, patch: Partial<ParamSet>): void {
    const target = side === 'A' ? this.paramsA : this.paramsB;
    Object.assign(target, patch);
    this.notifyProbe();
  }

  applyPreset(side: Side, preset: ParamSet): void {
    if (side === 'A') this.paramsA = cloneParams(preset);
    else this.paramsB = cloneParams(preset);
    this.attachXform();
    this.notifyProbe();
  }

  setTransformMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.xform.setMode(mode);
  }

  setSplit(on: boolean): void {
    this.split = on;
    this.attachXform();
  }

  setExposure(v: number): void {
    this.exposure = v;
    this.renderer.toneMappingExposure = v;
  }

  getExposure(): number {
    return this.exposure;
  }

  setCameraLocked(locked: boolean): void {
    this.cameraLocked = locked;
    this.orbit.enabled = !locked;
  }

  isCameraLocked(): boolean {
    return this.cameraLocked;
  }

  /** 复制当前侧全部参数到另一侧（用于先调好 A 再做 B 的变体） */
  copyToOtherSide(): void {
    const src = this.activeParams();
    const dst = this.activeSide === 'A' ? this.paramsB : this.paramsA;
    Object.assign(dst, cloneParams(src));
    this.notifyProbe();
  }

  hasProbe(): boolean {
    return this.hit !== null;
  }

  /** 测试/调试辅助：在平板指定世界 (x, z) 放置探针，法线 +Y */
  placeProbeOnPlate(x: number, z: number): void {
    const point = new THREE.Vector3(x, 0.001, z);
    const normal = new THREE.Vector3(0, 1, 0);
    this.hit = {
      sp: {
        point,
        normal,
        kind: 'plate',
        roughness: 0,
        metalness: 0,
        albedo: new THREE.Color(),
      },
    };
    this.marker.visible = true;
    this.marker.position.copy(point).addScaledVector(normal, 0.012);
    this.marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    this.notifyProbe();
  }

  clearProbe(): void {
    this.hit = null;
    this.marker.visible = false;
    this.notifyProbe();
  }

  /** 计算某一侧在探针点的亮度结果 */
  probeResult(side: Side): ProbeResult | null {
    if (!this.hit) return null;
    const p = side === 'A' ? this.paramsA : this.paramsB;
    const sp = this.surfacePointFor(p, this.hit.sp.kind, this.hit.sp.point, this.hit.sp.normal);
    const view = this.camera.position.clone().sub(sp.point).normalize();
    const rig = side === 'A' ? this.rigA : this.rigB;
    const pt = side === 'A' ? this.pointA : this.pointB;
    // 强制把当前参数同步到灯组并刷新世界矩阵，避免读到渲染帧之前的陈旧位姿
    rig.apply(p);
    pt.apply(p);
    rig.group.updateMatrixWorld(true);
    return probe(sp, view, rig, pt, p);
  }

  dispose(container: HTMLElement): void {
    this.resizeObs.disconnect();
    this.renderer.setAnimationLoop(null);
    this.xform.dispose();
    this.orbit.dispose();
    this.renderer.dispose();
    container.removeChild(this.renderer.domElement);
  }

  // ---------- 内部 ----------

  private activeRig(): LightRig {
    return this.activeSide === 'A' ? this.rigA : this.rigB;
  }

  private activeParams(): ParamSet {
    return this.activeSide === 'A' ? this.paramsA : this.paramsB;
  }

  private attachXform(): void {
    const rig = this.activeRig();
    this.xform.detach();
    this.xform.attach(rig.group);
    this.xform.showX = true;
    this.xform.showY = true;
    this.xform.showZ = true;
  }

  private surfacePointFor(
    p: ParamSet,
    kind: SurfaceKind,
    point: THREE.Vector3,
    normal: THREE.Vector3,
  ): SurfacePoint {
    const isMetal = kind === 'metal';
    return {
      point: point.clone(),
      normal: normal.clone(),
      kind,
      roughness: isMetal ? p.metalRoughness : p.plateRoughness,
      metalness: isMetal ? 1 : 0,
      albedo: new THREE.Color(isMetal ? p.metalColor : p.plateColor),
    };
  }

  private pick(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects([this.cylinder, this.plate], false);
    if (hits.length === 0) {
      this.clearProbe();
      return;
    }
    const h = hits[0];
    const normal = h.face
      ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize()
      : new THREE.Vector3(0, 1, 0);
    const kind: SurfaceKind = h.object.userData.kind as SurfaceKind;
    this.hit = {
      sp: {
        point: h.point.clone(),
        normal,
        kind,
        roughness: 0,
        metalness: kind === 'metal' ? 1 : 0,
        albedo: new THREE.Color(),
      },
    };
    this.marker.visible = true;
    this.marker.position.copy(h.point).addScaledVector(normal, 0.012);
    this.marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    this.notifyProbe();
  }

  private notifyProbe(): void {
    this.onProbeChange?.();
  }

  private applyLighting(p: ParamSet, rig: LightRig, pt: PointRig): void {
    this.ambient.intensity = p.ambient;
    rig.apply(p);
    pt.apply(p);
  }

  private frame(): void {
    this.orbit.update();
    const w = this.renderer.domElement.width;
    const h = this.renderer.domElement.height;
    this.renderer.toneMappingExposure = this.exposure;

    if (!this.split) {
      const p = this.activeParams();
      const pt = this.activeSide === 'A' ? this.pointA : this.pointB;
      const otherPt = this.activeSide === 'A' ? this.pointB : this.pointA;
      this.rigA.group.visible = this.activeSide === 'A';
      this.rigB.group.visible = this.activeSide === 'B';
      // 材质按活动侧；两侧灯组每帧都更新世界矩阵，保证非活动侧探针读数正确
      this.mats.apply(p);
      this.applyLighting(this.paramsA, this.rigA, this.pointA);
      this.applyLighting(this.paramsB, this.rigB, this.pointB);
      pt.apply(p);
      otherPt.light.visible = false; // 非活动侧点光不参与渲染
      this.xformHelper.visible = true;
      this.renderer.setViewport(0, 0, w, h);
      this.renderer.setScissorTest(false);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // 分屏：同机位、同曝光，左 A 右 B，只切换灯组与材质
    const halfW = Math.floor(w / 2);
    this.renderer.setScissorTest(true);

    // A pass
    this.rigA.group.visible = true;
    this.rigB.group.visible = false;
    this.mats.apply(this.paramsA);
    this.applyLighting(this.paramsA, this.rigA, this.pointA);
    this.applyLighting(this.paramsB, this.rigB, this.pointB);
    this.pointB.light.visible = false;
    this.xformHelper.visible = this.activeSide === 'A';
    this.renderer.setViewport(0, 0, halfW, h);
    this.renderer.setScissor(0, 0, halfW, h);
    this.renderer.render(this.scene, this.camera);

    // B pass
    this.rigA.group.visible = false;
    this.rigB.group.visible = true;
    this.mats.apply(this.paramsB);
    this.applyLighting(this.paramsA, this.rigA, this.pointA);
    this.applyLighting(this.paramsB, this.rigB, this.pointB);
    this.pointA.light.visible = false;
    this.xformHelper.visible = this.activeSide === 'B';
    this.renderer.setViewport(halfW, 0, w - halfW, h);
    this.renderer.setScissor(halfW, 0, w - halfW, h);
    this.renderer.render(this.scene, this.camera);

    this.rigA.group.visible = true;
    this.rigB.group.visible = true;
  }

  private resize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
