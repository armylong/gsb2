/**
 * 回读分析：对 WAV 两个声道做 FFT，估计主频率/幅度/初始相位，
 * 核对左右接线（哪一路纯音在哪个声道）与拍频 |fA−fB|。
 */

/** 迭代 radix-2 FFT，输入长度必须是 2 的幂；就地计算 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export interface ToneEstimate {
  freq: number;
  amplitude: number;
  phase: number;
  /** 该声道 RMS */
  rms: number;
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** 跳过首尾淡变，取中段做估计 */
function middleSegment(x: Float32Array, sampleRate: number, marginS = 0.05): Float32Array {
  const margin = Math.min(Math.floor(sampleRate * marginS), Math.floor(x.length / 4));
  const start = margin;
  const end = x.length - margin;
  return x.subarray(start, end);
}

/**
 * 双窗 DFT 相位差精修（相位声码器法）。
 * 关键：DFT 必须在精修窗的整数 bin 频率 fb 上计算，
 * 这样窗内整数周期部分只贡献 2π 的整数倍，卷绕后只剩残差相位。
 *   f_true = fb + (Δφ/2π)·binHz
 * 纯音场景误差可低于 0.001 Hz。
 */
function dftPhaseAt(x: Float32Array, offset: number, n: number, f0: number, sampleRate: number): number {
  const w = (2 * Math.PI * f0) / sampleRate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const v = x[offset + i];
    const ang = w * i;
    re += v * Math.cos(ang);
    im -= v * Math.sin(ang);
  }
  return Math.atan2(im, re);
}

function refineFrequency(seg: Float32Array, coarse: number, sampleRate: number): number {
  const n = Math.min(16384, Math.floor(seg.length / 2));
  if (n < 4096) return coarse;
  const binHz = sampleRate / n;
  // 对齐到精修窗的整数 bin（不是粗估 FFT 的 bin）
  const fb = Math.round(coarse / binHz) * binHz;
  const p1 = dftPhaseAt(seg, 0, n, fb, sampleRate);
  const p2 = dftPhaseAt(seg, n, n, fb, sampleRate);
  let dphi = p2 - p1;
  dphi -= 2 * Math.PI * Math.round(dphi / (2 * Math.PI));
  const refined = fb + (dphi / (2 * Math.PI)) * binHz;
  // 只接受一个 bin 以内的修正，拒绝粗估偏到相邻 bin 的野值
  return Math.abs(refined - coarse) <= binHz ? refined : coarse;
}

/** 估计单声道中最强的纯音（大 FFT 定位 + 双窗相位差精修） */
export function estimateTone(x: Float32Array, sampleRate: number): ToneEstimate {
  const seg = middleSegment(x, sampleRate);
  let n = 1;
  while (n * 2 <= seg.length) n *= 2;
  n = Math.min(n, 65536);
  const win = hann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let rms = 0;
  for (let i = 0; i < n; i++) {
    re[i] = seg[i] * win[i];
    rms += seg[i] * seg[i];
  }
  fft(re, im);
  let peak = 0;
  let peakMag = -1;
  for (let k = 1; k < n / 2; k++) {
    const mag = re[k] * re[k] + im[k] * im[k];
    if (mag > peakMag) {
      peakMag = mag;
      peak = k;
    }
  }
  // 抛物线插值
  const mL = re[peak - 1] ** 2 + im[peak - 1] ** 2;
  const m0 = peakMag;
  const mR = re[peak + 1] ** 2 + im[peak + 1] ** 2;
  const shift = (0.5 * (mL - mR)) / (mL - 2 * m0 + mR || 1);
  const binHz = sampleRate / n;
  const coarse = (peak + shift) * binHz;
  const freq = refineFrequency(seg, coarse, sampleRate);
  // 汉宁窗相干增益 0.5：单频幅度 A 的 |X| 峰值 ≈ A·N/4 → A = 4|X|/N
  const amplitude = (4 * Math.sqrt(peakMag)) / n;
  const phase = Math.atan2(im[peak], re[peak]);
  return { freq, amplitude, phase, rms: Math.sqrt(rms / seg.length) };
}

