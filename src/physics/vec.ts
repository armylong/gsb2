// 二维向量工具。世界坐标系：x 向右，y 向上（单位：米）。
export interface Vec2 {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const len2 = (a: Vec2): number => a.x * a.x + a.y * a.y;

export function normalize(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
}

/** 把角度（弧度，数学坐标系，0 = 水平向右，逆时针为正）转单位向量 */
export const fromAngle = (rad: number): Vec2 => ({ x: Math.cos(rad), y: Math.sin(rad) });

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** 平滑过渡权重：在 [edge, width+edge] 内由 0 平滑升到 1（smoothstep） */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 角度（弧度）归一化到 [-PI, PI] */
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** 角度（度）转弧度 / 弧度转度 */
export const deg2rad = (d: number): number => (d * Math.PI) / 180;
export const rad2deg = (r: number): number => (r * 180) / Math.PI;
