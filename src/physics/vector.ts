import type { V3 } from './geometry';

export type { V3 };
export const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
export const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
export const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
export const at = (o: V3, d: V3, t: number): V3 => add(o, scale(d, t));
export const fmt = (a: V3): string => `(${a.x.toFixed(1)}, ${a.y.toFixed(1)}, ${a.z.toFixed(1)})`;
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** 射线与轴对齐平面相交，返回正方向最近 t（无交点返回 null） */
export function hitPlane(o: V3, d: V3, axis: 'x' | 'y' | 'z', value: number): number | null {
  const denom = d[axis];
  if (Math.abs(denom) < 1e-12) return null;
  const t = (value - o[axis]) / denom;
  return t > 1e-9 ? t : null;
}

/** 射线与 AABB 相交（slab 法），返回正方向最近 t（无交点返回 null） */
export function hitBox(o: V3, d: V3, min: V3, max: V3): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const lo = min[axis];
    const hi = max[axis];
    if (Math.abs(d[axis]) < 1e-12) {
      if (o[axis] < lo || o[axis] > hi) return null;
      continue;
    }
    let t1 = (lo - o[axis]) / d[axis];
    let t2 = (hi - o[axis]) / d[axis];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 1e-9) return null;
  return tmin > 1e-9 ? tmin : tmax;
}
