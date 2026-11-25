import {
  Color,
  GridHelper,
  Line,
  LineBasicMaterial,
  Mesh,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  BufferGeometry,
  AmbientLight,
  DirectionalLight,
  Group,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { PuppetView } from './puppet';

export class ViewerScene {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private trailGeo: BufferGeometry;
  private readonly trail: Line;
  private onPick: (name: string | null) => void = () => undefined;
  /** 世界坐标 -> 屏幕偏移（两只纸偶在场景中的横向站位） */
  readonly sourceOffset = new Vector3(-1.15, 0, 0);
  readonly targetOffset = new Vector3(1.15, 0, 0);

  constructor(container: HTMLElement) {
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = false;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new Color(0x1d2129);
    this.camera = new PerspectiveCamera(45, w / h, 0.01, 50);
    this.camera.position.set(2.4, 1.5, 3.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.9, 0);
    this.controls.enableDamping = true;

    const grid = new GridHelper(6, 30, 0x3d4653, 0x2a303a);
    grid.position.y = 0;
    this.scene.add(grid);

    const amb = new AmbientLight(0xffffff, 1.15);
    const key = new DirectionalLight(0xffffff, 1.8);
    key.position.set(2.5, 4, 2);
    const fill = new DirectionalLight(0xbfd8ff, 0.7);
    fill.position.set(-3, 2, -2);
    this.scene.add(amb, key, fill);

    this.trailGeo = new BufferGeometry().setFromPoints([new Vector3(0, -999, 0)]);
    this.trail = new Line(
      this.trailGeo,
      new LineBasicMaterial({ color: 0x66f0ff, linewidth: 2 }),
    );
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    this.scene.add(this.trail);

    this.renderer.domElement.addEventListener('pointerdown', (e) => this.handlePick(e));
    new ResizeObserver(() => this.resize(container)).observe(container);
  }

  addPuppet(view: PuppetView, offset: Vector3): void {
    view.group.position.copy(offset);
    this.scene.add(view.group);
  }

  setPickHandler(fn: (name: string | null) => void): void {
    this.onPick = fn;
  }

  private handlePick(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes: Mesh[] = [];
    const nameOf = new Map<Mesh, string>();
    this.scene.traverse((obj) => {
      if (obj instanceof Mesh) {
        const view = this.puppetOf(obj);
        if (view) {
          meshes.push(obj);
          nameOf.set(obj, view.name);
        }
      }
    });
    const hits = this.raycaster.intersectObjects(meshes, false);
    this.onPick(hits.length > 0 ? nameOf.get(hits[0].object as Mesh) ?? null : null);
  }

  private puppetOf(mesh: Mesh): { name: string } | null {
    // 关节球通过 userData 标记（在 attachPuppets 时统一设置）
    const name = mesh.userData.jointName as string | undefined;
    return name ? { name } : null;
  }

  attachPickMeshes(views: { view: PuppetView; prefix: string }[]): void {
    for (const { view, prefix } of views) {
      for (const { name, mesh } of view.pickMeshes()) {
        mesh.userData.jointName = `${prefix}:${name}`;
      }
    }
  }

  updateTrail(points: Vector3[]): void {
    this.trailGeo.dispose();
    this.trailGeo = new BufferGeometry().setFromPoints(points);
    this.trail.geometry = this.trailGeo;
    this.trail.visible = points.length > 0;
  }

  clearTrail(): void {
    this.trailGeo.dispose();
    this.trailGeo = new BufferGeometry().setFromPoints([new Vector3(0, -999, 0)]);
    this.trail.geometry = this.trailGeo;
    this.trail.visible = false;
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private resize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  addHelper(group: Group): void {
    this.scene.add(group);
  }
}
