/**
 * 材质分层规则引擎（纯函数，渲染端 / 验证脚本 / GLSL 三处共用同一套语义）。
 *
 * 每层规则 = 高度区间 × 坡度区间的"覆盖度"（0..1），区间边缘用 feather 宽度平滑过渡。
 * 单点求值流程：
 *   1. raw_i      = 高度带系数 × 坡度带系数            （该层在此点的覆盖率）
 *   2. effective_i = raw_i × priority_i                 （优先级作为乘性权重）
 *   3. 若 Σeffective < EPS → 无任何规则覆盖，显式回退层权重 = 1
 *      否则 normalized_i = effective_i / Σeffective     （回退层 = 0）
 *   4. winner = effective 最大的层（即"哪层在起作用"）
 *
 * 注意：优先级不改变覆盖范围，只改变重叠区内的分配比例。
 * 重叠区内 normalized 比值 = (raw_i·pri_i) : (raw_j·pri_j)。
 */

export interface LayerRule {
  name: string;
  /** 高度区间 [min, max]（米），feather 为区间外过渡宽度 */
  heightMin: number;
  heightMax: number;
  heightFeather: number;
  /** 坡度区间 [min, max]（度），feather 为区间外过渡宽度（度） */
  slopeMin: number;
  slopeMax: number;
  slopeFeather: number;
  /** 优先级：重叠时的乘性权重，越大分得的归一化权重越多 */
  priority: number;
  /** 纹理平铺缩放（世界米 / 次），各层独立 */
  textureScale: number;
}

export const GRASS = 0;
export const ROCK = 1;
export const SNOW = 2;
export const LAYER_COUNT = 3;
/** 归一化权重数组中回退层的下标 */
export const FALLBACK = 3;

export const LAYER_NAMES = ['草地', '岩石', '雪'] as const;
export const FALLBACK_NAME = '回退(无覆盖)';

export const DEFAULT_RULES: LayerRule[] = [
  {
    name: LAYER_NAMES[GRASS],
    heightMin: -200, heightMax: 20, heightFeather: 6,
    slopeMin: 0, slopeMax: 28, slopeFeather: 8,
    priority: 1, textureScale: 9,
  },
  {
    name: LAYER_NAMES[ROCK],
    heightMin: -200, heightMax: 400, heightFeather: 1,
    slopeMin: 26, slopeMax: 90, slopeFeather: 8,
    priority: 2, textureScale: 6,
  },
  {
    name: LAYER_NAMES[SNOW],
    heightMin: 20, heightMax: 400, heightFeather: 6,
    slopeMin: 0, slopeMax: 50, slopeFeather: 10,
    priority: 3, textureScale: 4,
  },
];

export function cloneDefaults(): LayerRule[] {
  return DEFAULT_RULES.map((r) => ({ ...r }));
}

/** 经典 smoothstep(0..1)，GLSL 端用同名内置函数保持一致 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 带状覆盖系数：v ∈ [min, max] 时为 1，
 * 向两侧各以 feather 宽度平滑衰减到 0。
 * 与 shader 中的 band() 逐项对应。
 */
export function bandFactor(v: number, min: number, max: number, feather: number): number {
  const f = Math.max(feather, 1e-6);
  const lo = smoothstep(min - f, min, v);
  const hi = 1 - smoothstep(max, max + f, v);
  return lo * hi;
}

export const COVERAGE_EPS = 1e-4;

export interface EvalResult {
  /** 各层覆盖率（未乘优先级），长度 3 */
  raw: number[];
  /** raw × priority，长度 3 */
  effective: number[];
  /** 归一化权重，长度 4，最后一个为回退层；总和恒为 1 */
  normalized: number[];
  /** 是否无任何规则覆盖（回退层生效） */
  fallbackActive: boolean;
  /** 胜出的层下标（0..2），回退时为 FALLBACK */
  winner: number;
}

export function evaluateRules(height: number, slopeDeg: number, rules: LayerRule[]): EvalResult {
  const raw = rules.map(
    (r) =>
      bandFactor(height, r.heightMin, r.heightMax, r.heightFeather) *
      bandFactor(slopeDeg, r.slopeMin, r.slopeMax, r.slopeFeather),
  );
  const effective = raw.map((w, i) => w * Math.max(rules[i].priority, 1e-4));
  const sum = effective.reduce((a, b) => a + b, 0);

  if (sum < COVERAGE_EPS) {
    return { raw, effective, normalized: [0, 0, 0, 1], fallbackActive: true, winner: FALLBACK };
  }

  const normalized = effective.map((w) => w / sum);
  normalized.push(0);
  let winner = 0;
  for (let i = 1; i < effective.length; i++) {
    if (effective[i] > effective[winner]) winner = i;
  }
  return { raw, effective, normalized, fallbackActive: false, winner };
}
