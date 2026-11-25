/**
 * 基-2 原地复数 FFT 与实信号 DFT 工具。
 * 全部使用普通可擦除 TypeScript 语法，无浏览器依赖，可被 node --test 直接导入。
 */

export interface Complex {
  re: Float64Array;
  im: Float64Array;
}

/** 基-2 迭代 FFT（原地）。n 必须是 2 的幂；inverse=true 做逆变换（不除 n，由调用方处理）。 */
export function fftRadix2(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT 长度必须是 2 的幂');
  if (im.length !== n) throw new Error('虚实部长度不一致');

  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (sign * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = curR * re[b] - curI * im[b];
        const ti = curR * im[b] + curI * re[b];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** 实序列 DFT，返回复数谱（长度 n，含完整 n 个 bin，0..n-1）。 */
export function realDft(samples: ArrayLike<number>): Complex {
  const n = samples.length;
  const re = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = samples[i];
  const im = new Float64Array(n);
  fftRadix2(re, im, false);
  return { re, im };
}

/** 实序列 DFT 的单边幅度/相位（bin 0..n/2）。幅度按单边谱约定 ×2/n（直流不翻倍）。 */
export function realDftOneSided(samples: ArrayLike<number>): {
  freqIndex: number[];
  magnitude: Float64Array;
  phase: Float64Array;
} {
  const n = samples.length;
  const { re, im } = realDft(samples);
  const bins = n >> 1;
  const magnitude = new Float64Array(bins + 1);
  const phase = new Float64Array(bins + 1);
  const freqIndex: number[] = [];
  for (let k = 0; k <= bins; k++) {
    freqIndex.push(k);
    const raw = Math.hypot(re[k], im[k]);
    magnitude[k] = k === 0 || k === bins ? raw / n : (2 * raw) / n;
    phase[k] = Math.atan2(im[k], re[k]);
  }
  return { freqIndex, magnitude, phase };
}

/** 由单边谐波系数重建周期表：x[n] = a0 + Σ aₖ cos(2πkn/N + φₖ)。 */
export function reconstructTable(
  n: number,
  mag: Float64Array,
  phase: Float64Array,
): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = mag[0]; // 直流（单边约定里 mag[0] 已是 a0）
    const bins = n >> 1;
    for (let k = 1; k < bins; k++) {
      v += mag[k] * Math.cos((2 * Math.PI * k * i) / n + phase[k]);
    }
    // 奈奎斯特 bin 余弦项不翻倍
    v += mag[bins] * Math.cos(Math.PI * i);
    out[i] = v;
  }
  return out;
}

/** Hann 窗（周期形式，分母 N 而非 N-1）。 */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** 幅度转 dB（以满刻度 1.0 为 0 dBFS）。 */
export function toDb(amp: number, floorDb = -120): number {
  if (amp <= 1e-12) return floorDb;
  return Math.max(floorDb, 20 * Math.log10(amp));
}
