import { CurvePoint, FmPatch } from './types';
import { normalizeCurve } from './curve';

export function defaultCurve(): CurvePoint[] {
  return [
    { t: 0, v: 1 },
    { t: 0.25, v: 0.55 },
    { t: 0.6, v: 0.18 },
    { t: 1, v: 0 },
  ];
}

export function defaultPatch(): FmPatch {
  return {
    carrierMode: 'track',
    fixedCarrierHz: 220,
    modRatio: 2.76,
    modDepth: 3.2,
    depthCurve: defaultCurve(),
    modelTime: 1.2,
    decayTime: 2.4,
    attackTime: 0.005,
    outputGain: 0.5,
  };
}

/** 校验并规范化外部(预设/反序列化)进来的 patch */
export function normalizePatch(p: FmPatch): FmPatch {
  return {
    carrierMode: p.carrierMode === 'fixed' ? 'fixed' : 'track',
    fixedCarrierHz: clamp(p.fixedCarrierHz, 20, 12000),
    modRatio: clamp(p.modRatio, 0, 16),
    modDepth: clamp(p.modDepth, 0, 16),
    depthCurve: normalizeCurve(p.depthCurve ?? defaultCurve()),
    modelTime: clamp(p.modelTime, 0.05, 10),
    decayTime: clamp(p.decayTime, 0.05, 20),
    attackTime: clamp(p.attackTime, 0.001, 0.5),
    outputGain: clamp(p.outputGain, 0, 1),
  };
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}
