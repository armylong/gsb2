/**
 * viewer.ts —— 三维环境内观察视图(three.js)
 *
 * 场景组成:
 *  - 半径很大的反转立方盒,盒内表面贴程序化六面图 —— 环境在世界中固定不动
 *  - PMREM 处理同套六面图作为 PBR 环境贴图:镜面球与斜面金属件的反射
 *    完全由实际表面法线决定(环境不是贴在物体上的图案)
 *  - TransformControls 转物体、OrbitControls 转相机,二者独立
 *  - 检查点:表面标记 + 入射/反射射线,射线末端即命中的环境面
 *  - 选中的共享边在立方盒对应棱上高亮
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
  FACE_ORDER, GRID, SHARED_EDGES,
  reflect as mathReflect, sampleEnvironment, vnorm,
  type FaceId, type FaceEdge, type TransformMap, type EnvironmentHit, type Vec3,
} from './facemath';
import { createChamferedObject } from './geometry';

const CUBE_RADIUS = 50;

export interface Checkpoint {
  id: number;
  target: 'mirror' | 'chamfer';
  localPoint: Vec3;
  localNormal: Vec3;
  note: string;
}

export interface CheckpointReadout {
  cp: Checkpoint;
  worldPoint: Vec3;
  worldNormal: Vec3;
  incident: Vec3;
  reflection: Vec3;
  hit: EnvironmentHit;
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private orbit: OrbitControls;
  private transform: TransformControls;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envBox: THREE.Mesh | null = null;
  private mirror: THREE.Mesh;
  private chamfer = createChamferedObject();
  private checkpoints: Checkpoint[] = [];
  private cpGroup = new THREE.Group();
  private edgeGroup = new THREE.Group();
  private raycasters: THREE.Raycaster;
  private faceCanvases: Record<FaceId, HTMLCanvasElement>;
  private transforms: TransformMap;
  private onPick: ((r: CheckpointReadout[]) => void) | null = null;
  private onSelectionChange: ((obj: 'mirror' | 'chamfer') => void) | null = null;
  private downPos = { x: 0, y: 0 };
  private nextCpId = 1;

  constructor(container: HTMLElement, transforms: TransformMap,
    faces: Record<FaceId, HTMLCanvasElement>) {
    this.transforms = transforms;
    this.faceCanvases = faces;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      55, container.clientWidth / container.clientHeight, 0.1, 500);
    this.camera.position.set(4.2, 3.0, 4.6);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.target.set(0, 0, 0);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    // 世界坐标轴
    const axes = new THREE.AxesHelper(1.6);
    (axes.material as THREE.LineBasicMaterial).depthTest = false;
    axes.renderOrder = 999;
    this.scene.add(axes);
    const grid = new THREE.GridHelper(8, 16, 0x556070, 0x2c3440);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    grid.position.y = -1.25;
    this.scene.add(grid);

    // 镜面球
    const mirrorMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, metalness: 1, roughness: 0.02, envMapIntensity: 1.1,
    });
    this.mirror = new THREE.Mesh(new THREE.SphereGeometry(0.85, 64, 48), mirrorMat);
    this.mirror.position.set(-1.7, -0.4, 0.4);
    this.mirror.name = 'mirror';
    this.scene.add(this.mirror);

    // 斜面非对称物体
    this.chamfer.mesh.position.set(1.1, 0, -0.2);
    this.chamfer.edges.position.copy(this.chamfer.mesh.position);
    this.scene.add(this.chamfer.mesh, this.chamfer.edges);

    // 变换控制器(只转物体;镜面球旋转无视觉差异,选中时收起 gizmo)
    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setMode('rotate');
    this.transform.size = 0.9;
    this.transform.attach(this.chamfer.mesh);
    this.transform.addEventListener('dragging-changed', (ev) => {
      this.orbit.enabled = !ev.value;
    });
    this.transform.addEventListener('objectChange', () => {
      this.chamfer.edges.position.copy(this.chamfer.mesh.position);
      this.chamfer.edges.quaternion.copy(this.chamfer.mesh.quaternion);
      this.refreshReadouts();
    });
    const helper = this.transform.getHelper ? this.transform.getHelper() : (this.transform as unknown as THREE.Object3D);
    this.scene.add(helper);

    this.scene.add(this.cpGroup, this.edgeGroup);
    this.raycasters = new THREE.Raycaster();

    this.rebuildEnvironment();
    this.bindPointer();

    const ro = new ResizeObserver(() => this.resize(container));
    ro.observe(container);
  }

  /* ---------------- 环境贴图 ---------------- */

  rebuildEnvironment(): void {
    const images = FACE_ORDER.map((f) => this.faceCanvases[f]);
    const tex = new THREE.CubeTexture(images);
    tex.mapping = THREE.CubeReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;

    // 背景:反转立方盒(固定在世界中),CubeTexture 必须走 envMap 通道
    if (this.envBox) {
      this.scene.remove(this.envBox);
      this.envBox.geometry.dispose();
      (this.envBox.material as THREE.Material).dispose();
    }
    if (this.envRT) this.envRT.dispose();
    const boxGeo = new THREE.BoxGeometry(CUBE_RADIUS * 2, CUBE_RADIUS * 2, CUBE_RADIUS * 2);
    const boxMat = new THREE.MeshBasicMaterial({
      envMap: tex, side: THREE.BackSide, toneMapped: false,
    });
    this.envBox = new THREE.Mesh(boxGeo, boxMat);
    this.scene.add(this.envBox);

    // PBR 环境(与背景同源,保证反射与背景一致)
    this.envRT = this.pmrem.fromCubemap(tex);
    this.scene.environment = this.envRT.texture;
  }

  updateFaceCanvases(faces: Record<FaceId, HTMLCanvasElement>): void {
    this.faceCanvases = faces;
    this.rebuildEnvironment();
  }

  /* ---------------- 选择与旋转 ---------------- */

  selectObject(which: 'mirror' | 'chamfer'): void {
    // 镜面球旋转不改变外观,选中它时收起旋转 gizmo,避免误以为环境在跟着转
    if (which === 'mirror') this.transform.detach();
    else this.transform.attach(this.chamfer.mesh);
    this.onSelectionChange?.(which);
  }

  setOnSelectionChange(cb: (obj: 'mirror' | 'chamfer') => void): void { this.onSelectionChange = cb; }

  /** UI 滑块直接设物体旋转(弧度) */
  setObjectRotation(x: number, y: number, z: number): void {
    const obj = this.chamfer.mesh;
    obj.rotation.set(x, y, z);
    this.chamfer.edges.quaternion.copy(obj.quaternion);
    this.refreshReadouts();
  }

  getObjectRotation(): Vec3 {
    const r = this.chamfer.mesh.rotation;
    return [r.x, r.y, r.z];
  }

  resetObjectRotation(): void {
    this.chamfer.mesh.rotation.set(0, 0, 0);
    this.chamfer.mesh.position.set(1.1, 0, -0.2);
    this.chamfer.edges.position.copy(this.chamfer.mesh.position);
    this.chamfer.edges.quaternion.copy(this.chamfer.mesh.quaternion);
    this.refreshReadouts();
  }

  /* ---------------- 相机 ---------------- */

  setCameraView(pos: Vec3, up: Vec3): void {
    this.camera.up.set(up[0], up[1], up[2]);
    this.camera.position.set(pos[0], pos[1], pos[2]);
    this.orbit.target.set(0, 0, 0);
    this.orbit.update();
  }

  resetCamera(): void {
    this.setCameraView([4.2, 3.0, 4.6], [0, 1, 0]);
  }

  private resize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /* ---------------- 检查点 ---------------- */

  setOnPick(cb: (r: CheckpointReadout[]) => void): void { this.onPick = cb; }

  clearCheckpoints(): void {
    this.checkpoints = [];
    this.cpGroup.clear();
    this.onPick?.([]);
  }

  addCheckpoint(localPoint: Vec3, localNormal: Vec3, note = '手动检查点',
    target: 'mirror' | 'chamfer' = 'chamfer'): void {
    this.checkpoints.push({ id: this.nextCpId++, target, localPoint, localNormal, note });
    this.rebuildCheckpointMarkers();
    this.refreshReadouts();
  }

  setCheckpoints(list: { localPoint: Vec3; localNormal: Vec3; note: string; target?: 'mirror' | 'chamfer' }[]): void {
    this.checkpoints = list.map((c) => ({
      id: this.nextCpId++, target: c.target ?? 'chamfer',
      localPoint: c.localPoint, localNormal: c.localNormal, note: c.note,
    }));
    this.rebuildCheckpointMarkers();
    this.refreshReadouts();
  }

  private targetObject(t: 'mirror' | 'chamfer'): THREE.Object3D {
    return t === 'mirror' ? this.mirror : this.chamfer.mesh;
  }

  getReadouts(): CheckpointReadout[] {
    return this.checkpoints.map((cp) => {
      const obj = this.targetObject(cp.target);
      const wp = obj.localToWorld(new THREE.Vector3(...cp.localPoint));
      const wn = new THREE.Vector3(...cp.localNormal)
        .applyQuaternion(obj.quaternion).normalize();
      const incident = vnorm([
        this.camera.position.x - wp.x,
        this.camera.position.y - wp.y,
        this.camera.position.z - wp.z,
      ]);
      const reflection = mathReflect(incident, [wn.x, wn.y, wn.z]);
      const hit = sampleEnvironment(reflection, this.transforms);
      return {
        cp,
        worldPoint: [wp.x, wp.y, wp.z],
        worldNormal: [wn.x, wn.y, wn.z],
        incident,
        reflection,
        hit,
      };
    });
  }

  refreshReadouts(): void {
    this.rebuildCheckpointMarkers();
    this.onPick?.(this.getReadouts());
  }

  private rebuildCheckpointMarkers(): void {
    this.cpGroup.clear();
    for (const cp of this.checkpoints) {
      const obj = this.targetObject(cp.target);
      const wp = obj.localToWorld(new THREE.Vector3(...cp.localPoint));
      const wn = new THREE.Vector3(...cp.localNormal).applyQuaternion(obj.quaternion).normalize();
      const incident = vnorm([
        this.camera.position.x - wp.x,
        this.camera.position.y - wp.y,
        this.camera.position.z - wp.z,
      ]);
      const refl = mathReflect(incident, [wn.x, wn.y, wn.z]);

      // 表面标记
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false }),
      );
      marker.position.copy(wp);
      marker.renderOrder = 1000;
      this.cpGroup.add(marker);

      // 法线短线(绿)
      this.cpGroup.add(this.makeLine(
        wp, wp.clone().addScaledVector(wn, 0.55), 0x57d9a3));
      // 入射线(白,半透明)
      this.cpGroup.add(this.makeLine(
        wp, new THREE.Vector3(...incident).multiplyScalar(1.4).add(wp), 0xffffff, 0.55));
      // 反射射线(红),一直画到立方盒壁
      const end = this.rayToCubeWall(wp, refl);
      this.cpGroup.add(this.makeLine(wp, end, 0xff4d4d, 1));
      // 命中点环
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.22, 0.34, 32),
        new THREE.MeshBasicMaterial({ color: 0xff4d4d, side: THREE.DoubleSide, depthTest: false }),
      );
      ring.position.copy(end);
      ring.lookAt(wp);
      ring.renderOrder = 1000;
      this.cpGroup.add(ring);
    }
  }

  private rayToCubeWall(from: THREE.Vector3, dir: Vec3): THREE.Vector3 {
    // 求 from + t·dir 到达 |分量|=CUBE_RADIUS 的最小正 t
    let t = Infinity;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(dir[i]) < 1e-9) continue;
      const t1 = (CUBE_RADIUS - from.getComponent(i)) / dir[i];
      const t2 = (-CUBE_RADIUS - from.getComponent(i)) / dir[i];
      for (const cand of [t1, t2]) if (cand > 0) t = Math.min(t, cand);
    }
    return from.clone().addScaledVector(new THREE.Vector3(...dir), t);
  }

  private makeLine(a: THREE.Vector3, b: THREE.Vector3, color: number, opacity = 1): THREE.Line {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: false });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 999;
    return line;
  }

  /* ---------------- 共享边 3D 高亮 ---------------- */

  highlightSharedEdge(edge: FaceEdge | null): void {
    this.edgeGroup.clear();
    if (!edge) return;
    const se = SHARED_EDGES.find((s) =>
      (s.a.face === edge.face && s.a.side === edge.side)
      || (s.b.face === edge.face && s.b.side === edge.side));
    if (!se) return;
    for (const e of [se.a, se.b]) {
      const p0 = this.edgeEndpoint(e, 0);
      const p1 = this.edgeEndpoint(e, GRID);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([p0, p1]),
        new THREE.LineBasicMaterial({ color: 0xffd23f, linewidth: 3 }),
      );
      this.edgeGroup.add(line);
    }
  }

  private edgeEndpoint(e: FaceEdge, tick: number): THREE.Vector3 {
    // 与 facemath.edgePoint 同构,映射到立方盒半径
    const def = {
      px: { d: [1, 0, 0], r: [0, 0, -1], u: [0, 1, 0] },
      nx: { d: [-1, 0, 0], r: [0, 0, 1], u: [0, 1, 0] },
      py: { d: [0, 1, 0], r: [1, 0, 0], u: [0, 0, -1] },
      ny: { d: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] },
      pz: { d: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] },
      nz: { d: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0] },
    }[e.face];
    const t = tick / GRID * 2 - 1;
    const p = new THREE.Vector3(...def.d);
    const rv = new THREE.Vector3(...def.r);
    const uv = new THREE.Vector3(...def.u);
    if (e.side === 'left') p.addScaledVector(rv, -1);
    if (e.side === 'right') p.addScaledVector(rv, 1);
    if (e.side === 'top') p.addScaledVector(uv, -1);
    if (e.side === 'bottom') p.addScaledVector(uv, 1);
    const tan = (e.side === 'left' || e.side === 'right') ? uv : rv;
    p.addScaledVector(tan, t);
    return p.multiplyScalar(CUBE_RADIUS);
  }

  /* ---------------- 点击拾取检查点 ---------------- */

  private bindPointer(): void {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (ev) => {
      this.downPos = { x: ev.clientX, y: ev.clientY };
    });
    dom.addEventListener('pointerup', (ev) => {
      const moved = Math.hypot(ev.clientX - this.downPos.x, ev.clientY - this.downPos.y);
      if (moved > 6) return; // 拖拽轨道,不算点击
      if (this.transform.dragging || this.transform.axis !== null) return;
      this.pick(ev);
    });
  }

  private pick(ev: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycasters.setFromCamera(ndc, this.camera);
    const hits = this.raycasters.intersectObjects([this.mirror, this.chamfer.mesh], false);
    if (!hits.length) return;
    const hit = hits[0];
    if (hit.object === this.mirror) {
      this.selectObject('mirror');
      // 球面法线 = 命中点相对球心方向(世界系),球无旋转,局部法线相同
      const localPoint = this.mirror.worldToLocal(hit.point.clone());
      const n = localPoint.clone().normalize();
      this.addCheckpoint(
        [localPoint.x, localPoint.y, localPoint.z],
        [n.x, n.y, n.z],
        '镜面球拾取', 'mirror',
      );
      return;
    }
    this.selectObject('chamfer');
    const n = hit.face!.normal.clone();
    // 斜面物体的几何法线即物体局部法线
    const localPoint = this.chamfer.mesh.worldToLocal(hit.point.clone());
    const localNormal = n.clone().applyQuaternion(
      this.chamfer.mesh.quaternion.clone().invert());
    this.addCheckpoint(
      [localPoint.x, localPoint.y, localPoint.z],
      [localNormal.x, localNormal.y, localNormal.z],
      '点击拾取', 'chamfer',
    );
  }

  /* ---------------- 渲染循环 ---------------- */

  /** 调试用:按视口比例坐标做一次射线检测,返回命中对象名 */
  debugRaycast(fx: number, fy: number): string[] {
    const ndc = new THREE.Vector2(fx * 2 - 1, -(fy) * 2 + 1);
    this.raycasters.setFromCamera(ndc, this.camera);
    return this.raycasters.intersectObjects([this.mirror, this.chamfer.mesh], false)
      .map((h) => `${h.object.name}@${h.point.toArray().map((v) => v.toFixed(2)).join(',')}`);
  }

  start(): void {
    const loop = (): void => {
      this.orbit.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }
}
