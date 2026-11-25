/**
 * 线性照度 → 显示颜色：指数软限幅色调映射（同一色标用于两块画布）。
 */
import type { IrradianceRGB } from './types.js';
import { clamp, linToSrgb, rgbLuma } from './geometry.js';

export interface ToneMapper {
  /** 自动曝光基准（通常取热图 total 的 99 分位亮度） */
  exposure: number;
}

export function createToneMapper(exposure: number): ToneMapper {
  return { exposure: Math.max(exposure, 1e-6) };
}

/** 把照度映射为 0~1 的 sRGB 三元组（用于 ImageData） */
export function mapIrradToBytes(
  c: IrradianceRGB,
  tm: ToneMapper,
  out: Uint8ClampedArray,
  idx: number,
): void {
  const k = 1 / tm.exposure;
  // 归一化后做 1-exp(-x) 软限幅，避免高光硬裁切
  const nr = c.r * k;
  const ng = c.g * k;
  const nb = c.b * k;
  out[idx] = Math.round(linToSrgb(1 - Math.exp(-nr)) * 255);
  out[idx + 1] = Math.round(linToSrgb(1 - Math.exp(-ng)) * 255);
  out[idx + 2] = Math.round(linToSrgb(1 - Math.exp(-nb)) * 255);
  out[idx + 3] = 255;
}

/** CSS 字符串版本（画墙、图例等） */
export function mapIrradToCss(c: IrradianceRGB, exposure: number): string {
  const tm = createToneMapper(exposure);
  const buf = new Uint8ClampedArray(4);
  mapIrradToBytes(c, tm, buf, 0);
  return `rgb(${buf[0]},${buf[1]},${buf[2]})`;
}

/** 图例：0~1 归一化亮度对应的颜色（中性白光） */
export function legendCss(normalized: number): string {
  const x = clamp(normalized, 0, 1);
  const s = linToSrgb(1 - Math.exp(-x * 2.2));
  return `rgb(${Math.round(s * 255)},${Math.round(s * 255)},${Math.round(s * 255)})`;
}

export { rgbLuma };
