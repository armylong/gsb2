import type { LevelDef, TidePoint } from './types';

/**
 * 潮汐时间表：一个周期内的分段线性水位曲线。
 * 周期 60 刻：
 *   0–20  退潮 4 -> 0（路陆续露出）
 *  20–34  低潮 0（退潮路全开）
 *  34–54  涨潮 0 -> 4（路从低到高陆续封掉）
 *  54–60  满潮 4
 */
export const TIDE_CURVE: TidePoint[] = [
  { t: 0, level: 4 },
  { t: 20, level: 0 },
  { t: 34, level: 0 },
  { t: 54, level: 4 },
  { t: 60, level: 4 },
];

/** 绝对时刻 t 的水位（线性插值，按周期取模） */
export function tideLevel(t: number, period: number): number {
  const tp = ((t % period) + period) % period;
  for (let i = 0; i < TIDE_CURVE.length - 1; i++) {
    const p0 = TIDE_CURVE[i];
    const p1 = TIDE_CURVE[i + 1];
    if (tp >= p0.t && tp <= p1.t) {
      if (p1.t === p0.t) return p0.level;
      const k = (tp - p0.t) / (p1.t - p0.t);
      return p0.level + (p1.level - p0.level) * k;
    }
  }
  return TIDE_CURVE[TIDE_CURVE.length - 1].level;
}

/** 路 / 格子是否露出：水位不高于其高程即可走 / 可站（水位 > 高程才算淹没） */
export function isAboveWater(level: number, height: number): boolean {
  return level <= height;
}

/**
 * 从时刻 t 起，高程 h 的路面下次被封的时间差（刻，小数）。
 * 即首次满足 tideLevel >= h 的时刻 - t；视野 horizon 内不封则返回 null。
 */
export function ticksUntilClosed(
  t: number,
  height: number,
  period: number,
  horizon = 160,
): number | null {
  const now = tideLevel(t, period);
  if (!isAboveWater(now, height)) return 0;
  const step = 0.25;
  let cur = t;
  const end = t + horizon;
  while (cur <= end) {
    cur += step;
    if (!isAboveWater(tideLevel(cur, period), height)) {
      return cur - t;
    }
  }
  return null;
}

/** 从时刻 t 起，高程 h 的路面下次重新露出的时间差；视野内不露则 null */
export function ticksUntilOpen(
  t: number,
  height: number,
  period: number,
  horizon = 160,
): number | null {
  const now = tideLevel(t, period);
  if (isAboveWater(now, height)) return 0;
  const step = 0.25;
  let cur = t;
  const end = t + horizon;
  while (cur <= end) {
    cur += step;
    if (isAboveWater(tideLevel(cur, period), height)) {
      return cur - t;
    }
  }
  return null;
}

/** 每格显示用：当前能看见的水位（保留一位小数） */
export function visibleLevel(t: number, level: LevelDef): number {
  const raw = tideLevel(t, level.tidePeriod);
  return Math.round(raw * 10) / 10;
}
