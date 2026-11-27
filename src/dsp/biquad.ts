import { clamp } from '../types';

/**
 * RBJ cookbook band-pass（常数 0 dB 峰值版），bw = f0/Q 即半功率带宽。
 * 系数集可被逐样本线性插值，配合每块更新实现无爆音的时变滤波。
 */
export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function bandpassCoeffs(freq: number, bandwidth: number, sampleRate: number): BiquadCoeffs {
  const f = clamp(freq, 8, sampleRate / 2 - 8);
  const q = clamp(f / Math.max(1, bandwidth), 0.1, 60);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (alpha / a0),
    b1: 0,
    b2: (-alpha / a0),
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function lerpCoeffs(a: BiquadCoeffs, b: BiquadCoeffs, t: number): BiquadCoeffs {
  return {
    b0: a.b0 + (b.b0 - a.b0) * t,
    b1: a.b1 + (b.b1 - a.b1) * t,
    b2: a.b2 + (b.b2 - a.b2) * t,
    a1: a.a1 + (b.a1 - a.a1) * t,
    a2: a.a2 + (b.a2 - a.a2) * t,
  };
}

/** 转置直型 II 的每路滤波器状态 */
export class BiquadStage {
  private z1 = 0;
  private z2 = 0;

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  process(x: number, c: BiquadCoeffs): number {
    const y = c.b0 * x + this.z1;
    this.z1 = c.b1 * x - c.a1 * y + this.z2;
    this.z2 = c.b2 * x - c.a2 * y;
    return y;
  }
}

/** 滤波器在频率 f 处的解析幅度（线性），用于绘制共振形状曲线 */
export function magnitudeAt(c: BiquadCoeffs, f: number, sampleRate: number): number {
  const theta = (2 * Math.PI * f) / sampleRate;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  // z = e^{-jθ}；z^2 = e^{-j2θ}
  const cos2 = cosT * cosT - sinT * sinT;
  const sin2 = 2 * sinT * cosT;
  // H(z) = (b0 + b1·z + b2·z²) / (1 + a1·z + a2·z²)
  const numRe = c.b0 + c.b1 * cosT + c.b2 * cos2;
  const numIm = -(c.b1 * sinT + c.b2 * sin2);
  const denRe = 1 + c.a1 * cosT + c.a2 * cos2;
  const denIm = -(c.a1 * sinT + c.a2 * sin2);
  return Math.hypot(numRe, numIm) / Math.max(1e-12, Math.hypot(denRe, denIm));
}
