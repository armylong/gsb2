/**
 * 虚线规划：按整条折线的累计弧长连续排列，跨顶点不重新起算。
 * 节奏为 [dash, gap, dash, gap, ...]，起始偏移 offset 把整条节奏沿 u 平移。
 */
import { PolyPath } from './path';

export interface DashInterval {
  /** 沿中心线的累计参数；闭合路径可能超出 [0, T]，采样时按周期回绕 */
  u0: number;
  u1: number;
  /** 闭合路径且区间覆盖整圈：无端帽，接缝按普通转角 */
  fullLoop: boolean;
}

export interface DashOptions {
  dashed: boolean;
  dashLength: number;
  gapLength: number;
  /** 起始偏移：正值让节奏向 u 增大方向平移 */
  offset: number;
}

export const DEFAULT_DASH: DashOptions = {
  dashed: false,
  dashLength: 2,
  gapLength: 1.2,
  offset: 0,
};

/**
 * 返回与路径定义域相交的实线段区间。
 * - 开放路径：区间被夹在 [0, T] 内，两端按所选端帽封口。
 * - 闭合路径：区间不裁剪，可跨过接缝（u<0 或 u>T 由采样回绕处理）；
 *   覆盖整圈的区间标记 fullLoop，不生成端帽。
 * 不要求末段/首段等长，区间可在任意处被截断。
 */
export function planDashes(path: PolyPath, opt: DashOptions): DashInterval[] {
  const T = path.totalLength;
  if (T <= 1e-9) return [];

  if (!opt.dashed) {
    return [{ u0: 0, u1: T, fullLoop: path.closed }];
  }

  const dash = Math.max(opt.dashLength, 1e-6);
  const gap = Math.max(opt.gapLength, 0);
  const period = dash + gap;

  // 第一个 dash 的起始位置，规范到 (-period, 0]
  const start = -(((opt.offset % period) + period) % period);
  const intervals: DashInterval[] = [];

  let k = Math.floor((0 - start) / period) - 1;
  for (let guard = 0; guard < 100000; guard++) {
    const ds = start + k * period;
    const de = ds + dash;
    if (ds > T + 1e-9) break;
    if (de >= -1e-9) {
      if (path.closed) {
        intervals.push({ u0: ds, u1: de, fullLoop: de - ds >= T - 1e-9 });
      } else {
        const a = Math.max(ds, 0);
        const b = Math.min(de, T);
        if (b - a > 1e-9) intervals.push({ u0: a, u1: b, fullLoop: false });
      }
    }
    k++;
  }
  return intervals;
}
