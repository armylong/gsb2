/**
 * Three.js 三维查看器。
 * 只负责把内核状态画出来: 门板/托板几何体、半透明扫掠体、障碍盒、
 * 接触点与法线高亮、铰链/托板轴标记、正交俯视/侧视。
 * 所有几何均用 three 内置几何体 (BoxGeometry / Sphere / ArrowHelper 等)。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Mechanism, Pose } from '../core/kinematics';
import type { LiveContact, ObstacleSpec } from '../core/collision';
import type { OBB, Vec3 } from '../core/math3d';
import { samplePartOBBs } from '../core/sweep';

export type ViewMode = 'perspective' | 'top' | 'side';

const toV3 = (p: Vec3): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2]);

interface SweepMesh {
  group: THREE.Group;
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private perspectiveCamera: THREE.PerspectiveCamera;
  private orthoCamera: THREE.OrthographicCamera;
  private controls: OrbitControls;
  private transform: TransformControls;
  private doorMesh: THREE.Mesh;
  private trayMesh: THREE.Mesh;
  private doorGroup = new THREE.Group();
  private trayPivot = new THREE.Group();
  private hingeMarker: THREE.Group;
  private trayAxisMarker: THREE.Group;
  private obstacleGroup = new THREE.Group();
  private sweepGroup = new THREE.Group();
  private contactGroup = new THREE.Group();
  private grid: THREE.GridHelper;
  private axes: THREE.AxesHelper;
  private view: ViewMode = 'perspective';
  private container: HTMLElement;
  private obstacleMeshes = new Map<string, THREE.Mesh>();
  private sweep: SweepMesh | null = null;
  private onObstacleDrag?: (id: string, center: Vec3) => void;
  private resizeObs: ResizeObserver;

  constructor(container: HTMLElement) {
    this.container = container;
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0xf4f6fa);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xf4f6fa);

    this.perspectiveCamera = new THREE.PerspectiveCamera(45, w / h, 1, 20000);
    this.perspectiveCamera.position.set(950, 780, 1250);

    const aspect = w / h;
    const frustum = 1700;
    this.orthoCamera = new THREE.OrthographicCamera(
      (-frustum * aspect) / 2,
      (frustum * aspect) / 2,
      frustum / 2,
      -frustum / 2,
      -5000,
      5000,
    );
    this.orthoCamera.position.set(150, 1000, 200);
    this.orthoCamera.lookAt(150, 0, 200);

    this.controls = new OrbitControls(this.perspectiveCamera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(150, 0, 200);

    this.transform = new TransformControls(this.perspectiveCamera, this.renderer.domElement);
    this.transform.setMode('translate');
    this.transform.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !(e.value as boolean);
    });
    this.transform.addEventListener('objectChange', () => {
      const obj = this.transform.object as THREE.Mesh | undefined;
      if (obj && this.onObstacleDrag) {
        const id = obj.userData.obstacleId as string;
        this.onObstacleDrag(id, [obj.position.x, obj.position.y, obj.position.z]);
      }
    });
    this.scene.add(this.transform.getHelper ? this.transform.getHelper() : (this.transform as unknown as THREE.Object3D));

    // 灯光
    const amb = new THREE.AmbientLight(0xffffff, 0.75);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(600, 900, 700);
    this.scene.add(amb, dir);

    // 网格与坐标轴 (网格在 X-Z 平面, 一格 50mm)
    this.grid = new THREE.GridHelper(2000, 40, 0x9aa4b2, 0xcdd5e0);
    this.grid.position.y = -460;
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(180);
    this.axes.position.set(-700, -460, -700);
    this.scene.add(this.axes);

    // 门板
    const doorMat = new THREE.MeshStandardMaterial({
      color: 0x2f7ed8,
      transparent: true,
      opacity: 0.92,
      roughness: 0.55,
    });
    this.doorMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), doorMat);
    const doorEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.01, 1.01, 1.01)),
      new THREE.LineBasicMaterial({ color: 0x16385f }),
    );
    this.doorMesh.add(doorEdges);
    this.doorGroup.add(this.doorMesh);
    this.scene.add(this.doorGroup);

    // 托板 (挂在门组下的铰链节点)
    const trayMat = new THREE.MeshStandardMaterial({
      color: 0xf08c2e,
      transparent: true,
      opacity: 0.92,
      roughness: 0.55,
    });
    this.trayMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), trayMat);
    const trayEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.01, 1.01, 1.01)),
      new THREE.LineBasicMaterial({ color: 0x8a4a12 }),
    );
    this.trayMesh.add(trayEdges);
    this.trayPivot.add(this.trayMesh);
    this.doorGroup.add(this.trayPivot);

    // 铰链标记
    this.hingeMarker = this.makeAxisMarker(0x111111, 60);
    this.scene.add(this.hingeMarker);
    this.trayAxisMarker = this.makeAxisMarker(0xb91c1c, 40);
    this.scene.add(this.trayAxisMarker);

    this.scene.add(this.obstacleGroup, this.sweepGroup, this.contactGroup);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
  }

  private makeAxisMarker(color: number, len: number): THREE.Group {
    const g = new THREE.Group();
    const cyl = new THREE.Mesh(
      new THREE.CylinderGeometry(4, 4, len, 16),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25 }),
    );
    g.add(cyl);
    const top = new THREE.Mesh(new THREE.SphereGeometry(8, 16, 12), new THREE.MeshStandardMaterial({ color }));
    top.position.y = len / 2;
    const bot = top.clone();
    bot.position.y = -len / 2;
    g.add(top, bot);
    return g;
  }

  setObstacleDragHandler(fn: (id: string, center: Vec3) => void): void {
    this.onObstacleDrag = fn;
  }

  setView(view: ViewMode): void {
    this.view = view;
    const target = new THREE.Vector3(150, 0, 200);
    if (view === 'perspective') {
      this.perspectiveCamera.position.set(950, 780, 1250);
      this.controls.object = this.perspectiveCamera;
      this.controls.enableRotate = true;
      this.controls.target.copy(target);
      this.perspectiveCamera.lookAt(target);
      this.controls.update();
      this.transform.camera = this.perspectiveCamera;
    } else if (view === 'top') {
      this.orthoCamera.position.set(target.x, 1400, target.z + 0.01);
      this.orthoCamera.up.set(0, 0, -1);
      this.orthoCamera.lookAt(target);
      this.controls.object = this.orthoCamera;
      this.controls.enableRotate = false;
      this.controls.target.copy(target);
      this.controls.update();
      this.transform.camera = this.orthoCamera;
    } else {
      this.orthoCamera.position.set(target.x + 0.01, target.y, target.z + 1400);
      this.orthoCamera.up.set(0, 1, 0);
      this.orthoCamera.lookAt(target);
      this.controls.object = this.orthoCamera;
      this.controls.enableRotate = false;
      this.controls.target.copy(target);
      this.controls.update();
      this.transform.camera = this.orthoCamera;
    }
  }

  /** 重建障碍盒几何 */
  syncObstacles(obstacles: ObstacleSpec[], selectedId: string | null): void {
    const seen = new Set<string>();
    for (const o of obstacles) {
      seen.add(o.id);
      let mesh = this.obstacleMeshes.get(o.id);
      if (!mesh) {
        const mat = new THREE.MeshStandardMaterial({
          color: 0x9aa4b2,
          transparent: true,
          opacity: 0.4,
          roughness: 0.7,
        });
        mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
        mesh.userData.obstacleId = o.id;
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(1.01, 1.01, 1.01)),
          new THREE.LineBasicMaterial({ color: 0x4b5563 }),
        );
        mesh.add(edges);
        this.obstacleGroup.add(mesh);
        this.obstacleMeshes.set(o.id, mesh);
      }
      mesh.position.set(o.center[0], o.center[1], o.center[2]);
      mesh.scale.set(o.size[0], o.size[1], o.size[2]);
      const selected = o.id === selectedId;
      (mesh.material as THREE.MeshStandardMaterial).color.set(selected ? 0xd97706 : 0x9aa4b2);
      (mesh.material as THREE.MeshStandardMaterial).opacity = selected ? 0.55 : 0.4;
    }
    for (const [id, mesh] of this.obstacleMeshes) {
      if (!seen.has(id)) {
        this.obstacleGroup.remove(mesh);
        this.obstacleMeshes.delete(id);
      }
    }
  }

  selectObstacle(id: string | null): void {
    if (id === null) {
      this.transform.detach();
      return;
    }
    const mesh = this.obstacleMeshes.get(id);
    if (mesh) this.transform.attach(mesh);
  }

  /** 按当前姿态更新门板/托板/铰链 */
  updatePose(m: Mechanism, pose: Pose): void {
    // 门板几何: 局部中心 (0,0, 宽/2), 尺寸 (厚, 高, 宽)
    this.doorMesh.scale.set(m.door.size[0], m.door.size[1], m.door.size[2]);
    this.doorMesh.position.set(0, 0, m.door.size[2] / 2);
    this.doorGroup.position.set(m.door.pivot[0], m.door.pivot[1], m.door.pivot[2]);
    this.doorGroup.rotation.set(0, pose.doorAngle, 0);

    // 托板铰链节点 (门局部坐标), 托板几何中心在节点 -y 方向半个板长处
    this.trayPivot.position.set(
      m.tray.hingeInDoor[0],
      m.tray.hingeInDoor[1],
      m.tray.hingeInDoor[2],
    );
    this.trayPivot.rotation.set(pose.trayAngle, 0, 0);
    this.trayMesh.scale.set(m.tray.size[0], m.tray.size[1], m.tray.size[2]);
    this.trayMesh.position.set(0, -m.tray.size[1] / 2, 0);

    this.hingeMarker.position.set(m.door.pivot[0], m.door.pivot[1], m.door.pivot[2]);
    this.trayAxisMarker.position.set(
      pose.trayHingeWorld[0],
      pose.trayHingeWorld[1],
      pose.trayHingeWorld[2],
    );
    this.trayAxisMarker.rotation.z = Math.PI / 2;
  }

  /** 重建扫掠体 (检查区间变化时调用, 立即收紧) */
  updateSweep(m: Mechanism, range: [number, number], samples: number): void {
    this.disposeSweep();
    const group = new THREE.Group();
    const sampled = samplePartOBBs(m, range, samples);
    const addSwept = (obbs: OBB[], color: number) => {
      const mat = new THREE.MeshStandardMaterial({
        color,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
        roughness: 0.6,
      });
      for (const o of obbs) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
        mesh.position.copy(toV3(o.center));
        mesh.scale.set(o.half[0] * 2, o.half[1] * 2, o.half[2] * 2);
        mesh.setRotationFromMatrix(
          new THREE.Matrix4().makeBasis(toV3(o.axes[0]), toV3(o.axes[1]), toV3(o.axes[2])),
        );
        group.add(mesh);
      }
    };
    addSwept(sampled.map((s) => s.door), 0x2f7ed8);
    addSwept(sampled.map((s) => s.tray), 0xf08c2e);
    this.sweepGroup.add(group);
    this.sweep = { group };
  }

  setSweepVisible(v: boolean): void {
    this.sweepGroup.visible = v;
  }

  private disposeSweep(): void {
    if (!this.sweep) return;
    this.sweepGroup.remove(this.sweep.group);
    this.sweep.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    this.sweep = null;
  }

  /** 当前姿态的接触点/法线高亮 */
  updateContacts(contacts: LiveContact[]): void {
    this.contactGroup.clear();
    for (const c of contacts) {
      const color = c.kind === 'grazing' ? 0xf59e0b : 0xdc2626;
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(10, 20, 16),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 }),
      );
      sphere.position.copy(toV3(c.point));
      this.contactGroup.add(sphere);
      const arrow = new THREE.ArrowHelper(
        toV3(c.normal).normalize(),
        toV3(c.point),
        Math.max(30, c.depth + 30),
        color,
        18,
        10,
      );
      this.contactGroup.add(arrow);
    }
  }

  /** 渲染一帧 */
  render(): void {
    this.controls.update();
    const cam = this.view === 'perspective' ? this.perspectiveCamera : this.orthoCamera;
    this.renderer.render(this.scene, cam);
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.perspectiveCamera.aspect = w / h;
    this.perspectiveCamera.updateProjectionMatrix();
    const aspect = w / h;
    const frustum = 1700;
    this.orthoCamera.left = (-frustum * aspect) / 2;
    this.orthoCamera.right = (frustum * aspect) / 2;
    this.orthoCamera.top = frustum / 2;
    this.orthoCamera.bottom = -frustum / 2;
    this.orthoCamera.updateProjectionMatrix();
  }

  dispose(): void {
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
