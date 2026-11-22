import { RNG } from './rng';

/** 点的真值类别: 1 = 密集结构 (几何面/簇), 0 = 稀疏噪声 */
export type Label = 0 | 1;

export interface PointCloud {
  positions: Float32Array; // xyz 交错, 长度 = count * 3
  labels: Uint8Array; // 与点一一对应的真值标签
  count: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** 场景组成说明, 供界面展示 */
  description: string;
}

export type SceneId = 'plane' | 'shell' | 'noise';

/**
 * 场景 1: 带空洞的平面 + 稀疏空间噪点。
 * - 平面 z≈0, 半径 2 的圆盘内挖去 3 个圆洞; 面上点密集且近似规则 (网格 + 小抖动)
 * - 盒子范围内均匀撒稀疏噪点, 其中少量噪点恰好落在平面深度上 (模拟投影重叠)
 */
function buildPlane(seed: number): PointCloud {
  const rng = new RNG(seed);
  const pts: number[] = [];
  const labels: Label[] = [];

  // --- 密集平面 (圆盘挖洞) ---
  const R = 2.0;
  const holes: Array<[number, number, number]> = [
    [-0.85, 0.55, 0.42],
    [0.7, -0.75, 0.5],
    [0.25, 0.95, 0.3],
  ];
  const spacing = 0.085;
  const n = Math.floor((2 * R) / spacing);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = -R + (i + 0.5) * spacing + rng.gaussian(0, spacing * 0.08);
      const y = -R + (j + 0.5) * spacing + rng.gaussian(0, spacing * 0.08);
      if (x * x + y * y > R * R) continue;
      if (holes.some(([hx, hy, hr]) => (x - hx) ** 2 + (y - hy) ** 2 < hr * hr)) continue;
      pts.push(x, y, rng.gaussian(0, 0.004));
      labels.push(1);
    }
  }
  const planeCount = pts.length / 3;

  // --- 稀疏空间噪点 (全空间均匀) ---
  const NOISE = 400;
  for (let k = 0; k < NOISE; k++) {
    const x = rng.uniform(-2.6, 2.6);
    const y = rng.uniform(-2.6, 2.6);
    const z = rng.uniform(-2.2, 2.2);
    pts.push(x, y, z);
    labels.push(0);
  }

  // --- 投影重叠诱饵: 与平面同深度 (z≈0) 但 xy 在洞外的稀疏点,
  //     正视时与平面点在屏幕上几乎重合, 旋转视角即可区分 ---
  const DECOY = 90;
  let made = 0;
  let guard = 0;
  while (made < DECOY && guard++ < 5000) {
    const x = rng.uniform(-R, R);
    const y = rng.uniform(-R, R);
    if (x * x + y * y > R * R) continue;
    if (holes.some(([hx, hy, hr]) => (x - hx) ** 2 + (y - hy) ** 2 < hr * hr)) continue;
    pts.push(x, y, rng.gaussian(0, 0.012));
    labels.push(0);
    made++;
  }

  return finalize(
    pts,
    labels,
    `带空洞平面: 圆盘半径 ${R}, 3 个圆洞; 密集面点 ${planeCount} 个 (规则网格+抖动), ` +
      `空间稀疏噪点 ${NOISE} 个, 同深度投影诱饵 ${made} 个 (标签=稀疏)。`,
  );
}

/**
 * 场景 2: 球壳 (带球形缺口) + 稀疏外层壳。
 * - 内壳 r≈1.5 密集, 北极附近挖去一个球冠;
 * - 外壳 r≈2.4 稀疏, 正视方向上与内壳点大量屏幕重叠。
 */
function buildShell(seed: number): PointCloud {
  const rng = new RNG(seed);
  const pts: number[] = [];
  const labels: Label[] = [];

  const innerN = 2600;
  const capCos = Math.cos(0.6); // 北极球冠半角 0.6 rad
  let innerKept = 0;
  let guard = 0;
  while (innerKept < innerN && guard++ < innerN * 4) {
    const [dx, dy, dz] = rng.unitVector();
    if (dy > capCos) continue; // 挖掉北极球冠
    const r = 1.5 + rng.gaussian(0, 0.012);
    pts.push(dx * r, dy * r, dz * r);
    labels.push(1);
    innerKept++;
  }

  const outerN = 450;
  for (let k = 0; k < outerN; k++) {
    const [dx, dy, dz] = rng.unitVector();
    const r = 2.4 + rng.gaussian(0, 0.02);
    pts.push(dx * r, dy * r, dz * r);
    labels.push(0);
  }

  return finalize(
    pts,
    labels,
    `双层球壳: 内壳 r≈1.5 密集点 ${innerKept} 个 (北极挖 0.6rad 球冠), ` +
      `外壳 r≈2.4 稀疏点 ${outerN} 个; 沿视线方向两层点会屏幕重叠, 但局部密度相差一个量级。`,
  );
}

/**
 * 场景 3: 离散噪点 —— 全空间均匀稀疏背景 + 两个致密高斯团簇。
 * 没有任何连续几何面, 用于检验"高密度 ≠ 几何面"时的判断。
 */
function buildNoise(seed: number): PointCloud {
  const rng = new RNG(seed);
  const pts: number[] = [];
  const labels: Label[] = [];

  const BACKGROUND = 1400;
  for (let k = 0; k < BACKGROUND; k++) {
    pts.push(rng.uniform(-3, 3), rng.uniform(-3, 3), rng.uniform(-3, 3));
    labels.push(0);
  }

  const clusters: Array<[number, number, number, number, number]> = [
    [1.6, 1.4, -1.2, 320, 0.18],
    [-1.7, -1.1, 1.3, 260, 0.22],
  ];
  let clusterTotal = 0;
  for (const [cx, cy, cz, n, sigma] of clusters) {
    for (let k = 0; k < n; k++) {
      pts.push(
        cx + rng.gaussian(0, sigma),
        cy + rng.gaussian(0, sigma),
        cz + rng.gaussian(0, sigma),
      );
      labels.push(1);
      clusterTotal++;
    }
  }

  return finalize(
    pts,
    labels,
    `离散噪点: 均匀稀疏背景 ${BACKGROUND} 个 + 2 个致密高斯团簇共 ${clusterTotal} 个; ` +
      `团簇密度高但不构成几何面, 用于验证疏密分界而不把高密度误当表面。`,
  );
}

function finalize(raw: number[], labels: Label[], description: string): PointCloud {
  const positions = new Float32Array(raw);
  const count = positions.length / 3;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < 3; d++) {
      const v = positions[i * 3 + d];
      if (v < min[d]) min[d] = v;
      if (v > max[d]) max[d] = v;
    }
  }
  return { positions, labels: Uint8Array.from(labels), count, bounds: { min, max }, description };
}

const BUILDERS: Record<SceneId, (seed: number) => PointCloud> = {
  plane: buildPlane,
  shell: buildShell,
  noise: buildNoise,
};

export const SCENE_INFO: Record<SceneId, { name: string; defaultSeed: number }> = {
  plane: { name: '带空洞平面 + 噪点', defaultSeed: 1435601 },
  shell: { name: '双层球壳 (含缺口)', defaultSeed: 1435602 },
  noise: { name: '离散噪点 + 致密团簇', defaultSeed: 1435603 },
};

export function buildScene(id: SceneId, seed: number): PointCloud {
  return BUILDERS[id](seed);
}
