/**
 * 音色与包络的参数模型。
 *
 * 一次只管一种音色：一个振荡器波形 + 一条四段包络
 * （attack / decay / sustain / release，即 ADSR）。
 * 每段额外带一个 shape ∈ [-1, 1] 的曲线形状参数：
 *   -1 指数凹形（对数感，常用），0 线性，+1 指数凸形。
 */

export type Waveform = 'sine' | 'triangle' | 'sawtooth' | 'square';

/** 一个 ADSR 段的描述。sustain 段时长由按键时长决定，不在这里。 */
export interface EnvelopeParams {
  /** 起音时长（秒） */
  attack: number;
  /** 衰减时长（秒） */
  decay: number;
  /** 保持电平 [0, 1] */
  sustain: number;
  /** 释放时长（秒） */
  release: number;
  /** 各段曲线形状 [-1, 1] */
  attackShape: number;
  decayShape: number;
  releaseShape: number;
}

export interface TimbreParams {
  waveform: Waveform;
  /** 振荡器基频 Hz */
  frequency: number;
  envelope: EnvelopeParams;
  /** 输出增益（所有力度最终再乘这个系数），默认 0.8 防削波 */
  masterGain: number;
}

export const DEFAULT_ENVELOPE: EnvelopeParams = {
  attack: 0.08,
  decay: 0.18,
  sustain: 0.45,
  release: 0.35,
  attackShape: -0.4,
  decayShape: -0.4,
  releaseShape: -0.6,
};

export const DEFAULT_TIMBRE: TimbreParams = {
  waveform: 'sine',
  frequency: 440,
  envelope: { ...DEFAULT_ENVELOPE },
  masterGain: 0.8,
};

/** 参数合法性钳制：时长非负、电平与形状在范围内。 */
export function clampEnvelope(p: EnvelopeParams): EnvelopeParams {
  const nonNeg = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0);
  const range01 = (x: number) => Math.min(1, Math.max(0, x));
  const rangeShape = (x: number) => Math.min(1, Math.max(-1, x));
  return {
    attack: nonNeg(p.attack),
    decay: nonNeg(p.decay),
    sustain: range01(p.sustain),
    release: nonNeg(p.release),
    attackShape: rangeShape(p.attackShape),
    decayShape: rangeShape(p.decayShape),
    releaseShape: rangeShape(p.releaseShape),
  };
}

export function clampTimbre(t: TimbreParams): TimbreParams {
  return {
    ...t,
    frequency: Math.min(8000, Math.max(20, t.frequency || 440)),
    masterGain: Math.min(1, Math.max(0, t.masterGain)),
    envelope: clampEnvelope(t.envelope),
  };
}
