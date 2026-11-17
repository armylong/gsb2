/**
 * 程序化顶点着色:全部颜色由高度与坡度算出,不使用任何外部贴图。
 * LOD 色调叠加由材质端完成,这里只产出基础地貌色。
 */
import { HEIGHT_RANGE_MAX, HEIGHT_RANGE_MIN, LOD_COUNT } from './config';

export interface TerrainColor {
  r: number;
  g: number;
  b: number;
}

function mix(a: TerrainColor, b: TerrainColor, t: number): TerrainColor {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const DEEP: TerrainColor = { r: 0.16, g: 0.24, b: 0.34 }; // 低洼深蓝灰
const VALLEY: TerrainColor = { r: 0.27, g: 0.4, b: 0.24 }; // 谷底植被
const SLOPE: TerrainColor = { r: 0.42, g: 0.45, b: 0.28 }; // 缓坡草黄
const ROCK: TerrainColor = { r: 0.46, g: 0.4, b: 0.36 }; // 高处岩壁
const SNOW: TerrainColor = { r: 0.9, g: 0.91, b: 0.94 }; // 山顶积雪

/**
 * @param height 世界高度
 * @param slope  坡度(高度梯度模长,0 表示平坦)
 */
export function terrainColor(height: number, slope: number): TerrainColor {
  const t = clamp01((height - HEIGHT_RANGE_MIN) / (HEIGHT_RANGE_MAX - HEIGHT_RANGE_MIN));

  let base: TerrainColor;
  if (t < 0.3) {
    base = mix(DEEP, VALLEY, t / 0.3);
  } else if (t < 0.55) {
    base = mix(VALLEY, SLOPE, (t - 0.3) / 0.25);
  } else if (t < 0.8) {
    base = mix(SLOPE, ROCK, (t - 0.55) / 0.25);
  } else {
    base = mix(ROCK, SNOW, (t - 0.8) / 0.2);
  }

  // 陡坡偏向岩石色
  const rockBlend = clamp01(slope * 0.9);
  base = mix(base, ROCK, rockBlend * 0.7);
  return base;
}

/**
 * 每个 LOD 一个可区分的色调(色相偏移),与地貌色相乘后叠加,
 * 使画面可以直观看出每块当前层级。
 */
export const LOD_TINTS: readonly TerrainColor[] = [
  { r: 1.0, g: 1.0, b: 1.0 },
  { r: 0.92, g: 0.98, b: 1.06 },
  { r: 1.08, g: 0.96, b: 0.9 },
];

export function lodTint(lod: number): TerrainColor {
  return LOD_TINTS[lod] ?? LOD_TINTS[LOD_COUNT - 1];
}
