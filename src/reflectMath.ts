import { Vector3 } from 'three';

/** 平面：点 + 单位法线 */
export interface Plane {
  point: Vector3;
  normal: Vector3;
}

/** 点关于平面的镜像：P' = P - 2·((P - P0)·n)·n */
export function reflectPoint(p: Vector3, plane: Plane): Vector3 {
  const d = p.clone().sub(plane.point).dot(plane.normal);
  return p.clone().addScaledVector(plane.normal, -2 * d);
}

/** 方向向量关于法线的镜像：v' = v - 2·(v·n)·n */
export function reflectVector(v: Vector3, n: Vector3): Vector3 {
  return v.clone().addScaledVector(n, -2 * v.dot(n));
}

/** 点到平面的有符号距离 */
export function signedDistance(p: Vector3, plane: Plane): number {
  return p.clone().sub(plane.point).dot(plane.normal);
}
