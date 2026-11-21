/**
 * 可重复的山谷高度场。
 * 纯函数模块（不依赖 three），供渲染端与验证脚本共用。
 *
 * 地形构成：
 *  - 山谷主形：沿 x 轴延伸的谷地，高度随 |z| 按幂次抬升，并带正弦蜿蜒
 *  - fbm 值噪声：中频起伏
 *  - 山脊噪声：制造局部陡坡，让坡度规则在谷底气附近也有变化
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Heightfield {
  /** 世界尺寸（正方形边长，米），地形覆盖 [-size/2, size/2] */
  readonly size: number;
  readonly seed: number;
  height(x: number, z: number): number;
  /** 有限差分法线（已归一化） */
  normal(x: number, z: number): Vec3;
  /** 坡度（度），0 = 水平 */
  slopeDeg(x: number, z: number): number;
}

/** mulberry32 确定性伪随机数发生器 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smootherstep01(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function makeHeightfield(seed = 1337, size = 400): Heightfield {
  const rand = mulberry32(seed);
  const LATTICE = 128;
  const latticeSize = LATTICE + 1;
  const values = new Float64Array(latticeSize * latticeSize);
  for (let i = 0; i < values.length; i++) values[i] = rand();

  const latticeAt = (ix: number, iz: number): number => {
    const x = ((ix % latticeSize) + latticeSize) % latticeSize;
    const z = ((iz % latticeSize) + latticeSize) % latticeSize;
    return values[z * latticeSize + x];
  };

  /** 值噪声，freq 单位：周期/米 */
  function valueNoise(x: number, z: number, freq: number): number {
    const fx = x * freq;
    const fz = z * freq;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = smootherstep01(fx - ix);
    const tz = smootherstep01(fz - iz);
    const v00 = latticeAt(ix, iz);
    const v10 = latticeAt(ix + 1, iz);
    const v01 = latticeAt(ix, iz + 1);
    const v11 = latticeAt(ix + 1, iz + 1);
    const a = v00 + (v10 - v00) * tx;
    const b = v01 + (v11 - v01) * tx;
    return a + (b - a) * tz; // [0,1]
  }

  /** fbm，输出约 [-1, 1] */
  function fbm(x: number, z: number, baseFreq: number, octaves: number): number {
    let amp = 1;
    let freq = baseFreq;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * (valueNoise(x, z, freq) * 2 - 1);
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;
  }

  const half = size / 2;
  const meanderPhase = rand() * Math.PI * 2;

  const height = (x: number, z: number): number => {
    // 谷中心线沿 x 方向蜿蜒
    const meander = Math.sin(x * 0.011 + meanderPhase) * 28 + fbm(x, 0, 1 / 300, 2) * 14;
    const dz = Math.abs(z - meander) / half; // 0 谷底 → ~1 边缘
    const valley = Math.pow(dz, 2.1) * 58; // 谷壁主坡
    const hills = fbm(x, z, 1 / 90, 4) * 13; // 中频起伏
    // 山脊噪声：折痕附近坡度陡，给坡度规则制造低海拔陡坡样本
    const r = fbm(x + 137.7, z - 51.2, 1 / 55, 3);
    const ridged = (1 - Math.abs(r)) ** 2 * 9;
    return valley + hills + ridged;
  };

  const normal = (x: number, z: number): Vec3 => {
    const e = 0.75;
    const hx = height(x + e, z) - height(x - e, z);
    const hz = height(x, z + e) - height(x, z - e);
    const nx = -hx / (2 * e);
    const nz = -hz / (2 * e);
    const len = Math.hypot(nx, 1, nz);
    return { x: nx / len, y: 1 / len, z: nz / len };
  };

  const slopeDeg = (x: number, z: number): number => {
    const n = normal(x, z);
    return (Math.acos(Math.min(1, Math.max(-1, n.y))) * 180) / Math.PI;
  };

  return { size, seed, height, normal, slopeDeg };
}
