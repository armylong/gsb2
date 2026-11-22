/**
 * 纯数学工具：向量与 4x4 矩阵（列主序，与 three.js Matrix4 内存布局一致）。
 * 隐藏线引擎只依赖本模块，不 import three.js，便于在 Node 中做确定性测试。
 */

export type Vec3 = { x: number; y: number; z: number };

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-15 ? scale(a, 1 / l) : v3(0, 0, 0);
};
export const midpoint = (a: Vec3, b: Vec3): Vec3 =>
  v3((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);

/** 4x4 列主序数组（与 THREE.Matrix4.elements 相同）。 */
export type Mat4 = number[];

export function identityMat4(): Mat4 {
  const m = new Array<number>(16).fill(0);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** 从 three.js Matrix4 拷贝（结构鸭子类型，不直接依赖 three）。 */
export function fromThreeMatrix4(mat: { elements: ArrayLike<number> }): Mat4 {
  return Array.from(mat.elements);
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const w = m[12] * 0 + m[13] * 0 + m[14] * 0 + m[15];
  return v3(
    (m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / w,
    (m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]) / w,
    (m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]) / w
  );
}

export function transformDir(m: Mat4, p: Vec3): Vec3 {
  // 只取旋转部分（仿射平移不影响方向）
  return v3(
    m[0] * p.x + m[4] * p.y + m[8] * p.z,
    m[1] * p.x + m[5] * p.y + m[9] * p.z,
    m[2] * p.x + m[6] * p.y + m[10] * p.z
  );
}

/**
 * 把法向量按矩阵的逆转置变换。本项目的样例只有刚体变换（正交旋转+平移），
 * 直接变换后归一化即可；该函数仍保留逆转置形式以兼容非均匀缩放。
 */
export function transformNormal(m: Mat4, n: Vec3): Vec3 {
  // 3x3 逆转置 = (M^-1)^T 的 3x3 部分
  const a00 = m[0], a01 = m[4], a02 = m[8];
  const a10 = m[1], a11 = m[5], a12 = m[9];
  const a20 = m[2], a21 = m[6], a22 = m[10];
  const det =
    a00 * (a11 * a22 - a12 * a21) -
    a01 * (a10 * a22 - a12 * a20) +
    a02 * (a10 * a21 - a11 * a20);
  if (Math.abs(det) < 1e-15) return normalize(transformDir(m, n));
  const invDet = 1 / det;
  // 逆矩阵
  const i00 = (a11 * a22 - a12 * a21) * invDet;
  const i01 = (a02 * a21 - a01 * a22) * invDet;
  const i02 = (a01 * a12 - a02 * a11) * invDet;
  const i10 = (a12 * a20 - a10 * a22) * invDet;
  const i11 = (a00 * a22 - a02 * a20) * invDet;
  const i12 = (a02 * a10 - a00 * a12) * invDet;
  const i20 = (a10 * a21 - a11 * a20) * invDet;
  const i21 = (a01 * a20 - a00 * a21) * invDet;
  const i22 = (a00 * a11 - a01 * a10) * invDet;
  // 逆转置作用于 n
  return normalize(
    v3(
      i00 * n.x + i10 * n.y + i20 * n.z,
      i01 * n.x + i11 * n.y + i21 * n.z,
      i02 * n.x + i12 * n.y + i22 * n.z
    )
  );
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
