// 积雪覆盖模型：决定一个足迹在「当前时刻 + 所在区域」下还剩下多少线索。
//
// 规则（全部确定性，可由玩家从观察中归纳）：
//  1. 每个区域有基础积雪速率：迎风口 >> 普通 > 避风区。
//  2. 每个格子有小幅、固定的速率抖动（同种子重开不变）。
//  3. 足迹有初始压深，由脚步重量决定，带小幅落脚抖动。
//  4. 覆盖率 = 积雪速率 × 经过分钟数；剩余有效深度 = 初始压深 - 覆盖率。
//  5. 剩余深度高于可读阈值 → 完整脚印（方向、深浅均可读）；
//     低于可读阈值但还没到底 → 浅痕（只剩压痕，方向与重量不可读）；
//     降到 0 → 被新雪完全盖住。
//  6. 叠踩不删除旧足迹：同一格保留完整的足迹栈，各自独立衰减，
//     观察时按从新到旧列出，较新的排在前面。

import { DepthLevel, Impression, Visibility, VisibleImpression, Zone } from './types.js';

/** 各区域基础积雪速率（覆盖率 / 分钟） */
export const ZONE_RATE: Record<Zone, number> = {
  [Zone.Block]: 0,
  [Zone.Normal]: 0.0042,
  [Zone.Wind]: 0.02,
  [Zone.Shelter]: 0.0012,
};

/** 重量档位 → 名义初始压深（0~1） */
export const WEIGHT_DEPTH: Record<number, number> = {
  0: 0.35, // 轻
  1: 0.6, // 中
  2: 0.85, // 重
};

/** 落脚抖动幅度（初始压深 ±） */
export const DEPTH_JITTER = 0.05;
/** 格内积雪速率抖动幅度（±比例） */
export const RATE_JITTER = 0.12;

/** 剩余深度高于此值 → 完整可读脚印 */
export const READABLE_THRESHOLD = 0.18;
/** 剩余深度高于此值 → 至少还有浅痕 */
export const TRACE_THRESHOLD = 0.02;

/** 该足迹当前的覆盖率（0~1，截断） */
export function coverageAt(imp: Impression, now: number): number {
  const elapsed = Math.max(0, now - imp.time);
  return Math.min(1, imp.coverRate * elapsed);
}

/** 该足迹当前的剩余有效深度 */
export function remainingDepth(imp: Impression, now: number): number {
  return Math.max(0, imp.initialDepth - coverageAt(imp, now));
}

/** 该足迹当前的可见等级 */
export function visibilityAt(imp: Impression, now: number): Visibility {
  const rest = remainingDepth(imp, now);
  if (rest <= 0 || rest < TRACE_THRESHOLD) return Visibility.Gone;
  if (rest < READABLE_THRESHOLD) return Visibility.Trace;
  return Visibility.Visible;
}

/** 把内部足迹转换为玩家可见的观察结果；不可见返回 null */
export function toVisible(imp: Impression, now: number): VisibleImpression | null {
  const vis = visibilityAt(imp, now);
  if (vis === Visibility.Gone) return null;
  const rest = remainingDepth(imp, now);
  let depth: DepthLevel;
  if (vis === Visibility.Trace) {
    depth = DepthLevel.Trace;
  } else if (rest >= 0.62) {
    depth = DepthLevel.Deep;
  } else if (rest >= 0.38) {
    depth = DepthLevel.Medium;
  } else {
    depth = DepthLevel.Light;
  }
  return {
    routeId: imp.routeId,
    step: imp.step,
    dir: vis === Visibility.Visible ? imp.dir : null,
    depth,
    visibility: vis,
    cover: coverageAt(imp, now),
    initialDepth: imp.initialDepth,
    time: imp.time,
  };
}

/**
 * 观察一格：返回从新到旧排列的可见足迹。
 * 叠踩的旧足迹不会被抹掉，只是各自被雪埋得更深；
 * 只有当前仍可见的条目会出现。
 */
export function observeCell(
  stack: Impression[] | undefined,
  now: number,
): VisibleImpression[] {
  if (!stack || stack.length === 0) return [];
  const out: VisibleImpression[] = [];
  // 栈按时间升序存放，观察时从新到旧
  for (let i = stack.length - 1; i >= 0; i--) {
    const v = toVisible(stack[i], now);
    if (v) out.push(v);
  }
  return out;
}
