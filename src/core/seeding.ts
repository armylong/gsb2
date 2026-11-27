// 自动起点：抖动网格（jittered grid）在场景内均匀撒点，
// 跳过静止区与零速点。密度分三档，可用随机种子重复生成。
import { VelocityField, Vec2, Seed } from './types.js';
import { isSeedBlocked } from './integrator.js';

export type Density = 'sparse' | 'normal' | 'dense';

export const DENSITY_SPACING: Record<Density, number> = {
  sparse: 150,
  normal: 100,
  dense: 68
};

export const DENSITY_LABEL: Record<Density, string> = {
  sparse: '稀疏（弱密度）',
  normal: '标准',
  dense: '较密'
};

/** 可重复的伪随机数发生器（mulberry32），同一 rngSeed 得到同一批起点 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成自动起点。
 * @param spacing 网格间距（场景单位）
 * @param rngSeed 随机种子，重复使用可复现同一视图
 */
export function autoSeeds(field: VelocityField, spacing: number, rngSeed: number): Seed[] {
  const rng = mulberry32(rngSeed);
  const d = field.domain;
  const seeds: Seed[] = [];
  let id = 1;
  const jitter = spacing * 0.35;

  for (let x = d.xmin + spacing / 2; x <= d.xmax - spacing / 2; x += spacing) {
    for (let y = d.ymin + spacing / 2; y <= d.ymax - spacing / 2; y += spacing) {
      const p: Vec2 = {
        x: x + (rng() - 0.5) * 2 * jitter,
        y: y + (rng() - 0.5) * 2 * jitter
      };
      if (isSeedBlocked(field, p)) continue;
      seeds.push({ id: id++, p, manual: false, locked: false });
    }
  }
  return seeds;
}

/** 重新分布：保留手动 / 锁定起点，其余用新的随机种子重新撒点 */
export function redistribute(
  field: VelocityField,
  existing: Seed[],
  density: Density,
  rngSeed: number
): Seed[] {
  const kept = existing.filter((s) => s.manual || s.locked);
  const fresh = autoSeeds(field, DENSITY_SPACING[density], rngSeed);
  // 自动点避开与保留点过近的位置
  const keptPts = kept.map((s) => s.p);
  const minGap = DENSITY_SPACING[density] * 0.45;
  const filtered = fresh.filter(
    (s) => !keptPts.some((kp) => Math.hypot(kp.x - s.p.x, kp.y - s.p.y) < minGap)
  );
  const maxId = existing.reduce((m, s) => Math.max(m, s.id), 0);
  filtered.forEach((s, i) => (s.id = maxId + 1 + i));
  return [...kept, ...filtered];
}
