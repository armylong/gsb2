/**
 * LOD 选择:按相机到块中心的水平距离在三个层级间切换,
 * 带迟滞(hysteresis)带宽,阈值附近缓慢移动时不反复跳动。
 */
import { LOD_COUNT, WORLD_MIN } from './config';

export interface LodRanges {
  /** 小于该距离:LOD0(最细) */
  near: number;
  /** 大于该距离:LOD2(最粗),中间为 LOD1 */
  far: number;
  /** 迟滞带宽:距离需要越过边界 +hysteresis 才会降档,回落需越过 -hysteresis 才升档 */
  hysteresis: number;
}

/**
 * @param current 当前层级,null 表示首次决策(无迟滞)
 * @param distance 相机到块中心的水平距离
 */
export function selectLod(distance: number, ranges: LodRanges, current: number | null): number {
  const base = distance < ranges.near ? 0 : distance > ranges.far ? 2 : 1;
  if (current === null || current < 0 || current >= LOD_COUNT) return base;
  if (base === current) return current;

  const h = ranges.hysteresis;
  if (base > current) {
    // 降档(变粗):要严格越过边界 +hysteresis 才触发
    const threshold = current === 0 ? ranges.near + h : ranges.far + h;
    return distance > threshold ? base : current;
  }
  // 升档(变细):要严格低于边界 -hysteresis 才触发
  const threshold = current === 2 ? ranges.far - h : ranges.near - h;
  return distance < threshold ? base : current;
}

export function chunkCenterDistance(
  cx: number,
  cz: number,
  chunkSize: number,
  cameraX: number,
  cameraZ: number,
): number {
  const ccx = WORLD_MIN + (cx + 0.5) * chunkSize;
  const ccz = WORLD_MIN + (cz + 0.5) * chunkSize;
  return Math.hypot(cameraX - ccx, cameraZ - ccz);
}
