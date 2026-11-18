import type { Vec3 } from './vector';
import { v3 } from './vector';

/**
 * 轴对齐盒（静态盒形障碍）。
 * min/max 为世界空间包围盒；地面也用一个超大 AABB 表达，统一走同一套碰撞代码。
 */
export interface AABB {
  min: Vec3;
  max: Vec3;
  /** 是否为低顶（用于辅助图配色与判定，不参与数学） */
  isCeiling?: boolean;
  /** 调试名称 */
  name?: string;
}

export interface RayHit {
  /** 射线进入参数 t（射线 P = origin + t*dir, dir 为单位向量） */
  tEnter: number;
}

const EPS = 1e-9;

/**
 * 射线 vs AABB（slab 法），返回首次进入参数 t。
 * - 射线起点在盒内：tEnter 为负数（带符号距离），调用方可据此判定“已穿透”。
 * - 不相交或完全在盒后：返回 null。
 * dir 必须是单位向量，这样 t 直接等于距离。
 */
export function rayVsAABB(origin: Vec3, dir: Vec3, box: AABB): RayHit | null {
  let tmin = -Infinity;
  let tmax = Infinity;

  // 每个轴的 slab：近平面 tNear / 远平面 tFar（与射线方向符号无关地排序）
  const axes: Array<[number, number, number, number]> = [
    [origin.x, dir.x, box.min.x, box.max.x],
    [origin.y, dir.y, box.min.y, box.max.y],
    [origin.z, dir.z, box.min.z, box.max.z],
  ];

  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < EPS) {
      if (o < lo || o > hi) return null; // 平行且在 slab 外
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }

  if (tmax < 0) return null; // 盒子完全在射线后方
  return { tEnter: tmin };
}

/**
 * 沿单位方向 dir 扫掠半径 r 的球体 vs AABB，返回球心允许到达的最大距离 d。
 *
 * 不采用“把 AABB 整体外扩 r 再求交”的做法：膨胀盒在角部是方形的，
 * 斜向射线会比真实圆球体提前约 r·(√2-1) 碰到，过保守且墙角余量不准。
 *
 * 正确做法（对凸盒精确）：
 * 1. 对原始 AABB 做中心射线求交，得进入点 P、进入法线轴 n；
 * 2. 球体在该面的接触提前量 = r / |dir·n|（射线越斜，沿射线回退越多）；
 * 3. 球心安全距离 = tEnter - r/|dir·n|。
 * 起点已在盒内时 tEnter 为负，返回负值表示穿透，由调用方处理。
 * 射线不碰该盒返回 Infinity。
 */
export function sphereSweepAABB(
  origin: Vec3,
  dir: Vec3,
  radius: number,
  box: AABB,
): number {
  // 先处理平行 / 起点已接触：球在起点处就与盒重叠（含角部欧氏距离判定），
  // 说明沿该射线没有任何正距离可走，返回 0（贴住）或负值（已穿透深度）。
  const startDist = pointToAABBDistance(origin, box) - radius;
  if (startDist <= 0) {
    // 射线与盒平行（或朝向远离）时不会再靠近，直接返回当前净距作为距离上限
    const hit0 = rayVsAABB(origin, dir, box);
    if (!hit0 || hit0.tEnter <= 0) return Math.max(startDist, -radius);
  }

  const hit = rayVsAABB(origin, dir, box);
  if (!hit) return Infinity;
  const t = hit.tEnter;

  // 进入点：射线首次穿过的那个轴平面，法线分量绝对值最大的轴即进入轴
  const enterPoint = v3.create(
    origin.x + dir.x * t,
    origin.y + dir.y * t,
    origin.z + dir.z * t,
  );
  // 判定进入轴：进入点贴在哪个盒平面上（取方向贡献最大者，稳健处理角部）
  const eps = 1e-7;
  let normalAxis = -1;
  let best = -1;
  const axes: Array<[number, number, number, number]> = [
    [enterPoint.x, dir.x, box.min.x, box.max.x],
    [enterPoint.y, dir.y, box.min.y, box.max.y],
    [enterPoint.z, dir.z, box.min.z, box.max.z],
  ];
  axes.forEach(([p, d, lo, hi], i) => {
    const onFace = Math.abs(p - lo) < eps || Math.abs(p - hi) < eps;
    if (onFace && Math.abs(d) > best) {
      best = Math.abs(d);
      normalAxis = i;
    }
  });
  if (normalAxis < 0) {
    // 起点在盒内等退化情况：退化为沿射线回退半径
    return t - radius;
  }
  const dirNormal = Math.abs(dir[(['x', 'y', 'z'] as const)[normalAxis]]);
  // dir 是单位向量，dirNormal ∈ (0,1]，直射面时 =1
  return t - radius / Math.max(dirNormal, eps);
}

/** 点到 AABB 表面的最近距离（点在盒内为 0）。 */
export function pointToAABBDistance(p: Vec3, box: AABB): number {
  const dx = Math.max(box.min.x - p.x, 0, p.x - box.max.x);
  const dy = Math.max(box.min.y - p.y, 0, p.y - box.max.y);
  const dz = Math.max(box.min.z - p.z, 0, p.z - box.max.z);
  return Math.hypot(dx, dy, dz);
}

/** 点是否在 AABB 内部（可带 epsilon 内缩）。 */
export function pointInAABB(p: Vec3, box: AABB, eps = 0): boolean {
  return (
    p.x >= box.min.x - eps &&
    p.x <= box.max.x + eps &&
    p.y >= box.min.y - eps &&
    p.y <= box.max.y + eps &&
    p.z >= box.min.z - eps &&
    p.z <= box.max.z + eps
  );
}

/**
 * 给定球心位置与半径，返回相对该 AABB 的净距（盒表面到球面）。
 * 球心在盒外时 ≥ 0；球心进入盒体时，点-盒距离归零，返回 -radius（饱和值），
 * 即“至少穿透一个半径”。实测最小间距读数与可行性判定均以此为准。
 */
export function sphereToAABBClearance(center: Vec3, radius: number, box: AABB): number {
  return pointToAABBDistance(center, box) - radius;
}
