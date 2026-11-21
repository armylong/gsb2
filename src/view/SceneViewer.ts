import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Float32BufferAttribute,
  Fog,
  GridHelper,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  Line,
  LineBasicMaterial,
  LineSegments,
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
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { BvhNode } from '../core/picking';
import type { GeneratedScene, PickOutcome, RaySpec, SceneObject } from '../core/types';
import { WORLD } from '../core/scene';

export const STATE_COLORS = {
  groupAll: 0x2b5b8f,
  groupVisited: 0x3987e5,
  candidate: 0x3987e5,
  hit: 0xd95926,
  selected: 0x199e70,
  ray: 0xc3c2b7,
  origin: 0xf0efec,
} as const;

export type GizmoMode = 'translate' | 'rotate' | 'scale';

const RAY_LENGTH = 90;

interface ViewerCallbacks {
  onCanvasPick?: (origin: Vector3, direction: Vector3) => void;
  onTransformStart?: () => void;
  onObjectChange?: () => void;
  onTransformEnd?: () => void;
}

interface MeshRecord {
  mesh: Mesh;
  kind: SceneObject['kind'];
  /** 基础色，用于点选着色后复原 */
  baseColor: Color;
}

export class SceneViewer {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  private readonly transform: TransformControls;
  private readonly callbacks: ViewerCallbacks;

  private readonly objectRoot = new Group();
  private readonly groupRoot = new Group();
  private readonly pickRoot = new Group();
  private readonly selectionRoot = new Group();

  private readonly meshes = new Map<number, MeshRecord>();
  private readonly ownedMaterials = new Set<MeshStandardMaterial>();
  private readonly unitBox: BoxGeometry;
  private readonly unitSphere: SphereGeometry;
  private readonly boxEdges: EdgesGeometry;
  private readonly sphereEdges: EdgesGeometry;

  private readonly raycaster = new Raycaster();
  private readonly pointerNdc = new Vector2();
  private readonly pointerDown = new Vector2();

