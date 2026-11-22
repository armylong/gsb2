/**
 * 点云着色工具。
 * 密度用 log10 尺度 + 2%/98% 百分位归一化, 避免极端值压扁色阶。
 */

/** Google Turbo 近似配色 (t∈[0,1] -> [r,g,b] 0..255), 蓝(低)->红(高) */
export function turbo(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const r =
    0.13572138 +
    4.6153926 * x -
    42.66032258 * x ** 2 +
    132.13108234 * x ** 3 -
    152.94239396 * x ** 4 +
    59.28637944 * x ** 5;
  const g =
    0.09140261 +
    2.19418839 * x +
    4.84296658 * x ** 2 -
    14.18503333 * x ** 3 +
    4.27729857 * x ** 4 +
    2.82956604 * x ** 5;
  const b =
    0.1066733 +
    12.64194608 * x -
    60.58204836 * x ** 2 +
    110.36276771 * x ** 3 -
    89.90310912 * x ** 4 +
    27.34824974 * x ** 5;
  return [clamp255(r * 255), clamp255(g * 255), clamp255(b * 255)];
}

function clamp255(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v)));
}

function percentile(sorted: Float32Array, p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

/** 密度着色: 输入每点密度 (ppv), 返回 RGB 字节与色阶上下限 (log10 ppv) */
export function densityColors(densities: Float32Array): {
  rgb: Uint8Array;
  logMin: number;
  logMax: number;
} {
  const logs = new Float32Array(densities.length);
  for (let i = 0; i < densities.length; i++) logs[i] = Math.log10(Math.max(densities[i], 1e-9));
  const sorted = Float32Array.from(logs).sort();
  const logMin = percentile(sorted, 0.02);
  const logMax = percentile(sorted, 0.98);
  const span = logMax - logMin || 1;
  const rgb = new Uint8Array(densities.length * 3);
  for (let i = 0; i < densities.length; i++) {
    const t = (logs[i] - logMin) / span;
    const [r, g, b] = turbo(t);
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return { rgb, logMin, logMax };
}

/** 深度着色: 相机空间 z (近=暖色, 远=冷色), 线性归一化到当前帧深度范围 */
export function depthColors(viewZs: Float32Array): Uint8Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (const z of viewZs) {
    if (z < lo) lo = z;
    if (z > hi) hi = z;
  }
  const span = hi - lo || 1;
  const rgb = new Uint8Array(viewZs.length * 3);
  for (let i = 0; i < viewZs.length; i++) {
    const t = (viewZs[i] - lo) / span;
    const [r, g, b] = turbo(1 - t); // 近 -> 红, 远 -> 蓝
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return rgb;
}

/** 真值标签着色: 密集结构=橙红, 稀疏噪声=青灰 */
export function labelColors(labels: Uint8Array): Uint8Array {
  const rgb = new Uint8Array(labels.length * 3);
  for (let i = 0; i < labels.length; i++) {
    if (labels[i]) {
      rgb[i * 3] = 255;
      rgb[i * 3 + 1] = 128;
      rgb[i * 3 + 2] = 0;
    } else {
      rgb[i * 3] = 90;
      rgb[i * 3 + 1] = 170;
      rgb[i * 3 + 2] = 180;
    }
  }
  return rgb;
}

/** 投影重叠着色: 重叠=红, 干净=蓝灰 */
export function overlapColors(isOverlap: Uint8Array): Uint8Array {
  const rgb = new Uint8Array(isOverlap.length * 3);
  for (let i = 0; i < isOverlap.length; i++) {
    if (isOverlap[i]) {
      rgb[i * 3] = 235;
      rgb[i * 3 + 1] = 64;
      rgb[i * 3 + 2] = 52;
    } else {
      rgb[i * 3] = 70;
      rgb[i * 3 + 1] = 110;
      rgb[i * 3 + 2] = 200;
    }
  }
  return rgb;
}
