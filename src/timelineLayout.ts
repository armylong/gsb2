/** 时间轴百分比换算与刻度工具。 */

export function pctOf(time: number, horizonMs: number): number {
  if (!Number.isFinite(time)) return 100;
  return Math.max(0, Math.min(100, (time / horizonMs) * 100));
}

export function clampEnd(end: number, horizonMs: number): number {
  return Number.isFinite(end) ? Math.min(end, horizonMs) : horizonMs;
}

export const TICK_STEP = 1000;
export const MAJOR_TICK = 5000;

export function axisTicks(horizonMs: number): number[] {
  const ticks: number[] = [];
  for (let t = 0; t <= horizonMs; t += TICK_STEP) ticks.push(t);
  return ticks;
}
