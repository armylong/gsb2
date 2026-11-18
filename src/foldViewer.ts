/**
 * 三维纸模视图（Three.js）。
 * 负责：刚体姿态网格、铰链/裁切边、平面方向标记（贴在面外侧）、点击拾取、三种相机视角。
 */
import * as THREE from 'three';
import type { BuiltModel, FoldFace } from './types';
import { evaluateFold, worldPoints, worldNormal, type FacePose } from './geometry';
import { FACE_COLORS } from './netRenderer';

export type ViewMode = 'orbit' | 'root' | 'top';

export class FoldViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private model: BuiltModel | null = null;
  private group = new THREE.Group();
  private edgeGroup = new THREE.Group();
  private meshes = new Map<string, THREE.Mesh>();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private poses: Map<string, FacePose> = new Map();
  private progress = 0;
  private overrides = new Map<string, number>();
  private selectedId: string | null = null;
  private viewMode: ViewMode = 'orbit';
  onPick: ((id: string | null) => void) | null = null;

  // 轨道控制状态
  private orbit = { theta: 0.6, phi: 1.05, radius: 12, target: new THREE.Vector3() };
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private downX = 0;
  private downY = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.scene.background = new THREE.Color('#0f1420');
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(6, 10, 8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    fill.position.set(-8, -4, -6);
    this.scene.add(fill);
    this.scene.add(this.group);
    this.scene.add(this.edgeGroup);

    this.bindControls();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.animate();
  }

  private bindControls() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.downX = e.clientX;
      this.downY = e.clientY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.orbit.theta -= dx * 0.008;
      this.orbit.phi = THREE.MathUtils.clamp(
        this.orbit.phi - dy * 0.008,
        0.15,
        Math.PI - 0.15,
      );
    });
    c.addEventListener('pointerup', (e) => {
      this.dragging = false;
      // 按下与抬起几乎同位置才视为点击，避免旋转轨道时误拾取
      if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) < 5) {
        this.pick(e);
      }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.orbit.radius = THREE.MathUtils.clamp(this.orbit.radius * (1 + e.deltaY * 0.001), 4, 60);
    }, { passive: false });
  }

  private pick(e: MouseEvent) {
    if (!this.model) return;
    const r = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.meshes.values()], false);
    if (hits.length) this.onPick?.((hits[0].object.userData.faceId as string) ?? null);
    else this.onPick?.(null);
  }

  setModel(model: BuiltModel) {
    this.model = model;
    this.selectedId = null;
    this.overrides.clear();
    this.group.clear();
    this.edgeGroup.clear();
    this.meshes.clear();

    for (const f of model.faces) {
      const geo = this.buildFaceGeometry(f);
      const mat = new THREE.MeshStandardMaterial({
        color: this.faceColor(f.id),
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
        roughness: 0.55,
        metalness: 0.05,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.faceId = f.id;
      mesh.matrixAutoUpdate = false;
      mesh.add(this.buildFaceMarker(f));
      this.group.add(mesh);
      this.meshes.set(f.id, mesh);
    }
    this.buildEdgeObjects();
    this.fitCameraToModel();
    this.refresh();
  }

  /**
   * 面标记（本面局部帧内，随 mesh 矩阵一起刚动）：
   * 编号文字 + 沿“首边中点→面心”的不对称箭头 + 偏心点，与 2D 展开图标记同源，
   * 折叠后可直接核对朝向是否正确（无反面朝外/整片镜像）。
   */
  private buildFaceMarker(f: FoldFace): THREE.Group {
    const g = new THREE.Group();
    const pts = f.flatLocalPoints;
    const center = pts.reduce((a, b) => a.clone().add(b), new THREE.Vector3())
      .multiplyScalar(1 / pts.length);
    const edgeMid = pts[0].clone().add(pts[1]).multiplyScalar(0.5);
    const dir = center.clone().sub(edgeMid).normalize();
    const size = Math.max(0.12, center.distanceTo(edgeMid) * 0.32);

    // 编号（用精灵贴图，始终面向相机，且随面位于正确一侧）
    const label = this.makeLabelSprite(f.id);
    label.position.copy(center).add(new THREE.Vector3(0, 0, 0.02));
    const scale = size * 2.2;
    label.scale.set(scale, scale, 1);
    g.add(label);

    // 不对称箭头（细圆柱 + 圆锥），位于面 +Z 一侧，折叠后指向随之刚动
    const start = edgeMid.clone().add(dir.clone().multiplyScalar(size * 0.4));
    const end = center.clone().add(dir.clone().multiplyScalar(-size * 0.5));
    const arrow = new THREE.ArrowHelper(
      dir,
      start,
      start.distanceTo(end),
      0xffffff,
      size * 0.5,
      size * 0.32,
    );
    arrow.traverse((o) => { o.position.z += 0.02; });
    g.add(arrow);

    // 偏心点：靠近首边，强化非对称
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(size * 0.18, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    dot.position.copy(edgeMid.clone().lerp(center, 0.3)).add(new THREE.Vector3(0, 0, 0.02));
    g.add(dot);
    return g;
  }

  private makeLabelSprite(text: string): THREE.Sprite {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(15,20,32,0.85)';
    ctx.beginPath();
    ctx.arc(64, 64, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 56px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 64, 68);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 10;
    return sprite;
  }

  private faceColor(id: string): number {
    const idx = this.model!.def.faces.findIndex((f) => f.id === id);
    return new THREE.Color(FACE_COLORS[idx % FACE_COLORS.length]).getHex();
  }

  /** 用本面局部平面点构造 BufferGeometry（位置在局部帧，姿态由 mesh 矩阵承担）。 */
  private buildFaceGeometry(f: FoldFace): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    const verts: number[] = [];
    // 三角扇（凸多边形：立方体/棱柱侧面/三角形均为凸面）
    const pts = f.flatLocalPoints;
    for (let i = 1; i < pts.length - 1; i++) {
      for (const p of [pts[0], pts[i], pts[i + 1]]) {
        verts.push(p.x, p.y, p.z);
      }
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.computeVertexNormals();
    return geo;
  }

  /** 铰链边（实线粗管）与裁切边（虚线），随面姿态更新。 */
  private buildEdgeObjects() {
    const hingeMat = new THREE.LineBasicMaterial({ color: 0xffb020, linewidth: 2 });
    const cutMat = new THREE.LineDashedMaterial({ color: 0xff5d73, dashSize: 0.18, gapSize: 0.12 });
    const hingeSet = new Set(this.model!.hingeEdges.map((h) => h.key));
    for (const f of this.model!.def.faces) {
      const ids = f.targetVertexIds;
      for (let i = 0; i < ids.length; i++) {
        const va = ids[i];
        const vb = ids[(i + 1) % ids.length];
        const key = va < vb ? `${va}-${vb}` : `${vb}-${va}`;
        const geo = new THREE.BufferGeometry();
        const line = new THREE.Line(geo, hingeSet.has(key) ? hingeMat.clone() : cutMat.clone());
        line.userData = { faceId: f.id, va, vb, isHinge: hingeSet.has(key) };
        this.edgeGroup.add(line);
      }
    }
  }

  setProgress(p: number) {
    this.progress = p;
    this.refresh();
  }

  setOverride(faceId: string | null, angleRad: number | null) {
    if (!faceId) return;
    if (angleRad === null) this.overrides.delete(faceId);
    else this.overrides.set(faceId, angleRad);
    this.refresh();
  }

  clearOverrides() {
    this.overrides.clear();
    this.refresh();
  }

  setSelected(id: string | null) {
    this.selectedId = id;
    this.refresh();
  }

  setViewMode(mode: ViewMode) {
    this.viewMode = mode;
    this.refresh();
  }

  /** 重新求解姿态并把矩阵写入 mesh / 边线 / 标记。 */
  refresh() {
    if (!this.model) return;
    this.poses = evaluateFold(this.model, this.progress, this.overrides);
    for (const f of this.model.faces) {
      const pose = this.poses.get(f.id)!;
      const mesh = this.meshes.get(f.id)!;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(pose.matrix);
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.emissive.setHex(this.selectedId === f.id ? 0x2a4d8f : 0x000000);
    }
    this.updateEdges();
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  private updateEdges() {
    for (const line of this.edgeGroup.children) {
      const { faceId, va, vb, isHinge } = line.userData as {
        faceId: string; va: number; vb: number; isHinge: boolean;
      };
      const f = this.model!.faceById.get(faceId)!;
      const fdef = this.model!.def.faces.find((d) => d.id === faceId)!;
      const wp = worldPoints(f, this.poses.get(faceId)!);
      const ia = fdef.targetVertexIds.indexOf(va);
      const ib = fdef.targetVertexIds.indexOf(vb);
      const geo = line as THREE.Line;
      geo.geometry.dispose();
      geo.geometry = new THREE.BufferGeometry().setFromPoints([wp[ia], wp[ib]]);
      if (!isHinge) geo.computeLineDistances();
    }
  }

  private fitCameraToModel() {
    const box = new THREE.Box3();
    for (const f of this.model!.faces) {
      for (const p of f.flatLocalPoints.map((l) => l.clone().applyMatrix4(f.flatMatrix))) {
        box.expandByPoint(p);
      }
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.orbit.target.copy(center);
    this.orbit.radius = Math.max(size * 0.9, 6);
  }

  private updateCamera() {
    if (this.viewMode === 'orbit') {
      const { theta, phi, radius, target } = this.orbit;
      this.camera.position.set(
        target.x + radius * Math.sin(phi) * Math.cos(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * Math.sin(phi) * Math.sin(theta),
      );
      this.camera.lookAt(target);
      return;
    }
    if (!this.model) return;
    const root = this.model.faces.find((f) => f.parentId === null)!;
    const rootPose = this.poses.get(root.id)!;
    const center = worldPoints(root, rootPose).reduce((a, b) => a.clone().add(b), new THREE.Vector3())
      .multiplyScalar(1 / root.flatLocalPoints.length);
    if (this.viewMode === 'root') {
      // 沿根面外法线正对根面
      const n = worldNormal(rootPose);
      this.camera.position.copy(center).add(n.multiplyScalar(this.orbit.radius * 0.7));
      this.camera.up.set(0, 0, 1);
      this.camera.lookAt(center);
    } else {
      // 展开俯视：沿 -Z 看平面
      this.camera.position.copy(center).add(new THREE.Vector3(0, 0, this.orbit.radius));
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(center);
    }
  }

  private resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.refresh();
  }

  private animate() {
    requestAnimationFrame(() => this.animate());
    // 统一在 RAF 中刷新：轨道交互、视角切换、外部进度更新都能即时呈现。
    if (this.model) this.refresh();
  }
}
