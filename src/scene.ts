import * as THREE from 'three';
import { StereoRig } from './stereo';
import { CONVERGENCE_DOTS, GROUP_COLORS, MarkerDef, MarkerId } from './markers';

/** 生成始终面向相机的文字精灵 */
export function makeTextSprite(text: string, color = '#d7dde7', scale = 1): THREE.Sprite {
  const pad = 14;
  const font = '600 44px -apple-system, "PingFang SC", sans-serif';
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const w = Math.ceil(measure.measureText(text).width) + pad * 2;
  const h = 64;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = 'rgba(13,17,23,0.65)';
  ctx.roundRect(0, 0, w, h, 12);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, h / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  const k = 0.004 * scale;
  sprite.scale.set(w * k, h * k, 1);
  sprite.renderOrder = 999;
  return sprite;
}

export interface MarkerVisual {
  def: MarkerDef;
  mesh: THREE.Mesh;
  halo: THREE.Mesh;
  label: THREE.Sprite;
}

export class LabScene {
  readonly scene = new THREE.Scene();
  readonly rig: StereoRig;
  readonly markerVisuals = new Map<MarkerId, MarkerVisual>();
  readonly movable!: MarkerVisual;
  readonly helpers = new THREE.Group();

  private readonly convPlane: THREE.Mesh;
  private readonly convDots: THREE.Mesh[] = [];
  private readonly frustumLines: THREE.LineSegments;
  private readonly eyeGroups: Record<'left' | 'right', THREE.Group>;
  private readonly pickTargets: THREE.Object3D[] = [];
  private selectedId: MarkerId | null = null;

