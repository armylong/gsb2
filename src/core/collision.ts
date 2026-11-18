/**
 * 独立碰撞校验。
 * 与导航网格的构造完全分开: 直接基于原始矩形障碍与房间边界,
 * 计算圆心/线段到障碍的真实间隙, 用于通行判断与路线沿途碰撞检查。
 */
import {
  Vec2,
  Rect,
  EPS,
  distancePointRect,
  distanceSegmentRect,
  clamp,
} from './geometry';

export interface ClearanceResult {
  ok: boolean;
  /** 最小间隙(到障碍/边界的距离), ok 时 >= radius */
  clearance: number;
  /** 不满足时的人类可读原因 */
  reason?: string;
}

/**
 * 圆形角色能否合法停在 p:
 * 1. 整个圆在房间内(到四条边界距离 >= radius)
 * 2. 圆不与任何实心矩形相交(圆心到矩形距离 >= radius)
 * 边界上的接触(touch)视为合法, 用 EPS 容差。
 */
export function checkPointClearance(
  p: Vec2,
  radius: number,
  obstacles: Rect[],
  roomW: number,
  roomH: number,
): ClearanceResult {
  const boundGap = Math.min(p.x, p.y, roomW - p.x, roomH - p.y);
  let clearance = boundGap;
  if (boundGap + EPS < radius) {
    return { ok: false, clearance: boundGap, reason: '超出房间边界' };
  }
  for (const r of obstacles) {
    const d = distancePointRect(p, r);
    clearance = Math.min(clearance, d);
    if (d + EPS < radius) {
      return { ok: false, clearance: d, reason: '落入障碍内部或与障碍重叠' };
    }
  }
  return { ok: true, clearance };
}

/**
 * 整条折线对圆形角色是否合法:
 * 密集采样每个线段上的圆心位置, 逐点做真实间隙检查。
 * 返回第一个违例点的信息; 同时返回沿途测得的最小间隙。
 */
export function checkRouteClearance(
  route: Vec2[],
  radius: number,
  obstacles: Rect[],
  roomW: number,
  roomH: number,
  sampleStep = 0.05,
): ClearanceResult & { violationAt?: Vec2; segmentIndex?: number } {
  if (route.length === 0) return { ok: true, clearance: Infinity };
  let minClearance = Infinity;

  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / sampleStep));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const res = checkPointClearance(p, radius, obstacles, roomW, roomH);
      minClearance = Math.min(minClearance, res.clearance);
      if (!res.ok) {
        return {
          ok: false,
          clearance: res.clearance,
          reason: `第 ${i} 段采样点 (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) ${res.reason}`,
          violationAt: p,
          segmentIndex: i,
        };
      }
    }
  }
  return { ok: true, clearance: minClearance };
}

/**
 * 线段级别的间隙(不采样, 精确): 圆心沿线行走时到障碍的最小距离。
 * 房间是凸矩形, 线段到四条边界的最小距离出现在端点或整条线段上,
 * 用线段参数化求最小值; 用于断言"中心线能过但圆过不去"这类体积结论。
 */
export function segmentClearance(a: Vec2, b: Vec2, obstacles: Rect[], roomW: number, roomH: number): number {
  // 到四条房间边界: 线性坐标的极值出现在端点
  let min = Math.min(
    Math.min(a.x, b.x),
    Math.min(a.y, b.y),
    roomW - Math.max(a.x, b.x),
    roomH - Math.max(a.y, b.y),
  );
  for (const r of obstacles) {
    const d = distanceSegmentRect(a, b, r);
    if (d <= EPS) return 0;
    min = Math.min(min, d);
  }
  return min;
}

/** 把点夹回房间范围(仅用于 UI 坐标保护, 不用于"传送"角色) */
export function clampToRoom(p: Vec2, roomW: number, roomH: number): Vec2 {
  return clamp(p, roomW, roomH);
}
