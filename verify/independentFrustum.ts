import { Matrix4, Vector3, Vector4 } from 'three';

/**
 * 独立视锥数学：直接从 view-projection 矩阵提取 Gribb-Hartmann 平面，
 * 不使用 THREE.Frustum / THREE.Plane，用来交叉校验 src/culling/frustum.ts。
 *
 * 注意 THREE.Matrix4.elements 是列主序：e[column*4 + row]，
 * 取第 r 行要隔 4 取元素。平面归一化使 normal 为单位向量（与 THREE.Plane 约定一致）。
 */
export interface RawPlane {
  normal: Vector3;
  constant: number;
}

export interface RawFrustum {
  /** 顺序与 THREE.Frustum 一致: right, left, bottom, top, near, far */
  planes: RawPlane[];
}

function row(matrix: Matrix4, rowIndex: number): Vector4 {
  const e = matrix.elements;
  return new Vector4(
    e[rowIndex],
    e[4 + rowIndex],
    e[8 + rowIndex],
    e[12 + rowIndex],
  );
}

function toPlane(v: Vector4): RawPlane {
  const normal = new Vector3(v.x, v.y, v.z);
  const len = normal.length() || 1;
  normal.divideScalar(len);
  return { normal, constant: v.w / len };
}

export function extractFrustum(viewProjection: Matrix4): RawFrustum {
  const r0 = row(viewProjection, 0);
  const r1 = row(viewProjection, 1);
  const r2 = row(viewProjection, 2);
  const r3 = row(viewProjection, 3);
  return {
    planes: [
      toPlane(r3.clone().sub(r0)), // right: w - x
      toPlane(r3.clone().add(r0)), // left:  w + x
      toPlane(r3.clone().sub(r1)), // bottom: w - y
      toPlane(r3.clone().add(r1)), // top:    w + y
      toPlane(r3.clone().sub(r2)), // near:   w - z
      toPlane(r3.clone().add(r2)), // far:    w + z
    ],
  };
}

export type RawStatus = 'in' | 'intersect' | 'out';

export function sphereStatus(
  frustum: RawFrustum,
  center: Vector3,
  radius: number,
): RawStatus {
  let intersects = false;
  for (const plane of frustum.planes) {
    const d = plane.normal.dot(center) + plane.constant;
    if (d < -radius) return 'out';
    if (d < radius) intersects = true;
  }
  return intersects ? 'intersect' : 'in';
}

export function boxStatus(
  frustum: RawFrustum,
  min: Vector3,
  max: Vector3,
): RawStatus {
  let intersects = false;
  for (const plane of frustum.planes) {
    const nx = plane.normal.x;
    const ny = plane.normal.y;
    const nz = plane.normal.z;
    // 沿法线反方向的盒角：平面方程在盒上的最小值点。
    const px = nx >= 0 ? min.x : max.x;
    const py = ny >= 0 ? min.y : max.y;
    const pz = nz >= 0 ? min.z : max.z;
    const minSide = nx * px + ny * py + nz * pz + plane.constant;
    // 沿法线正方向的盒角：平面方程在盒上的最大值点。
    const qx = nx >= 0 ? max.x : min.x;
    const qy = ny >= 0 ? max.y : min.y;
    const qz = nz >= 0 ? max.z : min.z;
    const maxSide = nx * qx + ny * qy + nz * qz + plane.constant;
    // 面的内侧约定为方程值 >= 0；连最大侧都为负 => 整盒在该面外侧。
    if (maxSide < 0) return 'out';
    // 最小侧为负 => 有顶点在面外，盒与该面相交。
    if (minSide < 0) intersects = true;
  }
  return intersects ? 'intersect' : 'in';
}

export function viewProjectionOf(camera: {
  projectionMatrix: Matrix4;
  matrixWorldInverse: Matrix4;
}): Matrix4 {
  return new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
}
