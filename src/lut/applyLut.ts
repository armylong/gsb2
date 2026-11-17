/**
 * 色表应用（CPU 参考实现）。
 *
 * 这是导出与自动验证使用的实现；WebGL2 预览着色器按完全相同的语义编写：
 * 1. 输入像素按 sRGB 编码值解释（0..1）。
 * 2. mode = 'srgb'  : 色表直接作用于 sRGB 编码值。
 *    mode = 'linear': 先解码为线性光值，色表作用于线性光值，结果再编码回 sRGB。
 * 3. 色表输入按 domainMin/domainMax 归一化，超出范围按边界截断（clamp）。
 * 4. 插值：'trilinear' 真三线性（8 个网格点加权）；'nearest' 最近网格点，用于对照。
 * 5. 强度混合在色表的工作空间内进行：out = w + (lut(w) - w) * strength。
 *    强度 0 精确恢复原图，强度 1 完整应用色表，中间值不跨空间混算。
 * 6. 混合结果截断到 [0,1]（线性模式下先截断再编码回 sRGB，因传递函数单调，等价于最终截断）。
 * 7. 透明通道不参与运算，原样保留；不做任何预乘/解预乘，透明边沿不会引入黑边。
 */

import type { Lut3D } from './cubeParser';
import { srgbToLinear, linearToSrgb } from './srgb';

export type Interpolation = 'trilinear' | 'nearest';
export type ColorSpaceMode = 'srgb' | 'linear';

export interface ApplyOptions {
  interpolation: Interpolation;
  mode: ColorSpaceMode;
  /** 0..1,0 = 原图,1 = 完整色表 */
  strength: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 在已归一化（0..1）的网格坐标上采样色表 */
export function sampleLut(
  lut: Lut3D,
  r: number,
  g: number,
  b: number,
  interpolation: Interpolation
): [number, number, number] {
  const n = lut.size;
  const d = lut.data;
  const nx = clamp01((r - lut.domainMin[0]) / (lut.domainMax[0] - lut.domainMin[0]));
  const ny = clamp01((g - lut.domainMin[1]) / (lut.domainMax[1] - lut.domainMin[1]));
  const nz = clamp01((b - lut.domainMin[2]) / (lut.domainMax[2] - lut.domainMin[2]));
  const x = nx * (n - 1);
  const y = ny * (n - 1);
  const z = nz * (n - 1);
  const at = (i: number, j: number, k: number, c: number): number => d[((k * n + j) * n + i) * 3 + c];

  if (interpolation === 'nearest') {
    const i = Math.round(x);
    const j = Math.round(y);
    const k = Math.round(z);
    return [at(i, j, k, 0), at(i, j, k, 1), at(i, j, k, 2)];
  }

  const i0 = Math.floor(x);
  const j0 = Math.floor(y);
  const k0 = Math.floor(z);
  const i1 = Math.min(i0 + 1, n - 1);
  const j1 = Math.min(j0 + 1, n - 1);
  const k1 = Math.min(k0 + 1, n - 1);
  const fx = x - i0;
  const fy = y - j0;
  const fz = z - k0;

  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c000 = at(i0, j0, k0, c);
    const c100 = at(i1, j0, k0, c);
    const c010 = at(i0, j1, k0, c);
    const c110 = at(i1, j1, k0, c);
    const c001 = at(i0, j0, k1, c);
    const c101 = at(i1, j0, k1, c);
    const c011 = at(i0, j1, k1, c);
    const c111 = at(i1, j1, k1, c);
    const c00 = c000 + (c100 - c000) * fx;
    const c10 = c010 + (c110 - c010) * fx;
    const c01 = c001 + (c101 - c001) * fx;
    const c11 = c011 + (c111 - c011) * fx;
    const c0 = c00 + (c10 - c00) * fy;
    const c1 = c01 + (c11 - c01) * fy;
    out[c] = c0 + (c1 - c0) * fz;
  }
  return out;
}

/** 处理单个像素（输入输出均为 0..1 的 sRGB 编码值，不含 alpha） */
export function applyLutToPixel(
  r: number,
  g: number,
  b: number,
  lut: Lut3D,
  opts: ApplyOptions
): [number, number, number] {
  let wr = r;
  let wg = g;
  let wb = b;
  if (opts.mode === 'linear') {
    wr = srgbToLinear(wr);
    wg = srgbToLinear(wg);
    wb = srgbToLinear(wb);
  }
  const [lr, lg, lb] = sampleLut(lut, wr, wg, wb, opts.interpolation);
  const s = opts.strength;
  let or = wr + (lr - wr) * s;
  let og = wg + (lg - wg) * s;
  let ob = wb + (lb - wb) * s;
  if (opts.mode === 'linear') {
    or = linearToSrgb(clamp01(or));
    og = linearToSrgb(clamp01(og));
    ob = linearToSrgb(clamp01(ob));
  }
  return [clamp01(or), clamp01(og), clamp01(ob)];
}

/**
 * 处理整幅 RGBA 图片（8bit/通道，行优先）。返回新数组，不修改输入。
 * alpha 通道逐字节原样拷贝。lut 为 null 或强度为 0 时返回原图副本。
 */
export function applyLutToImage(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  lut: Lut3D | null,
  opts: ApplyOptions
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  if (!lut || opts.strength === 0) {
    out.set(data);
    return out;
  }
  const pixelCount = width * height;
  for (let p = 0; p < pixelCount; p++) {
    const o = p * 4;
    const [r, g, b] = applyLutToPixel(data[o] / 255, data[o + 1] / 255, data[o + 2] / 255, lut, opts);
    out[o] = Math.round(r * 255);
    out[o + 1] = Math.round(g * 255);
    out[o + 2] = Math.round(b * 255);
    out[o + 3] = data[o + 3];
  }
  return out;
}
