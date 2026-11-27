/** 全局共享类型与常量 */

export const SAMPLE_RATE = 44100;

/** 可稳定合成与分析的频带（Hz） */
export const MIN_FREQ = 40;
export const MAX_FREQ = 12000;

/** 一个共振区（一段共振峰）的参数 */
export interface FormantRegion {
  /** 中心频率 Hz */
  center: number;
  /** 带宽 Hz（半功率带宽，与 RBJ bandpass 的 bw 参数一致） */
  bandwidth: number;
  /** 线性增益 */
  gain: number;
}

/** 时间线上一个口形节点 */
export interface VowelKey {
  /** 节点位置，0..1（相对时长） */
  pos: number;
  label: string;
  formants: [FormantRegion, FormantRegion, FormantRegion];
}

export interface Timeline {
  /** 2 个或 3 个节点，pos 单调递增，首尾固定为 0 与 1 */
  keys: VowelKey[];
  middleEnabled: boolean;
  /** 拐点位置 0..1（middleEnabled 为 true 时生效） */
  middlePos: number;
}

export interface RenderOptions {
  sampleRate: number;
  /** 时长 s */
  duration: number;
  /** 声源基频 Hz（全程恒定） */
  f0: number;
  /** 气音混合比例 0..1（0 = 纯浊音，1 = 纯噪声） */
  noiseMix: number;
  timeline: Timeline;
  /** 归一化目标 RMS（线性），null 表示不做 RMS 归一化 */
  normalizeTo: number | null;
  /** 随机种子，保证同一参数合成结果可复现 */
  seed: number;
}

export interface RenderResult {
  samples: Float32Array;
  sampleRate: number;
  /** 渲染后 RMS */
  rms: number;
  /** 渲染后峰值（绝对值） */
  peak: number;
  warnings: string[];
}

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

export const dbToGain = (db: number): number => 10 ** (db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(1e-12, g));
