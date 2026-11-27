import type { Spectrum } from './fft';
import { MAX_FREQ, MIN_FREQ } from '../types';

export interface SpectralPeak {
  freq: number;
  magDb: number;
  bin: number;
  /** 局部 prominence（相对相邻谷值的高度，dB） */
  prominence: number;
}

/** 在谱上找局部极大值并计算 prominence；只保留 [minFreq, maxFreq] 范围 */
export function findPeaks(spec: Spectrum, minFreq = MIN_FREQ, maxFreq = MAX_FREQ): SpectralPeak[] {
  const { freqs, magDb } = spec;
  const peaks: SpectralPeak[] = [];
  for (let k = 2; k < magDb.length - 2; k++) {
    if (freqs[k] < minFreq || freqs[k] > maxFreq) continue;
    if (magDb[k] <= magDb[k - 1] || magDb[k] < magDb[k + 1]) continue;
    // 向左右找到被更高峰夹住的最低点，估算 prominence
    let leftMin = magDb[k];
    for (let j = k - 1; j >= 1; j--) {
      if (magDb[j] > magDb[k]) break;
      leftMin = Math.min(leftMin, magDb[j]);
    }
    let rightMin = magDb[k];
    for (let j = k + 1; j < magDb.length - 1; j++) {
      if (magDb[j] > magDb[k]) break;
      rightMin = Math.min(rightMin, magDb[j]);
    }
    const prominence = magDb[k] - Math.max(leftMin, rightMin);
    peaks.push({ freq: freqs[k], magDb: magDb[k], bin: k, prominence });
  }
  return peaks.sort((a, b) => b.prominence - a.prominence);
}

/**
 * 峰是否“清楚”：prominence 达标且高于噪声地板。
 * 气音过重或共振区重叠到只剩一个峰时，返回 false 并由调用方给出提示。
 */
export function isPeakClear(peak: SpectralPeak | undefined, noiseFloorDb: number): boolean {
  if (!peak) return false;
  return peak.prominence >= 6 && peak.magDb - noiseFloorDb >= 10;
}

/** 估计噪声地板：最低四分位的平均 dB */
export function noiseFloor(spec: Spectrum, minFreq = MIN_FREQ, maxFreq = MAX_FREQ): number {
  const vals: number[] = [];
  for (let k = 0; k < spec.magDb.length; k++) {
    if (spec.freqs[k] >= minFreq && spec.freqs[k] <= maxFreq) vals.push(spec.magDb[k]);
  }
  vals.sort((a, b) => a - b);
  const q = vals.slice(0, Math.max(1, Math.floor(vals.length / 4)));
  return q.reduce((s, v) => s + v, 0) / q.length;
}

/** 自相关基频检测：归一化自相关 + 局部极大 + 短周期优先（防低八度误判），返回 Hz 或 null */
export function detectF0(samples: Float32Array, sampleRate: number, minF0 = 50, maxF0 = 500): number | null {
  const n = samples.length;
  const minLag = Math.floor(sampleRate / maxF0);
  const maxLag = Math.min(Math.ceil(sampleRate / minF0), n - 2);

  // 前缀能量，用于每个 lag 的归一化（皮尔逊式相关，对幅度变化不敏感）
  let totalEnergy = 0;
  for (let i = 0; i < n; i++) totalEnergy += samples[i] * samples[i];
  if (totalEnergy < 1e-10) return null;

  const acf = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i + lag < n; i++) {
      s += samples[i] * samples[i + lag];
      e1 += samples[i] * samples[i];
      e2 += samples[i + lag] * samples[i + lag];
    }
    acf[lag] = e1 > 0 && e2 > 0 ? s / Math.sqrt(e1 * e2) : 0;
  }

  // 全部局部极大
  const maxima: { lag: number; val: number }[] = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (acf[lag] > acf[lag - 1] && acf[lag] >= acf[lag + 1]) {
      maxima.push({ lag, val: acf[lag] });
    }
  }
  if (maxima.length === 0) return null;
  const globalMax = maxima.reduce((m, x) => Math.max(m, x.val), 0);
  // 周期性太弱（如纯气音经共振峰后的衰减振铃）视为没有清楚音高
  if (globalMax < 0.45) return null;

  // 八度纠正：在达到全局峰值 85% 的候选里取最短周期，避免锁到 2T/3T
  const strong = maxima.filter((x) => x.val >= 0.85 * globalMax).sort((a, b) => a.lag - b.lag);
  const chosen = strong[0] ?? maxima[0];

  // 抛物线插值提高频率精度
  const lag = chosen.lag;
  const y0 = acf[lag - 1];
  const y1 = acf[lag];
  const y2 = acf[lag + 1];
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
  const refinedLag = lag + Math.max(-1, Math.min(1, shift));
  return sampleRate / refinedLag;
}
