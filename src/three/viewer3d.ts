/**
 * 三维窗口：渲染三个不透明零件，接收 2D 图纸的点选结果并高亮
 * "原来的边 + 挡住它的零件"。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ViewDescriptor } from '../hlr/view.ts';
import type { Vec3 } from '../hlr/math3d.ts';

export interface HighlightRequest {
  edgeId: string;
  partId: string;
  worldA: Vec3;
  worldB: Vec3;
  occluderPartIds: string[];
}

export class Viewer3D {
  readonly renderer: THREE.WebGLRenderer | null;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera | null;
  readonly controls: OrbitControls | null;
  readonly webglAvailable: boolean;
  private readonly partObjects = new Map<string, THREE.Mesh>();
  private readonly highlightGroup = new THREE.Group();
  private readonly baseEmissive = new Map<string, THREE.Color>();
  private raf = 0;
  private disposed = false;

  constructor(container: HTMLElement, sampleGroup: THREE.Group) {
    const w = container.clientWidth || 720;
    const h = container.clientHeight || 620;

    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (err) {
      console.warn('WebGL 不可用，三维窗口降级为占位显示，二维出图功能不受影响：', err);
    }
    this.renderer = renderer;
    this.webglAvailable = renderer !== null;

    if (!renderer) {
      const note = document.createElement('div');
      note.style.cssText =
        'display:flex;align-items:center;justify-content:center;height:100%;' +
        'color:#7a8699;font-size:13px;text-align:center;padding:24px;';
      note.textContent = '当前环境不支持 WebGL，无法显示三维窗口；二维简图、点选数据与 SVG 往返仍可正常使用。';
      container.appendChild(note);
      this.camera = null;
      this.controls = null;
      // 场景图仍然建立，highlight 的零件信息可在恢复 WebGL 后使用
      sampleGroup.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          this.partObjects.set(mesh.name, mesh);
          const mat = mesh.material as THREE.MeshStandardMaterial;
          this.baseEmissive.set(mesh.name, mat.emissive.clone());
        }
      });
      this.scene.add(sampleGroup);
      this.scene.add(this.highlightGroup);
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.setClearColor(0xf4f6f9);
    container.appendChild(renderer.domElement);

    this.scene.background = new THREE.Color(0xf4f6f9);
    this.camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 200);
    this.camera.position.set(-6, 5, -8);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    const hemi = new THREE.HemisphereLight(0xffffff, 0xb8c0cc, 1.1);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(-5, 9, -6);
    this.scene.add(dir);

    this.scene.add(sampleGroup);
    sampleGroup.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        this.partObjects.set(mesh.name, mesh);
        const mat = mesh.material as THREE.MeshStandardMaterial;
        this.baseEmissive.set(mesh.name, mat.emissive.clone());
      }
    });

    this.scene.add(this.highlightGroup);
    this.fitCameraToScene();
    this.controls.target.set(0, 0, 0);
    this.controls.update();

    const resize = new ResizeObserver(() => this.resize(container));
    resize.observe(container);
    this.animate();
  }

  private animate = (): void => {
    if (this.disposed || !this.renderer || !this.camera || !this.controls) return;
    this.raf = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  /** 用 CSS 像素尺寸算宽高比（drawingbuffer 含像素比，不能直接用）。 */
  private aspect(): number {
    if (!this.renderer) return 1;
    const h = this.renderer.domElement.clientHeight || 1;
    return (this.renderer.domElement.clientWidth || 1) / h;
  }

  private resize(container: HTMLElement): void {
    if (!this.renderer || !this.camera) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    const aspect = w / h;
    const viewH = (this.camera.top - this.camera.bottom) / 2;
    const viewW = viewH * aspect;
    this.camera.left = -viewW;
    this.camera.right = viewW;
    this.camera.updateProjectionMatrix();
  }

  fitCameraToScene(): void {
    if (!this.camera || !this.controls) return;
    const box = new THREE.Box3().setFromObject(this.scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const aspect = this.aspect();
    const halfH = maxDim * 0.72;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.left = -halfH * aspect;
    this.camera.right = halfH * aspect;
    this.camera.near = 0.1;
    this.camera.far = 200;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
  }

  /** 切到某个出图视图（保持正交）。 */
  applyView(view: ViewDescriptor): void {
    if (!this.camera || !this.controls) return;
    this.camera.position.set(view.eye.x, view.eye.y, view.eye.z);
    this.controls.target.set(view.target.x, view.target.y, view.target.z);
    this.camera.up.set(view.up.x, view.up.y, view.up.z);
    const aspect = this.aspect();
    this.camera.top = view.halfHeight;
    this.camera.bottom = -view.halfHeight;
    this.camera.left = -view.halfHeight * aspect;
    this.camera.right = view.halfHeight * aspect;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** 导出当前相机姿态，供 2D 端按同样角度重算（停在相同角度）。 */
  currentViewDescriptor(name = 'custom'): ViewDescriptor {
    if (!this.camera || !this.controls) {
      // 无 WebGL 时返回一个默认斜视，避免调用方拿到空指针
      return {
        name,
        eye: { x: -6, y: 5, z: -8 },
        target: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 1, z: 0 },
        halfHeight: 4,
        aspect: 1
      };
    }
    const p = this.camera.position;
    const t = this.controls.target;
    const u = this.camera.up;
    const halfHeight = this.camera.top;
    const aspect = this.aspect();
    return {
      name,
      eye: { x: p.x, y: p.y, z: p.z },
      target: { x: t.x, y: t.y, z: t.z },
      up: { x: u.x, y: u.y, z: u.z },
      halfHeight,
      aspect
    };
  }

  /**
   * 高亮点选结果：
   *  - 原边画亮黄色粗线（带轻微外扩的深色衬线保证在浅色面上也可见）；
   *  - 遮挡零件整体加红色自发光；
   *  - 所属零件加青色边线。
   */
  highlight(req: HighlightRequest): void {
    this.clearHighlight();

    const a = new THREE.Vector3(req.worldA.x, req.worldA.y, req.worldA.z);
    const b = new THREE.Vector3(req.worldB.x, req.worldB.y, req.worldB.z);
    const geom = new THREE.BufferGeometry().setFromPoints([a, b]);

    const halo = new THREE.Line(
      geom,
      new THREE.LineBasicMaterial({ color: 0x222222, linewidth: 5, transparent: true, opacity: 0.35 })
    );
    const main = new THREE.Line(
      geom,
      new THREE.LineBasicMaterial({ color: 0xffd400, linewidth: 3 })
    );
    const group = new THREE.Group();
    group.add(halo, main);
    this.highlightGroup.add(group);

    for (const id of req.occluderPartIds) {
      const mesh = this.partObjects.get(id);
      if (mesh) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.emissive = new THREE.Color(0xd6382e);
        mat.emissiveIntensity = 0.55;
      }
    }

    const own = this.partObjects.get(req.partId);
    if (own) {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(own.geometry, 1),
        new THREE.LineBasicMaterial({ color: 0x0a7dff })
      );
      edges.position.copy(own.position);
      edges.quaternion.copy(own.quaternion);
      edges.scale.copy(own.scale);
      this.highlightGroup.add(edges);
    }
  }

  clearHighlight(): void {
    this.highlightGroup.traverse((obj) => {
      const o = obj as THREE.Line | THREE.LineSegments | THREE.Mesh;
      if (o.geometry) o.geometry.dispose();
      const mat = (o as THREE.Mesh).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    });
    this.highlightGroup.clear();
    for (const [name, mesh] of this.partObjects) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const base = this.baseEmissive.get(name);
      if (base) mat.emissive.copy(base);
      mat.emissiveIntensity = 1;
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.controls?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
  }
}
