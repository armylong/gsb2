/**
 * 基础几何类型与工具函数。
 * 房间坐标: x ∈ [0, 40], y ∈ [0, 30], y 轴向下(屏幕方向)。
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const EPS = 1e-7;

export function v(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 线段长度之和 */
export function polylineLength(points: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/** 点到线段的最短距离 */
export function distancePointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq > 0 ? (apx * abx + apy * aby) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * abx;
  const cy = a.y + t * aby;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** 点到矩形(实心)的最短距离: 点在内部时返回 0 */
export function distancePointRect(p: Vec2, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/** 点是否位于实心矩形内(边界算内部) */
export function pointInRect(p: Vec2, r: Rect): boolean {
  return p.x >= r.x - EPS && p.x <= r.x + r.w + EPS && p.y >= r.y - EPS && p.y <= r.y + r.h + EPS;
}

/** 线段到矩形的最短距离(矩形按实心处理) */
export function distanceSegmentRect(a: Vec2, b: Vec2, r: Rect): number {
  if (pointInRect(a, r) || pointInRect(b, r)) return 0;
  const corners: Vec2[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  let min = Infinity;
  for (let i = 0; i < 4; i++) {
    min = Math.min(min, distanceSegmentSegment(a, b, corners[i], corners[(i + 1) % 4]));
  }
  return min;
}

/** 两条线段之间的最短距离 */
export function distanceSegmentSegment(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): number {
  if (segmentsIntersect(p1, p2, p3, p4)) return 0;
  return Math.min(
    distancePointSegment(p1, p3, p4),
    distancePointSegment(p2, p3, p4),
    distancePointSegment(p3, p1, p2),
    distancePointSegment(p4, p1, p2),
  );
}

/** 两条线段是否相交(含端点接触) */
export function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1 = cross(sub(p4, p3), sub(p1, p3));
  const d2 = cross(sub(p4, p3), sub(p2, p3));
  const d3 = cross(sub(p2, p1), sub(p3, p1));
  const d4 = cross(sub(p2, p1), sub(p4, p1));
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
      ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) {
    return true;
  }
  // 退化情况: 叉积为 0 且该点确实落在另一线段的包围盒内
  if (Math.abs(d1) <= EPS && onSegment(p3, p4, p1)) return true;
  if (Math.abs(d2) <= EPS && onSegment(p3, p4, p2)) return true;
  if (Math.abs(d3) <= EPS && onSegment(p1, p2, p3)) return true;
  if (Math.abs(d4) <= EPS && onSegment(p1, p2, p4)) return true;
  return false;
}

/** 点是否在线段的包围盒内(仅用于共线判定, 调用前已确认叉积为 0) */
function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS &&
    p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS
  );
}

/** 二维叉积 a × b */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

/** 矩形按角色半径向外膨胀, 并夹取到允许范围 [0,size] 内 */
export function inflateRect(r: Rect, amount: number, boundX: number, boundY: number): Rect | null {
  const x = Math.max(0, r.x - amount);
  const y = Math.max(0, r.y - amount);
  const right = Math.min(boundX, r.x + r.w + amount);
  const bottom = Math.min(boundY, r.y + r.h + amount);
  if (right <= x + EPS || bottom <= y + EPS) return null;
  return { x, y, w: right - x, h: bottom - y };
}

export function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function clamp(p: Vec2, boundX: number, boundY: number): Vec2 {
  return {
    x: Math.max(0, Math.min(boundX, p.x)),
    y: Math.max(0, Math.min(boundY, p.y)),
  };
}
