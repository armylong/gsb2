// 颜色与绘制主题。偏差热图使用蓝色顺序色阶（dataviz 规范，暗表面 700→100）：
// 误差 0 沉入背景的深蓝，误差越大越亮，亮度单调，不靠彩虹色相。

export const THEME = {
  page: '#0d0d0d',
  surface: '#1a1a19',
  ink: '#f0efec',
  secondary: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  // 分类色（已通过暗表面校验）：蓝=原线，橙=重建，两色 ΔE 31.8
  original: '#3987e5',
  rebuilt: '#d95926',
  aqua: '#199e70',
  warning: '#fab219',
  heatStops: [
    '#0d366b', // 700
    '#104281', // 650
    '#184f95', // 600
    '#1c5cab', // 550
    '#256abf', // 500
    '#2a78d6', // 450
    '#3987e5', // 400
    '#6da7ec', // 300
    '#9ec5f4', // 200
    '#cde2fb', // 100
  ],
} as const;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** t ∈ [0,1] → 热图颜色 */
export function heatColor(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  const scaled = x * (THEME.heatStops.length - 1);
  const i = Math.min(Math.floor(scaled), THEME.heatStops.length - 2);
  const f = scaled - i;
  const c1 = hexToRgb(THEME.heatStops[i]);
  const c2 = hexToRgb(THEME.heatStops[i + 1]);
  const r = Math.round(lerp(c1[0], c2[0], f));
  const g = Math.round(lerp(c1[1], c2[1], f));
  const b = Math.round(lerp(c1[2], c2[2], f));
  return `rgb(${r},${g},${b})`;
}

/** CSS 渐变（色条用），与 heatColor 同档位 */
export function heatGradientCss(): string {
  return `linear-gradient(to right, ${THEME.heatStops.join(', ')})`;
}
