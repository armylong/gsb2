import type { ClickKind, VoiceSettings } from './types';

/**
 * 纯函数音色合成: 不依赖 AudioContext, 试听 (转成 AudioBuffer) 与
 * WAV 导出 (直接写 PCM) 用的是同一份采样, 保证「试听即导出」。
 * 输出峰值归一化到 1, 实际大小在混音时乘 voice.volume。
 */

/** 确定性 PRNG, 保证每次导出/测试逐采样一致 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 各类型点击的自然时长 (秒) 与衰减时间常数 */
export const CLICK_DURATION: Record<ClickKind, number> = {
  downbeat: 0.14,
  beat: 0.08,
  sub: 0.045,
};

function trianglePhase(phase: number): number {
  // phase in [0,1) -> [-1,1] 三角波
  const x = (phase % 1) * 4;
  return x < 2 ? x - 1 : 3 - x;
}

export function renderClick(voice: VoiceSettings, kind: ClickKind, sampleRate: number): Float32Array {
  const duration = CLICK_DURATION[kind];
  const length = Math.max(1, Math.round(duration * sampleRate));
  const out = new Float32Array(length);
  const tau = duration * 0.32;
  const rand = mulberry32(0x9e3779b9 ^ Math.round(voice.pitch) ^ kind.length);
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t / tau);
    const phase = voice.pitch * t;
    let y: number;
    switch (voice.timbre) {
      case 'sine':
        y = Math.sin(2 * Math.PI * phase) * env;
        break;
      case 'triangle':
        y = trianglePhase(phase) * env;
        break;
      case 'noise':
        // 白噪声经正弦环调, 形成以 pitch 为中心的敲击感
        y = (rand() * 2 - 1) * Math.sin(2 * Math.PI * phase) * env;
        break;
    }
    out[i] = y;
    const abs = Math.abs(y);
    if (abs > peak) peak = abs;
  }
  if (peak > 0) {
    const gain = 1 / peak;
    for (let i = 0; i < length; i++) out[i] *= gain;
  }
  return out;
}

/** 把一段点击采样叠加到混音缓冲的指定采样偏移 */
export function mixInto(
  mix: Float32Array,
  click: Float32Array,
  offsetSample: number,
  volume: number,
): void {
  if (volume <= 0) return;
  const start = Math.max(0, offsetSample);
  const end = Math.min(mix.length, offsetSample + click.length);
  for (let i = start; i < end; i++) {
    mix[i] += click[i - offsetSample] * volume;
  }
}

/** 末端软限幅: 仅在可能削波时启用, 否则原样保留 (保证离线混音逐采样可核对) */
export function softLimit(buffer: Float32Array): void {
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    const abs = Math.abs(buffer[i]);
    if (abs > peak) peak = abs;
  }
  if (peak <= 1) return;
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = Math.tanh(buffer[i]);
  }
}
