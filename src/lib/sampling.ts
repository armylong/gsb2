import { RNG, hashSeed } from './rng';
import type { PointCloud } from './scenes';

/**
 * 分层 (stratified) 抽样: 把包围盒按固定网格划分, 每格内按比例独立抽点。
 * - 同一比例下抽样结果确定 (种子 = 场景种子 + 比例档位)
 * - 改变比例时网格划分不变, 仅改变每格保留概率, 空间分布形态保持可对比
 * - 抽样对密集/稀疏各类别一视同仁, 不按标签分层
 */
export function stratifiedSample(
  cloud: PointCloud,
  ratio: number,
  seed: number,
  grid = 12,
): Uint32Array {
  const r = Math.min(1, Math.max(0.01, ratio));
  const rng = new RNG(hashSeed(`${seed}:${grid}`));
  const { min, max } = cloud.bounds;
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const cellOf = (i: number): number => {
    const ix = clampGrid((cloud.positions[i * 3] - min[0]) / (size[0] || 1), grid);
    const iy = clampGrid((cloud.positions[i * 3 + 1] - min[1]) / (size[1] || 1), grid);
    const iz = clampGrid((cloud.positions[i * 3 + 2] - min[2]) / (size[2] || 1), grid);
    return (ix * grid + iy) * grid + iz;
  };

  const buckets: number[][] = Array.from({ length: grid ** 3 }, () => []);
  for (let i = 0; i < cloud.count; i++) buckets[cellOf(i)].push(i);

  const picked: number[] = [];
  for (const bucket of buckets) {
    // 格内洗牌 (Fisher-Yates, 用确定性 RNG) 后取前 ceil(n*r) 个,
    // 保证每格至少按比例贡献点, 稀疏格不会整体消失
    for (let k = bucket.length - 1; k > 0; k--) {
      const j = rng.int(k + 1);
      [bucket[k], bucket[j]] = [bucket[j], bucket[k]];
    }
    const keep = Math.max(r >= 1 ? bucket.length : 0, Math.ceil(bucket.length * r));
    for (let k = 0; k < keep; k++) picked.push(bucket[k]);
  }
  picked.sort((a, b) => a - b);
  return Uint32Array.from(picked);
}

function clampGrid(t: number, grid: number): number {
  return Math.min(grid - 1, Math.max(0, Math.floor(t * grid)));
}

/** 抽样下标转回精简点云 (labels 同步保留) */
export function subCloud(cloud: PointCloud, indices: Uint32Array): PointCloud {
  const positions = new Float32Array(indices.length * 3);
  const labels = new Uint8Array(indices.length);
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    positions[k * 3] = cloud.positions[i * 3];
    positions[k * 3 + 1] = cloud.positions[i * 3 + 1];
    positions[k * 3 + 2] = cloud.positions[i * 3 + 2];
    labels[k] = cloud.labels[i];
  }
  return { ...cloud, positions, labels, count: indices.length };
}
