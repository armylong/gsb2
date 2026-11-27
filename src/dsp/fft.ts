/** 迭代基数-2 FFT（in-place，长度需为 2 的幂），纯 TypeScript，无外部依赖 */

export interface ComplexArray {
  re: Float64Array;
  im: Float64Array;
}

export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT 长度必须是 2 的幂');

  // 位逆序置换
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
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Hann 窗 */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

export interface Spectrum {
  /** 每个 bin 的频率 */
  freqs: Float64Array;
  /** 幅度 dB */
  magDb: Float64Array;
  fftSize: number;
  sampleRate: number;
}

/** 对一段 PCM 加 Hann 窗（零填充到 fftSize）后做单边幅度谱，输出 dB */
export function computeSpectrum(
  samples: Float32Array,
  sampleRate: number,
  fftSize = 2048,
): Spectrum {
  const window = hannWindow(samples.length);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let i = 0; i < samples.length && i < fftSize; i++) re[i] = samples[i] * window[i];
  fft(re, im);
  const bins = fftSize >> 1;
  const freqs = new Float64Array(bins);
  const magDb = new Float64Array(bins);
  const norm = samples.length / 2;
  for (let k = 0; k < bins; k++) {
    freqs[k] = (k * sampleRate) / fftSize;
    const mag = Math.hypot(re[k], im[k]) / norm;
    magDb[k] = 20 * Math.log10(Math.max(1e-8, mag));
  }
  return { freqs, magDb, fftSize, sampleRate };
}
