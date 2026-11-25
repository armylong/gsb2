import { ColorCode, COLOR_NONE, PRIMARY } from './types.js';

/** 位掩码 -> 中文名 / 画布色值 */
interface ColorInfo {
  name: string;
  css: string;
  /** 组成它的三原中文名，用于解释“红 + 黄 = 橙” */
  primaries: string[];
}

const PRIMARY_NAMES: Readonly<Record<number, string>> = {
  [PRIMARY.R]: '红',
  [PRIMARY.Y]: '黄',
  [PRIMARY.B]: '蓝',
};

const TABLE: Readonly<Record<number, ColorInfo>> = {
  [COLOR_NONE]: { name: '白（未着色）', css: '#f6f4ee', primaries: [] },
  [PRIMARY.R]: { name: '红', css: '#e0524d', primaries: ['红'] },
  [PRIMARY.Y]: { name: '黄', css: '#f2c029', primaries: ['黄'] },
  [PRIMARY.B]: { name: '蓝', css: '#3f7fd6', primaries: ['蓝'] },
  [PRIMARY.R | PRIMARY.Y]: { name: '橙', css: '#ee8b2b', primaries: ['红', '黄'] },
  [PRIMARY.R | PRIMARY.B]: { name: '紫', css: '#8e5bb5', primaries: ['红', '蓝'] },
  [PRIMARY.Y | PRIMARY.B]: { name: '绿', css: '#43a877', primaries: ['黄', '蓝'] },
  [PRIMARY.R | PRIMARY.Y | PRIMARY.B]: {
    name: '棕（三色混合）',
    css: '#7a5a3a',
    primaries: ['红', '黄', '蓝'],
  },
};

export function colorInfo(color: ColorCode): ColorInfo {
  return TABLE[color] ?? { name: '未知色', css: '#999999', primaries: [] };
}

export function colorName(color: ColorCode): string {
  return colorInfo(color).name;
}

export function colorCss(color: ColorCode): string {
  return colorInfo(color).css;
}

/**
 * 人类可读的混色解释，例如：
 *   红 + 黄 → 橙
 * 输入来源颜色顺序无关（引擎已按来源 id 排序后再做并集）。
 */
export function explainMix(sourceColors: ColorCode[], result: ColorCode): string {
  const parts = [...new Set(sourceColors.flatMap((c) => colorInfo(c).primaries))];
  if (parts.length === 0) return `无花粉到达 → ${colorName(result)}`;
  return `${parts.join(' + ')} → ${colorName(result)}`;
}
