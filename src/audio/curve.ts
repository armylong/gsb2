import type { CurvePoint } from './types';

/** 保证曲线首点 t=0、末点 t=1, 且按 t 升序 */
export function normalizeCurve(points: CurvePoint[]): CurvePoint[] {
  const sorted = points.map((p) => ({ ...p })).sort((a, b) => a.t - b.t);
  if (sorted.length === 0 || sorted[0].t !== 0) sorted.unshift({ t: 0, v: 1 });
  if (sorted[sorted.length - 1].t !== 1) sorted.push({ t: 1, v: 0 });
  return sorted.map((p) => ({
    t: Math.min(1, Math.max(0, p.t)),
    v: Math.min(1, Math.max(0, p.v)),
  }));
}

/** 分段线性采样归一化曲线, u 超出 [0,1] 时按端点钳制 */
export function sampleCurve(points: CurvePoint[], u: number): number {
  if (points.length === 0) return 0;
  const x = Math.min(1, Math.max(0, u));
  if (x <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (x <= b.t) {
      const span = b.t - a.t;
      if (span <= 0) return b.v;
      const k = (x - a.t) / span;
      return a.v + (b.v - a.v) * k;
    }
  }
  return points[points.length - 1].v;
}
