import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface PickResult {
  index: number;
  point: [number, number, number];
}

/**
 * Three.js 点云查看器:
 * - Points + 顶点色 (密度/深度/标签/重叠四种着色共用一个 color attribute)
 * - localClippingEnabled 控制剖切; 标记球关闭剖切, 保证被切掉但仍参与统计的邻点可见
 * - raycaster 拾取, OrbitControls 提供旋转/缩放/平移
 */
export class PointViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private points: THREE.Points | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.PointsMaterial;
  private clipPlane: THREE.Plane;
  private clipHelper: THREE.Mesh;
  private markerGroup = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private resizeObserver: ResizeObserver;
  private container: HTMLElement;
  private pickCb: ((r: PickResult | null) => void) | null = null;
  private cameraIdleCb: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      55,
      container.clientWidth / container.clientHeight,
      0.05,
      100,
    );
    this.camera.position.set(4.5, 3.2, 5.5);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    this.scene.background = new THREE.Color(0x10131a);
    this.scene.add(new THREE.AxesHelper(1.2));
    this.scene.add(this.markerGroup);

    this.material = new THREE.PointsMaterial({
      size: 0.055,
      vertexColors: true,
      sizeAttenuation: true,
      clippingPlanes: [],
    });

    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const helperGeo = new THREE.PlaneGeometry(8, 8);
    const helperMat = new THREE.MeshBasicMaterial({
      color: 0xffe066,
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.clipHelper = new THREE.Mesh(helperGeo, helperMat);
    this.clipHelper.visible = false;
    this.scene.add(this.clipHelper);

    this.raycaster.params.Points = { threshold: 0.09 };

    this.controls.addEventListener('end', () => this.cameraIdleCb?.());
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.animate();
  }

  onPick(cb: (r: PickResult | null) => void): void {
    this.pickCb = cb;
  }

  onCameraIdle(cb: () => void): void {
    this.cameraIdleCb = cb;
  }

  /** 相机视线方向 (世界坐标, 从相机指向场景) */
  viewDirection(): [number, number, number] {
    const v = new THREE.Vector3();
    this.camera.getWorldDirection(v);
    return [v.x, v.y, v.z];
  }

  /** 每个点在相机空间的深度 (正值, 越大越远) */
  viewDepths(positions: Float32Array): Float32Array {
    const n = positions.length / 3;
    const out = new Float32Array(n);
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      p.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      p.applyMatrix4(this.camera.matrixWorldInverse);
      out[i] = -p.z;
    }
    return out;
  }

  setPointCloud(
    positions: Float32Array,
    bounds: { min: number[]; max: number[] },
    reframe = false,
  ): void {
    if (this.points) {
      this.scene.remove(this.points);
      this.geometry?.dispose();
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const rgb = new Uint8Array(positions.length);
    this.geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    this.geometry.computeBoundingSphere();
    this.points = new THREE.Points(this.geometry, this.material);
    this.scene.add(this.points);
    if (reframe) this.frameCamera(bounds);
  }

  setColors(rgb: Uint8Array): void {
    if (!this.geometry) return;
    const attr = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    (attr.array as Uint8Array).set(rgb);
    attr.needsUpdate = true;
  }

  setClip(enabled: boolean, axis: 0 | 1 | 2, plane: number): void {
    const normal = new THREE.Vector3();
    normal.setComponent(axis, 1);
    // Plane: n·x + c >= 0 保留, 即 n·x >= plane
    this.clipPlane.normal.copy(normal);
    this.clipPlane.constant = -plane;
    this.material.clippingPlanes = enabled ? [this.clipPlane] : [];
    this.clipHelper.visible = enabled;
    if (enabled) {
      this.clipHelper.position.setComponent(axis, plane);
      this.clipHelper.rotation.set(0, 0, 0);
      if (axis === 0) this.clipHelper.rotation.y = Math.PI / 2;
      if (axis === 2) this.clipHelper.rotation.x = Math.PI / 2;
    }
  }

  clearMarkers(): void {
    while (this.markerGroup.children.length) {
      const child = this.markerGroup.children.pop()!;
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    }
  }

  /**
   * 高亮选中点及其邻域。
   * @param center 中心点世界坐标
   * @param neighbors 实际参与统计的邻点坐标 (含中心)
   * @param hidden 被剖切隐藏但仍参与统计的邻点坐标
   */
  showNeighborhood(
    center: [number, number, number],
    neighbors: Array<[number, number, number]>,
    hidden: Array<[number, number, number]>,
  ): void {
    this.clearMarkers();
    const make = (color: number, size: number, pts: Array<[number, number, number]>, cap: number) => {
      if (!pts.length) return;
      const geo = new THREE.SphereGeometry(size, 10, 8);
      const mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(pts.length, cap));
      const m = new THREE.Matrix4();
      pts.forEach((p, i) => {
        m.makeTranslation(p[0], p[1], p[2]);
        mesh.setMatrixAt(i, m);
      });
      mesh.count = pts.length;
      mesh.renderOrder = 10;
      this.markerGroup.add(mesh);
    };
    make(0x39ff7a, 0.05, neighbors, 1);
    make(0xff4dff, 0.05, hidden, 1);
    const centerMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xffe600, depthTest: false }),
    );
    centerMesh.position.set(...center);
    centerMesh.renderOrder = 11;
    this.markerGroup.add(centerMesh);
  }

  private frameCamera(bounds: { min: number[]; max: number[] }): void {
    const center = new THREE.Vector3();
    for (let d = 0; d < 3; d++) center.setComponent(d, (bounds.min[d] + bounds.max[d]) / 2);
    const span = Math.max(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    );
    const dir = new THREE.Vector3(0.8, 0.55, 1).normalize();
    this.camera.position.copy(center).addScaledVector(dir, span * 1.5);
    this.controls.target.copy(center);
    this.controls.update();
  }

  private onPointerDown = (event: PointerEvent): void => {
    // 拖拽 (OrbitControls) 不触发拾取: 记录位移, pointerup 时判定
    const startX = event.clientX;
    const startY = event.clientY;
    const up = (ev: PointerEvent) => {
      this.renderer.domElement.removeEventListener('pointerup', up);
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) return;
      this.pickAt(ev);
    };
    this.renderer.domElement.addEventListener('pointerup', up);
  };

  private pickAt(event: PointerEvent): void {
    if (!this.points) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(mouse, this.camera);
    const hits = this.raycaster.intersectObject(this.points, false);
    if (!hits.length) {
      this.pickCb?.(null);
      return;
    }
    const idx = hits[0].index ?? 0;
    const p = hits[0].point;
    this.pickCb?.({ index: idx, point: [p.x, p.y, p.z] });
  }

  /** 立即刷新一次深度着色所需的相机矩阵 */
  updateCameraMatrix(): void {
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
  }

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.geometry?.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
