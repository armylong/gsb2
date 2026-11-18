import type { AABB, Camera, Vec3 } from './types';

export const GRID_SIZE = 12;
export const MAX_BLOCKS = 20;

export const CHAR_SX = 0.6;
export const CHAR_SY = 0.6;
export const CHAR_HEIGHT = 1.6;

/** 固定等距正交投影：2:1 菱形，x 朝东南、y 朝南，z 朝上。 */
export function project(p: Vec3, cam: Camera): { sx: number; sy: number } {
  return {
    sx: cam.originX + (p.x - p.y) * cam.k,
    sy: cam.originY + (p.x + p.y) * cam.k * 0.5 - p.z * cam.k,
  };
}

/** 反投影：屏幕点 -> 地面 z=0 上的世界格子坐标（project 的逆变换）。 */
export function screenToGround(sx: number, sy: number, cam: Camera): { x: number; y: number } {
  const dx = (sx - cam.originX) / cam.k;
  const dy = (sy - cam.originY) / cam.k;
  // sx: dx = x - y；sy: dy = (x + y) / 2
  return { x: dy + dx / 2, y: dy - dx / 2 };
}

export function blockAABB(b: { x: number; y: number; z: number; sx: number; sy: number; h: number }): AABB {
  return {
    minX: b.x,
    maxX: b.x + b.sx,
    minY: b.y,
    maxY: b.y + b.sy,
    minZ: b.z,
    maxZ: b.z + b.h,
  };
}

export function characterAABB(c: { x: number; y: number; z: number }): AABB {
  return {
    minX: c.x - CHAR_SX / 2,
    maxX: c.x + CHAR_SX / 2,
    minY: c.y - CHAR_SY / 2,
    maxY: c.y + CHAR_SY / 2,
    minZ: c.z,
    maxZ: c.z + CHAR_HEIGHT,
  };
}

/** 三维体积相交（严格正体积；仅共面/共边不算）。 */
export function overlaps3D(a: AABB, b: AABB): boolean {
  return (
    a.minX < b.maxX && b.minX < a.maxX &&
    a.minY < b.maxY && b.minY < a.maxY &&
    a.minZ < b.maxZ && b.minZ < a.maxZ
  );
}

/** 水平占地相交（严格正面积）。 */
export function overlapsFootprint(a: AABB, b: AABB): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

export interface Polygon {
  pts: { x: number; y: number }[];
}

/** 求 AABB 8 个角点投影后的凸包（Andrew 单调链），即该实体在屏幕上的剪影。 */
export function silhouettePolygon(box: AABB, cam: Camera): Polygon {
  const corners: Vec3[] = [];
  for (const x of [box.minX, box.maxX]) {
    for (const y of [box.minY, box.maxY]) {
      for (const z of [box.minZ, box.maxZ]) corners.push({ x, y, z });
    }
  }
  const pts = corners
    .map((c) => project(c, cam))
    .sort((a, b) => (a.sx === b.sx ? a.sy - b.sy : a.sx - b.sx));

  const cross = (o: { sx: number; sy: number }, a: { sx: number; sy: number }, b: { sx: number; sy: number }) =>
    (a.sx - o.sx) * (b.sy - o.sy) - (a.sy - o.sy) * (b.sx - o.sx);

  const lower: { sx: number; sy: number }[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: { sx: number; sy: number }[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  return { pts: hull.map((p) => ({ x: p.sx, y: p.sy })) };
}

/** 凸多边形相交（SAT），共边/共点视为不相交。 */
export function polygonsIntersect(a: Polygon, b: Polygon): boolean {
  const testAxis = (polyA: Polygon, polyB: Polygon): boolean => {
    for (let i = 0; i < polyA.pts.length; i++) {
      const p1 = polyA.pts[i];
      const p2 = polyA.pts[(i + 1) % polyA.pts.length];
      const nx = -(p2.y - p1.y);
      const ny = p2.x - p1.x;
      let minA = Infinity;
      let maxA = -Infinity;
      for (const p of polyA.pts) {
        const d = p.x * nx + p.y * ny;
        minA = Math.min(minA, d);
        maxA = Math.max(maxA, d);
      }
      let minB = Infinity;
      let maxB = -Infinity;
      for (const p of polyB.pts) {
        const d = p.x * nx + p.y * ny;
        minB = Math.min(minB, d);
        maxB = Math.max(maxB, d);
      }
      if (maxA <= minB || maxB <= minA) return false;
    }
    return true;
  };
  return testAxis(a, b) && testAxis(b, a);
}

export function pointInPolygon(px: number, py: number, poly: Polygon): boolean {
  let inside = false;
  const pts = poly.pts;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 投影后实体屏幕中心的纵坐标（naive 对照排序使用）。 */
export function projectedCenterY(box: AABB, cam: Camera): number {
  const p = project(
    {
      x: (box.minX + box.maxX) / 2,
      y: (box.minY + box.maxY) / 2,
      z: (box.minZ + box.maxZ) / 2,
    },
    cam,
  );
  return p.sy;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
