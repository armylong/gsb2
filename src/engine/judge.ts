import type { Grade } from './types.ts';

/**
 * 边界判法（闭区间，恰好压线归更优档）：
 *   |Δ| <= perfectWindow  → perfect
 *   |Δ| <= goodWindow     → good
 *   其余                  → null（调用方按 miss/ignored 处理）
 * Δ 定义为 输入时刻 - 目标时刻：负=早，正=晚。
 */
export function gradeDelta(deltaSec: number, perfectWindow: number, goodWindow: number): Grade | null {
  // 1e-9 容差消掉二进制浮点误差（如 1.0-0.95=0.050000000000000044），规则窗口本身是精确十进制参数。
  const eps = 1e-9;
  const abs = Math.abs(deltaSec);
  if (abs <= perfectWindow + eps) return 'perfect';
  if (abs <= goodWindow + eps) return 'good';
  return null;
}

/** 等级排序，用于汇总与展示。 */
export function gradeRank(g: Grade): number {
  switch (g) {
    case 'perfect':
      return 3;
    case 'good':
      return 2;
    case 'miss':
      return 1;
    case 'ignored':
      return 0;
  }
}

/** 早/晚文字。0 显示“压线”。 */
export function deltaLabel(deltaMs: number | null): string {
  if (deltaMs === null) return '—';
  const ms = Math.round(deltaMs);
  if (ms === 0) return '压线 0ms';
  return ms < 0 ? `早 ${-ms}ms` : `晚 ${ms}ms`;
}
