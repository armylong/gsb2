/**
 * 矢量路径几何核心。
 *
 * 设计要点:
 * - 所有曲线先自适应展平成多边形, 渲染(Path2D)与命中判定(射线法)使用同一份展平结果,
 *   保证「看到的」和「点中的」是同一套几何, 不会出现两套实现口径不一致。
 * - 填充规则同时给出奇偶交点数与方向环绕数, 方便在检查器里解释 evenodd / nonzero 的差异。
 */

export type Vec2 = { x: number; y: number };

export type FillRule = 'nonzero' | 'evenodd';

export type PathCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'C'; c1x: number; c1y: number; c2x: number; c2y: number; c3x: number; c3y: number }
  | { type: 'Z' };

export interface VectorPath {
  commands: PathCommand[];
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FillProbe {
  verdict: 'inside' | 'outside' | 'boundary';
  /** 有向环绕数, nonzero 规则看它是否为 0 */
  winding: number;
  /** 射线与轮廓的总交点数, evenodd 规则看它的奇偶 */
  crossings: number;
}

export const DEFAULT_FLATNESS = 0.25;

interface FlattenCacheEntry {
  contours: Vec2[][];
  bbox: BBox;
}

const flattenCache = new WeakMap<VectorPath, FlattenCacheEntry>();

/* ------------------------------ 曲线展平 ------------------------------ */

function distToLine(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const cross = dx * (p.y - a.y) - dy * (p.x - a.x);
  return Math.abs(cross) / Math.sqrt(len2);
}

function cubicFlatEnough(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, tolerance: number): boolean {
  return distToLine(p1, p0, p3) <= tolerance && distToLine(p2, p0, p3) <= tolerance;
}

function flattenCubic(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  tolerance: number,
  depth: number,
  out: Vec2[],
): void {
  if (depth > 16 || cubicFlatEnough(p0, p1, p2, p3, tolerance)) {
    out.push({ x: p3.x, y: p3.y });
    return;
  }
  const mid12: Vec2 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const mid23: Vec2 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const mid34: Vec2 = { x: (p2.x + p3.x) / 2, y: (p2.y + p3.y) / 2 };
  const mid123: Vec2 = { x: (mid12.x + mid23.x) / 2, y: (mid12.y + mid23.y) / 2 };
  const mid234: Vec2 = { x: (mid23.x + mid34.x) / 2, y: (mid23.y + mid34.y) / 2 };
  const mid1234: Vec2 = { x: (mid123.x + mid234.x) / 2, y: (mid123.y + mid234.y) / 2 };
  flattenCubic(p0, mid12, mid123, mid1234, tolerance, depth + 1, out);
  flattenCubic(mid1234, mid234, mid34, p3, tolerance, depth + 1, out);
}

/** 把路径展平为若干闭合多边形(每个轮廓首点会在末尾重复一次)。 */
export function toContours(path: VectorPath, tolerance: number = DEFAULT_FLATNESS): Vec2[][] {
  const cached = flattenCache.get(path);
  if (cached && cached.contours.length > 0) return cached.contours;

  const contours: Vec2[][] = [];
  let current: Vec2[] | null = null;
  let start: Vec2 | null = null;

  const finish = () => {
    if (current && start) {
      const last = current[current.length - 1];
      if (last.x !== start.x || last.y !== start.y) current.push({ x: start.x, y: start.y });
      if (current.length >= 4) contours.push(current);
    }
    current = null;
    start = null;
  };

  for (const cmd of path.commands) {
    if (cmd.type === 'M') {
      finish();
      current = [{ x: cmd.x, y: cmd.y }];
      start = { x: cmd.x, y: cmd.y };
    } else if (cmd.type === 'L' && current) {
      current.push({ x: cmd.x, y: cmd.y });
    } else if (cmd.type === 'C' && current) {
      const p0 = current[current.length - 1];
      flattenCubic(
        p0,
        { x: cmd.c1x, y: cmd.c1y },
        { x: cmd.c2x, y: cmd.c2y },
        { x: cmd.c3x, y: cmd.c3y },
        tolerance,
        0,
        current,
      );
    } else if (cmd.type === 'Z') {
      finish();
    }
  }
  finish();

  const entry: FlattenCacheEntry = { contours, bbox: boundsOf(contours) };
  flattenCache.set(path, entry);
  return contours;
}

export function pathBounds(path: VectorPath): BBox {
  const cached = flattenCache.get(path);
  if (cached) return cached.bbox;
  return boundsOf(toContours(path));
}

function boundsOf(contours: Vec2[][]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of contours) {
    for (const p of c) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/* --------------------------- 填充规则真值判定 --------------------------- */

function pointOnEdge(a: Vec2, b: Vec2, p: Vec2, scale: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y) <= 1e-9 * scale;
  const cross = dx * (p.y - a.y) - dy * (p.x - a.x);
  const edgeLen = Math.sqrt(len2);
  // 点到线段的垂直距离 <= 容差
  if (Math.abs(cross) / edgeLen > 1e-9 * scale) return false;
  const dot = (p.x - a.x) * dx + (p.y - a.y) * dy;
  return dot >= -1e-9 * scale * edgeLen && dot <= len2 + 1e-9 * scale * edgeLen;
}

/**
 * 对展平后的全部轮廓做一次遍历, 同时统计:
 * - winding: 有向环绕数(上行边在点左侧 +1, 下行边在点右侧 -1)
 * - crossings: 无向交点总数
 * - onEdge: 是否压在任意一条边上
 */
function scanContours(contours: Vec2[][], p: Vec2): { winding: number; crossings: number; onEdge: boolean } {
  let winding = 0;
  let crossings = 0;
  let onEdge = false;
  let scale = 1;
  for (const contour of contours) {
    for (const q of contour) {
      scale = Math.max(scale, Math.abs(q.x), Math.abs(q.y));
    }
  }

  for (const contour of contours) {
    for (let i = 0; i < contour.length - 1; i++) {
      const a = contour[i];
      const b = contour[i + 1];
      if (pointOnEdge(a, b, p, scale)) onEdge = true;
      const isLeft = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
      if (a.y <= p.y) {
        if (b.y > p.y && isLeft > 0) {
          winding += 1;
          crossings += 1;
        }
      } else if (b.y <= p.y && isLeft < 0) {
        winding -= 1;
        crossings += 1;
      }
    }
  }
  return { winding, crossings, onEdge };
}

export function fillRuleAt(path: VectorPath, p: Vec2, rule: FillRule): FillProbe {
  const contours = toContours(path);
  const { winding, crossings, onEdge } = scanContours(contours, p);
  if (onEdge) return { verdict: 'boundary', winding, crossings };
  const inside = rule === 'evenodd' ? crossings % 2 === 1 : winding !== 0;
  return { verdict: inside ? 'inside' : 'outside', winding, crossings };
}

/* ------------------------------ Path2D 桥接 ------------------------------ */

/** 交给 canvas 的 Path2D 直接由原命令构建, 与展平几何同源(同一 VectorPath)。 */
export function toPath2D(path: VectorPath): Path2D {
  const p2d = new Path2D();
  for (const cmd of path.commands) {
    if (cmd.type === 'M') p2d.moveTo(cmd.x, cmd.y);
    else if (cmd.type === 'L') p2d.lineTo(cmd.x, cmd.y);
    else if (cmd.type === 'C') p2d.bezierCurveTo(cmd.c1x, cmd.c1y, cmd.c2x, cmd.c2y, cmd.c3x, cmd.c3y);
    else p2d.closePath();
  }
  return p2d;
}

/** 轮廓有向面积; 屏幕坐标(y 向下)下正值表示顺时针 CW。 */
export function signedArea(contour: Vec2[]): number {
  let area = 0;
  for (let i = 0; i < contour.length - 1; i++) {
    area += contour[i].x * contour[i + 1].y - contour[i + 1].x * contour[i].y;
  }
  return area / 2;
}
