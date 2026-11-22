import type { PointCloud } from './scenes';

/**
 * 均匀网格空间哈希: 只对"参与统计"的点建索引。
 * 邻域查询为球形范围, 网格边长取邻域半径, 最坏情况检查 27 个格子。
 */
export class SpatialHash {
  readonly cellSize: number;
  private cells = new Map<number, number[]>();
  /** 参与索引的原始点下标 (即剖切后保留的点) */
  readonly active: Uint32Array;

  constructor(positions: Float32Array, active: Uint32Array, radius: number) {
    this.cellSize = Math.max(radius, 1e-6);
    this.active = active;
    for (let k = 0; k < active.length; k++) {
      const i = active[k];
      const key = this.key(
        Math.floor(positions[i * 3] / this.cellSize),
        Math.floor(positions[i * 3 + 1] / this.cellSize),
        Math.floor(positions[i * 3 + 2] / this.cellSize),
      );
      let bucket = this.cells.get(key);
      if (!bucket) {
        bucket = [];
        this.cells.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  private key(cx: number, cy: number, cz: number): number {
    // 每轴 1024 格够用 (场景尺度 ~6, 半径 >=0.05 => <=120 格), 冲突时退化为同桶仍正确
    return ((cx + 512) * 1024 + (cy + 512)) * 1024 + (cz + 512);
  }

  /** 返回半径 r 球内所有点的原始下标 (含中心点自身) */
  query(positions: Float32Array, px: number, py: number, pz: number, r: number): number[] {
    const out: number[] = [];
    const r2 = r * r;
    const x0 = Math.floor((px - r) / this.cellSize);
    const x1 = Math.floor((px + r) / this.cellSize);
    const y0 = Math.floor((py - r) / this.cellSize);
    const y1 = Math.floor((py + r) / this.cellSize);
    const z0 = Math.floor((pz - r) / this.cellSize);
    const z1 = Math.floor((pz + r) / this.cellSize);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cz = z0; cz <= z1; cz++) {
          const bucket = this.cells.get(this.key(cx, cy, cz));
          if (!bucket) continue;
          for (const i of bucket) {
            const dx = positions[i * 3] - px;
            const dy = positions[i * 3 + 1] - py;
            const dz = positions[i * 3 + 2] - pz;
            if (dx * dx + dy * dy + dz * dz <= r2) out.push(i);
          }
        }
      }
    }
    return out;
  }
}

export interface DensityStats {
  /** 每个活跃点的邻域点数 (含自身) */
  counts: Int32Array;
  /** 每个活跃点的局部密度, 单位 点/单位体积 (points per unit volume, ppv) */
  densities: Float32Array;
  /** 活跃点在原始点云中的下标 */
  active: Uint32Array;
  radius: number;
  /** 球形邻域体积 4/3 π r³, 界面据此解释密度单位 */
  sphereVolume: number;
}

/**
 * 计算所有活跃点的球形邻域计数与局部密度。
 * 密度定义: rho_i = k_i / (4/3 π r³), k 含中心点自身。
 */
export function computeDensity(cloud: PointCloud, active: Uint32Array, radius: number): DensityStats {
  const hash = new SpatialHash(cloud.positions, active, radius);
  const n = active.length;
  const counts = new Int32Array(n);
  const densities = new Float32Array(n);
  const vol = (4 / 3) * Math.PI * radius ** 3;
  const pos = cloud.positions;
  for (let k = 0; k < n; k++) {
    const i = active[k];
    const neighbors = hash.query(pos, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], radius);
    counts[k] = neighbors.length;
    densities[k] = neighbors.length / vol;
  }
  return { counts, densities, active, radius, sphereVolume: vol };
}

export interface ClippingOptions {
  enabled: boolean;
  /** 切面轴 0=x 1=y 2=z, 保留 axis 坐标 >= plane 的一侧 */
  axis: 0 | 1 | 2;
  plane: number;
  /** true = 被切掉的点完全不参与密度统计; false = 仅隐藏, 统计仍用全部点 */
  excludeFromStats: boolean;
}

/** 按剖切配置选出参与统计/显示的点下标 */
export function selectActive(cloud: PointCloud, clip: ClippingOptions): Uint32Array {
  if (!clip.enabled) {
    const all = new Uint32Array(cloud.count);
    for (let i = 0; i < cloud.count; i++) all[i] = i;
    return all;
  }
  const pos = cloud.positions;
  const kept: number[] = [];
  for (let i = 0; i < cloud.count; i++) {
    if (pos[i * 3 + clip.axis] >= clip.plane) kept.push(i);
  }
  return Uint32Array.from(kept);
}
