import * as THREE from 'three';

/**
 * 指示牌朝向的纯数学部分。
 *
 * 三种朝向模式：
 * - FIXED    固定朝向：完全不动
 * - BILLBOARD 全向广告牌：法线对准镜头（上下左右都跟）
 * - Y_LOCKED 仅绕自身竖轴：只取水平方向，绕局部 +Y 转
 *
 * 关键设计：所有计算都在牌的“父节点局部空间”内完成，
 * 因此即使父级架子带旋转和缩放，行为依然正确，且锚点不动
 * （位置完全不参与这些函数，函数只写旋转）。
 */

export type FaceMode = 'FIXED' | 'BILLBOARD' | 'Y_LOCKED';

/** 水平距离 / 总距离 小于该值，认为视线与竖轴几乎平行（牌正上/正下方）。 */
export const YLOCK_UNDECIDABLE_RATIO = 0.08;
/** 全向模式下，法线与视线夹角进入该锥角内时保持上一姿态，避免临界点抖转。 */
export const BILLBOARD_HOLD_ANGLE = THREE.MathUtils.degToRad(2.5);

/** 把任意角度规范到 (-PI, PI]。 */
export function wrapPi(a: number): number {
  let r = a % (Math.PI * 2);
  if (r <= -Math.PI) r += Math.PI * 2;
  if (r > Math.PI) r -= Math.PI * 2;
  return r;
}

/** 帧率无关的阻尼系数：lambda 越大跟得越紧。 */
export function dampFactor(lambda: number, dt: number): number {
  return 1 - Math.exp(-lambda * dt);
}

/**
 * 跨 ±PI 边界仍然连续的偏航角滤波器。
 *
 * 用“最短角差”逼近目标角，绕圈时角度连续增长，不会在 180° 处跳变；
 * 进入无法决定朝向的区域（视线与竖轴平行）时调用 hold()，
 * 数值保持冻结，离开区域后从冻结值平滑过渡，杜绝一帧翻来翻去。
 */
export class YawFilter {
  private current: number;
  private hasTarget = true;

  constructor(initial = 0) {
    this.current = initial;
  }

  get value(): number {
    return this.current;
  }

  /** 直接设定（切换模式时用，不产生动画跳跃以外的位移）。 */
  set(v: number): void {
    this.current = v;
    this.hasTarget = true;
  }

  /** 进入竖轴奇点：冻结当前角度。 */
  hold(): void {
    /* current 保持不变 */
  }

  /** 朝目标偏航做最短路径阻尼逼近。 */
  approach(target: number, t: number): number {
    if (!this.hasTarget) {
      this.current = target;
      this.hasTarget = true;
      return this.current;
    }
    const delta = wrapPi(target - this.current);
    this.current += delta * t;
    return this.current;
  }
}

export interface YLockResult {
  /** 局部空间内绕 +Y 的目标偏航（atan2，连续由 YawFilter 保证）。 */
  yaw: number;
  /** 视线是否与竖轴几乎平行，此时 yaw 在几何上无法决定。 */
  undecidable: boolean;
  /** 水平距离占总距离的比例，供 UI 显示。 */
  ratio: number;
}

/**
 * 仅绕竖轴模式的目标偏航计算（父节点局部空间）。
 *
 * 牌面默认朝局部 +Z，绕 +Y 转 yaw 后其法线为 (sin yaw, 0, cos yaw)，
 * 令其等于视线水平归一化方向，得 yaw = atan2(dirX, dirZ)。
 *
 * @param localCameraPos 相机（或正交相机视线）在父局部空间的位置
 * @param localAnchor    牌锚点在父局部空间的位置
 */
export function computeYLockedYaw(
  localCameraPos: THREE.Vector3,
  localAnchor: THREE.Vector3,
): YLockResult {
  const dx = localCameraPos.x - localAnchor.x;
  const dy = localCameraPos.y - localAnchor.y;
  const dz = localCameraPos.z - localAnchor.z;
  const horizontal = Math.hypot(dx, dz);
  const total = Math.hypot(horizontal, dy);
  const ratio = total > 1e-9 ? horizontal / total : 0;
  const undecidable = ratio < YLOCK_UNDECIDABLE_RATIO;
  const yaw = horizontal > 1e-9 ? Math.atan2(dx, dz) : 0;
  return { yaw, undecidable, ratio };
}

/**
 * 全向广告牌模式：让牌面法线（局部 +Z）直接对准相机。
 *
 * 用 lookAt 的等价矩阵实现；当视线与局部竖轴平行（从牌正上/正下方看）时
 * lookAt 因 up 与视线同向而退化，此时返回 hold=true，由调用方保留上一帧
 * 姿态 —— 配合外层阻尼，穿过竖轴的过程中不会出现单帧翻转。
 *
 * @param out 写入结果的四元数
 * @returns true 表示当前帧几何退化，应保持上一姿态
 */
export function faceTargetQuaternion(
  out: THREE.Quaternion,
  localCameraPos: THREE.Vector3,
  localAnchor: THREE.Vector3,
  localUp: THREE.Vector3,
): boolean {
  const dir = _v1.copy(localCameraPos).sub(localAnchor);
  if (dir.lengthSq() < 1e-12) return true; // 相机正好压在锚点上，保持
  dir.normalize();

  const up = _v2.copy(localUp).normalize();
  if (Math.abs(dir.dot(up)) > 1 - Math.cos(BILLBOARD_HOLD_ANGLE)) {
    return true; // 视线与竖轴平行：退化带，保持上一姿态
  }

  // Matrix4.lookAt 是相机约定：局部 -Z 朝目标。牌面法线是 +Z，
  // 因此在结果上绕 Y 补 180°，让 +Z（牌面）对准相机。
  _m1.lookAt(_ZERO, dir, up);
  out.setFromRotationMatrix(_m1).multiply(_FLIP_Y);
  return false;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _ZERO = new THREE.Vector3(0, 0, 0);
const _FLIP_Y = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 1, 0),
  Math.PI,
);
