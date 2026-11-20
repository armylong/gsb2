/**
 * 采样管线：把「UV 旋转 → 纹理采样 → 编码约定 → 手性处理 → 光照」串起来。
 * 页面 shader 与验证脚本共用同一条管线的参数定义，保证对照一致。
 */
import {
  rotateUV,
  worldNormalFromTS,
  diffuse,
  type TangentFrame,
  type Vec2,
  type Vec3,
} from './tangentSpace';
import { sampleTSNormal, type GreenConvention } from './heightfield';

/** 手性处理模式：correct=全部正确；wrong=全部错误（复现 bug）；split=左错右对（对照） */
export type FixMode = 'correct' | 'wrong' | 'split';

export interface SampleOptions {
  rotationDeg: number;
  convention: GreenConvention;
  fixMode: FixMode;
}

export const DEFAULT_SAMPLE_OPTIONS: SampleOptions = {
  rotationDeg: 0,
  convention: 'opengl',
  fixMode: 'correct',
};

/** 某区域在该模式下是否使用手性修正 */
export function useHandednessFor(mode: FixMode, region: 0 | 1): boolean {
  if (mode === 'correct') return true;
  if (mode === 'wrong') return false;
  return region === 1; // split：左区错误、右区正确
}

export interface ShadingSample {
  uv: Vec2;
  rotatedUV: Vec2;
  tsNormal: Vec3;
  worldNormal: Vec3;
  handedness: 1 | -1;
  usedHandedness: boolean;
}

/** 在给定框架处走一遍完整采样管线（不含光照） */
export function samplePipeline(frame: TangentFrame, uv: Vec2, region: 0 | 1, opts: SampleOptions): ShadingSample {
  const ruv = rotateUV(uv, opts.rotationDeg);
  const ts = sampleTSNormal(ruv[0], ruv[1], opts.convention);
  const useW = useHandednessFor(opts.fixMode, region);
  const worldN = worldNormalFromTS(ts, frame, useW);
  return {
    uv,
    rotatedUV: ruv,
    tsNormal: ts,
    worldNormal: worldN,
    handedness: frame.w,
    usedHandedness: useW,
  };
}

/** 完整管线 + 漫反射光照 */
export function sampleDiffuse(
  frame: TangentFrame,
  uv: Vec2,
  region: 0 | 1,
  opts: SampleOptions,
  lightDir: Vec3,
): number {
  return diffuse(samplePipeline(frame, uv, region, opts).worldNormal, lightDir);
}
