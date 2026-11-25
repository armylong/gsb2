import { DIR_VECTORS } from '../game/layout';
import type { Dir } from '../game/types';

/** 两面旗组合的迷你 SVG；arm 0 朱、1 青 */
export function glyphSvg(
  pair: readonly [Dir, Dir] | null | undefined,
  size = 38,
): string {
  const c = 16;
  const r = 11;
  const arms: Array<{ x2: number; y2: number; color: string }> = [];
  if (pair) {
    (['#dc2626', '#2563eb'] as const).forEach((color, i) => {
      const v = DIR_VECTORS[pair[i]];
      arms.push({ x2: c + v.x * r, y2: c + v.y * r, color });
    });
  }
  const lines = arms
    .map(
      (a) =>
        `<line x1="${c}" y1="${c}" x2="${a.x2.toFixed(1)}" y2="${a.y2.toFixed(1)}" stroke="${a.color}" stroke-width="2.6" stroke-linecap="round"/>
         <circle cx="${a.x2.toFixed(1)}" cy="${a.y2.toFixed(1)}" r="2.4" fill="${a.color}"/>`,
    )
    .join('');
  return `<svg class="glyph" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <circle cx="${c}" cy="${c}" r="8.5" fill="none" stroke="#cbd5e1" stroke-width="1"/>
    ${lines}
    <circle cx="${c}" cy="${c}" r="2.2" fill="#334155"/>
  </svg>`;
}

export function levelBadge(level: string): string {
  const map: Record<string, { cls: string; text: string }> = {
    both: { cls: 'lv-both', text: '双清' },
    stitch: { cls: 'lv-stitch', text: '分半拼见' },
    one: { cls: 'lv-one', text: '单旗' },
    none: { cls: 'lv-none', text: '全遮' },
  };
  const v = map[level] ?? { cls: '', text: level };
  return `<span class="level-badge ${v.cls}">${v.text}</span>`;
}
