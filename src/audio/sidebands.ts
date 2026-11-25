import { besselJ } from './bessel';
import type { FmPatch } from './types';

export interface Sideband {
  /** 阶数 n, 侧带为 fc + n*fm (n 可负) */
  order: number;
  /** 理论标称频率 fc + n*fm, 可能为负或超过 Nyquist */
  nominalHz: number;
  /** 采样后实际可听位置: 负频率折叠 |f|, 超 Nyquist 再按三角方式折回 */
  audibleHz: number;
  /** 相对载波的电平 (dB), 20*log10(|J_n(I)|), 载波本身按 J_0 */
  levelDb: number;
  /** 标称分量在离散采样下会被别名折叠 */
  aliased: boolean;
  /** 标称频率为负, 数学上与其正频率对偶分量叠加 */
  negativeNominal: boolean;
}

export interface SidebandAnalysis {
  carrierHz: number;
  modulatorHz: number;
  peakIndex: number;
  nyquistHz: number;
  sidebands: Sideband[];
  /** 是否有任何标称分量超过 Nyquist(会发生折叠) */
  hasAboveNyquist: boolean;
  /** 最高一个 |J_n| 仍高于阈值的标称频率 */
  highestNominalHz: number;
}

/**
 * 三角折叠: 把任意实频率映射到 [0, nyquist]。
 * 与离散采样的频谱别名一致(先 |f| 折到正半轴, 再对 2*nyquist 三角折回)。
 */
export function foldFrequency(freqHz: number, nyquistHz: number): number {
  let f = Math.abs(freqHz);
  const period = 2 * nyquistHz;
  f = f % period;
  if (f > nyquistHz) f = period - f;
  return f;
}

/**
 * 依据峰值调制指数 I = modDepth 计算主要侧带。
 * FM: x(t) = sin(2π fc t + I·curve(t)·sin(2π fm t))
 * 稳态分量幅度即 J_n(I), 频率 fc + n·fm。
 */
export function analyzeSidebands(
  patch: FmPatch,
  carrierHz: number,
  sampleRate: number,
  options: { maxOrder?: number; minLevelDb?: number } = {},
): SidebandAnalysis {
  const maxOrder = options.maxOrder ?? 48;
  const minLevelDb = options.minLevelDb ?? -60;
  const nyquistHz = sampleRate / 2;
  const modulatorHz = carrierHz * patch.modRatio;
  const I = patch.modDepth;

  const bands: Sideband[] = [];
  let hasAboveNyquist = false;
  let highestNominalHz = carrierHz;

  for (let n = -maxOrder; n <= maxOrder; n++) {
    const j = Math.abs(besselJ(Math.abs(n), I));
    if (j < 1e-7) continue;
    const levelDb = 20 * Math.log10(j);
    if (levelDb < minLevelDb) continue;

    const nominalHz = carrierHz + n * modulatorHz;
    const negativeNominal = nominalHz < 0;
    const above = Math.abs(nominalHz) > nyquistHz;
    if (above) hasAboveNyquist = true;
    if (Math.abs(nominalHz) > Math.abs(highestNominalHz)) highestNominalHz = nominalHz;

    bands.push({
      order: n,
      nominalHz,
      audibleHz: foldFrequency(nominalHz, nyquistHz),
      levelDb,
      aliased: above,
      negativeNominal,
    });
  }

  // 按标称频率绝对值排序, 方便从低到高查看
  bands.sort((a, b) => Math.abs(a.nominalHz) - Math.abs(b.nominalHz));

  return {
    carrierHz,
    modulatorHz,
    peakIndex: I,
    nyquistHz,
    sidebands: bands,
    hasAboveNyquist,
    highestNominalHz,
  };
}
