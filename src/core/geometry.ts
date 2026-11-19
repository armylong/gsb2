/**
 * geometry.ts — 二维几何原语
 *
 * 本实验使用「二维角度照明模型」：
 * 从接收点 P 看向面积光源（半径 r 的圆盘），光源在 P 处占据一个角度区间
 * [θL - α, θL + α]，α = asin(r / d)。每个凸多边形挡板在 P 处也占据一个
 * 角度楔形（由两条切线张成，宽度 ≤ π）。可见比例 = 光源角度未被所有挡板
 * 楔形并集覆盖的比例。半径 r=0 时 α=0，退化为点光源硬阴影（可见度为 0/1）。
 *
 * 所有角度均为弧度，区间用 [start, end] 表示且约定 end > start，
 * 长度允许超过 2π（调用方负责裁剪）。
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Poly {
  /** 顶点按逆时针（CCW）排列的凸多边形 */
  verts: Vec2[];
  id: number;
}

export interface Circle {
  c: Vec2;
  r: number;
}

export interface Interval {
  s: number;
  e: number; // e > s
}

export const TAU = Math.PI * 2;
export const EPS = 1e-9;

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => len(sub(a, b));

/** 把任意角度规范到 [0, 2π) */
export function norm2pi(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** 把角度规范到 (-π, π] */
export function wrapPi(a: number): number {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r <= -Math.PI) r += TAU;
  return r;
}

/** 有向线段 ab 与点 p 的叉积（z 分量） */
export function crossSeg(a: Vec2, b: Vec2, p: Vec2): number {
  return cross(sub(b, a), sub(p, a));
}

/** 点是否在凸多边形内部或边界上（要求顶点 CCW） */
export function pointInConvex(p: Vec2, poly: Poly): boolean {
  const n = poly.verts.length;
  for (let i = 0; i < n; i++) {
    const a = poly.verts[i];
    const b = poly.verts[(i + 1) % n];
    // CCW 多边形内部在每条有向边的左侧（cross >= 0）
    if (crossSeg(a, b, p) < -EPS) return false;
  }
  return true;
}

/** 圆盘与凸多边形是否相交（含包含与相切） */
export function circleIntersectsConvex(circle: Circle, poly: Poly): boolean {
  if (pointInConvex(circle.c, poly)) return true;
  const n = poly.verts.length;
  // 圆心在外部时，相交等价于圆心到某条边的距离 ≤ r
  for (let i = 0; i < n; i++) {
    const a = poly.verts[i];
    const b = poly.verts[(i + 1) % n];
    const ab = sub(b, a);
    const t = Math.max(0, Math.min(1, dot(sub(circle.c, a), ab) / dot(ab, ab)));
    const nearest = add(a, mul(ab, t));
    if (dist(nearest, circle.c) <= circle.r + EPS) return true;
  }
  return false;
}

/**
 * 两个凸多边形是否相交（SAT 分离轴定理）。
 * 轴取两个多边形的所有边法线。
 */
export function convexIntersect(p1: Poly, p2: Poly): boolean {
  const axes: Vec2[] = [];
  const collect = (p: Poly): void => {
    for (let i = 0; i < p.verts.length; i++) {
      const a = p.verts[i];
      const b = p.verts[(i + 1) % p.verts.length];
      const d = sub(b, a);
      axes.push({ x: -d.y, y: d.x }); // 边的法线
    }
  };
  collect(p1);
  collect(p2);
  for (const axis of axes) {
    let min1 = Infinity;
    let max1 = -Infinity;
    let min2 = Infinity;
    let max2 = -Infinity;
    for (const q of p1.verts) {
      const proj = dot(q, axis);
      min1 = Math.min(min1, proj);
      max1 = Math.max(max1, proj);
    }
    for (const q of p2.verts) {
      const proj = dot(q, axis);
      min2 = Math.min(min2, proj);
      max2 = Math.max(max2, proj);
    }
    if (max1 < min2 - EPS || max2 < min1 - EPS) return false; // 存在分离轴
  }
  return true;
}

