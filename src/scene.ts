import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CameraSnapshot, EditorConfig, PartDef, Vec3Tuple } from './types';
import { PART_ID_KEY } from './types';
import { HINGE_POINT, PART_IDS } from './preset';
import { localExplodeOffset } from './explosion';
import { createPartGeometry } from './geometry/factories';
import { createMaterials, type MaterialTable } from './geometry/materials';
import { computeLiveCollisions, computeSweepCollisions, type CollisionReport } from './collision';

interface PartNode {
  def: PartDef;
  group: THREE.Group;
  /** 装配位置的局部坐标缓存, 每帧在其上叠加爆炸偏移 */
  home: THREE.Vector3;
}

const v = (t: Vec3Tuple) => new THREE.Vector3(t[0], t[1], t[2]);

/** 管理 three.js 场景、装配层级与进度驱动的位移 */
export class AssemblyScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly root = new THREE.Group();

  private materials: MaterialTable;
  private nodes = new Map<string, PartNode>();
  private arrow: THREE.ArrowHelper;
  private selectedId: string | null = null;
  private warningIds = new Set<string>();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private config: EditorConfig;
  private collisionReport: CollisionReport = { hits: [], initialContact: [] };
  onPick: ((id: string | null) => void) | null = null;

  constructor(container: HTMLElement, config: EditorConfig) {
    this.config = config;
    const width = container.clientWidth;
    const height = container.clientHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 200);
    this.camera.position.set(9, 7, 11);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 2, 0);

    this.scene.background = new THREE.Color(0xf2f4f7);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a94a3, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(8, 12, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbcd0ff, 0.5);
    fill.position.set(-6, 4, -8);
    this.scene.add(fill);

    // 地面网格与阴影承接面
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.ShadowMaterial({ opacity: 0.18 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.scene.add(new THREE.GridHelper(40, 40, 0xb8c0cc, 0xd8dde5));
    this.scene.add(this.root);

    this.materials = createMaterials();
    this.arrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(),
      1.5,
      0x1e88e5,
      0.35,
      0.2,
    );
    this.arrow.visible = false;
    this.scene.add(this.arrow);

    this.buildTree(config);
    this.recomputeCollisions();

    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.controls.addEventListener('change', this.renderOnce);
  }

  /** 按 parentId 构建嵌套场景图; 重建配置时整体替换 */
  private buildTree(config: EditorConfig) {
    this.disposeTree();
    // 材质随旧树一起释放, 重建时换新, 避免反复切换预设导致 GPU 泄漏
    Object.values(this.materials).forEach((m) => m.dispose());
    this.materials = createMaterials();
    this.nodes.clear();
    const groups = new Map<string, THREE.Group>();

    for (const def of config.parts) {
      const group = new THREE.Group();
      group.name = def.name;
      group.userData[PART_ID_KEY] = def.id;
      group.position.copy(v(def.position));
      const geometry = createPartGeometry(def.id, this.materials);
      geometry.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      group.add(geometry);
      groups.set(def.id, group);
      this.nodes.set(def.id, { def, group, home: v(def.position) });
    }
    // 第二遍再挂父子, 保证父节点已存在
    for (const def of config.parts) {
      const group = groups.get(def.id)!;
      if (def.parentId) groups.get(def.parentId)!.add(group);
      else this.root.add(group);
    }
  }

  /** 应用总进度: 每个零件只写「相对自己父节点」的局部位移, 父动子随 */
  applyProgress(global: number, lidAngle: number) {
    for (const node of this.nodes.values()) {
      const offset = localExplodeOffset(node.def.step, global);
      node.group.position.copy(node.home).add(v(offset));
      // 翻盖预览仅在完全合装时可用, 避免与爆炸位移互相打架
      if (node.def.id === PART_IDS.cover) {
        if (global === 0) {
          // 盖板节点中心与铰链轴的高差, 旋转后补偿位置使枢轴落在铰链轴上
          const h = HINGE_POINT[1] - node.home.y;
          node.group.rotation.x = lidAngle;
          node.group.position.y = node.home.y + h * (1 - Math.cos(lidAngle));
          node.group.position.z = h * Math.sin(lidAngle);
        } else {
          node.group.rotation.set(0, 0, 0);
        }
      }
    }
    this.root.updateMatrixWorld(true);
    this.updateArrow();
    this.renderOnce();
  }

  /** 选中零件时显示它的局部爆炸方向与距离(箭头是世界空间对象, 需用父节点矩阵换算) */
  private updateArrow() {
    if (!this.selectedId) {
      this.arrow.visible = false;
      return;
    }
    const node = this.nodes.get(this.selectedId);
    if (!node || !node.def.step || !node.group.parent) {
      this.arrow.visible = false;
      return;
    }
    const step = node.def.step;
    const parentWorld = new THREE.Matrix4().copy(node.group.parent.matrixWorld);
    const dirWorld = v(step.dir).normalize().transformDirection(parentWorld);
    const originWorld = new THREE.Vector3();
    node.group.getWorldPosition(originWorld);
    this.arrow.position.copy(originWorld).addScaledVector(dirWorld, 0.02);
    this.arrow.setDirection(dirWorld);
    this.arrow.setLength(Math.max(0.8, step.distance), 0.3, 0.18);
    this.arrow.visible = true;
  }

  select(id: string | null) {
    this.selectedId = id;
    this.updateArrow();
    this.refreshHighlights();
  }

  /** 干涉零件红闪、选中零件蓝描边 */
  setWarningIds(ids: Set<string>) {
    this.warningIds = ids;
    this.refreshHighlights();
  }

  private refreshHighlights() {
    for (const node of this.nodes.values()) {
      const isWarn = this.warningIds.has(node.def.id);
      const isSel = node.def.id === this.selectedId;
      node.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const material = mesh.material as THREE.MeshStandardMaterial;
        if (isWarn) {
          material.emissive.setHex(0xd32f2f);
          material.emissiveIntensity = 0.75;
        } else if (isSel) {
          material.emissive.setHex(0x1565c0);
          material.emissiveIntensity = 0.45;
        } else {
          material.emissive.setHex(0x000000);
          material.emissiveIntensity = 0;
        }
      });
    }
  }

  /** 整条进度轴扫描干涉, 区间用于时间轴标记与面板提示 */
  recomputeCollisions(): CollisionReport {
    this.collisionReport = computeSweepCollisions(this.config, this);
    return this.collisionReport;
  }

  get report() {
    return this.collisionReport;
  }

  /** 当前进度下正在发生的碰撞(拖动时实时刷新, 恢复顺序后自动清空) */
  liveCollisions(global: number) {
    return computeLiveCollisions(this.config, this, global);
  }

  /** 碰撞模块需要的世界包围盒 */
  worldBoxOf(partId: string): THREE.Box3 {
    const node = this.nodes.get(partId);
    if (!node) throw new Error(`未知零件 ${partId}`);
    node.group.updateWorldMatrix(true, true);
    return new THREE.Box3().setFromObject(node.group);
  }

  /** 碰撞模块需要的直接父节点世界矩阵(顶层零件取装配根) */
  getParentWorldMatrix(partId: string): THREE.Matrix4 {
    const node = this.nodes.get(partId);
    if (!node) throw new Error(`未知零件 ${partId}`);
    const parent = node.group.parent ?? this.root;
    parent.updateWorldMatrix(true, false);
    return parent.matrixWorld.clone();
  }

  /** 配置被编辑/切换后重建几何与层级(当前未走热替换, 保留给后续扩展) */
  replaceConfig(config: EditorConfig) {
    this.config = config;
    this.selectedId = null;
    this.arrow.visible = false;
    this.buildTree(config);
    this.recomputeCollisions();
  }

  getCameraSnapshot(): CameraSnapshot {
    const target = this.controls.target;
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [target.x, target.y, target.z],
      zoom: this.camera.zoom,
    };
  }

  restoreCamera(snap: CameraSnapshot) {
    this.camera.position.set(...snap.position);
    this.controls.target.set(...snap.target);
    this.camera.zoom = snap.zoom;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.renderOnce();
  }

  resetCamera() {
    this.camera.position.set(9, 7, 11);
    this.controls.target.set(0, 2, 0);
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.renderOnce();
  }

  private handlePointerDown = (event: PointerEvent) => {
    // 拖拽轨道时不触发点选
    if (event.button !== 0) return;
    const downPos = { x: event.clientX, y: event.clientY };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointerup', up);
      const moved = Math.hypot(upEvent.clientX - downPos.x, upEvent.clientY - downPos.y);
      if (moved > 5) return;
      this.pick(upEvent);
    };
    window.addEventListener('pointerup', up);
  };

  private pick(event: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.root.children, true);
    let id: string | null = null;
    for (const hit of hits) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj && !obj.userData[PART_ID_KEY]) obj = obj.parent;
      if (obj) {
        id = obj.userData[PART_ID_KEY] as string;
        break;
      }
    }
    this.select(id);
    this.onPick?.(id);
  }

  resize(width: number, height: number) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.renderOnce();
  }

  /** OrbitControls 阻尼循环 */
  startLoop() {
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private raf = 0;
  private renderOnce = () => this.renderer.render(this.scene, this.camera);

  private disposeTree() {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry?.dispose();
      }
    });
    while (this.root.children.length) this.root.remove(this.root.children[0]);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.controls.removeEventListener('change', this.renderOnce);
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.disposeTree();
    Object.values(this.materials).forEach((m) => m.dispose());
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
