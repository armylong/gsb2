import * as THREE from 'three';
import type { BoxDef, TargetDef } from './types';

/**
 * 几何层: 全部为纯函数, 不依赖渲染。
 * 射线参数化 P(t) = origin + t * dir (dir 为单位向量, t >= 0)。
 */

/** 几何判定容差, 用于 t >= 0 门限与表面贴合去抖。 */
export const GEOM_EPS = 1e-7;

export interface BoxRayHit {
  objectId: string;
  tEntry: number;
  tExit: number;
  entryPoint: THREE.Vector3;
  exitPoint: THREE.Vector3;
  /** 入口面世界外法线 (指向射线来向) */
  entryNormal: THREE.Vector3;
  /** 出口面世界外法线 */
  exitNormal: THREE.Vector3;
  /** 射线起点是否在箱体内部 (含边界) */
  originInside: boolean;
}

export interface TargetRayHit {
  objectId: string;
  t: number;
  point: THREE.Vector3;
  /** 靶面法线 (世界空间, 双面信息用) */
  normal: THREE.Vector3;
}

export interface BoxFrame {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  half: THREE.Vector3;
}

export function boxFrame(box: BoxDef): BoxFrame {
  return {
    position: box.position.clone(),
    quaternion: new THREE.Quaternion().setFromEuler(box.rotation),
    half: box.size.clone().multiplyScalar(0.5),
  };
}

/**
 * 射线与旋转长方体 (OBB) 求交。
 * 做法: 把射线变换到箱体局部空间 (轴对齐), 用 slab 法求 t,
 * 再把命中点和法线变换回世界空间 —— 旋转物体的接触点因此与表面严格吻合。
 */
export function rayBox(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  box: BoxDef,
): BoxRayHit | null {
  const frame = boxFrame(box);
  const invQ = frame.quaternion.clone().invert();
  const localOrigin = origin.clone().sub(frame.position).applyQuaternion(invQ);
  const localDir = dir.clone().applyQuaternion(invQ);

  const h = frame.half;
  let tNear = -Infinity;
  let tFar = Infinity;
  let entryAxis = -1;
  let entrySign = 1;
  let exitAxis = -1;
  let exitSign = 1;
  let originInside = true;

  for (let axis = 0; axis < 3; axis++) {
    const o = localOrigin.getComponent(axis);
    const d = localDir.getComponent(axis);
    const bound = h.getComponent(axis);

    if (Math.abs(d) < GEOM_EPS) {
      // 射线与该轴 slab 平行: 起点必须在 slab 内
      if (o < -bound || o > bound) return null;
      continue;
    }

    let t1 = (-bound - o) / d;
    let t2 = (bound - o) / d;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
    }
    // t1 始终是近面: 法线指向 -d 方向
    const nearSign = d > 0 ? -1 : 1;
    const farSign = -nearSign;

    if (t1 > tNear) {
      tNear = t1;
      entryAxis = axis;
      entrySign = nearSign;
    }
    if (t2 < tFar) {
      tFar = t2;
      exitAxis = axis;
      exitSign = farSign;
    }
    if (o < -bound - GEOM_EPS || o > bound + GEOM_EPS) originInside = false;
  }

  if (tFar < -GEOM_EPS) return null; // 箱体完全在射线后方

  // 起点在内部时, 近裁剪在 t=0, 没有入口面
  const clampedNear = Math.max(tNear, 0);
  if (clampedNear > tFar + GEOM_EPS) return null;
  if (entryAxis < 0 && !originInside) return null;

  const localNormal = (axis: number, sign: number) => {
    const n = new THREE.Vector3();
    n.setComponent(axis, sign);
    return n;
  };

  const toWorldPoint = (t: number) =>
    localOrigin
      .clone()
      .addScaledVector(localDir, t)
      .applyQuaternion(frame.quaternion)
      .add(frame.position);

  const toWorldNormal = (n: THREE.Vector3) =>
    n.clone().applyQuaternion(frame.quaternion).normalize();

  return {
    objectId: box.id,
    tEntry: clampedNear,
    tExit: tFar,
    entryPoint: toWorldPoint(clampedNear),
    exitPoint: toWorldPoint(tFar),
    entryNormal:
      originInside || entryAxis < 0
        ? new THREE.Vector3()
        : toWorldNormal(localNormal(entryAxis, entrySign)),
    exitNormal:
      exitAxis < 0
        ? new THREE.Vector3()
        : toWorldNormal(localNormal(exitAxis, exitSign)),
    originInside,
  };
}

export interface TargetFrame {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  half: THREE.Vector2;
  normal: THREE.Vector3;
}

