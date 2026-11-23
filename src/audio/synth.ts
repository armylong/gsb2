import { Sample } from '../model/types';

/**
 * 内置音色：全部通过 OfflineAudioContext 离线渲染成 AudioBuffer，
 * 噪声用固定种子的 mulberry32 生成，保证每次渲染结果一致、可重建，无需持久化音频数据。
 * 五组音色在频谱和峰值音量上刻意拉开差距，便于听出交叉/轮换/连按。
 */

export interface SynthSpec {
  id: string;
  name: string;
  /** 渲染时长 s */
  duration: number;
  /** 目标峰值 dBFS，各音色响度不同 */
  peakDb: number;
  baseFreq: number;
  /** 音调包络：起始频率倍率 */
  pitchDrop: number;
  osc: OscillatorType;
  /** 噪声部分的滤波器参数 */
  noiseType: BiquadFilterType;
  noiseFreq: number;
  /** 噪声相对正弦体的比例 0..1 */
  noiseMix: number;
  /** 起音/释放 s */
  attack: number;
  release: number;
}

export const BUILTIN_SYNTHS: SynthSpec[] = [
  {
    id: 'synth-soft-thud',
    name: '闷响（轻）',
    duration: 0.28,
    peakDb: -20,
    baseFreq: 110,
    pitchDrop: 0.55,
    osc: 'sine',
    noiseType: 'lowpass',
    noiseFreq: 500,
    noiseMix: 0.25,
    attack: 0.004,
    release: 0.18,
  },
  {
    id: 'synth-wood-tap',
    name: '木质叩击（中）',
    duration: 0.22,
    peakDb: -13,
    baseFreq: 320,
    pitchDrop: 0.7,
    osc: 'triangle',
    noiseType: 'bandpass',
    noiseFreq: 1800,
    noiseMix: 0.4,
    attack: 0.002,
    release: 0.12,
  },
  {
    id: 'synth-stone-crack',
    name: '碎石（响）',
    duration: 0.3,
    peakDb: -8,
    baseFreq: 210,
    pitchDrop: 0.45,
    osc: 'square',
    noiseType: 'highpass',
    noiseFreq: 2600,
    noiseMix: 0.65,
    attack: 0.002,
    release: 0.16,
  },
  {
    id: 'synth-muffled-low',
    name: '低沉闷踩（很轻）',
    duration: 0.34,
    peakDb: -23,
    baseFreq: 68,
    pitchDrop: 0.6,
    osc: 'sine',
    noiseType: 'lowpass',
    noiseFreq: 240,
    noiseMix: 0.2,
    attack: 0.006,
    release: 0.24,
  },
  {
    id: 'synth-metal-clink',
    name: '金属脆响（亮）',
    duration: 0.26,
    peakDb: -15,
    baseFreq: 880,
    pitchDrop: 0.92,
    osc: 'triangle',
    noiseType: 'highpass',
    noiseFreq: 4200,
    noiseMix: 0.5,
    attack: 0.001,
    release: 0.16,
  },
];

export function synthSpec(id: string): SynthSpec | undefined {
  return BUILTIN_SYNTHS.find((s) => s.id === id);
}

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

/** 按 spec 离线渲染一帧 AudioBuffer（采样率跟随传入的 context） */
export async function renderSynth(ctx: BaseAudioContext, spec: SynthSpec): Promise<AudioBuffer> {
  const sr = ctx.sampleRate;
  const length = Math.ceil(spec.duration * sr);
  const offline = new OfflineAudioContext(1, length, sr);
  const t0 = 0;

  const env = offline.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(1, t0 + spec.attack);
  env.gain.setValueAtTime(1, t0 + spec.attack);
  env.gain.linearRampToValueAtTime(0.0001, t0 + spec.duration - spec.release);
  env.gain.linearRampToValueAtTime(0, t0 + spec.duration);
  env.connect(offline.destination);

  // 主体：带音高下滑的振荡器
  const osc = offline.createOscillator();
  osc.type = spec.osc;
  osc.frequency.setValueAtTime(spec.baseFreq, t0);
  osc.frequency.exponentialRampToValueAtTime(
    Math.max(20, spec.baseFreq * spec.pitchDrop),
    t0 + spec.duration * 0.5,
  );
  const oscGain = offline.createGain();
  oscGain.gain.value = 1 - spec.noiseMix;
  osc.connect(oscGain).connect(env);
  osc.start(t0);
  osc.stop(t0 + spec.duration);

  // 噪声部分：固定种子白噪声 + 滤波器
  const rand = mulberry32(hashCode(spec.id));
  const noiseBuf = offline.createBuffer(1, length, sr);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = rand() * 2 - 1;
  const noise = offline.createBufferSource();
  noise.buffer = noiseBuf;
  const filter = offline.createBiquadFilter();
  filter.type = spec.noiseType;
  filter.frequency.value = spec.noiseFreq;
  filter.Q.value = 0.9;
  const noiseGain = offline.createGain();
  noiseGain.gain.value = spec.noiseMix;
  noise.connect(filter).connect(noiseGain).connect(env);
  noise.start(t0);
  noise.stop(t0 + spec.duration);

  const rendered = await offline.startRendering();

  // 归一化到 spec.peakDb，让不同音色的响度差异确定、可听
  const targetPeak = Math.pow(10, spec.peakDb / 20);
  let peak = 0;
  for (let i = 0; i < rendered.length; i++) peak = Math.max(peak, Math.abs(rendered.getChannelData(0)[i]));
  if (peak > 0) {
    const k = targetPeak / peak;
    const ch = rendered.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] *= k;
  }
  return rendered;
}

function hashCode(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 内置素材的默认 gainDb 均为 0，响度差异已烘焙进渲染峰值 */
export function builtinSample(spec: SynthSpec): Sample {
  return {
    id: spec.id,
    name: spec.name,
    source: { kind: 'builtin', synthId: spec.id },
    gainDb: 0,
  };
}
