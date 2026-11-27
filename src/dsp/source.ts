/** 可复现的 32 位 PRNG（mulberry32） */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 浊声源：带限谐波叠加的周期脉冲串（锯齿式声门激励的带限版本）。
 * f0 全程恒定 —— 口形时间线只改共振区，绝不改音高。
 * 谐波只保留到奈奎斯特频率以内，避免混叠。
 */
export function generateVoiced(length: number, f0: number, sampleRate: number): Float32Array {
  const out = new Float32Array(length);
  const nHarmonics = Math.max(1, Math.floor((sampleRate / 2) / f0));
  // 1/n 幅度衰减，再整体归一化到 RMS≈1，与噪声源响度量级一致
  let norm = 0;
  for (let k = 1; k <= nHarmonics; k++) norm += 1 / k;
  const phaseInc = (2 * Math.PI * f0) / sampleRate;
  for (let n = 0; n < length; n++) {
    const phase = n * phaseInc;
    let v = 0;
    for (let k = 1; k <= nHarmonics; k++) {
      v += Math.sin(k * phase) / k;
    }
    out[n] = v / norm;
  }
  return out;
}

/** 无固定音高声源：白噪声（同一 seed 可复现） */
export function generateNoise(length: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const out = new Float32Array(length);
  // Box–Muller 高斯噪声，听感比均匀噪声更像气音
  let spare: number | null = null;
  for (let n = 0; n < length; n++) {
    if (spare !== null) {
      out[n] = spare;
      spare = null;
    } else {
      const u1 = Math.max(1e-12, rand());
      const u2 = rand();
      const r = Math.sqrt(-2 * Math.log(u1));
      out[n] = r * Math.cos(2 * Math.PI * u2) * 0.4;
      spare = r * Math.sin(2 * Math.PI * u2) * 0.4;
    }
  }
  return out;
}
