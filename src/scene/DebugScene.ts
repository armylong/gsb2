/**
 * 蒙皮权重调试场景:
 * 渲染器/相机/轨道控制、三骨骼带状蒙皮网格、骨架与关节可视化、
 * 权重热力图、顶点拾取、世界空间笔刷、姿态旋转、标记与笔刷环。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BONE_COLORS, Heatmap } from './heatmap';
import { computeSkinnedPositions } from './skinningCpu';
import { buildRibbon, syncSkinWeights, RibbonBuildResult } from './ribbon';
import { WeightModel } from '../weights/WeightModel';
import { blendWeights, buildInitialWeights, PRESETS } from '../weights/presets';
import { BonePose, DebuggerState } from '../weights/storage';

export type BrushMode = 'select' | 'add' | 'subtract';

export interface BrushConfig {
  mode: BrushMode;
  radius: number;
  strength: number;
}

export interface SceneCallbacks {
  /** 权重被笔刷/预设/存档修改后触发,UI 据此刷新 */
  onWeightsMutated?: () => void;
  /** 选中骨骼变化(bone),或选中顶点(vertex>=0) */
  onSelect?: (bone: number, vertex: number | null) => void;
  /** 点击顶点,回传该顶点各骨骼权重 */
  onVertexPick?: (vertex: number, weights: number[], worldPoint: THREE.Vector3) => void;
  /** 笔刷在某顶点落了一笔(状态栏提示用) */
  onBrushStamp?: (changed: number) => void;
}

const PICK_NDC_THRESHOLD = 0.07;

export class DebugScene {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly ribbon: RibbonBuildResult;
  private readonly heatmap: Heatmap;
  private readonly skeletonHelper: THREE.SkeletonHelper;
  private readonly jointMeshes: THREE.Mesh[] = [];
  private readonly vertexMarker: THREE.Mesh;
  private readonly brushRing: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private readonly resizeObserver: ResizeObserver;
  private readonly rafCallback = () => this.animate();

  readonly model: WeightModel;
  private readonly worldPositions: Float32Array;
  private locked: boolean[] = [false, false, false];
  private selectedBone = 0;
  private selectedVertex: number | null = null;
  private brush: BrushConfig = { mode: 'select', radius: 0.6, strength: 0.15 };
  private painting = false;
  private pointerDownPos = { x: 0, y: 0 };
  private disposed = false;

