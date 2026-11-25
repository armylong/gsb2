// 纯几何工具：格坐标、90° 离散旋转、连续旋转、SAT 多边形碰撞。
// 约定：世界坐标以“格”为单位，格 (x,y) 覆盖 [x, x+1) × [y, y+1)，
// 格中心为 (x+0.5, y+0.5)。画布 y 轴向下，正角度 = 顺时针。

import type { Dir, RotDir, Vec2 } from './types.js';

export const DIR_VECTORS: Record<Dir, Vec2> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};

export const OPPOSITE_DIR: Record<Dir, Dir> = {
  N: 'S',
  E: 'W',
  S: 'N',
  W: 'E',
};

export const key = (p: Vec2): string => `${p.x},${p.y}`;
export const eq = (a: Vec2, b: Vec2): boolean => a.x === b.x && a.y === b.y;
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });

/** 离散 90° 顺时针旋转向量（屏幕坐标，y 向下） */
export function rot90CW(v: Vec2): Vec2 {
  return { x: -v.y, y: v.x };
}

/** 离散 90° 逆时针旋转向量 */
export function rot90CCW(v: Vec2): Vec2 {
  return { x: v.y, y: -v.x };
}

export function rotateStep(v: Vec2, dir: RotDir): Vec2 {
  return dir === 'cw' ? rot90CW(v) : rot90CCW(v);
}

/** 连续旋转点（屏幕坐标，角度为正时顺时针） */
export function rotatePoint(p: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** 平台枢轴（中心）世界坐标 */
export function pivotOf(origin: Vec2, size: number): Vec2 {
  return { x: origin.x + size / 2, y: origin.y + size / 2 };
}

/** 平台本地坐标（以枢轴为原点）转世界坐标，angle 为当前转动角 */
export function localToWorld(local: Vec2, pivot: Vec2, angle: number): Vec2 {
  const r = rotatePoint(local, angle);
  return { x: pivot.x + r.x, y: pivot.y + r.y };
}

/** 轴对齐格的四角（逆时针序无所谓，SAT 只需要凸多边形顶点） */
export function cellCorners(cell: Vec2): Vec2[] {
  return [
    { x: cell.x, y: cell.y },
    { x: cell.x + 1, y: cell.y },
    { x: cell.x + 1, y: cell.y + 1 },
    { x: cell.x, y: cell.y + 1 },
  ];
}

/** 平台在 angle 角度下的四角世界坐标（含当前动画角） */
export function platformCorners(
  origin: Vec2,
  size: number,
  angle: number,
): Vec2[] {
  const pivot = pivotOf(origin, size);
  const half = size / 2;
  const locals = [
    { x: -half, y: -half },
    { x: half, y: -half },
    { x: half, y: half },
    { x: -half, y: half },
  ];
  return locals.map((l) => localToWorld(l, pivot, angle));
}

/** 玩家碰撞盒（以当前浮点位置为中心的小方块，半边长 0.3 格） */
export function playerBox(center: Vec2, half = 0.3): Vec2[] {
  return [
    { x: center.x - half, y: center.y - half },
    { x: center.x + half, y: center.y - half },
    { x: center.x + half, y: center.y + half },
    { x: center.x - half, y: center.y + half },
  ];
}

function project(poly: Vec2[], axis: Vec2): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const p of poly) {
    const d = p.x * axis.x + p.y * axis.y;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
}

/**
 * SAT 凸多边形相交判定。接触（gap ≈ 0）也算碰撞，
 * 这样转角恰好顶到栏杆角时能被稳定检出。
 */
export function polygonsIntersect(a: Vec2[], b: Vec2[]): boolean {
  const axes: Vec2[] = [];
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      const edge = sub(p2, p1);
      axes.push({ x: -edge.y, y: edge.x });
    }
  }
  for (const axis of axes) {
    const pa = project(a, axis);
    const pb = project(b, axis);
    const gap = Math.max(pa.min, pb.min) - Math.min(pa.max, pb.max);
    if (gap > 1e-9) return false;
  }
  return true;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
