import { describe, it, expect } from 'vitest';
import { RNG, hashSeed } from '../src/lib/rng';
import { buildScene, SCENE_INFO, type SceneId } from '../src/lib/scenes';
import { stratifiedSample, subCloud } from '../src/lib/sampling';
import { computeDensity, selectActive, SpatialHash, type ClippingOptions } from '../src/lib/density';
import { validateBoundary, otsuDensityThreshold } from '../src/lib/validation';
import { analyzeProjection } from '../src/lib/projection';

const R = 0.18;
const clip = (overrides: Partial<ClippingOptions> = {}): ClippingOptions => ({
  enabled: false,
  axis: 1,
  plane: 0,
  excludeFromStats: true,
  ...overrides,
});

describe('确定性随机数与场景可复现', () => {
  it('同种子 RNG 序列完全一致', () => {
    const a = new RNG(42);
    const b = new RNG(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
    expect(hashSeed('plane:12')).toBe(hashSeed('plane:12'));
  });

  it.each(['plane', 'shell', 'noise'] as SceneId[])('场景 %s 两次生成逐点相同', (id) => {
    const seed = SCENE_INFO[id].defaultSeed;
    const c1 = buildScene(id, seed);
    const c2 = buildScene(id, seed);
    expect(c1.count).toBe(c2.count);
    expect(Array.from(c1.positions)).toEqual(Array.from(c2.positions));
    expect(Array.from(c1.labels)).toEqual(Array.from(c2.labels));
    expect(c1.labels.some((l) => l === 1)).toBe(true);
    expect(c1.labels.some((l) => l === 0)).toBe(true);
  });
});

describe('分层抽样: 比例变化保持空间分布可对比', () => {
  it('同比例重复抽样结果一致且点数随比例单调', () => {
    const cloud = buildScene('plane', SCENE_INFO.plane.defaultSeed);
    const i50a = stratifiedSample(cloud, 0.5, 99);
    const i50b = stratifiedSample(cloud, 0.5, 99);
    expect(Array.from(i50a)).toEqual(Array.from(i50b));
    const i25 = stratifiedSample(cloud, 0.25, 99);
    const i100 = stratifiedSample(cloud, 1, 99);
    expect(i25.length).toBeLessThan(i50a.length);
    expect(i50a.length).toBeLessThanOrEqual(i100.length);
    expect(i100.length).toBe(cloud.count);
  });

  it('50% 抽样是 100% 的子集, 且每个空间格都有保留点 (形态不塌缩)', () => {
    const cloud = buildScene('shell', SCENE_INFO.shell.defaultSeed);
    const full = new Set(stratifiedSample(cloud, 1, 7));
    const half = stratifiedSample(cloud, 0.5, 7);
    for (const i of half) expect(full.has(i)).toBe(true);
    // 按包围盒 12³ 格统计, 有点的格在抽样后不应整体消失
    const grid = 12;
    const fullCells = new Set<number>();
    const halfCells = new Set<number>();
    const cell = (i: number) => {
      const { min, max } = cloud.bounds;
      const ix = Math.min(grid - 1, Math.max(0, Math.floor(((cloud.positions[i * 3] - min[0]) / (max[0] - min[0])) * grid)));
      const iy = Math.min(grid - 1, Math.max(0, Math.floor(((cloud.positions[i * 3 + 1] - min[1]) / (max[1] - min[1])) * grid)));
      const iz = Math.min(grid - 1, Math.max(0, Math.floor(((cloud.positions[i * 3 + 2] - min[2]) / (max[2] - min[2])) * grid)));
      return ix * grid * grid + iy * grid + iz;
    };
    for (let i = 0; i < cloud.count; i++) fullCells.add(cell(i));
    for (const i of half) halfCells.add(cell(i));
    expect(halfCells.size).toBe(fullCells.size);
  });

  it('抽样不改变真值标签比例结构 (密集/稀疏都被等比保留)', () => {
    const cloud = buildScene('shell', SCENE_INFO.shell.defaultSeed);
    const ratio = (labels: Uint8Array) => labels.filter((l) => l === 1).length / labels.length;
    const before = ratio(cloud.labels);
    const sub = subCloud(cloud, stratifiedSample(cloud, 0.5, 5));
    // 分层格保底机制会让低计数格保留率偏高, 容差取 0.15
    expect(Math.abs(ratio(sub.labels) - before)).toBeLessThan(0.15);
  });
});

describe('球形邻域密度统计', () => {
  it('均匀点云密度量纲正确: ppv ≈ 点数/球体积且计数含自身', () => {
    // 间距 0.1 的规则网格, r=0.12 时面对角 (0.141) 已在球外, 每点恰好 7 个邻居 (自身+轴向6)
    const r = 0.12;
    const n = 8;
    const pts: number[] = [];
    for (let x = 0; x < n; x++)
      for (let y = 0; y < n; y++)
        for (let z = 0; z < n; z++) pts.push(x * 0.1, y * 0.1, z * 0.1);
    const cloud = {
      positions: Float32Array.from(pts),
      labels: new Uint8Array(n ** 3).fill(1),
      count: n ** 3,
      bounds: { min: [0, 0, 0] as [number, number, number], max: [0.7, 0.7, 0.7] as [number, number, number] },
      description: 'grid',
    };
    const active = Uint32Array.from({ length: cloud.count }, (_, i) => i);
    const stats = computeDensity(cloud, active, r);
    const center = 3 * n * n + 3 * n + 3;
    expect(stats.counts[center]).toBe(7);
    const vol = (4 / 3) * Math.PI * r ** 3;
    // 密度以 Float32 存储, 用相对误差 (1e-6) 代替绝对小数位
    expect(Math.abs(stats.densities[center] - 7 / vol) / (7 / vol)).toBeLessThan(1e-6);
    expect(stats.sphereVolume).toBeCloseTo(vol, 8);
  });

  it('密集壳层点的局部密度显著高于稀疏外壳 (干净分离的几何面 vs 稀疏点)', () => {
    const cloud = buildScene('shell', SCENE_INFO.shell.defaultSeed);
    const active = Uint32Array.from({ length: cloud.count }, (_, i) => i);
    const stats = computeDensity(cloud, active, R);
    const dense: number[] = [];
    const sparse: number[] = [];
    for (let i = 0; i < cloud.count; i++) {
      (cloud.labels[i] === 1 ? dense : sparse).push(stats.densities[i]);
    }
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(dense)).toBeGreaterThan(mean(sparse) * 4);
  });

  it('平面场景的投影诱饵密度被几何面"抬高": 证明单靠密度无法识别投影重叠', () => {
    const cloud = buildScene('plane', SCENE_INFO.plane.defaultSeed);
    const active = Uint32Array.from({ length: cloud.count }, (_, i) => i);
    const stats = computeDensity(cloud, active, R);
    const pos = cloud.positions;
    // 诱饵: 稀疏标签但 |z| 很小 (与面同深度)
    const decoyDensity: number[] = [];
    const farNoiseDensity: number[] = [];
    for (let i = 0; i < cloud.count; i++) {
      if (cloud.labels[i] !== 0) continue;
      if (Math.abs(pos[i * 3 + 2]) < 0.05) decoyDensity.push(stats.densities[i]);
      else if (Math.abs(pos[i * 3 + 2]) > 0.8) farNoiseDensity.push(stats.densities[i]);
    }
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(decoyDensity.length).toBeGreaterThan(0);
    expect(farNoiseDensity.length).toBeGreaterThan(0);
    // 同深度诱饵的密度比远离面的噪点高一个量级以上 —— 必须靠旋转/深度/投影分析分辨
    expect(mean(decoyDensity)).toBeGreaterThan(mean(farNoiseDensity) * 8);
  });
});