/** 检查声道里是否同时含有两个频率（混合模式），返回两个最强分量 */
export function estimateTwoTones(x: Float32Array, sampleRate: number): [ToneEstimate, ToneEstimate] {
  const seg = middleSegment(x, sampleRate);
  let n = 1;
  while (n * 2 <= seg.length) n *= 2;
  n = Math.min(n, 65536);
  const win = hann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = seg[i] * win[i];
  fft(re, im);
  const mags = new Float64Array(n / 2);
  for (let k = 1; k < n / 2; k++) mags[k] = re[k] * re[k] + im[k] * im[k];
  const pick = (exclude: number): { k: number; mag: number } => {
    let best = 0;
    let bestMag = -1;
    for (let k = 1; k < n / 2; k++) {
      if (Math.abs(k - exclude) < 3) continue;
      if (mags[k] > bestMag) {
        bestMag = mags[k];
        best = k;
      }
    }
    return { k: best, mag: bestMag };
  };
  const p1 = pick(0);
  const p2 = pick(p1.k);
  const toEst = (k: number, mag: number): ToneEstimate => {
    const shift =
      (0.5 * (mags[k - 1] - mags[k + 1])) / (mags[k - 1] - 2 * mag + mags[k + 1] || 1);
    return {
      freq: (k + shift) * (sampleRate / n),
      amplitude: (4 * Math.sqrt(mag)) / n,
      phase: Math.atan2(im[k], re[k]),
      rms: 0,
    };
  };
  return [toEst(p1.k, p1.mag), toEst(p2.k, p2.mag)];
}

export interface ReadbackReport {
  sampleRate: number;
  duration: number;
  left: ToneEstimate;
  right: ToneEstimate;
  /** split: 左右各一个不同主音；mix: 两边主音相同 */
  routing: 'split' | 'mix' | 'unknown';
  /** 拍频估计（Hz）；混合声道用两个分量，分送用左右主频之差 */
  beatHz: number;
  /** 左声道主频率 */
  leftFreq: number;
  rightFreq: number;
  warnings: string[];
}

export function analyzeWav(channels: Float32Array[], sampleRate: number): ReadbackReport {
  const warnings: string[] = [];
  if (channels.length < 2) {
    throw new Error('回读需要双声道 WAV');
  }
  const [l, r] = channels;
  const left = estimateTone(l, sampleRate);
  const right = estimateTone(r, sampleRate);
  const lTwo = estimateTwoTones(l, sampleRate);
  const rTwo = estimateTwoTones(r, sampleRate);

  const lSep = Math.abs(lTwo[0].freq - lTwo[1].freq);
  const rSep = Math.abs(rTwo[0].freq - rTwo[1].freq);
  const sideSep = Math.abs(left.freq - right.freq);

  let routing: ReadbackReport['routing'] = 'unknown';
  let beatHz = 0;
  // 两个声道都含一对频率、且两边主频接近 → mix
  const bothDual = lSep > 1 && rSep > 1 && Math.abs(lTwo[0].freq - rTwo[0].freq) < 2;
  // 两边各一个不同主频、且各自第二分量很弱 → split
  const lRatio = lTwo[1].amplitude / (lTwo[0].amplitude || 1e-9);
  const rRatio = rTwo[1].amplitude / (rTwo[0].amplitude || 1e-9);

  if (bothDual) {
    routing = 'mix';
    beatHz = (lSep + rSep) / 2;
  } else if (sideSep > 0.5 && lRatio < 0.15 && rRatio < 0.15) {
    routing = 'split';
    beatHz = sideSep;
  } else {
    routing = 'unknown';
    beatHz = Math.max(sideSep, (lSep + rSep) / 2);
    warnings.push('接线方式无法明确判定，请结合频谱查看');
  }

  if (Math.abs(left.rms - right.rms) / Math.max(left.rms, 1e-9) > 0.1) {
    warnings.push('左右声道电平差超过 10%，请检查电平设置');
  }

  return {
    sampleRate,
    duration: l.length / sampleRate,
    left,
    right,
    routing,
    beatHz,
    leftFreq: left.freq,
    rightFreq: right.freq,
    warnings,
  };
}

/** 期望拍频（Hz） */
export function expectedBeat(fA: number, fB: number): number {
  return Math.abs(fA - fB);
}