  private currentScene: GeneratedScene | null = null;
  private transformTargetId: number | null = null;
  private editEnabled = false;
  private draggingGizmo = false;
  private tinted = false;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, callbacks: ViewerCallbacks = {}) {
    this.callbacks = callbacks;

    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;

    this.scene = new Scene();
    this.scene.background = new Color(0x0f1114);

    this.camera = new PerspectiveCamera(46, 1, 0.1, 800);
    this.camera.position.set(74, 52, 82);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 3, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 320;
    this.controls.update();

    this.scene.fog = new Fog(0x0f1114, 80, 210);
    this.scene.add(
      new AmbientLight(0xffffff, 0.55),
      new HemisphereLight(0xdde6ff, 0x22262c, 1.35),
    );
    const key = new DirectionalLight(0xffffff, 2.1);
    key.position.set(50, 90, 40);
    const fill = new DirectionalLight(0xa8c0e8, 0.85);
    fill.position.set(-70, 30, -60);
    const rim = new DirectionalLight(0x8fa4c8, 0.45);
    rim.position.set(10, 20, -80);
    this.scene.add(key, fill, rim);

    const grid = new GridHelper(170, 34, 0x2c3038, 0x1b1e23);
    grid.position.y = WORLD.min.y - 0.01;
    const gridMat = grid.material as LineBasicMaterial;
    gridMat.transparent = true;
    gridMat.opacity = 0.6;
    this.scene.add(grid);

    this.unitBox = new BoxGeometry(1, 1, 1);
    this.unitSphere = new SphereGeometry(0.5, 24, 16);
    this.boxEdges = new EdgesGeometry(this.unitBox);
    this.sphereEdges = new EdgesGeometry(new IcosahedronGeometry(0.5, 1));

    this.scene.add(this.objectRoot, this.groupRoot, this.pickRoot, this.selectionRoot);

    this.transform = new TransformControls(this.camera, canvas);
    this.transform.setMode('rotate');
    this.transform.setSize(0.8);
    this.transform.enabled = false;
    this.scene.add(this.transform.getHelper());

    // 注意：TransformControls 内部直接赋值 `dragging`，并不会派发 dragging-changed，
    // 因此这里监听 mouseDown / mouseUp 来暂停轨道控制，避免拖手柄时相机跟着转。
    this.transform.addEventListener('mouseDown', () => {
      this.draggingGizmo = true;
      this.controls.enabled = false;
      this.callbacks.onTransformStart?.();
    });
    this.transform.addEventListener('objectChange', () => {
      this.syncCoreFromMesh();
      this.callbacks.onObjectChange?.();
    });
    this.transform.addEventListener('mouseUp', () => {
      this.draggingGizmo = false;
      this.controls.enabled = true;
      this.syncCoreFromMesh();
      this.callbacks.onTransformEnd?.();
    });

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('resize', this.onResize);
    this.resize();
    this.renderer.setAnimationLoop(this.renderLoop);
  }

  private renderLoop = (): void => {
    if (this.disposed) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private onResize = (): void => {
    this.resize();
  };

  private resize(): void {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerDown.set(event.clientX, event.clientY);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    if (this.draggingGizmo || this.transform.dragging) return;
    if (this.transform.axis !== null) return;
    const moved = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
    if (moved > 4) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const origin = this.raycaster.ray.origin.clone();
    const direction = this.raycaster.ray.direction.clone().normalize();
    this.callbacks.onCanvasPick?.(origin, direction);
  };

  loadScene(scene: GeneratedScene): void {
    this.currentScene = scene;
    this.tinted = false;
    this.clearObjectRoot();
    this.clearGroup(this.pickRoot);
    this.clearGroup(this.groupRoot);
    this.clearGroup(this.selectionRoot);
    this.transformTargetId = null;
    this.transform.detach();
    this.transform.enabled = false;

    for (const obj of scene.objects) {
      const geometry = obj.kind === 'box' ? this.unitBox : this.unitSphere;
      const material = new MeshStandardMaterial({
        color: obj.color,
        roughness: 0.52,
        metalness: 0.04,
        emissive: obj.color,
        emissiveIntensity: 0.06,
        transparent: obj.style !== 'normal',
        opacity: obj.style === 'shell' ? 0.3 : obj.style === 'wire' ? 0.6 : 1,
        wireframe: obj.style === 'wire',
        depthWrite: obj.style !== 'shell',
      });
      this.ownedMaterials.add(material);
      const mesh = new Mesh(geometry, material);
      mesh.userData.objectId = obj.id;
      mesh.position.copy(obj.position);
      mesh.quaternion.copy(obj.quaternion);
      mesh.scale.copy(obj.size);
      this.objectRoot.add(mesh);
      this.meshes.set(obj.id, {
        mesh,
        kind: obj.kind,
        baseColor: new Color(obj.color),
      });
      mesh.updateMatrixWorld();
    }

    this.camera.position.set(74, 52, 82);
    this.controls.target.set(0, 3, 0);
    this.controls.update();
  }

  private applyObjectToMesh(obj: SceneObject): void {
    const rec = this.meshes.get(obj.id);
    if (!rec) return;
    rec.mesh.position.copy(obj.position);
    rec.mesh.quaternion.copy(obj.quaternion);
    rec.mesh.scale.copy(obj.size);
    rec.mesh.updateMatrixWorld();
  }

  private syncCoreFromMesh(): void {
    const id = this.transformTargetId;
    if (id === null || !this.currentScene) return;
    const obj = this.currentScene.objects.find((o) => o.id === id);
    const rec = this.meshes.get(id);
    if (!obj || !rec) return;
    obj.position.copy(rec.mesh.position);
    obj.quaternion.copy(rec.mesh.quaternion);
    obj.size.set(
      Math.max(Math.abs(rec.mesh.scale.x), 0.2),
      Math.max(Math.abs(rec.mesh.scale.y), 0.2),
      Math.max(Math.abs(rec.mesh.scale.z), 0.2),
    );
    rec.mesh.scale.copy(obj.size);
  }

  /**
   * 把核心物件状态同步回渲染网格。
   * 拖动过程中不能重新 attach —— 那会丢掉 TransformControls 正在追踪的起始状态。
   */
  syncObjectsFromCore(): void {
    if (!this.currentScene) return;
    for (const obj of this.currentScene.objects) this.applyObjectToMesh(obj);
  }

  getObjectIdAtMesh(object: Object3D | null): number | null {
    if (!object) return null;
    const value = object.userData.objectId;
    return typeof value === 'number' ? value : null;
  }

  /** 编辑模式用：按屏幕射线找最近的可编辑物件（three 的网格求交）。 */
  pickObjectId(origin: Vector3, direction: Vector3): number | null {
    this.raycaster.set(origin, direction);
    const hits = this.raycaster.intersectObjects(this.objectRoot.children, false);
    for (const hit of hits) {
      const id = this.getObjectIdAtMesh(hit.object);
      if (id !== null) return id;
    }
    return null;
  }

  setEditEnabled(enabled: boolean): void {
    this.editEnabled = enabled;
    this.refreshTransformState();
  }

  /** 高亮一个物件（点选核查时用，不挂手柄）。 */
  setHighlight(id: number | null): void {
    this.drawSelection(id);
  }

  /** 编辑目标：编辑模式下会挂上 TransformControls 手柄。 */
  setTransformTarget(id: number | null): void {
    this.transformTargetId = id;
    this.refreshTransformState();
  }

  setGizmoMode(mode: GizmoMode): void {
    this.transform.setMode(mode);
  }

  private refreshTransformState(): void {
    if (!this.editEnabled || this.transformTargetId === null) {
      this.transform.detach();
      this.transform.enabled = false;
      return;
    }
    const rec = this.meshes.get(this.transformTargetId);
    if (!rec) {
      this.transform.detach();
      this.transform.enabled = false;
      return;
    }
    this.transform.attach(rec.mesh);
    this.transform.enabled = true;
  }

  private drawSelection(id: number | null): void {
    this.clearGroup(this.selectionRoot);
    if (id === null || !this.currentScene) return;
    const obj = this.currentScene.objects.find((o) => o.id === id);
    if (!obj) return;
    const outline = this.makeOutline(obj, STATE_COLORS.selected, 0.95, 1.03);
    outline.renderOrder = 6;
    this.selectionRoot.add(outline);
  }

  /** 画分组边界（dim = 全部组，hot = 本次访问组）。 */
  drawGroups(allLeaves: BvhNode[] | null, visitedLeaves: BvhNode[]): void {
    this.clearGroup(this.groupRoot);
    if (allLeaves && allLeaves.length > 0) {
      // 全部分组：普通深度测试，让物件遮住身后的边界，画面才不糊成一片线框。
      const lines = this.boxLines(allLeaves, STATE_COLORS.groupAll, 0.34, true);
      lines.renderOrder = 1;
      this.groupRoot.add(lines);
    }
    if (visitedLeaves.length > 0) {
      const hot = this.boxLines(visitedLeaves, STATE_COLORS.groupVisited, 0.95, false);
      hot.renderOrder = 4;
      this.groupRoot.add(hot);
    }
  }

  /** 画一次点选的结果。 */
  drawPick(
    ray: RaySpec,
    outcome: PickOutcome,
    selectedId: number | null,
    candidateIds: number[],
  ): void {
    this.clearGroup(this.pickRoot);
    if (!this.currentScene) return;

    const origin = ray.origin;
    const end = origin.clone().addScaledVector(ray.direction, RAY_LENGTH);
    const rayLine = new Line(
      new BufferGeometry().setFromPoints([origin, end]),
      new LineBasicMaterial({
        color: STATE_COLORS.ray,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        depthTest: false,
      }),
    );
    rayLine.renderOrder = 5;
    this.pickRoot.add(rayLine);

    const originDot = new Mesh(
      new SphereGeometry(0.3, 12, 10),
      new MeshBasicMaterial({ color: STATE_COLORS.origin, depthTest: false }),
    );
    originDot.position.copy(origin);
    originDot.renderOrder = 9;
    this.pickRoot.add(originDot);

    const hitSet = new Set(outcome.hits.map((h) => h.objectId));
    const candidateSet = new Set(candidateIds);
    this.tintObjects(candidateSet, hitSet, selectedId);
    this.tinted = true;

    // 命中 / 选中物件额外描边，保证在密集场景里能一眼定位。
    for (const id of candidateIds) {
      if (!hitSet.has(id) && id !== selectedId) continue;
      const obj = this.currentScene.objects.find((o) => o.id === id);
      if (!obj) continue;
      const isSelected = id === selectedId;
      const color = isSelected ? STATE_COLORS.selected : STATE_COLORS.hit;
      const outline = this.makeOutline(obj, color, 1, isSelected ? 1.05 : 1.02);
      outline.renderOrder = isSelected ? 8 : 6;
      this.pickRoot.add(outline);
    }

    // 从远到近画交点标记（depthTest 关闭），保证距离最近的那个压在最上面。
    for (const hit of [...outcome.hits].reverse()) {
      const point = origin.clone().addScaledVector(ray.direction, Math.max(hit.t, 0));
      const isSelected = hit.objectId === selectedId;
      const marker = new Mesh(
        new SphereGeometry(isSelected ? 0.55 : 0.32, 16, 12),
        new MeshBasicMaterial({
          color: isSelected ? STATE_COLORS.selected : STATE_COLORS.hit,
          depthTest: false,
          transparent: true,
          opacity: 0.98,
        }),
      );
      marker.position.copy(point);
      marker.renderOrder = isSelected ? 12 : 10;
      this.pickRoot.add(marker);
    }
  }

  /**
   * 用材质的自发光给候选/命中/选中上色，而不是给每件候选都画线框——
   * 候选可能有几十件，线框一多整个画面就糊了。
   */
  private tintObjects(
    candidateIds: Set<number>,
    hitIds: Set<number>,
    selectedId: number | null,
  ): void {
    for (const [id, rec] of this.meshes) {
      const material = rec.mesh.material as MeshStandardMaterial;
      if (id === selectedId) {
        material.color.setHex(STATE_COLORS.selected);
        material.emissive.setHex(STATE_COLORS.selected);
        material.emissiveIntensity = 0.85;
      } else if (hitIds.has(id)) {
        material.color.setHex(STATE_COLORS.hit);
        material.emissive.setHex(STATE_COLORS.hit);
        material.emissiveIntensity = 0.7;
      } else if (candidateIds.has(id)) {
        material.color.copy(rec.baseColor).lerp(new Color(STATE_COLORS.candidate), 0.5);
        material.emissive.setHex(STATE_COLORS.candidate);
        material.emissiveIntensity = 0.3;
      } else {
        material.color.copy(rec.baseColor);
        material.emissive.copy(rec.baseColor);
        material.emissiveIntensity = 0.06;
      }
    }
  }

  clearPick(): void {
    this.clearGroup(this.pickRoot);
    if (this.tinted) {
      this.tintObjects(new Set(), new Set(), null);
      this.tinted = false;
    }
  }

  private makeOutline(
    obj: SceneObject,
    color: number,
    opacity: number,
    inflate: number,
  ): LineSegments {
    const geometry = obj.kind === 'box' ? this.boxEdges : this.sphereEdges;
    const lines = new LineSegments(
      geometry,
      new LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        depthTest: false,
      }),
    );
    lines.position.copy(obj.position);
    lines.quaternion.copy(obj.quaternion);
    lines.scale.copy(obj.size).multiplyScalar(inflate);
    lines.frustumCulled = false;
    return lines;
  }

  private boxLines(
    nodes: BvhNode[],
    color: number,
    opacity: number,
    depthTest: boolean,
  ): LineSegments {
    const positions: number[] = [];
    for (const node of nodes) {
      const { min, max } = node.box;
      const c: Array<[number, number, number]> = [
        [min.x, min.y, min.z],
        [max.x, min.y, min.z],
        [max.x, max.y, min.z],
        [min.x, max.y, min.z],
        [min.x, min.y, max.z],
        [max.x, min.y, max.z],
        [max.x, max.y, max.z],
        [min.x, max.y, max.z],
      ];
      const edges = [
        [0, 1], [1, 2], [2, 3], [3, 0],
        [4, 5], [5, 6], [6, 7], [7, 4],
        [0, 4], [1, 5], [2, 6], [3, 7],
      ];
      for (const [a, b] of edges) positions.push(...c[a], ...c[b]);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    const lines = new LineSegments(
      geometry,
      new LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        depthTest,
      }),
    );
    lines.frustumCulled = false;
    return lines;
  }

  /** 让相机框住一组世界坐标点（演示射线用）。 */
  framePoints(points: Vector3[], pad = 1.6): void {
    if (points.length === 0) return;
    const center = new Vector3();
    for (const p of points) center.add(p);
    center.multiplyScalar(1 / points.length);

    let radius = 4;
    for (const p of points) radius = Math.max(radius, p.distanceTo(center));
    radius *= pad;

    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.8, 1);
    dir.normalize();
    const distance = radius / Math.sin((this.camera.fov * Math.PI) / 360);
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, distance);
    this.controls.update();
  }

  resetCamera(): void {
    this.camera.position.set(74, 52, 82);
    this.controls.target.set(0, 3, 0);
    this.controls.update();
  }

  private clearObjectRoot(): void {
    this.objectRoot.clear();
    this.meshes.clear();
    for (const mat of this.ownedMaterials) mat.dispose();
    this.ownedMaterials.clear();
  }

  /**
   * 清空一个 overlay 组，并释放该组独占的几何/材质。
   * 注意：unitBox / unitSphere / boxEdges / sphereEdges 是全场共享的，不能在这里释放。
   */
  private clearGroup(group: Group): void {
    const shared = new Set<unknown>([this.unitBox, this.unitSphere, this.boxEdges, this.sphereEdges]);
    const disposables: Array<{ dispose: () => void }> = [];
    group.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh || (child as LineSegments).isLineSegments || (child as Line).isLine) {
        if (mesh.geometry && !shared.has(mesh.geometry)) disposables.push(mesh.geometry);
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach((m) => disposables.push(m));
        else if (mat) disposables.push(mat as unknown as { dispose: () => void });
      }
    });
    group.clear();
    for (const d of disposables) d.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.clearObjectRoot();
    this.clearGroup(this.pickRoot);
    this.clearGroup(this.groupRoot);
    this.clearGroup(this.selectionRoot);
    this.unitBox.dispose();
    this.unitSphere.dispose();
    this.boxEdges.dispose();
    this.sphereEdges.dispose();
    this.transform.dispose();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
