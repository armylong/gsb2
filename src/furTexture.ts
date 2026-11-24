import * as THREE from 'three';

/**
 * 确定性 2D 哈希 → [0,1)。
 * 同一 (x, y, seed) 永远得到同一值,这是“改层数/视角不换毛纹”的基础。
 */
function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

export interface FurTextureResult {
  texture: THREE.DataTexture;
  hairCount: number;
}

/**
 * 生成毛发分布纹理(R 通道 = 该像素处毛束能到达的归一化层高度)。
 *
 * 确定性保证:
 * - 毛发是否存在 = hash(cell) < density,密度只当阈值用,
 *   调大密度只会“多出”新毛,已有毛的位置和长度不变;
 * - 纹理与壳层层数完全无关,改层数不会换分布;
 * - seed 固定,视角/相机变化 obviously 不影响纹理。
 */
export function generateFurTexture(size: number, density: number, seed = 1337): FurTextureResult {
  const data = new Float32Array(size * size);
  const cell = 4; // 每根毛占的网格边长(px)
  const cells = Math.floor(size / cell);
  let hairCount = 0;

  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      if (hash2(cx, cy, seed) >= density) continue;
      hairCount++;

      const jx = hash2(cx, cy, seed + 1);
      const jy = hash2(cx, cy, seed + 2);
      const len = 0.45 + 0.55 * hash2(cx, cy, seed + 3); // 这根毛的最高层
      const px = (cx + 0.15 + 0.7 * jx) * cell;
      const py = (cy + 0.15 + 0.7 * jy) * cell;
      const rootR = 2.4; // 根部半径(px),锥形泼溅 → 根粗尖细

      const r = Math.ceil(rootR);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = Math.sqrt(dx * dx + dy * dy) / rootR;
          if (d >= 1) continue;
          const x = Math.round(px + dx);
          const y = Math.round(py + dy);
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const v = len * (1 - d);
          const idx = y * size + x;
          if (v > data[idx]) data[idx] = v; // max 混合
        }
      }
    }
  }

  const bytes = new Uint8Array(size * size);
  for (let i = 0; i < data.length; i++) bytes[i] = Math.min(255, Math.round(data[i] * 255));

  const tex = new THREE.DataTexture(bytes, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { texture: tex, hairCount };
}
