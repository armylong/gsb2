import {
  COLORS,
  clearPanel,
  drawGrid,
  drawLine,
  drawMinMaxWave,
  label,
  legend,
  minMaxBuckets,
  setupCanvas,
  title,
} from './canvas-util';
import type { RouteMode } from '../dsp/kernel';


export interface WaveViewData {
  /** 最近数秒的滚动数据（降采样后） */
  left: Float32Array;
  right: Float32Array;
  sumRef: Float32Array;
  envelope: Float32Array;
  windowS: number;
  mode: RouteMode;
}

/**
 * 波形+包络主画面。
 * split：上半分别画左耳收到的 A（蓝）与右耳收到的 B（橙），各自独立零轴；
 *        下半画两路相加的数学对照与解析包络。
 * mix  ：两耳信号相同，上半画该混合信号；下半仍为相加对照与包络。
 * 同频时包络拉平为直线 —— 拍动停止。
 */
export function drawWavePanel(canvas: HTMLCanvasElement, d: WaveViewData, hoverX: number | null) {
  const ctx = setupCanvas(canvas);
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  clearPanel(ctx, w, h);
  // 顶部 26px 为标题/图例区，两个波形区平分剩余高度
  const header = 26;
  const plotH = (h - header) / 2;

  // 标题（左）与图例（右）同在顶部，不与波形重叠
  title(
    ctx,
    d.mode === 'split'
      ? '耳机实际信号：左=A（蓝）  右=B（橙），上下分屏'
      : '耳机实际信号：左右同为 A+B 混合信号',
    10,
    7,
  );
  legend(
    ctx,
    [
      { color: COLORS.toneA, text: 'A/左' },
      { color: COLORS.toneB, text: 'B/右' },
      { color: COLORS.sum, text: 'A+B' },
      { color: COLORS.envelope, text: '包络' },
    ],
    w,
    7,
  );

  // 上波形区（纵向平移到 header 之下）
  ctx.save();
  ctx.translate(0, header);
  ctx.beginPath();
  ctx.rect(0, 0, w, plotH - 2);
  ctx.clip();
  drawGrid(ctx, w, plotH, 6, 2);
  if (d.mode === 'split') {
    drawStacked(ctx, d.left, w, plotH, COLORS.toneA, 0);
    drawStacked(ctx, d.right, w, plotH, COLORS.toneB, 1);
  } else {
    drawMinMaxWave(ctx, d.left, w, plotH, COLORS.toneA, 0.95);
  }
  ctx.restore();

  const divider = header + plotH;
  ctx.strokeStyle = COLORS.baseline;
  ctx.beginPath();
  ctx.moveTo(0, divider);
  ctx.lineTo(w, divider);
  ctx.stroke();

  ctx.save();
  ctx.translate(0, divider + 2);
  ctx.beginPath();
  ctx.rect(0, 0, w, plotH - 2);
  ctx.clip();
  drawGrid(ctx, w, plotH, 6, 2);
  drawMinMaxWave(ctx, d.sumRef, w, plotH, COLORS.sum, 0.95);
  // 包络 ±E：包络幅度范围 0..2g，映射到本区域
  const mid2 = plotH / 2;
  const envToY = (v: number) => mid2 - (v / 2) * (plotH / 2) * 1.9;
  drawLine(ctx, d.envelope, w, plotH, COLORS.envelope, envToY);
  drawLine(ctx, d.envelope, w, plotH, COLORS.envelope, (v) => envToY(-v));
  label(ctx, '两路相加对照 A+B（青）与解析包络 ±E（紫）', 10, 6);
  ctx.restore();

  for (let i = 0; i <= 4; i++) {
    const x = (w * i) / 4;
    const t = (-d.windowS + (d.windowS * i) / 4).toFixed(1);
    label(ctx, `${t}s`, x + 2, h - 14, true);
  }

  if (hoverX !== null && d.left.length > 1) {
    ctx.strokeStyle = COLORS.playhead;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hoverX, header);
    ctx.lineTo(hoverX, h);
    ctx.stroke();
    ctx.setLineDash([]);
    const idx = Math.min(d.left.length - 1, Math.max(0, Math.floor((hoverX / w) * d.left.length)));
    const tt = ((idx / d.left.length - 1) * d.windowS).toFixed(2);
    drawTooltip(
      ctx,
      [
        `t=${tt}s`,
        `L=${d.left[idx]?.toFixed(3) ?? '-'}`,
        `R=${d.right[idx]?.toFixed(3) ?? '-'}`,
        `A+B=${d.sumRef[idx]?.toFixed(3) ?? '-'}`,
        `E=${d.envelope[idx]?.toFixed(3) ?? '-'}`,
      ],
      hoverX,
      w,
      h,
    );
  }
}

/** 在上半区两个 1/4 高的槽位里各画一路波形，槽位中心为各自零轴 */
function drawStacked(
  ctx: CanvasRenderingContext2D,
  data: Float32Array,
  w: number,
  half: number,
  color: string,
  slot: 0 | 1,
) {
  const center = slot === 0 ? half * 0.28 : half * 0.78;
  const span = half * 0.2;
  const buckets = Math.max(2, Math.floor(w));
  const { min, max } = minMaxBuckets(data, buckets);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < buckets; i++) {
    const x = (i / (buckets - 1)) * w;
    ctx.moveTo(x, center - max[i] * span * 4);
    ctx.lineTo(x, center - min[i] * span * 4);
  }
  ctx.stroke();
}

function drawTooltip(ctx: CanvasRenderingContext2D, lines: string[], x: number, w: number, h: number) {
  ctx.font = '11px ui-monospace, monospace';
  const pad = 6;
  const lineH = 14;
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
  const th = lines.length * lineH + pad;
  const bx = x + 12 + tw > w ? x - 12 - tw : x + 12;
  const by = Math.min(h - th - 6, 40);
  ctx.fillStyle = 'rgba(20,20,19,0.92)';
  ctx.strokeStyle = COLORS.baseline;
  ctx.fillRect(bx, by, tw, th);
  ctx.strokeRect(bx, by, tw, th);
  ctx.fillStyle = COLORS.text;
  lines.forEach((l, i) => ctx.fillText(l, bx + pad, by + pad + i * lineH));
}
