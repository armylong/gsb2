// 流线积分器：固定弧长步长的 RK4，沿流向 / 逆流向各追一条半线，
// 拼成经过起点的同一条路径。停止条件全部显式化，不允许靠「长度耗尽」掩盖问题。
import {
  Vec2,
  VelocityField,
  TraceResult,
  EndInfo,
  StopReason,
  Seed,
  add,
  scale,
  dist,
  lerp,
  len,
  pointInRect,
  segmentRectExit,
  segmentZoneEntry
} from './types.js';

/** 固定弧长步长（场景单位）。按速度方向归一化后，路径密度与速度大小无关。 */
export const ARC_STEP = 4;
/** 单条半线最大步数，仅作保护；正常停止应来自边界/静止区/闭合/零速 */
export const MAX_STEPS = 6000;
/** 绕回判定：与已走过的点（排除刚走出的一小段）距离小于该值视为闭合 */
const CLOSE_EPS = 6;
/** 闭合判定需要跳过的最近历史点数，避免把相邻积分点误判成闭合 */
const CLOSE_SKIP = 24;
/** 空间哈希格子边长，用于闭合检测的近邻查询 */
const HASH_CELL = 14;

class PointHash {
  private cells = new Map<string, Array<{ p: Vec2; i: number }>>();

  private key(cx: number, cy: number): string {
    return `${cx}|${cy}`;
  }

  add(p: Vec2, i: number): void {
    const cx = Math.floor(p.x / HASH_CELL);
    const cy = Math.floor(p.y / HASH_CELL);
    const k = this.key(cx, cy);
    const bucket = this.cells.get(k);
    if (bucket) bucket.push({ p, i });
    else this.cells.set(k, [{ p, i }]);
  }

  /** 返回距离 p 小于 eps、且索引早于 minIndex 的最近点索引 */
  findClose(p: Vec2, eps: number, minIndex: number): number | null {
    const cx = Math.floor(p.x / HASH_CELL);
    const cy = Math.floor(p.y / HASH_CELL);
    let best: number | null = null;
    let bestD = eps;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = this.cells.get(this.key(gx, gy));
        if (!bucket) continue;
        for (const item of bucket) {
          if (item.i >= minIndex) continue;
          const d = dist(item.p, p);
          if (d <= bestD) {
            bestD = d;
            best = item.i;
          }
        }
      }
    }
    return best;
  }
}

function unitVelocity(field: VelocityField, p: Vec2): Vec2 | null {
  const v = field.velocity(p);
  const s = len(v);
  if (!Number.isFinite(s) || s < field.speedFloor) return null;
  return scale(v, 1 / s);
}

/** RK4：按单位速度方向推进 ARC_STEP，与速度大小解耦 */
function rk4Step(field: VelocityField, p: Vec2, dir: 1 | -1): Vec2 | null {
  const k1 = unitVelocity(field, p);
  if (!k1) return null;
  const k2p = add(p, scale(k1, (ARC_STEP / 2) * dir));
  const k2 = unitVelocity(field, k2p);
  if (!k2) return null;
  const k3p = add(p, scale(k2, (ARC_STEP / 2) * dir));
  const k3 = unitVelocity(field, k3p);
  if (!k3) return null;
  const k4p = add(p, scale(k3, ARC_STEP * dir));
  const k4 = unitVelocity(field, k4p);
  if (!k4) return null;
  const inc = scale(
    add(add(k1, scale(k2, 2)), add(scale(k3, 2), k4)),
    (ARC_STEP / 6) * dir
  );
  return add(p, inc);
}

interface HalfTrace {
  points: Vec2[]; // 不含起点，逐步向外
  end: EndInfo;
}

function halfTrace(field: VelocityField, seed: Vec2, dir: 1 | -1): HalfTrace {
  const pts: Vec2[] = [];
  const hash = new PointHash();
  let cur = seed;
  let reason: StopReason = 'max-length';
  let closedIndex = -1;

  for (let i = 0; i < MAX_STEPS; i++) {
    const next = rk4Step(field, cur, dir);
    if (!next) {
      reason = 'zero-speed';
      break;
    }

    // 1) 穿出场景边界：把端点裁到边界上，停止原因明确
    const tOut = segmentRectExit(cur, next, field.domain);
    if (tOut !== null) {
      pts.push(lerp(cur, next, Math.max(0, tOut)));
      reason = 'boundary';
      break;
    }

    // 2) 进入静止区（涡核 / 圆柱 / 停滞盘）：取线段与区域的第一个交点
    const tZone = segmentZoneEntry(cur, next, field.zones);
    if (tZone !== null) {
      pts.push(lerp(cur, next, tZone));
      reason = 'zone';
      break;
    }

    pts.push(next);
    hash.add(next, i);

    // 3) 闭合：与足够早的历史点贴近，说明流线绕回了自身
    if (i >= CLOSE_SKIP) {
      const hit = hash.findClose(next, CLOSE_EPS, i - CLOSE_SKIP + 1);
      if (hit !== null) {
        reason = 'closed';
        closedIndex = hit;
        break;
      }
    }
    cur = next;
  }

  return {
    points: pts,
    end: {
      point: pts.length ? pts[pts.length - 1] : seed,
      reason,
      steps: pts.length
    }
  };
}

function polylineLength(points: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/**
 * 从起点双向积分。返回的 points 为一条连续折线：
 * 逆流向半线（反向后） -> 起点 -> 顺流向半线。
 */
export function traceStreamline(field: VelocityField, seed: Vec2): TraceResult {
  const blocked = !field.isPlaceable(seed);
  const fwd = halfTrace(field, seed, 1);
  const back = halfTrace(field, seed, -1);

  const backReversed = back.points.slice().reverse();
  const points = [...backReversed, seed, ...fwd.points];
  const closed = fwd.end.reason === 'closed' || back.end.reason === 'closed';

  return {
    seed,
    points,
    forward: fwd.end,
    backward: back.end,
    closed,
    length: polylineLength(points),
    blocked
  };
}

export function traceSeeds(field: VelocityField, seeds: Seed[]): TraceResult[] {
  return seeds.map((s) => traceStreamline(field, s.p));
}

/** 起点在当前场里是否被挡住（出界或落在静止区 / 零速点上） */
export function isSeedBlocked(field: VelocityField, p: Vec2): boolean {
  if (!pointInRect(p, field.domain)) return true;
  if (!field.isPlaceable(p)) return true;
  const v = field.velocity(p);
  return !Number.isFinite(v.x) || !Number.isFinite(v.y) || len(v) < field.speedFloor;
}
