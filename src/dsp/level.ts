/**
 * 等响度对齐：估计 RMS 并平滑归一。
 * 两种播放模式共用同一目标电平，保证“相同音量在几个八度间比较”。
 */
import { rms } from './wavetable';

export const TARGET_RMS = 0.12;

/** 对整段信号按 RMS 归一（静音则原样返回）。 */
export function normalizeRms(signal: Float64Array, target = TARGET_RMS): Float64Array {
  const level = rms(signal);
  if (level < 1e-6) return signal.slice();
  const g = target / level;
  return signal.map((v) => v * g);
}

/**
 * 流式 RMS 平滑增益（一极点），供 AudioWorklet / 离线逐块渲染共用。
 * timeConstantSeconds 控制电平估计窗口。
 */
export class RmsLeveler {
  private env = 0;
  private readonly coeff: number;
  readonly target: number;

  constructor(sampleRate: number, timeConstantSeconds = 0.12, target = TARGET_RMS) {
    this.coeff = 1 - Math.exp(-1 / (sampleRate * timeConstantSeconds));
    this.target = target;
  }

  /** 处理一块样本，就地写入 out（out 可与 in 同数组）。 */
  process(input: Float32Array, out: Float32Array): void {
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      this.env += this.coeff * (x * x - this.env);
      const level = Math.sqrt(this.env) + 1e-7;
      const g = Math.min(8, this.target / level); // 限幅防爆
      out[i] = x * g;
    }
  }

  reset(): void {
    this.env = 0;
  }
}

/** 离线版：对整段做逐采样一极点归一，返回新数组。 */
export function levelOffline(signal: Float64Array, sampleRate: number): Float64Array {
  const leveler = new RmsLeveler(sampleRate);
  const f32in = Float32Array.from(signal);
  const f32out = new Float32Array(signal.length);
  leveler.process(f32in, f32out);
  return Float64Array.from(f32out);
}