  constructor(rig: StereoRig, defs: MarkerDef[]) {
    this.rig = rig;
    this.scene.background = new THREE.Color(0x070a10);
    this.scene.fog = new THREE.Fog(0x070a10, 45, 110);

    // ---- 世界地面网格 + 世界坐标轴 ----
    const grid = new THREE.GridHelper(120, 60, 0x2b4a6f, 0x1a2738);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    grid.position.y = 0;
    this.scene.add(grid);

    const worldAxes = new THREE.AxesHelper(1.6);
    worldAxes.position.set(0, 0.02, 0);
    this.scene.add(worldAxes);
    const axesLabel = makeTextSprite('世界原点 XYZ', '#8b96a7', 0.8);
    axesLabel.position.set(2.2, 0.4, 0);
    this.scene.add(axesLabel);

    this.scene.add(this.rig.root);
    this.buildDepthRuler();

    // ---- 标记：全部挂在 rig.root 下，位置即 rig 局部坐标，并随姿态一起运动 ----
    for (const def of defs) {
      const visual = this.buildMarker(def);
      this.markerVisuals.set(def.id, visual);
      this.rig.root.add(visual.mesh, visual.halo, visual.label);
      this.pickTargets.push(visual.mesh);
      if (def.movable) {
        (this as { movable: MarkerVisual }).movable = visual;
      }
    }

    // ---- 辅助元素全部挂在 rig 下（随相机姿态移动） ----
    this.rig.root.add(this.helpers);

    // 相机自身坐标系小轴
    const rigAxes = new THREE.AxesHelper(0.9);
    rigAxes.position.set(0, 0, 0);
    this.helpers.add(rigAxes);

    // 会聚面
    const planeGeo = new THREE.PlaneGeometry(2, 2);
    const planeMat = new THREE.MeshBasicMaterial({
      color: GROUP_COLORS.mid, transparent: true, opacity: 0.07,
      side: THREE.DoubleSide, depthWrite: false,
    });
    // 会聚面（−Z 侧），平面默认法线朝 +Z，无需额外旋转即面向相机
    this.convPlane = new THREE.Mesh(planeGeo, planeMat);
    this.helpers.add(this.convPlane);
    const planeFrame = new THREE.LineSegments(
      new THREE.EdgesGeometry(planeGeo),
      new THREE.LineBasicMaterial({ color: GROUP_COLORS.mid, transparent: true, opacity: 0.8 }),
    );
    this.convPlane.add(planeFrame);
    const convLabel = makeTextSprite('会聚面 zc（零视差）', '#3fb950', 0.9);
    convLabel.position.set(0, 1.15, 0);
    this.convPlane.add(convLabel);

    // 会聚面参考点（零视差基准）
    const dotGeo = new THREE.SphereGeometry(0.09, 16, 12);
    for (const d of CONVERGENCE_DOTS) {
      const dot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: 0x9be8a6 }));
      dot.position.copy(d.offset);
      this.convPlane.add(dot);
      this.convDots.push(dot);
    }

    // 两眼视锥线
    this.frustumLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
    );
    this.helpers.add(this.frustumLines);

    // 眼位 gizmo
    this.eyeGroups = { left: this.buildEyeGizmo(0xff7b72, 'L'), right: this.buildEyeGizmo(0x58a6ff, 'R') };
    this.helpers.add(this.eyeGroups.left, this.eyeGroups.right);
  }

  private buildDepthRuler(): void {
    const x = -7;
    const pts: number[] = [];
    for (let d = 1; d <= 40; d++) {
      const major = d % 5 === 0;
      const len = major ? 0.55 : 0.25;
      // 前方为 −Z，刻度放在负 Z 上
      pts.push(x, 0.02, -d, x + len, 0.02, -d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0x6e8db4, transparent: true, opacity: 0.8 }),
    );
    this.rig.root.add(lines);
    for (let d = 5; d <= 40; d += 5) {
      const label = makeTextSprite(`${d}m`, '#8b96a7', 0.75);
      label.position.set(x - 0.55, 0.25, -d);
      this.rig.root.add(label);
    }
    const rulerName = makeTextSprite('深度刻度（前方 −Z，米）', '#8b96a7', 0.85);
    rulerName.position.set(x - 0.4, 0.5, -1.2);
    this.rig.root.add(rulerName);
  }

  private buildMarker(def: MarkerDef): MarkerVisual {
    const geo = new THREE.SphereGeometry(def.radius, 28, 20);
    const mat = new THREE.MeshStandardMaterial({
      color: def.color, emissive: def.color, emissiveIntensity: 0.25,
      roughness: 0.35, metalness: 0.1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(def.position);
    mesh.userData.markerId = def.id;

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(def.radius * 1.45, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0 }),
    );
    halo.position.copy(def.position);

    const label = makeTextSprite(def.label, `#${def.color.toString(16).padStart(6, '0')}`, 0.9);
    label.position.copy(def.position).add(new THREE.Vector3(0, def.radius + 0.42, 0));
    return { def, mesh, halo, label };
  }

  private buildEyeGizmo(color: number, tag: string): THREE.Group {
    const g = new THREE.Group();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.34, 20),
      new THREE.MeshBasicMaterial({ color }),
    );
    cone.rotation.x = Math.PI / 2; // 锥体指向 −Z（Three 相机观察方向）
    cone.position.z = -0.18;
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 16, 12),
      new THREE.MeshBasicMaterial({ color }),
    );
    const label = makeTextSprite(tag, `#${color.toString(16).padStart(6, '0')}`, 0.8);
    label.position.set(0, 0.28, 0);
    g.add(cone, ball, label);
    return g;
  }

  setHelpersVisible(v: boolean): void {
    this.helpers.visible = v;
  }

  setSelected(id: MarkerId | null): void {
    this.selectedId = id;
    for (const [mid, vis] of this.markerVisuals) {
      const selected = mid === id;
      (vis.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = selected ? 0.9 : 0.25;
      (vis.halo.material as THREE.MeshBasicMaterial).opacity = selected ? 0.9 : 0;
    }
  }

  getSelected(): MarkerId | null {
    return this.selectedId;
  }

  /** 刷新会聚面位置/尺寸与参考点 */
  updateConvergence(): void {
    const p = this.rig.params;
    const aspect = this.rig.getAspect();
    const tanHalfH = Math.tan(THREE.MathUtils.degToRad(p.fov) / 2);
    const halfW = p.convergence * tanHalfH;
    const halfH = halfW / aspect;
    // 相机看向 −Z：会聚面位于局部 z = −zc
    this.convPlane.position.set(0, 0, -p.convergence);
    this.convPlane.scale.set(halfW * 2, halfH * 2, 1);
  }

  /** 两眼 gizmo 位置 */
  updateEyeGizmos(): void {
    const s = this.rig.params.baseline / 2;
    this.eyeGroups.left.position.set(-s, 0, 0);
    this.eyeGroups.right.position.set(s, 0, 0);
    // 基线为 0 时仍保留两个标识，但稍微分开提示重叠
    const overlap = s < 1e-6;
    this.eyeGroups.left.visible = true;
    this.eyeGroups.right.visible = true;
    if (overlap) {
      this.eyeGroups.left.position.y = 0.12;
      this.eyeGroups.right.position.y = -0.12;
    }
  }

  /** 按当前参数/宽高比重建两眼视锥线（near/far 四角 + 连线） */
  updateFrustum(): void {
    const p = this.rig.params;
    const aspect = this.rig.getAspect();
    const vfov = THREE.MathUtils.degToRad(
      2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(p.fov) / 2) / aspect) * 180 / Math.PI,
    );
    const tanV = Math.tan(vfov / 2);
    const s = p.baseline / 2;
    const shift = (eye: 'left' | 'right') =>
      (eye === 'left' ? s : -s) * (p.near / p.convergence);

    const corners = (eye: 'left' | 'right') => {
      const ex = eye === 'left' ? -s : s;
      const sh = shift(eye);
      // depth 为正深度；视锥位于相机 −Z 侧，故局部坐标 z = −depth
      const at = (depth: number) => {
        const k = depth / p.near;
        const hw = p.near * tanV * aspect * k; // 半宽（正值）
        const hh = p.near * tanV * k;
        const cx = ex + sh * k;
        return [
          new THREE.Vector3(cx - hw, -hh, -depth),
          new THREE.Vector3(cx + hw, -hh, -depth),
          new THREE.Vector3(cx + hw, hh, -depth),
          new THREE.Vector3(cx - hw, hh, -depth),
        ];
      };
      return { near: at(p.near), far: at(p.far) };
    };

    const positions: number[] = [];
    const colors: number[] = [];
    const push = (a: THREE.Vector3, b: THREE.Vector3, hex: number) => {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      const c = new THREE.Color(hex);
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };

    for (const eye of ['left', 'right'] as const) {
      const hex = eye === 'left' ? 0xff7b72 : 0x58a6ff;
      const { near, far } = corners(eye);
      for (let i = 0; i < 4; i++) {
        push(near[i], near[(i + 1) % 4], hex);
        push(far[i], far[(i + 1) % 4], hex);
        push(near[i], far[i], hex);
      }
    }
    const geo = this.frustumLines.geometry;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
  }

  /** 可移动物体：按 rig 局部 (x, y, 正深度 depth) 定位到世界 */
  setMovableLocal(x: number, y: number, depth: number): void {
    const v = this.movable;
    const local = new THREE.Vector3(x, y, -depth);
    const world = this.rig.root.localToWorld(local.clone());
    v.mesh.position.copy(world);
    v.halo.position.copy(world);
    v.label.position.copy(world).add(new THREE.Vector3(0, v.def.radius + 0.45, 0));
    v.def.position.copy(world);
  }

  getMovableLocal(): THREE.Vector3 {
    return this.rig.root.worldToLocal(this.movable.mesh.position.clone());
  }

  /** 射线拾取标记；ndc 为相对指定眼视口的 [-1,1] 坐标 */
  pick(ndcX: number, ndcY: number, camera: THREE.Camera): MarkerId | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const hits = ray.intersectObjects(this.pickTargets, false);
    if (hits.length === 0) return null;
    return (hits[0].object.userData.markerId as MarkerId) ?? null;
  }

  /** 取可移动物体上用于拖动的平面（垂直于光轴、过球心） */
  movableDragPlane(): THREE.Plane {
    const normal = this.rig.forward();
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, this.movable.mesh.position);
  }

  allVisuals(): MarkerVisual[] {
    return [...this.markerVisuals.values()];
  }
}
