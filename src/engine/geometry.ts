/**
 * 向量与扫掠线段几何 —— 计时判定的核心。
 *
 * 关键设计：角色在一帧内从 p0 移动到 p1，把这段位移当作一条"扫掠线段"，
 * 与闸门线段求交。只要发生跨线（哪怕一帧内跨越整个闸门、甚至两扇闸门），
 * 都能通过交点参数 u 插值出 sub-frame 级别的触发时刻，
 * 因此判定结果只依赖时间步长序列，不依赖显示帧率。
 */

export interface Vec2 {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec2 => ({ x, y });

export const add = (a: Vec2, b: Vec2): Vec2 => v(a.x + b.x, a.y + b.y);
export const sub = (a: Vec2, b: Vec2): Vec2 => v(a.x - b.x, a.y - b.y);
export const scale = (a: Vec2, s: number): Vec2 => v(a.x * s, a.y * s);
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => len(sub(a, b));

export function normalize(a: Vec2): Vec2 {
  const l = len(a);
  return l < 1e-12 ? v(0, 0) : v(a.x / l, a.y / l);
}

/** 线性插值，u∈[0,1] */
export function lerp(a: Vec2, b: Vec2, u: number): Vec2 {
  return v(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u);
}

/** 线段 a-b 上最接近 p 的点的参数 u（未截断） */
function closestParam(a: Vec2, b: Vec2, p: Vec2): number {
  const d = sub(b, a);
  const l2 = dot(d, d);
  if (l2 < 1e-12) return 0;
  return dot(sub(p, a), d) / l2;
}

export interface GateHit {
  /** 闸门索引 */
  gate: number;
  /** 交点在位移线段上的参数 u∈(0,1]，用于插值触发时刻 */
  u: number;
  /** 交点世界坐标 */
  point: Vec2;
  /** 扫掠方向与跑道通行方向（切线）的点积符号：>0 正向，<0 逆行 */
  forward: boolean;
  /** 是否为共线重叠（沿闸门滑行），共线时没有明确跨线，不算通过 */
  overlap: boolean;
}

const EPS = 1e-9;
/** 归一化叉积 ≈ sin(夹角)，小于该值视为平行/共线（与向量尺度无关） */
const PARALLEL = 1e-7;

/**
 * 分析一段位移 p0→p1 与一扇闸门的关系。
 * @param tangent 闸门所在位置的跑道切线（通行正方向），用于判定正向/逆行
 * - 普通相交：交点同时落在两条线段内部/端点上
 * - 共线重叠：位移与闸门共线且投影重叠（贴边滑行场景）
 * - 无接触：null
 */
export function analyzeSweep(
  p0: Vec2,
  p1: Vec2,
  gA: Vec2,
  gB: Vec2,
  tangent: Vec2,
): GateHit | null {
  const r = sub(p1, p0);
  const s = sub(gB, gA);
  const lenR = len(r);
  const lenS = len(s);
  if (lenR < EPS || lenS < EPS) return null;
  const rN = scale(r, 1 / lenR);
  const sN = scale(s, 1 / lenS);
  const sinAngle = Math.abs(cross(rN, sN)); // |sin θ|
  const rxs = cross(r, s);
  const qp = sub(gA, p0);
  // 方向判定对照跑道切线，而不是闸门横梁（横梁与切线垂直）
  const forward = dot(rN, normalize(tangent)) >= 0;

  if (sinAngle > PARALLEL) {
    // 非平行：解 p0 + u*r = gA + w*s
    const u = cross(qp, s) / rxs;
    const w = cross(qp, r) / rxs;
    if (u > EPS && u <= 1 + EPS && w >= -EPS && w <= 1 + EPS) {
      const uu = Math.min(1, Math.max(EPS, u));
      const ww = Math.min(1, Math.max(0, w));
      return {
        gate: -1,
        u: uu,
        point: lerp(gA, gB, ww),
        forward,
        overlap: false,
      };
    }
    return null;
  }

  // 平行：只有共线才可能重叠（用归一化向量的 sin 夹角，消除尺度影响）
  const lenQ = len(qp);
  if (lenQ > EPS && Math.abs(cross(scale(qp, 1 / lenQ), sN)) > PARALLEL) return null;

  const uA = closestParam(p0, p1, gA);
  const uB = closestParam(p0, p1, gB);
  const lo = Math.max(0, Math.min(uA, uB));
  const hi = Math.min(1, Math.max(uA, uB));
  if (hi - lo > EPS) {
    const uu = (lo + hi) / 2;
    return {
      gate: -1,
      u: uu,
      point: lerp(p0, p1, uu),
      forward,
      overlap: true,
    };
  }
  return null;
}

/** 点到线段的距离（贴边判定/渲染辅助） */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const u = Math.min(1, Math.max(0, closestParam(a, b, p)));
  return dist(p, lerp(a, b, u));
}
