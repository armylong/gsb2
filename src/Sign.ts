import * as THREE from 'three';
import {
  YawFilter,
  computeYLockedYaw,
  faceTargetQuaternion,
  dampFactor,
  type FaceMode,
} from './orientation';
import { makeSignTexture, type SignTextureSpec } from './textures';

export type SizeMode = 'WORLD' | 'SCREEN';

/** 屏幕尺寸牌最大只允许占到视口高度的这个比例，防止盖住整屏。 */
const MAX_VIEWPORT_RATIO = 0.35;
/** 近裁面安全淡入距离（相对 near 的倍数）。 */
const NEAR_FADE_MULT = 2.0;

/** 牌当前的安全状态，供 HUD 展示。 */
export type SafetyState = 'OK' | 'NEAR' | 'CLIPPED' | 'BEHIND' | 'CLAMPED';

export interface SignOptions {
  id: string;
  label: string;
  texture: SignTextureSpec;
  /** 牌面世界单位尺寸（WORLD 模式即真实尺寸） */
  width: number;
  height: number;
  faceMode: FaceMode;
  sizeMode: SizeMode;
  /** 锚点在父节点局部空间的位置（构造后不再改变） */
  anchor: THREE.Vector3;
  parent: THREE.Object3D;
  /** FIXED 姿态的初始偏航/俯仰（弧度） */
  fixedYaw?: number;
  fixedTilt?: number;
  /** SCREEN 模式下目标占视口高度的比例 */
  screenRatio?: number;
}

const MODE_COLORS: Record<FaceMode, number> = {
  FIXED: 0x9aa7b8,
  BILLBOARD: 0x35d0ba,
  Y_LOCKED: 0xffb020,
};

/**
 * 一块指示牌。
 *
 * 层级：group(锚点，位置只在构造时设定) → pivot(朝向) → holder(缩放) → mesh(牌面)
 * 切换朝向模式只改 pivot 的旋转，group.position 永不变化，因此锚点不会跑。
 */
export class Sign {
  readonly id: string;
  readonly label: string;
  readonly group = new THREE.Group();
  readonly pivot = new THREE.Group();
  readonly holder = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;

  faceMode: FaceMode;
  sizeMode: SizeMode;
  safety: SafetyState = 'OK';
  undecidable = false;
  /** 最近一帧的水平距离占比，UI 用 */
  lastRatio = 1;

  private readonly baseHeight: number;
  private readonly targetScreenRatio: number;
  private readonly fixedQuat = new THREE.Quaternion();
  private readonly yawFilter = new YawFilter();
  private readonly targetQuat = new THREE.Quaternion();
  private readonly anchorMarker: THREE.Mesh;
  private readonly axisLine: THREE.Line;
  private readonly normalLine: THREE.Line;
  private readonly normalCone: THREE.Mesh;

  // 复用临时对象，避免每帧分配
  private static _camLocal = new THREE.Vector3();
  private static _anchorLocal = new THREE.Vector3();
  private static _upLocal = new THREE.Vector3();
  private static _parentInv = new THREE.Matrix4();
  private static _camSpace = new THREE.Vector3();
  private static _parentScale = new THREE.Vector3();

