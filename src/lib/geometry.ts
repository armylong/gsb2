// 基础几何类型与纯函数 —— 不依赖 DOM，可直接在 Node 测试中复用

export interface Vec2 {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const centroid = (pts: Vec2[]): Vec2 => {
  const c = pts.reduce((acc, p) => add(acc, p), v(0, 0));
  return scale(c, 1 / pts.length);
};

/** 折线累计弧长（相邻点欧氏距离之和） */
export function polylineLength(pts: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  return total;
}

/**
 * 沿折线按弧长等距重采样为 count 个点。
 * 关键：采样密度只由几何弧长决定，与鼠标移动速度 / 原始事件密度无关 ——
 * 慢手画的那一段不会因为事件多而多占取样，也不会因此变粗（线宽在渲染层固定）。
 * 闭合折线约定首尾点为同一点。
 */
export function resampleArcLength(points: Vec2[], count: number, closed: boolean): Vec2[] {
  if (points.length < 2) return points.slice();
  const pts = points;
  const segCount = closed ? pts.length - 1 : pts.length - 1;
  if (segCount < 1) return points.slice();

  const segLens: number[] = [];
  let total = 0;
  for (let i = 0; i < segCount; i++) {
    const l = dist(pts[i], pts[i + 1]);
    segLens.push(l);
    total += l;
  }
  if (total === 0) return Array.from({ length: count }, () => pts[0]);

  const out: Vec2[] = [];
  let seg = 0;
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const target = closed ? (total * i) / count : (total * i) / (count - 1);
    while (seg < segCount - 1 && acc + segLens[seg] < target) {
      acc += segLens[seg];
      seg++;
    }
    const l = segLens[seg];
    const t = l === 0 ? 0 : (target - acc) / l;
    out.push({
      x: pts[seg].x + (pts[seg + 1].x - pts[seg].x) * t,
      y: pts[seg].y + (pts[seg + 1].y - pts[seg].y) * t,
    });
  }
  return out;
}

/** 多边形有向面积：>0 逆时针（屏幕坐标 y 向下时语义为顺时针），用于判断手画方向 */
export function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    a += pts[i].x * pts[i + 1].y - pts[i + 1].x * pts[i].y;
  }
  return a / 2;
}

/** 点集包围盒尺寸（取长宽的最大值，用于把偏差归一化成无量纲量） */
export function bboxSize(pts: Vec2[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return Math.max(maxX - minX, maxY - minY, 1e-9);
}

/** 角度归一化到 (-PI, PI] */
export function wrapAngle(a: number): number {
  let x = a;
  while (x <= -Math.PI) x += 2 * Math.PI;
  while (x > Math.PI) x -= 2 * Math.PI;
  return x;
}