export function targetFrame(target: TargetDef): TargetFrame {
  const quaternion = new THREE.Quaternion().setFromEuler(target.rotation);
  // 局部 +Z 面为靶面正面
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize();
  return {
    position: target.position.clone(),
    quaternion,
    half: target.size.clone().multiplyScalar(0.5),
    normal,
  };
}

/**
 * 射线与靶面 (局部 XY 平面内的矩形) 求交。
 * 仅记录 t >= 0 的交点; 是否算命中 (正面/被阻挡) 由模拟器决定。
 */
export function rayTarget(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  target: TargetDef,
): TargetRayHit | null {
  const frame = targetFrame(target);
  const invQ = frame.quaternion.clone().invert();
  const localOrigin = origin.clone().sub(frame.position).applyQuaternion(invQ);
  const localDir = dir.clone().applyQuaternion(invQ);

  if (Math.abs(localDir.z) < GEOM_EPS) return null; // 与靶面平行

  const t = -localOrigin.z / localDir.z;
  if (t < -GEOM_EPS) return null;

  const p = localOrigin.clone().addScaledVector(localDir, t);
  if (Math.abs(p.x) > frame.half.x + GEOM_EPS) return null;
  if (Math.abs(p.y) > frame.half.y + GEOM_EPS) return null;

  const point = p.applyQuaternion(frame.quaternion).add(frame.position);
  return { objectId: target.id, t: Math.max(t, 0), point, normal: frame.normal };
}

/** SAT: 两个 OBB 是否重叠 (含接触)。轴 = 两个盒子各自的 3 条局部轴。 */
export function boxesOverlap(a: BoxDef, b: BoxDef): boolean {
  const fa = boxFrame(a);
  const fb = boxFrame(b);
  const axesA = [
    new THREE.Vector3(1, 0, 0).applyQuaternion(fa.quaternion),
    new THREE.Vector3(0, 1, 0).applyQuaternion(fa.quaternion),
    new THREE.Vector3(0, 0, 1).applyQuaternion(fa.quaternion),
  ];
  const axesB = [
    new THREE.Vector3(1, 0, 0).applyQuaternion(fb.quaternion),
    new THREE.Vector3(0, 1, 0).applyQuaternion(fb.quaternion),
    new THREE.Vector3(0, 0, 1).applyQuaternion(fb.quaternion),
  ];
  const delta = fb.position.clone().sub(fa.position);
  const allAxes = [...axesA, ...axesB];

  for (const axis of allAxes) {
    const ra =
      fa.half.x * Math.abs(axis.dot(axesA[0])) +
      fa.half.y * Math.abs(axis.dot(axesA[1])) +
      fa.half.z * Math.abs(axis.dot(axesA[2]));
    const rb =
      fb.half.x * Math.abs(axis.dot(axesB[0])) +
      fb.half.y * Math.abs(axis.dot(axesB[1])) +
      fb.half.z * Math.abs(axis.dot(axesB[2]));
    const dist = Math.abs(delta.dot(axis));
    if (dist > ra + rb + GEOM_EPS) return false;
  }
  return true;
}

/** 把靶面当作零厚度盒子 (半厚取一个极小值) 与 OBB 做 SAT 重叠检测。 */
export function boxTargetOverlap(box: BoxDef, target: TargetDef): boolean {
  const thin: BoxDef = {
    id: `${target.id}__thin`,
    name: target.name,
    position: target.position,
    rotation: target.rotation,
    size: new THREE.Vector3(target.size.x, target.size.y, 1e-6),
    material: box.material,
  };
  return boxesOverlap(box, thin);
}

export function targetsOverlap(a: TargetDef, b: TargetDef): boolean {
  const thinA: BoxDef = {
    id: `${a.id}__thin`,
    name: a.name,
    position: a.position,
    rotation: a.rotation,
    size: new THREE.Vector3(a.size.x, a.size.y, 1e-6),
    material: defaultBlockingMaterial(),
  };
  const thinB: BoxDef = {
    id: `${b.id}__thin`,
    name: b.name,
    position: b.position,
    rotation: b.rotation,
    size: new THREE.Vector3(b.size.x, b.size.y, 1e-6),
    material: defaultBlockingMaterial(),
  };
  return boxesOverlap(thinA, thinB);
}

function defaultBlockingMaterial() {
  // 仅为复用 SAT, 材料参数不参与重叠计算
  return {
    kind: 'blocking' as const,
    resistance: 0,
    reflectLossRatio: 0,
    maxReflectAngleDeg: 0,
  };
}
