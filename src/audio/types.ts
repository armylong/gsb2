export type CarrierMode = 'track' | 'fixed';

/**
 * 完整音色参数。
 * - track 模式: 载波频率 = 所按音高; fixed 模式: 载波频率 = fixedCarrierHz, 与按键无关。
 * - 调制器频率恒为 carrierFreq * modRatio。
 * - modDepth 是峰值调制指数 I(t) 的整体幅度, 实际指数 = modDepth * curve(t / modelTime)。
 */
export interface FmPatch {
  carrierMode: CarrierMode;
  fixedCarrierHz: number;
  modRatio: number;
  modDepth: number;
  /** 分段曲线断点, t 为归一化时间 0..1, v 为 0..1 的指数比例 */
  depthCurve: CurvePoint[];
  /** 模型时间(秒): 曲线全部展开所需时间, 也是衰减包络的参考时长 */
  modelTime: number;
  /** 振幅衰减到 -60dB 所需时间(秒), 相对起音点 */
  decayTime: number;
  /** 起音时长(秒) */
  attackTime: number;
  /** 输出增益 */
  outputGain: number;
}

export interface CurvePoint {
  t: number;
  v: number;
}

export function clonePatch(p: FmPatch): FmPatch {
  return { ...p, depthCurve: p.depthCurve.map((pt) => ({ ...pt })) };
}
