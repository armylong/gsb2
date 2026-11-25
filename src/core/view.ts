/**
 * 由 ProjectorState 构造融合引擎使用的 ProjectorView,
 * 把「输出图 uv -> 主测试图坐标」的裁剪映射接进采样链。
 */
import { homographyUnitSquareToQuad, invert3x3 } from './geometry.ts';
import {
  bitmapSampler,
  patternSampler,
  type ProjectorView,
  type SourceSampler,
} from './blend.ts';
import { samplePatternBilinear, PATTERN_W, PATTERN_H } from './pattern.ts';
import type { ProjectorState } from './types.ts';

/** 实时图案采样器: 输出 uv 先映射到裁剪段, 再采样主测试图 */
export function liveSampler(st: ProjectorState): SourceSampler {
  const base = patternSampler(samplePatternBilinear, PATTERN_W, PATTERN_H);
  return (u, v) =>
    base(
      st.patternU0 + u * (st.patternU1 - st.patternU0),
      st.patternV0 + v * (st.patternV1 - st.patternV0),
    );
}

export function buildView(
  st: ProjectorState,
  sampler?: SourceSampler,
): ProjectorView & { forwardH: number[] } {
  const forwardH = homographyUnitSquareToQuad(st.quad);
  const invH = invert3x3(forwardH);
  return {
    quad: st.quad,
    brightness: st.brightness,
    invH,
    forwardH,
    sample: sampler ?? liveSampler(st),
    cropU0: st.patternU0,
    cropU1: st.patternU1,
    cropV0: st.patternV0,
    cropV1: st.patternV1,
  };
}

/**
 * 用导入的 PNG 位图作为采样源(导入核对模式)。
 * 位图只烘焙了几何权重, 亮度仍由定位设置中的 brightness 重新应用,
 * 从而能复现两台增益不同(如 0.95/1.05)的合成结果。
 */
export function buildBitmapView(
  st: ProjectorState,
  bitmap: Uint8ClampedArray,
  w: number,
  h: number,
): ProjectorView & { forwardH: number[] } {
  const view = buildView(st, bitmapSampler(bitmap, w, h));
  view.preBaked = true;
  // 保留 st.brightness: 合成时对位图颜色再乘一次亮度
  return view;
}
