/**
 * 纯函数确定性噪声:相同 (x, y, seed) 永远得到相同结果,
 * 主线程、WebWorker、Node 验证脚本共用同一份实现。
 */

/** 二维整数格点哈希,返回 [0, 1) */
export function hash2i(x: number, y: number, seed: number): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
  h = Math.imul(h ^ (y | 0), 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 二维值噪声,输出范围 [0, 1] */
export function valueNoise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smoothstep(x - ix);
  const fy = smoothstep(y - iy);

  const a = hash2i(ix, iy, seed);
  const b = hash2i(ix + 1, iy, seed);
  const c = hash2i(ix, iy + 1, seed);
  const d = hash2i(ix + 1, iy + 1, seed);

  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

/** 分形布朗运动,输出 [0, 1] */
export function fbm2(
  x: number,
  y: number,
  seed: number,
  octaves = 4,
  gain = 0.5,
  lacunarity = 2,
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + o * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** 山脊噪声:脊线处接近 1,山谷处接近 0 */
export function ridgedFbm2(
  x: number,
  y: number,
  seed: number,
  octaves = 4,
  gain = 0.52,
  lacunarity = 2,
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise2(x * freq, y * freq, seed + o * 1013);
    const ridge = 1 - Math.abs(2 * n - 1);
    sum += amp * ridge * ridge;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
