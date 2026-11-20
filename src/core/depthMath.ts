/**
 * 深度精度模型 —— 纯函数，无 three.js 依赖，便于在 Node 中做单元测试。
 *
 * 约定：zView 是相机到片元的正距离（>0）。near/far 同理。
 *
 * 直接深度（OpenGL 默认，NDC z ∈ [-1, 1]）：
 *     d = far * (z - near) / ((far - near) * z)          near → 0，far → 1
 *
 * 反向深度（EXT_clip_control ZERO_TO_ONE，three.js reversedDepthBuffer）：
 *     d = near * (far / z - 1) / (far - near)            near → 1，far → 0
 *
 * 两者 |dd/dz| 相同，因此“定点存储”（每个码点等间距）下精度完全一致；
 * 反向深度只有配合浮点深度存储（z 越远，d 越小，浮点 ulp 越小）才能拉开差距。
 */

export type DepthMode = 'direct' | 'reversed';

/** 深度存储模型：仅用于画理论参考曲线，不用于替代实测。 */
export type StorageModel = 'fixed16' | 'fixed24' | 'f32';

/** 定点深度的最大码值（UNORM16 / UNORM24）。 */
export const FIXED_MAX: Record<'fixed16' | 'fixed24', number> = {
  fixed16: 0xffff,
  fixed24: 0xffffff,
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 视角距离 → 归一化深度。zView 需位于 (near, far) 内才有意义。 */
export function depthFromViewZ(zView: number, near: number, far: number, mode: DepthMode): number {
  if (mode === 'direct') {
    return (far * (zView - near)) / ((far - near) * zView);
  }
  return (near * (far / zView - 1)) / (far - near);
}

/**
 * 归一化深度 → 视角距离。d 对应 GPU 深度纹理里的值。
 * 反函数在同模式下严格成立（推导见 three.js 的 packing.glsl.js）。
 */
export function viewZFromDepth(d: number, near: number, far: number, mode: DepthMode): number {
  if (mode === 'direct') {
    return (near * far) / (far - d * (far - near));
  }
  return (near * far) / (d * (far - near) + near);
}

/** 按给定存储模型量化一个归一化深度值。 */
export function quantizeDepth(d: number, model: StorageModel): number {
  const c = clamp(d, 0, 1);
  if (model === 'f32') return Math.fround(c);
  const max = FIXED_MAX[model];
  return Math.round(c * max) / max;
}

/** 该存储模型在深度值 d 处的相邻码点间距（浮点取局部 ulp）。 */
export function depthQuantum(d: number, model: StorageModel): number {
  if (model !== 'f32') return 1 / FIXED_MAX[model];
  const a = Math.abs(d);
  if (a === 0) return Number.MIN_VALUE;
  const exp = Math.floor(Math.log2(a));
  // 正规数；d ∈ [0,1] 不会落入次正规区（除 0 本身）。
  return Math.pow(2, exp - 23);
}

/** 在距离 z 处，一个深度码点对应多少世界距离。越大 = 越粗糙。 */
export function depthStepWorld(
  zView: number,
  near: number,
  far: number,
  mode: DepthMode,
  model: StorageModel,
): number {
  const d = depthFromViewZ(zView, near, far, mode);
  // |dd/dz| = far * near / ((far - near) * z^2)，正反向同值
  const derivative = (far * near) / ((far - near) * zView * zView);
  return depthQuantum(d, model) / derivative;
}

/** 均匀对数采样，首尾精确等于入参；用于固定相机扫过距离。 */
export function geometricSchedule(start: number, end: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  if (n === 1) return [start];
  const lo = Math.log(start);
  const hi = Math.log(end);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    out[i] = i === 0 ? start : i === n - 1 ? end : Math.exp(lo + ((hi - lo) * i) / (n - 1));
  }
  return out;
}

/**
 * 理论“深度码点开始重合”的距离：相对间距 gapRatio（= 世界间距 / z），
 * 求 depthStepWorld(z) ≥ gapRatio * z 的最小 z。
 * 返回 null 表示到 far 之前都不会重合。
 */
export function predictedOnset(
  gapRatio: number,
  near: number,
  far: number,
  mode: DepthMode,
  model: StorageModel,
): number | null {
  if (!(gapRatio > 0) || !(near > 0) || !(far > near)) return null;
  const lo = Math.max(near * 1.001, 1e-6);
  const hi = far * 0.98;
  if (!(hi > lo)) return null;

  const f = (z: number) => depthStepWorld(z, near, far, mode, model) - gapRatio * z;

  const samples = 256;
  let prevZ = lo;
  let prevF = f(lo);
  if (prevF >= 0) return lo;
  for (let i = 1; i <= samples; i++) {
    const z = Math.exp(Math.log(lo) + ((Math.log(hi) - Math.log(lo)) * i) / samples);
    const cur = f(z);
    if (cur >= 0) {
      // 在 [prevZ, z] 内二分
      let a = prevZ;
      let b = z;
      for (let k = 0; k < 64; k++) {
        const mid = Math.sqrt(a * b);
        if (f(mid) >= 0) b = mid;
        else a = mid;
      }
      return b;
    }
    prevZ = z;
    prevF = cur;
  }
  void prevF;
  return null;
}

export interface RatioSample {
  z: number;
  ratio: number;
}

/**
 * 争抢起点：连续 sustain 个采样点的争抢比例都 ≥ threshold 的第一段起点。
 * 不足 sustain 个尾部样本不参与判定（保证窗口完整，结果可重复）。
 */
export function detectOnset(
  samples: readonly RatioSample[],
  threshold: number,
  sustain: number,
): number | null {
  const k = Math.max(1, Math.floor(sustain));
  for (let i = 0; i + k <= samples.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!(samples[i + j].ratio >= threshold)) {
        ok = false;
        break;
      }
    }
    if (ok) return samples[i].z;
  }
  return null;
}

/** 相对间距转世界间距（扫描/场景统一使用）。 */
export function worldGap(gapRatio: number, z: number): number {
  return gapRatio * z;
}
