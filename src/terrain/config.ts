/**
 * 全局地形配置:有限规模,不做无限流式加载。
 * 世界坐标范围:[-160, 160],共 8x8 个块,每块边长 40。
 */
export const TERRAIN_SIZE = 320;
export const HALF_TERRAIN = TERRAIN_SIZE / 2;
export const WORLD_MIN = -HALF_TERRAIN;
export const WORLD_MAX = HALF_TERRAIN;

export const CHUNK_COUNT = 8;
export const CHUNK_SIZE = TERRAIN_SIZE / CHUNK_COUNT; // 40

/** 每块最细网格的边分段数(B x B),块边缘始终保持该分辨率以保证跨层级无缝 */
export const BASE_RES = 32;

/** 三个细节层级对应的网格步长倍率:k 越大网格越粗 */
export const LOD_STEPS = [1, 2, 4] as const;
export const LOD_COUNT = LOD_STEPS.length;

/** 默认 LOD 距离阈值(相机到块中心的水平距离)与迟滞带宽 */
export const DEFAULT_NEAR = 70;
export const DEFAULT_FAR = 140;
export const DEFAULT_HYSTERESIS = 12;

/** 高度估计范围,仅用于颜色归一化,不参与几何 */
export const HEIGHT_RANGE_MIN = -26;
export const HEIGHT_RANGE_MAX = 42;

export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}
