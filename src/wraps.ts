/**
 * 带历史的绕角状态机。
 *
 * 与“每次都求全局最短可见折线”不同，真实绳索是有记忆的：
 * 拉紧的绳段碰到障碍拐角才会绕上；几何关系改变、能直接拉直时才会解开。
 * 这个模块用“已绕拐点序列”表示历史，并提供：
 *   - buildPathFromWraps: 由拐点序列生成折线（长度 = 各段欧氏距离之和）
 *   - firstBlocker: 判断线段被哪条障碍边挡住
 *   - chooseWrapVertex: 被挡时选择要绕的拐点
 *   - pruneWraps: 找出已经可以直接拉直、应当解开的拐点
 *   - collapseWraps: 折叠“贴着同一条边滑过”的共线拐点
 *   - evolveWraps: 一次增量更新（先解角、再补角）
 *   - verifyWraps: 校验拐点序列的每段都可见（防止穿过障碍）
 *
 * 所有函数都是纯函数，输入相同则输出相同，便于确定性重放。
 */
import { Vec, add, dist, mul, pointSegmentDistance, segmentIntersection, sub } from './math.js';
import { ObstacleDef, RopeCorner, RopePath, cornerLabel, segmentVisible } from './rope.js';

/** 两条不同折线长度差在此范围内视为“打平”，保留既有历史。 */
export const WRAP_TIE = 1e-3;
/** 解角滞回：拐点离开新直线至少这么多像素才拆除，避免擦角抖动。 */
export const RELEASE_MARGIN = 1.2;

export interface BlockerHit {
  obstacleId: string;
  edgeIndex: number;
  point: Vec;
  t: number;
}

/**
 * 稳定取舍：绳恰好沿障碍边滑过时，同一个障碍的两个相邻顶点会同时出现在
 * 折线上，中间那段只是贴着边。这不是真正的两个拐角。
 * 只保留“prev → next 可直视且角点明显偏离直线”的拐点，其余视为共线滑过。
 */
export function collapseWraps(
  anchor: Vec,
  body: Vec,
  wraps: readonly RopeCorner[],
  obstacles: readonly ObstacleDef[],
  tolerance = 0.75,
): RopeCorner[] {
  let out = [...wraps];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const prev = i === 0 ? anchor : out[i - 1].point;
      const next = i === out.length - 1 ? body : out[i + 1].point;
      if (!segmentVisible(prev, next, obstacles)) continue;
      if (pointSegmentDistance(out[i].point, prev, next) > tolerance) continue;
      out.splice(i, 1);
      changed = true;
      break;
    }
  }
  return out;
}

export function buildPathFromWraps(anchor: Vec, body: Vec, wraps: readonly RopeCorner[]): RopePath {
  const points: Vec[] = [anchor, ...wraps.map((w) => ({ ...w.point })), body];
  const corners = wraps.map((w) => ({ ...w, point: { ...w.point } }));
  const segments = [];
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const l = dist(points[i], points[i + 1]);
    total += l;
    segments.push({ from: points[i], to: points[i + 1], length: l, index: i });
  }
  return { points, corners, segments, totalLength: total };
}

/** 线段 a→b 与障碍边界的第一个严格内部命中。擦过顶点不计，作为稳定取舍。 */
export function firstBlocker(
  a: Vec,
  b: Vec,
  obstacles: readonly ObstacleDef[],
  ignoreKeys: ReadonlySet<string> = new Set(),
): BlockerHit | null {
  let best: BlockerHit | null = null;
  for (const ob of obstacles) {
    const poly = ob.points;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      if (ignoreKeys.has(`${ob.id}#${i}`) || ignoreKeys.has(`${ob.id}#${(i + 1) % poly.length}`)) continue;
      const hit = segmentIntersection(a, b, p, q);
      if (!hit) continue;
      const [t, s] = hit;
      const edgeLen = dist(p, q);
      if (s * edgeLen < 1e-6 || (1 - s) * edgeLen < 1e-6) continue;
      if (!best || t < best.t) {
        best = {
          obstacleId: ob.id,
          edgeIndex: i,
          point: add(a, mul(sub(b, a), t)),
          t,
        };
      }
    }
  }
  return best;
}

export interface WrapChoice {
  corner: RopeCorner;
  length: number;
}

/**
 * 上一个点 src 到角色 body 的直线被挡时，选择要绕的拐点：
 *  - 只考虑障碍顶点（绳子只会挂在角上）。
 *  - 顶点必须与 src、body 都可见。
 *  - 加入后折线必须真的变长（确实绕行）。
 *  - 取折线最短者；打平按 key 排序，保证确定性。
 *  - 优先选挡住视线的那个障碍。
 */
