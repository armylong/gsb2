import type { ColorId, LevelDef, PaletteEntry } from './types';

export function paletteOf(level: LevelDef, color: ColorId): PaletteEntry {
  const entry = level.palette.find((p) => p.id === color);
  if (!entry) throw new Error(`未知颜色：${color}`);
  return entry;
}

/** 纸面颜色统一走这里，渲染与导出判定色保持一致。 */
export function colorCss(level: LevelDef, color: ColorId): string {
  return paletteOf(level, color).css;
}

/** 把十六进制颜色按权重与白色混合，返回 rgb 分量。 */
export function lighten(hex: string, amount: number): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const value = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const mix = (channel: number) => Math.round(channel + (255 - channel) * amount);
  return { r: mix(r), g: mix(g), b: mix(b) };
}

export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = lighten(hex, 0);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
