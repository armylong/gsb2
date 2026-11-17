import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RobotArm } from './RobotArm';
import {
  ArmParams,
  BaseTransform,
  JointAngles,
  Vec3,
  forwardKinematics,
  forwardKinematicsExplicit,
  localToWorld,
  worldToLocal,
  solveIK,
  distance,
  clampAngles,
  REACH_TOLERANCE,
} from './kinematics';

export type Mode = 'follow' | 'manual';

export interface SceneSnapshot {
  mode: Mode;
  angles: JointAngles;
  params: ArmParams;
  base: BaseTransform;
  targetWorld: Vec3;
  endWorld: Vec3; // read from the three.js world matrix (not from the IK solver)
  residual: number;
  reached: boolean;
  reason: string;
  scriptedRunning: boolean;
}

export interface PoseVerification {
  expected: Vec3; // explicit trig FK + rigid base transform
  composed: Vec3; // frame-composition FK + rigid base transform
  actual: Vec3; // three.js scene-graph world matrix
  errorExpectedActual: number;
  errorComposedActual: number;
}

const TARGET_COLOR = 0x27d3ff;
const OK_COLOR = 0x46e08a;
const BAD_COLOR = 0xff5d5d;

export class SceneApp {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  private arm: RobotArm;
  private targetGroup = new THREE.Group();
  private targetSphere: THREE.Mesh;
  private connector: THREE.Line;
  private worldAxes: THREE.AxesHelper;
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private params: ArmParams;
  private angles: JointAngles;
  private base: BaseTransform;
  private targetWorld: THREE.Vector3;
  private mode: Mode = 'follow';
  private reason = 'reached';
  private dragPlaneMode: 'camera' | 'ground' = 'camera';

  private dragKind: 'target' | 'base' | null = null;
  private dragPlane = new THREE.Plane();
  private dragOffset = new THREE.Vector3();

  private scripted: { t: number; active: boolean } | null = null;
  private crossPath: THREE.Vector3[] = [];

  onChange: ((s: SceneSnapshot) => void) | null = null;

