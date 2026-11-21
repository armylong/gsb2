/**
 * 射线 / AABB / 球体的纯数学部分。
 *
 * 这里不依赖 three 的 Raycaster，保证 Node 下的验证脚本和浏览器里跑的是同一套代码；
 * three 只在渲染层使用。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Mat3 {
  /** 行优先 */
  m: number[];
}

export type BoxLike = { min: Vec3; max: Vec3 };

export const EPS = 1e-9;

/** 判定“并列命中”的距离容差（世界单位） */
export const TIE_EPS = 1e-4;

export function quatToMat3(q: { x: number; y: number; z: number; w: number }): Mat3 {
  const { x, y, z, w } = q;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return {
    m: [
      1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
      2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
      2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
    ],
  };
}

/**
 * 射线与轴对齐包围盒求交（slab 法）。
 * 返回 [tEnter, tExit]，tEnter 可能为负（起点在盒内）；无交则返回 null。
 */
export function rayBox(
  origin: Vec3,
  dir: Vec3,
  box: BoxLike,
): [number, number] | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  const lo = [box.min.x, box.min.y, box.min.z];
  const hi = [box.max.x, box.max.y, box.max.z];

  for (let i = 0; i < 3; i++) {
    const di = d[i];
    const oi = o[i];
    if (Math.abs(di) < EPS) {
      // 平行于该轴：起点必须在 slab 内
      if (oi < lo[i] || oi > hi[i]) return null;
      continue;
    }
    const inv = 1 / di;
    let t1 = (lo[i] - oi) * inv;
    let t2 = (hi[i] - oi) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return [tmin, tmax];
}

/** 射线是否与 AABB 有 t >= 0 的交集。 */
export function rayHitsBox(origin: Vec3, dir: Vec3, box: BoxLike): boolean {
  const r = rayBox(origin, dir, box);
  if (!r) return false;
  return r[1] >= 0;
}

/**
 * 射线与“中心 c、半边长 h、朝向 rot”的盒体求交，返回世界空间参数 t >= 0。
 * 做法：把射线变换到物件局部空间，用 slab 法。
 */
export function rayBoxObject(
  origin: Vec3,
  dir: Vec3,
  center: Vec3,
  half: Vec3,
  rot: Mat3,
): number | null {
  // 局部空间：p_local = R^T (p_world - center)
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const m = rot.m;
  // R^T 的第 i 行 = R 的第 i 列
  const lo = [
    m[0] * ox + m[3] * oy + m[6] * oz,
    m[1] * ox + m[4] * oy + m[7] * oz,
    m[2] * ox + m[5] * oy + m[8] * oz,
  ];
  const ld = [
    m[0] * dir.x + m[3] * dir.y + m[6] * dir.z,
    m[1] * dir.x + m[4] * dir.y + m[7] * dir.z,
    m[2] * dir.x + m[5] * dir.y + m[8] * dir.z,
  ];
  let tmin = -Infinity;
  let tmax = Infinity;
  const h = [half.x, half.y, half.z];
  for (let i = 0; i < 3; i++) {
    const di = ld[i];
    if (Math.abs(di) < EPS) {
      if (lo[i] < -h[i] || lo[i] > h[i]) return null;
      continue;
    }
    const inv = 1 / di;
    let t1 = (-h[i] - lo[i]) * inv;
    let t2 = (h[i] - lo[i]) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  return tmin >= 0 ? tmin : 0;
}

/**
 * 射线与椭球求交。椭球由半轴 half 和朝向 rot 定义（sphere 物件三个轴向直径可不同）。
 * 做法：把射线压到单位球空间再解二次方程，t 在仿射变换下保持不变。
 */
export function rayEllipsoid(
  origin: Vec3,
  dir: Vec3,
  center: Vec3,
  half: Vec3,
  rot: Mat3,
): number | null {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const m = rot.m;
  // 局部空间原点与方向
  const lo = [
    m[0] * ox + m[3] * oy + m[6] * oz,
    m[1] * ox + m[4] * oy + m[7] * oz,
    m[2] * ox + m[5] * oy + m[8] * oz,
  ];
  const ld = [
    m[0] * dir.x + m[3] * dir.y + m[6] * dir.z,
    m[1] * dir.x + m[4] * dir.y + m[7] * dir.z,
    m[2] * dir.x + m[5] * dir.y + m[8] * dir.z,
  ];
  const eox = lo[0] / half.x;
  const eoy = lo[1] / half.y;
  const eoz = lo[2] / half.z;
  const edx = ld[0] / half.x;
  const edy = ld[1] / half.y;
  const edz = ld[2] / half.z;
  const a = edx * edx + edy * edy + edz * edz;
  const b = 2 * (eox * edx + eoy * edy + eoz * edz);
  const c = eox * eox + eoy * eoy + eoz * eoz - 1;
  if (a < EPS) return null; // 方向退化
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  if (t2 < 0) return null;
  return t1 >= 0 ? t1 : 0;
}

/** 旋转变换下的 AABB（8 个角点重新取包围）。 */
export function transformedAabb(center: Vec3, half: Vec3, rot: Mat3): BoxLike {
  const m = rot.m;
  const ex =
    Math.abs(m[0]) * half.x + Math.abs(m[1]) * half.y + Math.abs(m[2]) * half.z;
  const ey =
    Math.abs(m[3]) * half.x + Math.abs(m[4]) * half.y + Math.abs(m[5]) * half.z;
  const ez =
    Math.abs(m[6]) * half.x + Math.abs(m[7]) * half.y + Math.abs(m[8]) * half.z;
  return {
    min: { x: center.x - ex, y: center.y - ey, z: center.z - ez },
    max: { x: center.x + ex, y: center.y + ey, z: center.z + ez },
  };
}



export function boxContains(outer: BoxLike, inner: BoxLike): boolean {
  return (
    outer.min.x <= inner.min.x + EPS &&
    outer.min.y <= inner.min.y + EPS &&
    outer.min.z <= inner.min.z + EPS &&
    outer.max.x >= inner.max.x - EPS &&
    outer.max.y >= inner.max.y - EPS &&
    outer.max.z >= inner.max.z - EPS
  );
}

export function distanceSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/** 点到 AABB 的最近点。 */
export function closestPointOnBox(p: Vec3, box: BoxLike): Vec3 {
  return {
    x: Math.min(Math.max(p.x, box.min.x), box.max.x),
    y: Math.min(Math.max(p.y, box.min.y), box.max.y),
    z: Math.min(Math.max(p.z, box.min.z), box.max.z),
  };
}

