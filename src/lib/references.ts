// 偏差视图的两个参照场景（题目要求：用正圆与整体平移图形作参照，
// 区分「位置平移」与「真正形变」）。全部用当前保留数量计算，保证可对比。

import type { Vec2 } from './geometry';
import { centroid } from './geometry';
import { dft, orderComponents, reconstruct, retainByAmplitude } from './dft';
import { analyzeDeviation, type DeviationReport } from './deviation';
import { makeCircle, makeLeaf, translatePoints } from './presets';

export interface ReferenceScene {
  title: string;
  original: Vec2[];
  rebuilt: Vec2[];
  report: DeviationReport;
  note: string;
}

const N = 256;

/** 正圆参照：无论保留多少（>=2），重建都应近零偏差 */
export function circleReference(keep: number): ReferenceScene {
  const original = makeCircle(60, N);
  const comps = dft(original);
  const rebuilt = reconstruct(orderComponents(retainByAmplitude(comps, Math.max(2, keep)), 'frequency'), N);
  const report = analyzeDeviation(original, rebuilt);
  return {
    title: '正圆',
    original,
    rebuilt,
    report,
    note: `无形变基线：最大形变 ${report.stats.maxShapeError.toExponential(1)}px`,
  };
}

/**
 * 整体平移参照：同一张歪叶片整体平移后再重建。
 * 原始总偏差 ≈ 平移量，但去掉重心差之后形变仍为零。
 */
export function translatedReference(keep: number): ReferenceScene {
  const base = makeLeaf(N);
  const original = translatePoints(base, 34, -22);
  const comps = dft(original);
  const rebuilt = reconstruct(orderComponents(retainByAmplitude(comps, keep), 'frequency'), N);
  const report = analyzeDeviation(original, rebuilt);
  const c0 = centroid(original);
  return {
    title: '整体平移',
    original,
    rebuilt,
    report,
    note: `平移 ${report.stats.translationMagnitude.toFixed(1)}px，去重心后最大形变 ${report.stats.maxShapeError.toExponential(1)}px；重心 (${c0.x.toFixed(0)}, ${c0.y.toFixed(0)})`,
  };
}