export function chooseWrapVertex(
  src: Vec,
  body: Vec,
  obstacles: readonly ObstacleDef[],
  existing: readonly RopeCorner[],
  blocker: BlockerHit | null,
): WrapChoice | null {
  const used = new Set(existing.map((c) => c.key));
  const direct = dist(src, body);
  const candidates: { corner: RopeCorner; length: number; priority: number }[] = [];

  const consider = (ob: ObstacleDef, priority: number): void => {
    for (let i = 0; i < ob.points.length; i++) {
      const key = `${ob.id}#${i}`;
      if (used.has(key)) continue;
      const point = ob.points[i];
      if (dist(point, body) < 1e-6 || dist(point, src) < 1e-6) continue;
      if (pointSegmentDistance(point, src, body) < 1e-3) continue;
      if (!segmentVisible(src, point, obstacles)) continue;
      if (!segmentVisible(point, body, obstacles)) continue;
      const length = dist(src, point) + dist(point, body);
      if (length <= direct + WRAP_TIE) continue;
      candidates.push({
        corner: {
          key,
          obstacleId: ob.id,
          vertexIndex: i,
          point: { ...point },
          label: cornerLabel(ob, i),
        },
        length,
        priority,
      });
    }
  };

  if (blocker) {
    const ob = obstacles.find((o) => o.id === blocker.obstacleId);
    if (ob) consider(ob, 0);
  }
  for (const ob of obstacles) {
    if (blocker && ob.id === blocker.obstacleId) continue;
    consider(ob, 1);
  }
  if (candidates.length === 0) return null;
  candidates.sort((x, y) => {
    if (Math.abs(x.length - y.length) > 1e-6) return x.length - y.length;
    if (x.priority !== y.priority) return x.priority - y.priority;
    return x.corner.key < y.corner.key ? -1 : x.corner.key > y.corner.key ? 1 : 0;
  });
  const best = candidates[0];
  return { corner: best.corner, length: best.length };
}

export interface PruneResult {
  wraps: RopeCorner[];
  removed: RopeCorner[];
}

/**
 * 解开判定：若去掉某拐点后“前后两点”可直视，且该拐点离新直线超过
 * RELEASE_MARGIN，则绳子已不再被这个角顶住，可以解开。
 * 逐轮删除直到稳定（每轮一次只删一个，避免连锁误删）。
 */
export function pruneWraps(
  anchor: Vec,
  body: Vec,
  wraps: readonly RopeCorner[],
  obstacles: readonly ObstacleDef[],
  margin = RELEASE_MARGIN,
): PruneResult {
  const out = [...wraps];
  const removed: RopeCorner[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const prev = i === 0 ? anchor : out[i - 1].point;
      const next = i === out.length - 1 ? body : out[i + 1].point;
      if (!segmentVisible(prev, next, obstacles)) continue;
      if (pointSegmentDistance(out[i].point, prev, next) <= margin) continue;
      removed.push(out[i]);
      out.splice(i, 1);
      changed = true;
      break;
    }
  }
  return { wraps: out, removed };
}

/** 逐段验证拐点序列可行（每段都可见）。 */
export function verifyWraps(anchor: Vec, body: Vec, wraps: readonly RopeCorner[], obstacles: readonly ObstacleDef[]): boolean {
  const pts = [anchor, ...wraps.map((w) => w.point), body];
  for (let i = 0; i + 1 < pts.length; i++) {
    if (!segmentVisible(pts[i], pts[i + 1], obstacles)) return false;
  }
  return true;
}

/**
 * 从当前拐点序列出发，增量更新：
 *  1. 先按“可拉直则解开”拆角；
 *  2. 再检查每段是否被挡，逐个在末尾加上新的绕角，直到全部可见；
 *  3. 每一步都取最短可行候选，长度按实际折线累计。
 * 不会把已有拐点瞬间换成另一侧（那相当于让绳子穿过障碍）。
 */
export function evolveWraps(
  anchor: Vec,
  body: Vec,
  wraps: readonly RopeCorner[],
  obstacles: readonly ObstacleDef[],
  maxCorners = 8,
): { wraps: RopeCorner[]; added: RopeCorner[]; removed: RopeCorner[] } {
  const pruned = pruneWraps(anchor, body, wraps, obstacles);
  const collapsed = collapseWraps(anchor, body, pruned.wraps, obstacles);
  const collapsedAway = pruned.wraps.filter((w) => !collapsed.some((c) => c.key === w.key));
  const out = [...collapsed];
  const added: RopeCorner[] = [];

  // 从锚点开始逐段检查，遇到被挡就在该段末端插入拐点。
  let guard = 0;
  let idx = 0;
  while (idx < out.length + 1 && guard++ < 16) {
    const from = idx === 0 ? anchor : out[idx - 1].point;
    const to = idx === out.length ? body : out[idx].point;
    const blocker = firstBlocker(from, to, obstacles, new Set(out.map((c) => c.key)));
    if (!blocker) {
      idx++;
      continue;
    }
    if (out.length >= maxCorners) break;
    const choice = chooseWrapVertex(from, to, obstacles, out, blocker);
    if (!choice) break;
    // 插入到 idx 位置（保持从锚点向角色的顺序）
    out.splice(idx, 0, choice.corner);
    added.push(choice.corner);
    // 回退一格重新检查新加入的段
    idx = Math.max(0, idx - 1);
  }
  return { wraps: out, added, removed: [...pruned.removed, ...collapsedAway] };
}

