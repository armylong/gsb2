// 基础类型与几何工具。所有坐标均为「场景坐标」（世界坐标），
// 画布像素与场景坐标之间的换算只在 camera / 渲染层进行，
// 因此缩放、切换流速图时流线和起点的场景坐标不会漂移。

export interface Vec2 {
  x: number;
  y: number;
}

/** 场景范围（世界坐标），x/y 均包含上下界 */
export interface Rect {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

/** 无流速 / 不可进入区域。速度场内命中区域即停笔。 */
export interface StopZone {
  kind: 'circle' | 'rect';
  x: number;
  y: number;
  r?: number;
  w?: number;
  h?: number;
}

/** 流速场定义。velocity 只在合法（场区域内且不在静止区中）时有定义。 */
export interface VelocityField {
  id: string;
  label: string;
  desc: string;
  domain: Rect;
  /** 速度低于该值视为无流速区域 */
  speedFloor: number;
  zones: StopZone[];
  velocity(p: Vec2): Vec2;
  /** 点是否落在允许放置起点的区域内 */
  isPlaceable(p: Vec2): boolean;
}

/** 流线停止原因码，文案见 reasonText() */
export type StopReason =
  | 'boundary'
  | 'zero-speed'
  | 'zone'
  | 'closed'
  | 'max-length';

export interface EndInfo {
  point: Vec2;
  reason: StopReason;
  steps: number;
}

export interface TraceResult {
  seed: Vec2;
  /** 从起点沿流向（forward）与逆流向（backward）得到的同一条路径 */
  points: Vec2[];
  forward: EndInfo;
  backward: EndInfo;
  closed: boolean;
  length: number;
  blocked: boolean;
}

export interface Seed {
  id: number;
  p: Vec2;
  manual: boolean;
  locked: boolean;
}

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t
});
export const angleDeg = (v: Vec2): number => {
  const d = len(v);
  if (d === 0) return 0;
  // 画布 y 轴向下，角度以「正右 = 0°，顺时针为正」展示
  return (Math.atan2(v.y, v.x) * 180) / Math.PI;
};
export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** 线段 a->b 与圆（圆心 c，半径 r）的第一个进入交点参数 t（0..1），无交点返回 null */
export function segmentCircleEntry(a: Vec2, b: Vec2, c: Vec2, r: number): number | null {
  const d = sub(b, a);
  const f = sub(a, c);
  const A = d.x * d.x + d.y * d.y;
  if (A === 0) return null;
  const B = 2 * (f.x * d.x + f.y * d.y);
  const C = f.x * f.x + f.y * f.y - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / (2 * A);
  const t2 = (-B + sq) / (2 * A);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

/** 线段 a->b 穿出矩形 rect 的参数 t（0..1），完全在内（沿线段方向）返回 null */
export function segmentRectExit(a: Vec2, b: Vec2, rect: Rect): number | null {
  const d = sub(b, a);
  let tLo = -Infinity;
  let tHi = Infinity;
  const axes: Array<[number, number, number, number]> = [
    [d.x, a.x, rect.xmin, rect.xmax],
    [d.y, a.y, rect.ymin, rect.ymax]
  ];
  for (const [dd, origin, lo, hi] of axes) {
    if (Math.abs(dd) < 1e-12) {
      // 该轴无移动：起点必须在矩形内，否则线段根本不与矩形内部相交
      if (origin < lo || origin > hi) return null;
      continue;
    }
    let t1 = (lo - origin) / dd;
    let t2 = (hi - origin) / dd;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tLo = Math.max(tLo, t1);
    tHi = Math.min(tHi, t2);
    if (tLo > tHi) return null;
  }
  // 起点在矩形内时 tLo<=0<=tHi，第一次穿出发生在 tHi
  return tHi >= 0 && tHi <= 1 ? tHi : null;
}

export function pointInZone(p: Vec2, z: StopZone): boolean {
  if (z.kind === 'circle') return Math.hypot(p.x - z.x, p.y - z.y) <= (z.r ?? 0);
  const w = z.w ?? 0;
  const h = z.h ?? 0;
  return p.x >= z.x - w / 2 && p.x <= z.x + w / 2 && p.y >= z.y - h / 2 && p.y <= z.y + h / 2;
}

export function pointInRect(p: Vec2, r: Rect): boolean {
  return p.x >= r.xmin && p.x <= r.xmax && p.y >= r.ymin && p.y <= r.ymax;
}

/** 线段 a->b 与任意静止区的第一个交点参数 t，无交点返回 null */
export function segmentZoneEntry(a: Vec2, b: Vec2, zones: StopZone[]): number | null {
  let best: number | null = null;
  for (const z of zones) {
    let t: number | null = null;
    if (z.kind === 'circle') {
      t = segmentCircleEntry(a, b, { x: z.x, y: z.y }, z.r ?? 0);
    } else {
      const rect: Rect = {
        xmin: z.x - (z.w ?? 0) / 2,
        xmax: z.x + (z.w ?? 0) / 2,
        ymin: z.y - (z.h ?? 0) / 2,
        ymax: z.y + (z.h ?? 0) / 2
      };
      // 矩形作为不可进入区：取进入边界（slab 下界）
      const d = sub(b, a);
      let tLo = -Infinity;
      let tHi = Infinity;
      const calc = (origin: number, dv: number, lo: number, hi: number): boolean => {
        if (Math.abs(dv) < 1e-12) return origin >= lo && origin <= hi;
        let t1 = (lo - origin) / dv;
        let t2 = (hi - origin) / dv;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tLo = Math.max(tLo, t1);
        tHi = Math.min(tHi, t2);
        return tLo <= tHi;
      };
      if (calc(a.x, d.x, rect.xmin, rect.xmax) && calc(a.y, d.y, rect.ymin, rect.ymax)) t = tLo;
      if (t !== null && (t < 0 || t > 1)) t = null;
    }
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

export const REASON_TEXT: Record<StopReason, string> = {
  boundary: '出画面边界',
  'zero-speed': '进入无流速区域（速度低于阈值）',
  zone: '进入静止圆区 / 停滞区',
  closed: '绕回起点附近，路径闭合',
  'max-length': '达到单段最大步数（保护性停止）'
};
