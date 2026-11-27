// 偏差分析：同相位（同一 t）比较原线与重建线，区分「整体平移」与「真正形变」
//
// 关键区分：
//   平移 = 两条曲线的 c0（重心）之差，是一个全局常量向量，不随相位变化
//   形变 = 去掉重心差之后，随相位变化的逐点残差
// 另提供两个参照场景：
//   - 正圆重建：任何保留数下都应近零偏差（圆本身只有 k=±1）
//   - 平移图形：重建残差近零，全部偏差集中在 translation 向量上

import type { Vec2 } from './geometry';
import { centroid, sub } from './geometry';

export interface DeviationPoint {
  t: number;
  /** 原线点 */
  original: Vec2;
  /** 重建点 */
  rebuilt: Vec2;
  /** 原始总偏差（含平移） */
  totalDelta: Vec2;
  /** 去掉整体平移后的形变残差 */
  shapeDelta: Vec2;
  /** 残差长度（像素） */
  shapeError: number;
  totalError: number;
}

export interface DeviationStats {
  /** 整体平移向量（两重心之差） */
  translation: Vec2;
  translationMagnitude: number;
  meanShapeError: number;
  maxShapeError: number;
  rmsShapeError: number;
  /** 形变能量占比：形变 RMS / (平移+形变) 总 RMS，帮助判断偏差来源 */
  shapeShare: number;
}

export interface DeviationReport {
  points: DeviationPoint[];
  stats: DeviationStats;
  /** 色阶归一化用的最大形变误差 */
  scaleMax: number;
}

/**
 * @param original  原线等弧长采样（闭合，不含重复尾点）
 * @param rebuilt   同相位、同数量的重建点
 */
export function analyzeDeviation(original: Vec2[], rebuilt: Vec2[]): DeviationReport {
  const n = Math.min(original.length, rebuilt.length);
  const cOrig = centroid(original.slice(0, n));
  const cReb = centroid(rebuilt.slice(0, n));
  const translation = sub(cReb, cOrig);

  const points: DeviationPoint[] = [];
  let sum = 0;
  let sumSq = 0;
  let max = 0;
  let totalSq = 0;
  for (let i = 0; i < n; i++) {
    const totalDelta = sub(rebuilt[i], original[i]);
    const shapeDelta = sub(totalDelta, translation);
    const shapeError = Math.hypot(shapeDelta.x, shapeDelta.y);
    const totalError = Math.hypot(totalDelta.x, totalDelta.y);
    sum += shapeError;
    sumSq += shapeError * shapeError;
    totalSq += totalError * totalError;
    max = Math.max(max, shapeError);
    points.push({
      t: i / n,
      original: original[i],
      rebuilt: rebuilt[i],
      totalDelta,
      shapeDelta,
      shapeError,
      totalError,
    });
  }
  const rmsShapeError = Math.sqrt(sumSq / n);
  const rmsTotal = Math.sqrt(totalSq / n);
  return {
    points,
    scaleMax: max,
    stats: {
      translation,
      translationMagnitude: Math.hypot(translation.x, translation.y),
      meanShapeError: sum / n,
      maxShapeError: max,
      rmsShapeError,
      shapeShare: rmsTotal > 1e-12 ? rmsShapeError / rmsTotal : 0,
    },
  };
}
