/**
 * sRGB 传递函数（IEC 61966-2-1 分段定义）。
 * 输入图片一律按 sRGB 编码值解释；"线性光"模式用这两个函数在编码值与线性光值之间转换。
 */

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
