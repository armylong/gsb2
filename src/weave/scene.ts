import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  type WeaveState,
  mod,
  warpCenterY,
  weftCenterY,
} from './weaveMath';
import { buildFabricGeometry, computeLayout, makeFiberTexture, buildTileBounds } from './fabric';

export interface PickResult {
  /** 循环内的组织格列号/行号 */
  i: number;
  j: number;
  /** 实际命中的是第几次重复（从 0 开始） */
  repX: number;
  repZ: number;
  /** 命中点在该重复内的局部坐标，便于高亮 */
  globalW: number;
  globalF: number;
}

export class FabricScene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly fabricGroup = new THREE.Group();
  private readonly fiberTex: THREE.CanvasTexture;
  private fabricMesh: THREE.Mesh | null = null;
  private bounds: THREE.LineSegments | null = null;
  private marker: THREE.Mesh;
  private queued = false;

  constructor(private readonly container: HTMLElement, private state: WeaveState) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x11161d);
    this.camera = new THREE.PerspectiveCamera(
      42,
      container.clientWidth / container.clientHeight,
      0.05,
      200,
    );
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(4, 8, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 40;
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x302a26, 0.85));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    // 接影平面，放在布下方
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.ShadowMaterial({ opacity: 0.32 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.fiberTex = makeFiberTexture();
    this.scene.add(this.fabricGroup);

    // 定位标记：小圆环，贴在交叉点表面
    this.marker = new THREE.Mesh(
      new THREE.TorusGeometry(0.16, 0.025, 10, 32),
      new THREE.MeshBasicMaterial({ color: 0xff3fb4 }),
    );
    this.marker.rotation.x = Math.PI / 2;
    this.marker.visible = false;
    this.scene.add(this.marker);

    this.rebuild(true);
    this.loop();

    const ro = new ResizeObserver(() => this.onResize());
    ro.observe(container);
  }

  updateState(state: WeaveState): void {
    this.state = state;
    this.rebuild(false);
  }

  setBoundsVisible(v: boolean): void {
    if (this.bounds) this.bounds.visible = v;
  }

  private rebuild(initial: boolean): void {
    if (this.fabricMesh) {
      this.fabricGroup.remove(this.fabricMesh);
      this.fabricMesh.geometry.dispose();
      (this.fabricMesh.material as THREE.Material).dispose();
    }
    if (this.bounds) {
      this.fabricGroup.remove(this.bounds);
      this.bounds.geometry.dispose();
      (this.bounds.material as THREE.Material).dispose();
    }

    const geo = buildFabricGeometry(this.state);
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.0,
      bumpMap: this.fiberTex,
      bumpScale: 0.035,
      roughnessMap: this.fiberTex,
    });
    this.fabricMesh = new THREE.Mesh(geo, mat);
    this.fabricMesh.castShadow = true;
    this.fabricMesh.receiveShadow = true;
    this.fabricGroup.add(this.fabricMesh);

    this.bounds = buildTileBounds(this.state);
    this.bounds.visible = true;
    this.fabricGroup.add(this.bounds);

    if (initial) this.frameCamera();
  }

  /** 按当前布的包围盒取景，并保持倾斜观察角度（斜着看才是这个工具的目的） */
  frameCamera(): void {
    const box = new THREE.Box3().setFromObject(this.fabricGroup);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z);
    const dist = span * 1.15 + 2;
    this.camera.position.set(center.x + dist * 0.55, center.y + dist * 0.75, center.z + dist * 0.62);
    this.controls.target.copy(center);
    this.controls.update();
  }

  /**
   * 点击拾取：射线与 y=0 的数学平面求交，再按间距反算全局线号。
   * 不依赖任何网格命中，所以视角旋转、粗细改变后定位仍然准确。
   */
  pick(clientX: number, clientY: number): PickResult | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);

    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;

    const { model, yarn } = this.state;
    const layout = computeLayout(this.state);
    if (hit.x < layout.xMin || hit.x > layout.xMax || hit.z < layout.zMin || hit.z > layout.zMax) {
      return null;
    }

    // 世界坐标 → 全局线号（四舍五入到最近的交叉点）
    const g = Math.round((hit.x + layout.cx) / yarn.warp.spacing);
    const h = Math.round((hit.z + layout.cz) / yarn.weft.spacing);
    if (g < 0 || g >= layout.nW || h < 0 || h >= layout.nF) return null;

    const i = mod(g, model.sizeW);
    const j = mod(h, model.sizeF);
    const repX = Math.floor(g / model.sizeW);
    const repZ = Math.floor(h / model.sizeF);

    // 标记放到该交叉点的实际布面顶端（按当前组织/粗细实时计算）
    const x = g * yarn.warp.spacing - layout.cx;
    const z = h * yarn.weft.spacing - layout.cz;
    const cell = model.matrix[i * model.sizeF + j];
    const topY =
      cell === 1
        ? warpCenterY(model, yarn, i, z) + yarn.warp.radius
        : weftCenterY(model, yarn, j, x) + yarn.weft.radius;
    this.marker.position.set(x, topY + 0.03, z);
    this.marker.visible = true;
    const s = Math.max(0.6, Math.min(1.6, (yarn.warp.radius + yarn.weft.radius) / 0.4));
    this.marker.scale.setScalar(s);

    return { i, j, repX, repZ, globalW: g, globalF: h };
  }

  hideMarker(): void {
    this.marker.visible = false;
  }

  /** 当前布面里实际生成的物理线数量（经+纬），供测试核对 */
  yarnCount(): number {
    return computeLayout(this.state).nW + computeLayout(this.state).nF;
  }

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private loop(): void {
    this.controls.addEventListener('change', () => this.requestRender());
    this.requestRender();
  }

  private requestRender(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }
}