  constructor(container: HTMLElement, params: ArmParams, angles: JointAngles, base: BaseTransform) {
    this.params = structuredClone(params);
    this.angles = { ...angles };
    this.base = structuredClone(base);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x10151d);
    this.camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.05,
      100
    );
    this.camera.position.set(2.6, 2.1, 3.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.target.set(0.4, 0.7, 0);

    this.setupLights();
    this.setupGround();

    this.worldAxes = new THREE.AxesHelper(0.55);
    this.scene.add(this.worldAxes);

    this.arm = new RobotArm(this.params, this.angles);
    this.scene.add(this.arm.root);
    this.applyBase();

    // --- target marker ---
    this.targetSphere = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.07, 2),
      new THREE.MeshStandardMaterial({
        color: TARGET_COLOR,
        emissive: TARGET_COLOR,
        emissiveIntensity: 0.55,
        metalness: 0.2,
        roughness: 0.3,
      })
    );
    this.targetSphere.userData.dragKind = 'target';
    this.targetSphere.castShadow = true;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.12, 0.008, 10, 40),
      new THREE.MeshBasicMaterial({ color: TARGET_COLOR, transparent: true, opacity: 0.9 })
    );
    ring.rotation.x = Math.PI / 2;
    this.targetGroup.add(this.targetSphere, ring);
    this.targetGroup.userData.dragKind = 'target';
    this.scene.add(this.targetGroup);

    // end -> target connector line
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    this.connector = new THREE.Line(
      lineGeo,
      new THREE.LineDashedMaterial({
        color: OK_COLOR,
        dashSize: 0.05,
        gapSize: 0.035,
        transparent: true,
        opacity: 0.85,
      })
    );
    this.connector.frustumCulled = false;
    this.scene.add(this.connector);

    // initial target: a reachable point in front of the arm
    this.targetWorld = new THREE.Vector3(1.2, 0.67, 0.35);
    this.targetGroup.position.copy(this.targetWorld);

    this.bindPointerEvents();
    window.addEventListener('resize', () => this.handleResize(container));

    this.runFollow();
    this.animate();
  }

  // ------------------------------------------------------------- public API

  getSnapshot(): SceneSnapshot {
    const endWorld = this.arm.getEndWorldPosition(new THREE.Vector3());
    const residual = endWorld.distanceTo(this.targetWorld);
    const reached = residual <= REACH_TOLERANCE;
    return {
      mode: this.mode,
      angles: { ...this.angles },
      params: structuredClone(this.params),
      base: structuredClone(this.base),
      targetWorld: { x: this.targetWorld.x, y: this.targetWorld.y, z: this.targetWorld.z },
      endWorld: { x: endWorld.x, y: endWorld.y, z: endWorld.z },
      residual,
      reached,
      reason: this.mode === 'manual' ? 'manual' : this.reason,
      scriptedRunning: this.scripted?.active ?? false,
    };
  }

  setMode(mode: Mode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'follow') this.runFollow(); // warm start = current pose
    this.emit();
  }

  setManualAngles(a: JointAngles): void {
    this.mode = 'manual';
    this.angles = clampAngles(a, this.params);
    this.arm.setAngles(this.angles);
    this.emit();
  }

  setParams(params: ArmParams): void {
    this.params = structuredClone(params);
    this.angles = clampAngles(this.angles, this.params);
    this.arm.rebuild(this.params);
    this.applyBase();
    this.arm.setAngles(this.angles);
    if (this.mode === 'follow') this.runFollow();
    this.emit();
  }

  setTargetWorld(t: Vec3): void {
    this.stopScripted();
    this.targetWorld.set(t.x, t.y, t.z);
    this.targetGroup.position.copy(this.targetWorld);
    if (this.mode === 'follow') this.runFollow();
    this.emit();
  }

  setBasePosition(p: Vec3): void {
    this.stopScripted();
    this.base.position = { ...p };
    this.applyBase();
    if (this.mode === 'follow') this.runFollow();
    this.emit();
  }

  setBaseYaw(yawDeg: number): void {
    this.stopScripted();
    this.base.yawDeg = yawDeg;
    this.applyBase();
    if (this.mode === 'follow') this.runFollow();
    this.emit();
  }

  setDragPlaneMode(m: 'camera' | 'ground'): void {
    this.dragPlaneMode = m;
  }

  setJointAxesVisible(v: boolean): void {
    this.arm.setJointAxesVisible(v);
  }

  setLocalAxesVisible(v: boolean): void {
    this.arm.setLocalAxesVisible(v);
  }

  setWorldAxesVisible(v: boolean): void {
    this.worldAxes.visible = v;
  }

  setLabelsVisible(v: boolean): void {
    this.arm.setLabelsVisible(v);
  }

  /** Project a world point to renderer-client pixel coordinates (for tests). */
  projectWorld(p: Vec3): { x: number; y: number; behind: boolean } {
    const v3 = new THREE.Vector3(p.x, p.y, p.z).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + (v3.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-v3.y * 0.5 + 0.5) * rect.height,
      behind: v3.z > 1,
    };
  }

  /** Apply a known pose in MANUAL mode and verify it three independent ways. */
  applyKnownPose(
    angles: JointAngles,
    base: BaseTransform
  ): PoseVerification {
    this.stopScripted();
    this.mode = 'manual';
    this.angles = clampAngles(angles, this.params);
    this.base = structuredClone(base);
    this.applyBase();
    this.arm.setAngles(this.angles);

    const expected = localToWorld(
      forwardKinematicsExplicit(this.params, this.angles),
      this.base
    );
    const composed = localToWorld(
      forwardKinematics(this.params, this.angles).end,
      this.base
    );
    const actualV3 = this.arm.getEndWorldPosition(new THREE.Vector3());
    const actual: Vec3 = { x: actualV3.x, y: actualV3.y, z: actualV3.z };

    this.emit();
    return {
      expected,
      composed,
      actual,
      errorExpectedActual: distance(expected, actual),
      errorComposedActual: distance(composed, actual),
    };
  }

  startCrossSide(): void {
    const h = 0.22 + 0.12;
    this.crossPath = [
      new THREE.Vector3(1.5, h, 0.9),
      new THREE.Vector3(1.0, h + 0.1, 0.45),
      new THREE.Vector3(0.5, h + 0.05, 0.08),
      new THREE.Vector3(0.45, h, -0.05),
      new THREE.Vector3(0.9, h + 0.1, -0.5),
      new THREE.Vector3(1.5, h, -0.9),
    ];
    this.mode = 'follow';
    this.targetWorld.copy(this.crossPath[0]);
    this.targetGroup.position.copy(this.targetWorld);
    this.runFollow();
    this.scripted = { t: 0, active: true };
    this.emit();
  }

  stopScripted(): void {
    if (this.scripted) this.scripted.active = false;
    this.scripted = null;
  }

  // ----------------------------------------------------------------- internals

  private setupLights(): void {
    const hemi = new THREE.HemisphereLight(0xbfd7ff, 0x2a2f38, 0.85);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(3, 5, 2.5);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -4;
    dir.shadow.camera.right = 4;
    dir.shadow.camera.top = 4;
    dir.shadow.camera.bottom = -4;
    this.scene.add(dir);
  }

  private setupGround(): void {
    const grid = new THREE.GridHelper(8, 32, 0x3a4556, 0x232b37);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.7;
    this.scene.add(grid);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.ShadowMaterial({ opacity: 0.28 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  private applyBase(): void {
    this.arm.setBaseTransform(
      new THREE.Vector3(this.base.position.x, this.base.position.y, this.base.position.z),
      this.base.yawDeg
    );
  }

  /** One IK solve in the base-local frame; warm-started from current angles. */
  private runFollow(): void {
    const localTarget = worldToLocal(
      { x: this.targetWorld.x, y: this.targetWorld.y, z: this.targetWorld.z },
      this.base
    );
    const result = solveIK(this.params, localTarget, this.angles);
    this.angles = result.angles;
    this.reason = result.reason;
    this.arm.setAngles(this.angles);
  }

  private emit(): void {
    this.onChange?.(this.getSnapshot());
  }

  // ------------------------------------------------------------- pointer drag

  private bindPointerEvents(): void {
    const dom = this.renderer.domElement;
    dom.style.touchAction = 'none';

    dom.addEventListener('pointerdown', (e) => {
      this.updatePointer(e);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hits = this.raycaster.intersectObjects(
        [this.targetGroup, this.arm.root],
        true
      );
      if (hits.length === 0) return;

      // nearest hit decides what is grabbed
      const kind = this.findDragKind(hits[0].object);
      if (!kind) return;
      e.preventDefault();
      dom.setPointerCapture(e.pointerId);
      this.dragKind = kind;
      this.controls.enabled = false;

      const hitPoint = hits[0].point;
      if (kind === 'target') {
        if (this.dragPlaneMode === 'ground') {
          this.dragPlane.set(new THREE.Vector3(0, 1, 0), -this.targetWorld.y);
        } else {
          const normal = new THREE.Vector3();
          this.camera.getWorldDirection(normal);
          this.dragPlane.setFromNormalAndCoplanarPoint(normal, this.targetWorld);
        }
        this.dragOffset.copy(this.targetWorld).sub(hitPoint);
      } else {
        this.dragPlane.copy(this.groundPlane);
        this.dragOffset.set(0, 0, 0);
      }
    });

    dom.addEventListener('pointermove', (e) => {
      if (!this.dragKind) {
        this.updatePointer(e);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hits = this.raycaster.intersectObjects(
          [this.targetGroup, this.arm.root],
          true
        );
        dom.style.cursor = hits.length && this.findDragKind(hits[0].object) ? 'grab' : '';
        return;
      }
      this.updatePointer(e);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const point = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(this.dragPlane, point)) return;
      point.add(this.dragOffset);

      if (this.dragKind === 'target') {
        point.y = Math.max(0.05, point.y);
        this.stopScripted();
        this.targetWorld.copy(point);
        this.targetGroup.position.copy(point);
        if (this.mode === 'follow') this.runFollow();
        this.emit();
      } else {
        this.stopScripted();
        this.base.position = { x: point.x, y: 0, z: point.z };
        this.applyBase();
        if (this.mode === 'follow') this.runFollow();
        this.emit();
      }
    });

    const endDrag = (e: PointerEvent) => {
      if (!this.dragKind) return;
      this.dragKind = null;
      this.controls.enabled = true;
      dom.style.cursor = '';
      try {
        dom.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    dom.addEventListener('pointerup', endDrag);
    dom.addEventListener('pointercancel', endDrag);
  }

  private findDragKind(obj: THREE.Object3D): 'target' | 'base' | null {
    let o: THREE.Object3D | null = obj;
    while (o) {
      if (o.userData.dragKind === 'target') return 'target';
      o = o.parent;
    }
    // anything on the arm root is the base (base translation only, y=0 plane)
    o = obj;
    while (o) {
      if (o === this.arm.root) return 'base';
      o = o.parent;
    }
    return null;
  }

  private updatePointer(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private handleResize(container: HTMLElement): void {
    this.camera.aspect = container.clientWidth / container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(container.clientWidth, container.clientHeight);
  }

  // -------------------------------------------------------------------- loop

  private animate = (): void => {
    requestAnimationFrame(this.animate);

    if (this.scripted?.active) {
      // advance along the polyline and ping-pong; ~0.9 unit/s.
      // Triangular wave on the arc parameter keeps the direction state
      // self-contained (no separate forward flag to desync).
      const speed = 0.9;
      const s = this.scripted;
      s.t += speed / 60;
      const totalLen = this.crossPath.length - 1;
      const period = 2 * totalLen;
      const phase = s.t % period;
      const pos = phase <= totalLen ? phase : period - phase;

      const i = Math.min(Math.floor(pos), totalLen - 1);
      const f = pos - i;
      this.targetWorld.lerpVectors(this.crossPath[i], this.crossPath[i + 1], f);
      this.targetGroup.position.copy(this.targetWorld);
      this.runFollow();
      this.emit();
    }

    this.controls.update();

    // update end -> target connector from the live world matrix
    const end = this.arm.getEndWorldPosition(new THREE.Vector3());
    const posAttr = this.connector.geometry.getAttribute('position') as THREE.BufferAttribute;
    posAttr.setXYZ(0, end.x, end.y, end.z);
    posAttr.setXYZ(1, this.targetWorld.x, this.targetWorld.y, this.targetWorld.z);
    posAttr.needsUpdate = true;
    this.connector.computeLineDistances();
    const residual = end.distanceTo(this.targetWorld);
    const mat = this.connector.material as THREE.LineDashedMaterial;
    const ok = residual <= REACH_TOLERANCE;
    mat.color.setHex(ok ? OK_COLOR : BAD_COLOR);
    this.targetSphere.scale.setScalar(ok ? 1 : 1 + 0.18 * Math.sin(performance.now() / 180));

    this.renderer.render(this.scene, this.camera);
  };
}