describe('剖切与统计口径', () => {
  it('排除模式: 被切掉的点不参与邻居计数', () => {
    const cloud = buildScene('plane', SCENE_INFO.plane.defaultSeed);
    const opts = clip({ enabled: true, axis: 2, plane: 0.0, excludeFromStats: true });
    const kept = selectActive(cloud, opts);
    expect(kept.every((i) => cloud.positions[i * 3 + 2] >= 0)).toBe(true);
    const stats = computeDensity(cloud, kept, R);
    // 所有保留点的邻居下标都必须来自保留集合
    const keptSet = new Set(kept);
    const hash = new SpatialHash(cloud.positions, kept, R);
    const i = kept[Math.floor(kept.length / 2)];
    const neighbors = hash.query(
      cloud.positions,
      cloud.positions[i * 3],
      cloud.positions[i * 3 + 1],
      cloud.positions[i * 3 + 2],
      R,
    );
    expect(neighbors.every((j) => keptSet.has(j))).toBe(true);
    expect(stats.active.length).toBe(kept.length);
  });

  it('仅隐藏模式: 切点仍参与统计, 可见点邻域计数 >= 排除模式', () => {
    const cloud = buildScene('plane', SCENE_INFO.plane.defaultSeed);
    const optsExclude = clip({ enabled: true, axis: 2, plane: 0, excludeFromStats: true });
    const optsKeep = clip({ enabled: true, axis: 2, plane: 0, excludeFromStats: false });
    const kept = selectActive(cloud, optsExclude);
    const all = Uint32Array.from({ length: cloud.count }, (_, i) => i);

    const sExclude = computeDensity(cloud, kept, R);
    const sKeep = computeDensity(cloud, all, R);
    const remap = new Map<number, number>();
    kept.forEach((orig, k) => remap.set(orig, k));
    let strictlyMore = 0;
    for (let orig = 0; orig < cloud.count; orig++) {
      const k = remap.get(orig);
      if (k === undefined) continue;
      expect(sKeep.counts[orig]).toBeGreaterThanOrEqual(sExclude.counts[k]);
      if (sKeep.counts[orig] > sExclude.counts[k]) strictlyMore++;
    }
    expect(strictlyMore).toBeGreaterThan(0); // 确实存在跨切面的邻居被两种模式区别对待
    expect(optsKeep.excludeFromStats).toBe(false);
  });
});

