import { Euler, Matrix4, Quaternion, Vector3 } from 'three';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export const deg = (d: number): number => (d * Math.PI) / 180;

export function quat(x = 0, y = 0, z = 0, w = 1): Quaternion {
  return new Quaternion(x, y, z, w);
}

export function vec(x = 0, y = 0, z = 0): Vector3 {
  return new Vector3(x, y, z);
}

/** 欧拉角（度）转四元数，旋转写在静止局部坐标系一侧：qLocal = qRest * euler */
export function eulerQuat(xDeg = 0, yDeg = 0, zDeg = 0, order: Euler['order'] = 'XYZ'): Quaternion {
  return new Quaternion().setFromEuler(new Euler(deg(xDeg), deg(yDeg), deg(zDeg), order));
}

/** 由三根正交轴构造四元数（列基），轴必须右手正交 */
export function quatFromAxes(xAxis: Vector3, yAxis: Vector3, zAxis: Vector3): Quaternion {
  const m = new Matrix4().makeBasis(
    xAxis.clone().normalize(),
    yAxis.clone().normalize(),
    zAxis.clone().normalize(),
  );
  return new Quaternion().setFromRotationMatrix(m);
}

/** 以 boneDir 为局部 +Y、bendDir 投影后为局部 +Z 构造朝向（纸偶骨块常用） */
export function frameAlong(boneDir: Vector3, bendDir: Vector3): Quaternion {
  const y = boneDir.clone().normalize();
  const z = bendDir.clone().addScaledVector(y, -bendDir.dot(y)).normalize();
  const x = new Vector3().crossVectors(y, z).normalize();
  return quatFromAxes(x, y, z);
}

export function qToArray(q: Quaternion): Quat {
  return [q.x, q.y, q.z, q.w];
}

export function vToArray(v: Vector3): Vec3 {
  return [v.x, v.y, v.z];
}

export function qFromArray(a: Quat): Quaternion {
  return new Quaternion(a[0], a[1], a[2], a[3]);
}

export function vFromArray(a: Vec3): Vector3 {
  return new Vector3(a[0], a[1], a[2]);
}

/** 绕某根局部轴再扭转 angle 弧度 */
export function twisted(base: Quaternion, axis: Vector3, angle: number): Quaternion {
  const local = axis.clone().normalize().applyQuaternion(base.clone().invert());
  const twist = new Quaternion().setFromAxisAngle(local, angle);
  return base.clone().multiply(twist);
}

export function qAngle(a: Quaternion, b: Quaternion): number {
  return a.angleTo(b);
}
