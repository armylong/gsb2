/**
 * 统一高度场:所有网格顶点高度与点选/坐标查询都来自这里,
 * 因此同一世界坐标的高度不随渲染层级改变。
 */
import { fbm2, ridgedFbm2 } from './noise';
import { WORLD_MAX, WORLD_MIN } from './config';

/**
 * 高度合成:
 * - 低频 fbm 形成整体起伏与低洼盆地
 * - ridged fbm 形成尖锐山脊
 * - 中等频率 fbm 形成缓坡细节
 */
export function sampleHeight(x: number, z: number, seed: number): number {
  const continent = fbm2(x * 0.006 + 11.3, z * 0.006 - 4.7, seed, 4);
  const ridge = ridgedFbm2(x * 0.012 - 30.1, z * 0.012 + 8.4, seed + 77, 4);
  const rolling = fbm2(x * 0.03 + 50, z * 0.03 - 20, seed + 191, 3);

  // 沿对角线加一条主山脊,使地形有明显走向
  const diag = Math.abs(Math.sin((x + z) * 0.012 + fbm2(x * 0.004, z * 0.004, seed + 5, 2) * 2.4));
  const spine = Math.pow(1 - diag, 3);

  let h = (continent - 0.45) * 34; // 大尺度高低差,制造低洼区域
  h += ridge * 16;
  h += spine * 14;
  h += (rolling - 0.5) * 6;
  return h;
}

export function isInsideTerrain(x: number, z: number): boolean {
  return x >= WORLD_MIN && x <= WORLD_MAX && z >= WORLD_MIN && z <= WORLD_MAX;
}

export interface HeightQueryResult {
  inside: boolean;
  x: number;
  z: number;
  /** inside 为 false 时为 null,避免把地形外误报为 0 或边界高度 */
  height: number | null;
}

export function queryHeight(x: number, z: number, seed: number): HeightQueryResult {
  if (!isInsideTerrain(x, z)) {
    return { inside: false, x, z, height: null };
  }
  return { inside: true, x, z, height: sampleHeight(x, z, seed) };
}
