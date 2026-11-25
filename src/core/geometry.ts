/**
 * 二维几何: 点/四边形工具、单应矩阵、自交检测、多边形光栅化。
 * 纯函数, 不依赖 DOM, 可在 Node 验证脚本中直接复用。
 */
import type { Point, Quad } from './types.ts';

// ---------- 基础向量运算 ----------

export const pt = (x: number, y: number): Point => ({ x, y });

export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Point, s: number): Point => ({ x: a.x * s, y: a.y * s });

export const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;

/** 线段 (a1,a2) 与 (b1,b2) 的交点; 不相交返回 null */
export function segmentIntersection(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const r = sub(a2, a1);
  const s = sub(b2, b1);
  const rxs = cross(r, s);
  if (Math.abs(rxs) < 1e-12) return null;
  const t = cross(sub(b1, a1), s) / rxs;
  const u = cross(sub(b1, a1), r) / rxs;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return add(a1, scale(r, t));
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------- 四边形合法性 ----------

/**
 * 校验四边形: 四条边只允许相邻边在端点相接;
 * 出现自交(对角线方式交叉)或退化(共线、重合、面积≈0)即非法。
 */
export function validateQuad(q: Quad): { valid: boolean; reason: string | null } {
  const n = 4;
  // 退化检查: 任意相邻三点共线 / 重合点
  for (let i = 0; i < n; i++) {
    const a = q[i];
    const b = q[(i + 1) % n];
    if (distance(a, b) < 1e-6) return { valid: false, reason: `角点 ${i} 与 ${(i + 1) % n} 重合` };
    const c = q[(i + 2) % n];
    if (Math.abs(cross(sub(b, a), sub(c, b))) < 1e-9) {
      return { valid: false, reason: `角点 ${i}-${(i + 1) % n}-${(i + 2) % n} 共线, 四边形退化` };
    }
  }
  // 自交检查: 任意两条不相邻边在内部相交(端点相接不算)
  const edges: Array<[Point, Point]> = q.map((p, i) => [p, q[(i + 1) % n]]);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = (i + 1) % n === j || (j + 1) % n === i;
      if (adjacent) continue;
      const hit = segmentIntersection(edges[i][0], edges[i][1], edges[j][0], edges[j][1]);
      if (hit) return { valid: false, reason: '四边形自交(对边交叉)' };
    }
  }
  return { valid: true, reason: null };
}

/** 有向面积(绝对值即面积), 负号表示顺时针 */
export function polygonArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

// ---------- 单应矩阵 (3x3, 行主序) ----------

/**
 * 求从单位矩形四角 (0,0)(1,0)(1,1)(0,1) 映射到任意凸四边形的单应矩阵。
 * 返回的 H 满足 [x', y', w']^T = H · [u, v, 1]^T。
 * 经典 8 参数解法 (Heckbert 1989)。
 */
export function homographyUnitSquareToQuad(q: Quad): number[] {
  const [p0, p1, p2, p3] = q;
  const [x0, y0] = [p0.x, p0.y];
  const [x1, y1] = [p1.x, p1.y];
  const [x2, y2] = [p2.x, p2.y];
  const [x3, y3] = [p3.x, p3.y];

  const dx1 = x1 - x2;
  const dy1 = y1 - y2;
  const dx2 = x3 - x2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;

  let g: number;
  let h: number;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    // 平行四边形(含矩形): 仿射退化
    g = 0;
    h = 0;
  } else {
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < 1e-12) {
      // 几乎退化, 退而用仿射
      g = 0;
      h = 0;
    } else {
      g = (sx * dy2 - dx2 * sy) / det;
      h = (dx1 * sy - sx * dy1) / det;
    }
  }

  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const c = x0;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  const f = y0;

  return [a, b, c, d, e, f, g, h, 1];
}

/** 求 3x3 矩阵的逆(伴随矩阵法) */
export function invert3x3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error('单应矩阵不可逆');
  const inv = [A, D, G, B, E, H, C, F, I];
  return inv.map((v) => v / det);
}

/** 用 3x3 矩阵变换点 */
export function applyH(H: number[], x: number, y: number): Point {
  const w = H[6] * x + H[7] * y + H[8];
  return {
    x: (H[0] * x + H[1] * y + H[2]) / w,
    y: (H[3] * x + H[4] * y + H[5]) / w,
  };
}

/**
 * 幕布坐标 -> 输出图归一化坐标 (0..1)。
 * 即 homographyUnitSquareToQuad 的逆映射。
 */
export function screenToOutput(q: Quad): number[] {
  return invert3x3(homographyUnitSquareToQuad(q));
}

// ---------- 多边形工具 ----------

/** 点是否在多边形内(射线法, 边界算在内) */
export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];
    const intersect =
      pi.y > p.y !== pj.y > p.y &&
      p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 多边形包围盒 */
