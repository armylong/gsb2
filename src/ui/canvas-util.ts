/**
 * 画布工具：DPR 适配、配色主题（深色工程风，已通过 dataviz 校验）、网格与文字。
 */
export const COLORS = {
  surface: '#161615',
  panel: '#1c1c1b',
  grid: '#2c2c2a',
  baseline: '#3d3d3a',
  text: '#f0efec',
  textDim: '#a3a29a',
  muted: '#898781',
  toneA: '#3987e5', // 蓝：A 路 / 左
  toneB: '#d95926', // 橙：B 路 / 右
  sum: '#199e70', // 青绿：相加对照
  envelope: '#9085e9', // 紫：包络
  warn: '#fab219',
  bad: '#e66767',
  good: '#0ca30c',
  playhead: '#f0efec',
} as const;

export function setupCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function clearPanel(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(0, 0, w, h);
}

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cols: number,
  rows: number,
  zeroRow = true,
) {
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath();
  for (let i = 1; i < cols; i++) {
    const x = (w * i) / cols;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let i = 1; i < rows; i++) {
    const y = (h * i) / rows;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  if (zeroRow) {
    ctx.strokeStyle = COLORS.baseline;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }
}

export function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, dim = false) {
  ctx.fillStyle = dim ? COLORS.muted : COLORS.textDim;
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y);
}

export function title(ctx: CanvasRenderingContext2D, text: string, x = 10, y = 8) {
  ctx.fillStyle = COLORS.text;
  ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y);
}

/** 把长缓冲按桶压缩为 min/max 折线点（密集波形也能看清峰谷） */
export function minMaxBuckets(data: Float32Array, buckets: number): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const per = data.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * per);
    const e = Math.max(s + 1, Math.floor((b + 1) * per));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = s; i < e && i < data.length; i++) {
      const v = data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo === Infinity ? 0 : lo;
    max[b] = hi === -Infinity ? 0 : hi;
  }
  return { min, max };
}

export function drawMinMaxWave(
  ctx: CanvasRenderingContext2D,
  data: Float32Array,
  w: number,
  h: number,
  color: string,
  scale = 1,
  buckets = Math.floor(w),
) {
  const { min, max } = minMaxBuckets(data, buckets);
  const mid = h / 2;
  const y = (v: number) => mid - (v * mid * scale);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < buckets; i++) {
    const x = (i / (buckets - 1)) * w;
    ctx.moveTo(x, y(max[i]));
    ctx.lineTo(x, y(min[i]));
  }
  ctx.stroke();
}

/** 平滑包络线（逐点连线） */
export function drawLine(
  ctx: CanvasRenderingContext2D,
  data: Float32Array,
  w: number,
  _h: number,
  color: string,
  toY: (v: number) => number,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1)) * w;
    const yv = toY(data[i]);
    if (i === 0) ctx.moveTo(x, yv);
    else ctx.lineTo(x, yv);
  }
  ctx.stroke();
}

export function legend(
  ctx: CanvasRenderingContext2D,
  items: { color: string; text: string }[],
  w: number,
  y = 8,
) {
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'top';
  let x = w - 10;
  const widths = items.map((it) => ctx.measureText(it.text).width + 22);
  x -= widths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    ctx.fillStyle = it.color;
    ctx.fillRect(x, y + 2, 12, 3);
    ctx.fillStyle = COLORS.textDim;
    ctx.fillText(it.text, x + 16, y);
    x += widths[i];
  }
}
