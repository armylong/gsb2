import { COLORS, clearPanel, drawGrid, label, setupCanvas, title } from './canvas-util';
import type { SeamInfo, SegmentSpec } from '../audio/segment';
import { freqAt } from '../audio/segment';


export interface PhaseViewData {
  phaseDiff: Float32Array;
  freqA: Float32Array;
  freqB: Float32Array;
  windowS: number;
  /** 当前两路瞬时频率与拍频的文字读数 */
  readout: { fA: number; fB: number; beat: number; diffRad: number; diffDeg: number };
}

/** 相位差条带：纵轴 -π..π，斜率即拍频；同频时拉成水平线（拍动停止） */
export function drawPhasePanel(canvas: HTMLCanvasElement, d: PhaseViewData, hoverX: number | null) {
  const ctx = setupCanvas(canvas);
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  clearPanel(ctx, w, h);
  drawGrid(ctx, w, h, 6, 4);
  title(ctx, '两路相位差 Δφ = φA − φB（卷绕到 ±π）；条纹越密 = 拍越快', 10, 6);

  // 顶部 40px 留给标题与读数，曲线绘制在其下方
  const top = 42;
  const bottom = h - 18;
  const midY = (top + bottom) / 2;
  const span = (bottom - top) / 2;
  const yOf = (v: number) => midY - (v / Math.PI) * span;
  ctx.strokeStyle = COLORS.envelope;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const n = d.phaseDiff.length;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const y = yOf(d.phaseDiff[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  label(ctx, '+π', 4, top - 2, true);
  label(ctx, '0', 4, midY - 6, true);
  label(ctx, '−π', 4, bottom - 4, true);

  const r = d.readout;
  ctx.font = '11.5px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  // 读数排在第二行，与标题错开
  const ry = 22;
  ctx.fillStyle = COLORS.toneA;
  ctx.fillText(`fA = ${r.fA.toFixed(2)} Hz`, 90, ry);
  ctx.fillStyle = COLORS.toneB;
  ctx.fillText(`fB = ${r.fB.toFixed(2)} Hz`, 235, ry);
  ctx.fillStyle = COLORS.text;
  ctx.fillText(`|Δf| = ${r.beat.toFixed(2)} Hz`, 380, ry);
  ctx.fillStyle = COLORS.envelope;
  ctx.fillText(`Δφ = ${r.diffRad.toFixed(2)} rad (${r.diffDeg.toFixed(0)}°)`, 525, ry);

  if (hoverX !== null && n > 1) {
    const idx = Math.min(n - 1, Math.max(0, Math.floor((hoverX / w) * n)));
    ctx.strokeStyle = COLORS.playhead;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hoverX, 0);
    ctx.lineTo(hoverX, h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '11px ui-monospace, monospace';
    const line = `Δφ=${d.phaseDiff[idx].toFixed(2)}  fA=${d.freqA[idx].toFixed(1)}  fB=${d.freqB[idx].toFixed(1)}`;
    ctx.fillStyle = 'rgba(20,20,19,0.92)';
    const tw = ctx.measureText(line).width + 12;
    const bx = Math.min(w - tw - 4, hoverX + 10);
    ctx.fillRect(bx, h - 22, tw, 18);
    ctx.fillStyle = COLORS.text;
    ctx.fillText(line, bx + 6, h - 18);
  }
}

/** 左右独立 RMS 电平表；split/mix 切换时两表读数应保持一致（等功率路由） */
export function drawMeterPanel(canvas: HTMLCanvasElement, rmsL: number, rmsR: number) {
  const ctx = setupCanvas(canvas);
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  clearPanel(ctx, w, h);
  title(ctx, '左右电平（RMS，线性刻度）');

  const bar = (x0: number, value: number, color: string, tag: string) => {
    const bw = (w - 40) / 2;
    const top = 30;
    const bh = h - top - 18;
    ctx.strokeStyle = COLORS.baseline;
    ctx.strokeRect(x0, top, bw, bh);
    const frac = Math.min(1, value / 0.25);
    const grad = ctx.createLinearGradient(0, top + bh, 0, top);
    grad.addColorStop(0, color);
    grad.addColorStop(0.85, color);
    grad.addColorStop(1, COLORS.bad);
    ctx.fillStyle = grad;
    ctx.fillRect(x0 + 1, top + bh * (1 - frac), bw - 2, bh * frac);
    ctx.fillStyle = COLORS.textDim;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`${tag}  ${(value * 100).toFixed(1)}%`, x0, h - 14);
  };
  bar(12, rmsL, COLORS.toneA, '左 L');
  bar(w / 2 + 8, rmsR, COLORS.toneB, '右 R');
}

export interface SegmentViewData {
  spec: SegmentSpec;
  seam: SeamInfo | null;
  /** 播放位置 0..1，null=未播放 */
  playPos: number | null;
  /** 循环模式：reset=每轮设定相位开始，cont=维持当前相位 */
  loopMode: 'reset' | 'cont' | null;
}

/** 段视图：两路频率随时间的扫频曲线 + 播放头 + 接缝标记 */
export function drawSegmentPanel(canvas: HTMLCanvasElement, d: SegmentViewData) {
  const ctx = setupCanvas(canvas);
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  clearPanel(ctx, w, h);
  title(ctx, '选段频率轨迹（实线 A 蓝 / 虚线 B 橙）与循环接缝', 10, 6);

  // 顶部 34px 为标题/状态区，曲线绘制在其下方
  const top = 34;
  const bottom = h - 20;

  const { spec } = d;
  const samples = 240;
  const path: [number, number][] = [];
  for (let i = 0; i <= samples; i++) path.push(freqAt(spec, (i / samples) * spec.duration));
  const all = path.flatMap((p) => p);
  const fMin = Math.min(...all) - 2;
  const fMax = Math.max(...all) + 2;
  const xOf = (t: number) => (t / spec.duration) * w;
  const yOf = (f: number) => bottom - ((f - fMin) / (fMax - fMin || 1)) * (bottom - top);

  // 网格只画在曲线区
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, w, bottom - top);
  ctx.clip();
  drawGrid(ctx, w, h, 6, 3);
  const strokePath = (idx: 0 | 1, color: string, dash: number[]) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(dash);
    ctx.beginPath();
    path.forEach((p, i) => {
      const x = xOf((i / samples) * spec.duration);
      const y = yOf(p[idx]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  };
  strokePath(0, COLORS.toneA, []);
  strokePath(1, COLORS.toneB, [5, 4]);
  ctx.restore();

  label(ctx, `${fMax.toFixed(0)} Hz`, 6, top - 2, true);
  label(ctx, `${fMin.toFixed(0)} Hz`, 6, bottom - 12, true);
  label(ctx, '0s', 6, h - 14, false);
  label(ctx, `${spec.duration.toFixed(2)}s`, w - 46, h - 14, false);

  // 接缝状态放在标题右侧（同一水平区），不再压到曲线
  if (d.seam) {
    const ok = d.seam.phaseContinuous && d.seam.freqContinuous;
    const color = ok ? COLORS.good : COLORS.bad;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w - 1, top);
    ctx.lineTo(w - 1, bottom);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const txt = ok ? '接缝：相位/频率连续 ✓' : '接缝：未接上 ✗（见下方数据）';
    ctx.fillText(txt, w - ctx.measureText(txt).width - 8, 6);
  }

  if (d.playPos !== null) {
    const x = d.playPos * w;
    ctx.strokeStyle = COLORS.playhead;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
}