export function bbox(poly: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Sutherland–Hodgman: 用有向裁剪边 (a -> b) 的内侧半平面裁剪多边形。
 * insideSign: 裁剪多边形有向面积的符号(>0 逆时针, 内部在边左侧; <0 反之)。
 */
export function clipPolygonHalfPlane(subject: Point[], a: Point, b: Point, insideSign: number): Point[] {
  if (subject.length === 0) return [];
  const out: Point[] = [];
  const edge = sub(b, a);
  const inside = (p: Point): number => cross(edge, sub(p, a)) * insideSign;
  let prev = subject[subject.length - 1];
  let prevIn = inside(prev) >= -1e-12;
  for (const cur of subject) {
    const curIn = inside(cur) >= -1e-12;
    if (curIn !== prevIn) {
      const hit = segmentIntersection(prev, cur, a, b);
      if (hit) out.push(hit);
    }
    if (curIn) out.push(cur);
    prev = cur;
    prevIn = curIn;
  }
  return out;
}

/** 两个凸多边形求交(逐裁剪边推进); 非凸时结果可能不精确, 本场景四边形均为凸 */
export function convexPolygonIntersection(a: Point[], b: Point[]): Point[] {
  const sign = polygonArea(b) >= 0 ? 1 : -1;
  let poly = a.slice();
  for (let i = 0; i < b.length && poly.length > 0; i++) {
    poly = clipPolygonHalfPlane(poly, b[i], b[(i + 1) % b.length], sign);
  }
  // 去掉重复点
  const dedup: Point[] = [];
  for (const p of poly) {
    if (!dedup.some((q) => distance(p, q) < 1e-9)) dedup.push(p);
  }
  return dedup;
}

/**
 * 点到线段的距离
 */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const ab = sub(b, a);
  const len2 = ab.x * ab.x + ab.y * ab.y;
  if (len2 < 1e-12) return distance(p, a);
  let t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len2;
  t = clamp(t, 0, 1);
  return distance(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

/** 点到多边形边界(最近边)的距离, 内部为正、外部为负 */
export function signedDistanceToPolygon(p: Point, poly: Point[]): number {
  let minD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    minD = Math.min(minD, distanceToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  }
  return pointInPolygon(p, poly) ? minD : -minD;
}

/**
 * 沿方向 dir 的射线与多边形的最近交点, t 可正可负(双向)。
 * 返回绝对值最小的非零 t。
 */
export function rayPolygonHit(p: Point, dir: Point, poly: Point[]): { point: Point; t: number } | null {
  let best: { point: Point; t: number } | null = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const edge = sub(b, a);
    const denom = cross(dir, edge);
    if (Math.abs(denom) < 1e-12) continue;
    const ap = sub(a, p);
    const t = cross(ap, edge) / denom;
    const u = cross(ap, dir) / denom;
    if (Math.abs(t) < 1e-9) continue;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    if (!best || Math.abs(t) < Math.abs(best.t)) best = { point: add(p, scale(dir, t)), t };
  }
  return best;
}

export interface Crossing {
  /** 沿 -inward 方向到自身边界的距离(本机熄灭处) */
  dSelf: number;
  /** 沿 -inward 方向到对方边界的距离(本机满功率处) */
  dOther: number;
}

/**
 * 求 p 在重叠区内、沿自身融合边法线方向的穿越线段。
 * 融合边 = self 的四条边中整条位于 other 内部的边(两个端点都在 other 内);
 * 若有多个候选(深度交叠), 取距 p 最近者。
 * 四边形按 TL,TR,BR,BL 顺时针排列, 内部在每条边的右侧,
 * 故内法线 = 边方向顺时针转 90° = (-edge.y, edge.x)。
 */
export function overlapCrossing(p: Point, self: Point[], other: Point[]): Crossing | null {
  const candidates: number[] = [];
  for (let i = 0; i < self.length; i++) {
    const a = self[i];
    const b = self[(i + 1) % self.length];
    if (pointInPolygon(a, other) && pointInPolygon(b, other)) candidates.push(i);
  }
  if (candidates.length === 0) return null;
  let bestI = candidates[0];
  let bestD = Infinity;
  for (const i of candidates) {
    const d = distanceToSegment(p, self[i], self[(i + 1) % self.length]);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  const a = self[bestI];
  const b = self[(bestI + 1) % self.length];
  const edge = sub(b, a);
  const len = Math.hypot(edge.x, edge.y) || 1;
  const inward = { x: -edge.y / len, y: edge.x / len };
  // 向外(朝向自身融合边与对方)的方向
  const outward = scale(inward, -1);

  const hitSelf = rayPolygonHit(p, outward, self);
  const hitOther = rayPolygonHit(p, outward, other);
  if (!hitSelf || !hitOther) return null;
  return { dSelf: hitSelf.t, dOther: hitOther.t };
}
