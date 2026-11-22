import type { DensityStats } from './density';
import type { PointCloud } from './scenes';

export interface BoundaryValidation {
  /** Otsu 在 log10(密度) 上求出的分界密度 (ppv) */
  threshold: number;
  /** 判为密集的点中真值也是密集 (label=1) 的比例 */
  precision: number;
  /** 真值密集点中被正确判为密集的比例 */
  recall: number;
  /** F1 分数 */
  f1: number;
  /** 混淆矩阵, 以"预测密集"为正类 */
  confusion: { tp: number; fp: number; tn: number; fn: number };
  denseMean: number;
  sparseMean: number;
  /** 两类均值在 log10 尺度上的间距, 越大越可分 */
  logSeparation: number;
}

/**
 * 一维 Otsu 阈值 (在 log10 密度直方图上最大化类间方差)。
 * 返回原值尺度的密度阈值; 全部同值时返回该值。
 */
export function otsuDensityThreshold(densities: Float32Array): number {
  const logs = new Float32Array(densities.length);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < densities.length; i++) {
    const v = Math.log10(Math.max(densities[i], 1e-9));
    logs[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi - lo < 1e-9) return 10 ** lo;

  const BINS = 128;
  const hist = new Array(BINS).fill(0);
  for (let i = 0; i < logs.length; i++) {
    const b = Math.min(BINS - 1, Math.floor(((logs[i] - lo) / (hi - lo)) * BINS));
    hist[b]++;
  }
  const total = logs.length;
  let sumAll = 0;
  for (let b = 0; b < BINS; b++) sumAll += b * hist[b];

  let w0 = 0;
  let sum0 = 0;
  let bestVar = -1;
  let bestBin = 0;
  for (let b = 0; b < BINS - 1; b++) {
    w0 += hist[b];
    if (w0 === 0) continue;
    const w1 = total - w0;
    if (w1 === 0) break;
    sum0 += b * hist[b];
    const m0 = sum0 / w0;
    const m1 = (sumAll - sum0) / w1;
    const between = w0 * w1 * (m0 - m1) ** 2;
    if (between > bestVar) {
      bestVar = between;
      bestBin = b;
    }
  }
  const logT = lo + ((bestBin + 1) / BINS) * (hi - lo);
  return 10 ** logT;
}

/**
 * 内置疏密分界验证: Otsu 自动阈值 vs 场景真值标签。
 * label=1 视为密集结构 (面/团簇), label=0 视为稀疏噪点。
 */
export function validateBoundary(cloud: PointCloud, stats: DensityStats): BoundaryValidation {
  const threshold = otsuDensityThreshold(stats.densities);
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let denseLogSum = 0;
  let sparseLogSum = 0;
  let denseN = 0;
  let sparseN = 0;

  for (let k = 0; k < stats.active.length; k++) {
    const truth = cloud.labels[stats.active[k]];
    const predDense = stats.densities[k] >= threshold ? 1 : 0;
    if (predDense && truth) tp++;
    else if (predDense && !truth) fp++;
    else if (!predDense && !truth) tn++;
    else fn++;
    if (truth) {
      denseLogSum += Math.log10(Math.max(stats.densities[k], 1e-9));
      denseN++;
    } else {
      sparseLogSum += Math.log10(Math.max(stats.densities[k], 1e-9));
      sparseN++;
    }
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const denseMean = denseN ? 10 ** (denseLogSum / denseN) : 0;
  const sparseMean = sparseN ? 10 ** (sparseLogSum / sparseN) : 0;
  return {
    threshold,
    precision,
    recall,
    f1,
    confusion: { tp, fp, tn, fn },
    denseMean,
    sparseMean,
    logSeparation: Math.log10(denseMean / Math.max(sparseMean, 1e-9)),
  };
}
