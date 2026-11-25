// 二维向量与角度工具。屏幕坐标：x 向右、y 向下，角度为从 +x 轴顺时针的弧度。

export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x = 0, y = 0): Vec2 => ({ x, y });

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => len(sub(a, b));

export function normalize(a: Vec2): Vec2 {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
}

/** 顺时针旋转 90°（屏幕坐标）。 */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

export function rotate(a: Vec2, ang: number): Vec2 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

export const fromAngle = (ang: number, mag = 1): Vec2 => ({
  x: Math.cos(ang) * mag,
  y: Math.sin(ang) * mag,
});

/** 角度归一化到 (-π, π]。 */
export function wrapAngle(a: number): number {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r <= -Math.PI) r += Math.PI * 2;
  return r;
}

/** 两方向夹角，带符号，范围 (-π, π]。顺时针为正。 */
export function angleDiff(from: number, to: number): number {
  return wrapAngle(to - from);
}

export const rad2deg = (r: number): number => (r * 180) / Math.PI;
export const deg2rad = (d: number): number => (d * Math.PI) / 180;

/** 平滑插值到目标值（指数逼近）。 */
export function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 线段 p0->p1 与 a->b 是否相交，返回 { hit, t(在 p0p1 上的参数), u(在 ab 上的参数), point }。 */
export function segmentIntersect(
  p0: Vec2,
  p1: Vec2,
  a: Vec2,
  b: Vec2,
): { hit: boolean; t: number; u: number; point: Vec2 } {
  const r = sub(p1, p0);
  const s = sub(b, a);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-12) return { hit: false, t: 0, u: 0, point: vec() };
  const qp = sub(a, p0);
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;
  const hit = t >= 0 && t <= 1 && u >= 0 && u <= 1;
  return { hit, t, u, point: add(p0, scale(r, t)) };
}