describe('内置疏密分界验证', () => {
  it.each(['plane', 'shell', 'noise'] as SceneId[])(
    'Otsu 阈值在 %s 场景对真值标签 F1 >= 0.8',
    (id) => {
      const cloud = buildScene(id, SCENE_INFO[id].defaultSeed);
      const active = Uint32Array.from({ length: cloud.count }, (_, i) => i);
      const stats = computeDensity(cloud, active, R);
      const v = validateBoundary(cloud, stats);
      expect(v.threshold).toBeGreaterThan(0);
      expect(v.denseMean).toBeGreaterThan(v.sparseMean);
      expect(v.logSeparation).toBeGreaterThan(0.5);
      expect(v.f1).toBeGreaterThanOrEqual(0.8);
      expect(v.confusion.tp + v.confusion.fp + v.confusion.tn + v.confusion.fn).toBe(cloud.count);
    },
  );

  it('全同密度时阈值退化为该密度而不崩溃', () => {
    const d = new Float32Array([5, 5, 5, 5]);
    expect(otsuDensityThreshold(d)).toBeCloseTo(5, 6);
  });
});

describe('投影重叠量化', () => {
  it('球壳沿视线存在重叠格, 且随视角旋转重叠比例下降', () => {
    const cloud = buildScene('shell', SCENE_INFO.shell.defaultSeed);
    const active = Uint32Array.from({ length: cloud.count }, (_, i) => i);
    const alongZ = analyzeProjection(cloud, active, [0, 0, 1], 0.15, 0.3);
    expect(alongZ.overlapBins).toBeGreaterThan(0);
    expect(alongZ.overlapPointFraction).toBeGreaterThan(0.1);
    // 换一个斜视角, 内外壳在屏幕上错开, 重叠应显著减少
    const tilted = analyzeProjection(cloud, active, [1, 0.6, 0.3], 0.15, 0.3);
    expect(tilted.overlapPointFraction).toBeLessThan(alongZ.overlapPointFraction);
  });

  it('单层平面正视方向深度跨度小, 不产生重叠误报', () => {
    const cloud = buildScene('plane', SCENE_INFO.plane.defaultSeed);
    const active = Uint32Array.from(cloud.labels)
      .map((l, i) => (l === 1 ? i : -1))
      .filter((i) => i >= 0);
    const r = analyzeProjection(cloud, Uint32Array.from(active), [0, 0, 1], 0.15, 0.3);
    expect(r.overlapPointFraction).toBeLessThan(0.05);
  });
});
