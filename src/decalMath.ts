import * as THREE from 'three';

/**
 * 投射几何的纯数学部分:应用(着色器 uniform 计算)与验证(vitest / 页面内自检)
 * 共用这一份实现,保证「验证所依据的公式」与「画面所用的公式」一致。
 */

/** 投影机参数。投影画面固定为正方形(aspect = 1)。 */
export interface ProjectorParams {
  position: [number, number, number];
  lookAt: [number, number, number];
  fovDeg: number;
  near: number;
  far: number;
}

export const PROJECTOR_ASPECT = 1;

/** 目标变换快照(导出/导入与确认记录用)。 */
export interface TransformSnapshot {
  position: [number, number, number];
  rotationEuler: [number, number, number]; // XYZ 顺序,弧度
  scale: [number, number, number];
}

export function snapshotTransform(obj: THREE.Object3D): TransformSnapshot {
  return {
    position: [obj.position.x, obj.position.y, obj.position.z],
    rotationEuler: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
    scale: [obj.scale.x, obj.scale.y, obj.scale.z],
  };
}

export function applySnapshot(obj: THREE.Object3D, t: TransformSnapshot): void {
  obj.position.fromArray(t.position);
  obj.rotation.set(t.rotationEuler[0], t.rotationEuler[1], t.rotationEuler[2], 'XYZ');
  obj.scale.fromArray(t.scale);
  obj.updateMatrixWorld(true);
}

export function composeMatrix(t: TransformSnapshot): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(t.rotationEuler[0], t.rotationEuler[1], t.rotationEuler[2], 'XYZ'),
  );
  return new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(t.position),
    q,
    new THREE.Vector3().fromArray(t.scale),
  );
}

/** 参数合法性校验;返回错误信息数组,空数组表示合法。 */
export function validateProjector(p: ProjectorParams): string[] {
  const errs: string[] = [];
  const nums = [...p.position, ...p.lookAt, p.fovDeg, p.near, p.far];
  if (!nums.every(Number.isFinite)) errs.push('存在非法数字');
  if (!(p.fovDeg >= 5 && p.fovDeg <= 150)) errs.push('张角需在 5° ~ 150° 之间');
  if (!(p.near > 0.01)) errs.push('近端需大于 0.01');
  if (!(p.far > p.near + 0.01)) errs.push('远端需大于近端 +0.01');
  const d = Math.hypot(
    p.position[0] - p.lookAt[0],
    p.position[1] - p.lookAt[1],
    p.position[2] - p.lookAt[2],
  );
  if (d < 1e-3) errs.push('投影器位置与朝向目标点不能重合');
  return errs;
}

/** 透视投影矩阵(与着色器中使用的裁剪矩阵一致)。 */
export function projectionMatrix(p: ProjectorParams): THREE.Matrix4 {
  const top = p.near * Math.tan(THREE.MathUtils.degToRad(p.fovDeg) / 2);
  const right = top * PROJECTOR_ASPECT;
  return new THREE.Matrix4().makePerspective(-right, right, top, -top, p.near, p.far);
}

/** 投影机世界矩阵(位置 + 朝向,相机惯例:沿 -Z 方向看)。 */
export function projectorWorldMatrix(p: ProjectorParams): THREE.Matrix4 {
  const eye = new THREE.Vector3().fromArray(p.position);
  const tgt = new THREE.Vector3().fromArray(p.lookAt);
  const rot = new THREE.Matrix4().lookAt(eye, tgt, new THREE.Vector3(0, 1, 0));
  return rot.setPosition(eye);
}

/** 视图矩阵 = 投影机世界矩阵的逆。 */
export function viewMatrix(p: ProjectorParams): THREE.Matrix4 {
  return projectorWorldMatrix(p).invert();
}

/**
 * 冻结贴花矩阵:局部坐标 -> 投影机裁剪坐标。
 * 确认时取 M = P · V · Model(confirm);之后目标怎么动,同一局部点算出的
 * 贴花 UV 不变,即贴花固定在目标表面。
 */
export function frozenDecalMatrix(
  p: ProjectorParams,
  modelAtConfirm: THREE.Matrix4,
): THREE.Matrix4 {
  return projectionMatrix(p).multiply(viewMatrix(p)).multiply(modelAtConfirm);
}

/** 视图空间法线变换矩阵:inverse-transpose(V · Model) 的 3x3 部分。 */
export function decalNormalMatrix(
  p: ProjectorParams,
  modelAtConfirm: THREE.Matrix4,
): THREE.Matrix3 {
  const vm = viewMatrix(p).multiply(modelAtConfirm);
  const invT = vm.invert().transpose();
  return new THREE.Matrix3().setFromMatrix4(invT);
}

/** 投影机相对目标的姿态,确认时冻结:relPose = Model⁻¹ · ProjWorld。 */
export function relativePose(
  p: ProjectorParams,
  modelAtConfirm: THREE.Matrix4,
): THREE.Matrix4 {
  return modelAtConfirm.clone().invert().multiply(projectorWorldMatrix(p));
}

export interface ClipResult {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** 用冻结矩阵把局部点投到投影机 NDC。 */
export function projectLocal(m: THREE.Matrix4, local: THREE.Vector3): ClipResult {
  const v = new THREE.Vector4(local.x, local.y, local.z, 1).applyMatrix4(m);
  return { x: v.x / v.w, y: v.y / v.w, z: v.z / v.w, w: v.w };
}

export type OutsideReason = 'behind' | 'side' | 'near' | 'far';

/**
 * 投射体边界分类,与片元着色器中的判定一一对应:
 *   w <= 0        -> 投影机后方
 *   |x|>1, |y|>1  -> 侧边界之外
 *   z < -1 / > 1  -> 近端以内 / 远端以外
 */
export function classifyClip(c: ClipResult): OutsideReason[] {
  const reasons: OutsideReason[] = [];
  if (c.w <= 0) {
    reasons.push('behind');
    return reasons; // 后方点的 NDC 经负 w 翻转,其余分量无意义
  }
  if (c.x < -1 || c.x > 1 || c.y < -1 || c.y > 1) reasons.push('side');
  if (c.z < -1) reasons.push('near');
  if (c.z > 1) reasons.push('far');
  return reasons;
}

/** NDC z([-1,1]) 转深度缓存约定([0,1])。 */
export function ndcToDepth01(ndcZ: number): number {
  return ndcZ * 0.5 + 0.5;
}

/** 背面规则:视图空间法线 z > 0(表面朝向投影机)才接收。 */
export function backfaceAccepts(viewNormalZ: number): boolean {
  return viewNormalZ > 0;
}

/** 深度比较容差:24bit 深度在 near≈1、far≈10 时分辨率远优于该值。 */
export const DEPTH_BIAS = 2e-3;

/** 首表面规则:片元深度不大于已存深度(加容差)才是沿投射方向首先遇到的表面。 */
export function firstSurfaceAccepts(
  fragmentDepth01: number,
  storedDepth01: number,
  bias: number = DEPTH_BIAS,
): boolean {
  return fragmentDepth01 <= storedDepth01 + bias;
}
