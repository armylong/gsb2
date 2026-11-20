/**
 * 三骨骼带状网格的权重预设。
 *
 * 网格沿 +X 方向,总长 length,三节骨骼等分,关节位于 x = length/3 与 2*length/3。
 * 用 smoothstep 在关节附近做混合过渡:
 *   - 肘部(elbow):过渡带窄,弯出清晰的折角;
 *   - 尾部(tail):过渡带宽,末端呈柔软的有机摆动;
 *   - 默认(default):居中的常规过渡。
 */

import { BONE_COUNT } from './WeightModel';

export interface WeightPreset {
  id: string;
  label: string;
  /** 关节两侧过渡带的半宽,越大越柔和 */
  blendWidth: number;
}

export const PRESETS: Record<'default' | 'elbow' | 'tail', WeightPreset> = {
  default: { id: 'default', label: '默认(中等过渡)', blendWidth: 1.0 },
  elbow: { id: 'elbow', label: '肘部(尖锐折角)', blendWidth: 0.35 },
  tail: { id: 'tail', label: '尾部(柔和摆动)', blendWidth: 2.0 },
};

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 返回归一化的三骨骼权重。
 * @param x       顶点沿带方向的坐标 [0, length]
 * @param length  带总长
 * @param width   关节过渡带半宽
 */
export function blendWeights(x: number, length: number, width: number): number[] {
  const j1 = length / 3;
  const j2 = (2 * length) / 3;

  // t1: 在关节1处从骨骼0过渡到骨骼1+2;t2: 在关节2处从骨骼0+1过渡到骨骼2
  const t1 = smoothstep(j1 - width, j1 + width, x);
  const t2 = smoothstep(j2 - width, j2 + width, x);

  const w0 = 1 - t1;
  const w1 = t1 * (1 - t2);
  const w2 = t1 * t2;

  const sum = w0 + w1 + w2;
  return [w0 / sum, w1 / sum, w2 / sum];
}

/** 生成整根带的初始权重扁平数组(顶点顺序需与 ribbon 几何一致) */
export function buildInitialWeights(
  xs: ArrayLike<number>,
  length: number,
  width: number = PRESETS.default.blendWidth,
): Float32Array {
  const out = new Float32Array(xs.length * BONE_COUNT);
  for (let v = 0; v < xs.length; v++) {
    const w = blendWeights(xs[v], length, width);
    for (let b = 0; b < BONE_COUNT; b++) out[v * BONE_COUNT + b] = w[b];
  }
  return out;
}