/** 线段 [a,b] 与 CCW 凸多边形是否相交（含端点落在边界上） */
export function segmentHitsConvex(a: Vec2, b: Vec2, poly: Poly): boolean {
  if (pointInConvex(a, poly) || pointInConvex(b, poly)) return true;
  // 对每条边做 2D 线段求交
  const n = poly.verts.length;
  const d = sub(b, a);
  for (let i = 0; i < n; i++) {
    const c = poly.verts[i];
    const e = poly.verts[(i + 1) % n];
    const edge = sub(e, c);
    const denom = cross(d, edge);
    if (Math.abs(denom) < EPS) continue; // 平行
    const t = cross(sub(c, a), edge) / denom;
    const u = cross(sub(c, a), d) / denom;
    if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS) return true;
  }
  return false;
}

/**
 * 从点 P 看凸多边形的角度楔形（两条切线的方向角）。
 * 要求 P 在多边形外部。返回的区间在以视线均值为中心的展开坐标下满足
 * width <= π，并用 wrapPi 归一化后返回 [mean, halfWidth]。
 */
export function tangentWedge(p: Vec2, poly: Poly): { mean: number; half: number } {
  let minA = Infinity;
  let maxA = -Infinity;
  for (const q of poly.verts) {
    const a = norm2pi(Math.atan2(q.y - p.y, q.x - p.x));
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
  }
  let s = minA;
  let e = maxA;
  // 顶点角度跨越 0 方向时，把区间整体上移 2π 后重新取最小展开
  if (e - s > Math.PI) {
    const shifted = poly.verts.map((q) => {
      const a = norm2pi(Math.atan2(q.y - p.y, q.x - p.x));
      return a < Math.PI ? a + TAU : a;
    });
    s = Math.min(...shifted);
    e = Math.max(...shifted);
  }
  const width = e - s; // ≤ π
  const mean = s + width / 2;
  return { mean: wrapPi(mean), half: width / 2 };
}

/** 从 P 看向圆盘光源得到的角度区间（中心角与半宽）。P 在圆盘内时返回 null */
export function lightWedge(p: Vec2, light: Circle): { mean: number; half: number } | null {
  const d = sub(light.c, p);
  const dd = len(d);
  if (dd <= light.r + EPS) return null;
  const mean = Math.atan2(d.y, d.x);
  const half = Math.asin(Math.min(1, light.r / dd));
  return { mean, half };
}

/**
 * 把楔形（中心 + 半宽，允许跨 ±π）裁剪到规范区间 [0, 2π) 内，
 * 返回 0~2 个互不重叠的区间。
 */
export function cutToCircle(mean: number, half: number): Interval[] {
  const s = norm2pi(mean - half);
  const e = norm2pi(mean + half);
  if (half * 2 >= TAU - EPS) return [{ s: 0, e: TAU }];
  if (s < e) return [{ s, e }];
  // 跨过 0：拆成两段
  return [
    { s: 0, e },
    { s, e: TAU },
  ];
}

/** 合并一组区间为互不重叠、按起点排序的并集（输入需在 [0,2π) 内） */
export function mergeIntervals(ivs: Interval[]): Interval[] {
  if (ivs.length === 0) return [];
  const sorted = [...ivs].sort((a, b) => a.s - b.s);
  const out: Interval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const top = out[out.length - 1];
    if (sorted[i].s <= top.e + EPS) {
      top.e = Math.max(top.e, sorted[i].e);
    } else {
      out.push({ ...sorted[i] });
    }
  }
  return out;
}

/** 给定光源分段（并集，已在 [0,2π) 内），被遮挡并集 union 覆盖的总角度长度 */
export function coveredLength(lightSegs: Interval[], union: Interval[]): number {
  let total = 0;
  for (const L of lightSegs) {
    for (const U of union) {
      const s = Math.max(L.s, U.s);
      const e = Math.min(L.e, U.e);
      if (e > s) total += e - s;
    }
  }
  return total;
}

/** 规则多边形生成：中心 c、半径 r、n 边、旋转角 rot（弧度） */
export function regularPolygon(c: Vec2, r: number, n: number, rot = 0): Vec2[] {
  const verts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i * TAU) / n;
    verts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return verts;
}

/** 矩形（CCW）：左上角 x,y，宽 w 高 h */
export function rect(x: number, y: number, w: number, h: number): Vec2[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/** 多边形面积（带符号），用于校验 CCW */
export function signedArea(verts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < verts.length; i++) {
    const p = verts[i];
    const q = verts[(i + 1) % verts.length];
    a += cross(p, q);
  }
  return a / 2;
}