  constructor(opts: SignOptions) {
    this.id = opts.id;
    this.label = opts.label;
    this.faceMode = opts.faceMode;
    this.sizeMode = opts.sizeMode;
    this.baseHeight = opts.height;
    this.targetScreenRatio = opts.screenRatio ?? 0.22;

    const texture = makeSignTexture(opts.texture);
    this.material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: true,
    });
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(opts.width, opts.height),
      this.material,
    );
    this.mesh.userData.signId = opts.id;

    this.holder.add(this.mesh);
    this.pivot.add(this.holder);
    this.group.add(this.pivot);
    this.group.position.copy(opts.anchor);
    opts.parent.add(this.group);

    // FIXED 姿态（仅用于 FIXED 模式，切换回去时精确恢复）
    this.fixedQuat.setFromEuler(
      new THREE.Euler(opts.fixedTilt ?? 0, opts.fixedYaw ?? 0, 0),
    );
    this.pivot.quaternion.copy(this.fixedQuat);
    this.yawFilter.set(opts.fixedYaw ?? 0);

    // 锚点标记：一个小球，证明模式切换时锚点不动
    this.anchorMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    this.group.add(this.anchorMarker);

    // 竖轴参考线（穿过锚点）
    this.axisLine = this.makeLine(
      new THREE.Vector3(0, -opts.height * 0.75, 0),
      new THREE.Vector3(0, opts.height * 0.75, 0),
      0xcccccc,
    );
    this.group.add(this.axisLine);

    // 牌面法线参考线（局部 +Z 方向）
    this.normalLine = this.makeLine(
      new THREE.Vector3(0, 0, 0.02),
      new THREE.Vector3(0, 0, 1.3),
      MODE_COLORS[opts.faceMode],
    );
    this.normalCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.08, 0.24, 12),
      new THREE.MeshBasicMaterial({ color: MODE_COLORS[opts.faceMode] }),
    );
    this.normalCone.rotation.x = Math.PI / 2;
    this.normalCone.position.set(0, 0, 1.42);
    this.pivot.add(this.normalLine, this.normalCone);
  }

  private makeLine(a: THREE.Vector3, b: THREE.Vector3, color: number): THREE.Line {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    return new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }),
    );
  }

  setFaceMode(mode: FaceMode): void {
    if (mode === this.faceMode) return;
    this.faceMode = mode;
    if (mode === 'FIXED') {
      this.pivot.quaternion.copy(this.fixedQuat);
    } else if (mode === 'Y_LOCKED') {
      // 从当前可视姿态的偏航接续，避免切换瞬间跳变
      this.yawFilter.set(this.pivot.rotation.y);
    }
    // BILLBOARD 直接以当前 quaternion 为起点 slerp，无需处理
    const color = MODE_COLORS[mode];
    (this.normalLine.material as THREE.LineBasicMaterial).color.setHex(color);
    (this.normalCone.material as THREE.MeshBasicMaterial).color.setHex(color);
  }

  setSizeMode(mode: SizeMode): void {
    this.sizeMode = mode;
  }

  setReferenceVisible(visible: boolean): void {
    this.axisLine.visible = visible;
    this.normalLine.visible = visible;
    this.normalCone.visible = visible;
    this.anchorMarker.visible = visible;
  }

  setHighlight(on: boolean): void {
    this.anchorMarker.scale.setScalar(on ? 1.8 : 1);
    (this.anchorMarker.material as THREE.MeshBasicMaterial).color.setHex(
      on ? 0xff5a5a : 0xffffff,
    );
  }

  /** 牌面法线（世界空间），供场景画参考线/调试。 */
  getWorldNormal(out: THREE.Vector3): THREE.Vector3 {
    return out
      .set(0, 0, 1)
      .applyQuaternion(this.pivot.getWorldQuaternion(new THREE.Quaternion()));
  }

  /** 当前 holder 缩放（1 = 基础尺寸），供端到端断言“不盖住整屏”。 */
  get currentScale(): number {
    return this.holder.scale.x;
  }

  /** 牌面基础高度（世界单位），与 currentScale 相乘得到当前世界高度。 */
  get baseHeightValue(): number {
    return this.baseHeight;
  }

  /**
   * 每帧更新：先按模式约束朝向，再按尺寸模式缩放，最后做近裁面/背后安全处理。
   */
  update(camera: THREE.Camera, dt: number): void {
    const parent = this.group.parent!;
    parent.updateWorldMatrix(true, false);
    Sign._parentInv.copy(parent.matrixWorld).invert();

    Sign._camLocal.copy((camera as THREE.PerspectiveCamera).position).applyMatrix4(
      Sign._parentInv,
    );
    Sign._anchorLocal.copy(this.group.position);
    Sign._upLocal.set(0, 1, 0);

    const t = dampFactor(10, dt);

    switch (this.faceMode) {
      case 'FIXED':
        this.pivot.quaternion.copy(this.fixedQuat);
        this.undecidable = false;
        break;
      case 'Y_LOCKED': {
        const r = computeYLockedYaw(Sign._camLocal, Sign._anchorLocal);
        this.lastRatio = r.ratio;
        this.undecidable = r.undecidable;
        if (r.undecidable) {
          this.yawFilter.hold(); // 奇点：角度冻结，不翻转
        } else {
          this.yawFilter.approach(r.yaw, t);
        }
        this.pivot.rotation.set(0, this.yawFilter.value, 0);
        break;
      }
      case 'BILLBOARD': {
        const hold = faceTargetQuaternion(
          this.targetQuat,
          Sign._camLocal,
          Sign._anchorLocal,
          Sign._upLocal,
        );
        this.undecidable = hold;
        if (!hold) this.pivot.quaternion.slerp(this.targetQuat, t);
        // hold 时保持上一姿态
        break;
      }
    }

    // 竖轴参考线颜色：奇点时变红，明确提示“此处无法决定朝向”
    const axisMat = this.axisLine.material as THREE.LineBasicMaterial;
    axisMat.color.setHex(this.undecidable ? 0xff2a2a : 0xcccccc);

    this.updateScaleAndSafety(camera);
  }

  private updateScaleAndSafety(camera: THREE.Camera): void {
    const worldAnchor = Sign._camSpace;
    this.group.getWorldPosition(worldAnchor);
    const camInv = camera.matrixWorldInverse;
    const viewPos = _v.copy(worldAnchor).applyMatrix4(camInv);
    // 相机空间中 -z 为前方
    const depth = -viewPos.z;
    const near = (camera as THREE.PerspectiveCamera).near ?? 0.1;

    // 1) 背后 / 近裁面安全
    if (depth <= 0) {
      this.setVisibility(false, 1);
      this.safety = 'BEHIND';
      this.holder.scale.setScalar(1);
      return;
    }
    if (depth <= near) {
      this.setVisibility(false, 1);
      this.safety = 'CLIPPED';
      this.holder.scale.setScalar(1);
      return;
    }

    let clamped = false;
    let s = 1;
    if (this.sizeMode === 'SCREEN') {
      const viewHeight = this.getViewWorldHeight(camera, depth);
      // 父级（架子等）的世界缩放会与 holder 缩放相乘，钳制时必须除掉，
      // 否则架子放大时牌的实际屏幕占比会突破 35% 上限
      const parentScaleY: number = Sign._parentScale
        .set(0, 1, 0)
        .applyMatrix4(this.group.parent!.matrixWorld)
        .length();
      const maxS =
        (MAX_VIEWPORT_RATIO * viewHeight) / (this.baseHeight * parentScaleY);
      s = (this.targetScreenRatio * viewHeight) / (this.baseHeight * parentScaleY);
      if (s > maxS) {
        s = maxS;
        clamped = true;
      }
      // 额外硬上限，避免极端参数下出现巨型牌
      const hardMax = 8 / parentScaleY;
      if (s > hardMax) {
        s = hardMax;
        clamped = true;
      }
    }
    this.holder.scale.setScalar(s);

    // 近裁面附近淡入（两种尺寸模式都生效）
    const fadeRange = near * NEAR_FADE_MULT;
    const opacity = THREE.MathUtils.clamp((depth - near) / (fadeRange - near), 0.15, 1);
    const visible = opacity > 0.15;
    this.setVisibility(visible, opacity);
    this.safety = !visible
      ? 'CLIPPED'
      : depth < fadeRange
        ? 'NEAR'
        : clamped
          ? 'CLAMPED'
          : 'OK';
  }

  /** 给定深度处，整个视口对应的世界高度。 */
  private getViewWorldHeight(camera: THREE.Camera, depth: number): number {
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const persp = camera as THREE.PerspectiveCamera;
      return 2 * depth * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2);
    }
    const ortho = camera as THREE.OrthographicCamera;
    return (ortho.top - ortho.bottom) / ortho.zoom;
  }

  private setVisibility(visible: boolean, opacity: number): void {
    this.mesh.visible = visible;
    this.material.opacity = opacity;
    // 参考线独立可见，不随牌面淡出
  }
}

const _v = new THREE.Vector3();
