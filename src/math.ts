/** 平面二维向量与几何工具。全部为纯函数，便于确定性重放。 */
export interface Vec {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const len2 = (a: Vec): number => a.x * a.x + a.y * a.y;

export function norm(a: Vec): Vec {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function perp(a: Vec): Vec {
  return { x: -a.y, y: a.x };
}

export function rotate(a: Vec, ang: number): Vec {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** 点到线段的最近点与参数 t∈[0,1]。 */
export function closestOnSegment(p: Vec, a: Vec, b: Vec): { point: Vec; t: number } {
  const ab = sub(b, a);
  const l2 = len2(ab);
  const t = l2 < 1e-18 ? 0 : clamp(dot(sub(p, a), ab) / l2, 0, 1);
  return { point: add(a, mul(ab, t)), t };
}

/**
 * 两条线段的交点参数。返回 [tA, tB]，均须严格位于开区间 (0,1)。
 * 共线/平行返回 null，由调用方单独处理。
 */
export function segmentIntersection(
  a1: Vec,
  a2: Vec,
  b1: Vec,
  b2: Vec,
  eps = 1e-9,
): [number, number] | null {
  const d1 = sub(a2, a1);
  const d2 = sub(b2, b1);
  const den = cross(d1, d2);
  if (Math.abs(den) < eps) return null;
  const t = cross(sub(b1, a1), d2) / den;
  const s = cross(sub(b1, a1), d1) / den;
  if (t <= eps || t >= 1 - eps || s <= eps || s >= 1 - eps) return null;
  return [t, s];
}

/** 射线/线段与线段相交，返回线段参数 t∈(0,1)。用于判定绳段是否被障碍物挡住。 */
export function segmentHitsSegment(
  a1: Vec,
  a2: Vec,
  b1: Vec,
  b2: Vec,
  eps = 1e-9,
): number | null {
  const hit = segmentIntersection(a1, a2, b1, b2, eps);
  return hit ? hit[0] : null;
}

export function pointInPolygon(p: Vec, poly: readonly Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const hit = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (hit) inside = !inside;
  }
  return inside;
}

export function pointSegmentDistance(p: Vec, a: Vec, b: Vec): number {
  return dist(p, closestOnSegment(p, a, b).point);
}

/** 多边形边界到点的最近距离及最近点。 */
export function polygonDistance(p: Vec, poly: readonly Vec[]): { d: number; point: Vec } {
  let best = Infinity;
  let point = poly[0];
  for (let i = 0; i < poly.length; i++) {
    const q = closestOnSegment(p, poly[i], poly[(i + 1) % poly.length]).point;
    const d = dist(p, q);
    if (d < best) {
      best = d;
      point = q;
    }
  }
  return { d: best, point };
}
