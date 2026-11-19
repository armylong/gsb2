/**
 * 三视图渲染：
 * - split：左原始 / 右简化，两个视口共用同一个相机实例与同一套坐标刻度，
 *   不做任何独立 fit/fov 适配，因此收缩与位置偏移直接可见；
 * - overlay：单视口，简化实体 + 原始半透明叠加，共用同一相机。
 * 相机的轨道状态（旋转/平移/缩放）在两种模式间完全一致。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshData } from './meshTypes';
import { toThreeGeometry } from './errorMetrics';

export type ViewMode = 'split' | 'overlay';

export interface ViewerState {
  viewMode: ViewMode;
  wireframe: boolean;
  /** 简化表面的顶点色（距离着色）；null 时使用中性材质 */
  distanceColors: THREE.BufferAttribute | null;
  /** 距离色带的显示范围（只影响颜色） */
  colorRange: number;
}

export class MeshViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly scene = new THREE.Scene();
  private readonly originalMesh: THREE.Mesh;
  private readonly simplifiedMesh: THREE.Mesh;
  private readonly originalWire: THREE.LineSegments;
  private readonly simplifiedWire: THREE.LineSegments;
  private readonly originalMaterial: THREE.MeshStandardMaterial;
  private readonly simplifiedMaterial: THREE.MeshStandardMaterial;
  private readonly overlayOriginalMaterial: THREE.MeshStandardMaterial;
  private state: ViewerState;
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;

  constructor(container: HTMLElement, initial: ViewerState) {
    this.container = container;
    this.state = initial;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    // 所有样例都归一化到最长边 4，固定同一初始机位，不随网格重新适配
    this.camera.position.set(4.6, 3.2, 5.4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.target.set(0, 0, 0);

    this.scene.background = new THREE.Color(0x14161a);

    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x2a2c33, 1.1);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(5, 8, 6);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    fill.position.set(-6, -2, -4);
    this.scene.add(hemi, key, fill);

    this.originalMaterial = new THREE.MeshStandardMaterial({
      color: 0xb9c2d4,
      roughness: 0.65,
      metalness: 0.05,
      side: THREE.DoubleSide,
      flatShading: true,
    });
    this.overlayOriginalMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.8,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      side: THREE.DoubleSide,
      flatShading: true,
    });
    this.simplifiedMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.7,
      metalness: 0.05,
      side: THREE.DoubleSide,
      flatShading: true,
    });

    this.originalMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.originalMaterial);
    this.simplifiedMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.simplifiedMaterial);
    this.originalWire = this.makeWireframe(0x111418);
    this.simplifiedWire = this.makeWireframe(0x0b0d10);
    this.originalWire.visible = false;
    this.simplifiedWire.visible = false;
    this.scene.add(this.originalMesh, this.simplifiedMesh, this.originalWire, this.simplifiedWire);

    // 同一坐标原点的参考网格，两个视口共用，帮助判断位置偏移
    const grid = new THREE.GridHelper(6, 12, 0x3a4150, 0x262b35);
    grid.position.y = -2.15;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(grid);
    const axes = new THREE.AxesHelper(1.2);
    this.scene.add(axes);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.renderer.setAnimationLoop(() => this.frame());
  }

  private makeWireframe(color: number): THREE.LineSegments {
    const lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }),
    );
    return lines;
  }

  private replaceGeometry(target: THREE.Mesh | THREE.LineSegments, mesh: MeshData | null, wire = false) {
    target.geometry.dispose();
    if (!mesh) {
      target.geometry = new THREE.BufferGeometry();
      return;
    }
    const geom = toThreeGeometry(mesh);
    if (wire) {
      target.geometry = new THREE.WireframeGeometry(geom);
      geom.dispose();
    } else {
      geom.computeVertexNormals();
      target.geometry = geom;
    }
  }

  setOriginal(mesh: MeshData): void {
    this.replaceGeometry(this.originalMesh, mesh);
    this.replaceGeometry(this.originalWire, mesh, true);
  }

  setSimplified(mesh: MeshData | null, colors: THREE.BufferAttribute | null): void {
    this.state.distanceColors = colors;
    this.replaceGeometry(this.simplifiedMesh, mesh);
    this.replaceGeometry(this.simplifiedWire, mesh, true);
    if (mesh && colors) {
      this.simplifiedMesh.geometry.setAttribute('color', colors);
    }
    this.simplifiedMaterial.needsUpdate = true;
  }

  setState(patch: Partial<ViewerState>): void {
    this.state = { ...this.state, ...patch };
    if (patch.distanceColors !== undefined && this.simplifiedMesh.geometry.getAttribute('position')) {
      if (patch.distanceColors) {
        this.simplifiedMesh.geometry.setAttribute('color', patch.distanceColors);
      }
    }
    this.applyState();
  }

  getState(): ViewerState {
    return { ...this.state };
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** 供检查点标记等附属对象挂载的场景（只读引用） */
  get sceneRoot(): THREE.Scene {
    return this.scene;
  }

  /** 返回简化网格对象，供 raycast 点击拾取使用 */
  getSimplifiedObject(): THREE.Mesh {
    return this.simplifiedMesh;
  }

  private applyState(): void {
    // 具体的逐视口可见性在 frame() 里按模式再裁剪，这里只同步材质
    this.originalWire.visible = this.state.wireframe;
    this.simplifiedWire.visible = this.state.wireframe;
    const overlay = this.state.viewMode === 'overlay';
    this.originalMesh.material = overlay
      ? this.overlayOriginalMaterial
      : this.originalMaterial;
  }

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    // 视口模式切换时宽高比由 frame() 按视口宽度分别设置
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 把归一化设备坐标（相对容器）转成 Ray，供点击检查。
   * 两个视口共用同一相机，只需用点击位置对应的视口宽高修正 NDC。
   */
  pickRay(clientX: number, clientY: number): THREE.Ray {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const split = this.state.viewMode === 'split';
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    let ndcX: number;
    if (split) {
      const halfWidth = rect.width / 2;
      const inLeft = localX < halfWidth;
      // 左视口只显示原始网格，点击检查只在右视口（简化结果）生效，
      // 但仍返回正确的射线；调用方负责限定右半区。
      const xInViewport = inLeft ? localX : localX - halfWidth;
      ndcX = (xInViewport / halfWidth) * 2 - 1;
    } else {
      ndcX = (localX / rect.width) * 2 - 1;
    }
    const ndcY = -(localY / rect.height) * 2 + 1;
    const ray = new THREE.Ray();
    this.camera.updateMatrixWorld();
    ray.origin.setFromMatrixPosition(this.camera.matrixWorld);
    ray.direction.set(ndcX, ndcY, 0.5).unproject(this.camera).sub(ray.origin).normalize();
    return ray;
  }

  /** 点击是否落在 split 模式的右视口（简化结果）内 */
  isSimplifiedViewport(clientX: number): boolean {
    if (this.state.viewMode !== 'split') return true;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return clientX - rect.left >= rect.width / 2;
  }

  /**
   * 对简化网格做射线拾取。只在简化结果可见的视口生效；
   * 点空（背景/线框缝隙外）返回 null，由调用方决定不生成检查点。
   */
  pickSimplified(clientX: number, clientY: number): THREE.Intersection | null {
    if (!this.simplifiedMesh.geometry.getAttribute('position')) return null;
    if (this.state.viewMode === 'split' && !this.isSimplifiedViewport(clientX)) return null;
    const ray = this.pickRay(clientX, clientY);
    const hits = this.raycastMesh(ray);
    return hits.length > 0 ? hits[0] : null;
  }

  private raycastMesh(ray: THREE.Ray): THREE.Intersection[] {
    const raycaster = new THREE.Raycaster();
    raycaster.ray.copy(ray);
    raycaster.params.Line = { threshold: 0 };
    const intersections: THREE.Intersection[] = [];
    this.simplifiedMesh.raycast(raycaster, intersections);
    return intersections;
  }

  private frame(): void {
    this.controls.update();
    this.applyState();
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    const w = size.x;
    const h = size.y;
    this.renderer.clear();

    if (this.state.viewMode === 'split') {
      const halfW = Math.floor(w / 2);
      this.camera.aspect = halfW / h;
      this.camera.updateProjectionMatrix();

      // 左视口：仅原始网格（同一相机、同一坐标刻度）
      this.originalMesh.visible = true;
      this.originalMesh.material = this.originalMaterial;
      this.originalWire.visible = this.state.wireframe;
      this.simplifiedMesh.visible = false;
      this.simplifiedWire.visible = false;
      this.renderer.setScissorTest(true);
      this.renderer.setViewport(0, 0, halfW, h);
      this.renderer.setScissor(0, 0, halfW, h);
      this.renderer.render(this.scene, this.camera);

      // 右视口：仅简化结果
      this.originalMesh.visible = false;
      this.originalWire.visible = false;
      this.simplifiedMesh.visible = true;
      this.simplifiedWire.visible = this.state.wireframe;
      this.renderer.setViewport(halfW, 0, w - halfW, h);
      this.renderer.setScissor(halfW, 0, w - halfW, h);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setScissorTest(false);
    } else {
      // 叠加视口：简化实体 + 原始半透明
      this.originalMesh.visible = true;
      this.originalMesh.material = this.overlayOriginalMaterial;
      this.originalWire.visible = false;
      this.simplifiedMesh.visible = true;
      this.simplifiedWire.visible = this.state.wireframe;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setViewport(0, 0, w, h);
      this.renderer.setScissorTest(false);
      this.renderer.render(this.scene, this.camera);
    }
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.renderer.setAnimationLoop(null);
    this.controls.dispose();
    this.originalMesh.geometry.dispose();
    this.simplifiedMesh.geometry.dispose();
    this.originalWire.geometry.dispose();
    this.simplifiedWire.geometry.dispose();
    this.originalMaterial.dispose();
    this.simplifiedMaterial.dispose();
    this.overlayOriginalMaterial.dispose();
    (this.originalWire.material as THREE.Material).dispose();
    (this.simplifiedWire.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
