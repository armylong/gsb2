import { FmPatch } from './types';

export interface Preset {
  id: string;
  label: string;
  description: string;
  patch: FmPatch;
}

/** 近纯音: 调制指数极小, J0 占绝对主导, 频谱几乎只剩载波 */
export const PURE_TONE: Preset = {
  id: 'pure',
  label: '近纯音',
  description: 'I=0.15, 侧带电平普遍低于 -30dB, 听起来接近一根纯正弦音叉',
  patch: {
    carrierMode: 'track',
    fixedCarrierHz: 220,
    modRatio: 2.01,
    modDepth: 0.15,
    depthCurve: [
      { t: 0, v: 1 },
      { t: 0.4, v: 0.6 },
      { t: 1, v: 0 },
    ],
    modelTime: 1.4,
    decayTime: 2.6,
    attackTime: 0.004,
    outputGain: 0.55,
  },
};

/** 强侧带电铃: 非整数比 2.76 产生不和谐金属泛音, I=4 侧带丰富 */
export const BRIGHT_BELL: Preset = {
  id: 'bell',
  label: '强侧带电铃',
  description: 'I=4, 调制比 2.76(非谐波), 多阶侧带形成金属铃质感',
  patch: {
    carrierMode: 'track',
    fixedCarrierHz: 220,
    modRatio: 2.76,
    modDepth: 4,
    depthCurve: [
      { t: 0, v: 1 },
      { t: 0.2, v: 0.7 },
      { t: 0.55, v: 0.3 },
      { t: 1, v: 0 },
    ],
    modelTime: 1.0,
    decayTime: 2.8,
    attackTime: 0.005,
    outputGain: 0.5,
  },
};

export const PRESETS: Preset[] = [PURE_TONE, BRIGHT_BELL];
