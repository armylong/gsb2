import { Vec2 } from './types';

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 有符号面积，正值为逆时针 */
export function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  if (l2 < 1e-18) return dist(p, a);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

export function pointOnBoundary(p: Vec2, poly: Vec2[], eps: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (distToSegment(p, poly[i], poly[(i + 1) % poly.length]) <= eps) return true;
  }
  return false;
}

/** 点是否在多边形内（边界上视为内部） */
export function containsPoint(poly: Vec2[], p: Vec2): boolean {
  if (pointOnBoundary(p, poly, 1e-7)) return true;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y) {
      const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return cross(sub(b, a), sub(c, a));
}

/** 严格相交（不含端点接触） */
export function segmentsProperlyIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

export function lineIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = cross(r, s);
  const t = Math.abs(den) < 1e-18 ? 0 : cross(sub(c, a), s) / den;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

/** 检查多边形是否自交，返回首个交点或 null */
export function findSelfIntersection(poly: Vec2[]): Vec2 | null {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if ((j + 1) % n === i || (i + 1) % n === j) continue;
      const c = poly[j];
      const d = poly[(j + 1) % n];
      if (segmentsProperlyIntersect(a, b, c, d)) return lineIntersect(a, b, c, d);
    }
  }
  return null;
}