  constructor(container: HTMLElement, initialWeights?: Float32Array, private readonly callbacks: SceneCallbacks = {}) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setClearColor(0x14181f);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.1,
      100,
    );
    this.camera.position.set(3.4, 3.2, 5.4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(3, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    // 灯光与参考网格
    this.scene.add(new THREE.HemisphereLight(0xdde6f0, 0x2a3140, 1.4));
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(4, 6, 5);
    this.scene.add(dir);
    const grid = new THREE.GridHelper(10, 20, 0x3a4453, 0x232a35);
    grid.position.set(3, -0.55, 0);
    this.scene.add(grid);
    const axes = new THREE.AxesHelper(1.1);
    this.scene.add(axes);

    // 带状蒙皮网格
    this.ribbon = buildRibbon();
    this.scene.add(this.ribbon.mesh);

    // 未显式传入时按默认预设、基于几何的绑定 X 坐标生成初始权重
    const weights =
      initialWeights ??
      buildInitialWeights(this.ribbon.bindXs, this.ribbon.length, PRESETS.default.blendWidth);
    this.model = new WeightModel(this.ribbon.vertexCount, weights);
    syncSkinWeights(this.ribbon.geometry, this.model.data, this.ribbon.vertexCount);
    this.worldPositions = new Float32Array(this.ribbon.vertexCount * 3);

    // 热力图
    this.heatmap = new Heatmap(this.ribbon.vertexCount);
    this.heatmap.updateColors(this.model, this.selectedBone);
    this.scene.add(this.heatmap.points);

    // 骨架
    this.skeletonHelper = new THREE.SkeletonHelper(this.ribbon.mesh);
    (this.skeletonHelper.material as THREE.LineBasicMaterial).linewidth = 2;
    this.scene.add(this.skeletonHelper);

    // 关节球(可点击选骨骼)
    const sphereGeo = new THREE.SphereGeometry(0.13, 20, 16);
    for (let b = 0; b < this.ribbon.bones.length; b++) {
      const mat = new THREE.MeshStandardMaterial({
        color: BONE_COLORS[b],
        emissive: BONE_COLORS[b],
        emissiveIntensity: 0.45,
      });
      const sphere = new THREE.Mesh(sphereGeo, mat);
      sphere.userData.boneIndex = b;
      this.jointMeshes.push(sphere);
      this.scene.add(sphere);
    }

    // 选中顶点标记
    this.vertexMarker = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.12),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    this.vertexMarker.visible = false;
    this.scene.add(this.vertexMarker);

    // 笔刷环(始终面向相机)
    this.brushRing = new THREE.Mesh(
      new THREE.RingGeometry(0.96, 1, 48),
      new THREE.MeshBasicMaterial({ color: 0xfff17a, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
    );
    this.brushRing.visible = false;
    this.scene.add(this.brushRing);

    this.bindPointerEvents();
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);
    this.animate();
  }

  // ---------------- 选择 / 视图 ----------------

  get boneCount(): number {
    return this.ribbon.bones.length;
  }

  get vertexCount(): number {
    return this.ribbon.vertexCount;
  }

  setSelectedBone(b: number): void {
    this.selectedBone = b;
    this.heatmap.updateColors(this.model, b);
    this.callbacks.onSelect?.(b, this.selectedVertex);
  }

  getSelectedBone(): number {
    return this.selectedBone;
  }

  setHeatmapVisible(visible: boolean): void {
    this.heatmap.setVisible(visible);
  }

  setSkeletonVisible(visible: boolean): void {
    this.skeletonHelper.visible = visible;
    this.jointMeshes.forEach((m) => (m.visible = visible));
  }

  setWireframe(wireframe: boolean): void {
    (this.ribbon.mesh.material as THREE.MeshStandardMaterial).wireframe = wireframe;
  }

  // ---------------- 锁定 ----------------

  setBoneLocked(b: number, locked: boolean): void {
    this.locked[b] = locked;
    this.refreshJointAppearance();
  }

  getLocked(): boolean[] {
    return [...this.locked];
  }

  private refreshJointAppearance(): void {
    this.jointMeshes.forEach((mesh, b) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (this.locked[b]) {
        mat.color.set(0x6b7280);
        mat.emissive.set(0x2f3540);
        mat.emissiveIntensity = 0.6;
      } else {
        mat.color.copy(BONE_COLORS[b]);
        mat.emissive.copy(BONE_COLORS[b]);
        mat.emissiveIntensity = b === this.selectedBone ? 0.9 : 0.45;
      }
    });
  }

  // ---------------- 姿态 ----------------

  setPose(poses: BonePose[]): void {
    this.ribbon.bones.forEach((bone, b) => {
      bone.rotation.y = THREE.MathUtils.degToRad(poses[b].rotY);
      bone.rotation.z = THREE.MathUtils.degToRad(poses[b].rotZ);
    });
  }

  getPoses(): BonePose[] {
    return this.ribbon.bones.map((bone) => ({
      rotY: THREE.MathUtils.radToDeg(bone.rotation.y),
      rotZ: THREE.MathUtils.radToDeg(bone.rotation.z),
    }));
  }

  resetPose(): void {
    this.setPose(this.ribbon.bones.map(() => ({ rotY: 0, rotZ: 0 })));
  }

  // ---------------- 权重修改 ----------------

  setBrush(partial: Partial<BrushConfig>): void {
    this.brush = { ...this.brush, ...partial };
    this.brushRing.visible = this.brush.mode !== 'select';
  }

  getBrush(): BrushConfig {
    return { ...this.brush };
  }

  /** 套用权重预设;锁定骨骼的权重保持不变 */
  applyPreset(presetId: keyof typeof PRESETS): void {
    const preset = PRESETS[presetId];
    for (let v = 0; v < this.vertexCount; v++) {
      const target = blendWeights(this.ribbon.bindXs[v], this.ribbon.length, preset.blendWidth);
      this.model.applyPresetPreservingLocks(target, v, this.locked);
    }
    this.afterWeightsChanged();
  }

  /** 恢复默认权重(仍尊重锁定) */
  resetWeights(): void {
    this.applyPreset('default');
  }

  restoreState(state: DebuggerState): void {
    this.model.data.set(state.weights);
    this.locked = [...state.locked];
    this.setPose(state.poses);
    this.refreshJointAppearance();
    this.afterWeightsChanged();
  }

  getWeightsData(): Float32Array {
    return new Float32Array(this.model.data);
  }

  getVertexWeights(v: number): number[] {
    return this.model.weightsOf(v);
  }

  getSelectedVertex(): number | null {
    return this.selectedVertex;
  }

  private afterWeightsChanged(): void {
    syncSkinWeights(this.ribbon.geometry, this.model.data, this.vertexCount);
    this.heatmap.updateColors(this.model, this.selectedBone);
    this.callbacks.onWeightsMutated?.();
    if (this.selectedVertex !== null) {
      this.callbacks.onVertexPick?.(
        this.selectedVertex,
        this.model.weightsOf(this.selectedVertex),
        this.getVertexWorldPosition(this.selectedVertex, new THREE.Vector3()),
      );
    }
  }

  // ---------------- 拾取与笔刷 ----------------

  private toNDC(event: PointerEvent): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** NDC 距离最近的顶点索引与距离 */
  private nearestVertex(ndc: THREE.Vector2): { index: number; distance: number } {
    const proj = new THREE.Vector3();
    let best = -1;
    let bestDist = Infinity;
    for (let v = 0; v < this.vertexCount; v++) {
      proj.set(this.worldPositions[v * 3], this.worldPositions[v * 3 + 1], this.worldPositions[v * 3 + 2]);
      proj.project(this.camera);
      const d = Math.hypot(proj.x - ndc.x, proj.y - ndc.y);
      if (d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
    return { index: best, distance: bestDist };
  }

  /** 射线命中关节球时返回骨骼索引,否则 null */
  private pickJoint(event: PointerEvent): number | null {
    const ndc = this.toNDC(event);
    this.raycaster.setFromCamera(ndc, this.camera);
    const joints = this.raycaster.intersectObjects(this.jointMeshes, false);
    return joints.length > 0 ? (joints[0].object.userData.boneIndex as number) : null;
  }

  private pick(event: PointerEvent): void {
    // 优先拾取关节球 -> 选骨骼
    const jointBone = this.pickJoint(event);
    if (jointBone !== null) {
      this.setSelectedBone(jointBone);
      return;
    }

    const ndc = this.toNDC(event);
    const nearest = this.nearestVertex(ndc);
    if (nearest.distance <= PICK_NDC_THRESHOLD) {
      this.selectedVertex = nearest.index;
      this.vertexMarker.visible = true;
      const world = this.getVertexWorldPosition(nearest.index, new THREE.Vector3());
      this.callbacks.onSelect?.(this.selectedBone, nearest.index);
      this.callbacks.onVertexPick?.(nearest.index, this.model.weightsOf(nearest.index), world);
    } else {
      this.selectedVertex = null;
      this.vertexMarker.visible = false;
      this.callbacks.onSelect?.(this.selectedBone, null);
    }
  }

  /** 在指针位置落一笔:半径内顶点按距离衰减修改选中骨骼权重 */
  private stamp(event: PointerEvent): void {
    const ndc = this.toNDC(event);
    const anchor = this.nearestVertex(ndc);
    if (anchor.distance > PICK_NDC_THRESHOLD * 3) return;

    const ax = this.worldPositions[anchor.index * 3];
    const ay = this.worldPositions[anchor.index * 3 + 1];
    const az = this.worldPositions[anchor.index * 3 + 2];
    const sign = this.brush.mode === 'add' ? 1 : -1;
    const r2 = this.brush.radius * this.brush.radius;

    let changed = 0;
    for (let v = 0; v < this.vertexCount; v++) {
      const dx = this.worldPositions[v * 3] - ax;
      const dy = this.worldPositions[v * 3 + 1] - ay;
      const dz = this.worldPositions[v * 3 + 2] - az;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const falloff = 1 - Math.sqrt(d2) / this.brush.radius; // 线性衰减,中心 1 -> 边缘 0
      const delta = sign * this.brush.strength * falloff;
      const ok = this.model.paintVertex(v, { bone: this.selectedBone, delta, locked: this.locked });
      if (ok) changed++;
    }

    if (changed > 0) {
      this.afterWeightsChanged();
      this.callbacks.onBrushStamp?.(changed);
    }
  }

  private bindPointerEvents(): void {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';

    el.addEventListener('pointerdown', (e) => {
      this.pointerDownPos = { x: e.clientX, y: e.clientY };
      if (this.brush.mode !== 'select') {
        // 笔刷模式下点关节球仍视为选骨骼,避免误刷
        const jointBone = this.pickJoint(e);
        if (jointBone !== null) {
          this.setSelectedBone(jointBone);
          return;
        }
        this.painting = true;
        this.controls.enabled = false;
        el.setPointerCapture(e.pointerId);
        this.stamp(e);
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (this.painting && this.brush.mode !== 'select') {
        this.stamp(e);
      }
      this.updateBrushRing(e);
    });

    el.addEventListener('pointerup', (e) => {
      const moved = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
      if (this.painting) {
        this.painting = false;
        this.controls.enabled = true;
      } else if (this.brush.mode === 'select' && moved < 5) {
        this.pick(e);
      }
    });

    el.addEventListener('pointerleave', () => {
      this.brushRing.visible = false;
    });
  }

  private updateBrushRing(event: PointerEvent): void {
    if (this.brush.mode === 'select') {
      this.brushRing.visible = false;
      return;
    }
    const ndc = this.toNDC(event);
    const nearest = this.nearestVertex(ndc);
    if (nearest.distance > PICK_NDC_THRESHOLD * 4) {
      this.brushRing.visible = false;
      return;
    }
    this.brushRing.visible = true;
    this.brushRing.position.set(
      this.worldPositions[nearest.index * 3],
      this.worldPositions[nearest.index * 3 + 1],
      this.worldPositions[nearest.index * 3 + 2],
    );
    this.brushRing.quaternion.copy(this.camera.quaternion);
    this.brushRing.scale.setScalar(this.brush.radius);
  }

  getVertexWorldPosition(v: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.worldPositions[v * 3], this.worldPositions[v * 3 + 1], this.worldPositions[v * 3 + 2]);
  }

  /** 数组形式的顶点世界坐标,便于控制台/外部脚本探查,无需持有 THREE.Vector3 */
  getVertexWorldPositionArray(v: number): [number, number, number] {
    return [this.worldPositions[v * 3], this.worldPositions[v * 3 + 1], this.worldPositions[v * 3 + 2]];
  }

  // ---------------- 帧循环 ----------------

  private animate(): void {
    if (this.disposed) return;
    requestAnimationFrame(this.rafCallback);

    this.controls.update();
    this.ribbon.skeleton.update();

    computeSkinnedPositions(this.ribbon.geometry, this.ribbon.skeleton, this.worldPositions);
    this.heatmap.updatePositions(this.worldPositions);

    // 关节球跟随骨骼世界位置
    for (let b = 0; b < this.jointMeshes.length; b++) {
      this.ribbon.bones[b].getWorldPosition(this.jointMeshes[b].position);
    }

    // 选中顶点标记跟随
    if (this.selectedVertex !== null) {
      this.getVertexWorldPosition(this.selectedVertex, this.vertexMarker.position);
    }

    this.renderer.render(this.scene, this.camera);
  }

  private handleResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.heatmap.dispose();
    this.ribbon.geometry.dispose();
    (this.ribbon.mesh.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
