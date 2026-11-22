/**
 * 误差热图配色：蓝 -> 青 -> 绿 -> 黄 -> 红 的分段线性渐变。
 * 归一化支持线性与对数（误差通常跨数量级，默认对数更易看出分布）。
 */

const STOPS: [number, [number, number, number]][] = [
  [0.0, [40, 60, 180]],
  [0.25, [0, 180, 220]],
  [0.5, [60, 190, 90]],
  [0.75, [240, 210, 40]],
  [1.0, [225, 40, 40]],
];

export type HeatScale = 'linear' | 'log';

export function heatColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [t0, c0] = STOPS[i];
    const [t1, c1] = STOPS[i + 1];
    if (x >= t0 && x <= t1) {
      const k = (x - t0) / (t1 - t0);
      return [
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k,
      ];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

export function normalizeError(error: number, maxError: number, scale: HeatScale): number {
  if (maxError <= 0 || error <= 0) return 0;
  if (scale === 'linear') return error / maxError;
  return Math.log10(1 + (error / maxError) * 9) / Math.log10(10); // 平滑映射到 [0,1]
}

/** 生成顶点色 Float32Array（three.js Color 期望 0..1） */
export function buildHeatColors(errors: Float64Array, maxError: number, scale: HeatScale): Float32Array {
  const colors = new Float32Array(errors.length * 3);
  for (let i = 0; i < errors.length; i++) {
    const [r, g, b] = heatColor(normalizeError(errors[i], maxError, scale));
    colors[i * 3] = r / 255;
    colors[i * 3 + 1] = g / 255;
    colors[i * 3 + 2] = b / 255;
  }
  return colors;
}

/** 在图例 canvas 上画渐变条与刻度 */
export function drawLegend(canvas: HTMLCanvasElement, maxError: number, scale: HeatScale) {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  for (let x = 0; x < w; x++) {
    const [r, g, b] = heatColor(x / (w - 1));
    ctx.fillStyle = `rgb(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})`;
    ctx.fillRect(x, 0, 1, h - 14);
  }
  ctx.fillStyle = '#cfd6e4';
  ctx.font = '11px monospace';
  const fmt = (t: number) => {
    const v = scale === 'log' ? (10 ** (t * 1) - 1) / 9 * maxError : t * maxError;
    return v.toExponential(1);
  };
  ctx.fillText(fmt(0), 0, h - 2);
  const mid = fmt(0.5);
  ctx.fillText(mid, w / 2 - ctx.measureText(mid).width / 2, h - 2);
  const top = fmt(1);
  ctx.fillText(top, w - ctx.measureText(top).width, h - 2);
}
