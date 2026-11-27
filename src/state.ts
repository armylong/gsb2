// 应用状态与派生模型。所有 DFT / 重建 / 偏差计算集中在这里，UI 只读写状态。

import type { Vec2 } from './lib/geometry';
import { centroid, resampleArcLength } from './lib/geometry';
import {
  buildEpicycles, chainTip, dft, orderComponents, reconstruct,
  retainByAmplitude, type CircleComponent, type Epicycle, type OrderMode,
} from './lib/dft';
import { analyzeDeviation, type DeviationReport } from './lib/deviation';

export const SAMPLE_COUNT = 360; // 等弧长采样数，也是 DFT 长度与相位分辨率

export type ViewMode = 'trace' | 'deviation';

export interface AppModel {
  /** 闭合后的原始折线（模型坐标，含重复尾点） */
  rawClosed: Vec2[];
  /** 等弧长采样（闭合，无重复尾点），DFT 输入 */
  samples: Vec2[];
  allComponents: CircleComponent[];
  ordered: CircleComponent[];
  rebuilt: Vec2[];
  report: DeviationReport;
  keep: number;
  order: OrderMode;
  view: ViewMode;
}

export interface Playback {
  phase: number;
  playing: boolean;
  /** 每秒走过的相位圈数 */
  speedHz: number;
}

export function buildModel(
  closedPoints: Vec2[],
  keep: number,
  order: OrderMode,
  view: ViewMode,
): AppModel {
  const samples = resampleArcLength(closedPoints, SAMPLE_COUNT, true);
  const allComponents = dft(samples);
  const retained = retainByAmplitude(allComponents, keep);
  const ordered = orderComponents(retained, order);
  const rebuilt = reconstruct(ordered, SAMPLE_COUNT);
  const report = analyzeDeviation(samples, rebuilt);
  return { rawClosed: closedPoints, samples, allComponents, ordered, rebuilt, report, keep, order, view };
}

export function modelAtPhase(model: AppModel, phase: number): { chain: Epicycle[]; tip: Vec2 } {
  const t = ((phase % 1) + 1) % 1;
  const chain = buildEpicycles(model.ordered, t);
  return { chain, tip: chainTip(chain) };
}

/** 当前相位下的原线点（与重建点同相位，供位置参照） */
export function originalAtPhase(model: AppModel, phase: number): Vec2 {
  const t = ((phase % 1) + 1) % 1;
  const idx = Math.round(t * SAMPLE_COUNT) % SAMPLE_COUNT;
  return model.samples[idx];
}

export function rebuiltAtPhase(model: AppModel, phase: number): Vec2 {
  const t = ((phase % 1) + 1) % 1;
  const idx = Math.round(t * SAMPLE_COUNT) % SAMPLE_COUNT;
  return model.rebuilt[idx];
}

/** 开放的重建轨迹：只包含 [0, phase] 区间，绝不跨接缝连回首点 */
export function trailUpTo(model: AppModel, phase: number): Vec2[] {
  const t = ((phase % 1) + 1) % 1;
  const end = Math.round(t * SAMPLE_COUNT);
  return model.rebuilt.slice(0, Math.max(1, end + 1));
}

export function directionCounts(components: CircleComponent[]): { ccw: number; cw: number } {
  let ccw = 0;
  let cw = 0;
  for (const c of components) {
    if (c.k > 0) ccw++;
    else if (c.k < 0) cw++;
  }
  return { ccw, cw };
}

/** 让整组点居中到模型原点附近，便于初始取景 */
export function recenter(points: Vec2[]): Vec2[] {
  const c = centroid(points);
  return points.map((p) => ({ x: p.x - c.x, y: p.y - c.y }));
}
