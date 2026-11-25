/**
 * 纯几何工具：向量、线段/射线求交、可见性、角度、颜色换算。
 * 本文件不依赖场景状态，全部为可单测的纯函数。
 */
import type { RGBColor, Vec2 } from './types.js';

export const EPS = 1e-9;
/** 视线判定用的微小偏移（米），避免共线自交 */
export const VIS_EPS = 1e-4;

// ---------- 向量 ----------
export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, mul: number): Vec2 => ({ x: a.x * mul, y: a.y * mul });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const normalize = (a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y);
  return l < EPS ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
};
/** 左侧法向量（线段 a→b 逆时针 90°） */
export const normal = (a: Vec2, b: Vec2): Vec2 => {
  const d = normalize(sub(b, a));
  return { x: -d.y, y: d.x };
};
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

// ---------- 求交 ----------
/**
 * 射线 origin + t*dir（dir 不必归一化，t 以 dir 长度为单位）与线段 a-b 求交。
 * 返回射线参数 t（>=0）与线段参数 u（0~1），不相交返回 null。
 */
export function raySegment(
  origin: Vec2,
  dir: Vec2,
  a: Vec2,
  b: Vec2,
): { t: number; u: number } | null {
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const denom = dir.x * sy - dir.y * sx;
  if (Math.abs(denom) < EPS) return null;
  const ox = a.x - origin.x;
  const oy = a.y - origin.y;
  const t = (ox * sy - oy * sx) / denom;
  const u = (ox * dir.y - oy * dir.x) / denom;
  if (t < -EPS || u < -EPS || u > 1 + EPS) return null;
  return { t: Math.max(0, t), u: clamp(u, 0, 1) };
}

/** 两线段是否相交（含端点接触） */
export function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1 = raySegment(p3, sub(p4, p3), p1, p2);
  if (!d1) return false;
  // p1-p2 上的交点参数由 raySegment 的 u 等价换算：直接再做一次反向检测
  const d2 = raySegment(p1, sub(p2, p1), p3, p4);
  return !!d2 && d1.u >= -EPS && d1.u <= 1 + EPS;
}

/** 点到线段的最近距离与参数 u */
export function pointSegmentDistance(
  p: Vec2,
  a: Vec2,
  b: Vec2,
): { dist: number; u: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const u = l2 < EPS ? 0 : clamp(dot(sub(p, a), ab) / l2, 0, 1);
  const closest = lerp(a, b, u);
  return { dist: dist(p, closest), u };
}

// ---------- 可见性 ----------
export interface FlatWall {
  id: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  enabled: boolean;
}

/**
 * 从 from 到 to 是否可见（不经过任何启用的墙）。
 * ignoreId：起点或终点落在该墙段上时忽略它（例如墙面上的采样点）。
 */
export function isVisible(
  from: Vec2,
  to: Vec2,
  walls: FlatWall[],
  ignoreId?: string,
): boolean {
  const dir = sub(to, from);
  const total = Math.hypot(dir.x, dir.y);
  if (total < EPS) return true;
  for (const w of walls) {
    if (!w.enabled || w.id === ignoreId) continue;
    const hit = raySegment(from, dir, { x: w.ax, y: w.ay }, { x: w.bx, y: w.by });
    if (hit && hit.t > VIS_EPS && hit.t < 1 - VIS_EPS) return false;
  }
  return true;
}

// ---------- 角度 ----------
/** 归一化到 [0, 2π) */
export function angleMod(a: number): number {
  const twoPi = Math.PI * 2;
  return ((a % twoPi) + twoPi) % twoPi;
}

/** 从 from 指向 to 的方位角 */
export function angleTo(from: Vec2, to: Vec2): number {
  return angleMod(Math.atan2(to.y - from.y, to.x - from.x));
}

/**
 * 从点 p 看线段 a-b 的张角（弧度，0~π）。
 * 即两方向 pa、pb 之间的夹角。
 */
export function angularSpan(p: Vec2, a: Vec2, b: Vec2): number {
  const da = sub(a, p);
  const db = sub(b, p);
  const la = Math.hypot(da.x, da.y);
  const lb = Math.hypot(db.x, db.y);
  if (la < EPS || lb < EPS) return 0;
  const c = clamp((da.x * db.x + da.y * db.y) / (la * lb), -1, 1);
  return Math.acos(c);
}

// ---------- 颜色 ----------
export function hexToRgb(hex: string): RGBColor {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0.8, g: 0.8, b: 0.8 };
  const n = parseInt(m[1], 16);
  // sRGB → 近似线性（gamma 2.2），光照计算在线性空间进行
  const srgbToLin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return {
    r: srgbToLin((n >> 16) & 255),
    g: srgbToLin((n >> 8) & 255),
    b: srgbToLin(n & 255),
  };
}

export function linToSrgb(c: number): number {
  const s = clamp(c, 0, 1);
  return s <= 0.0031308 ? s * 12.92 : 1.055 * Math.pow(s, 1 / 2.4) - 0.055;
}

export function rgbToHex(c: RGBColor): string {
  const toByte = (x: number): number => clamp(Math.round(linToSrgb(x) * 255), 0, 255);
  const h = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${h(toByte(c.r))}${h(toByte(c.g))}${h(toByte(c.b))}`;
}

export function rgbLuma(c: { r: number; g: number; b: number }): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

let idCounter = 0;
export function genId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}
