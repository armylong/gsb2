// 基础二维几何。世界坐标:画布像素,x 向右,y 向下;水在上方,岸在下方。
export interface Vec { x: number; y: number }

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => len(sub(a, b));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 点 p 到线段 ab 的最近距离及对应参数 s(0..1)。 */
export function segPoint(a: Vec, b: Vec, p: Vec): { d: number; s: number } {
  const abx = b.x - a.x, aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  let s = 0;
  if (l2 > 1e-9) s = ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2;
  s = Math.max(0, Math.min(1, s));
  const cx = a.x + abx * s, cy = a.y + aby * s;
  return { d: Math.hypot(p.x - cx, p.y - cy), s };
}

/** 点到折线段的累计距离位置:给定路程 d,返回折线上的点;超出末端返回 null。 */
export function polylineAt(points: Vec[], d: number): Vec | null {
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const seg = dist(points[i], points[i + 1]);
    if (d <= acc + seg) {
      const t = seg < 1e-9 ? 0 : (d - acc) / seg;
      return { x: lerp(points[i].x, points[i + 1].x, t), y: lerp(points[i].y, points[i + 1].y, t) };
    }
    acc += seg;
  }
  return null;
}

export function polylineLength(points: Vec[]): number {
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) acc += dist(points[i], points[i + 1]);
  return acc;
}

/** 角度差,归一化到 [-PI, PI]。 */
export function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
